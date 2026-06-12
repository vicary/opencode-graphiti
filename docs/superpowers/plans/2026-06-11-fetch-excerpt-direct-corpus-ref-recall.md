# Fetch Excerpt And Direct Corpus Ref Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `session_fetch_and_index` return an immediate `excerpt`, and let
`session_search({ query: corpus_ref })` reopen fetched content directly without
restating keywords.

**Architecture:** Add a bounded `excerpt` to the fetch-and-index response
contract, then introduce an exact `corpus_ref` fast path in the local corpus
service and runtime before the normal tokenized keyword search begins. Preserve
ordinary keyword ranking as the fallback path, and update shipped tool
descriptions so agents learn the `session_search({ query: corpus_ref })` pattern
directly from tool help.

**Tech Stack:** Deno, TypeScript, Zod, in-process MCP runtime, Redis-backed
local corpus service, Deno test.

---

### Task 1: Add `excerpt` To The Fetch Response Contract

**Files:**

- Modify: `src/services/session-mcp-types.ts`
- Modify: `src/services/session-corpus.ts`
- Test: `src/services/session-corpus.test.ts`
- Test: `src/services/session-mcp-runtime.test.ts`

- [ ] **Step 1: Write the failing corpus/runtime tests for `excerpt`**

Add assertions to `src/services/session-corpus.test.ts` and
`src/services/session-mcp-runtime.test.ts` that successful fetches return a
non-empty `excerpt` and failed fetches return `excerpt: ""`.

Test additions should look like:

```ts
assertEquals(indexed.status, "ok");
assertEquals(indexed.excerpt.length > 0, true);
assertStringIncludes(indexed.excerpt, "Session TTL");
```

And for the runtime error case:

```ts
assertEquals(parsed.status, "error");
assertEquals(parsed.excerpt, "");
```

- [ ] **Step 2: Run the targeted tests to confirm they fail first**

Run:
`deno test src/services/session-corpus.test.ts src/services/session-mcp-runtime.test.ts`
Expected: FAIL because `excerpt` does not exist in the current fetch response
shape.

- [ ] **Step 3: Extend the response schema with `excerpt`**

Update `src/services/session-mcp-types.ts` so `session_fetch_and_index`
responses always include `excerpt: string`.

The schema block should become:

```ts
session_fetch_and_index: z.object({
  status: sessionMcpStatusSchema,
  corpus_ref: z.string().min(1),
  summary: z.string(),
  excerpt: z.string(),
  query_hints: z.array(z.string()),
  fetched_url: z.string().min(1),
  content_type: z.string().min(1),
  truncated: z.boolean(),
}).strict(),
```

- [ ] **Step 4: Return normalized excerpts from the corpus service**

Update `src/services/session-corpus.ts` so `fetchAndIndex()` returns a bounded
excerpt derived from normalized content.

Use the same snippet budget already used in corpus search results instead of
inventing a new one. The success path should use the normalized content written
by `writeCorpus(...)`, and the error path should use `""`.

Implementation shape:

```ts
return {
  status: "ok" as const,
  corpusRef: indexed.corpusRef,
  summary: `Fetched and indexed ${input.url}`,
  excerpt: indexed.excerpt,
  queryHints: indexed.queryHints,
  fetchedUrl: input.url,
  contentType: indexed.contentType,
  truncated: indexed.truncated,
};
```

If `writeCorpus(...)` does not currently expose a ready-to-use excerpt, extend
its return shape with a single bounded snippet derived from the normalized body.

- [ ] **Step 5: Run the targeted tests to verify the contract passes**

Run:
`deno test src/services/session-corpus.test.ts src/services/session-mcp-runtime.test.ts`
Expected: PASS for the new `excerpt` assertions.

### Task 2: Add Exact `corpus_ref` Lookup Before Keyword Tokenization

**Files:**

- Modify: `src/services/session-corpus.ts`
- Modify: `src/services/session-mcp-runtime.ts`
- Test: `src/services/session-corpus.test.ts`
- Test: `src/services/session-mcp-runtime.test.ts`

- [ ] **Step 1: Write the failing exact-handle lookup tests**

Add tests proving that `session_search({ query: fetched.corpus_ref })` surfaces
the fetched content directly, and that malformed/partial refs fall back to
normal keyword search.

Add a corpus-service level test like:

```ts
const fetched = await corpus.fetchAndIndex({
  rootSessionId: "root-fetch-ref",
  url: "http://127.0.0.1/local-doc",
  timeoutSeconds: 5,
});

const exact = await corpus.search({
  rootSessionId: "root-fetch-ref",
  query: fetched.corpusRef,
});

assertEquals(exact.corpusRefs, [fetched.corpusRef]);
assertEquals(exact.results.length, 1);
assertStringIncludes(exact.results[0].snippet, "Session TTL");
```

Add a runtime-level test like:

```ts
const fetchSerialized = await runtime.tools.session_fetch_and_index.execute(
  { url: "https://example.com/doc" },
  createRootToolContext("root-runtime-fetch-ref"),
);
const fetched = JSON.parse(fetchSerialized);

const searchSerialized = await runtime.tools.session_search.execute(
  { query: fetched.corpus_ref },
  createRootToolContext("root-runtime-fetch-ref"),
);
const search = JSON.parse(searchSerialized);

assertEquals(search.refs, [fetched.corpus_ref]);
assertEquals(search.results.length, 1);
assertStringIncludes(search.results[0].snippet, fetched.excerpt);
```

- [ ] **Step 2: Run the targeted tests to confirm they fail first**

Run:
`deno test src/services/session-corpus.test.ts src/services/session-mcp-runtime.test.ts`
Expected: FAIL because search currently tokenizes the handle instead of
resolving it directly.

- [ ] **Step 3: Add exact corpus-ref detection and direct lookup in the corpus
      service**

Update `src/services/session-corpus.ts` so `search()` inspects the raw query
before tokenization.

Implement a single helper that:

1. trims the query
2. validates the corpus-ref shape for the current root session namespace
3. derives the corpus id from the ref
4. checks corpus metadata existence
5. returns a single bounded search result when the handle is valid

Keep it exact-only. Do not support embedded handles inside surrounding text.

Implementation shape should be close to:

```ts
const directCorpusRefResult = await lookupExactCorpusRef({
  rootSessionId: input.rootSessionId,
  query: input.query,
});

if (directCorpusRefResult) {
  return {
    status: "ok",
    results: [directCorpusRefResult],
    corpusRefs: [directCorpusRefResult.corpus_ref],
    truncated: false,
  };
}
```

- [ ] **Step 4: Keep runtime search behavior thin**

Ensure `src/services/session-mcp-runtime.ts` keeps delegating to corpus search
without adding a second inconsistent handle parser in the runtime layer. The
exact-handle logic should live in one place in the corpus service.

- [ ] **Step 5: Run the targeted tests to verify direct-handle lookup passes**

Run:
`deno test src/services/session-corpus.test.ts src/services/session-mcp-runtime.test.ts`
Expected: PASS for exact `corpus_ref` lookup and fallback behavior.

### Task 3: Teach The Tool Descriptions The Reuse Pattern

**Files:**

- Modify: `src/services/session-mcp-runtime.ts`
- Test: `src/services/session-mcp-runtime.test.ts`
- Test: `src/index.test.ts`

- [ ] **Step 1: Write failing description assertions first**

Add assertions that both shipped descriptions explicitly mention the
`corpus_ref` reuse pattern.

Example assertions:

```ts
assertStringIncludes(
  runtime.tools.session_fetch_and_index.description,
  "session_search({ query: corpus_ref })",
);
assertStringIncludes(
  runtime.tools.session_search.description,
  "exact `corpus_ref` previously returned by `session_fetch_and_index`",
);
```

- [ ] **Step 2: Run the description-focused tests to confirm they fail first**

Run: `deno test src/services/session-mcp-runtime.test.ts src/index.test.ts`
Expected: FAIL because the current descriptions do not yet mention `corpus_ref`
reuse.

- [ ] **Step 3: Update the shipped descriptions**

Edit the `session_fetch_and_index` and `session_search` descriptions in
`src/services/session-mcp-runtime.ts` so they explicitly teach agents this exact
pattern:

```ts
"The response includes `corpus_ref`; later call `session_search({ query: corpus_ref })` to reopen the fetched content without repeating keywords.";
```

And for search:

```ts
"`query` accepts either normal free-form search text or an exact `corpus_ref` previously returned by `session_fetch_and_index`.";
```

- [ ] **Step 4: Re-run the description tests**

Run: `deno test src/services/session-mcp-runtime.test.ts src/index.test.ts`
Expected: PASS.

### Task 4: Update Smoke-Test Documentation

**Files:**

- Modify: `docs/SmokeTests.md`

- [ ] **Step 1: Add the new fetch-and-reopen validation steps**

Update the relevant smoke-test scenario so operators verify:

1. `session_fetch_and_index` returns `corpus_ref` and `excerpt`
2. `session_search({ query: corpus_ref })` returns the fetched content directly
3. agents no longer need to restate the original keyword set to reopen the fetch

Document the proof artifacts to capture, for example:

```md
- successful `session_fetch_and_index` response including `corpus_ref` and
  `excerpt`
- subsequent `session_search` response using only that `corpus_ref` in `query`
- returned bounded snippet showing the fetched content
```

- [ ] **Step 2: Review the doc change for consistency with current response
      fields**

Read the edited section and verify it uses `corpus_ref`, `excerpt`, and `query`
consistently with the updated tool contract.

### Task 5: Full Verification

**Files:**

- No new source files expected

- [ ] **Step 1: Run the focused affected suites**

Run:
`deno test src/services/session-corpus.test.ts src/services/session-mcp-runtime.test.ts src/index.test.ts`
Expected: PASS.

- [ ] **Step 2: Run repository type-check**

Run: `deno task check` Expected: PASS.

- [ ] **Step 3: Run lint**

Run: `deno lint` Expected: PASS.

- [ ] **Step 4: Run format**

Run: `deno fmt` Expected: files are already formatted or formatting is applied
cleanly.
