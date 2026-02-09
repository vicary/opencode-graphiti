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
- Detects user-triggered memory saves ("remember this", "keep in mind", etc.)
- Preserves key facts during context compaction
- Scopes memories per project using directory-based group IDs

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

  // Maximum results to retrieve
  "maxFacts": 10,
  "maxNodes": 5,
  "maxEpisodes": 5,

  // Feature toggles
  "injectOnFirstMessage": true,
  "enableTriggerDetection": true,
  "enableCompactionSave": true
}
```

All fields are optional — defaults are used for any missing values.

## How It Works

### Memory Injection (`chat.message`)

On the first user message in a session, the plugin searches Graphiti for facts
and entities relevant to the message content. Matching results are formatted and
prepended to the conversation as a synthetic context block.

### Trigger Detection (`chat.message`)

User messages are scanned for phrases like:

- "remember this", "memorize that"
- "save this in memory", "keep this in mind"
- "don't forget", "note this"
- "for future reference"

When detected, the message content is saved as an episode in Graphiti.

### Compaction Preservation (`event` + `experimental.session.compacting`)

When OpenCode compacts the context window:

1. **Before compaction**: The plugin injects known facts into the compaction
   context, so the summarizer preserves important knowledge.
2. **After compaction**: If a summary is produced, it is saved as an episode to
   Graphiti, ensuring knowledge survives across compaction boundaries.

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
