# opencode-graphiti

OpenCode plugin that gives your AI agent **short-term memory** and **long-term
memory**.

**Short-term memory** continuously summarizes and compacts every meaningful
session event — decisions, active tasks, file edits, errors, and more — into a
priority-tiered snapshot that is re-injected before every LLM call and every
compaction. The result is a rolling window of session continuity that
effectively extends the usable context far beyond the model's native limit: the
agent always knows what it was doing, even after the conversation is compacted.

**Long-term memory** persists knowledge across sessions via a
[Graphiti](https://github.com/getzep/graphiti) knowledge graph, so the agent can
recall project facts, past decisions, and learned preferences from earlier work
— not just the current session.

## Motivation

Long-running AI coding sessions depend on persistent memory to stay on track.
When the context window fills up and OpenCode triggers compaction, the
summarizer discards details that were never captured outside the conversation.
The result is **context rot**: the agent loses track of recent decisions,
re-explores solved problems, and drifts away from the original goal.

Graphiti's MCP server is a powerful knowledge-graph backend, but calling it on
every message adds latency and introduces a single point of failure —
connections drop, queries time out, and ingestion silently fails.

This plugin exists to close both gaps.

**Short-term memory** captures every meaningful event during the session —
decisions, task progress, file edits, errors, environment changes — and
continuously summarizes them into a compact, priority-tiered snapshot. That
snapshot is re-injected before every LLM call and before every compaction, so
the agent always retains a coherent picture of the active workstream. Because
the snapshot is continuously rebuilt from structured events rather than raw
conversation text, it survives compaction intact: the model picks up exactly
where it left off, no matter how many times the conversation has been
summarized. In practice, this creates a rolling session memory that extends the
effective context window well beyond the model's native limit.

**Long-term memory** lives in Graphiti's knowledge graph, which is updated in
the background so it never slows down your conversation. It provides
cross-session recall — project facts, past decisions, and learned preferences
from earlier sessions — cached locally for instant injection alongside the
short-term snapshot.

## Overview

This plugin uses a two-layer memory architecture:

**Short-term memory — continuously summarized session continuity:**

- Captures every meaningful event (decisions, tasks, file edits, errors,
  environment changes) as structured session events
- Continuously rebuilds a priority-tiered snapshot from those events, keeping
  the most important context within a tight budget
- Re-injects the snapshot before every LLM call and every compaction as a
  `<session_memory>` block, so the agent never loses track of the active
  workstream — even after repeated compactions
- Detects topic drift and schedules a background refresh of cached long-term
  facts when the conversation shifts

**Long-term memory — persistent cross-session recall via Graphiti:**

- Sends buffered session events to Graphiti as episodes on idle or before
  compaction
- Refreshes the local memory cache from Graphiti search results in the
  background
- Provides cross-session recall via vector/graph search, cached locally for
  instant injection alongside the short-term snapshot
- Saves compaction summaries as episodes so knowledge survives across session
  boundaries

Graphiti stays off the steady-state hook path entirely: hook-time injection uses
only Redis/local cached recall, while fresh Graphiti data arrives through the
existing background refresh path on later turns.

### MCP-First Execution Surface

The plugin exposes a set of `session_*` MCP tools as the **primary execution
surface** for data-heavy work. These tools run in-process alongside the plugin
hooks and share the same canonical root-session identity and Redis/FalkorDB hot
tier.

The `session_*` tools also write into the same local continuity model as the
rest of the session: their bounded summaries are recorded as structured events,
folded into the local snapshot, and preserved through compaction under the same
`<session_memory>` envelope used for ordinary chat continuity.

- **Bounded execution** (`session_execute`, `session_execute_file`,
  `session_batch_execute`) — run commands or process files locally, store full
  output in the local corpus, and return only a bounded summary to the model.
  `session_batch_execute` supports ordered mixed steps, so one request can
  combine bounded command execution with local corpus search.
- **Local indexing and search** (`session_index`, `session_search`,
  `session_fetch_and_index`) — index content into a per-session local corpus in
  Redis/FalkorDB and search it with bounded result sets. The local corpus stays
  local-first: indexing and retrieval happen against the session's local store,
  while any Graphiti augmentation remains asynchronous and cache-backed.
  `session_index` accepts either inline `content` or a local `path`; when the
  same `source` and `label` are indexed again for one root session, the prior
  logical document is replaced instead of appended.
- **Diagnostics** (`session_stats`, `session_doctor`) — inspect session state
  and corpus health.

The plugin hooks enforce this preference: when the model falls back to risky
native tools (e.g. unbounded `WebFetch` or raw `curl`), the hook layer may
redirect or deny the call and suggest the corresponding `session_*` tool. Hooks
remain secondary — they handle enforcement, continuity capture, snapshot
assembly, and `<session_memory>` injection, but are not the primary execution
path.

For the full MCP-first architecture, see
`docs/superpowers/plans/2026-03-20-context-mode-mcp-first.md`.

## Prerequisites

Start the
[Graphiti MCP server](https://github.com/getzep/graphiti/tree/main/mcp_server)
with its default [FalkorDB](https://www.falkordb.com/) backend:

```bash
git clone https://github.com/getzep/graphiti.git
cd graphiti/mcp_server
docker compose up -d
```

This starts Graphiti at `http://localhost:8000/mcp` and FalkorDB/Redis on
`localhost:6379`.

This plugin reuses that same FalkorDB/Redis storage layer alongside Graphiti: it
keeps short-term memory locally for every turn, while Graphiti builds the
long-term knowledge graph on top of the same backend.

> **Note:** Graphiti is optional for basic operation. If Graphiti is
> unavailable, the plugin continues to function with FalkorDB/Redis-sourced
> session memory; only the `<persistent_memory>` section (long-term
> cross-session facts) will be absent until Graphiti comes online.

## Installation

### Option A: npm package (recommended)

Add the plugin to your `opencode.json` (or `opencode.jsonc`):

The package root intentionally exports only the `graphiti` plugin entrypoint.
Helper symbols under `src/` are internal implementation details and are not a
supported public import surface.

```jsonc
{
  "plugin": ["opencode-graphiti"]
}
```

### Option B: Local build

Local distributable builds are not a routine local setup step: `deno task
build`
uses the `VERSION` environment variable when set and otherwise falls back to the
`version` in `deno.json` via `dnt.ts`. If you already have a built artifact, add
it to your `opencode.json`:

```jsonc
{
  "plugin": ["file:///absolute/path/to/opencode-graphiti/dist/esm/mod.js"]
}
```

### Option C: Plugin directory

Copy the built plugin into OpenCode's auto-loaded plugin directory:

```bash
# Global (all projects)
cp dist/esm/mod.js ~/.config/opencode/plugins/opencode-graphiti.js

# Or project-level
mkdir -p .opencode/plugins
cp dist/esm/mod.js .opencode/plugins/opencode-graphiti.js
```

No config entry needed — OpenCode loads plugins from these directories
automatically.

## Configuration

Supported config locations, in lookup order:

1. The provided project directory: `package.json#graphiti`, `.graphitirc`, and
   other standard `cosmiconfig` `graphiti` filenames
2. Standard global/home `graphiti` config locations discovered by `cosmiconfig`
   (for example `~/.graphitirc`)
3. Legacy fallback: `~/.config/opencode/.graphitirc`

### Nested Config Shape (recommended)

```jsonc
{
  "redis": {
    // Redis endpoint used for the plugin hot tier
    "endpoint": "redis://localhost:6379",
    // Max events per drain batch
    "batchSize": 20,
    // Max combined body bytes per drain batch
    "batchMaxBytes": 51200,
    // Session event TTL in seconds (default: 24 h)
    "sessionTtlSeconds": 86400,
    // Memory cache TTL in seconds (default: 10 min)
    "cacheTtlSeconds": 600,
    // Max drain retry attempts before dead-lettering
    "drainRetryMax": 3
  },
  "graphiti": {
    // Graphiti MCP server endpoint
    "endpoint": "http://localhost:8000/mcp",
    // Prefix for project group IDs (e.g. "opencode-my-project")
    "groupIdPrefix": "opencode",
    // Jaccard similarity threshold (0–1) below which cache is refreshed
    "driftThreshold": 0.5
  }
}
```

All fields are optional — defaults (shown above) are used for any missing
values. Canonical nested values take precedence when both forms are supplied.

### Retained Compatibility

The canonical hot-tier config shape is `redis.*`. Only the original Graphiti
top-level aliases remain supported for backward compatibility. Precedence is:

1. `redis.*` (canonical)
2. top-level Graphiti aliases such as `endpoint` and `groupIdPrefix`

Endpoint values must be valid URLs, so include the scheme explicitly - for
example `redis://localhost:6379` for Redis and `http://localhost:8000/mcp` for
Graphiti.

### Legacy Top-Level Keys

For backward compatibility, the following original Graphiti top-level keys are
still accepted and map to their nested equivalents:

| Legacy key       | Nested equivalent         |
| ---------------- | ------------------------- |
| `endpoint`       | `graphiti.endpoint`       |
| `groupIdPrefix`  | `graphiti.groupIdPrefix`  |
| `driftThreshold` | `graphiti.driftThreshold` |

Removed top-level Redis aliases are no longer supported.

## How It Works

### Injection Format

The plugin injects a **local-first** `<session_memory>` XML envelope into the
last user message. Every section except `<persistent_memory>` is assembled
entirely from Redis/FalkorDB state — no external service is on the synchronous
path.

- **Local continuity sections** (`<last_request>`, `<active_tasks>`,
  `<key_decisions>`, `<files_in_play>`, `<project_rules>`, etc.) are derived
  from structured session events stored in Redis/FalkorDB.
- **`<session_snapshot>`** is produced by the local snapshot service, which
  continuously rebuilds a priority-tiered summary from those events.
- **`<persistent_memory>`** is an **optional, cache-only** augmentation. When
  Graphiti-sourced facts are cached locally, they are included; on a cold first
  turn or when Graphiti is unreachable, this section is simply absent. It never
  blocks the current turn.

```xml
<session_memory source="graphiti" version="1">
  <last_request>Continue the current task.</last_request>
  <active_tasks><task>Implement the new feature.</task></active_tasks>
  <key_decisions><decision>Use Redis for short-term memory.</decision></key_decisions>
  <files_in_play><file>src/index.ts</file></files_in_play>
  <project_rules><rule>Graphiti runs in the background only.</rule></project_rules>
  <session_snapshot><!-- priority-tiered snapshot --></session_snapshot>
  <persistent_memory node_refs="nodeA">
    <!-- long-term node/episode summaries from Graphiti, optional -->
  </persistent_memory>
</session_memory>
```

### Session Memory Preparation (`chat.message`)

On each user message the plugin assembles the current session memory from
local-only sources:

- **Session events** stored in Redis/FalkorDB
- **Priority-tiered snapshot** rebuilt by the local snapshot service
- **Cached Graphiti facts** (optional; read from the local Redis cache, never
  from a synchronous Graphiti call)

These are composed into a `<session_memory>` envelope and staged for the
transform hook. All reads are local/cache-backed; Graphiti is never called
synchronously. Any fresh Graphiti lookup remains on the existing background
refresh path and benefits the next turn instead of blocking the current one.

### User Message Injection (`experimental.chat.messages.transform`)

The transform hook reads the prepared `<session_memory>` envelope and prepends
it to the last user message. Legacy `<memory data-uuids>` and older
`<persistent_memory fact_uuids>` blocks are still scrubbed and parsed for
compatibility, while current `<persistent_memory>` output uses `node_refs`. This
approach keeps the system prompt static, enabling provider-side prefix caching,
and avoids influencing session titles. The prepared injection is cleared after
use so stale context is not re-injected on subsequent LLM calls within the same
turn.

### Drift Detection and Background Cache Refresh

On each user message, the plugin compares the current query against the query
that produced the cached memory. When Jaccard similarity between the current
query text and cached query text drops below `driftThreshold` (default 0.5), a
background cache refresh is scheduled via Graphiti. The current cached context
is still injected immediately; the refreshed cache becomes available on the next
message. This trades one message of staleness for keeping most long-term memory
refresh work off the response-time path.

### Event Extraction and Buffering (`event`)

User and assistant messages are captured as structured `SessionEvent` objects
and stored in Redis (`session:{id}:events`). The plugin listens on
`message.part.updated` to buffer assistant text as it streams, and on
`message.updated` to finalize completed assistant replies.

Events are also queued for background ingestion into long-term memory:

- **On idle** (`session.idle`): buffered events are sent to Graphiti and the
  priority-tiered snapshot is rebuilt.
- **After compaction** (`session.compacted`): the compaction summary and any
  pending continuity are scheduled for background Graphiti ingestion so nothing
  is lost across compaction boundaries.

### Compaction Preservation

Compaction is handled entirely by OpenCode's native compaction mechanism. The
plugin ensures session continuity survives each compaction cycle:

1. **Before compaction** (`experimental.session.compacting`): The plugin injects
   the same `<session_memory>` envelope used for chat — including the
   priority-tiered snapshot and cached long-term facts — so the summarizer
   preserves important knowledge. No Graphiti call is made.
2. **After compaction** (`session.compacted`): The snapshot is rebuilt from
   structured events and the compaction summary is sent to Graphiti in the
   background, ensuring knowledge survives across compaction boundaries.

Because the snapshot is rebuilt from structured events rather than raw
conversation text, the agent retains a coherent picture of the workstream
regardless of how aggressively the conversation was summarized.

### Child / Subagent Session Handling

> **Note:** This behavior intentionally diverges from
> [context-mode](https://github.com/mksglu/context-mode), which records subagent
> work as summarized tool events. This plugin promotes child sessions to
> first-class participants in the root session's state so that decisions, file
> edits, and errors from delegated work are fully visible to the parent session.
> See `docs/ContextOverhaul.md` §11.1 for the design rationale.

When OpenCode spawns a child session (e.g. a subagent or delegated task), the
plugin resolves the child's `sessionID` to the root/parent session by walking
the `parentID` chain. All event storage, snapshot builds, and `<session_memory>`
injection then operate on the canonical root session, so child activity is
treated identically to parent activity:

- Child prompts and responses are recorded in the same event log as the parent.
- The priority-tiered snapshot includes child-derived events when it is rebuilt.
- Future `<session_memory>` injections — for both parent and child turns —
  reflect the combined activity of the entire session lineage.
- Deleting a child session removes only that child's local bookkeeping; the root
  session's state, events, and snapshot are preserved.

This means the agent retains full continuity across delegation boundaries
without any special configuration.

### Project Scoping

Each project gets a unique `group_id` derived from its directory name (e.g.
`opencode_my-project`). Group IDs only allow letters, numbers, dashes, and
underscores (colons are not allowed). This ensures memories from different
projects stay isolated.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and release
process. In CI, pushes to `main` publish `latest` releases, while pull requests
targeting `main` publish canary builds under the `canary` dist-tag.

## License

MIT

## Acknowledgements

The structured event extraction, priority-tiered snapshots, and session
continuity design in this plugin are inspired by
[context-mode](https://github.com/mksglu/context-mode).

The original plugin concept is inspired by
[opencode-openmemory](https://github.com/happycastle114/opencode-openmemory).
