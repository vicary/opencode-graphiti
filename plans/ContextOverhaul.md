# Context Overhaul — FalkorDB Hot Path + Async Graphiti Consolidation

**Status:** Planning **Date:** 2026-03-13 (revised)

---

## 1 Problem

The current plugin routes every write and every query through Graphiti (via
MCP). Each `addEpisode` triggers LLM-backed entity extraction (~200–400 ms).
Each `searchFacts`/`searchNodes` issues an embedding + vector search on the hot
path of `chat.message`, adding 100–300 ms of synchronous latency per user
message. Compaction context augmentation also calls Graphiti synchronously with
no timeout. If Graphiti or its backing LLM is slow or down, the session degrades
silently with no local fallback.

The current design also copies raw message strings rather than extracting
structured session events, and has no local searchable session history.

---

## 2 Goals

1. **Zero Graphiti on the hot path.** No synchronous Graphiti call may block
   `chat.message`, `messages.transform`, `session.compacting`, or any
   per-message event hook. All Graphiti interaction is asynchronous.
2. **Session continuity from local state.** FalkorDB/Redis owns verbatim event
   history, structured snapshots, and cached memory. Compaction survives
   Graphiti outages.
3. **Preserved long-term memory.** Graphiti's vector search, entity extraction,
   and cross-session graph remain available — populated asynchronously and
   cached in Redis for chat-time injection.
4. **Minimal async backend.** Graphiti MCP is the sole consolidation backend. It
   is private infrastructure — hidden behind the async worker, never exposed to
   users, and never called on the hot path.
5. **Structured event extraction.** Context-mode-style categorised events with
   priority-tiered snapshot generation, not raw message copying.

---

## 3 Architecture

```
opencode-graphiti plugin (TypeScript / Deno)
  │
  ├── Hot path — ioredis → FalkorDB :6379 (Redis protocol)
  │     WRITES (every event, sub-ms):
  │       LPUSH  session:{id}:events        <structured-event-json>
  │       SET    session:{id}:snapshot       <priority-tiered-xml>
  │       LPUSH  drain:pending:{groupId}     <episode-json>
  │     READS (chat.message / compacting, sub-ms):
  │       LRANGE session:{id}:events        (recent session context)
  │       GET    session:{id}:snapshot       (post-compaction restore)
  │       GET    memory-cache:{groupId}      (cached Graphiti outputs)
  │
   └── Async tier — Graphiti MCP (configured via `graphiti.endpoint`)
         REQUIRED tool capabilities:
           - add_memory
           - search_memory_facts
           - search_nodes
           - get_episodes
           - get_status  (health check; used to verify MCP reachability)
         All calls are async and never block hook returns.
```

### 3.1 Connectivity

| Target   | Protocol        | Default Port | Connection                                            |
| -------- | --------------- | ------------ | ----------------------------------------------------- |
| FalkorDB | Redis (ioredis) | 6379         | Direct TCP; configured via `falkordb.redisEndpoint`   |
| Graphiti | MCP over HTTP   | 8000         | Direct MCP client; configured via `graphiti.endpoint` |

**Integration decision (final):** Graphiti MCP is the async consolidation
backend. Direct Graphiti HTTP is not used; all Graphiti interaction goes through
the configured MCP endpoint.

**Deployment note:** both FalkorDB and Graphiti MCP are operator-provisioned
services. The plugin connects to whatever addresses are supplied in config.

**Hot-path rule:** hot-path hooks never talk to MCP or Graphiti synchronously.
All MCP communication is queued, async, and hidden behind the plugin's local hot
path.

**User-facing invariant:** MCP is private infrastructure. Users see only the
plugin's existing memory features and the new context-mode-style resumability —
no extra workflow, no manual sync, no awareness that MCP exists.

---

## 4 Data Model

### 4.1 Structured Event Schema

Events are extracted from hooks, not copied verbatim. The taxonomy is designed
to preserve the useful parts of context-mode: active file state, task state,
decisions, blockers, environment changes, and searchable local history.

```typescript
interface SessionEvent {
  id: string; // UUID
  ts: number; // epoch ms
  category: EventCategory;
  priority: 0 | 1 | 2 | 3 | 4;
  role: "user" | "assistant" | "tool" | "system";
  summary: string; // <= 200 chars, human-readable
  body?: string; // full content, truncated to 4 KB
  refs?: string[]; // file paths, task IDs, session IDs, UUIDs
  metadata?: Record<string, unknown>; // tool name, exit code, cwd, env deltas
}

type EventCategory =
  | "task.create"
  | "task.update"
  | "task.complete"
  | "decision"
  | "preference"
  | "rule.load"
  | "file.read"
  | "file.write"
  | "file.edit"
  | "file.search"
  | "cwd.change"
  | "env.change"
  | "git.activity"
  | "error"
  | "subagent.start"
  | "subagent.finish"
  | "integration.call"
  | "intent"
  | "data.import"
  | "discovery"
  | "message"
  | "session.meta";
```

### 4.1.1 Extraction Targets

| Context-mode benefit to preserve  | SessionEvent categories                               | Notes                                                                |
| --------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| Active files and code touchpoints | `file.read`, `file.write`, `file.edit`, `file.search` | Track most recent touched files, not just raw tool output.           |
| Task state and progress           | `task.create`, `task.update`, `task.complete`         | Preserve current goal, checkpoints, and completion markers.          |
| Decisions and user corrections    | `decision`, `preference`                              | Highest-priority resumability signal.                                |
| Rules / operating constraints     | `rule.load`                                           | Capture AGENTS/plugin rules loaded into the session.                 |
| Errors and unresolved blockers    | `error`                                               | Include failing command/tool, status, and whether resolved.          |
| Environment / cwd state           | `cwd.change`, `env.change`                            | Preserve working directory and setup changes.                        |
| Git milestones                    | `git.activity`                                        | Branch, commit, merge, push, stash, rebase milestones when present.  |
| Subagent orchestration            | `subagent.start`, `subagent.finish`                   | Track dispatched work and returned outcomes.                         |
| Remote/tool-service usage         | `integration.call`                                    | Track Graphiti MCP calls and other remote tool/service interactions. |
| Large pasted/reference data       | `data.import`, `discovery`                            | Store pointers/summaries instead of re-injecting full payloads.      |
| Session framing                   | `intent`, `session.meta`, `message`                   | Preserve intent, compaction markers, and low-value chat residue.     |

### 4.2 Redis Key Layout

| Key                           | Type   | Content                                          | TTL    |
| ----------------------------- | ------ | ------------------------------------------------ | ------ |
| `session:{id}:events`         | List   | JSON `SessionEvent` objects                      | 24 h   |
| `session:{id}:snapshot`       | String | Priority-tiered XML snapshot (≤ 3 KB)            | 48 h   |
| `memory-cache:{groupId}`      | String | Serialized Graphiti search results               | 10 min |
| `memory-cache:{groupId}:meta` | Hash   | `lastQuery`, `lastRefresh`, `factUuids`          | 10 min |
| `drain:pending:{groupId}`     | List   | Serialized drain-batch entries awaiting Graphiti | 7 d    |
| `drain:cursor:{groupId}`      | String | Last successfully drained event ID               | 7 d    |

### 4.3 Priority-Tiered Snapshot Format

Generated at `session.idle` and `session.compacted` from structured Redis
events. Sections are filled in priority order; lower-priority sections are
truncated first when the snapshot budget (3 KB) is exceeded.

| Priority | Sections                                         | Source categories                                |
| -------- | ------------------------------------------------ | ------------------------------------------------ |
| P0       | `decisions`, `constraints`, `active_task`        | `decision`, `preference`, `rule.load`, `task.*`  |
| P1       | `active_files`, `recent_edits`, `subagents_open` | `file.*`, `subagent.start`                       |
| P2       | `errors`, `blockers`, `environment`              | `error`, `cwd.change`, `env.change`              |
| P3       | `git_state`, `subagents_done`, `open_questions`  | `git.activity`, `subagent.finish`, `task.update` |
| P4       | `discoveries`, `references`, `residual_messages` | `discovery`, `data.import`, `message`            |

```xml
<snapshot session="{id}" ts="{epoch}" version="2">
  <decisions>
    <d>Plugin hot path must talk directly to FalkorDB; Graphiti remains async behind MCP.</d>
  </decisions>

  <constraints>
    <c>Graphiti stays off the hot path; Redis owns compaction survival.</c>
  </constraints>

  <active_task>
    <goal>Redesign context pipeline around FalkorDB hot path.</goal>
    <status>Planning revised; Graphiti MCP endpoint confirmed reachable.</status>
  </active_task>

  <active_files>
    <f>plans/ContextOverhaul.md</f>
  </active_files>

  <errors>
    <e>No open errors at snapshot time.</e>
  </errors>

  <environment>
    <cwd>/workspace/project</cwd>
  </environment>

  <discoveries>
    <d>Graphiti bulk ingestion is documented, but docs warn it skips edge invalidation.</d>
  </discoveries>
</snapshot>
```

### 4.4 Cold Tier (Graphiti — unchanged schema)

No changes to Graphiti's internal entity/fact/node model. The plugin sends the
same semantic payloads through MCP tool calls (`add_memory`,
`search_memory_facts`, `search_nodes`, `get_episodes`).

---

## 5 Hook Mapping

### 5.1 Hot Path (synchronous, sub-ms)

| Hook                                   | Action                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `event: message.part.updated`          | Buffer assistant part in memory (unchanged)                                                                                        |
| `event: message.updated` (completed)   | Extract `SessionEvent` → `LPUSH session:{id}:events`                                                                               |
| `chat.message`                         | Extract user `SessionEvent` → `LPUSH`; read `memory-cache:{groupId}` + recent session state from Redis; prepare transform input    |
| `event: session.idle`                  | Build priority-tiered snapshot → `SET session:{id}:snapshot`; trigger async cache refresh + drain                                  |
| `event: session.compacted`             | Build snapshot from events → `SET session:{id}:snapshot`; enqueue drain batch                                                      |
| `experimental.session.compacting`      | Compose the same canonical `<session_memory>` envelope for compaction from Redis snapshot + cached memory                          |
| `experimental.chat.messages.transform` | Actual chat-time injection point: compose canonical `<session_memory>` with optional `<persistent_memory>` from Redis-backed state |
| `event: session.created`               | `EXPIRE` reset; bootstrap best-effort async warmup / cross-session primer only; cannot inject directly                             |

### 5.2 Async Tier (fire-and-forget, non-blocking)

| Trigger                                                 | Action                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `session.idle` / `session.compacted` / buffer threshold | Drain pending events through Graphiti MCP `add_memory`                                                 |
| `session.idle` / first `chat.message`                   | Refresh `memory-cache:{groupId}` via MCP `search_memory_facts` + `search_nodes`                        |
| `session.created`                                       | Best-effort async cross-session primer via MCP `get_episodes`; prewarm reusable cache if timing allows |

**No Graphiti call ever blocks a hook return.**

### 5.3 Backend Rule

| Consolidation backend | When used | Constraint                                                               |
| --------------------- | --------- | ------------------------------------------------------------------------ |
| Graphiti MCP          | Always    | Used only behind the async consolidation worker; never in hot-path hooks |

---

## 6 Cached Memory Strategy

### 6.1 Problem

The current design calls `searchFacts` + `searchNodes` synchronously on every
`chat.message` (or on drift detection). This puts Graphiti + embedding latency
on the critical path.

### 6.2 Solution: Redis-Resident Memory Cache

```
Session starts (`event: session.created`)
  ├── [sync]  Initialize empty session state; restore reusable cache keys if present
  ├── [async] Fire-and-forget: best-effort warm `memory-cache:{groupId}` via MCP `get_episodes`
  └── [future option, non-final] Schedule proactive `search_memory_facts`/`search_nodes` refresh for broader project scope

First user message arrives (`chat.message`)
  ├── [sync]  Read memory-cache:{groupId} from Redis (sub-ms)
  │           If cache hit + not stale → make cached facts/nodes available to the transform hook
  │           If cache miss or stale → use last cached value (or empty)
  ├── [sync]  Read session:{id}:events from Redis for session context
  ├── [sync]  Prepare Redis-backed inputs for `experimental.chat.messages.transform`
  └── [async] Fire-and-forget: refresh cache from Graphiti MCP using this prompt
              search_memory_facts + search_nodes → parse results → SET memory-cache:{groupId}
```

### 6.3 Cache Lifecycle

| Event                 | Cache Action                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| Plugin startup        | Restore Redis clients only; no synchronous Graphiti warmup                                      |
| `session.created`     | Best-effort async prewarm of reusable cache and cross-session primer                            |
| first `chat.message`  | Read cache (sync); inject if available via transform; schedule prompt-specific refresh          |
| later `chat.message`  | Read cache (sync); schedule refresh if stale or drifted (async)                                 |
| `session.idle`        | Refresh cache (async) — incorporates recently drained facts                                     |
| Drain completes       | Refresh cache (async) — new facts now searchable                                                |
| Cache miss / cold run | Return empty `persistent_memory`; first injection still includes Redis-sourced `session_memory` |

### 6.4 New-Session First-Turn Behavior

Because OpenCode does not expose `SessionStart`, the plan relies on the
combination of `event: session.created`, `chat.message`, and
`experimental.chat.messages.transform`:

- `event: session.created` cannot inject memories directly. It only bootstraps
  async warmup and restores reusable cached state.
- The first actual injection point in a brand-new session is the first
  `experimental.chat.messages.transform` after the user's opening message.
- `persistent_memory` on that first reply is **best-effort**, not guaranteed.
- If `memory-cache:{groupId}` was already warm from prior work, or if the
  `session.created` bootstrap finishes before the first transform runs, relevant
  `persistent_memory` may appear on the first reply.
- If the cache is cold, the first reply still receives `session_memory` from
  FalkorDB, while `persistent_memory` may be empty until the async MCP refresh
  completes.
- In practice this means long-term memory is often cold-first-turn / warmer on a
  later turn, while session continuity remains available immediately.

### 6.5 Drift Detection (Revised)

Drift detection currently calls `searchFacts` synchronously. Under the new
design:

- On each `chat.message`, compare the user's message against the query that
  produced the current cache.
- If the topic has drifted (Jaccard on cached fact UUIDs < threshold), schedule
  an async cache refresh with the new query. The _current_ cached context is
  still injected immediately; the refreshed cache is available for the next
  message.
- This trades one message of staleness for eliminating synchronous Graphiti
  latency entirely.

---

## 7 Injection Strategy

Injected continuity context uses one canonical `<session_memory>` envelope with
an optional nested `<persistent_memory>` section. The Session Guide is assembled
from Redis hot-tier state and optional Graphiti cache data.

Historically, the plugin's Graphiti-derived memory was injected as a standalone
`<memory data-uuids="...">...</memory>` block. This plan keeps the caller's
current naming (`session_memory` + `persistent_memory`) and treats the older
`<memory data-uuids>` shape as a legacy Graphiti-only serialization detail, not
as a separate top-level layer. Its UUID metadata maps cleanly to
`<persistent_memory fact_uuids="...">` in the canonical format below.

```xml
<session_memory source="falkordb+graphiti-cache" version="1">
  <last_request>Continue the current task without asking for recap.</last_request>

  <active_tasks>
    <task status="in_progress">Redesign plugin around FalkorDB hot path.</task>
  </active_tasks>

  <key_decisions>
    <decision>Keep Graphiti off the hot path; use MCP only in async consolidation.</decision>
  </key_decisions>

  <files_in_play>
    <file>plans/ContextOverhaul.md</file>
  </files_in_play>

  <project_rules>
    <rule>Preserve context-mode-style resumability behavior.</rule>
  </project_rules>

  <session_snapshot>
    <!-- Priority-tiered snapshot from §4.3 -->
  </session_snapshot>

  <persistent_memory fact_uuids="uuid1,uuid2" node_refs="nodeA,nodeB">
    <!-- Cached Graphiti facts/nodes, optional on cold first turn; fact_uuids preserves legacy memory[data-uuids] semantics -->
  </persistent_memory>
</session_memory>
```

### 7.1 Session Guide Sections

The injected sections intentionally mirror context-mode's continuity model and
should be rendered in this order:

| Section             | Source                           | Required   | Notes                                                          |
| ------------------- | -------------------------------- | ---------- | -------------------------------------------------------------- |
| `last_request`      | latest user prompt / task intent | Yes        | Primary resume anchor.                                         |
| `active_tasks`      | structured task events           | Yes        | Checkbox/task-state style when rendered.                       |
| `key_decisions`     | decision + preference events     | Yes        | Preserve user corrections and constraints.                     |
| `files_in_play`     | recent file events               | Yes        | Mirrors context-mode active-files continuity.                  |
| `project_rules`     | loaded AGENTS/rules              | Yes        | Must survive compaction.                                       |
| `unresolved_errors` | open error events                | If present | Show only unresolved blockers.                                 |
| `git_state`         | git activity events              | If present | Include only meaningful milestones.                            |
| `subagent_work`     | subagent events                  | If present | Summaries only, not raw logs.                                  |
| `session_snapshot`  | priority-tiered snapshot         | If present | Compact state restore layer.                                   |
| `persistent_memory` | Graphiti cache                   | Optional   | Canonical successor to the legacy `<memory data-uuids>` block. |

### 7.2 Budget Allocation

| Section group                                                       | Budget                         | Source                     | Latency |
| ------------------------------------------------------------------- | ------------------------------ | -------------------------- | ------- |
| Session Guide core (`last_request`, tasks, decisions, files, rules) | up to 1 600 chars              | Redis events + snapshot    | < 1 ms  |
| Session snapshot detail                                             | up to 800 chars                | Redis `GET`                | < 1 ms  |
| Persistent memory                                                   | remainder of 5% context budget | Redis `GET memory-cache:*` | < 1 ms  |

`persistent_memory` is empty (not an error) if cache has not been warmed yet,
the session is on its first cold turn, or Graphiti is unreachable. The rest of
the Session Guide is always available because it is sourced from FalkorDB/Redis.

### 7.3 Compatibility Note

- **Current plan:** emit one canonical `<session_memory>` envelope with optional
  `<persistent_memory>`.
- **Historical implementation:** Graphiti-derived memory previously appeared as
  `<memory data-uuids="...">`.
- **Migration stance:** preserve UUID/fact metadata semantics, but do not
  describe or reintroduce the old shape as a separate "layer" in new plan text.

---

## 8 Async Batch Drain

### 8.1 Drain Policy

Events are batched in a Redis list (`drain:pending:{groupId}`) and drained to
Graphiti asynchronously:

| Parameter       | Value                                                              | Rationale                                |
| --------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| Max batch size  | 20 events                                                          | Keeps Graphiti LLM call duration bounded |
| Max batch bytes | 50 KB combined body                                                | Avoids oversized episode payloads        |
| Drain triggers  | `session.idle`, `session.compacted`, buffer threshold              | Natural pause points                     |
| Retry policy    | Exponential backoff, 3 attempts, then dead-letter                  | Bounded retry cost                       |
| Idempotency     | Each event has a UUID; Graphiti deduplicates by episode name+group | At-least-once safe                       |

**Important Graphiti constraint:** the drain path uses standard `add_memory`
sequentially per `groupId` to ensure normal entity invalidation semantics on an
active agent graph. Bulk ingestion (`add_episode_bulk`, if available) is
documented by Graphiti as skipping edge invalidation and is reserved for
bootstrap/backfill scenarios only; it is not part of the current plan.

### 8.2 Ordering Guarantees

- Events within a session are appended to the Redis list in order.
- Drain reads from the list head (FIFO). A cursor (`drain:cursor:{groupId}`)
  tracks the last successfully drained event ID.
- If a batch partially fails, the cursor is not advanced; the entire batch is
  retried.
- Cross-session ordering is best-effort (sessions drain independently).

### 8.3 Crash Recovery

- On plugin restart, the drain scheduler reads `drain:pending:{groupId}` and
  `drain:cursor:{groupId}` from Redis.
- Events after the cursor are re-drained. Because drain is idempotent
  (UUID-keyed), duplicates are harmless.
- If Redis itself is lost, pending events in memory are lost. This is acceptable
  because they are session-local and Graphiti is the durable store — the lost
  events simply won't be consolidated into the knowledge graph.

### 8.4 Dead-Letter Handling

After 3 failed drain attempts for a batch:

- Log a warning with the batch event IDs.
- Move the batch to `drain:dead:{groupId}` (Redis list, 30-day TTL).
- Advance the cursor past the failed batch.
- A manual retry command (or scheduled job) can re-enqueue dead-letter batches.

---

## 9 Compaction Flow (Revised)

```
session.compacting hook fires
  ├── [sync]  GET session:{id}:snapshot from Redis
  ├── [sync]  GET memory-cache:{groupId} from Redis (cached Graphiti facts)
  ├── [sync]  Compose the same `<session_memory>` envelope used for chat injection
  ├── [sync]  Inject into output.context
  └── [done]  ← no Graphiti call, no timeout risk

session.compacted event fires (after LLM compaction completes)
  ├── [sync]  LRANGE session:{id}:events → rebuild snapshot → SET
  ├── [async] Enqueue compaction summary to drain batch
  └── [async] Refresh memory cache (new context post-compaction)
```

No timeout/fallback needed for compaction augmentation because all reads are
from Redis (sub-ms). The Graphiti-sourced context comes from the pre-warmed
Redis cache, not a live query.

---

## 10 Session Lifecycle

### 10.1 Session ID Semantics

- `sessionID` from OpenCode hooks is the canonical key for all Redis state.
- Subagent sessions (with `parentID`) are ignored for memory purposes
  (unchanged).
- Session state is local to the plugin process; Redis keys provide persistence
  across plugin restarts within TTL windows.

### 10.2 Startup / Bootstrap

1. Plugin initializes `ioredis` connection to FalkorDB Redis port.
2. If Redis is unreachable: log error, disable hot tier, fall back to in-memory
   event buffer (degraded but functional — same as current behavior without
   Redis). Retry connection with exponential backoff.
3. Plugin initializes the Graphiti MCP client. Graphiti availability is checked
   lazily on first drain attempt.
4. Async: if reusable cache context is identifiable, start best-effort warmup of
   `memory-cache:{groupId}`.
5. If Graphiti is unreachable at startup: log warning, continue. Memory cache
   remains empty until Graphiti comes online and a drain/refresh succeeds.

### 10.3 Failure Modes

| Component Down   | Impact                                                                                                                         | Recovery                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Redis (FalkorDB) | No session events, no snapshot, no cache. In-memory fallback for current session; no cross-restart persistence.                | Auto-reconnect (ioredis built-in). State rebuilds on reconnect.                                                          |
| Graphiti         | No drain, no cache refresh. Cached memory stales out (10 min TTL). Session continuity unaffected.                              | Drain retries on next trigger. Cache refreshes when Graphiti returns.                                                    |
| Both             | Plugin operates with in-memory session buffer only. Equivalent to current plugin without Graphiti, minus cross-session memory. | Both auto-recover independently.                                                                                         |
| Plugin crash     | In-memory state lost. Redis state survives within TTL.                                                                         | On restart, read `drain:pending` + `drain:cursor` from Redis; resume drain. Session snapshot available for next session. |

---

## 11 Searchable Session History

### 11.1 Local Session Recall (reuse existing stack only)

Do not introduce a separate SQLite store. Local session recall stays within the
existing FalkorDB/Graphiti stack:

- **Primary local source:** Redis/FalkorDB hot-tier event log + snapshot keys.
- **Optional secondary index:** if the FalkorDB deployment includes RediSearch,
  use it to index `SessionEvent.summary` and selected `body` fields.
- **Fallback:** if RediSearch is unavailable, use bounded linear scan over the
  hot-tier event list for recent-session diagnostics and compaction recovery.

### 11.2 Cross-Session Search (Graphiti)

Cross-session search goes through Graphiti's vector/graph search, but only via
the async cache layer — never as a synchronous hot-path call.

---

## 12 Tradeoffs

| Tradeoff                                     | Impact                                                                                                       | Mitigation                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **One-message staleness on topic drift**     | After a topic shift, the first message uses the old cached memory; the refresh arrives for the next message. | Acceptable for most conversations. Cache refresh latency is ~200 ms; user won't notice the one-turn delay.                                                    |
| **Cold-start empty persistent memory**       | First reply in a new or cold session may have no Graphiti-derived `persistent_memory`.                       | Redis-sourced `session_memory` still provides immediate continuity. Warmup is best-effort and improves later turns when it wins the race.                     |
| **Redis as SPOF for hot tier**               | If Redis is down, session events and snapshots are unavailable.                                              | In-memory fallback provides degraded session continuity. ioredis auto-reconnects.                                                                             |
| **Eventual consistency of knowledge graph**  | Graphiti facts lag behind conversation by drain interval (seconds to minutes).                               | Acceptable — knowledge graph is for cross-session recall, not intra-session continuity.                                                                       |
| **Lost events on plugin crash before drain** | Events buffered in-memory but not yet in Redis `drain:pending` are lost.                                     | Use Redis `drain:pending` as the durable queue (write-ahead). Events are written to `drain:pending` at the same time as `session:{id}:events`.                |
| **10-min cache TTL may serve stale facts**   | Facts invalidated in Graphiti may still appear in cache for up to 10 minutes.                                | Current design has the same staleness issue (search results are point-in-time). Configurable TTL.                                                             |
| **No snapshot for very short sessions**      | Sessions that end before `session.idle` fires produce no snapshot.                                           | Acceptable — short sessions have minimal context to preserve.                                                                                                 |
| **MCP tool-call abstraction**                | MCP adds protocol overhead vs direct HTTP and limits control over request shaping.                           | Overhead is irrelevant on the async path. Direct HTTP remains a future option only if the API surface is later confirmed; it is not part of the current plan. |

---

## 13 Config Changes

`GraphitiConfig` keeps legacy top-level keys for backward compatibility, but
adds explicit nested sections for FalkorDB and Graphiti. Nested values take
precedence whenever both forms are supplied.

```typescript
interface GraphitiConfig {
  // Preferred nested config
  falkordb?: {
    redisEndpoint?: string; // FalkorDB Redis URL (default: "redis://localhost:6379")
    batchSize?: number; // max events per drain batch (default: 20)
    batchMaxBytes?: number; // max combined body bytes per batch (default: 51200)
    sessionTtlSeconds?: number; // session:{id}:events TTL (default: 86400)
    cacheTtlSeconds?: number; // memory-cache TTL (default: 600)
    drainRetryMax?: number; // max drain retry attempts (default: 3)
  };

  graphiti?: {
    endpoint?: string; // Graphiti MCP URL (e.g. "http://localhost:8000/mcp")
    groupIdPrefix?: string;
    driftThreshold?: number;
    factStaleDays?: number;
  };

  // Legacy top-level keys still accepted during migration
  endpoint?: string;
  groupIdPrefix?: string;
  driftThreshold?: number;
  factStaleDays?: number;
}
```

Resolution rules for the implementation:

1. Read FalkorDB/Redis settings from `falkordb.*` first; fall back to legacy
   top-level Redis keys only when the nested value is absent.
2. Read Graphiti settings from `graphiti.*` first; fall back to legacy top-level
   Graphiti keys only when the nested value is absent.
3. New docs, examples, validation, and runtime lookups should use the nested
   shape as canonical; legacy top-level keys exist only for compatibility.

---

## 14 File Changes

### New Files

```
src/services/redis-client.ts     — ioredis wrapper, connection management, fallback
src/services/redis-events.ts     — SessionEvent extraction, LPUSH/LRANGE helpers
src/services/redis-snapshot.ts   — priority-tiered snapshot builder
src/services/redis-cache.ts      — memory-cache read/write/refresh logic
src/services/graphiti-mcp.ts     — Graphiti MCP client wrapper
src/services/graphiti-async.ts   — async consolidation worker backed by Graphiti MCP
src/services/batch-drain.ts      — drain scheduler, cursor management, dead-letter
src/services/event-extractor.ts  — structured event extraction from hook payloads
```

### Modified Files

```
src/config.ts                    — add canonical `falkordb`/`graphiti` sections, legacy top-level fallback, and precedence resolution
src/types/index.ts               — add SessionEvent, EventCategory types
src/session.ts                   — SessionState gains hotTierReady; wire Redis client and async Graphiti consolidation worker; remove direct GraphitiClient dependency
src/services/connection-manager.ts — adapt existing MCP transport lifecycle for the new graphiti-mcp.ts wrapper (reconnect backoff, request queuing already implemented)
src/handlers/event.ts            — hot tier writes on all event types, async drain triggers
src/handlers/chat.ts             — read from Redis cache instead of sync Graphiti calls
src/handlers/compacting.ts       — read snapshot + cache from Redis, no Graphiti calls
src/handlers/messages.ts         — compose canonical `session_memory` envelope from Redis-sourced data
src/index.ts                     — wire Redis client + async Graphiti MCP worker
```

### Removed/Deprecated Files

```
src/services/client.ts               — replaced by graphiti-mcp.ts
```

---

## 15 Implementation Order

| Phase                                 | Files                                                 | Depends On     | Acceptance Criteria                                                                                                   |
| ------------------------------------- | ----------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------- |
| 0. Normalize MCP contract             | —                                                     | —              | Confirm tool payload/response handling against a reachable Graphiti MCP endpoint.                                     |
| 1. Consolidation backend              | `graphiti-mcp.ts`, `graphiti-async.ts`                | Phase 0        | Async worker can drain, refresh cache, and load primers through Graphiti MCP with no hot-path blocking.               |
| 2. Redis primitives                   | `redis-client.ts`, `redis-events.ts`                  | —              | LPUSH/LRANGE/GET/SET work against FalkorDB. Connection retry works.                                                   |
| 3. Event extractor                    | `event-extractor.ts`, `types/index.ts`                | —              | Hook payloads produce context-mode-equivalent `SessionEvent` categories. Unit tests.                                  |
| 4. Snapshot builder                   | `redis-snapshot.ts`                                   | Phase 3        | Priority-tiered XML snapshot generated from event list. Budget enforcement. Unit tests.                               |
| 5. Local search strategy              | —                                                     | Phases 2, 4    | Redis/FalkorDB-only session recall path works; optional RediSearch path documented if available.                      |
| 6. Memory cache                       | `redis-cache.ts`                                      | Phases 1, 2    | Async Graphiti search results written to and read from Redis. TTL expiry. Stale-read behavior.                        |
| 7. Batch drain                        | `batch-drain.ts`                                      | Phases 1, 2, 3 | Events drain to Graphiti async with sequential ingest semantics by `groupId`. Cursor tracking. Crash recovery.        |
| 8. Wire handlers                      | `event.ts`, `chat.ts`, `compacting.ts`, `messages.ts` | Phases 2–7     | All hooks use Redis hot path. No synchronous Graphiti calls remain. Existing test assertions hold.                    |
| 9. Config & bootstrap                 | `config.ts`, `index.ts`, `session.ts`                 | Phase 8        | Nested `falkordb`/`graphiti` config is validated, legacy top-level fallback works, and nested values take precedence. |
| 10. Docs alignment (future follow-up) | `README.md`                                           | Phase 9        | README incorporates all adopted context-mode feature descriptions and credits the original author/project by name.    |
| 11. Integration tests                 | —                                                     | All            | End-to-end: message -> Redis event -> snapshot -> async drain -> Graphiti -> cache refresh -> injection.              |

---

## 16 Confirmed Decisions, Remaining Validation, and Future Options

### 16.1 Confirmed decisions for this plan

- **Hot path:** FalkorDB/Redis (configured via `falkordb.redisEndpoint`, with
  legacy fallback to `redisEndpoint`) is the hot path for writes, snapshots, and
  cached reads.
- **Cold/async backend:** Graphiti stays off the hot path. The consolidation
  backend is Graphiti MCP (configured via `graphiti.endpoint`, with legacy
  fallback to `endpoint`).
- **Hook model:** because OpenCode lacks `SessionStart`, first-turn memory must
  rely on `event: session.created` bootstrap + `chat.message` +
  `experimental.chat.messages.transform`.
- **Naming:** the canonical injected structure remains `session_memory` with
  optional `persistent_memory`.
- **Storage scope:** do not add new independent storage such as SQLite.
- **Docs follow-up:** README alignment and attribution are future implementation
  work, not already-completed state.

### 16.2 Remaining implementation validation

- [ ] **MCP payload/response normalization**: the endpoint is already verified
      as reachable; implementation still needs to lock down exact
      request/response handling for `add_memory`, `search_memory_facts`,
      `search_nodes`, and `get_episodes`.
- [ ] **Graphiti bulk semantics**: official docs warn `add_episode_bulk` skips
      edge invalidation. Confirm whether any bootstrap/backfill path here can
      safely use bulk, or whether all non-empty-graph traffic must remain
      sequential `add_memory`.
- [ ] **RediSearch in FalkorDB**: if the image includes RediSearch, decide
      whether to use it for optional local session search over structured
      events.
- [ ] **Cache key namespacing**: if multiple plugin instances share the same
      FalkorDB, cache keys need instance-level namespacing to avoid collisions.
      Current `groupId` prefix may suffice.
- [ ] **Drift detection heuristic**: the cached Jaccard approach compares fact
      UUID sets rather than issuing a live search. Validate that this is good
      enough in practice.
- [ ] **Connection manager reuse**: the existing
      `src/services/connection-manager.ts` (from `plans/ConnectionManager.md`)
      already implements MCP transport lifecycle, reconnect backoff, and request
      queuing. Decide whether `graphiti-mcp.ts` wraps it as-is, adapts it, or
      replaces it.
- [ ] **README scope and attribution**: the README update (Phase 10) must
      enumerate every context-mode-derived feature this design adopts
      (structured event extraction, priority-tiered snapshots, resumable session
      state, hidden background consolidation) and credit the original
      context-mode author and project by name with a link. This is a hard
      requirement, not optional polish.

### 16.3 Future options (non-final)

- [ ] **More proactive cache prewarm**: broaden warmup beyond `get_episodes`
      into project-scope `search_memory_facts`/`search_nodes` if the extra async
      work is worth the cache-hit improvement.
- [ ] **Alternative Graphiti transport**: direct Graphiti HTTP could be
      revisited later only if its API surface is confirmed and there is a
      concrete reason to move away from MCP. It is not part of the current plan.
