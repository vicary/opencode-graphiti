# Context Overhaul — FalkorDB Hot Path + Async Graphiti Consolidation

**Status:** In Implementation **Date:** 2026-03-13 (revised) | README overhaul
completed 2026-03-15 | Child-session routing documented 2026-03-15

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
| Redis    | Redis (ioredis) | 6379         | Direct TCP; configured via `redis.endpoint`           |
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

| Key                           | Type   | Content                                                | TTL    |
| ----------------------------- | ------ | ------------------------------------------------------ | ------ |
| `session:{id}:events`         | List   | JSON `SessionEvent` objects                            | 24 h   |
| `session:{id}:snapshot`       | String | Priority-tiered XML snapshot (≤ 3 KB)                  | 48 h   |
| `memory-cache:{groupId}`      | String | Serialized Graphiti search results                     | 10 min |
| `memory-cache:{groupId}:meta` | Hash   | `lastQuery`, `lastRefresh` (+ optional extra metadata) | 10 min |
| `drain:pending:{groupId}`     | List   | Serialized drain-batch entries awaiting Graphiti       | 7 d    |
| `drain:cursor:{groupId}`      | String | Last successfully drained event ID                     | 7 d    |

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

All hooks resolve the incoming `sessionID` to the canonical (root) session ID
before accessing state, events, or snapshots. Child/subagent sessions are routed
to the parent session's state transparently (see §10.1).

| Hook                                   | Action                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `event: session.created`               | Cache parent/child linkage; resolve canonical ID; `EXPIRE` reset; bootstrap best-effort async warmup / cross-session primer        |
| `event: message.part.updated`          | Buffer assistant part under canonical session ID                                                                                   |
| `event: message.updated` (completed)   | Extract `SessionEvent` → `LPUSH session:{canonicalId}:events`                                                                      |
| `chat.message`                         | Extract user `SessionEvent` → `LPUSH`; read `memory-cache:{groupId}` + recent session state from Redis; prepare transform input    |
| `event: session.idle`                  | Build priority-tiered snapshot → `SET session:{canonicalId}:snapshot`; trigger async cache refresh + drain                         |
| `event: session.compacted`             | Build snapshot from events → `SET session:{canonicalId}:snapshot`; enqueue drain batch                                             |
| `event: session.deleted`               | Delete only the reported session's local bookkeeping; canonical/root session state is preserved (see §10.1)                        |
| `experimental.session.compacting`      | Compose the same canonical `<session_memory>` envelope for compaction from Redis snapshot + cached memory                          |
| `experimental.chat.messages.transform` | Actual chat-time injection point: compose canonical `<session_memory>` with optional `<persistent_memory>` from Redis-backed state |

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

| Event                 | Cache Action                                                                            |
| --------------------- | --------------------------------------------------------------------------------------- |
| Plugin startup        | Restore Redis clients only; no synchronous Graphiti warmup                              |
| `session.created`     | Best-effort async prewarm of reusable cache and cross-session primer                    |
| first `chat.message`  | Read cache (sync); inject if available via transform; schedule prompt-specific refresh  |
| later `chat.message`  | Read cache (sync); schedule refresh if stale or drifted (async)                         |
| `session.idle`        | Refresh cache (async) — incorporates recently drained facts                             |
| Drain completes       | Refresh cache (async) — new facts now searchable                                        |
| Cache miss / cold run | Omit `persistent_memory`; first injection still includes Redis-sourced `session_memory` |

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
  FalkorDB, while `persistent_memory` may be absent until the async MCP refresh
  completes.
- In practice this means long-term memory is often cold-first-turn / warmer on a
  later turn, while session continuity remains available immediately.

### 6.5 Drift Detection (Revised)

Drift detection currently calls `searchFacts` synchronously. Under the new
design:

- On each `chat.message`, compare the user's message against the query that
  produced the current cache.
- If the topic has drifted (Jaccard on current query text vs cached query text <
  threshold), schedule an async cache refresh with the new query. The _current_
  cached context is still injected immediately; the refreshed cache is available
  for the next message.
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
UUID-bearing shapes as legacy compatibility details, not as a separate top-level
layer.

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

  <persistent_memory node_refs="nodeA,nodeB">
    <!-- Cached Graphiti node/episode summaries, optional on cold first turn -->
  </persistent_memory>
</session_memory>
```

### 7.1 Session Guide Sections

The injected sections intentionally mirror context-mode's continuity model and
should be rendered in this order:

| Section             | Source                           | Required   | Notes                                                                                                  |
| ------------------- | -------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------ |
| `last_request`      | latest user prompt / task intent | Yes        | Primary resume anchor.                                                                                 |
| `active_tasks`      | structured task events           | If present | Omitted when empty. Checkbox/task-state style when rendered.                                           |
| `key_decisions`     | decision + preference events     | If present | Omitted when empty. Preserve user corrections and constraints.                                         |
| `files_in_play`     | recent file events               | If present | Omitted when empty. Mirrors context-mode active-files continuity.                                      |
| `project_rules`     | loaded AGENTS/rules              | If present | Omitted when empty. Must survive compaction.                                                           |
| `unresolved_errors` | open error events                | If present | Show only unresolved blockers.                                                                         |
| `git_state`         | git activity events              | If present | Include only meaningful milestones.                                                                    |
| `subagent_work`     | subagent events                  | If present | Summaries only, not raw logs.                                                                          |
| `session_snapshot`  | priority-tiered snapshot         | If present | Compact state restore layer.                                                                           |
| `persistent_memory` | Graphiti cache                   | Optional   | Current emitted shape carries `node_refs`; legacy UUID-bearing blocks remain parse-only compatibility. |

### 7.2 Budget Allocation

| Section group                                                       | Budget                         | Source                     | Latency |
| ------------------------------------------------------------------- | ------------------------------ | -------------------------- | ------- |
| Session Guide core (`last_request`, tasks, decisions, files, rules) | up to 1 600 chars              | Redis events + snapshot    | < 1 ms  |
| Session snapshot detail                                             | up to 800 chars                | Redis `GET`                | < 1 ms  |
| Persistent memory                                                   | remainder of 5% context budget | Redis `GET memory-cache:*` | < 1 ms  |

`persistent_memory` is omitted (not an error) if cache has not been warmed yet,
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

### 10.1 Session ID Semantics and Child-Session Routing

> **Intentional divergence from `mksglu/context-mode`.** Official context-mode
> treats subagent activity as summarized `Agent` tool events within the parent
> session's continuity log — the child session is not a first-class participant
> in session state; only its summary is recorded.
>
> This plugin intentionally promotes child sessions to first-class participants
> in the root session's state. The rationale is that OpenCode's multi-agent
> orchestration (swarm, delegated tasks) produces work that is semantically part
> of the parent session — decisions made, files edited, and errors encountered
> by a child agent are as important to session continuity as parent-originated
> events. Treating them as opaque summaries would lose actionable detail that
> the parent (or a sibling child) needs on the next turn.
>
> **Do not "fix" this by reverting to summarized-only subagent tracking unless
> the design decision is explicitly revisited.** Future alignment sessions with
> upstream context-mode should treat this section as the canonical record of the
> divergence.

Every hook-provided `sessionID` is resolved to a **canonical (root) session ID**
before any state access. When a session has a `parentID`, the plugin walks the
parent chain to find the root session and uses that root ID for all Redis keys,
event storage, snapshot builds, `<session_memory>` injection, and compaction
context. This means child/subagent sessions are first-class participants in the
parent session's memory:

- **Event log**: child prompts, responses, tool calls, and structured events are
  recorded under the root session's `session:{canonicalId}:events` key.
- **Snapshot**: child activity is included when the priority-tiered snapshot is
  rebuilt at `session.idle` or `session.compacted`.
- **`<session_memory>` injection**: the same prepared envelope is used
  regardless of whether the triggering hook fires from a parent or child
  session. `chat.message`, `experimental.chat.messages.transform`, and
  `experimental.session.compacting` all resolve to the canonical session before
  reading or writing state.
- **Compaction**: child-derived events survive compaction because they live in
  the same event list and snapshot as the parent.
- **Future `<session_memory>` injections**: because child events are stored
  alongside parent events, they are included in later snapshot rebuilds and
  appear in subsequent `<session_memory>` injections for any session in the same
  lineage.

Parent/child linkage is established at `session.created` time via
`setParentId()` and cached for the process lifetime. The canonical ID is
resolved lazily (with an SDK lookup fallback) and cached once resolved. Cycle
detection prevents infinite loops in malformed parent chains.

#### Child-Session Deletion Semantics

When a `session.deleted` event fires for a child session, **only that child's
local bookkeeping is removed** (parent-ID cache entry, canonical-ID cache entry,
buffered assistant messages scoped to the child). The canonical/root session's
state, event log, snapshot, and lifecycle are **not** deleted. This prevents a
child session teardown from accidentally wiping the parent's accumulated memory.

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

`GraphitiConfig` keeps only the original top-level Graphiti keys for backward
compatibility, while using explicit nested sections for Redis and Graphiti.
Canonical nested values take precedence whenever both forms are supplied.

```typescript
interface GraphitiConfig {
  // Preferred nested config
  redis?: {
    endpoint?: string; // Redis URL for the plugin hot tier (default: "redis://localhost:6379")
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
  };

  // Legacy top-level keys still accepted during migration (Graphiti settings)
  endpoint?: string;
  groupIdPrefix?: string;
  driftThreshold?: number;

  // Legacy nested compatibility during migration
  falkordb?: {
    redisEndpoint?: string;
    batchSize?: number;
    batchMaxBytes?: number;
    sessionTtlSeconds?: number;
    cacheTtlSeconds?: number;
    drainRetryMax?: number;
  };
}
```

Resolution rules for the implementation:

1. Read Redis settings from `redis.*` first; fall back to legacy nested
   `falkordb.*` only when the higher-precedence value is absent.
2. Read Graphiti settings from `graphiti.*` first; fall back to legacy top-level
   Graphiti keys only when the nested value is absent.
3. New docs, examples, validation, and runtime lookups should use the nested
   shape as canonical; only Graphiti top-level keys remain for compatibility.

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
src/config.ts                    — add canonical `redis`/`graphiti` sections, retain nested `falkordb` compatibility and top-level Graphiti compatibility, and resolve precedence
src/types/index.ts               — add SessionEvent, EventCategory types
src/session.ts                   — SessionState gains hotTierReady; wire Redis client and async Graphiti consolidation worker; remove direct GraphitiClient dependency; add canonical session ID resolution, parent/child linkage cache, and child-safe deletion
src/services/connection-manager.ts — adapt existing MCP transport lifecycle for the new graphiti-mcp.ts wrapper (reconnect backoff, request queuing already implemented)
src/handlers/event.ts            — hot tier writes on all event types, async drain triggers; all hooks resolve to canonical session ID; child deletion preserves parent state
src/handlers/chat.ts             — read from Redis cache instead of sync Graphiti calls; resolves to canonical session ID for child sessions
src/handlers/compacting.ts       — read snapshot + cache from Redis, no Graphiti calls; resolves to canonical session ID for child sessions
src/handlers/messages.ts         — compose canonical `session_memory` envelope from Redis-sourced data; resolves to canonical session ID for child sessions
src/index.ts                     — wire Redis client + async Graphiti MCP worker
```

### Removed/Deprecated Files

```
src/services/client.ts               — replaced by graphiti-mcp.ts
```

---

## 15 Implementation Order

| Phase                            | Files                                                 | Depends On     | Acceptance Criteria                                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0. Normalize MCP contract        | —                                                     | —              | Confirm tool payload/response handling against a reachable Graphiti MCP endpoint.                                                                                              |
| 1. Consolidation backend         | `graphiti-mcp.ts`, `graphiti-async.ts`                | Phase 0        | Async worker can drain, refresh cache, and load primers through Graphiti MCP with no hot-path blocking.                                                                        |
| 2. Redis primitives              | `redis-client.ts`, `redis-events.ts`                  | —              | LPUSH/LRANGE/GET/SET work against FalkorDB. Connection retry works.                                                                                                            |
| 3. Event extractor               | `event-extractor.ts`, `types/index.ts`                | —              | Hook payloads produce context-mode-equivalent `SessionEvent` categories. Unit tests.                                                                                           |
| 4. Snapshot builder              | `redis-snapshot.ts`                                   | Phase 3        | Priority-tiered XML snapshot generated from event list. Budget enforcement. Unit tests.                                                                                        |
| 5. Local search strategy         | —                                                     | Phases 2, 4    | Redis/FalkorDB-only session recall path works; optional RediSearch path documented if available.                                                                               |
| 6. Memory cache                  | `redis-cache.ts`                                      | Phases 1, 2    | Async Graphiti search results written to and read from Redis. TTL expiry. Stale-read behavior.                                                                                 |
| 7. Batch drain                   | `batch-drain.ts`                                      | Phases 1, 2, 3 | Events drain to Graphiti async with sequential ingest semantics by `groupId`. Cursor tracking. Crash recovery.                                                                 |
| 8. Wire handlers                 | `event.ts`, `chat.ts`, `compacting.ts`, `messages.ts` | Phases 2–7     | All hooks use Redis hot path. No synchronous Graphiti calls remain. Existing test assertions hold.                                                                             |
| 9. Config & bootstrap            | `config.ts`, `index.ts`, `session.ts`                 | Phase 8        | Nested `redis`/`graphiti` config is validated, legacy nested `falkordb` compatibility remains, top-level Graphiti fallback works, and canonical nested values take precedence. |
| 10. Docs alignment ✓ (completed) | `README.md`                                           | Phase 9        | ✓ README incorporates all adopted context-mode feature descriptions and credits the original author/project by name.                                                           |
| 11. Integration tests            | —                                                     | All            | End-to-end: message -> Redis event -> snapshot -> async drain -> Graphiti -> cache refresh -> injection.                                                                       |

---

## 16 Confirmed Decisions, Remaining Validation, and Future Options

### 16.1 Confirmed decisions for this plan

- **Hot path:** FalkorDB/Redis (configured canonically via `redis.endpoint`,
  with legacy fallback to nested `falkordb.*`) is the hot path for writes,
  snapshots, and cached reads.
- **Cold/async backend:** Graphiti stays off the hot path. The consolidation
  backend is Graphiti MCP (configured via `graphiti.endpoint`, with legacy
  fallback to `endpoint`).
- **Hook model:** because OpenCode lacks `SessionStart`, first-turn memory must
  rely on `event: session.created` bootstrap + `chat.message` +
  `experimental.chat.messages.transform`.
- **Naming:** the canonical injected structure remains `session_memory` with
  optional `persistent_memory`.
- **Storage scope:** do not add new independent storage such as SQLite.
- **Docs alignment:** README has been updated to reflect the two-layer
  architecture design and includes acknowledgement of the context-mode
  inspiration with proper attribution.
- **Child-session routing diverges from context-mode (intentional):** official
  context-mode records subagent work as summarized `Agent` tool events. This
  plugin instead resolves every child/subagent session to the canonical root
  session and treats child events as first-class entries in the shared event
  log, snapshot, and `<session_memory>` injection. See §10.1 for the full
  rationale. This is a deliberate design choice, not an alignment gap.

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
- [ ] **Drift detection heuristic**: the cached Jaccard approach compares query
      UUID sets rather than issuing a live search. Validate that this is good
      enough in practice.
- [ ] **Connection manager reuse**: the existing
      `src/services/connection-manager.ts` (from `plans/ConnectionManager.md`)
      already implements MCP transport lifecycle, reconnect backoff, and request
      queuing. Decide whether `graphiti-mcp.ts` wraps it as-is, adapts it, or
      replaces it.

### 16.3 Pending: Memory Hygiene and Legacy Injection Cleanup

**Status:** Implemented and verified in repo tests (live-session
cleanup/validation still pending)

The current implementation still has a serious memory-quality problem even
though the hot-path architecture itself has been migrated to FalkorDB/Redis +
async Graphiti MCP. In live sessions, the canonical `<session_memory>` envelope
is being polluted by duplicated user text, assistant operational chatter,
tool-call scaffolding, and transcript-heavy residue that should never be treated
as durable continuity state. The same user instruction is often copied into
multiple sections such as `last_request`, `active_tasks`, and `key_decisions`,
which wastes prompt budget and weakens the signal that these sections are
supposed to carry. Assistant-authored analysis and planning text is also being
promoted into `unresolved_errors`, `discoveries`, and `residual_messages`,
causing the plugin to remember its own commentary rather than the user's actual
goals, decisions, blockers, and file work.

The problem is broader than simple duplication. Raw tool transcript content is
still entering the memory pipeline: `Read` output dumps, wrapper tags such as
`<path>` and `<content>`, agent/tool orchestration text, and previously injected
memory blocks are being re-consumed as fresh session evidence. This creates a
feedback loop where memory injection becomes self-referential: old injected
memory is parsed again, assistant summaries are stored as facts, and the next
turn receives an even noisier envelope. The result is a prompt that is larger,
less stable, and less representative of the true session state than the
context-mode-style continuity model this overhaul is trying to preserve.

Persistent memory quality is also compromised by stale or low-value Graphiti
facts. Instead of surfacing durable project knowledge, the current
`persistent_memory` block can include meta-facts about planning files, assistant
actions, prior phrasing suggestions, and historical implementation chatter that
is no longer relevant to the active turn. At the same time, the legacy top-level
`<memory data-uuids="...">...</memory>` format is still appearing alongside the
canonical `<session_memory>` path in some live runs, which indicates that
compatibility handling is still leaking into effective prompt output. Until
these hygiene issues are fixed, the architecture change is only partially
successful: Graphiti is off the hot path, but the injected continuity state is
still too noisy, too repetitive, and too contaminated by assistant/tool
artifacts to deliver the intended resumability benefits.

#### 16.3.1 Alignment target

This cleanup should intentionally move the hot path closer to context-mode's
session-continuity behavior. The design goal is not simply "less verbose"
memory; it is a narrower contract for what counts as durable working state.
Context-mode's implementation works because it primarily stores compact,
category-specific events and reconstructs a small resume snapshot from those
events rather than replaying transcripts. The same principle should govern this
plugin's hot tier.

The target behavior is:

- event storage is compact, typed, and continuity-oriented rather than
  transcript-oriented
- tool outputs are used to infer structure, not replayed as durable memory text
- assistant operational prose is not treated as project memory
- injected memory is stable, small, and semantically partitioned
- Graphiti acts as an optional background knowledge source, not a second
  transcript channel

In practice, that means the hot path should remember things like the user's last
request, active tasks, files in play, key decisions, and concrete blockers, but
not the raw `Read` result, not the assistant's planning narration, and not the
XML/text wrappers of previously injected memory.

#### 16.3.2 Revised hot-tier data contract

The hot-path pipeline should enforce a stricter contract at each stage:

1. **Sanitize before extraction**: remove injected memory blocks and obvious
   wrapper text before any new event extraction occurs.
2. **Extract compact events**: store concise, typed continuity events with hard
   length limits and category-specific schemas.
3. **Build a conservative snapshot**: synthesize only high-value continuity
   sections; treat everything else as discardable.
4. **Render a stable envelope**: produce a deterministic `<session_memory>`
   block whose sections do not duplicate each other.
5. **Drain only semantic episodes**: send Graphiti compact facts about work
   state, not conversational residue.

Each stage should be allowed to throw away information aggressively. The point
of the hot tier is resumability, not archival completeness.

#### 16.3.3 Input sanitization and reinjection prevention

The first concrete change should be to prevent the pipeline from re-consuming
its own output.

Planned implementation details:

- In `src/handlers/chat.ts` and any extraction entrypoint, strip leading
  canonical `<session_memory ...>...</session_memory>` blocks before deriving
  `last_request` or user events.
- In `src/handlers/messages.ts`, continue parsing visible UUID metadata from
  legacy `<memory data-uuids>` blocks for compatibility, but strip legacy block
  text from the effective user content before it can be re-extracted.
- Add a shared sanitizer utility that removes:
  - canonical injected memory blocks
  - legacy injected memory blocks
  - wrapper lines such as `<path>`, `<content>`, and similar tool-output tags
    when they are part of replayed tool transcript rather than true user input
- Ensure this sanitizer runs before both hot-tier event extraction and async
  Graphiti drain preparation.

This stage is required to break the self-referential loop visible in live
sessions, where injected memory and tool transcript wrappers become fresh memory
material on the next turn.

#### 16.3.4 Extraction redesign around context-mode-like compact events

`src/services/event-extractor.ts` should be narrowed so it behaves more like
context-mode's compact event extraction model.

Planned extraction policy by source:

- **User message events**
  - Keep: explicit request/intent, user decisions, preferences, task updates,
    user-pasted data references when genuinely user-originated.
  - Reject: repeated injected memory text, quoted assistant prose, copied tool
    output, and orchestration chatter.
- **Read/search tool events**
  - Keep: file path, query, maybe a tiny summary derived from metadata.
  - Reject: full returned content, wrapper blocks, and long bodies.
- **Edit/write tool events**
  - Keep: touched file path plus a short semantic summary if one is reliably
    derivable.
- **Error events**
  - Keep: concrete failing command/tool name, status, concise failure text.
  - Reject: assistant hypotheses, debugging commentary, and narrative status
    updates.
- **Subagent events**
  - Keep: launch intent and terse completion result.
  - Reject: full delegated report bodies.
- **Integration/MCP events**
  - Keep: service call occurred, optional tool name, success/failure signal.
  - Reject: request/response payload bodies.

This redesign should also reduce the default payload size of each stored event.
By default, event bodies should be one sentence or one path-like datum, not an
open-ended transcript field.

#### 16.3.5 Section-specific rendering rules and dedupe

The canonical `<session_memory>` envelope should follow a more rigid section
contract so the same sentence cannot be repeated across multiple sections.

Planned section semantics:

- `last_request`
  - exactly one normalized user request from the latest turn
  - never duplicated verbatim in any other section
- `active_tasks`
  - only explicit task-state items or inferred work items with task-like shape
  - should not restate `last_request` if no real task structure exists
- `key_decisions`
  - only user decisions/preferences/corrections that materially changed the
    direction of work
- `files_in_play`
  - paths only
- `project_rules`
  - rule paths or compact rule summaries only
- `unresolved_errors`
  - concrete unresolved blockers only
- `session_snapshot`
  - compact secondary restore layer only; never a replay of upper sections

Implementation should normalize candidate strings and use explicit precedence
when deduping:

- `last_request` outranks `active_tasks`
- `active_tasks` outrank `key_decisions` when text is effectively the same work
  item
- explicit user decisions outrank generic discoveries
- `session_snapshot` must not restate text already emitted in top-level fields

This is the direct fix for the failure mode where one user sentence currently
lands in `last_request`, `active_tasks`, and `key_decisions` simultaneously.

#### 16.3.6 Snapshot simplification

`src/services/redis-snapshot.ts` should become more conservative and closer to
context-mode's priority-tiered snapshot builder.

Planned changes:

- preserve a small number of high-value sections only:
  - decisions / constraints
  - active task state
  - active files / recent edits
  - concrete blockers / unresolved errors
  - environment / git state
- heavily cap or omit low-value sections such as:
  - `discoveries`
  - `references`
  - `residual_messages`
- make omission the default for weak sections rather than filling them with
  low-quality text
- enforce deterministic ordering and small fixed limits so the same session
  state renders similarly across turns

The snapshot should be boring and durable. If a section cannot be represented in
compact, high-signal form, it should not be injected.

#### 16.3.7 Graphiti drain and cache filtering

The async Graphiti tier should inherit the same compact-memory discipline;
otherwise `persistent_memory` will remain polluted even if the hot-tier snapshot
improves.

Planned changes:

- Drain only semantic episodes built from structured events, not raw transcript
  fragments.
- Reject drain entries dominated by:
  - tool scaffolding
  - injected memory text
  - assistant operational narration
  - agent-control syntax
  - file-content dumps
- During cache refresh, prefer durable facts about:
  - architecture decisions
  - constraints
  - explicit user preferences
  - major work milestones
  - meaningful project entities
- Filter out stale or low-value facts about:
  - prior phrasing suggestions
  - assistant planning chatter
  - tool routing advice
  - historical meta-discussion unrelated to active work
- Prefer rendering facts over nodes, and render nodes only when they add unique
  value.

This should make `persistent_memory` act like sparse background knowledge,
closer to context-mode's retrieval posture, rather than an echo chamber of old
agent conversation.

#### 16.3.8 Rollout and cleanup

Because existing Redis and Graphiti data are already polluted, the rollout must
include a cleanup step after the code-level hygiene fixes land.

Planned rollout steps:

- land sanitization, extraction, snapshot, and drain filtering changes first
- validate behavior in unit tests and targeted integration tests
- reset or namespace polluted Redis hot-tier keys for the affected project
- reset or namespace Graphiti group data so stale low-value facts stop
  repopulating cache
- verify fresh-session behavior after cleanup, not just behavior in an already
  poisoned namespace

Without this cleanup, old low-value facts may continue to dominate recall and
hide whether the new extraction rules are actually working.

#### 16.3.9 Required verification

This work should only be considered complete when both code-level and live-run
verification show that the hot path now behaves more like context-mode's compact
continuity model.

Required verification targets:

- sanitizer tests proving injected memory cannot be re-consumed as new input
- extraction tests proving `Read`/search outputs store refs rather than bodies
- section-dedupe tests proving the same normalized text cannot occupy
  `last_request`, `active_tasks`, and `key_decisions` together
- transform tests proving canonical and legacy memory blocks cannot coexist in
  final injection
- Graphiti drain/cache tests proving assistant chatter and transcript wrappers
  are rejected
- live-session validation proving assistant planning text no longer appears in
  `unresolved_errors`, `discoveries`, or `persistent_memory`
- live-session validation proving the injected envelope is smaller, more stable,
  and more continuity-focused across turns

- [x] **Strip injected memory before extraction**: before processing a new user
      turn, remove leading legacy `<memory ...>...</memory>` and canonical
      `<session_memory ...>...</session_memory>` blocks so injected context is
      not re-learned as fresh content.
- [x] **Harden memory hygiene filters**: never persist raw tool payloads, `Read`
      output dumps, XML-like wrappers, assistant operational chatter, or agent
      orchestration text into hot-tier summaries or Graphiti drain batches.
- [x] **Make extraction allowlist-based**: only promote durable continuity
      signals such as user intent, explicit decisions, active tasks, file
      edits/writes, meaningful git milestones, and real unresolved errors.
- [x] **Stop storing transcript-heavy tool bodies**: keep refs and compact
      summaries for file reads/searches, but do not retain full returned file
      contents in session memory or Graphiti episodes.
- [x] **Gate async Graphiti writes more aggressively**: skip semantic drain
      entries whose content is primarily tool-call scaffolding, injected memory,
      assistant self-narration, or agent-control text.
- [x] **Shrink the injected envelope**: favor `last_request`, `active_tasks`,
      `key_decisions`, and `files_in_play`; heavily cap or suppress noisy
      `discoveries`, `residual_messages`, and assistant-originated
      `unresolved_errors`.
- [x] **Add regression coverage**: verify that legacy `<memory>` does not leak
      into new injections, duplicated text does not land across multiple
      sections, assistant chatter is not stored as errors, and noisy persistent
      memory facts are filtered out.
- [ ] **Plan one-time cleanup of poisoned state**: after code fixes land, reset
      or namespace polluted Redis hot-tier keys and Graphiti group data so stale
      low-value memories stop resurfacing.

### 16.4 Future options (non-final)

- [ ] **More proactive cache prewarm**: broaden warmup beyond `get_episodes`
      into project-scope `search_memory_facts`/`search_nodes` if the extra async
      work is worth the cache-hit improvement.
- [ ] **Alternative Graphiti transport**: direct Graphiti HTTP could be
      revisited later only if its API surface is confirmed and there is a
      concrete reason to move away from MCP. It is not part of the current plan.
