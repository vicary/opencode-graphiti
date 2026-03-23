# Clean-Slate Architecture Design

## Goal

Define the cleaner architecture this repository should have if redesigned from
scratch for long-term maintainability, while preserving the original product
intent: follow `context-mode` as closely as practical, with a few explicit local
touches.

The clean-slate target keeps this exact intent:

1. replace SQLite with FalkorDB/Redis hot-tier storage
2. rename `ctx_*` to `session_*`
3. skip the upgrade/update tool to keep the control-pane impact area smaller
4. retain the Graphiti feature intact for long-term memory, with async ingestion
   and synchronous cached injection on the hot path
5. when either Graphiti or FalkorDB/Redis is degraded, fall back to base
   OpenCode behavior with a warning instead of throwing

This is a clean-slate design target, not an incremental refactor plan.

## Design Principles

1. **Capability-first modules, not service piles**
   - Organize by product capability and ownership boundary, not by generic
     “service” or “handler” categories.
2. **One owner per truth**
   - Session identity, continuity assembly, corpus state, MCP protocol, routing
     policy, and Graphiti augmentation should each have one authoritative home.
3. **Thin orchestration, thick domain modules**
   - Bootstrap files should wire modules together, not contain business logic.
4. **Graphiti stays off the hot path**
   - All synchronous hooks and MCP calls must remain local-first.
5. **Explicit contracts at boundaries**
   - Hooks, MCP tools, persistence adapters, and async workers communicate via
     typed module contracts rather than cross-cutting internal calls.
6. **Graceful degradation over startup failure**
   - If Graphiti or FalkorDB/Redis is unavailable, the plugin should warn and
     degrade to base OpenCode-compatible behavior rather than throwing.

## Recommended Top-Level Modules

### `app/`

Owns only plugin/runtime composition:

- config loading
- dependency construction
- runtime lifecycle startup/shutdown
- teardown ordering
- OpenCode hook registration
- degraded-mode detection and warning emission

This replaces the current overgrown orchestration role of `src/index.ts`.

### `session/`

Owns canonical session identity and session-local lifecycle rules:

- canonical root resolution
- child/parent lineage
- temporary-root migration coordination
- session lifecycle activity tracking
- assistant buffering tied to session ownership

Nothing outside `session/` should traverse parent chains or reason about
provisional-to-canonical migration.

### `continuity/`

Owns short-term memory composition:

- event extraction from OpenCode/SDK payloads into continuity records
- event normalization for continuity-facing records
- snapshot building
- local `<session_memory>` assembly
- duplicate filtering / section shaping
- context-window budgeting for continuity payloads
- compaction continuity rules

This module should answer: “given local events, cached persistent memory, and
session state, what exact memory envelope should the model see?”

In the clean-slate architecture, synchronous injection still happens on the hot
path, but only from local state and cached Graphiti recall. Fresh Graphiti calls
must remain asynchronous.

### `corpus/`

Owns local knowledge storage and retrieval:

- ingestion
- HTML/text normalization
- chunking
- lexical indexing/postings
- artifacts and bounded body spillover
- stats/accounting
- replacement semantics (`source`/`label`)
- root-session migration of corpus-owned state

This should become a subsystem, not one giant file.

### `mcp/`

Owns the `session_*` public tool protocol:

- tool registry
- request/response schema definitions
- request validation
- bounded response budgeting
- per-tool dispatch
- tool-facing diagnostics surfaces

`mcp/` should not implement corpus/session internals directly; it should call
module interfaces.

The public naming remains `session_*` even though the target capability set is
context-mode-inspired.

### `routing/`

Owns native-tool steering policy:

- before-hook routing rules
- after-hook attribution metadata
- guidance throttling
- routing outcome cache
- policy explanation strings

This module should be mostly pure policy code plus tiny caches.

### `graphiti/`

Owns the asynchronous long-term memory path:

- episode draining/batching
- retry/recovery behavior
- Graphiti connection/client behavior
- refresh scheduling
- persistent-memory cache hydration

This module must never be required for synchronous hook correctness.

Its cached outputs are still consumed synchronously by `continuity/` when
assembling `<persistent_memory>` on the hot path.

### `platform/`

Owns external adapters:

- Redis/FalkorDB adapter
- Graphiti transport adapter
- command execution adapter
- OpenCode warning/notification adapter

The rest of the system should depend on interfaces, not on raw SDK/client
objects.

Only the Redis config surface needs to remain canonical. No separate FalkorDB
config namespace is required in the clean-slate design.

## Proposed Directory Shape

```text
src/
  app/
    plugin.ts
    runtime.ts
    teardown.ts
    config.ts

  session/
    canonicalizer.ts
    lifecycle.ts
    migration.ts
    assistant-buffer.ts
    types.ts

  continuity/
    event-extractor.ts
    event-model.ts
    event-normalizer.ts
    budget.ts
    snapshot-builder.ts
    memory-builder.ts
    memory-renderer.ts
    injection-state.ts
    types.ts

  corpus/
    ingest.ts
    normalize.ts
    chunking.ts
    index-store.ts
    search.ts
    artifacts.ts
    stats.ts
    replacement.ts
    migration.ts
    types.ts

  mcp/
    registry.ts
    schemas.ts
    budgeting.ts
    runtime.ts
    tools/
      execute.ts
      execute-file.ts
      batch.ts
      index.ts
      search.ts
      fetch-and-index.ts
      stats.ts
      doctor.ts

  routing/
    policy.ts
    before-hook.ts
    after-hook.ts
    guidance-cache.ts
    outcome-cache.ts
    types.ts

  graphiti/
    client.ts
    connection.ts
    drain.ts
    refresh.ts
    cache-sync.ts
    coordinator.ts
    types.ts

  platform/
    redis/
      client.ts
      hash.ts
      list.ts
      migration.ts
    executor/
      runtime.ts
      files.ts
    opencode/
      warnings.ts
      hooks.ts
      normalize.ts

  shared/
    constants.ts
    errors.ts
    logger.ts
    xml.ts
    text.ts
    ids.ts
    types.ts
```

## Ownership Boundaries

### `app` depends on everything; nothing depends on `app`

`app` is the composition root. It wires modules and exposes plugin hooks/tool
registrations. It should contain almost no domain decisions.

`app` also owns degraded startup/runtime policy: if Redis/FalkorDB or Graphiti
is unavailable, it emits warnings and composes the best available reduced
runtime instead of throwing.

### `session` is the identity authority

All code that needs a canonical root session asks `session`. No other module
inspects parent chains, caches provisional mappings, or owns retry semantics for
temporary-root migration.

### `continuity` is the memory authority

Handlers should delegate to `continuity` for assembling model-facing memory.
`continuity` should not own transport or storage clients directly; it should
depend on abstract event/snapshot/cache readers.

`continuity` also owns:

- extraction of raw SDK payloads into continuity-facing events
- context-window budgeting for local memory assembly

### `corpus` is the local retrieval authority

All indexing/search/artifact concerns live here. `mcp` and `routing` should not
duplicate chunking, budgeting, or identity-replacement logic.

### `mcp` is the protocol authority

`mcp` decides how public tool calls are parsed, validated, and encoded. It does
not decide search ranking, session migration, or routing policy.

### `routing` is the policy authority

The tool guidance system should be a pure policy layer with minimal state. It
should never need to know corpus internals beyond public capabilities.

### `graphiti` is the long-term augmentation authority

All episode flushing and refresh logic stays here. The only synchronous thing
the rest of the system should consume is cached recall data already materialized
locally.

`graphiti/` owns its own transport-facing client/connection layer. `platform/`
does not need a separate Graphiti transport subtree in the clean-slate design.

If `graphiti/` is degraded, the system continues without long-term augmentation
and without throwing; cached or absent `<persistent_memory>` should be handled
gracefully.

### `shared/` is the pure utility layer

`shared/` contains domain-agnostic helpers only:

- constants
- generic errors
- logging facade
- text helpers
- XML helpers
- shared IDs/types

Nothing in `shared/` should import from any domain module.

## What Changes From Today

### Current `src/index.ts`

Today it acts as both:

- composition root
- runtime lifecycle coordinator
- teardown scheduler
- dependency policy file

In the clean-slate design it becomes a thin entrypoint delegating almost
entirely to `app/plugin.ts` and `app/runtime.ts`.

### Current `src/session.ts`

Today it mixes too many concerns:

- canonical session identity
- lifecycle and activity retention
- assistant buffering
- memory composition
- XML rendering inputs
- persistent-memory assembly
- migration bookkeeping

In the clean-slate design it is split mostly across `session/` and
`continuity/`.

### Current `src/services/session-mcp-runtime.ts`

Today it mixes:

- tool registry
- schema bridging
- request validation
- response budgeting
- artifact fallback
- tool implementation logic
- stats wiring

In the clean-slate design it becomes `mcp/runtime.ts` plus per-tool handlers and
shared protocol helpers.

### Current `src/services/session-corpus.ts`

Today it owns too much of the local retrieval system in one place:

- normalization
- chunking
- indexing
- search ranking
- artifacts
- migration
- stats
- replacement logic

In the clean-slate design it becomes a real `corpus/` subsystem with smaller,
individually testable components.

### Current `src/handlers/*`

Today the handler files contain a mix of adapter code and orchestration logic.
In the clean-slate design they become thin OpenCode-facing adapters under the
`platform/opencode/` boundary, delegating into:

- `continuity/` for chat/message/compaction assembly
- `routing/` for native-tool policy and attribution
- `session/` for canonical root resolution when needed

They should stop owning any meaningful business logic.

## Data Flow in the Clean-Slate Design

### Chat / transform / compaction hot path

1. OpenCode hook enters `app` adapter.
2. `session` resolves canonical root.
3. `continuity` reads local events/snapshot/cache state.
4. `continuity` renders local-first `<session_memory>`, including cached
   `<persistent_memory>` when available.
5. Hook returns without any Graphiti dependency.

### Tool execution path

1. OpenCode MCP tool call enters `mcp/registry.ts`.
2. `mcp/runtime.ts` validates request and session root.
3. Tool-specific handler dispatches to `corpus`, executor adapter, or session
   contract.
4. `mcp/budgeting.ts` enforces bounded output.
5. Result returns with typed bounded payloads.

### Native-tool routing path

1. Before-hook enters `routing/policy.ts`.
2. Policy emits allow/deny/rewrite/guidance outcome.
3. After-hook records attribution metadata only.
4. Event capture stores compact continuity metadata only.

### Async Graphiti path

1. `event` path stores local events synchronously.
2. Async coordinator picks up buffered work later.
3. `graphiti/drain.ts` turns events into episodes.
4. `graphiti/refresh.ts` updates cached persistent memory.
5. Later hot-path injections consume only cached results.

### Degraded startup/runtime path

1. `app` detects Graphiti and Redis/FalkorDB availability independently.
2. If Redis/FalkorDB is unavailable, the plugin warns and falls back to the
   minimum safe local/base-OpenCode-compatible mode rather than throwing.
3. If Graphiti is unavailable, the plugin warns and continues without persistent
   memory augmentation.
4. If both are unavailable, the plugin still does not throw during startup; it
   degrades to the least-capable safe mode and surfaces warnings.

## Testing Strategy

### Unit-first module tests

Each module should have strong direct tests:

- `session`: canonicalization, migration retry, child deletion safety
- `continuity`: memory envelope composition and duplicate suppression
- `corpus`: indexing, replacement, migration, search ranking, artifact rules
- `mcp`: schema validation, budgeting, per-tool output shaping
- `routing`: policy verdicts and attribution metadata
- `graphiti`: retry/backoff/cache hydration semantics

### Thin vertical slices

Keep a smaller number of full-path integration tests for:

- hot-path local-first memory injection
- compaction survival
- mixed MCP tool execution
- async Graphiti refresh/drain interactions

This reduces the current tendency for a few giant files to accumulate too much
test surface.

## Why This Is More Maintainable

- A developer can reason about one capability at a time.
- Identity logic stops leaking across hooks, runtime, and migration code.
- Memory composition becomes a first-class subsystem instead of a side effect of
  `SessionManager` growth.
- Local corpus evolution becomes easier because ingestion, search, replacement,
  and migration are no longer one file.
- MCP feature work becomes additive: adding a new `session_*` tool mostly means
  one new handler plus schema, not more branching in a central runtime file.
- Graphiti integration remains powerful but structurally quarantined from the
  synchronous path.

## Success Criteria For The Clean-Slate Architecture

- The clean-slate architecture still reflects the original context-mode parity
  intent, with the approved local touches.
- `app/` is only orchestration.
- `session/` owns identity and lifecycle.
- `continuity/` owns short-term memory assembly.
- `corpus/` owns local retrieval/index/artifact/stat semantics.
- `mcp/` owns the public `session_*` protocol surface.
- `routing/` owns native-tool policy.
- `graphiti/` owns asynchronous long-term augmentation.
- Synchronous injection remains available from local state and cached Graphiti
  recall without synchronous Graphiti fetches.
- Redis/FalkorDB and Graphiti degradation both fall back with warnings rather
  than throwing.
- No single file needs to understand all three of: OpenCode hooks, session
  identity, and corpus internals at once.
