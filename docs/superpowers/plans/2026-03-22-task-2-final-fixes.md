# Task 2 Final Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Task 2 to ready state by reproducing and fixing any remaining
`session_search` candidate-cap compliance gap, and by adding structured non-OK
handling for `session_fetch_and_index`.

**Architecture:** Keep the existing Redis-backed local corpus design and
retrieval stages intact. First verify whether the current search implementation
still has a real 200-candidate-cap compliance gap; only patch `session_search`
if a new failing regression test proves it. Separately, make the fetch path
reject non-success HTTP responses before indexing while still returning a
schema-valid `session_fetch_and_index` response.

**Tech Stack:** Deno, TypeScript, `jsr:@std/testing`, Redis-backed in-memory
test client, existing `session-corpus` service.

---

### Task 1: Reproduce the remaining search-cap audit claim before changing

search logic

**Files:**

- Modify: `src/services/session-corpus.test.ts`
- Modify: `src/services/session-corpus.ts`
- Test: `src/services/session-corpus.test.ts`

- [ ] **Step 1: Run the existing regression first**

Run:
`deno test src/services/session-corpus.test.ts --filter "applies the 200-candidate cap"`
Expected: Determine whether the existing regression already covers the reported
blocker.

- [ ] **Step 2: Write a sharper failing test only if the existing regression
      passes**

```ts
it("keeps RRF- and proximity-relevant chunks eligible until the final 200-candidate cap", async () => {
  // Construct a corpus where a chunk is only promoted by the full compliant
  // retrieval pipeline, not by the intermediate preliminary sum alone.
});
```

- [ ] **Step 3: Run the new test to verify it fails**

Run:
`deno test src/services/session-corpus.test.ts --filter "RRF- and proximity-relevant"`
Expected: FAIL only if the current implementation still drops a chunk that
should remain eligible until final ranking.

- [ ] **Step 4: Write minimal implementation only if the new regression fails**

```ts
// Keep candidate collection and ranking phases intact, but make the bounded
// 200-candidate selection derive from the same compliant evidence used by the
// final scorer so no chunk needed by the final ranking is dropped early.
```

- [ ] **Step 5: Run the relevant search tests to verify they pass**

Run:
`deno test src/services/session-corpus.test.ts --filter "candidate cap|RRF|trigram|proximity"`
Expected: PASS

- [ ] **Step 6: If no failing repro is found, stop changing `session_search` and
      record that the blocker could not be reproduced from the current tree**

```text
Do not refactor search heuristics without a red test.
If the existing and sharper regressions both pass, leave
`src/services/session-corpus.ts` unchanged for search.
```

### Task 2: Lock non-OK fetch handling with tests

**Files:**

- Modify: `src/services/session-corpus.test.ts`
- Modify: `src/services/session-mcp-runtime.test.ts`
- Modify: `src/services/session-corpus.ts`
- Test: `src/services/session-corpus.test.ts`
- Test: `src/services/session-mcp-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("returns a structured error when fetch responds with non-ok status", async () => {
  // Stub fetch to return new Response("missing", { status: 404 })
  // and assert status=error, non-empty corpusRef, URL echo, and HTTP status in
  // summary.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test src/services/session-corpus.test.ts --filter "non-ok status"`
Expected: FAIL because the current code treats the response as a successful
indexed document.

- [ ] **Step 3: Write minimal implementation**

```ts
const contentType = response.headers.get("content-type")?.split(";")[0] ??
  "text/plain";
if (!response.ok) {
  return {
    status: "error",
    corpusRef: corpusRefFor(
      input.rootSessionId,
      `error-http-${response.status}`,
    ),
    summary: `Fetch failed for ${input.url} with HTTP ${response.status}.`,
    queryHints: [],
    fetchedUrl: input.url,
    contentType,
    truncated: false,
  };
}
const content = await response.text();
```

This replaces the existing `contentType`/`response.text()` sequence in
`src/services/session-corpus.ts`; do not duplicate the declaration.

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test src/services/session-corpus.test.ts --filter "non-ok status"`
Expected: PASS

- [ ] **Step 5: Add and run the runtime-layer regression**

```ts
it("serializes a schema-valid error response for non-ok fetches", async () => {
  // Execute session_fetch_and_index through the runtime boundary and assert the
  // parsed response survives schema validation with a non-empty corpus_ref.
});
```

Run:
`deno test src/services/session-mcp-runtime.test.ts --filter "schema-valid error response"`
Expected: PASS

### Task 3: Verify the full affected surface

**Files:**

- Modify: `src/services/session-corpus.ts` (only if cleanup is needed after
  tests pass)
- Test: `src/services/session-corpus.test.ts`
- Test: `src/services/session-mcp-runtime.test.ts`

- [ ] **Step 1: Run focused corpus and runtime tests**

Run:
`deno test src/services/session-corpus.test.ts src/services/session-mcp-runtime.test.ts`
Expected: PASS

- [ ] **Step 2: Run repository verification**

Run: `deno task check && deno lint && deno fmt --check` Expected: PASS

- [ ] **Step 3: Confirm Task 2 exit criteria**

```text
- search cap applied through the compliant ranking path
- non-ok fetch responses return structured errors
- targeted tests pass
- broader Deno verification passes
```
