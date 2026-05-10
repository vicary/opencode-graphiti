# Session Notes Freshness Without TTL Design

## Goal

Make session notes durable instead of expiring on TTL, reduce the visibility of
old noisy notes through freshness-aware ranking rather than deletion-by-time,
and let same-project sessions explicitly delete obsolete notes by `id`.

The design keeps the existing small tool surface:

- `session_search` remains the default recall entrypoint
- `session_notes_read(id)` remains the exact reopen path
- `session_notes_write(text, replace?)` remains the mutation path

## Why This Change

The current design uses `sessionTtlSeconds` for the session-scoped note store,
and `session_search` applies a hard-coded non-local penalty to same-project
notes from other sessions.

That creates two problems:

1. useful notes can disappear just because they are old
2. old incorrect or noisy notes are hard to remove from a later session, while
   still sometimes surfacing because search relevance alone does not reflect
   whether a note has stayed useful over time

The desired behavior is:

- notes persist until explicitly deleted
- stale notes become less likely to surface naturally
- same-project notes are not penalized only for being non-local
- exact note reopen through `session_notes_read(id)` becomes a meaningful
  usefulness signal

## Current Relevant Behavior

### Note Storage

- `session:{rootSessionId}:notes` stores current-session note bodies and is used
  for compaction note injection
- `project:{groupId}:notes` stores same-project notes for cross-session search
  and direct reopen by `id`

### Search Ranking

Current note ranking rule:

- local note hit: `final_score = raw_score`
- project note hit: `final_score = raw_score * 0.85`

### Read Path

- `session_search` returns note hits with excerpt `snippet`, not full note text
- `session_notes_read(id)` returns the exact full note text
- reads do not currently update note metadata

## Required Behavior

### Persistence

- Session notes must no longer expire because of TTL.
- The session-local note store must stop being written with TTL.
- Read operations must stop refreshing note TTL.
- Notes remain present until explicitly deleted.

This change applies to session notes only. It does not change unrelated TTL use
for other hot-tier data.

### Deletion Semantics

- Any session in the same project may delete a note by `id`.
- Same-project delete must remove the note from both the session-local store and
  the project-scoped store.
- Delete-on-miss remains a successful no-op returning a deleted result.
- Cross-project deletion must remain impossible.

Recommended scope rule:

- create and non-empty replace stay session-scoped
- empty-text delete becomes same-project scoped

This keeps ordinary authorship conservative while allowing later cleanup of old
incorrect or noisy notes.

### Search Result Shape

`session_search` note hits must include:

- `id`
- `root_session_id`
- `scope`
- `snippet`
- `score`
- `created_at`
- `updated_at`

Example:

```json
{
  "type": "note",
  "id": "uuid",
  "root_session_id": "ses_...",
  "scope": "local",
  "snippet": "...",
  "score": 0.91,
  "created_at": "2026-05-10T12:00:00.000Z",
  "updated_at": "2026-05-10T12:30:00.000Z"
}
```

`last_read_at` should not be returned in search results initially.

### Read Freshness

To better measure note usefulness, project note metadata must add
`last_read_at`.

Rules:

- `session_notes_read(id)` updates `last_read_at` when the note exists
- missing-note reads remain normal misses and must not create or modify data
- `last_read_at` is project-scoped metadata because usefulness is shared across
  same-project sessions

`updated_at` remains write freshness only. It must not be overloaded to mean
read freshness.

## Ranking Model

### Terminology

- `relevance`: how well the note matches the query
- `write_freshness`: freshness derived from `updated_at`
- `read_freshness`: usefulness derived from `last_read_at`

### Scoring

Use note ranking based on:

```text
final_score = relevance * write_freshness * read_freshness
```

Recommended shape:

- `write_freshness = exp(-lambda_write * age_since_updated_at)`
- `read_freshness = 1 + alpha * exp(-lambda_read * age_since_last_read_at)`

Properties:

- `relevance` remains the primary semantic match measure
- `write_freshness` causes old untouched notes to fade smoothly
- `read_freshness` partially rescues notes that agents repeatedly find useful
- `read_freshness` must be capped and bounded
- `read_freshness` must not fully reset or overwhelm `write_freshness`

This means:

- a new note can rank highly without reads
- an old unread note fades naturally
- an old but recently reopened note can remain competitive
- a very strong semantic match can still beat a weaker newer note

### Locality

Remove the hard-coded same-project non-local penalty.

Do not broadly multiply project-note scores down only because they come from a
different root session.

Instead:

- apply the same freshness model to local and project note hits
- use locality only as a tie-break when scores are effectively equal

Tie-break order:

1. higher `score`
2. prefer `scope: "local"`
3. newer `updated_at`
4. stable deterministic fallback such as `id`

## Search And Read Roles

### `session_search`

- remains the default recall tool
- returns only a relevance-centered excerpt/snippet, not full note text
- lets agents judge whether a note is promising enough to reopen

The snippet should remain informative enough to support triage. It should not be
degraded into an opaque summary that hides likely relevance.

### `session_notes_read`

- remains the only exact reopen path for full note text
- acts as the explicit signal that a note was useful enough to inspect in full

This aligns the tool workflow with ranking: search discovers, read confirms, and
read activity feeds note usefulness over time.

## Storage Model

### Session-Local Store

`session:{rootSessionId}:notes`

- remains the authoritative store for current-session note enumeration and
  compaction injection
- stores current-session note bodies keyed by `id`
- no longer uses TTL

Stored fields remain:

- `text`
- `created_at`
- `updated_at`

### Project Store

`project:{groupId}:notes`

- remains the cross-session source of truth for same-project search and direct
  reopen by `id`

Stored fields become:

- `root_session_id`
- `text`
- `created_at`
- `updated_at`
- `last_read_at` optional or nullable

## Compaction Behavior

Compaction remains current-session scoped.

- only current-session notes are injected into compaction context
- same-project foreign-session notes must not be injected into compaction
- note freshness ranking has no effect on compaction note inclusion

## Migration

- Existing notes must survive this change.
- Existing `updated_at` values become the initial write-freshness clock.
- Existing notes may begin with missing `last_read_at` and be treated as never
  read.
- No destructive backfill is required.

## Validation

At minimum, verify:

- notes no longer disappear because of session note TTL
- search results include `created_at` and `updated_at`
- old unread notes rank below newer comparable notes
- old recently read notes can outrank newer weaker matches
- same-project delete-by-id succeeds for foreign-session notes
- delete-on-miss remains a no-op success
- cross-project note isolation remains intact
- compaction still injects only current-session notes

## Risks

- If `write_freshness` decays too aggressively, useful old notes become too hard
  to discover.
- If `read_freshness` is too strong, agents can accidentally keep junk alive by
  reopening it.
- If snippets become too weak, agents may fail to call `session_notes_read` on
  the right note.

The ranking constants should therefore be conservative and test-driven.
