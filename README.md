# opencode-graphiti

OpenCode plugin that provides persistent memory via a
[Graphiti](https://github.com/getzep/graphiti) knowledge graph.

## Motivation

Long-running AI coding sessions depend on persistent memory to stay on track.
Graphiti's MCP server is the intended backbone for this, but in practice it is
unreliable — connections drop, queries time out, and ingestion silently fails.
When the context window fills up and OpenCode triggers compaction, the
summarizer discards details that were never persisted. The result is **context
rot**: the agent loses track of recent decisions, re-explores solved problems,
and drifts away from the original goal.

This plugin exists to close that gap. It captures chat histories and project
facts into Graphiti when the server is healthy, then **re-injects them at the
start of every session and before every compaction** so the agent is always
reminded of recent project context — regardless of what survived the summary.

## Overview

This plugin connects to a Graphiti MCP server and:

- Injects relevant memories into the first user message of each session
- Periodically re-injects project memories as the conversation progresses
- Buffers user and assistant messages, flushing them to Graphiti on idle or
  before compaction
- Preserves key facts during context compaction
- Saves compaction summaries as episodes so knowledge survives across boundaries
- Scopes memories per project (and per user) using directory-based group IDs

## Prerequisites

A running
[Graphiti MCP server](https://github.com/getzep/graphiti/tree/main/mcp_server)
accessible over HTTP. The easiest way to set one up:

```bash
# Clone and start with Docker Compose
git clone https://github.com/getzep/graphiti.git
cd graphiti/mcp_server
docker compose up -d
```

This starts the MCP server at `http://localhost:8000/mcp` with a FalkorDB
backend.

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

Create a config file at `~/.config/opencode/graphiti.jsonc`:

```jsonc
{
  // Graphiti MCP server endpoint
  "endpoint": "http://localhost:8000/mcp",

  // Prefix for project group IDs (e.g. "opencode_my-project")
  "groupIdPrefix": "opencode",

  // Number of user messages between memory re-injections (0 = disabled)
  "injectionInterval": 10
}
```

All fields are optional — defaults (shown above) are used for any missing
values.

## How It Works

### Memory Injection (`chat.message`)

On the first user message in a session, the plugin searches Graphiti for facts
and entities relevant to the message content. Results are split into project and
user scopes (70% / 30% budget split), formatted, and prepended to the
conversation as a synthetic context block.

The injection budget is calculated dynamically: 10% of the model's context limit
(resolved from the provider list) multiplied by 4 characters per token.

### Re-injection (`chat.message`)

When `injectionInterval` is greater than 0, the plugin periodically re-injects
project-scoped memories as the conversation progresses. After every N user
messages (where N is `injectionInterval`), stale synthetic memory parts are
replaced with fresh results. Re-injection uses the full character budget for
project memories only (no user scope).

### Message Buffering (`event`)

User and assistant messages are buffered in memory as they arrive. The plugin
listens on `message.part.updated` to capture assistant text as it streams, and
on `message.updated` to finalize completed assistant replies. Buffered messages
are flushed to Graphiti as episodes:

- **On idle** (`session.idle`): when the session becomes idle with at least 50
  bytes of buffered content.
- **Before compaction** (`session.compacted`): all buffered messages are flushed
  immediately (no minimum size) so nothing is lost.

If the last buffered message is from the user (i.e. no assistant reply was
captured), the plugin fetches the latest assistant message from the session API
as a fallback before flushing.

### Compaction Preservation (`session.compacted` + `experimental.session.compacting`)

Compaction is handled entirely by OpenCode's native compaction mechanism. The
plugin participates in two ways:

1. **Before compaction** (`experimental.session.compacting`): The plugin injects
   known facts and entities into the compaction context using the same 70% / 30%
   project/user budget split, so the summarizer preserves important knowledge.
2. **After compaction** (`session.compacted`): The compaction summary is saved
   as an episode to Graphiti, ensuring knowledge survives across compaction
   boundaries.

### Project Scoping

Each project gets a unique `group_id` derived from its directory name (e.g.
`opencode_my-project`). Group IDs only allow letters, numbers, dashes, and
underscores (colons are not allowed). This ensures memories from different
projects stay isolated.

## Development

```bash
# Format
deno fmt

# Lint
deno lint

# Type check
deno check src/index.ts

# Build
deno task build
```

## License

MIT

## Acknowledgement

This project is inspired by
[opencode-openmemory](https://github.com/happycastle114/opencode-openmemory)
