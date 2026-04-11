# Session Notes Anti-Drift Design

## Goal

Add an agent-driven session-notes layer of MCP tools that helps preserve working
context across long tool-calling sessions, interleaved user topics, and
compaction without introducing structured note storage.

The design keeps note contents as opaque markdown bodies stored on the existing
Redis hot tier. Agents should be biased to use note tools naturally through tool
descriptions and search behavior rather than through rigid schemas or new UI
surfaces.

## Why This Change

The current plugin preserves session continuity through event extraction,
snapshot rebuilding, cached persistent memory, and compaction-time
`<session_memory>` injection. That is strong for ordinary conversation flow, but
it does not give agents an explicit way to pin deliberately written working
context for topics that stall, get interrupted, or return later in the same
session.

The target workflow is an agent session with multiple interleaving topics,
frequent short task switches, and user corrections that must survive compaction.
In that workflow, relying only on latent recall, event summaries, and generic
search has proven too weak. A note layer should give the agent a small set of
tools to:

- write pinned markdown notes when context is likely to drift
- reopen exact note contents later instead of reconstructing them from memory
- surface prior note hits through the existing recall path
- feed complete note bodies into compaction as source input so the compaction
  model can synthesize session history and notes together

The design explicitly avoids structured note fields. Agents may be encouraged to
write readable markdown sections, but the storage layer itself remains opaque
text plus minimal note metadata.

## Required Behavior

### Storage Model

- Session notes must use the same Redis endpoint already used by the plugin hot
  tier.
- Notes should live in a dedicated Redis namespace rather than being mixed into
  ordinary event or memory keys.
- Notes are stored per canonical root session so child-agent activity remains
  aligned with parent-session continuity.
- Note contents are opaque markdown bodies.
- Note keys should expire using the existing `sessionTtlSeconds` configuration
  value (default 86400 seconds), matching the lifetime of other session-scoped
  Redis data.
- Stored metadata is minimal and operational only:
  - note id
  - canonical root session id
  - note creation timestamp
  - note update timestamp
  - note title or session title data only where needed for search result
    annotation
- The design must not introduce structured note payload fields such as `status`,
  `goal`, `blocker`, or other typed task-state columns.

### MCP Tool Surface

The note feature should expose exactly two dedicated note tools:

- `session_notes_write(text: string, replace?: string)` →
  `{ action: "created" | "replaced" | "deleted", note_id?: string, cleared_count?: number }`
- `session_notes_read(id?: string)` →
  `{ notes: Array<{ note_id: string, text: string, created_at: string, updated_at: string }> }`

`session_note_search` is explicitly out of scope and should not be added.

### `session_notes_write`

- Adds a note entry to session note storage and returns an explicit outcome
  object so agents can tell whether the operation created, replaced, deleted, or
  replaced all notes without inferring it from the inputs alone.
- If `replace` is omitted, append a new note.
- If `replace` is a note id, replace that single note entry.
- If `replace` is `"*"`, replace all current-session notes.
- If `text` is empty and `replace` is provided, clear the targeted note or note
  set.
- `session_notes_write` responses must make deletion transparent to the agent:
  - append new note → `{ action: "created", note_id }`
  - replace one note → `{ action: "replaced", note_id }`
  - delete one note → `{ action: "deleted", note_id }`
  - replace all notes with one new note →
    `{ action: "replaced", note_id, cleared_count }`
  - clear all notes with empty `text` and `replace: "*"` →
    `{ action: "replaced", cleared_count }`
- Replacement behavior applies only within the canonical root session note set.
- Tool descriptions should strongly bias usage toward anti-drift note taking,
  including examples such as:
  - before switching topics
  - after a user correction changes assumptions
  - when a small task stalls and work is about to shift elsewhere
  - during long tool loops where state may otherwise live only in model context
- The description should encourage concise markdown formatting with headings,
  bullets, and short code examples when useful, without making that format
  mandatory.

### `session_notes_read`

- If `id` is omitted, return all notes for the current canonical root session.
- If `id` is provided, return the exact note contents for that note.
- Returns `{ notes: [{ note_id, text, created_at, updated_at }] }`.
- The response should preserve the original note text rather than paraphrasing
  or transforming it.
- The tool exists primarily so agents can reload exact pinned context instead of
  reciting it from latent memory.
- Tool descriptions should bias usage toward reopening note contents when the
  agent resumes an interrupted topic or needs the exact wording of pinned user
  instructions.

### `session_search`

- `session_search` remains the primary recall entrypoint.
- Note hits should be included in `session_search` results alongside existing
  session or memory search results.
- Note hits must be clearly labeled as note-tool material so the agent can tell
  that the result came from pinned notes rather than indexed memory content.
- The result item schema should be extended with optional
  `type?: "memory" |
  "note"` and `note_id?: string` fields so note hits are
  unambiguous and agents can follow up with `session_notes_read` by note id.
- Existing memory results should default to `type: "memory"` and omit `note_id`.
- Note hits should include enough metadata for an obvious follow-up with
  `session_notes_read`, such as note id, session id, session title, and snippet.
- Existing session-search behavior should remain intact for memory results.
- The implementation should merge note hits conservatively so note recall is
  discoverable without overwhelming existing search output.

## Agent Usage Bias

The design should not rely on agents inferring note workflows on their own.
Usage bias is part of the feature.

### Strong Tool-Description Bias

The note-tool descriptions should be intentionally prescriptive rather than
neutral.

`session_notes_write` should read as the preferred way to pin working context
that must survive:

- long tool-calling sessions
- topic switches
- stalls or blockers
- user corrections
- compaction

`session_notes_read` should read as the preferred way to reopen exact note text
instead of reconstructing note contents from memory.

`session_search` should be reframed as the default recall tool for:

- new sessions
- post-compaction turns
- resumed or repeated topics
- checking whether earlier work or pinned notes already contain the needed
  context

The intended descriptions should include concrete markdown examples so agents
are nudged toward useful freeform notes without the storage layer becoming
structured.

### Dynamic `session_search` Description Bias

Static descriptions alone are not strong enough. The plugin should use the
OpenCode `tool.definition` hook to dynamically strengthen `session_search`
guidance when it is most useful.

The important dynamic-bias moments are:

- new-session turns
- post-compaction turns

At those times, the `session_search` description sent to the model should be
augmented to emphasize that agents should use it before re-solving earlier work
or when resuming context that may have drifted.

This is a description-layer bias only. It does not add extra reminder text into
ordinary turn prompts and does not introduce heuristic pre-compaction reminders.

#### Bias State Mechanism

The `tool.definition` hook receives only `{ toolID }` as input — no session
state, turn count, or compaction flag. To work around this limitation, the
plugin should maintain a per-session `biasState` flag in module-scoped state:

- Set `biasState = "new-session"` when a session is first seen in `chat.message`
  (no prior events recorded for that session).
- Set `biasState = "post-compaction"` when `session.compacting` fires.
- Clear `biasState` back to `"normal"` after the first `tool.definition` call
  for `session_search` has consumed the flag (i.e., after the strengthened
  description has been emitted once).
- The `tool.definition` hook reads the current `biasState` and returns the
  strengthened or normal description accordingly.

This keeps the mechanism local to the plugin without requiring upstream changes
to the OpenCode plugin API.

### Recall Workflow

The intended default workflow becomes:

1. Use `session_search` to broadly recall prior context and note hits.
2. Use `session_notes_read` to reopen exact note text once a note hit or current
   note set looks relevant.
3. Use `session_notes_write` to pin new or updated working context before drift
   is likely.

This keeps the search path unified instead of splitting recall between multiple
specialized search tools that agents are unlikely to adopt consistently.

## Compaction Behavior

### Full Note Bodies As Compaction Input

- The compaction hook must inject the complete current-session note contents as
  input context to compaction.
- The plugin must not pre-summarize, compress, or reinterpret note bodies before
  injecting them, beyond safe escaping and envelope formatting.
- The compaction prompt should explicitly state that the injected note contents
  came from note tools and were intentionally written to preserve anti-drift
  context.
- The compaction model should summarize both:
  - the session conversation and tool history
  - the injected note contents

This means the note layer provides the raw note material and provenance, while
the compaction model performs the actual synthesis.

### Compaction Envelope Shape

The plugin should extend the compaction-time `<session_memory>` payload with a
dedicated note section, for example a `<session_notes>` block, so provenance is
explicit and the compaction model can treat note text as intentionally pinned
material.

The rendered section should:

- include complete note bodies for the canonical root session
- preserve note boundaries and note ids
- identify that the contents came from note tools
- remain separate from snapshot and persistent-memory sections

This note section is required for compaction input. Injecting notes into normal
chat-message turns is out of scope.

## Recommended Approach

### Option A: Dedicated Redis Note Store Plus Search Integration

Recommended.

- Add a dedicated Redis-backed note service using the existing hot-tier Redis
  endpoint.
- Keep note mutation and exact reads separate from event and memory storage.
- Extend `session_search` to merge note hits into the main recall path.
- Extend compaction rendering to include full note bodies with explicit
  provenance.
- Use `tool.definition` to bias `session_search` descriptions on new-session and
  post-compaction turns.

This approach fits note semantics cleanly without contorting event or memory
storage into a mutable note store.

### Option B: Store Notes As Ordinary Session Events

Not recommended.

- Reuse event storage and reconstruct note state from events.

This makes replace semantics, exact reads, and compaction-time note rendering
awkward. Events are append-oriented and do not naturally model a mutable note
set.

### Option C: Store Notes Inside Corpus Records Only

Not recommended.

- Reuse session corpus indexing as the primary note store.

This overfits a chunked search index to a feature that needs exact note reads,
note replacement, and explicit compaction provenance. (Note: "corpus" here
refers to the internal implementation class name `SessionCorpus`, not the
user-facing terminology which uses "memory".)

## Implementation Shape

### `src/services/session-notes.ts`

Add a new note service responsible for:

- note storage keyed by canonical root session id
- note id generation
- append and replace semantics
- clear semantics through empty text plus `replace`
- current-session note reads
- migration of root-session note state if canonical roots change
- note-search indexing and retrieval for `session_search`

This service should depend only on the existing Redis client and remain on the
hot tier.

### `src/services/session-mcp-types.ts`

- Add `session_notes_write` and `session_notes_read` to the MCP tool name set.
- Define request and response schemas for both tools:
  - `session_notes_write` response:
    `{ action: "created" | "replaced" | "deleted", note_id?: string, cleared_count?: number }`
  - `session_notes_read` response:
    `{ notes: Array<{ note_id: string, text: string, created_at: string, updated_at: string }> }`
- Extend `session_search` result item schema with optional
  `type?: "memory" |
  "note"` and `note_id?: string` fields.
- Keep `.strict()` on the result item schema and add the new optional fields
  before the strict call.

### `src/services/session-mcp-runtime.ts`

- Register the new note tools.
- Route note tool handlers through the note service.
- Update `session_search` to merge note results with existing memory results.
- Rewrite tool descriptions for:
  - `session_notes_write`
  - `session_notes_read`
  - `session_search`
- Ensure the `session_search` description is strong enough in its baseline form
  to bias usage even before dynamic description augmentation.

### `src/session.ts`

- Extend session-memory composition to load current-session notes for compaction
  rendering.
- Add note-aware XML rendering that preserves note boundaries and provenance.
- Keep note injection limited to compaction-time session memory rather than
  normal turn injection.

### `src/handlers/compacting.ts`

- Continue to prepare compaction injection through the canonical session.
- Ensure the compaction context includes the complete note section inside the
  rendered `<session_memory>` envelope.
- Preserve the local-first behavior: no Graphiti fetch should be required for
  note injection.

### `src/index.ts`

- Instantiate the new note service on the existing Redis client.
- Pass note service dependencies into the MCP runtime and session manager.
- Maintain a per-session `biasState` flag (module-scoped or on the plugin
  context) that tracks whether the current turn is new-session, post-compaction,
  or normal.
- Set `biasState` in `chat.message` (new session detection) and
  `session.compacting` hooks.
- Register a `tool.definition` hook that reads `biasState` to strengthen or
  normalize the `session_search` description.
- Clear `biasState` back to `"normal"` after `tool.definition` emits the
  strengthened description once.

### Search Result Rendering

If note hits and memory hits share one response array, the result shape should
distinguish them clearly enough that an agent can tell which follow-up to use.
The implementation may add a result discriminator or equivalent metadata, but it
should remain compact and obvious in plain JSON output.

## Testing Strategy

Follow TDD for the feature.

### Red

- Add MCP schema tests that fail until the new note tools exist.
- Add runtime tests that fail until:
  - note writes append and replace correctly
  - note reads return exact stored text
  - `session_search` includes note hits
  - compaction injection includes full note bodies with provenance
  - `session_search` dynamic description bias changes on new-session and
    post-compaction states

### Green

- Implement only the minimal note service, tool registration, search merge, and
  compaction rendering changes required to satisfy the new failing tests.

### Refactor

- Extract small helpers only where repeated note-rendering, note-hit merging, or
  description-bias logic would otherwise become unclear.
- Do not introduce structured note parsing or typed note sections.

## Validation Plan

At minimum, verify:

- `deno test -A src/services/session-mcp-runtime.test.ts`
- `deno test -A src/handlers/compacting.test.ts`
- `deno test -A`
- `deno task check`
- `deno task lint`
- `deno task fmt`

The critical evidence is:

- notes can be written, replaced, deleted, cleared via `replace: "*"`, and read
  exactly
- `session_notes_write` responses make deletion/clear outcomes explicit to the
  agent instead of requiring inference from `text` and `replace`
- `session_search` visibly includes note hits and is described as the preferred
  recall path
- compaction receives full note contents as input with explicit note-tool
  provenance
- interleaved-topic note context survives compaction through the injected note
  section

## Out Of Scope

- TUI or GUI note display surfaces
- any new external plugin UI system
- structured note payloads or typed task-state storage
- note injection into normal `chat.message` or `messages.transform` turns
- a standalone `session_note_search` or `session_notes_search` tool
- heuristic pre-compaction reminder nudges
- generic turn-local reminder nudges outside description shaping
