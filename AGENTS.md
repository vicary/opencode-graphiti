# opencode-graphiti: Repository Anti-Drift Guide

## What This Repository Does

**opencode-graphiti** is an OpenCode plugin that provides persistent memory for
AI agent sessions. It is a two-layer architecture:

- **Short-term memory**: Continuously extracts structured session events
  (decisions, tasks, file edits, errors) and rebuilds a priority-tiered snapshot
  stored in Redis/FalkorDB. This snapshot survives compaction and is re-injected
  before every LLM call.
- **Long-term memory**: Asynchronously sends buffered events to Graphiti (a
  knowledge graph MCP server) in the background. Graphiti results are cached
  locally in Redis and injected alongside the short-term snapshot for
  cross-session recall.

**Key invariant**: Graphiti is never on the hot path. All writes and queries for
chat/compaction hooks use only Redis/FalkorDB; Graphiti updates happen
asynchronously on idle or after compaction.

## Critical Architecture Boundaries

### Hot Path

- **Redis/FalkorDB** only. ioredis client at `redis://localhost:6379`
  (configurable).
- Stores: session events, snapshots, memory cache, pending drain batches.
- Used by: `chat.message`, `messages.transform`, `session.compacting`, event
  handlers.

### Async Tier (Background)

- **Graphiti MCP** HTTP endpoint (default `http://localhost:8000/mcp`,
  configurable).
- Async drain service: batches buffered events, retries on failure, flushes on
  idle or post-compaction.
- Background cache refresh: searches Graphiti when topic drift is detected,
  updates Redis cache.
- Never blocks hook return time.

### Session Continuity Across Delegation

- Child/subagent sessions resolve to root sessionID via `parentID` chain.
- All child events are recorded in the root session's event log.
- Snapshots and `<session_memory>` injection reflect combined parent + child
  activity.
- Deleting a child session preserves root state and events.

## Workflows

### Session Memory Injection

1. **chat.message**: Session events + snapshot loaded from Redis, cached
   Graphiti facts retrieved, composed into `<session_memory>` XML, staged for
   transform hook.
2. **messages.transform**: `<session_memory>` prepended to last user message
   (right before LLM call).
3. **Drift detection**: Current query vs. cached query; if Jaccard similarity <
   `driftThreshold` (default 0.5), schedule Graphiti cache refresh for next
   turn.
4. **session.compacting**: Same `<session_memory>` envelope injected into
   compaction summary (no fresh Graphiti call).

### Event Extraction and Buffering

- User/assistant messages captured as `SessionEvent` objects, stored in Redis as
  `session:{id}:events`.
- Events queued for async drain to Graphiti.
- **On idle** (`session.idle`): drain pending events to Graphiti, rebuild
  snapshot.
- **Post-compaction** (`session.compacted`): schedule async drain and snapshot
  rebuild.

### GitHub PR Review Handling

- **See `docs/ReviewProtocol.md`** for the complete workflow.
- Detect active PR → fetch unresolved review comments → spawn concurrent swarm
  sessions per item → verify claims → apply narrow fixes → resolve threads →
  push → request fresh review.

## Validation Expectations

- **Config loading**: Supports `cosmiconfig` discovery + nested `redis.*` and
  `graphiti.*` keys. See `src/config.ts`.
- **Redis connectivity**: When available, Redis/FalkorDB stores events,
  snapshots, and cache. If Redis is unavailable, the plugin degrades to
  in-memory fallback. Graphiti is optional; plugin continues with local-only
  mode if unavailable.
- **Compaction survival**: Snapshots and events must persist across compaction
  cycles. Test via `docs/ContextOverhaulTests.md`.
- **Concurrency**: Multiple child sessions should not corrupt root snapshot.
  Serialize child event writes to avoid race conditions.

## Risky Areas

1. **Session root resolution**: Parent ID chain walk must not infinite-loop;
   validate chain structure to avoid cycles.
2. **Event ordering**: Redis LPUSH/LRANGE preserve order, but concurrent writes
   risk out-of-order injection if not serialized.
3. **Snapshot budget**: Priority-tiered snapshot has hard limits
   (`SNAPSHOT_BODY_BUDGET`, `PERSISTENT_MEMORY_BODY_BUDGET`). Oversized events
   may be truncated; monitor via test suite.
4. **Drain batch retry logic**: Failed Graphiti writes retry up to
   `drainRetryMax` times (default 3). Dead-lettered entries are retained in
   Redis dead-letter storage but not automatically recovered.
5. **Cache stale reads**: On Graphiti unavailability, cached facts may be stale;
   no explicit cache invalidation exists.

## Resume-Reading Order

When starting work, read in this order:

1. **This file** (AGENTS.md) — overview and boundaries.
2. **README.md** (§1–4) — detailed motivation, architecture, injection format,
   workflows.
3. **docs/ReviewProtocol.md** — if handling PR reviews.
4. **src/index.ts** — plugin entry point; see which services are instantiated
   and how.
5. **src/session.ts** — session ID resolution, memory composition, root-finding
   logic.
6. **src/handlers/** — event capture, chat injection, compaction, message
   transform.
7. **src/services/** — Redis clients, batch drain, Graphiti async worker, cache
   management.
8. **docs/ContextOverhaul.md** — full design rationale (especially for async
   decisions and event taxonomy).
9. **docs/ContextOverhaulTests.md** — runtime validation entry point and rewrite
   status.
10. **deno.json** — dependencies and build tasks.

## Configuration

Default config file locations (cosmiconfig order):

- Project: `package.json#graphiti`, `.graphitirc`, `graphiti.config.*`
- Home: `~/.graphitirc`, `~/.config/graphiti/*`
- Legacy: `~/.config/opencode/.graphitirc`

Canonical shape (nested):

```jsonc
{
  "redis": {
    "endpoint": "redis://localhost:6379",
    "batchSize": 20,
    "batchMaxBytes": 51200,
    "sessionTtlSeconds": 86400,
    "cacheTtlSeconds": 600,
    "drainRetryMax": 3
  },
  "graphiti": {
    "endpoint": "http://localhost:8000/mcp",
    "groupIdPrefix": "opencode",
    "driftThreshold": 0.5
  }
}
```

Endpoint values must be explicit URLs with schemes, for example
`redis://localhost:6379` for Redis and `http://localhost:8000/mcp` for Graphiti.

## Key Files & Their Scope

| File                                 | Purpose                                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| `src/index.ts`                       | Plugin factory; wires all services.                         |
| `src/session.ts`                     | Session root resolution, memory composition, XML rendering. |
| `src/handlers/chat.ts`               | `chat.message` hook; prepares `<session_memory>`.           |
| `src/handlers/messages.ts`           | `messages.transform` hook; injects into LLM message.        |
| `src/handlers/compacting.ts`         | `session.compacting` hook; injects for summarization.       |
| `src/handlers/event.ts`              | Event capture from all message hooks.                       |
| `src/services/redis-cache.ts`        | Graphiti cache, drift detection, TTL.                       |
| `src/services/redis-events.ts`       | Event list storage, cleanup.                                |
| `src/services/graphiti-async.ts`     | Async drain worker, Graphiti interaction.                   |
| `src/services/connection-manager.ts` | Graphiti MCP health checks.                                 |
| `src/services/batch-drain.ts`        | Event batching, retry logic.                                |
| `docs/ContextOverhaul.md`            | Full design document.                                       |
| `docs/ContextOverhaulTests.md`       | Runtime validation entry point and rewrite status.          |
| `docs/ReviewProtocol.md`             | PR review handling workflow.                                |

---

**Last Updated:** 2026-03-19
