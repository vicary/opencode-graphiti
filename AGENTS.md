# OpenCode-Graphiti Plugin - Agent Notes

## High-Level Goal

Build an OpenCode plugin (`opencode-graphiti`) that provides persistent memory
via a Graphiti knowledge graph endpoint. The plugin should automatically manage
memories (inject, capture, preserve) across coding sessions.

Reference: https://github.com/happycastle114/opencode-openmemory

## Architecture

```
opencode-graphiti/
├── package.json              # Plugin manifest + dependencies
├── tsconfig.json             # TypeScript config
├── src/
│   ├── index.ts              # Plugin entry point & hook registrations
│   ├── config.ts             # JSONC config loader
│   ├── services/
│   │   ├── client.ts         # Graphiti MCP client (HTTP transport)
│   │   ├── context.ts        # Memory injection formatting
│   │   ├── compaction.ts     # Compaction handler
│   │   ├── triggers.ts       # Memory trigger detection
│   │   └── logger.ts         # Logging utility
│   └── types/
│       └── index.ts          # TypeScript type definitions
└── README.md
```

## Key Design Decisions

1. **Communication**: Use `@modelcontextprotocol/sdk` MCP client over HTTP
   transport to talk to Graphiti MCP server (e.g. `http://host:8000/mcp`)
2. **Scoping**: Use directory-based `group_id` for project isolation
3. **Plugin System**: Register via `package.json` `"opencode"` field, export
   Plugin function from `src/index.ts`
4. **Config**: JSONC file at `~/.config/opencode/graphiti.jsonc`

## Plugin Hooks

| Hook                              | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `session.created`                 | Initialize group_id from project path                  |
| `message.updated`                 | Inject memories on first user message; detect triggers |
| `session.compacted`               | Save compaction summary as episode                     |
| `experimental.session.compacting` | Inject memories into compaction prompt                 |
| `session.idle`                    | Extract insights from completed exchanges              |

## Dependencies

- `@opencode-ai/plugin` - OpenCode plugin types
- `@modelcontextprotocol/sdk` - MCP client SDK
- `typescript` - Build tool

## Progression Log

### Phase 1: Setup (Complete)

- [x] Research reference plugin (opencode-openmemory)
- [x] Research OpenCode plugin system
- [x] Research Graphiti API
- [x] Plan approved
- [x] AGENTS.md created
- [x] Project scaffolded

### Phase 2: Core Implementation (Complete)

- [x] Config module
- [x] Graphiti MCP client
- [x] Context injection service
- [x] Trigger detection
- [x] Compaction handler
- [x] Plugin entry point

### Phase 3: Verification (Complete)

- [x] Build succeeds (`deno check` + `deno bundle`)
- [x] `deno fmt` + `deno lint` pass
- [x] README written
- [ ] Plugin loads in OpenCode (needs runtime test)

## Important Notes

- User's Graphiti MCP server is at `http://mac-studio:8000/mcp`
- This is a long-running unmanned session - no human intervention available
- All work must be delegated to preserve context window
- Read this file between runs to recover context

## Runtime Requirement

This project MUST be coded in Deno. Key rules:

- Use `deno.jsonc` for project configuration (imports, tasks, fmt/lint settings)
- Use `npm:` prefixed imports for npm packages (e.g.,
  `npm:@modelcontextprotocol/sdk`)
- Use `node:` APIs for Node.js compatibility (e.g., `node:fs`, `node:path`,
  `node:os`)
- Use `deno fmt` and `deno lint` for code formatting and linting
- Use `deno test` for testing
- Use `deno bundle` to produce bundled output for OpenCode/Bun consumption
- Keep a minimal `package.json` only for OpenCode plugin registration (the
  `"opencode"` field)
- Do NOT use Bun, Node.js, or any other runtime

## Delegation Requirement

All coding work MUST be delegated to `@dev-lead` subagent. All documentation
work MUST be delegated to `@doc-coauthoring` subagent. The main agent stays in
plan mode for context window preservation. This is critical for long-running
unmanned sessions where auto-compaction can cause context drift.
