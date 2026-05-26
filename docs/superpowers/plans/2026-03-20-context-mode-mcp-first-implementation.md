# Context-Mode-Aligned MCP-First Replacement — Implementation Task Plan

**Status:** Completed\
**Date:** 2026-03-20\
**Primary architecture:**
`docs/superpowers/plans/2026-03-20-context-mode-mcp-first.md`\
**This plan supersedes:**
`docs/superpowers/plans/2026-03-20-context-overhaul-hot-path.md` and any
in-progress native-hook-first implementation work derived from it\
**Grounding sources used:** `AGENTS.md`, `README.md`, `src/index.ts`,
`src/session.ts`, `docs/ContextOverhaul.md`, `docs/ContextOverhaulTests.md`,
`docs/superpowers/plans/2026-03-20-context-mode-mcp-first.md`, `deno.json`

---

## 1. Purpose

This document is the execution plan for the MCP-first replacement architecture.
It is for implementation work only. It is not a design exploration document.

Every task below is ordered, concrete, and intended for subagent-by-subagent
execution without reinterpretation.

The implementation must keep these facts true throughout:

1. `session_*` MCP tools are the primary product surface for bounded execution,
   fetch, file processing, indexing, and search.
2. OpenCode hooks remain secondary: enforcement, attribution, continuity
   capture, and `<session_memory>` injection only.
3. Redis/FalkorDB remains the hot-tier system of record.
4. Graphiti stays asynchronous and off the hot path.
5. Parent and child sessions share one canonical root-session-local corpus.

---

## 2. Locked Defaults For This Milestone

These defaults are mandatory for the implementation. Do not reopen them during
execution.

### 2.1 Runtime and transport

- Use an **in-process** `session_*` runtime owned by the same plugin runtime as
  `src/index.ts`.
- Do **not** introduce an out-of-process MCP server as the default path.
- Do **not** invent undocumented OpenCode capabilities. The implementation must
  use only exported APIs from the installed `@opencode-ai/plugin` and
  `@modelcontextprotocol/sdk` packages already in `deno.json`.
- If the installed OpenCode plugin package does not expose a documented tool
  registration surface compatible with this plan, stop implementation and update
  the controlling architecture docs instead of inventing a private integration.

### 2.2 Storage and scope

- Local corpora are scoped to the canonical root session only.
- Namespace all local corpus keys under the concrete shape
  `session:{groupId}:{root}:...`; bare `session:{root}:...` keys are not
  acceptable final implementation output for this milestone.
- Use Redis-compatible primitives only: strings, hashes, sets, lists, TTLs, and
  pipelined/multi operations.
- Do **not** assume RediSearch, SQLite, FTS5, BM25, or undocumented FalkorDB
  full-text features.

### 2.3 Search and chunking

- Markdown / normalized HTML: heading-aware chunks with intact fenced code
  blocks preserved under the nearest heading.
- HTML fetches must be normalized into a markdown-oriented or
  markdown-equivalent representation before chunking; flat tag-stripped blobs do
  not satisfy the target parity level.
- HTML normalization must preserve at minimum: headings, paragraph/section
  boundaries, ordered/unordered list boundaries, and pre/code blocks.
- Plain text / logs: 1200-character chunks with 200-character overlap.
- JSON: pretty-print before chunking; do not index minified JSON directly.
- Search ranking order is fixed:
  1. query normalization + porter-equivalent stemming
  2. token/stem candidate collection
  3. conditional trigram candidate expansion when token/stem recall is sparse or
     query form is partial-string oriented
  4. BM25-style scoring for token/stem candidates
  5. trigram scoring for substring candidates
  6. Reciprocal Rank Fusion (RRF) across ranked token/stem and trigram lists
  7. multi-term proximity reranking
  8. light recency boost
  9. light shorter-chunk boost
- Token and trigram evidence must remain distinguishable in the scorer so the
  implementation resembles the practical retrieval behavior of `context-mode`
  rather than degenerating into one undifferentiated bag-of-hits ranking pass.
- Retrieval phases are also locked: collect token candidates first, and add
  trigram candidates only when token recall is sparse or when the query form is
  explicitly partial-string oriented.
- Fuzzy correction is required for typo-tolerant retrieval before the search
  path gives up on local recall.
- Candidate scoring is bounded to the top 200 candidate chunks before final
  ranking.
- `session_search` returns at most 5 results, each with one bounded snippet of
  at most 320 characters.

### 2.4 Bounded result contracts

- `session_execute`, `session_execute_file`, and `session_batch_execute` return
  a bounded human-readable summary plus references, never an unbounded raw
  payload.
- Tool response body budget: 32 KB maximum serialized response payload per
  `session_*` call.
- Large execution/fetch/file artifacts are stored locally and referenced by
  artifact or corpus ID.
- `session_batch_execute` is sequential only in v1. No hidden parallelism.
- Default command timeout for `session_execute`: 30 seconds.
- Maximum allowed command timeout in this milestone: 120 seconds.
- Default fetch timeout for `session_fetch_and_index`: 15 seconds.
- Maximum indexed source body per single fetch/file/command artifact in this
  milestone: 512 KB after normalization. Larger bodies are truncated before
  indexing and the truncation must be surfaced in metadata.

### 2.5 TTL behavior

- Session events: `redis.sessionTtlSeconds`.
- Snapshots: `2 * redis.sessionTtlSeconds`.
- Local corpora, chunks, postings, artifacts, and stats:
  `redis.sessionTtlSeconds`.
- Graphiti cache: `redis.cacheTtlSeconds`.
- Pending drain + dead-letter state: `3 * redis.sessionTtlSeconds`.
- Successful writes and successful local search hits refresh TTL for the full
  affected local corpus family.
- Expired local corpus lookups must return a structured not-found / expired
  result, not throw an unhandled error.

### 2.6 Execution environment

- `session_execute*` uses the local plugin process and the current project
  directory. Do not add container orchestration or remote execution in this
  milestone.
- `session_fetch_and_index` uses standard HTTP fetch from the plugin runtime.
- `session_execute_file` reads local files directly through Deno APIs and must
  never depend on native `Read` as its implementation path.

---

## 3. Required File Structure

Create or modify these files unless a task below says otherwise.

### 3.1 New files to create

- `src/services/session-mcp-types.ts`
- `src/services/session-mcp-runtime.ts`
- `src/services/session-mcp-runtime.test.ts`
- `src/services/session-corpus.ts`
- `src/services/session-corpus.test.ts`
- `src/services/session-executor.ts`
- `src/services/session-executor.test.ts`
- `src/session.test.ts`

### 3.2 Existing files to modify

- `src/index.ts`
- `src/index.test.ts`
- `src/session.ts`
- `src/types/index.ts`
- `src/handlers/tool-before.ts`
- `src/handlers/tool-before.test.ts`
- `src/handlers/tool-after.ts`
- `src/handlers/tool-after.test.ts`
- `src/handlers/event.ts`
- `src/handlers/event.test.ts`
- `src/handlers/chat.ts`
- `src/handlers/chat.test.ts`
- `src/handlers/messages.ts`
- `src/handlers/messages.test.ts`
- `src/handlers/compacting.ts`
- `src/handlers/compacting.test.ts`
- `src/services/tool-routing.ts`
- `src/services/tool-routing.test.ts`
- `src/services/redis-client.test.ts`
- `README.md`
- `docs/ContextOverhaul.md`
- `docs/ContextOverhaulTests.md`

### 3.3 Files to delete or explicitly retire

- `docs/superpowers/plans/2026-03-20-context-overhaul-hot-path.md`
  - delete it if it exists in the working tree or branch under implementation
  - if it is already absent, keep it absent and remove any references to it
- Do **not** delete `docs/ContextOverhaul.md`; keep it as a superseded
  historical document with corrected references.

---

## 4. Ordered Top-Level Tasks

Execute tasks in this exact order. Do not reorder them.

1. Define the `session_*` MCP server surface and bounded result contracts.
2. Implement local corpus storage/index/search on Redis/FalkorDB.
3. Thread canonical root-session identity into all `session_*` calls.
4. Integrate `session_*` results into continuity capture and stats.
5. Rewrite `tool.execute.before` / `tool.execute.after` around enforcement and
   attribution.
6. Extend temporary-root migration and teardown coverage to new MCP local state.
7. Validate compaction continuity and async Graphiti augmentation remain intact.

No native-hook-first task may start ahead of Task 1 or Task 2.

---

## 5. Task 1 — Define `session_*` MCP surface and bounded result contracts

### 5.1 Goal

Create the in-process `session_*` runtime, schemas, and registration layer
first. This task establishes the primary product surface before any
enforcement-hook rewrite.

### 5.2 Files

**Create**

- `src/services/session-mcp-types.ts`
- `src/services/session-mcp-runtime.ts`
- `src/services/session-mcp-runtime.test.ts`

**Modify**

- `src/index.ts`
- `src/index.test.ts`
- `src/types/index.ts`

### 5.3 Implementation requirements

1. Define zod-backed request/response schemas in
   `src/services/session-mcp-types.ts` for exactly these tools:
   - `session_execute`
   - `session_execute_file`
   - `session_batch_execute`
   - `session_index`
   - `session_search`
   - `session_fetch_and_index`
   - `session_stats`
   - `session_doctor`
2. Superseded by later runtime contract changes: public request schemas no
   longer accept `root_session_id`; canonical root-session identity is resolved
   implicitly from runtime context.
3. Every response schema must include `status` and enough metadata to attribute
   results later in hooks.
4. Add a runtime module in `src/services/session-mcp-runtime.ts` that:
   - owns tool registration
   - dispatches to typed handlers
   - exposes `dispose()` for teardown
   - does not perform Graphiti I/O
   - returns minimal **valid** schema-conforming responses from any initial stub
     handler implementation; schema-only placeholders that return `undefined`,
     partial payloads, or shape-invalid objects are forbidden
5. Lock response contracts now:
   - `session_execute`:
     `{ status, summary, artifact_ref?, exit_code,
     timed_out, truncated, bytes_captured }`
   - `session_batch_execute`: `{ status, summary, results[], truncated }`
   - `session_execute_file`:
     `{ status, summary, artifact_ref?, corpus_ref?,
     file_count, truncated }`
   - `session_index`: `{ status, corpus_ref, chunk_count, query_hints[] }`
   - `session_search`: `{ status, results[], corpus_refs[], truncated }`
   - `session_fetch_and_index`:
     `{ status, corpus_ref, summary, query_hints[],
     fetched_url, content_type, truncated }`
   - `session_stats`:
     `{ status, counters, corpus_count, artifact_count,
     bytes_saved_estimate }`
   - `session_doctor`: `{ status, checks, redis, graphiti_cache, runtime }`
6. `src/index.ts` must instantiate the new runtime inside the existing runtime
   initialization path and register its `dispose()` inside the same teardown
   chain as Redis and Graphiti.
7. Do not make `tool.execute.before` the owner of any `session_*` execution
   semantics.

### 5.4 TDD steps

Write failing tests first in `src/services/session-mcp-runtime.test.ts` and
`src/index.test.ts` covering:

- runtime registers exactly the 8 `session_*` tools
- each tool schema rejects caller-supplied `root_session_id`
- initial stub handlers return minimal valid responses for all 8 registered
  tools
- response payloads are capped to the exact 32 KB response budget
- at least one large-output case crossing the 32 KB boundary falls back to local
  artifact storage/reference instead of returning an oversized inline payload
- `session_batch_execute` executes sequentially in request order
- `src/index.ts` wires runtime initialization and teardown in-process

### 5.5 Verification commands

```bash
deno test src/services/session-mcp-runtime.test.ts src/index.test.ts
deno task check
```

### 5.6 Completion gate

Task 1 is done only when the repo has a real in-process `session_*` runtime with
typed contracts and teardown coverage, even if the handlers still return stubbed
results internally.

---

## 6. Task 2 — Implement local corpus storage/index/search on Redis/FalkorDB

### 6.1 Goal

Build the local session-scoped corpus/index/search layer before any hook
rewrite.

This task must aim for close feature resemblance to `context-mode`'s practical
corpus behavior, not merely any local index that passes a tiny baseline test.

### 6.2 Files

**Create**

- `src/services/session-corpus.ts`
- `src/services/session-corpus.test.ts`

**Modify**

- `src/services/redis-client.test.ts`
- `src/services/session-mcp-runtime.ts`
- `src/services/session-mcp-runtime.test.ts`

### 6.3 Implementation requirements

1. `src/services/session-corpus.ts` must own:
   - corpus metadata writes
   - chunk storage
   - term postings
   - trigram postings
   - artifact metadata for oversized execution/fetch/file outputs
   - corpus-family TTL refresh
   - search ranking
2. Use these key families exactly:
   - `session:{groupId}:{root}:corpora`
   - `session:{groupId}:{root}:corpus:{corpusId}:meta`
   - `session:{groupId}:{root}:corpus:{corpusId}:chunks`
   - `session:{groupId}:{root}:chunk:{chunkId}`
   - `session:{groupId}:{root}:term:{token}`
   - `session:{groupId}:{root}:tri:{trigram}`
   - `session:{groupId}:{root}:artifact:{artifactId}:meta`
   - `session:{groupId}:{root}:artifact:{artifactId}:body`
   - `session:{groupId}:{root}:stats`
3. `session_index` must write normalized content into the above structures.
4. `session_fetch_and_index` must:
   - fetch content with local HTTP fetch
   - normalize HTML into a markdown-oriented or markdown-equivalent text form
     that preserves heading/section structure closely enough to resemble
     `context-mode` retrieval behavior
   - preserve pre/code blocks as fenced-code-style units in the normalized
     representation
   - preserve list and paragraph boundaries in the normalized representation
   - normalize Markdown/text/JSON
   - index through the same corpus service
   - never touch Graphiti
5. `session_execute` and `session_execute_file` must write searchable artifact
   text through the same corpus service when output is large enough to exceed
   the bounded response surface.
6. `session_search` must read only local corpus structures and rank in process.
7. TTL refresh must apply to the whole related corpus family, not just the hit
   chunk.
8. Expired data must yield structured empty/not-found results.
9. Markdown/HTML chunking must preserve fenced code blocks with their nearest
   heading rather than splitting them arbitrarily.
10. Artifact storage must avoid keeping duplicate full-body copies when one
    canonical artifact representation plus derived searchable index text is
    sufficient.
11. Production runtime wiring must be completed as part of this task: the
    in-process `session_*` runtime in `src/index.ts` must receive the live
    Redis-backed corpus dependencies so local indexing/search is not test-only.
12. `src/index.ts` must explicitly pass the live `redisClient`,
    `config.redis.sessionTtlSeconds`, and the resolved project `groupId` into
    `createSessionMcpRuntime(...)`; leaving the runtime in stub-only mode is a
    Task 2 failure.
13. Token and trigram retrieval must remain distinct in both retrieval order and
    scoring: token candidate collection happens first; trigram candidate
    expansion happens only for sparse token recall or partial-string queries.
14. The chunking algorithm must explicitly treat fenced code blocks as atomic
    units that cannot be split by the plain-text windowing pass.
15. The retrieval implementation must include all of these `context-mode`-style
    behaviors in application code over Redis/FalkorDB postings:
    - porter-equivalent stemming
    - BM25-style scoring for token/stem matches
    - trigram substring retrieval
    - Reciprocal Rank Fusion (RRF)
    - fuzzy correction for misspelled queries
    - proximity reranking for multi-term queries

### 6.4 TDD steps

Write failing tests first in `src/services/session-corpus.test.ts` for:

- `session_fetch_and_index`
- `session_search`
- TTL expiry graceful behavior
- heading-preserving HTML normalization that produces query-visible section
  structure rather than a flat stripped blob
- HTML normalization preserving pre/code blocks and list/paragraph boundaries in
  the intermediate normalized representation
- fenced code blocks remaining intact under their nearest heading after
  chunking/indexing
- the small-corpus relevance baseline:
  - doc A `Redis Session TTLs`
  - doc B `Graphiti Async Drain`
  - doc C `Child Session Canonicalization`
  - query `session ttl`
  - doc A must rank first
- partial-string retrieval behavior where trigram-style matching can surface the
  intended chunk when an exact token form is absent
- stemming behavior where an inflected query still finds the intended indexed
  document family
- BM25-style ranking behavior where repeated/title-weighted query terms outrank
  weaker candidates
- RRF behavior where token/stem and trigram result lists are fused rather than
  one simply replacing the other
- fuzzy-correction behavior where a misspelled query still retrieves the
  intended result
- proximity-reranking behavior where near-adjacent multi-term matches outrank
  distant matches for the same terms
- artifact storage + bounded summary behavior for large outputs
- no duplicate canonical full-body storage for one oversized artifact

Write failing tests first in `src/index.test.ts` covering:

- `src/index.ts` passes the live Redis-backed corpus dependencies into
  `createSessionMcpRuntime(...)`
- the runtime produced by `src/index.ts` is not left in corpus/search stub mode
  when Redis is available

Extend `src/services/redis-client.test.ts` so the fake runtime can support any
additional Redis primitives needed by `session-corpus.ts` tests.

Extend `src/services/session-mcp-runtime.test.ts` so production-style runtime
construction with a real `RedisClient` exercises the local corpus path rather
than only test-only injected behavior.

### 6.5 Verification commands

```bash
deno test src/services/session-corpus.test.ts src/services/redis-client.test.ts src/services/session-mcp-runtime.test.ts src/index.test.ts
deno task check
```

### 6.6 Completion gate

Task 2 is done only when local indexing and search work fully without Graphiti
and the small-corpus relevance baseline passes exactly.

Task 2 is NOT done if corpus/search parity exists only in tests while
`src/index.ts` still constructs a stub-only runtime with no live corpus wiring.

---

## 7. Task 3 — Thread canonical root-session identity into all `session_*` calls

### 7.1 Goal

Make canonical root-session identity mandatory for all `session_*` activity and
shared across parent/child sessions.

### 7.2 Files

**Create**

- `src/session.test.ts`

**Modify**

- `src/session.ts`
- `src/handlers/tool-before.ts`
- `src/handlers/tool-before.test.ts`
- `src/services/session-mcp-runtime.ts`
- `src/services/session-mcp-runtime.test.ts`
- `src/services/session-corpus.ts`
- `src/services/session-corpus.test.ts`

### 7.3 Implementation requirements

1. Reuse `SessionManager` as the only canonical lineage authority.
2. `tool.execute.before` must preserve canonical root-session context for every
   `session_*` call using canonical resolution from `src/session.ts`.
3. The `session_*` runtime must resolve canonical root-session identity from
   runtime context; callers must not supply `root_session_id`, and the runtime
   must not invent a second lineage model.
4. All corpus/artifact/stats writes must use the canonical root session ID,
   never the raw child session ID.
5. Parent and child sessions must read from the same root corpus namespace.
6. Temporary-root sessions must remain supported until later migration work in
   Task 6.

### 7.4 TDD steps

Write failing tests first in `src/session.test.ts`,
`src/handlers/tool-before.test.ts`, and `src/services/session-corpus.test.ts`
covering:

- parent and child `session_*` calls share one root corpus namespace
- `tool.execute.before` keeps `session_*` calls rooted in canonical session
  context without mutating public args
- native tool calls do not receive `root_session_id`
- the runtime rejects caller-supplied `root_session_id` and resolves canonical
  root identity from context

### 7.5 Verification commands

```bash
deno test src/session.test.ts src/handlers/tool-before.test.ts src/services/session-corpus.test.ts src/services/session-mcp-runtime.test.ts
deno task check
```

### 7.6 Completion gate

Task 3 is done only when parent and child sessions demonstrably share a single
root-session-local corpus and all `session_*` calls are rooted through
`SessionManager`.

---

## 8. Task 4 — Integrate `session_*` results into continuity capture and stats

### 8.1 Goal

Capture bounded MCP-first tool activity into local continuity and local stats
without polluting events or `<session_memory>` with raw payloads.

### 8.2 Files

**Modify**

- `src/handlers/event.ts`
- `src/handlers/event.test.ts`
- `src/handlers/chat.ts`
- `src/handlers/chat.test.ts`
- `src/types/index.ts`
- `src/services/session-corpus.ts`
- `src/services/session-corpus.test.ts`
- `src/services/session-mcp-runtime.ts`
- `src/services/session-executor.ts`
- `src/services/session-executor.test.ts`

### 8.3 Implementation requirements

1. Add typed event metadata for `session_*` tool activity:
   - tool name
   - root session ID
   - corpus refs
   - artifact refs
   - bytes captured
   - bytes omitted from transcript
   - truncation flag
2. Keep event bodies compact. No stored event body may exceed existing hot-tier
   event limits.
3. Add root-session-local stats counters in `session:{root}:stats` for at least:
   - `session_execute_calls`
   - `session_execute_file_calls`
   - `session_batch_execute_calls`
   - `session_index_calls`
   - `session_search_calls`
   - `session_fetch_and_index_calls`
   - `artifact_count`
   - `corpus_count`
   - `bytes_indexed_total`
   - `bytes_returned_total`
   - `bytes_saved_estimate`
4. `session_stats` must read those counters directly from local state.
5. `chat.message` preparation must remain local-first and deterministic.
   `persistent_memory` stays optional and cache-backed only.
6. Do not inject full `session_*` artifacts into `<session_memory>`.

### 8.4 TDD steps

Write failing tests first in:

- `src/handlers/event.test.ts`
- `src/handlers/chat.test.ts`
- `src/services/session-executor.test.ts`
- `src/services/session-corpus.test.ts`

Required coverage:

- `session_execute` stores bounded continuity metadata and stats
- `session_batch_execute` aggregates per-item results without raw concatenation
- `session_execute_file` captures file-analysis continuity without raw file dump
- local-first `<session_memory>` still renders with optional cached
  `<persistent_memory>`

### 8.5 Verification commands

```bash
deno test src/handlers/event.test.ts src/handlers/chat.test.ts src/services/session-executor.test.ts src/services/session-corpus.test.ts
deno task check
```

### 8.6 Completion gate

Task 4 is done only when `session_*` activity contributes compact continuity and
measurable local stats without hot-tier raw dumps.

---

## 9. Task 5 — Rewrite `tool.execute.before` / `tool.execute.after` around enforcement + attribution

### 9.1 Goal

Reduce native-tool routing to a secondary enforcement layer that pushes the
model toward `session_*` tools and attributes outcomes cleanly.

### 9.2 Files

**Modify**

- `src/handlers/tool-before.ts`
- `src/handlers/tool-before.test.ts`
- `src/handlers/tool-after.ts`
- `src/handlers/tool-after.test.ts`
- `src/services/tool-routing.ts`
- `src/services/tool-routing.test.ts`
- `src/handlers/event.ts`
- `src/handlers/event.test.ts`

### 9.3 Implementation requirements

1. Keep `session_*` calls simple in `tool.execute.before`:
   - preserve canonical root-session context without injecting public
     `root_session_id` args
   - allow the call to proceed
2. Rewrite native-tool policy so it is explicitly secondary:
   - `WebFetch` -> deny with direct guidance to `session_fetch_and_index`
   - data-heavy `Bash` patterns -> deny or bounded rewrite toward
     `session_execute` / `session_batch_execute`
   - large-analysis `Read` patterns -> guidance toward `session_execute_file`
   - `Grep` / `Glob` remain lightweight helpers, not primary retrieval
   - `Task` guidance must tell delegated agents to prefer `session_*` for
     data-heavy operations
3. `tool.execute.after` must only attach routing/attribution metadata; it must
   not become a second output-rewriting engine.
4. Rework or trim existing native-routing-only logic in
   `src/services/tool-routing.ts` so the success condition is no longer
   “intercept more native tools.”

### 9.4 TDD steps

Write failing tests first in the existing hook/routing test files covering:

- `session_*` calls are allowed with canonical root-session context and without
  caller-supplied `root_session_id`
- `WebFetch` is denied toward `session_fetch_and_index`
- data-heavy `Bash` is routed toward `session_execute`
- `Task` prompt rewriting adds MCP-first routing guidance
- `tool.execute.after` records attribution only

### 9.5 Verification commands

```bash
deno test src/handlers/tool-before.test.ts src/handlers/tool-after.test.ts src/services/tool-routing.test.ts src/handlers/event.test.ts
deno task check
```

### 9.6 Completion gate

Task 5 is done only when hooks clearly serve MCP-first enforcement and
attribution rather than acting as the main product surface.

---

## 10. Task 6 — Extend temporary-root migration and teardown coverage to new MCP local state

### 10.1 Goal

Make temporary-root resolution and runtime re-initialization safe for local
corpora, artifacts, postings, stats, and new MCP runtime resources.

### 10.2 Files

**Modify**

- `src/session.ts`
- `src/session.test.ts`
- `src/index.ts`
- `src/index.test.ts`
- `src/services/session-corpus.ts`
- `src/services/session-corpus.test.ts`
- `src/services/session-mcp-runtime.ts`
- `src/services/session-mcp-runtime.test.ts`

### 10.3 Implementation requirements

1. Extend temporary-root migration in `src/session.ts` so it covers:
   - corpus manifests
   - corpus metadata
   - chunk lists
   - chunk payloads
   - term postings
   - trigram postings
   - artifact metadata and bodies
   - local stats
2. Use a single atomic or pipeline-disciplined migration strategy. Lock it now:
   - use a Redis `MULTI/EXEC` pipeline where key enumeration happens first and
     every rename/copy/delete step for one provisional root is committed as one
     migration unit
   - preserve remaining TTL for each moved key by reading TTL before migration
     and reapplying it after the move when the primitive used does not retain
     expiry automatically
3. After successful migration, remove obsolete provisional-root keys.
4. If migration fails, surface failure and do not silently continue with split
   ownership.
5. Extend `src/index.ts` teardown registration so it disposes:
   - `session-mcp-runtime`
   - any executor worker state
   - any corpus caches
   - any new timers introduced for TTL refresh/cleanup

### 10.4 TDD steps

Write failing tests first in:

- `src/session.test.ts`
- `src/services/session-corpus.test.ts`
- `src/index.test.ts`
- `src/services/session-mcp-runtime.test.ts`

Required coverage:

- temporary-root migration of corpora/stat keys
- parent/child shared root-session corpora after migration
- runtime re-initialization disposes all new MCP-first resources exactly once
- deletion of a child session does not delete root-owned corpora or stats

### 10.5 Verification commands

```bash
deno test src/session.test.ts src/services/session-corpus.test.ts src/index.test.ts src/services/session-mcp-runtime.test.ts
deno task check
```

### 10.6 Completion gate

Task 6 is done only when temporary-root migration covers all new local MCP state
and runtime restart/teardown leaves no duplicate workers, timers, or orphaned
root-local corpus state.

---

## 11. Task 7 — Validate compaction continuity and async Graphiti augmentation remain intact

### 11.1 Goal

Prove that the MCP-first replacement did not break the existing local continuity
and async Graphiti invariants.

### 11.2 Files

**Modify**

- `src/handlers/chat.ts`
- `src/handlers/chat.test.ts`
- `src/handlers/messages.ts`
- `src/handlers/messages.test.ts`
- `src/handlers/compacting.ts`
- `src/handlers/compacting.test.ts`
- `src/handlers/event.ts`
- `src/handlers/event.test.ts`
- `README.md`
- `docs/ContextOverhaul.md`
- `docs/ContextOverhaulTests.md`

### 11.3 Implementation requirements

1. Keep `<session_memory>` local-first:
   - local continuity sections from Redis/FalkorDB
   - `<session_snapshot>` from the local snapshot service
   - optional `<persistent_memory>` from cache only
2. Do not add any synchronous Graphiti dependency to:
   - `chat.message`
   - `experimental.chat.messages.transform`
   - `experimental.session.compacting`
   - `tool.execute.before`
   - `tool.execute.after`
   - synchronous `event` handling
3. Ensure `session_*` activity survives compaction through the same event and
   snapshot model as other continuity events.
4. Update docs:
   - `README.md`: add MCP-first `session_*` overview, local corpus behavior, and
     local-first `<session_memory>` wording
   - `docs/ContextOverhaul.md`: keep historical doc but mark it superseded by
     the replacement architecture and this implementation plan; fix stale
     `plans/...` references to actual `docs/...` paths and normalize any stale
     internal cross-references that still point at pre-move locations
   - `docs/ContextOverhaulTests.md`: mark prior hot-path test plan superseded;
     fix stale path references, normalize any stale internal cross-references,
     and point readers to this implementation plan for the active acceptance
     matrix
   - delete or keep absent
     `docs/superpowers/plans/2026-03-20-context-overhaul-hot-path.md`

### 11.4 TDD steps

Write failing tests first in:

- `src/handlers/chat.test.ts`
- `src/handlers/messages.test.ts`
- `src/handlers/compacting.test.ts`
- `src/handlers/event.test.ts`

Required coverage:

- local-first `<session_memory>` with optional cached `<persistent_memory>`
- compaction continuity still includes session-derived MCP-first events
- Graphiti remains off the hot path for all synchronous hooks

### 11.5 Verification commands

```bash
deno test src/handlers/chat.test.ts src/handlers/messages.test.ts src/handlers/compacting.test.ts src/handlers/event.test.ts
deno task check
```

### 11.6 Completion gate

Task 7 is done only when compaction continuity and async Graphiti augmentation
still behave as before, with `session_*` activity folded into the same local
continuity model.

---

## 12. Migration / Removal Work For Superseded Native-Routing Plan

This cleanup is mandatory and not optional follow-up polish.

### 12.1 Delete or retire

1. Delete `docs/superpowers/plans/2026-03-20-context-overhaul-hot-path.md` if it
   exists anywhere in the active branch.
2. Remove any stale references to that file from docs, tasks, or review notes.

### 12.2 Rewrite and retain

1. Retain `src/services/tool-routing.ts`, but rewrite it as a secondary
   enforcement layer only.
2. Retain `src/handlers/tool-before.ts` and `src/handlers/tool-after.ts`, but
   narrow them to:
   - canonical root-session context handling for `session_*`
   - native fallback enforcement
   - routing attribution metadata
3. Retain `src/session.ts` as lineage authority and extend it for corpus/state
   migration.
4. Retain existing Redis events, snapshots, and Graphiti async services.

### 12.3 Remove old success language

Delete or rewrite any comments, tests, or docs that define success mainly as:

- “native hot-path alignment”
- “80% native routing parity”
- “intercept Read/Bash/WebFetch first, then call it context-mode aligned”

Replace them with MCP-first success language centered on `session_*`.

---

## 13. Required Acceptance Test Matrix

All of the following must exist by the end of implementation.

| Requirement                                                               | Required test location                                                                          |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `session_fetch_and_index`                                                 | `src/services/session-corpus.test.ts`, `src/services/session-mcp-runtime.test.ts`               |
| `session_index`                                                           | `src/services/session-corpus.test.ts`, `src/services/session-mcp-runtime.test.ts`               |
| `session_execute` / `session_batch_execute`                               | `src/services/session-executor.test.ts`, `src/services/session-mcp-runtime.test.ts`             |
| `session_execute_file`                                                    | `src/services/session-executor.test.ts`, `src/services/session-mcp-runtime.test.ts`             |
| `session_search`                                                          | `src/services/session-corpus.test.ts`                                                           |
| parent/child shared root-session corpora                                  | `src/session.test.ts`, `src/services/session-corpus.test.ts`                                    |
| temporary-root migration of corpora/stat keys                             | `src/session.test.ts`, `src/services/session-corpus.test.ts`                                    |
| TTL expiry graceful behavior                                              | `src/services/session-corpus.test.ts`, `src/services/redis-client.test.ts`                      |
| local-first `<session_memory>` with optional cached `<persistent_memory>` | `src/handlers/chat.test.ts`, `src/handlers/messages.test.ts`, `src/handlers/compacting.test.ts` |
| small-corpus relevance baseline                                           | `src/services/session-corpus.test.ts`                                                           |

In addition to the top-level rows above, named coverage for `session_stats` and
`session_doctor` is mandatory in `src/services/session-mcp-runtime.test.ts` and
must verify valid bounded responses backed by local state/health checks rather
than placeholder payloads.

---

## 14. Final Verification Sequence

Run this exact sequence after Task 7.

```bash
deno test src/services/session-mcp-runtime.test.ts src/services/session-corpus.test.ts src/services/session-executor.test.ts src/session.test.ts
deno test src/handlers/tool-before.test.ts src/handlers/tool-after.test.ts src/handlers/chat.test.ts src/handlers/messages.test.ts src/handlers/compacting.test.ts src/handlers/event.test.ts
deno test src/index.test.ts src/services/tool-routing.test.ts src/services/redis-client.test.ts
deno test
deno task check
deno task lint
deno fmt --check
```

Do not mark the milestone complete if any command above fails.

---

## 15. Out of Scope For This Milestone

The implementation must not expand into any of the following:

- `session_upgrade`
- SQLite / FTS5 / BM25 adoption
- Graphiti on the hot path
- project-wide or cross-session local corpora beyond the canonical root session
- child-session-only corpus namespaces
- remote execution backends, containers, or Docker orchestration for
  `session_execute*`
- semantic/vector search for local corpora
- undocumented OpenCode APIs or private plugin internals
- UI work, telemetry pipelines, or non-test benchmarking infrastructure

---

## 16. Definition of Done

This milestone is done only when all seven ordered tasks are complete and all of
the following are true:

1. `session_*` tools are the primary bounded execution and retrieval surface.
2. Local Redis/FalkorDB corpora and search work without Graphiti.
3. Parent and child sessions share one canonical root-session corpus.
4. Temporary-root migration covers corpus/artifact/stat state.
5. Hook logic is clearly secondary enforcement + attribution.
6. `<session_memory>` remains local-first with optional cached
   `<persistent_memory>`.
7. Async Graphiti augmentation remains intact and off the hot path.
8. The superseded hot-path implementation plan file is deleted or verified
   absent, and stale references are removed.
