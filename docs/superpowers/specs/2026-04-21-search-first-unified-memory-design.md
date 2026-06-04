# Search-First Unified Memory Design

## Goal

Redesign memory around one search-first contract that keeps exact history in
`opencode db` SQLite, limits injected memory to lossy hints, and makes injected
XML and `session_search()` results come from a common normalized subset of code
paths.

This design replaces the current split between event-derived injected sections,
local corpus search, cached Graphiti renderers, and ad hoc continuity shaping.

## Overarching Design Concept

The system becomes one memory architecture with separated authority layers:

1. `opencode db` is the only exact chronological truth.
2. `session_search()` is the primary memory API.
3. Injected XML is a bounded render of a subset of normalized search-style
   results.
4. Exact entries are never injected.
5. Session summaries, notes, dream snapshots, and Graphiti hints are derived
   artifacts, not transcript truth.

The practical meaning is:

- SQLite stores exact user turns, assistant turns, and tool calls.
- Local plugin storage keeps only derived or promoted artifacts and references
  back to SQLite.
- Normal turns rely on lossy injected hints for the common case.
- Exact recall happens only through `session_search()`.

## Goals

1. Make project memory a durable asset across months and years.
2. Preserve one authoritative source for exact chronology.
3. Stop injecting exact records into routine prompts.
4. Make startup and compaction continuity deterministic and concise.
5. Let `session_search()` reconnect the current turn to exact history when
   precision matters.
6. Keep retrieval predictable and bounded with O(n) scoring over candidate
   records.
7. Remove short TTL assumptions from durable memory while keeping operational
   state bounded.
8. Keep Graphiti useful but non-authoritative.
9. Ensure injected XML tags are derived from the same normalized result model as
   search results.

## Critique Of The Current Design

The current memory system mixes too many producers with incompatible semantics.

The failure sample from this design session shows the concrete problems:

- `<last_request>` promoted `yes, write into a spec now`, which is an approval,
  not durable memory.
- `<last_request>` also later promoted `yes, fold it into spec.`, showing that
  ordinary approvals still leak straight into injected memory.
- `<active_tasks>` promoted raw user fragments like `keep it` and a long
  keep/drop list, which are transcript slices rather than stable memory types.
- `<active_tasks>` also promoted `fix the stale wording`, which is a transient
  editing step rather than a stable memory object.
- `<key_decisions>` duplicated content that also appeared in the snapshot.
- `<session_snapshot>` repeated decisions already surfaced elsewhere.
- `<persistent_memory>` rendered unrelated Graphiti cache material that had no
  bearing on the active design discussion.

These are not isolated ranking bugs. They are architectural symptoms:

1. Injection is built from different producers than search.
2. Redis/FalkorDB currently acts as partial exact-memory storage instead of a
   derived-memory store.
3. The local corpus and Graphiti cache create separate retrieval semantics that
   do not line up with injected XML.
4. The system promotes lightly cleaned transcript fragments into invented XML
   sections instead of using stable memory result types.

## Authority Model

### Exact Truth

`opencode db` SQLite is the only exact ground truth for chronology.

It owns:

- user turns
- assistant turns
- tool calls
- their timestamps and identities

Exact transcript-like records must not be duplicated into FalkorDB/Redis as a
second authoritative store.

### Derived Local Artifacts

FalkorDB/Redis stores only derived or promoted artifacts and references back to
exact SQLite records.

It owns:

- session notes
- session summaries
- dream snapshots
- Graphiti-related storage and references
- operational state needed for hooks and background work

### Graphiti

Graphiti remains an asynchronous enrichment layer.

It consumes promoted local memory and exact-memory references. It does not own
authoritative exact history. It is read only as a one-off hint source on new
sessions and compaction. There is no Graphiti cache layer for injected memory.

## Keep / Drop Decisions

### Keep

1. Session snapshots.
2. Session notes.
3. One-off Graphiti queries on new sessions and compaction.
4. A new exact-entry adapter over `opencode db` for `session_search()`.
5. A shared normalization and ranking layer that feeds both search results and
   injected XML.

### Drop

1. The Redis exact event stream as a memory authority.
2. Event-derived injected section builders like `last_request`, `active_tasks`,
   `key_decisions`, `files_in_play`, `project_rules`, `unresolved_errors`,
   `git_state`, and `subagent_work`.
3. The local corpus as a memory substrate for `session_search()`.
4. The Graphiti cache render path used to build ordinary-turn
   `<persistent_memory>`.

## Normalized Result Model

All memory adapters normalize into one shared result model.

### `entry`

- Source: `opencode db` SQLite.
- Meaning: exact user turns, assistant turns, and tool calls.
- Visibility: `session_search()` only.
- Injection: never.

### `note`

- Source: session notes storage.
- Meaning: explicit durable notes.
- Visibility: searchable and injectable where allowed.

### `summary`

- Source: session snapshot adapter, dream snapshot adapter, and one-off Graphiti
  normalization.
- Meaning: lossy summaries and hint layers.
- Visibility: searchable and injectable where allowed.

No other top-level memory result kinds are part of this design.

## Shared Code-Path Rule

Injected XML sections and `session_search()` result sections must come from the
same normalized subset of code paths.

The rule is:

1. Adapters read from sources and emit `entry`, `note`, or `summary` items.
2. Retrieval ranks and filters those normalized items.
3. `session_search()` returns normalized results directly.
4. XML renderers render only the allowed subset of those same normalized
   results.

This is the core anti-drift mechanism for the new design. XML tags must emerge
from normalized result types instead of hand-built parallel summarizers.

## `session_search()` Contract

`session_search()` becomes the canonical memory read API.

### Query Mode

When `query` is non-empty:

- accept `when`, defaulting to the current timestamp
- search exact SQLite-backed entries
- search notes
- search the same summary set used by empty-query reflection mode
- limit exact entry and note hits to records at or before `when`
- return exact results first, then summaries

The exact-results segment contains `entry` and `note` results. The summary
segment contains `summary` results.

Within each segment, order by:

1. `weight` descending
2. `created_at` descending
3. stable tie-break

This keeps exact evidence ahead of summaries while still preserving a single
normalization layer.

The summary segment must be produced by the same reflection machinery used by
empty-query search. Query mode does not introduce a second summary-selection
algorithm.

Tool-heavy sessions can produce too many exact SQLite hits. That is a real
concern rather than overthinking. The noise-reduction rule is:

- exact entry adapters may collapse contiguous low-signal tool activity into one
  bounded exact result when the underlying raw sequence is mechanically related
  and has no intervening user or assistant turn
- this compaction must preserve a reference back to the underlying exact records
  in `opencode db`
- the compaction rule applies only to exact search results and must not create a
  new injected-memory type

### Reflection Mode

When `query` is empty or null:

- return summaries only
- accept `when`, defaulting to the current timestamp
- resolve granularity with decreasing resolution the farther away from `when`
- include snapshots from both before and after the reference time
- order returned summaries chronologically

The temporal ladder is numeric rather than bespoke. Examples include:

- day
- week
- month
- year
- decade
- century
- millennia

Every summary snapshot is retained indefinitely. Larger timeframes are access
points, not replacements.

Query mode and reflection mode therefore share the same summary-selection
mechanism. The difference is only that query mode also returns exact entries and
notes ahead of those summaries.

### Exact Recall Boundary

`session_search()` is the only bridge from hints back to exact history.

If an injected summary looks relevant, the agent uses `session_search()` to
recover exact entries. Exact entries never appear in injected XML.

## Injection Contract

### Top-Level `<memory>` Wrapper

Injected memory must be wrapped in one top-level `<memory>` element. Multiple
top-level XML nodes are not allowed because they render poorly in the user view
and introduce meaningless line breaks.

`<persistent_memory>` remains nested inside `<memory>`.

### `<memory>`

`<memory>` is the session-start and compaction continuity wrapper.

It is injected only on:

1. new sessions, including subagents
2. compaction

It is not the general ordinary-turn memory surface.

It may contain:

- session-scoped summaries
- notes where explicitly allowed

It may not contain:

- exact entries
- raw turns
- raw tool calls
- hand-built transcript projections outside the normalized result model

For new sessions, it should primarily contain session-scoped summary material.

For new sessions and compaction, up to the last 10 session notes may be injected
when they are relevant to the active continuity surface.

For compaction, it may also include notes because compaction benefits from a
slightly richer continuity surface.

### `<persistent_memory>`

`<persistent_memory>` remains available on ordinary turns.

The common 80% autopilot criterion applies to the whole injected-memory surface,
not only `<persistent_memory>`. The injected blocks together should provide a
bounded hint layer that is sufficient for most routine work without replacing
explicit search.

It may contain:

- dream summaries
- other local summary artifacts

On new sessions and compaction, it may also include one-off Graphiti-derived
summaries normalized into the same `summary` result shape.

It may not contain:

- exact entries
- exact notes
- literal Graphiti nodes, facts, or episodes rendered verbatim

### Summary-Only Rule

The entire injected `<memory>` surface is hint-only. Exact memory remains
search-only.

## XML Shape

Use one top-level wrapper:

- `<memory>`

Inside `<memory>`, only render tags derived from normalized result kinds.

`<persistent_memory>` remains a nested child section inside `<memory>`.

### Allowed Child Tags

1. `<summary ...>`
2. `<note ...>`

There is no injected `<entry ...>` tag.

### Session Summary Attributes

Session-local summaries use `scope`, not `granularity`.

This is valid:

```xml
<summary scope="session" source="snapshot">...</summary>
```

This is invalid:

```xml
<summary granularity="session">...</summary>
```

`granularity` is reserved for temporal buckets like `day`, `week`, `month`,
`year`, `decade`, `century`, and `millennia`.

### Example Shape

```xml
<memory version="2">
  <summary scope="session" source="snapshot">...</summary>
  <session_notes>
    <note scope="local" created="..." updated="...">...</note>
    <note scope="project" created="..." updated="...">...</note>
  </session_notes>

  <persistent_memory>
    <summary granularity="day">...</summary>
    <summary granularity="week">...</summary>
    <summary source="graphiti">...</summary>
  </persistent_memory>
</memory>
```

The exact tags shown above are illustrative. The invariant is that rendered tags
must come directly from normalized `note` and `summary` results.

## Dream Pipeline

Dream is a local asynchronous summarization pipeline inside the plugin. It is
not a server-side dependency.

The pipeline works like this:

1. consume promoted local memory and note material
2. produce daily summaries first
3. recursively compose higher timeframes from lower ones
4. store all generated summaries indefinitely

Dream summaries are a permanent chronological access layer. They are a hint
surface for injection and a searchable summary layer for reflection mode.

### Dream Triggers

Because OpenCode usually runs as a CLI process rather than a persisted daemon,
dreaming cannot rely on a permanently resident worker.

The trigger model is therefore opportunistic and local:

1. run a bounded dream refresh during session startup if required summaries are
   missing relative to the current exact-history watermark
2. run a bounded dream refresh during compaction
3. on orderly runtime shutdown, if there is dirty exact-history material not yet
   incorporated into summaries, persist a bounded dream job descriptor and spawn
   a detached headless dream worker to consume that job while letting the
   foreground OpenCode process exit immediately
4. if detached dreaming cannot be started safely, show an explicit OpenCode
   toast telling the user that dreaming is still in progress and they should
   wait for completion before exiting
5. on the next process start, detect any remaining exact-history gap and resume
   bounded catch-up dreaming before serving reflection-style summary reads

This gives the system durable dream progress without requiring a resident
service.

Detached dreaming is viable only as an independent bounded catch-up worker. It
must bootstrap from persisted job input and persisted exact-history watermarks;
it must not depend on the parent process's in-memory runtime state.

## Graphiti Role

Graphiti stays in the architecture, but with a narrower contract.

It is:

- an asynchronous consumer of promoted local memory and note material
- a semantic enrichment layer
- a one-off hint source on new sessions and compaction

It is not:

- authoritative transcript storage
- a cached ordinary-turn injection substrate
- a replacement for `session_search()`

Graphiti summaries are hints only. If they matter, the agent must still use
`session_search()` to reconnect to exact records.

## Storage And Retention

Durable memory has no TTL.

This applies to:

- notes
- summaries
- Graphiti-related durable references

Operational state remains bounded.

This applies to:

- transient hook state
- background job coordination
- any remaining short-lived runtime caches

The system relies only on relevancy and weighting to suppress low-value recall.
Durable artifacts are not expired by time.

## Migration Direction

Implementation should proceed by moving toward the normalized read model first.

The sequence is:

1. add the SQLite-backed exact-entry adapter for `session_search()`
2. add normalized `note` and `summary` result types around existing notes and
   snapshot material
3. teach XML renderers to consume normalized results instead of bespoke event
   section builders
4. remove local corpus memory search from the memory path
5. remove Graphiti cache-based ordinary-turn rendering
6. remove Redis exact-event memory authority from injected continuity assembly

This preserves a working system while shifting all memory surfaces toward one
shared normalization layer.

## Validation Expectations

The redesigned memory system is correct when:

1. exact user turns, assistant turns, and tool calls are discoverable through
   `session_search()` and not injected.
2. new-session and compaction injection are wrapped in one top-level `<memory>`
   block and contain only normalized `summary`, `note`, and nested
   `<persistent_memory>` sections.
3. ordinary-turn `<memory>` contains only summary and note hints, with exact
   entries excluded.
4. the bad promotion pattern from the current failure sample is impossible
   because `last_request`, `active_tasks`, and `key_decisions` no longer exist
   as independent injected-memory producers.
5. Graphiti absence does not break local dream summaries or exact recall via
   `session_search()`.

## Non-Goals

This design does not try to:

- inject exact transcript fragments directly into model prompts
- keep the local corpus as a memory search surface
- make Graphiti the authoritative memory reader
- preserve the current bespoke injected section taxonomy
