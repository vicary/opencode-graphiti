# opencode-graphiti

OpenCode plugin that provides persistent memory via
[FalkorDB](https://www.falkordb.com/)/Redis and asynchronous
[Graphiti](https://github.com/getzep/graphiti) knowledge-graph consolidation.

## Motivation

Long-running AI coding sessions depend on persistent memory to stay on track.
Graphiti's MCP server is a powerful knowledge-graph backend, but synchronous
calls to it on every message add latency and introduce a single point of failure
— connections drop, queries time out, and ingestion silently fails. When the
context window fills up and OpenCode triggers compaction, the summarizer
discards details that were never persisted. The result is **context rot**: the
agent loses track of recent decisions, re-explores solved problems, and drifts
away from the original goal.

This plugin exists to close that gap. It uses **FalkorDB/Redis as the hot-path
store** for structured session events, priority-tiered snapshots, and cached
memory — all readable in sub-millisecond time. Graphiti remains the long-term
knowledge graph but is accessed **only asynchronously**, off the critical path.
The plugin re-injects session context before every LLM call and before every
compaction so the agent is always reminded of recent project context —
regardless of what survived the summary and regardless of Graphiti availability.

## Overview

This plugin uses a two-tier architecture:

**Hot path (FalkorDB/Redis — synchronous, sub-ms):**

- Stores structured session events, priority-tiered snapshots, and cached
  Graphiti results in Redis
- Reads cached memory on each user message and injects it into the last user
  message as a `<session_memory>` block via
  `experimental.chat.messages.transform`, keeping the system prompt static for
  prefix caching
- Composes the same `<session_memory>` envelope for compaction context via
  `experimental.session.compacting`
- Detects context drift using Jaccard similarity on cached fact UUIDs and
  schedules an async cache refresh when the topic shifts

**Async tier (Graphiti MCP — fire-and-forget, non-blocking):**

- Drains buffered session events to Graphiti as episodes on idle or before
  compaction
- Refreshes the Redis memory cache from Graphiti search results in the
  background
- Provides cross-session recall via vector/graph search, cached in Redis for
  chat-time injection
- Saves compaction summaries as episodes so knowledge survives across boundaries

No Graphiti call ever blocks a hook return.

## Prerequisites

### FalkorDB / Redis

A running [FalkorDB](https://www.falkordb.com/) instance accessible via the
Redis protocol. The easiest way to start one:

```bash
docker run -p 6379:6379 falkordb/falkordb:latest
```

### Graphiti MCP Server

A running
[Graphiti MCP server](https://github.com/getzep/graphiti/tree/main/mcp_server)
accessible over HTTP:

```bash
git clone https://github.com/getzep/graphiti.git
cd graphiti/mcp_server
docker compose up -d
```

This starts the MCP server at `http://localhost:8000/mcp`.

> **Note:** Graphiti is optional for basic operation. If Graphiti is
> unavailable, the plugin continues to function with FalkorDB/Redis-sourced
> session memory; only the `<persistent_memory>` section (long-term
> cross-session facts) will be empty until Graphiti comes online.

## Installation

### Option A: npm package (recommended)

Add the plugin to your `opencode.json` (or `opencode.jsonc`):

```jsonc
{
  "plugin": ["opencode-graphiti"]
}
```

### Option B: Local build

Clone and build, then reference the built file:

```bash
git clone https://github.com/vicary/opencode-graphiti.git
cd opencode-graphiti
deno task build
```

Then add to your `opencode.json`:

```jsonc
{
  "plugin": ["file:///absolute/path/to/opencode-graphiti/dist/index.js"]
}
```

### Option C: Plugin directory

Copy the built plugin into OpenCode's auto-loaded plugin directory:

```bash
# Global (all projects)
cp dist/index.js ~/.config/opencode/plugins/opencode-graphiti.js

# Or project-level
mkdir -p .opencode/plugins
cp dist/index.js .opencode/plugins/opencode-graphiti.js
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
  "falkordb": {
    // FalkorDB Redis URL
    "redisEndpoint": "redis://localhost:6379",
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
    "driftThreshold": 0.5,
    // Number of days after which facts are annotated as stale
    "factStaleDays": 30
  }
}
```

All fields are optional — defaults (shown above) are used for any missing
values. Nested values take precedence when both forms are supplied.

### Legacy Top-Level Keys

For backward compatibility, the following top-level keys are still accepted and
map to their nested equivalents:

| Legacy key          | Nested equivalent            |
| ------------------- | ---------------------------- |
| `endpoint`          | `graphiti.endpoint`          |
| `groupIdPrefix`     | `graphiti.groupIdPrefix`     |
| `driftThreshold`    | `graphiti.driftThreshold`    |
| `factStaleDays`     | `graphiti.factStaleDays`     |
| `redisEndpoint`     | `falkordb.redisEndpoint`     |
| `batchSize`         | `falkordb.batchSize`         |
| `batchMaxBytes`     | `falkordb.batchMaxBytes`     |
| `sessionTtlSeconds` | `falkordb.sessionTtlSeconds` |
| `cacheTtlSeconds`   | `falkordb.cacheTtlSeconds`   |
| `drainRetryMax`     | `falkordb.drainRetryMax`     |

## How It Works

### Injection Format

The plugin injects a single canonical `<session_memory>` XML envelope into the
last user message. This envelope is assembled from Redis hot-tier state and
contains structured sections such as `<last_request>`, `<active_tasks>`,
`<key_decisions>`, `<files_in_play>`, `<project_rules>`, and an optional
`<session_snapshot>`.

When cached Graphiti results are available, a nested `<persistent_memory>`
section is included with `fact_uuids` and `node_refs` attributes. On a cold
first turn or when Graphiti is unreachable, `<persistent_memory>` is simply
absent — the rest of the session memory is always available from FalkorDB/Redis.

```xml
<session_memory source="falkordb+graphiti-cache" version="1">
  <last_request>Continue the current task.</last_request>
  <active_tasks><task>Implement the new feature.</task></active_tasks>
  <key_decisions><decision>Use Redis for the hot path.</decision></key_decisions>
  <files_in_play><file>src/index.ts</file></files_in_play>
  <project_rules><rule>No synchronous Graphiti calls.</rule></project_rules>
  <session_snapshot><!-- priority-tiered snapshot --></session_snapshot>
  <persistent_memory fact_uuids="uuid1,uuid2" node_refs="nodeA">
    <!-- cached Graphiti facts/nodes, optional -->
  </persistent_memory>
</session_memory>
```

### Hot-Path Memory Preparation (`chat.message`)

On each user message the plugin reads session state from Redis:

- Recent structured session events (`session:{id}:events`)
- The priority-tiered snapshot (`session:{id}:snapshot`)
- The cached Graphiti memory (`memory-cache:{groupId}`)

These are composed into a `<session_memory>` envelope and staged for the
transform hook. All reads are from Redis (sub-ms); no Graphiti call is made on
this path.

### User Message Injection (`experimental.chat.messages.transform`)

The transform hook reads the prepared `<session_memory>` envelope and prepends
it to the last user message. Fact UUIDs from the `<persistent_memory>` section
are tracked in `visibleFactUuids` so subsequent cache refreshes can filter out
already-visible facts. This approach keeps the system prompt static, enabling
provider-side prefix caching, and avoids influencing session titles. The
prepared injection is cleared after use so stale context is not re-injected on
subsequent LLM calls within the same turn.

### Drift Detection and Async Cache Refresh

On each user message, the plugin compares the current query against the query
that produced the cached memory. When Jaccard similarity on cached fact UUIDs
drops below `driftThreshold` (default 0.5), an **async** cache refresh is
scheduled via Graphiti MCP. The current cached context is still injected
immediately; the refreshed cache becomes available on the next message. This
trades one message of staleness for eliminating synchronous Graphiti latency
entirely.

### Event Extraction and Buffering (`event`)

User and assistant messages are captured as structured `SessionEvent` objects
and stored in Redis (`session:{id}:events`). The plugin listens on
`message.part.updated` to buffer assistant text as it streams, and on
`message.updated` to finalize completed assistant replies.

Events are also enqueued for async drain to Graphiti:

- **On idle** (`session.idle`): buffered events are drained and the
  priority-tiered snapshot is rebuilt.
- **Before compaction** (`session.compacted`): all pending events are drained
  immediately so nothing is lost.

### Compaction Preservation

Compaction is handled entirely by OpenCode's native compaction mechanism. The
plugin participates in two ways:

1. **Before compaction** (`experimental.session.compacting`): The plugin reads
   the snapshot and cached memory from Redis and composes the same canonical
   `<session_memory>` envelope used for chat injection, so the summarizer
   preserves important knowledge. No Graphiti call is made.
2. **After compaction** (`session.compacted`): The snapshot is rebuilt from
   Redis events and the compaction summary is enqueued for async drain to
   Graphiti, ensuring knowledge survives across compaction boundaries.

### Project Scoping

Each project gets a unique `group_id` derived from its directory name (e.g.
`opencode_my-project`). Group IDs only allow letters, numbers, dashes, and
underscores (colons are not allowed). This ensures memories from different
projects stay isolated.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and release
process.

## License

MIT

## Acknowledgements

The structured event extraction, priority-tiered snapshots, and session
continuity design in this plugin are inspired by
[context-mode](https://github.com/mksglu/context-mode) by
[Mert Köseoğlu](https://github.com/mksglu).

The original plugin concept is inspired by
[opencode-openmemory](https://github.com/happycastle114/opencode-openmemory).
