# Context-Mode-Aligned MCP-First Replacement Plan

**Status:** Completed\
**Date:** 2026-03-20\
**Supersedes:** `plans/ContextOverhaul.md` and any in-progress Task 1 / Task 2
work derived from that native-hook-first plan\
**Grounding sources:** `AGENTS.md`, `README.md`, `src/index.ts`,
`src/session.ts`, `plans/ContextOverhaul.md`, `plans/ContextOverhaulTests.md`,
and the public `mksglu/context-mode` README already established for this session

---

## 1. Executive Decision

This document **replaces**, not extends, the current
`tool.execute.before`-centric native-routing plan.

The prior plan drifted from the actual target in one decisive way: it treated
**native tool interception** as the product architecture, while `context-mode`
is fundamentally an **MCP-first system** where dedicated tools are the primary
execution surface and hooks exist to enforce that preference, capture
continuity, and preserve state across compaction.

That drift produced the wrong center of gravity:

- it optimized how native OpenCode tools should be blocked or rewritten
- it did **not** define a first-class `session_*` MCP tool surface analogous to
  `context-mode`
- it risked making this repository a smarter native-tool filter instead of a
  local session-runtime with its own bounded execution and local retrieval path

This plan corrects that. The architecture target is now:

1. **MCP-first execution** through `session_*` tools
2. **Redis/FalkorDB hot-path persistence** instead of SQLite/FTS5
3. **Canonical root-session participation** for parent and child sessions alike
4. **Async Graphiti consolidation** that augments `<session_memory>` with cached
   `<persistent_memory>` and never blocks the hot path

---

## 2. Replacement Scope

### 2.1 In scope

- define the MCP-first architecture for this repository
- define the `session_*` tool suite and each tool's contract-level role
- define the Redis/FalkorDB local indexing and search design
- define the plugin/hook role as enforcement + continuity only
- define child-session behavior for both continuity and MCP-tool activity
- define TTL rules for all non-Graphiti Redis/FalkorDB state
- define Graphiti's async role after the local hot path
- define migration/replacement rules for current native-routing work
- define measurable validation criteria tied to MCP-first behavior

### 2.2 Explicitly not in scope

- copying `context-mode`'s SQLite storage, FTS5 schema, or `ctx_*` naming
- moving Graphiti onto the hot path
- flattening child sessions into summarized tool events
- turning hooks into the primary execution system
- introducing undocumented OpenCode capabilities beyond the documented plugin
  hooks already used in this repo
- implementing an auto-upgrade workflow in this phase (`session_upgrade` is out
  of scope)
- storing non-Graphiti session data indefinitely in Redis/FalkorDB

---

## 3. Architecture Decision Summary

### 3.1 Primary architectural split

| Layer                      | Owns                                                                                                                                                         | Must not own                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **`session_*` MCP server** | bounded execution, file processing, fetch+index, local indexing, local search, utility diagnostics/stats                                                     | compaction injection, session lineage resolution via OpenCode parent chain, Graphiti hot-path reads |
| **OpenCode plugin hooks**  | root-session canonicalization, native-tool enforcement, continuity event capture, snapshot assembly, `<session_memory>` injection, async Graphiti scheduling | primary execution semantics, large-result processing, long-lived search/index ranking state         |
| **Async Graphiti tier**    | background semantic consolidation and cached `<persistent_memory>` refresh                                                                                   | any synchronous hook-time dependency                                                                |

### 3.2 Required execution model

1. The model should prefer `session_*` tools for data-heavy work.
2. The MCP server should keep raw data local and return bounded results.
3. The plugin should enforce the preference when the model falls back to risky
   native tools.
4. The plugin should continue to build and inject deterministic
   `<session_memory>` from local Redis/FalkorDB state.
5. Graphiti should remain a later, asynchronous enhancer.

This is the canonical target. Any implementation choice that recenters the
system on native tool routing is out of compliance with this plan.

### 3.3 MCP server lifecycle and transport default

The default for OpenCode is locked:

- the `session_*` MCP server/runtime must run **in process**, owned by the same
  plugin runtime that owns the hooks
- MCP tool handlers and hooks must therefore share the same canonical
  root-session identity source, teardown discipline, and process-local caches
- a separate out-of-process MCP transport is **not** the default for this repo
  and must not be assumed in the first implementation plan

Rationale:

- `src/index.ts` already centralizes runtime initialization and teardown
- `src/session.ts` already centralizes canonical root-session identity
- the approved hardening goal is to avoid split-brain lifecycle handling between
  tool runtime and hook runtime

If a later plan proposes a different transport boundary, it must justify how it
preserves shared root identity, shared teardown, and non-divergent cache/state
behavior. That justification is out of scope here.

---

## 4. MCP-First Runtime Model

```text
OpenCode session
  |
  |- Model chooses tools
  |    |- preferred path: session_* MCP tools
  |    '- fallback path: native tools (plugin may allow, redirect, or deny)
  |
  |- session_* MCP server
  |    |- session_execute / session_execute_file / session_batch_execute
  |    |- session_index / session_search / session_fetch_and_index
  |    '- session_stats / session_doctor
  |
  |- Redis/FalkorDB hot tier
  |    |- session events
  |    |- snapshots
  |    |- local indexed corpora + chunk postings
  |    |- execution/search stats
  |    '- pending Graphiti drain state
  |
  |- OpenCode plugin hooks
  |    |- canonical root-session identity
  |    |- continuity extraction + injection
  |    '- native-tool enforcement toward session_*
  |
  '- Graphiti async tier
       |- consolidate selected local events in background
       '- refresh cached persistent memory for later injection
```

### 4.1 Default behavioral rule

When a task would otherwise dump large raw output into the transcript, the
correct path is:

1. use a `session_*` MCP tool
2. store or index the full local artifact in Redis/FalkorDB
3. return only a bounded summary/snippet/handle to the model

The plugin exists to keep the system on that path; it is not the path itself.

### 4.2 Runtime resources that must join teardown discipline

Any new MCP-first runtime component must join the same teardown/cleanup
discipline already visible in `src/index.ts`.

The follow-on implementation must register cleanup for all of these resources if
they exist:

1. in-process `session_*` MCP server/runtime registration
2. local indexing workers or task queues
3. fetch/normalize/index pipelines for `session_fetch_and_index`
4. chunking or artifact-processing pipelines for `session_execute_file`
5. bounded execution worker pools or subprocess supervisors for
   `session_execute` / `session_batch_execute`
6. any in-memory corpus/query caches used by the MCP runtime
7. any per-session search candidate caches or snippet caches
8. any local timers/background loops for corpus cleanup, TTL refresh, or
   deferred indexing
9. existing Graphiti async flush/dispose resources
10. Redis client / connection resources already owned by the runtime

No new background worker, queue, cache, or timer may be introduced without an
explicit teardown path.

### 4.3 How models discover and prefer `session_*` tools in OpenCode

The default discovery/preference stack is also locked:

1. `session_*` tools are registered as MCP tools and are visible to the model as
   first-class tool choices
2. project `AGENTS.md` guidance must teach the model to prefer `session_*` tools
   for data-heavy work
3. plugin-side guidance/enforcement in `tool.execute.before` remains active as a
   fallback when the model attempts risky native tools instead

OpenCode preference therefore comes from **all three** layers together:

- MCP registration makes the tools available
- `AGENTS.md` teaches the preference early
- hook enforcement keeps the session on the bounded path when the model drifts

The implementation must not assume MCP registration alone is sufficient, and it
must not rely on hook enforcement alone as the primary discovery mechanism.

---

## 5. `session_*` Tool Suite

All new MCP tools must use the `session_*` prefix. `ctx_*` naming is forbidden
in this repository.

### 5.1 Tool suite and exact role

| Tool                      | Role                                                                    | Primary inputs                                  | Primary outputs                                              | Notes                                                                       |
| ------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `session_execute`         | Run one bounded sandbox execution task                                  | command/script, runtime, intent, timeout        | bounded result, summary, optional artifact/index handle      | canonical root session resolves implicitly from runtime context             |
| `session_execute_file`    | Run one bounded sandbox file-processing task                            | path(s), processing intent, runtime/handler     | findings, summary, optional artifact/index handle            | canonical root session resolves implicitly from runtime context             |
| `session_batch_execute`   | Combine multiple execute/search sub-operations into one call            | list of execute/search/file subrequests         | bounded multi-result response + handles                      | sequential in v1; no hidden parallelism; canonical root resolves implicitly |
| `session_index`           | Normalize and locally index supplied content into the hot-tier corpus   | content or pre-normalized text, source metadata | corpus id, chunk count, query hints                          | local-only indexing; no Graphiti involvement                                |
| `session_search`          | Query the local indexed corpus for the canonical root session           | query or query list, optional corpus filters    | ranked bounded snippets + corpus/chunk refs                  | searches only local session-scoped indexed data                             |
| `session_fetch_and_index` | Fetch a URL in sandbox, normalize it, then index it locally             | url, fetch options, content-type hint           | corpus id, summary, query hints                              | primary replacement for native `WebFetch`                                   |
| `session_stats`           | Show local context-savings and tool/index activity for the root session | optional scope                                  | counters, byte ratios, corpus counts, queue depth            | in scope                                                                    |
| `session_doctor`          | Diagnose MCP/plugin/hot-tier health                                     | optional checks                                 | health report for Redis, hooks, cache, Graphiti connectivity | in scope                                                                    |

### 5.2 Scope decision for `session_upgrade`

`session_upgrade` is **out of scope** for this replacement plan.

Reason:

- the replacement goal is architectural correctness, not self-update mechanics
- this repository's current documented scope is memory continuity + async
  Graphiti integration, not installer/update orchestration
- adding upgrade behavior now would broaden scope before the MCP-first runtime
  is stable

The implementation may reserve the name, but it must not be part of the first
replacement milestone, the validation bar, or the migration work.

### 5.3 Tool behavior defaults

The following defaults are mandatory unless later superseded by a narrower
implementation plan:

1. Every public `session_*` tool request resolves the canonical root session
   implicitly from runtime context; callers must not pass `root_session_id`.
2. In OpenCode, the plugin/runtime must preserve canonical root-session context
   for every `session_*` call using canonical root-session resolution from
   `src/session.ts`, without mutating the public request contract to require
   `root_session_id`.
3. `session_*` tools are session-scoped by default; they do not create
   indefinite project-wide local corpora.
4. If a full result exceeds the bounded response budget, the tool must
   store/index the full artifact locally and return only:
   - a concise summary
   - a handle/corpus reference
   - suggested follow-up queries or next actions
5. `session_search` must return snippets and references, not full stored
   documents.

### 5.4 Default semantics for `session_batch_execute`

`session_batch_execute` must behave deterministically in v1.

Locked defaults:

1. sub-operations execute **sequentially** in request order
2. there is **no hidden parallelism** in v1
3. each sub-operation returns its own status (`ok`, `error`, or `skipped`)
4. later sub-operations may continue after an earlier error unless the request
   explicitly asks for fail-fast behavior in a future version; fail-fast is not
   the default in this plan
5. the tool returns a bounded **combined** response plus per-item references,
   not full raw outputs concatenated together
6. if any sub-operation produces a large artifact, the artifact is
   stored/indexed locally and represented in the combined response by a summary
   and reference

This default is chosen to keep execution understandable, auditable, and easy to
test while the MCP-first runtime is being established.

---

## 6. Local Indexing and Search on Redis/FalkorDB

## 6.1 Storage decision

This repository must **not** reproduce `context-mode`'s SQLite/FTS5 layer.

Instead, local indexing/search must run on the already-documented Redis/FalkorDB
hot tier used by this repo's short-term memory system. The implementation must
rely on Redis-compatible primitives that are already consistent with the
existing repository architecture. It must **not** assume RediSearch, SQLite
FTS5, or undocumented FalkorDB full-text features.

### 6.2 Responsibility split

| Concern                                 | Responsibility                                              |
| --------------------------------------- | ----------------------------------------------------------- |
| text normalization                      | MCP server                                                  |
| chunking                                | MCP server                                                  |
| postings/materialized search structures | Redis/FalkorDB hot tier                                     |
| ranking                                 | MCP server process using Redis/FalkorDB candidate retrieval |
| continuity injection                    | plugin, not the MCP server                                  |
| long-term semantic memory               | Graphiti async tier, not local search                       |

### 6.3 Corpus scope

Local indexed corpora are scoped to the **canonical root session** and the
project `groupId` already used by the plugin.

Default namespace:

`groupId + root_session_id`

Concrete default key prefix for implementation:

`session:{groupId}:{root}:...`

Any later shorthand that omits `{groupId}` is documentation shorthand only and
must not be implemented as a bare root-only namespace.

That scope is mandatory because:

- the repo already centers continuity on canonical root-session identity
- child sessions are intentionally first-class participants in the same
  workstream
- Graphiti, not Redis/FalkorDB, is responsible for cross-session persistence
- TTL-based cleanup is required to avoid hoarding prior sessions

### 6.4 Required index structures

The local index must store, at minimum:

| Key family                                            | Purpose                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `session:{groupId}:{root}:corpora`                    | corpus manifest set/list for the root session                             |
| `session:{groupId}:{root}:corpus:{corpusId}:meta`     | corpus metadata: source, title, created/updated time, chunk count, format |
| `session:{groupId}:{root}:corpus:{corpusId}:chunks`   | ordered chunk references                                                  |
| `session:{groupId}:{root}:chunk:{chunkId}`            | chunk payload + heading/title/order metadata                              |
| `session:{groupId}:{root}:term:{token}`               | token-retrieval posting set of chunk ids containing a normalized token    |
| `session:{groupId}:{root}:tri:{trigram}`              | trigram-retrieval posting set for substring matching                      |
| `session:{groupId}:{root}:artifact:{artifactId}:meta` | canonical artifact metadata                                               |
| `session:{groupId}:{root}:artifact:{artifactId}:body` | canonical artifact body                                                   |
| `session:{groupId}:{root}:stats`                      | local execution/index/search counters and byte totals                     |

This plan intentionally chooses Redis-compatible sets/hashes/lists and
application-side ranking, because those are compatible with the repository's
current documented storage model.

### 6.5 Chunking rules

To stay close to `context-mode` without copying SQLite mechanics, chunking must
follow these defaults:

1. **Markdown / HTML-normalized content**: heading-aware chunks; preserve code
   blocks with their nearest heading.
2. **HTML fetches**: normalize into a markdown-oriented or markdown-equivalent
   text form before chunking; simple tag stripping is not sufficient for the
   target architecture because it loses heading/section structure that
   `context-mode` relies on for navigational retrieval.
3. **Plain text / logs**: fixed-size windows with overlap.
4. **JSON**: normalized pretty text or selected-path projections before
   chunking; do not index raw minified blobs unchanged.
5. **Execution outputs**: store the full artifact locally, index either the
   normalized full text or a derived searchable text representation, and return
   only the bounded surface response.

Required implementation discipline:

- fenced code blocks must survive chunking as intact units associated with the
  nearest heading/section context
- heading/title structure must remain query-visible after normalization
- fetched HTML must not degrade into one flat whitespace-collapsed blob before
  indexing
- HTML normalization must preserve at minimum headings, paragraph/section
  boundaries, ordered/unordered list boundaries, and pre/code blocks in the
  markdown-oriented intermediate form
- if a fenced code block would cross a chunk boundary, it becomes its own atomic
  chunk tied to the nearest heading rather than being split by the plain-text
  windowing pass

### 6.6 Search algorithm defaults

The local search path must be deterministic and implemented in process.

Required ranking flow:

1. normalize query text
2. apply stemming to normalized query tokens with a porter-equivalent stemming
   pass so inflected token forms can retrieve the same indexed concept family
3. if exact/stem retrieval would otherwise miss the intended target, apply fuzzy
   correction before or alongside a retry/expansion pass for typo-tolerant
   recovery
4. collect token/stem candidates from `term:*` postings
5. if token/stem recall is sparse, add trigram candidates from `tri:*`
6. rank each retrieval strategy independently in process:
   - token/stem strategy uses an in-process BM25-style score over local postings
   - trigram strategy uses substring-match scoring with lower base weight than
     token/stem results
7. fuse the ranked lists with Reciprocal Rank Fusion (RRF)
8. apply proximity reranking for multi-term queries so chunks where terms appear
   close together outrank chunks where the same terms are widely separated
9. return bounded snippets around the matched region plus refs

To stay closer to `context-mode` feature behavior, the implementation must also:

- keep token matching and trigram matching as two distinct retrieval strategies
  whose evidence is combined during ranking rather than treating trigram hits as
  an undifferentiated append-only fallback
- keep the retrieval phases distinct as well: collect token candidates first,
  and add trigram candidates only when token recall is sparse or when a
  partial-string query explicitly needs substring recovery
- include a porter-equivalent stemming stage in both indexing and/or query
  normalization so singular/plural/inflected forms are not treated as unrelated
  terms
- implement BM25-style scoring in process over Redis/FalkorDB postings rather
  than dropping BM25 parity entirely; the divergence from `context-mode` is the
  storage engine, not the retrieval feature target
- use Reciprocal Rank Fusion (RRF) to merge token/stem and trigram ranked lists
- include fuzzy correction for misspelled queries before failing closed on local
  retrieval
- apply proximity reranking for multi-term queries after the base ranked lists
  are fused
- expose deterministic query behavior for partial-string lookups that mimics the
  practical role of `context-mode`'s porter+trigram pairing, even though BM25
  and porter stemming are not available as built-in Redis/FalkorDB database
  features
- bias snippet extraction around matched query regions, not first-chunk text

### 6.7 Known limitations versus `context-mode`

This design deliberately accepts these differences from `context-mode`:

| Area                 | `context-mode`                                              | This plan                                                  |
| -------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| local DB             | SQLite                                                      | Redis/FalkorDB via Redis protocol                          |
| full-text engine     | FTS5 with BM25 and tokenizer support                        | application-side BM25-style scoring over Redis postings    |
| stemming             | documented Porter stemming                                  | application-side porter-equivalent stemming                |
| ranking fusion       | FTS5/trigram/RRF stack                                      | application-side token/stem + trigram + RRF stack          |
| fuzzy correction     | Levenshtein-based retry/correction                          | application-side fuzzy correction before/alongside retry   |
| ranking depth        | DB-native full-text scoring + proximity reranking           | bounded candidate scoring in process + proximity reranking |
| persistence lifetime | local DB survives until session lifecycle policy deletes it | TTL-governed Redis/FalkorDB state                          |

The intended feature target is therefore closer to `context-mode` than the
earlier draft: the storage engine diverges, but the retrieval feature set should
still include BM25-style ranking, porter-equivalent stemming, trigram matching,
RRF fusion, fuzzy correction, and proximity reranking. These features must be
documented and tested, not hidden.

### 6.8 Pitfalls specific to Redis/FalkorDB indexing

Implementers must treat these as design constraints, not optional warnings:

1. **No FTS5 assumptions** — no SQL ranking clauses, tokenizer extensions, or
   BM25 dependency may leak into the design.
2. **Key explosion risk** — token/trigram postings can multiply quickly; chunk
   sizes and TTLs must be conservative.
3. **TTL coherence risk** — corpus manifests, chunk payloads, and postings must
   expire together or be refreshed together.
4. **Large-artifact duplication risk** — store one canonical artifact
   representation and derive index text from it; do not keep multiple full
   copies.
5. **Ranking drift risk** — bounded in-process ranking will be simpler than
   BM25; tests must measure useful retrieval behavior explicitly.
6. **HTML-structure loss risk** — if normalization destroys heading/section
   structure, retrieval quality will drift too far from `context-mode`'s actual
   navigational behavior.
7. **Test-only parity illusion** — corpus/search behavior must be wired into the
   real in-process runtime, not only exercised through test-only dependency
   injection, or the implementation will falsely appear context-mode-aligned
   while production remains stubbed.
8. **Feature-parity erosion risk** — if BM25-style scoring, porter-equivalent
   stemming, trigram fusion, fuzzy correction, or proximity reranking are
   quietly dropped, the system will only superficially resemble `context-mode`.

Required default for artifact indexing:

- store exactly one canonical full artifact body under the artifact key family
- derive searchable text/chunks from that canonical body during indexing, but do
  not persist a second redundant full-body copy as the chunk payload set

### 6.9 Minimum search relevance baseline

The implementation plan must include at least one small-corpus relevance test
for `session_search` with a fully known expected ordering.

Required baseline:

1. index a three-document corpus under one canonical root session:
   - doc A titled `Redis Session TTLs` containing repeated terms about session
     TTLs and expiration
   - doc B titled `Graphiti Async Drain` containing Graphiti drain/retry text
   - doc C titled `Child Session Canonicalization` containing parent/root/child
     lineage text
2. query `session ttl`
3. expected result: doc A must rank first
4. expected result: returned snippet for doc A must include both `session` and
   `TTL`/`ttls` in the snippet window
5. expected result: doc B and doc C may appear after doc A, but neither may rank
   above doc A

This baseline is intentionally small and mechanical. It does not claim semantic
search quality; it verifies that exact-term and title-weighted retrieval behave
as designed.

Additional required retrieval-parity checks for the follow-on implementation
plan:

1. stemming behavior: a query using an inflected form still retrieves the same
   intended document family
2. partial-string behavior: a substring query can retrieve the intended chunk
   through trigram matching
3. typo behavior: a misspelled query is corrected or retried through fuzzy
   matching and still surfaces the intended result
4. multi-term proximity behavior: a chunk where terms appear close together
   ranks above one where the same terms are far apart
5. rank-fusion behavior: token/stem and trigram result lists are merged through
   RRF rather than one list blindly overwriting the other

---

## 7. OpenCode Hook Model in the MCP-First Architecture

The hooks remain important, but their role changes from “primary routing
architecture” to “enforcement + continuity around the MCP-first runtime.”

### 7.1 Hook responsibilities

| Hook                                   | Required role in the new model                                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool.execute.before`                  | preserve canonical root-session context for `session_*` calls and enforce fallback from risky native tools toward `session_*`; never become the main execution engine |
| `tool.execute.after`                   | capture bounded tool events, context-savings stats, artifact refs, and routing outcomes; never rewrite large raw output after the fact as the primary mechanism       |
| `chat.message`                         | assemble local `<session_memory>` from events, snapshot, and cached persistent memory; schedule async refresh decisions only                                          |
| `experimental.chat.messages.transform` | prepend the prepared `<session_memory>` envelope to the last user message                                                                                             |
| `experimental.session.compacting`      | inject the same prepared local continuity envelope into compaction                                                                                                    |
| `event`                                | capture user/assistant/session lifecycle events, maintain canonical root-session lineage state, schedule snapshot rebuilds and async Graphiti drain                   |

### 7.2 Hook interaction sequence

```text
1. chat.message
   -> load canonical root-session local state
   -> prepare <session_memory>

2. experimental.chat.messages.transform
   -> inject <session_memory> into the user message

3. tool call selected by the model
   a. tool.execute.before
      - if tool is session_*: route using canonical session context and allow
      - if tool is risky native fallback: redirect/deny toward session_*
      - if tool is safe bounded native fallback: allow
   b. tool runs
   c. tool.execute.after
      - record bounded event and stats only
   d. event hook(s)
      - persist compact continuity event under canonical root session

4. session.idle / session.compacted events
   -> rebuild snapshot locally
   -> flush eligible Graphiti drain work asynchronously
```

### 7.3 Enforcement defaults for native OpenCode tools

To stay close to `context-mode` while remaining MCP-first, the defaults are:

| Native tool     | Enforcement default                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `WebFetch`      | deny and direct to `session_fetch_and_index`                                                                                               |
| `Bash`          | allow ordinary bounded shell use; deny or rewrite data-heavy/network/raw-dump patterns toward `session_execute` or `session_batch_execute` |
| `Read`          | allow bounded file inspection; direct large/analysis-oriented use toward `session_execute_file`                                            |
| `Grep` / `Glob` | allow as lightweight native helpers; do not make them the primary retrieval path when `session_index` / `session_search` is the better fit |
| `Task`          | preserve child-session behavior, but append routing guidance so delegated agents prefer `session_*` tools                                  |

This is a **secondary enforcement layer**. The success criteria for the system
are no longer “how many native tools were intercepted,” but “whether data-heavy
work primarily flows through `session_*` tools.”

### 7.4 OpenCode-specific root identity rule

`src/session.ts` already makes canonical root-session identity the core
continuity concept. The new architecture must reuse that logic.

Rule:

- the plugin is authoritative for canonical root-session identity in OpenCode
- `tool.execute.before` / runtime wiring must preserve canonical root-session
  context for all `session_*` tool calls without exposing `root_session_id` as a
  required public request field
- `tool.execute.after` and `event` must attribute all resulting continuity
  events, stats, corpora, and artifacts to that same canonical root session

The MCP server must not invent a competing lineage model.

### 7.5 Existing in-memory routing caches under the new architecture

The current in-memory `ToolGuidanceCache` and `ToolRoutingOutcomeCache` remain
process-local enforcement-layer caches.

Locked behavior:

1. they stay **in memory only** in v1
2. they are not promoted to Redis/FalkorDB durable state
3. they continue to be keyed by canonical root-session lineage where applicable
4. they must be cleared naturally on plugin runtime re-initialization/teardown
5. they are advisory/enforcement helpers only; no continuity-critical behavior
   may depend on them surviving restart

Their role narrows under this architecture:

- `ToolGuidanceCache` throttles repeated native-tool fallback guidance
- `ToolRoutingOutcomeCache` tracks transient routing outcomes for tool-lifecycle
  handling

Neither cache is allowed to become a second durable session-state system.

---

## 8. Child Sessions as First-Class Participants

This repository keeps its intentional divergence from `context-mode`: child
sessions are not reduced to opaque summarized tool invocations. They are
first-class contributors to the canonical root session.

### 8.1 Mandatory behavior

1. Child and parent sessions share one canonical root session identity.
2. Child-created `session_*` corpora, execution artifacts, and stats are stored
   under the root session namespace.
3. Child-origin events continue to appear in the same event log and snapshot
   stream used by the parent.
4. Future parent or child `<session_memory>` injections reflect the combined
   lineage state.
5. Deleting a child session must not delete root-owned corpora, events,
   snapshots, or cached local index state.

### 8.2 Temporary-root handling

`src/session.ts` already contains temporary-root behavior for sessions whose
lineage is not yet resolved. The replacement architecture must preserve one
rule:

- if a child session temporarily behaves like a root and later resolves to an
  actual parent, all runtime state and local MCP artifacts created during the
  temporary-root phase must migrate to the canonical root session namespace
  exactly once

This includes:

- in-memory session state
- assistant buffers
- guidance/routing state
- local corpus manifests
- chunk keys/postings
- per-session stats

If this migration is not exact, the implementation will leak or orphan indexed
artifacts and break root-session continuity.

Required Redis/FalkorDB migration behavior for temporary-root resolution:

1. the implementation must migrate the full local key family from provisional
   root namespace to canonical root namespace, including:
   - `session:{root}:corpora`
   - `session:{root}:corpus:{corpusId}:meta`
   - `session:{root}:corpus:{corpusId}:chunks`
   - `session:{root}:chunk:{chunkId}`
   - `session:{root}:term:{token}`
   - `session:{root}:tri:{trigram}`
   - `session:{root}:stats`
   - any future artifact-manifest keys created for bounded execution outputs
2. migration must preserve existing TTL semantics for the moved data; it must
   not silently reset indefinite lifetimes or strip expiry from migrated keys
3. the follow-on implementation must use **atomic or pipeline-based migration**
   so partial moves cannot leave postings, chunks, or manifests split across old
   and new roots
4. after successful migration, the obsolete provisional-root key family must be
   removed
5. if migration fails partway, the implementation must fail in a way that avoids
   partial ownership ambiguity; it must not continue as though migration fully
   succeeded

The implementation plan must name the exact migration strategy it chooses
(`MULTI/EXEC`, Lua/scripted move, or an equivalent pipeline discipline) and must
justify how TTL preservation is guaranteed.

### 8.3 Delegation rule for `Task`

When the agent delegates work through `Task`, the plugin must append guidance
that child work remains inside the same canonical continuity model and should
prefer `session_*` tools for data-heavy operations. The implementation must not
create a second “child-local” MCP corpus model.

---

## 9. TTL Strategy for All Non-Graphiti Redis/FalkorDB State

All non-Graphiti data stored in Redis/FalkorDB must have TTLs. This is
mandatory.

### 9.1 TTL categories and defaults

| State category                                                           | Default TTL                                                                                | Rationale                                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| session events (`session:{id}:events`)                                   | `redis.sessionTtlSeconds` (default 24h)                                                    | current-session continuity should survive compaction and short idle periods, not become indefinite history |
| root snapshots                                                           | `2 * redis.sessionTtlSeconds` (default 48h)                                                | matches existing snapshot-retention posture and gives compaction recovery more headroom than event lists   |
| local MCP corpora manifests/chunks/postings/artifacts                    | `redis.sessionTtlSeconds` (default 24h) refreshed on write and on successful search/access | session-scoped local knowledge should expire with the workstream                                           |
| lineage maps / canonical session bookkeeping mirrored in Redis, if added | `2 * redis.sessionTtlSeconds` (default 48h)                                                | root resolution must outlive brief child churn and compaction windows                                      |
| local stats and counters                                                 | `redis.sessionTtlSeconds` (default 24h)                                                    | useful during active work only                                                                             |
| Graphiti cache (`memory-cache:*`)                                        | `redis.cacheTtlSeconds` (default 10m)                                                      | already documented as cached persistent-memory projection                                                  |
| Graphiti cache metadata                                                  | `redis.cacheTtlSeconds` (default 10m)                                                      | must expire with the cache body                                                                            |
| pending drain batches                                                    | `3 * redis.sessionTtlSeconds` (default 72h)                                                | retries and delayed Graphiti recovery need more time than active session memory                            |
| dead-letter drain entries                                                | `3 * redis.sessionTtlSeconds` (default 72h)                                                | enough time for inspection without indefinite retention                                                    |

### 9.2 TTL invariants

1. Related local-index keys must be expired together.
2. A search hit on a local corpus may refresh that corpus family TTL, but only
   within the root-session namespace.
3. No non-Graphiti key family may be created without an explicit TTL assignment.
4. If TTL expiry removes session-local corpora, the system must degrade
   gracefully by returning “not found / expired” rather than an error cascade.

---

## 10. Async Graphiti Integration After the Local Hot Path

Graphiti remains an enhancer, not a dependency.

### 10.1 Fixed role

Graphiti continues to do exactly these jobs:

1. receive selected semantic episodes from the local event stream in the
   background
2. refresh cached persistent-memory projections in Redis
3. provide later-turn `<persistent_memory>` augmentation inside
   `<session_memory>`

Graphiti must not do any of these jobs:

- answer current-turn local search requests
- block `session_*` tool execution
- block `chat.message`, `messages.transform`, `session.compacting`, `event`, or
  tool hooks
- become the local index for fetched pages, file processing, or command outputs

### 10.2 Required integration sequence

```text
session_* or native tool activity
  -> compact continuity event written locally
  -> eligible events queued for async Graphiti drain
  -> snapshot rebuilt locally on idle/compaction
  -> Graphiti drain runs later
  -> Graphiti cache refresh updates Redis cache
  -> next turn may include refreshed <persistent_memory>
```

### 10.3 `<session_memory>` contract remains local-first

The injected envelope remains local-first and deterministic:

```xml
<session_memory source="graphiti" version="1">
  ...local continuity sections...
  <session_snapshot>...</session_snapshot>
  <persistent_memory node_refs="...">...</persistent_memory>
</session_memory>
```

Rules:

1. local continuity sections and snapshot come from Redis/FalkorDB hot-tier
   state
2. `<persistent_memory>` is optional and cache-backed only
3. absence or staleness of Graphiti data must never prevent injection of the
   rest of `<session_memory>`

---

## 11. Migration and Replacement Strategy for Current Native-Routing Work

This section is normative. It tells implementers what to keep, rewrite, and
remove from the current workstream.

### 11.1 Keep and reuse

These existing capabilities remain aligned and should be retained:

- `SessionManager` root-session canonicalization and parent-chain handling in
  `src/session.ts`
- temporary-root migration mechanics, expanded to include MCP local-index state
- current `<session_memory>` assembly model and transform/compaction injection
  flow
- Redis-backed events, snapshots, and cached persistent-memory services
- async Graphiti drain/cache architecture and the “Graphiti off the hot path”
  invariant
- runtime teardown orchestration in `src/index.ts`

### 11.2 Rewrite

These parts must be rewritten around the MCP-first design:

- `tool.execute.before` logic: it must become `session_*` argument injection +
  native fallback enforcement, not the primary product architecture
- `tool.execute.after` logic: it must focus on bounded event capture, stats, and
  artifact refs for both native and `session_*` calls
- any routing policy or documentation that defines success mainly in terms of
  intercepting native `Read`/`Bash`/`WebFetch`
- any in-progress task text that frames the target as “80% native hot-path
  alignment” rather than “context-mode-style MCP-first bounded execution plus
  continuity”

### 11.3 Remove

The following target assumptions from the prior plan must be removed outright:

1. that the main implementation milestone is a deterministic native-tool routing
   engine
2. that the architecture can be considered context-mode-aligned without a
   first-class `session_*` MCP surface
3. that local search/indexing can be deferred while still claiming close
   mechanism parity with `context-mode`
4. that hook-time blocking alone is enough to replace `context-mode`'s sandbox
   tool model

### 11.4 Task 1 / Task 2 replacement rules

| Current workstream item                    | Action under this plan                                                                                                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task 1 native-routing contract/policy work | cancel as the main deliverable; salvage only generic utilities that remain useful for enforcement, canonical session lookup, and concise guidance                          |
| Task 2 pre-tool hook wiring                | rewrite so hook wiring serves `session_*` root-session injection and native fallback enforcement; do not continue expanding native-tool policy as the center of the system |

### 11.5 File-level migration guidance

| File / area                                                                                               | Migration directive                                                                                                           |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                                                                            | keep runtime/service wiring pattern; add MCP-first services and ensure teardown also covers new local-index/runtime resources |
| `src/session.ts`                                                                                          | keep canonical lineage ownership; extend migration and cleanup rules to MCP corpora/artifacts/stats                           |
| `src/handlers/chat.ts`, `src/handlers/messages.ts`, `src/handlers/compacting.ts`, `src/handlers/event.ts` | preserve continuity role; add any new local-index-derived metadata only if it remains compact and deterministic               |
| `src/handlers/tool-before.ts`                                                                             | rewrite around `session_*` argument injection and native fallback enforcement                                                 |
| `src/handlers/tool-after.ts`                                                                              | rewrite around bounded event capture, stats, and artifact refs                                                                |
| any new native-tool policy module created for the prior plan                                              | either delete or reduce to the minimal enforcement layer required to push work toward `session_*`                             |

### 11.6 Documentation supersession requirements

The old plan must be explicitly marked superseded in repository documentation.

Minimum requirement:

1. `plans/ContextOverhaul.md` must carry a factual superseded status/header that
   points to this replacement plan
2. future implementation planning/docs must refer to this replacement plan as
   the controlling architecture document for MCP-first work
3. no new task list or milestone text may describe `plans/ContextOverhaul.md` as
   the active target architecture

---

## 12. Validation and Acceptance Criteria

Success must now be measured against MCP-first behavior, not against
native-routing sophistication.

### 12.1 Acceptance criteria

| ID  | Criterion                                    | Pass condition                                                                                                                                                                                         |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | `session_*` tool surface exists              | `session_batch_execute`, `session_execute`, `session_execute_file`, `session_index`, `session_search`, `session_fetch_and_index`, `session_stats`, and `session_doctor` are implemented and registered |
| A2  | MCP-first path is primary                    | representative data-heavy tasks use `session_*` tools without raw payloads entering the transcript                                                                                                     |
| A3  | Native enforcement is secondary              | hook logic exists, but core success does not depend on native-tool-only workflows                                                                                                                      |
| A4  | Root-session identity is unified             | parent and child `session_*` tool calls store corpora, events, and stats under the same canonical root session                                                                                         |
| A5  | Local indexing/search works without Graphiti | indexed fetch/file/command outputs are retrievable via `session_search` while Graphiti is offline                                                                                                      |
| A6  | TTL discipline is complete                   | every non-Graphiti Redis/FalkorDB key family created by the new architecture has an explicit TTL                                                                                                       |
| A7  | Hot path remains local                       | no Graphiti call is required during `tool.execute.before`, `tool.execute.after`, `chat.message`, `messages.transform`, `session.compacting`, or synchronous `event` handling                           |
| A8  | `<session_memory>` remains deterministic     | compaction and chat injection still work when only Redis/FalkorDB local state is available                                                                                                             |
| A9  | Migration is clean                           | prior Task 1 / Task 2 work is either repurposed or removed; no remaining milestone text describes native routing as the primary architecture                                                           |
| A10 | Out-of-scope boundaries are honored          | no `session_upgrade`, no SQLite dependency, no child-session flattening, no Graphiti hot-path dependence                                                                                               |

### 12.2 Required test additions and rewrites

The follow-on implementation plan must replace native-routing-only success cases
with tests that prove MCP-first behavior. Required measurable coverage:

1. `session_fetch_and_index` replaces native `WebFetch` for at least one
   end-to-end fetch/search flow.
2. `session_execute` or `session_batch_execute` handles a data-heavy command and
   returns only bounded output plus a searchable artifact handle.
3. `session_execute_file` handles a large-file analysis case without injecting
   raw file contents into the transcript.
4. `session_search` retrieves relevant snippets from a locally indexed corpus
   while Graphiti is unavailable.
5. parent and child sessions share the same root-session-local corpus namespace.
6. temporary-root migration moves local corpora/stat keys to the resolved
   canonical root.
7. TTL expiry of local corpora causes graceful expiration behavior, not
   corruption.
8. `chat.message`, `messages.transform`, and `session.compacting` still inject
   valid local-first `<session_memory>` with optional cached
   `<persistent_memory>`.
9. the minimum small-corpus relevance baseline from §6.9 passes exactly as
   specified.

### 12.3 Regression thresholds that must remain true

The following existing invariants from the repository remain mandatory:

- Graphiti stays off the hot path
- compaction survival continues to work
- Redis/FalkorDB remains the local system of record for the hot path
- child-session writes do not corrupt root-session continuity

---

## 13. Failure Modes That Would Cause Goal Drift

The implementation/tasks must explicitly prevent these drift modes.

### 13.1 Architecture drift modes

1. **Native-routing recentering**\
   Symptom: most design effort remains in `tool.execute.before` heuristics while
   `session_*` tools are delayed or thin wrappers.\
   Prevention: implementation order must start with the `session_*` surface and
   local index/search, then add enforcement hooks.

2. **Graphiti creep back onto the hot path**\
   Symptom: current-turn search, fetch, or injection waits on Graphiti.\
   Prevention: all `session_*` tool functionality must be satisfiable from local
   sandbox + Redis/FalkorDB only.

3. **Child-session split brain**\
   Symptom: child `session_*` calls create separate corpora or stats outside the
   root session.\
   Prevention: canonical root resolution from runtime context is mandatory for
   all `session_*` calls; no alternative local-session namespace is allowed.

4. **Temporary-root orphaning**\
   Symptom: artifacts indexed before lineage resolution remain under obsolete
   keys.\
   Prevention: canonicalization migration must include local corpus, chunk,
   posting, and stat families in addition to existing in-memory session state.

5. **Runtime re-initialization leakage**\
   Symptom: plugin re-init leaves duplicate timers, stale local-index workers,
   or orphaned drain tasks.\
   Prevention: any new MCP-first runtime components must join the existing
   teardown discipline visible in `src/index.ts`.

6. **TTL inconsistency**\
   Symptom: chunk payloads expire but postings remain, or manifests remain
   without chunks.\
   Prevention: index keys must be managed as explicit families with synchronized
   TTL refresh/cleanup.

7. **Search parity overclaim**\
   Symptom: docs claim BM25/FTS5-equivalent behavior without those mechanisms.\
   Prevention: plan and implementation must document the exact local ranking
   method and its limitations.

8. **Scope creep into upgrade/install workflows**\
   Symptom: `session_upgrade` or installer automation consumes the milestone.\
   Prevention: keep utilities to `session_stats` and `session_doctor` only in
   the first replacement milestone.

---

## 14. Ordered Implementation Priorities for the Follow-On Plan

This document is not the implementation plan, but it locks the order that the
implementation plan must follow.

1. **Define the `session_*` MCP server surface** and bounded result contracts.
2. **Implement local corpus storage/index/search on Redis/FalkorDB**.
3. **Thread canonical root-session identity into all `session_*` calls**.
4. **Integrate `session_*` results into continuity capture and stats**.
5. **Rewrite `tool.execute.before` / `tool.execute.after` around enforcement +
   attribution**.
6. **Extend temporary-root migration and teardown coverage to new MCP local
   state**.
7. **Validate compaction continuity and async Graphiti augmentation remain
   intact**.

Any implementation plan that starts with native-tool policy expansion instead of
the `session_*` tool surface is out of compliance with this document.

---

## 15. Locked Defaults and Remaining Uncertainty

This plan leaves little room for interpretation. The only meaningful
uncertainties are implementation details, and they are resolved here with
defaults.

| Uncertainty                                                                                    | Locked default                                                          |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Should local search use Redis-only primitives or assume RediSearch/FalkorDB full-text support? | Redis-compatible primitive key families + application-side ranking only |
| Should local corpora be project-wide or session-scoped?                                        | session-scoped to canonical root session                                |
| Should child sessions have their own MCP corpus namespace?                                     | no; child work joins the canonical root session                         |
| Should Graphiti answer current-turn local fetch/search queries?                                | no                                                                      |
| Does `session_upgrade` belong in the first replacement scope?                                  | no                                                                      |
| Which layer owns root-session identity for OpenCode?                                           | the plugin, using `src/session.ts` lineage logic                        |

No further ambiguity is allowed on those points in the follow-on implementation
plan.

---

## 16. Final Replacement Statement

The repository target is now a **context-mode-style MCP-first local session
runtime** with:

- `session_*` tools as the primary bounded execution and retrieval surface
- Redis/FalkorDB hot-tier local persistence instead of SQLite/FTS5
- canonical root-session participation for parent and child work alike
- existing `<session_memory>` continuity and compaction preservation retained
- Graphiti kept async-only as a persistent-memory consolidator

The previous native-hook-first plan is superseded because it optimized the wrong
center of gravity. From this point forward, implementation work must be judged
against the MCP-first architecture defined in this document.
