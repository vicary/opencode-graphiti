# MCP-First Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining MCP-first alignment gaps so the branch fully
matches the context-mode-style pivot plan for canonical root-session
enforcement, bounded execution, stats, and secondary hook enforcement.

**Architecture:** Keep `session_*` as the primary bounded execution and
retrieval surface, with hooks limited to root-session injection, enforcement,
attribution, and continuity capture. Finish the missing execution layer
(`session-executor`), tighten canonical root enforcement at both the hook and
runtime layers, and complete local stats and tool-specific coverage without
moving Graphiti onto the hot path.

**Tech Stack:** Deno, TypeScript, `@opencode-ai/plugin`, local in-process MCP
runtime, Redis/FalkorDB hot tier, zod-backed tool schemas.

---

## File Structure

### New files

- `src/services/session-executor.ts` — bounded local execution/file-processing
  implementation for `session_execute`, `session_execute_file`, and shared batch
  execution primitives.
- `src/services/session-executor.test.ts` — exhaustive execution-layer tests for
  bounded command/file processing, truncation, artifacts, and error paths.

### Existing files to modify

- `src/handlers/tool-before.ts` — inject canonical `root_session_id` into every
  `session_*` call and keep native-tool logic secondary.
- `src/handlers/tool-before.test.ts` — verify root injection, canonicalization,
  and that native tools do not receive MCP root fields.
- `src/handlers/tool-after.ts` — keep attribution-only behavior and extend
  metadata expectations if needed.
- `src/handlers/tool-after.test.ts` — verify no output rewriting and compact
  attribution behavior.
- `src/services/tool-routing.ts` — re-center routing around MCP-first guidance
  and ensure `session_*` tools are pass-through with explicit root injection
  handled in the before-hook.
- `src/services/tool-routing.test.ts` — verify MCP-first routing outcomes and
  that native heavy tools are directed toward `session_*` tools.
- `src/services/session-mcp-runtime.ts` — enforce root-session contract after
  schema validation, delegate execution/file paths to `session-executor`, and
  complete `session_stats` / `session_doctor` behavior.
- `src/services/session-mcp-runtime.test.ts` — verify root mismatch rejection,
  stats behavior, `session_execute_file`, and doctor/stats health contracts.
- `src/services/session-corpus.ts` — finish any remaining stats or bounded
  artifact integration points needed by executor/runtime.
- `src/services/session-corpus.test.ts` — cover stats, bounded artifact
  accounting, and any remaining edge cases surfaced by the gap audit.
- `src/session.ts` — preserve canonical lineage authority and support stricter
  root enforcement paths.
- `src/session.test.ts` — validate canonical root sharing and temporary-root
  compatibility with the stricter runtime rules.
- `src/index.ts` — wire the runtime with executor/cache dependencies only; keep
  Graphiti off the hot path.
- `src/index.test.ts` — verify runtime wiring for executor/cache dependencies
  and teardown.
- `README.md` — update MCP-first wording only if implementation details or
  guarantees change materially.
- `docs/ContextOverhaulTests.md` — add/refresh acceptance coverage references if
  new required tests are introduced.

### Existing files to verify but avoid broad rewrites

- `src/handlers/event.ts`
- `src/handlers/event.test.ts`
- `docs/ContextOverhaul.md`

These should only change if the new execution/stat metadata requires it.

---

### Task 1: Inject canonical `root_session_id` into all `session_*` calls

**Files:**

- Modify: `src/handlers/tool-before.ts`
- Modify: `src/handlers/tool-before.test.ts`
- Modify: `src/services/tool-routing.ts`
- Modify: `src/services/tool-routing.test.ts`
- Test: `src/session.test.ts`

- [ ] **Step 1: Write the failing tests for MCP root injection**

Add failing coverage for:

- every `session_*` tool call receiving injected `root_session_id`
- canonical child-session calls resolving to the parent/root session ID
- native tools (`Read`, `Bash`, `Grep`, `Glob`, `WebFetch`, `Task`) not
  receiving injected `root_session_id`
- already-present mismatched `root_session_id` values being normalized or
  flagged according to the locked runtime contract

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:
`deno test src/handlers/tool-before.test.ts src/services/tool-routing.test.ts src/session.test.ts`
Expected: FAIL with missing `root_session_id` injection or incorrect MCP-first
routing behavior.

- [ ] **Step 3: Implement minimal before-hook/root-injection behavior**

Implement these rules:

- if `tool` is one of the `session_*` MCP tools, inject canonical
  `root_session_id`
- use `SessionManager` canonical resolution only; do not create a second lineage
  model
- keep non-`session_*` tools unchanged except for existing routing
  guidance/rewrites
- keep `tool.execute.before` free of Graphiti/Redis I/O

- [ ] **Step 4: Re-run the targeted tests to verify they pass**

Run:
`deno test src/handlers/tool-before.test.ts src/services/tool-routing.test.ts src/session.test.ts`
Expected: PASS

- [ ] **Step 5: Commit the task**

```bash
git add src/handlers/tool-before.ts src/handlers/tool-before.test.ts src/services/tool-routing.ts src/services/tool-routing.test.ts src/session.test.ts
git commit -m "fix: inject canonical root ids for session tools"
```

### Task 2: Enforce runtime root-session contract strictly

**Files:**

- Modify: `src/services/session-mcp-runtime.ts`
- Modify: `src/services/session-mcp-runtime.test.ts`
- Modify: `src/session.ts`
- Test: `src/session.test.ts`

- [ ] **Step 1: Write the failing tests for root mismatch rejection**

Add failing coverage for:

- missing `root_session_id` rejected by schema (already present; keep)
- mismatched caller/root combinations rejected after schema validation
- canonical child-session requests allowed only when the injected root matches
  lineage
- temporary-root/provisional sessions remaining valid until migration resolves
  them

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `deno test src/services/session-mcp-runtime.test.ts src/session.test.ts`
Expected: FAIL with missing runtime mismatch enforcement.

- [ ] **Step 3: Implement minimal runtime root enforcement**

Implement:

- a runtime-level validation step after request parsing and before handler
  execution
- rejection of mismatched `root_session_id` values with schema-valid error
  responses or explicit runtime errors, matching existing runtime conventions
- no fallback that silently invents a different root ID

- [ ] **Step 4: Re-run the targeted tests to verify they pass**

Run: `deno test src/services/session-mcp-runtime.test.ts src/session.test.ts`
Expected: PASS

- [ ] **Step 5: Commit the task**

```bash
git add src/services/session-mcp-runtime.ts src/services/session-mcp-runtime.test.ts src/session.ts src/session.test.ts
git commit -m "fix: enforce canonical root ids in session runtime"
```

### Task 3: Implement the missing bounded execution layer

**Files:**

- Create: `src/services/session-executor.ts`
- Create: `src/services/session-executor.test.ts`
- Modify: `src/services/session-mcp-runtime.ts`
- Modify: `src/services/session-mcp-runtime.test.ts`
- Modify: `src/index.ts`
- Modify: `src/index.test.ts`

Use the locked execution defaults from
`docs/superpowers/plans/2026-03-20-context-mode-mcp-first-implementation.md`
§2.4 and §2.6 while implementing this task: 8 KB maximum serialized response
body, 30-second default command timeout, 120-second maximum command timeout, 512
KB maximum normalized indexed body, local plugin-process execution,
`Deno.Command` for command execution, and direct Deno file APIs for file reads.

- [ ] **Step 1: Write the failing execution-layer tests**

Add failing coverage for:

- `session_execute` bounded command execution with timeout enforcement
- `session_execute_file` direct local file processing without using native
  `Read`
- `session_batch_execute` sequential execution through the shared executor
- oversized command/file outputs stored as artifacts/corpus refs rather than
  returned inline
- execution failures, timeout failures, and file-read failures returning
  bounded, schema-valid results

This task covers basic executor correctness. Keep deeper `session_execute_file`
edge cases and routing-layer integration for Task 5.

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:
`deno test src/services/session-executor.test.ts src/services/session-mcp-runtime.test.ts src/index.test.ts`
Expected: FAIL because `src/services/session-executor.ts` does not exist yet and
runtime delegation is incomplete.

- [ ] **Step 3: Implement the minimal executor and wire it into the runtime**

Implement:

- `src/services/session-executor.ts` for shared command/file execution
  primitives
- direct Deno file reads for `session_execute_file`
- bounded summaries + artifact/corpus writes for oversized outputs
- runtime delegation from `session-mcp-runtime.ts` into the executor
- `src/index.ts` wiring for any new executor dependency only inside the
  in-process runtime path

- [ ] **Step 4: Re-run the targeted tests to verify they pass**

Run:
`deno test src/services/session-executor.test.ts src/services/session-mcp-runtime.test.ts src/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit the task**

```bash
git add src/services/session-executor.ts src/services/session-executor.test.ts src/services/session-mcp-runtime.ts src/services/session-mcp-runtime.test.ts src/index.ts src/index.test.ts
git commit -m "feat: add bounded session executor runtime"
```

### Task 4: Complete stats integration and bounded output accounting

**Files:**

- Modify: `src/services/session-corpus.ts`
- Modify: `src/services/session-corpus.test.ts`
- Modify: `src/services/session-mcp-runtime.ts`
- Modify: `src/services/session-mcp-runtime.test.ts`
- Modify: `src/services/session-executor.ts`
- Modify: `src/services/session-executor.test.ts`
- Modify: `src/handlers/event.ts`
- Modify: `src/handlers/event.test.ts`

- [ ] **Step 1: Write the failing tests for stats and bounded accounting**

Add failing coverage for:

- `session_stats` reading real counters from local state
- `session_doctor` continuing to return bounded, schema-valid local health
  responses after the new stats/accounting wiring
- stats counters for every `session_*` call family
- `artifact_count`, `corpus_count`, `bytes_indexed_total`,
  `bytes_returned_total`, `bytes_saved_estimate`
- compact continuity metadata for execution/file/batch activity without raw
  payload dumps
- no duplicate full-body artifact storage when one canonical artifact body is
  enough

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:
`deno test src/services/session-corpus.test.ts src/services/session-mcp-runtime.test.ts src/services/session-executor.test.ts src/handlers/event.test.ts`
Expected: FAIL with missing or incomplete stats/accounting behavior.

- [ ] **Step 3: Implement minimal stats/accounting completion**

Implement:

- root-session-local counters in the corpus/stats layer
- direct `session_stats` reads from that local state
- preserve and extend `session_doctor` bounded local health behavior while
  wiring real stats/accounting state
- executor/runtime updates for bytes captured/indexed/saved metadata
- compact event metadata only; no raw artifact bodies in continuity events

- [ ] **Step 4: Re-run the targeted tests to verify they pass**

Run:
`deno test src/services/session-corpus.test.ts src/services/session-mcp-runtime.test.ts src/handlers/event.test.ts`
Expected: PASS

- [ ] **Step 5: Commit the task**

```bash
git add src/services/session-corpus.ts src/services/session-corpus.test.ts src/services/session-mcp-runtime.ts src/services/session-mcp-runtime.test.ts src/services/session-executor.ts src/services/session-executor.test.ts src/handlers/event.ts src/handlers/event.test.ts
git commit -m "fix: complete local session stats accounting"
```

### Task 5: Finish `session_execute_file` and MCP-first routing coverage

**Files:**

- Modify: `src/services/session-executor.test.ts`
- Modify: `src/services/session-mcp-runtime.test.ts`
- Modify: `src/services/tool-routing.ts`
- Modify: `src/services/tool-routing.test.ts`
- Modify: `src/handlers/tool-after.ts`
- Modify: `src/handlers/tool-after.test.ts`

Use the enforcement defaults already locked in
`docs/superpowers/plans/2026-03-20-context-mode-mcp-first-implementation.md`
§9.3 for this task: `session_*` calls must be allowed after root injection,
`WebFetch` denied toward `session_fetch_and_index`, data-heavy `Bash` routed
toward `session_execute` / `session_batch_execute`, large-analysis `Read` guided
toward `session_execute_file`, `Task` prompts rewritten with MCP-first guidance,
and `tool.execute.after` kept attribution-only.

- [ ] **Step 1: Write the failing tests for file-processing and enforcement
      coverage**

Add failing coverage for:

- `session_execute_file` happy path on one file and multiple files
- nonexistent file path handling
- oversized file content bounded to artifact/corpus refs
- file processing preserving schema-valid metadata and bounded summaries
- routing guidance explicitly steering large-analysis `Read` usage toward
  `session_execute_file`
- `tool.execute.after` remaining attribution-only with no visible output
  rewriting

This task covers the higher-variance `session_execute_file` edge cases and
MCP-first routing integration that build on Task 3's basic executor correctness.

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:
`deno test src/services/session-executor.test.ts src/services/session-mcp-runtime.test.ts src/services/tool-routing.test.ts src/handlers/tool-after.test.ts`
Expected: FAIL where file-path behavior or routing guidance is still incomplete.

- [ ] **Step 3: Implement minimal file/routing completion**

Implement:

- any remaining `session_execute_file` behavior missing from the
  executor/runtime
- explicit MCP-first guidance toward `session_execute_file` for heavy
  file-analysis cases
- no expansion of `tool.execute.after` beyond attribution metadata

- [ ] **Step 4: Re-run the targeted tests to verify they pass**

Run:
`deno test src/services/session-executor.test.ts src/services/session-mcp-runtime.test.ts src/services/tool-routing.test.ts src/handlers/tool-after.test.ts`
Expected: PASS

- [ ] **Step 5: Commit the task**

```bash
git add src/services/session-executor.test.ts src/services/session-mcp-runtime.test.ts src/services/tool-routing.ts src/services/tool-routing.test.ts src/handlers/tool-after.ts src/handlers/tool-after.test.ts
git commit -m "test: cover session execute file and routing edges"
```

### Task 6: Run the full MCP-first gap-closure verification matrix

**Files:**

- Modify only if verification exposes a concrete failure:
  - `README.md`
  - `docs/ContextOverhaulTests.md`
  - any file touched above

- [ ] **Step 1: Run the focused execution/runtime verification block**

Run:
`deno test src/services/session-mcp-runtime.test.ts src/services/session-corpus.test.ts src/services/session-executor.test.ts src/session.test.ts src/index.test.ts`
Expected: PASS

- [ ] **Step 2: Run the hook/routing verification block**

Run:
`deno test src/handlers/tool-before.test.ts src/handlers/tool-after.test.ts src/services/tool-routing.test.ts src/handlers/event.test.ts`
Expected: PASS

- [ ] **Step 3: Run the full repo test suite**

Run: `deno test` Expected: PASS

- [ ] **Step 4: Run build/type/lint/format verification**

Run: `deno task build && deno task check && deno lint && deno fmt --check`
Expected: PASS

- [ ] **Step 5: Update docs only if verification changed guarantees**

If verification exposed stale wording, update `README.md` and/or
`docs/ContextOverhaulTests.md` to match the final behavior. Otherwise, make no
docs changes.

- [ ] **Step 6: Commit the verification cleanup**

```bash
git add README.md docs/ContextOverhaulTests.md
git commit -m "docs: finalize MCP-first gap closure verification"
```

Use this commit only if docs actually changed; otherwise skip the commit and
record that verification completed with no docs delta.

---

## Final Verification Sequence

Run this exact sequence after Task 6:

```bash
deno test src/services/session-mcp-runtime.test.ts src/services/session-corpus.test.ts src/services/session-executor.test.ts src/session.test.ts src/index.test.ts
deno test src/handlers/tool-before.test.ts src/handlers/tool-after.test.ts src/services/tool-routing.test.ts src/handlers/event.test.ts
deno test
deno task build
deno task check
deno lint
deno fmt --check
```

## Completion Criteria

This gap-closure plan is done only when all of the following are true:

1. `tool.execute.before` injects canonical `root_session_id` into every
   `session_*` call.
2. The runtime rejects mismatched `root_session_id` values instead of silently
   accepting them.
3. `src/services/session-executor.ts` and
   `src/services/session-executor.test.ts` exist and own bounded
   execution/file-processing behavior.
4. `session_execute_file` has dedicated behavioral coverage, not only schema
   coverage.
5. `session_stats` and `session_doctor` are backed by real local counters/health
   signals and bounded accounting.
6. `tool-routing` is visibly secondary enforcement that points data-heavy work
   toward `session_*` tools.
7. `tool.execute.after` remains attribution-only.
8. All verification commands above pass.
