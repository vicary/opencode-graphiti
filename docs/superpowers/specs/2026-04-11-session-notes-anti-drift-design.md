# Session Notes Cross-Session Recall Design

## Goal

Extend session notes so `session_search` can surface matching notes from other
sessions in the same project while still preferring the current session, and
make exact note reopen work by a single globally meaningful `id` within one
project.

The design keeps notes on the Redis/FalkorDB hot tier, keeps compaction
injection local-first, and avoids Graphiti on the hot path.

## Why This Change

The current note design is root-session scoped. That is good for compaction and
same-lineage continuity, but it is too narrow for the real recall workflow: an
agent often resumes similar work in a different root session within the same
project and should be able to discover intentionally pinned notes from those
earlier sessions.

The desired behavior is:

- `session_search` remains the default recall tool.
- It can find note hits from the current session and from other sessions in the
  same project.
- Current-session note hits rank above equivalent same-project foreign-session
  note hits.
- `session_notes_read` can reopen any same-project note directly by `id`.
- Mutation stays session-owned: one session cannot overwrite or delete another
  session's note.

## Required Behavior

### Storage Model

Use two Redis hashes:

1. `session:{rootSessionId}:notes`

- session-local authoritative note store
- field: `id`
- value:
  - `text`
  - `created_at`
  - `updated_at`

2. `session:notes:${groupId}`

- same-project cross-session note store
- field: `id`
- value:
  - `root_session_id`
  - `text`
  - `created_at`
  - `updated_at`

The session store remains authoritative for:

- compaction note injection
- current-session note enumeration and ordering
- current-session ownership semantics

The project store exists for:

- same-project cross-session note search
- direct note reopen by `id`
- project-scoped uniqueness checks

There must not be an unscoped global `session:notes` key. Redis/FalkorDB may be
shared across multiple projects, so the shared note store must remain project
scoped.

### Note Identity

Public note identity is `id`, not `note_id`.

`id` must be unique within `session:notes:${groupId}`.

On note creation:

1. Generate a UUID.
2. Check whether `session:notes:${groupId}` already contains that `id`.
3. If yes, generate a new UUID and retry until unique.
4. Persist the new note to both stores.

This makes one `id` sufficient for:

- `session_search` note hits
- `session_notes_read({ id })`
- owned-session mutation via `replace: id`

### MCP Tool Surface

Expose exactly two note tools:

- `session_notes_write(text: string, replace?: string)`
- `session_notes_read(id: string)`

Do not add a dedicated note-search tool. `session_search` remains the primary
recall entrypoint.

### Public Tool Contracts

#### `session_notes_write`

Request:

```json
{
  "text": "...",
  "replace": "optional id or *"
}
```

Response:

```json
{ "action": "created", "id": "uuid" }
```

```json
{ "action": "replaced", "id": "uuid" }
```

```json
{ "action": "deleted", "id": "uuid" }
```

```json
{ "action": "replaced", "id": "uuid", "cleared_count": 3 }
```

```json
{ "action": "replaced", "cleared_count": 3 }
```

Mutation semantics:

- No `replace`: create a new note with a fresh unique `id`.
- `replace: "<id>"` with non-empty `text`: upsert into the current session.
  - If the `id` does not exist, create a new note with that exact `id` in the
    current session.
  - If the `id` exists and is owned by the current session, update it in place.
  - If the `id` exists but is owned by another session in the same project,
    reject the write.
- `replace: "<id>"` with empty `text`: delete from the current session.
  - If the `id` does not exist, deletion is a no-op and still returns
    `{ action: "deleted", id }`.
  - If the `id` exists and is owned by the current session, delete it from both
    stores.
  - If the `id` exists but is owned by another session in the same project,
    reject the delete.
- `replace: "*"` with non-empty `text`: replace all notes for the current
  session with one new note.
- `replace: "*"` with empty `text`: clear all notes for the current session.

Only ownership conflicts are exceptional. Missing targets are normal control
flow and must not throw for upsert or delete.

#### `session_notes_read`

Request:

```json
{ "id": "uuid" }
```

Response when found:

```json
{
  "note": {
    "id": "uuid",
    "text": "...",
    "created_at": "...",
    "updated_at": "..."
  }
}
```

Response when missing:

```json
{ "note": null }
```

Behavior:

- `session_notes_read` does not require `root_session_id`.
- It reopens one note by `id` from the current project.
- A specified `id` returns exactly one note or `null`, never multiple results.
- Not-found is a normal miss, not an error.
- The tool must preserve exact note text rather than paraphrasing or
  transforming it.

### `session_search`

Public request:

```json
{ "query": "..." }
```

The plugin resolves the canonical current `root_session_id` internally. The
agent should not need to pass it.

`session_search` remains the primary recall tool. It must merge:

1. current-session local corpus hits
2. current-session note hits
3. same-project foreign-session note hits

Note hits must use this shape:

```json
{
  "type": "note",
  "id": "uuid",
  "root_session_id": "ses_...",
  "scope": "local",
  "snippet": "...",
  "score": 0.91
}
```

or

```json
{
  "type": "note",
  "id": "uuid",
  "root_session_id": "ses_other...",
  "scope": "project",
  "snippet": "...",
  "score": 0.77
}
```

Rules:

- `scope: "local"` means the note belongs to the current root session.
- `scope: "project"` means the note belongs to another session in the same
  project.
- Current-session note hits should rank above equivalent same-project foreign
  note hits.
- Unrelated-project notes must not appear.
- If the same note is encountered through both local and project passes, keep a
  single hit and prefer the local version.

Recommended ranking rule:

- local note hit: `final_score = raw_score`
- project note hit: `final_score = raw_score * 0.85`

### Compaction Behavior

Compaction remains current-session scoped.

- The compaction hook injects complete current-session note bodies from
  `session:{rootSessionId}:notes`.
- The plugin must not inject same-project foreign-session notes into compaction.
- The `<session_notes>` compaction envelope should preserve note boundaries and
  `id` values.
- The compaction path remains local-first and must not require Graphiti.

## Agent Usage Bias

### `session_search` Is The Default Recall Tool

`session_search` should explicitly describe itself as the first tool to use:

- at the start of a new session
- after compaction
- when resuming a topic worked on earlier
- before re-solving a problem that may already have prior context
- when checking whether pinned notes already contain the needed information

The description should explain that note hits may come from:

- the current session (`scope: "local"`)
- another session in the same project (`scope: "project"`)

### `session_notes_read` Is The Exact Reopen Tool

`session_notes_read` should describe itself as the way to reopen exact pinned
note text by `id` instead of reconstructing it from memory.

The description should explicitly say:

- it reads one note by `id`
- it does not require `root_session_id`
- unknown ids return `{ note: null }`

### `session_notes_write` Must Document Delete Semantics

The write tool description must document mutation semantics precisely,
especially deletion behavior.

It must explain:

- `replace: id` is an upsert when `text` is non-empty
- empty `text` plus `replace: id` is a delete
- delete on a missing `id` is a no-op that still returns `deleted`
- mutation is rejected only when the target `id` exists but is owned by another
  session in the same project
- `replace: "*"` replaces or clears the entire current-session note set

This is required because consumer agents need to know whether delete-on-miss is
safe and whether an ownership conflict is the only exceptional mutation case.

## Legacy Compatibility

Do not run a migration.

Instead:

- reads must tolerate legacy stored note shapes
- search must tolerate legacy stored note shapes
- any touched note must be rewritten in the new shape on write

This keeps rollout simple while allowing gradual cleanup through ordinary note
operations.

## Implementation Approach

- Keep the current session-scoped note store for compaction and local ownership.
- Add one project-scoped shared note hash for same-project cross-session recall.
- Keep the public identity model simple by using one project-unique `id`.
- Keep `session_search` as the unified recall entrypoint.

This is the smallest design that satisfies:

- same-project cross-session note search
- direct reopen by `id`
- current-session ranking preference
- compaction isolation
- no extra note locator type

## Implementation Shape

### `src/services/session-notes.ts`

Extend the note service to own:

- session-scoped note storage
- project-scoped note storage
- project-unique `id` generation with collision retry
- local and project note search
- ownership-aware mutation
- legacy-shape tolerant reads
- root-session migration for session-scoped note state if canonical roots change

### `src/services/session-mcp-types.ts`

- Remove public `root_session_id` from:
  - `session_search`
  - `session_notes_write`
  - `session_notes_read`
- Update public note response shapes from `note_id` to `id`.
- Change `session_notes_read` response to singular `{ note: ... | null }`.
- Extend `session_search` note hit schema with:
  - `type: "note"`
  - `id`
  - `root_session_id`
  - `scope: "local" | "project"`

### `src/services/session-mcp-runtime.ts`

- Register the updated note tools.
- Resolve current root session internally for `session_search` and
  `session_notes_write`.
- Route direct note reads by `id` through the project-scoped shared note store.
- Merge local and same-project foreign note hits into `session_search`.
- Rewrite tool descriptions for:
  - `session_notes_write`
  - `session_notes_read`
  - `session_search`

### `src/handlers/tool-before.ts`

- Keep internal canonical root-session resolution available for session tools.
- Publicly removed parameters do not remove the need for internal canonical
  session resolution.

### `src/session.ts`

- Continue to load current-session notes only for compaction injection.
- Preserve note boundaries and ids inside `<session_notes>`.

### `src/handlers/compacting.ts`

- Continue to inject full current-session notes into compaction context.
- Do not widen compaction note injection to same-project foreign sessions.

## Testing Strategy

Follow TDD.

### Red

Add failing tests for:

- schema changes removing public `root_session_id` from note/search tools
- `session_notes_read({ id }) -> { note: ... | null }`
- cross-session same-project note hits in `session_search`
- local-vs-project note ranking
- ownership-blocked replace/delete
- replace-on-miss upsert
- delete-on-miss no-op success
- UUID collision retry within the project store
- legacy-shape tolerant read/search behavior

### Green

Implement only the smallest set of storage, schema, runtime, and search changes
required to satisfy those tests.

### Refactor

- Extract helpers only where note-shape normalization or result merging would
  otherwise become unclear.
- Do not introduce a third note identity type.
- Do not broaden compaction scope to project-wide note injection.

## Validation Plan

At minimum, verify:

- `deno test -A src/services/session-mcp-runtime.test.ts`
- `deno test -A src/services/session-notes.test.ts`
- `deno test -A src/session.test.ts`
- `deno test -A`
- `deno task check`
- `deno task lint`
- `deno task fmt`

Critical evidence:

- `session_search` returns both local and same-project foreign note hits
- local note hits outrank equivalent project note hits
- `session_notes_read({ id })` reopens a foreign-session same-project note
- `session_notes_read({ id })` returns `{ note: null }` on miss
- delete semantics are explicit in the tool description and runtime behavior
- ownership conflicts are the only exceptional mutation path
- compaction still injects only current-session note bodies

## Out Of Scope

- Graphiti-backed cross-session note recall on the hot path
- unrelated-project note visibility
- a dedicated note-search tool
- note injection into normal chat turns
- structured note payloads or typed note state
- subagent-specific note stores or note UI surfaces
