# Fetch Excerpt And Direct Corpus Ref Recall Design

## Goal

Make `session_fetch_and_index` immediately useful without requiring a follow-up
search, and make the returned fetch handle reusable in `session_search` so
agents do not have to restate the original keyword set.

The new behavior is:

1. `session_fetch_and_index` returns the existing `corpus_ref` plus a bounded
   `excerpt` of the fetched content.
2. `session_search({ query: corpus_ref })` resolves that exact handle directly
   and surfaces the fetched content without relying on keyword ranking.

## Problem

Today, `session_fetch_and_index` returns a `corpus_ref`, but that handle is not
directly useful for exact recall through `session_search`.

The current search pipeline tokenizes free-form query text with a lossy
alphanumeric tokenizer. That is good for ordinary keyword retrieval, but it is
the wrong place to recognize a structured corpus handle:

- `corpus_ref` values are structured handles such as
  `session:group-stub:root-stub:corpus:stub-fetch:meta`
- the existing search pipeline splits on punctuation before ranking
- after tokenization, the handle is no longer distinguishable from ordinary
  keyword queries

This causes agents to repeat the fetched page's keyword set instead of reusing
the handle returned by the tool.

## Non-Goals

This design does not:

1. add a new public search parameter alongside `query`
2. inject `fetch id: ...` lines into indexed content
3. change ordinary keyword-search ranking behavior
4. widen local search to other root sessions
5. add fuzzy or partial corpus-handle matching

## Current Constraints

### `corpus_ref` Is Already Stable Enough

The current `corpus_ref` is not a bare UUID. It is a deterministic structured
handle built from the local corpus namespace. That makes exact detection easier
than UUID recognition because the handle shape is already namespaced and not
ambiguous with normal prose.

### Keyword Search Must Stay Intact

Normal `session_search` behavior is still correct for ordinary recall. The new
behavior must be an exact-handle fast path that runs before tokenization. It
must not change the current ranking pipeline for non-handle queries.

## Design Overview

### 1. `session_fetch_and_index` Returns An Excerpt

`session_fetch_and_index` keeps its current response fields and adds one new
field:

- `excerpt: string`

The `excerpt` is a bounded snippet from the normalized fetched body, not the raw
HTML or transport body.

Properties:

1. it uses the same normalized content that is actually indexed
2. it is short enough to fit comfortably within the existing bounded tool
   response budget
3. it is intended for immediate user/agent inspection, not durable identity
4. it is always present in the response schema

For successful fetches:

- `excerpt` is the leading bounded snippet of normalized content

For failed fetches:

- `excerpt` is the empty string

Using a required string keeps the contract simple for agents and avoids a second
branch in normal handling.

### 2. `session_search` Gets An Exact Corpus-Ref Fast Path

Before tokenization or keyword ranking, `session_search` inspects the raw query
string.

If the trimmed query is exactly one valid `corpus_ref` for the current root
session, `session_search` performs a direct corpus lookup and returns that exact
corpus as the result.

If the query is anything else, `session_search` uses the current keyword-search
pipeline unchanged.

This is intentionally exact-only.

The first version does not treat embedded handles inside surrounding prose as
direct lookup requests. That would make disambiguation with normal keyword
queries harder than necessary and would weaken the mental model. Exact-only is
deterministic, easy to document, and easy for agents to follow.

### 3. No `fetch id:` Content Injection

The earlier idea of prefixing indexed bodies with `fetch id: ${corpus_ref}` is
dropped.

Reason:

1. the handle is already available in the response contract
2. direct raw-query detection is cleaner than embedding retrieval metadata into
   user-visible content
3. injecting the handle into the indexed body would be compensating for the
   wrong boundary; the right boundary is pre-tokenization query parsing

## Exact Detection Rule

`session_search` should treat a query as a direct corpus lookup request only
when all of the following are true:

1. after trimming whitespace, the query is one exact candidate string
2. the candidate matches the corpus-ref shape used by the local corpus store
3. the candidate belongs to the current canonical root session namespace
4. the referenced corpus metadata exists

If any of those checks fail, the runtime falls back to normal keyword search.

This keeps the new behavior strict and predictable.

## Response Behavior

### `session_fetch_and_index`

Its shipped tool description must explicitly teach the follow-up pattern:

- the response includes a reusable `corpus_ref`
- agents can later call `session_search({ query: corpus_ref })` to reopen the
  fetched content without repeating the original keyword set

Successful response shape becomes:

```json
{
  "status": "ok",
  "corpus_ref": "session:group:root:corpus:corpus-1:meta",
  "summary": "Fetched and indexed https://example.com",
  "excerpt": "Leading normalized snippet...",
  "query_hints": ["example", "ttl"],
  "fetched_url": "https://example.com",
  "content_type": "text/markdown",
  "truncated": false
}
```

Failed response shape stays schema-valid and includes:

```json
{
  "status": "error",
  "corpus_ref": "session:group:root:corpus:error-http-404:meta",
  "summary": "Fetch failed for https://example.com with HTTP 404.",
  "excerpt": "",
  "query_hints": [],
  "fetched_url": "https://example.com",
  "content_type": "text/plain",
  "truncated": false
}
```

### `session_search`

Its shipped tool description must explicitly teach that `query` accepts either:

1. normal free-form search text, or
2. an exact `corpus_ref` previously returned by `session_fetch_and_index`

The description should make the exact-handle usage concrete enough that agents
learn the pattern directly from tool help.

When queried with an exact `corpus_ref`, `session_search` returns a normal
search response with that exact corpus surfaced as the hit.

The exact-match result should:

1. reuse the normal result schema
2. expose the corpus ref in `refs`
3. return a bounded snippet from that corpus's normalized content
4. avoid mixing in unrelated ranked keyword results for the exact-handle path

Returning only the exact hit keeps the contract unambiguous: if the caller used
an exact handle, the runtime should answer that exact handle first and only.

## Storage And Lookup Design

The local corpus service gains a direct-lookup helper for corpus refs. It should
operate on corpus metadata/body already stored under the current root session
namespace rather than re-entering the keyword postings pipeline.

The lookup helper should:

1. validate the raw `corpus_ref`
2. derive the corpus id from the ref
3. read the corresponding corpus metadata and chunk/body data for the current
   root session
4. synthesize a bounded search-style result from that exact corpus

This is a read-path addition only. Indexing, chunking, and ranking behavior stay
unchanged.

## Why Exact-Only Is The Right First Version

There are two plausible variants:

1. exact-only handle matching
2. handle matching even when embedded in surrounding text

This design chooses exact-only because:

1. it is easy for agents to learn: paste the returned handle back into
   `session_search`
2. it avoids edge cases where ordinary text accidentally contains something that
   resembles a handle
3. it keeps keyword search and exact-handle recall clearly separated
4. it is enough to solve the reported behavior problem

If embedded-handle detection becomes necessary later, it can be added as a
separate, explicit refinement.

## Files Expected To Change

1. `src/services/session-mcp-types.ts`
   - add `excerpt` to the `session_fetch_and_index` response schema
2. `src/services/session-corpus.ts`
   - return normalized `excerpt` from `fetchAndIndex`
   - add exact corpus-ref lookup helper
3. `src/services/session-mcp-runtime.ts`
   - thread `excerpt` through the fetch response
   - add pre-tokenization exact corpus-ref detection to `session_search`
   - update the shipped descriptions for `session_fetch_and_index` and
     `session_search` to teach `session_search({ query: corpus_ref })`
4. `src/services/session-corpus.test.ts`
   - direct corpus-ref lookup coverage
5. `src/services/session-mcp-runtime.test.ts`
   - fetch excerpt contract and `session_search({ query: corpus_ref })` behavior
6. `docs/SmokeTests.md`
   - runtime validation steps for fetch excerpt plus exact-handle recall

## Testing Requirements

The implementation must prove all of the following:

1. `session_fetch_and_index` success responses include a non-empty `excerpt`
2. `session_fetch_and_index` error responses include `excerpt: ""`
3. `session_search({ query: corpus_ref })` surfaces contents from the fetched
   corpus without repeating original keywords
4. exact corpus-ref lookup returns the exact hit only, not mixed ranked results
5. malformed or partial corpus refs fall back to normal keyword search behavior
6. ordinary keyword search behavior remains unchanged
7. same-root exact handle lookup works in both stub and redis-backed runtime
   paths where applicable
8. shipped tool descriptions for `session_fetch_and_index` and `session_search`
   explicitly mention the `corpus_ref` reuse pattern

## Risks And Mitigations

### Risk: Corpus-Ref Parsing Becomes Too Coupled To String Shape

Mitigation:

- centralize parsing and validation in one helper rather than duplicating ad hoc
  string splitting in multiple call sites

### Risk: Exact Lookup Returns Too Much Content

Mitigation:

- reuse the same bounded snippet budget used for ordinary search results

### Risk: Exact-Lookup Misses Valid Handles Across Sessions

Mitigation:

- do not widen scope in this design
- exact lookup remains current-root-session only, matching the current local
  corpus authority model

## Decision Summary

1. Add `excerpt` to `session_fetch_and_index`
2. Do not inject `fetch id:` into indexed content
3. Add exact raw-query `corpus_ref` detection before tokenization in
   `session_search`
4. Support exact-only direct-handle queries in the first version
5. Preserve ordinary keyword search behavior as the fallback path
