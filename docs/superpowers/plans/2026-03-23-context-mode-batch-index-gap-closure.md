# Context-Mode Batch And Index Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining verified context-mode parity gaps by adding mixed
command+search batching to `session_batch_execute` and critical
path/source/label replacement semantics to `session_index`, while keeping
`session_*`, skipping upgrade/update, and preserving the Redis/FalkorDB +
Graphiti architecture.

**Architecture:** Keep the current MCP-first runtime and local corpus
architecture, but extend their contracts in two focused places only: batch step
dispatch and identity-aware indexing. Reuse existing bounded-response, artifact
spillover, local search, and root-session semantics instead of introducing a
second protocol or storage path.

**Tech Stack:** Deno, TypeScript, OpenCode plugin tool APIs, Redis/FalkorDB
hot-tier storage, Graphiti async cache augmentation, existing `session_*` MCP
runtime and corpus services.

---

## File structure and responsibility lock-in

- `src/services/session-mcp-types.ts`
  - Extend request/response contracts for mixed batch steps and critical index
    parity fields.
- `src/services/session-mcp-runtime.ts`
  - Extend runtime dispatch for mixed batch steps and path/source/label
    indexing.
- `src/services/session-mcp-runtime.test.ts`
  - Add runtime-level contract tests for mixed batch and index behavior.
- `src/services/session-executor.ts`
  - Reuse existing safe file reading helpers if needed for path-based indexing
    input normalization.
- `src/services/session-executor.test.ts`
  - Add tests only if executor helpers are extended.
- `src/services/session-corpus.ts`
  - Add identity-aware replacement bookkeeping and replacement-safe re-index
    behavior.
- `src/services/session-corpus.test.ts`
  - Add focused replacement and path-ingestion parity tests.
- `README.md`
  - Update only the documented `session_batch_execute` and `session_index`
    behavior.

Do **not** rename `session_*` to `ctx_*`. Do **not** add `session_upgrade` /
`ctx_upgrade` / `ctx_update`. Do **not** broaden into clean-slate modularization
work.

## Locked implementation decisions

These are not left to the implementer; the plan is explicitly choosing them now.

- **Mixed batch response shape:** `session_batch_execute.results` becomes a
  discriminated union of typed step result items, not a homogeneous array of
  execute responses.

```ts
type SessionBatchStepResult =
  | { kind: "command"; result: SessionExecuteResponse }
  | { kind: "search"; result: SessionSearchResponse };
```

- **Backward compatibility:** keep accepting the current `commands` request
  field for command-only callers, and add `steps` for mixed callers. Normalize
  both forms internally into one ordered step list.

- **Mixed-step orchestration location:** mixed batch execution is coordinated in
  `src/services/session-mcp-runtime.ts`, not by generalizing
  `src/services/session-executor.ts` into a mixed command/search engine.

- **Batch budgeting:** existing execute-only budget/coercion code in
  `session-mcp-runtime.ts` and any reused helper in `session-executor.ts` must
  be updated to branch by result kind rather than assuming every item is an
  execute response.

- **Index replacement model:** replacement happens at the logical indexed
  document level. Old searchable state for the same
  `(rootSessionId, source,
  label)` must be removed before the replacement is
  committed. Do not use tombstones or search-time filtering.

- **Path resolution model:** `session_index` path ingestion must resolve against
  the active worktree/directory from `ToolContext`. Paths inside the active root
  are read directly; paths outside that root must follow the host permission
  model by requesting the needed external-directory/read grants and returning a
  structured bounded denial if permission is refused.

## Task order

### Task 1: Add mixed-step batch contracts

**Files:**

- Modify: `src/services/session-mcp-types.ts`
- Test: `src/services/session-mcp-runtime.test.ts`

- [ ] **Step 1: Write the failing tests for mixed batch requests**

Add tests covering:

- mixed `command` + `search` steps are accepted
- legacy `commands` input remains accepted for command-only callers
- empty batch still rejects
- unknown step kinds reject

Suggested test sketch:

```ts
it("accepts mixed command and search batch steps", async () => {
  const runtime = createSessionMcpRuntime({ ...deps });
  const handler = runtime.tools.session_batch_execute.execute;
  const result = await handler(
    {
      root_session_id: "root-1",
      steps: [
        { kind: "command", command: "pwd" },
        { kind: "search", query: "session continuity" },
      ],
    },
    makeToolContext(),
  );
  assertEquals(result.status, "ok");
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `deno test src/services/session-mcp-runtime.test.ts --filter "mixed|batch"`

Expected: FAIL because `session_batch_execute` still only accepts homogeneous
command input and returns homogeneous execute-style results.

- [ ] **Step 3: Extend the batch schema minimally**

Implement a mixed-step request shape in `src/services/session-mcp-types.ts`:

```ts
type SessionBatchStep =
  | { kind: "command"; command: string; timeout_seconds?: number }
  | { kind: "search"; query: string };

type SessionBatchStepResult =
  | { kind: "command"; result: SessionExecuteResponse }
  | { kind: "search"; result: SessionSearchResponse };
```

Keep backward compatibility explicitly:

- `commands` remains valid for command-only callers
- `steps` becomes the new mixed-step shape
- runtime normalizes both forms internally

- [ ] **Step 4: Run the focused test to verify schema acceptance now passes or
      fails later in dispatch**

Run: `deno test src/services/session-mcp-runtime.test.ts --filter "mixed|batch"`

Expected: The request shape parses, but runtime behavior may still fail until
dispatch is implemented.

### Task 2: Implement mixed-step batch dispatch and budgeting

**Files:**

- Modify: `src/services/session-mcp-runtime.ts`
- Modify: `src/services/session-executor.ts` (only if a small shared budgeting
  helper extraction is clearly beneficial)
- Test: `src/services/session-mcp-runtime.test.ts`
- Test: `src/services/session-executor.test.ts` (only if helper extraction
  happens)

- [ ] **Step 1: Write failing dispatch tests for mixed command + search
      execution**

Add tests covering:

- sequential step execution order is preserved
- search step uses local corpus search
- oversized command step still spills safely to artifacts
- typed per-step result items are preserved in `results`

Suggested test sketch:

```ts
it("executes mixed command and search steps in order", async () => {
  // arrange indexed content first
  // execute batch with command then search
  // assert typed results in original order
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:
`deno test src/services/session-mcp-runtime.test.ts --filter "order|search step|mixed"`

Expected: FAIL because runtime only supports command-only batch execution.

- [ ] **Step 3: Implement the minimal mixed-step runtime dispatch**

In `src/services/session-mcp-runtime.ts`:

- iterate `steps`
- for `command`, reuse existing executor path
- for `search`, call `corpus.search(...)`
- preserve original order
- keep per-step results typed and bounded

Also update existing execute-only assumptions in batch result budgeting and
coercion so search results are handled by kind rather than treated as execute
responses.

Do not add parallel execution.

- [ ] **Step 4: Run the focused batch tests**

Run:
`deno test src/services/session-mcp-runtime.test.ts --filter "batch|search step|mixed|order"`

Expected: PASS.

### Task 3: Add critical index contract fields

**Files:**

- Modify: `src/services/session-mcp-types.ts`
- Test: `src/services/session-mcp-runtime.test.ts`

- [ ] **Step 1: Write failing tests for path/source/label index requests**

Add tests covering:

- inline `content` still works
- `path` is accepted as an alternative content source
- `source` and `label` fields are accepted

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `deno test src/services/session-mcp-runtime.test.ts --filter "index"`

Expected: FAIL because current schema supports only inline `content`.

- [ ] **Step 3: Extend the index schema minimally**

Support the verified critical fields only:

```ts
type SessionIndexRequest = {
  root_session_id: string;
  content?: string;
  path?: string;
  source?: string;
  label?: string;
};
```

Require at least one of `content` or `path`.

- [ ] **Step 4: Re-run the focused test**

Run: `deno test src/services/session-mcp-runtime.test.ts --filter "index"`

Expected: request validation passes, but path/replacement behavior may still
fail.

### Task 4: Implement safe path-based indexing input resolution

**Files:**

- Modify: `src/services/session-mcp-runtime.ts`
- Modify: `src/services/session-executor.ts` (only if helper extraction is
  needed)
- Test: `src/services/session-mcp-runtime.test.ts`
- Test: `src/services/session-executor.test.ts` (only if helper extraction is
  needed)

- [ ] **Step 1: Write a failing test for path-based indexing**

Add a test that indexes a local file via `path` and confirms the content becomes
searchable.

- [ ] **Step 2: Run the focused test to verify it fails**

Run:
`deno test src/services/session-mcp-runtime.test.ts --filter "path-based indexing|indexes a local file"`

Expected: FAIL because runtime does not yet resolve `path` input.

- [ ] **Step 3: Implement minimal safe path ingestion**

In `src/services/session-mcp-runtime.ts`:

- when `path` is present, read the file through existing safe local file rules
- use `ToolContext` worktree/directory information for path resolution
- normalize that body into the same `corpus.index(...)` pipeline used for inline
  content
- for out-of-workspace paths, request the needed host permissions and return a
  structured bounded error if permission is refused

If shared logic is clearly needed, extract a tiny helper from
`src/services/session-executor.ts`; otherwise keep the change local.

- [ ] **Step 4: Run the focused test**

Run:
`deno test src/services/session-mcp-runtime.test.ts --filter "path-based indexing|indexes a local file"`

Expected: PASS.

### Task 5: Implement source/label replacement semantics in the corpus

**Files:**

- Modify: `src/services/session-corpus.ts`
- Test: `src/services/session-corpus.test.ts`
- Test: `src/services/session-mcp-runtime.test.ts`

- [ ] **Step 1: Write failing corpus tests for replacement semantics**

Add tests covering:

- re-indexing the same `(rootSessionId, source, label)` replaces prior
  searchable content
- old content is no longer returned by search
- replacement does not duplicate logical-document state

Suggested test sketch:

```ts
it("replaces prior content for the same source and label", async () => {
  await corpus.index({
    rootSessionId: "root-1",
    content: "old alpha body",
    source: "build-log",
    label: "latest",
  });
  await corpus.index({
    rootSessionId: "root-1",
    content: "new beta body",
    source: "build-log",
    label: "latest",
  });
  const oldSearch = await corpus.search({
    rootSessionId: "root-1",
    query: "alpha",
  });
  const newSearch = await corpus.search({
    rootSessionId: "root-1",
    query: "beta",
  });
  assertEquals(oldSearch.results.length, 0);
  assertEquals(newSearch.results.length > 0, true);
});
```

- [ ] **Step 2: Run the focused corpus test to verify it fails**

Run:
`deno test src/services/session-corpus.test.ts --filter "source and label|replaces prior content"`

Expected: FAIL because indexing currently only appends.

- [ ] **Step 3: Implement minimal identity-aware replacement bookkeeping**

In `src/services/session-corpus.ts`:

- introduce a stable mapping for `(groupId, rootSessionId, source, label)` to
  the current logical corpus/document identity
- on replacement:
  - find the old logical document’s owned searchable state
  - remove old searchable associations/postings/metadata before indexing the
    replacement
  - write the new canonical content
  - update the identity mapping

Keep this local to the corpus subsystem; do not implement replacement as
search-time filtering or tombstoning.

- [ ] **Step 4: Run the focused replacement tests**

Run:
`deno test src/services/session-corpus.test.ts --filter "source and label|replaces prior content|replacement"`

Expected: PASS.

### Task 6: Wire runtime-level index replacement behavior

**Files:**

- Modify: `src/services/session-mcp-runtime.ts`
- Test: `src/services/session-mcp-runtime.test.ts`

- [ ] **Step 1: Write a failing runtime-level replacement test**

Add a test that calls `session_index` twice with the same `source`/`label`, then
uses `session_search` to confirm only the new content remains visible.

- [ ] **Step 2: Run the focused test to verify it fails**

Run:
`deno test src/services/session-mcp-runtime.test.ts --filter "same source|same label|replacement"`

Expected: FAIL until runtime passes the new identity fields through cleanly.

- [ ] **Step 3: Implement the minimal runtime pass-through**

Pass `source` and `label` from `session_index` requests to `corpus.index(...)`.

- [ ] **Step 4: Run the focused test**

Run:
`deno test src/services/session-mcp-runtime.test.ts --filter "same source|same label|replacement"`

Expected: PASS.

### Task 7: Update docs for the narrowed parity closure only

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Write the doc changes**

Update only the relevant sections to describe:

- mixed command + search support in `session_batch_execute`
- `session_index` support for inline content or local `path`
- optional `source`/`label` replacement semantics

Do not rename tools and do not mention any upgrade tool.

- [ ] **Step 2: Verify docs stay aligned with the narrowed scope**

Read back the changed sections and confirm they match the approved decisions:

- `session_*` stays public
- no upgrade/update tool
- Graphiti + Redis/FalkorDB architecture unchanged

### Task 8: Run final verification for the narrowed gap-closure work

**Files:**

- Test: `src/services/session-mcp-runtime.test.ts`
- Test: `src/services/session-corpus.test.ts`
- Test: `src/services/session-executor.test.ts`
- Test: `README.md`

- [ ] **Step 1: Run focused parity verification**

Run:

```bash
deno test src/services/session-mcp-runtime.test.ts src/services/session-corpus.test.ts src/services/session-executor.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full repo verification**

Run:

```bash
deno test && deno task check && deno task lint && deno fmt --check
```

Expected: all commands pass.

- [ ] **Step 3: Re-check the original narrowed goals against the result**

Confirm all of the following are true:

- `session_batch_execute` supports mixed command + search steps
- `session_index` supports path ingestion
- `session_index` supports `source`/`label` replacement semantics
- `session_*` naming remains unchanged
- no upgrade/update tool was added
- Graphiti async + cached `<persistent_memory>` behavior remains intact

## Exit criteria

- Mixed command + search steps work in `session_batch_execute`.
- `session_index` accepts inline content or local path input.
- Re-indexing the same `(source, label)` replaces prior indexed content for that
  root session.
- README reflects the narrowed parity closure only.
- Full repo tests, check, lint, and format verification all pass.
