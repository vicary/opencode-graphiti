# Session Notes Anti-Drift Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an agent-driven session-notes layer that preserves working context
across long sessions, topic switches, and compaction. Three MCP tools
(`session_notes_write`, `session_notes_read`, updated `session_search`) give
agents explicit control over pinning and recalling anti-drift context, with
complete note bodies injected into compaction input.

**Architecture:** A dedicated Redis-backed note service on the existing hot tier
stores opaque markdown note bodies keyed by canonical root session. Notes
surface through `session_search` result merging and are injected as raw input
into compaction. Per-session `biasState` flags drive dynamic `session_search`
description strengthening via the `tool.definition` hook.

**Tech Stack:** Deno, TypeScript, Redis (ioredis), Zod, `@opencode-ai/plugin`.

**Done when:** All existing and new tests pass:

- `deno test -A src/services/session-notes.test.ts`
- `deno test -A src/services/session-mcp-runtime.test.ts`
- `deno test -A src/handlers/compacting.test.ts`
- `deno test -A src/session.test.ts`
- `deno test -A src/index.test.ts`
- `deno test -A`
- `deno task check`
- `deno task lint`
- `deno task fmt`

---

## Verbatim Tool Descriptions (Ship As-Is)

These descriptions are deliberately prescriptive to bias agent behavior toward
the intended anti-drift workflows. They ship verbatim in the tool registrations.

**Multi-line rendering note:** These descriptions are substantially longer and
more structured than the typical one-line tool descriptions. Before shipping,
verify that multi-line descriptions render correctly in the OpenCode tool
surface (the tool picker / description display). See Task 7 Step 4 for the
concrete validation step.

### `session_notes_write` Description

> **Ship this description verbatim in the tool registration.**

<!-- begin verbatim description -->

    Pin working context as a session note so it survives topic switches, long tool
    loops, and compaction. Use this BEFORE drifting away from important context:

    - Before switching to a different topic or task
    - After a user correction changes your assumptions
    - When a small task stalls and work shifts elsewhere
    - During long tool-calling sequences where key state lives only in your context
    - Before compaction is likely (many messages into a session)

    Do NOT use this for ephemeral state that will be irrelevant within a few turns
    (e.g., intermediate variable values, transient build errors you are about to
    fix, or scratchpad reasoning). Notes are for context you need to survive
    across topic switches or compaction — not for every observation.

    Accepts `text` (markdown body) and optional `replace` (a note_id to update one
    note, or "*" to replace all notes). The response tells you exactly what
    happened:

    - `{ action: "created", note_id }` for a new note
    - `{ action: "replaced", note_id }` when replacing one note
    - `{ action: "deleted", note_id }` when empty `text` deletes one note
    - `{ action: "replaced", note_id, cleared_count }` when replacing all notes
    - `{ action: "replaced", cleared_count }` when empty `text` clears all notes

    Always rely on the returned `action` instead of inferring the outcome from the
    inputs alone.

    Prefer concise markdown with headings, bullets, and short code snippets:

        ## Current Task: Fix Redis TTL bug
        - **File:** `src/services/redis-client.ts`
        - **Root cause:** TTL not refreshed on read
        - **Next step:** Add EXPIRE call after GET in `refreshEntry()`
        - **User correction:** Use seconds not milliseconds for TTL

<!-- end verbatim description -->

**Response note:** `session_notes_write` intentionally omits `status` from its
response. This diverges from existing MCP tool responses that typically include
a `status` field. The omission is deliberate. The tool still makes outcomes
explicit by returning `action` and the relevant identifiers/counts directly.

### `session_notes_read` Description

> **Ship this description verbatim in the tool registration.**

<!-- begin verbatim description -->

    Reopen exact pinned note text instead of reconstructing it from memory. Use this
    when you resume an interrupted topic, need the exact wording of a pinned user
    instruction, or want to verify what you previously noted before acting on it.

    If `id` is provided, returns that single note. If `id` is omitted, returns all
    notes for the current session. Returns
    `{ notes: [{ note_id, text, created_at, updated_at }] }`.

    Always prefer reading a pinned note over reciting its contents from recall —
    notes are the source of truth for intentionally preserved context.

<!-- end verbatim description -->

**Response note:** `session_notes_read` intentionally omits `status` from its
response. When `id` is omitted and no notes exist, returns `{ notes: [] }`
(empty array). When `id` is provided but the note does not exist, returns
`{ notes: [] }` (empty array, not an error).

### `session_search` Description (Baseline)

> **Ship this description verbatim in the tool registration.**

<!-- begin verbatim description -->

    Search local indexed content for the current root session. This is the default
    recall path — use it FIRST when you need prior context, especially:

    - At the start of a new session or after compaction
    - When resuming a topic you worked on earlier
    - Before re-solving a problem that may already have a solution in session history
    - To check whether pinned session notes already contain the context you need

    Results may include indexed memory content (type: "memory") and, when pinned
    session notes exist, matching notes (type: "note"). Note results include a
    `note_id` — use `session_notes_read` with that id to reopen the full note
    text. Not every query will return note results; notes only appear when they
    match the search query and the session has pinned notes.

    Prefer session_search over reconstructing context from scratch. If search
    returns relevant note hits, read the note before duplicating its contents.

<!-- end verbatim description -->

### `session_search` Description (Dynamic Bias — New Session / Post-Compaction)

This strengthened variant is emitted by the `tool.definition` hook when any
tracked session has `biasState` `"new-session"` or `"post-compaction"`. See Task
5 for the Map-based mechanism.

> **Ship this description verbatim when bias is active.**

<!-- begin verbatim description -->

    Search local indexed content for the current root session. This is the default
    recall path — use it FIRST when you need prior context, especially:

    - At the start of a new session or after compaction
    - When resuming a topic you worked on earlier
    - Before re-solving a problem that may already have a solution in session history
    - To check whether pinned session notes already contain the context you need

    Results may include indexed memory content (type: "memory") and, when pinned
    session notes exist, matching notes (type: "note"). Note results include a
    `note_id` — use `session_notes_read` with that id to reopen the full note
    text. Not every query will return note results; notes only appear when they
    match the search query and the session has pinned notes.

    Prefer session_search over reconstructing context from scratch. If search
    returns relevant note hits, read the note before duplicating its contents.

    ⚠️ This is a new session or a post-compaction turn. Prior context may have been
    summarized or is not yet in your working memory. STRONGLY RECOMMENDED: run a
    session_search query before starting work to recover earlier decisions, pinned
    notes, and task state. This avoids re-solving problems or contradicting earlier
    decisions that survived compaction.

<!-- end verbatim description -->

---

## File Map

### Create

| File                                 | Purpose                                            |
| ------------------------------------ | -------------------------------------------------- |
| `src/services/session-notes.ts`      | Redis-backed note service: CRUD, TTL, search-merge |
| `src/services/session-notes.test.ts` | TDD test suite for the note service                |

### Modify

| File                                       | Purpose                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `src/services/session-mcp-types.ts`        | Add note tool names, request/response schemas, extend search result         |
| `src/services/session-mcp-runtime.ts`      | Register note tools, merge note hits into search, update descriptions       |
| `src/services/session-mcp-runtime.test.ts` | Tests for note tool routing, search merge, description bias                 |
| `src/session.ts`                           | Internal: extend compaction envelope with `<session_notes>` section         |
| `src/session.test.ts`                      | Tests for note-aware compaction envelope (file already exists)              |
| `src/handlers/compacting.ts`               | Pass note service to enable note loading for compaction                     |
| `src/handlers/compacting.test.ts`          | Tests for complete note injection in compaction                             |
| `src/index.ts`                             | Instantiate note service, wire `biasState`, register `tool.definition` hook |
| `src/index.test.ts`                        | Tests for note service wiring and `tool.definition` hook                    |

**Note:** `src/session.test.ts` already exists with session-manager tests. New
compaction-envelope tests for notes will be added to this existing file.

**Spec Reference:**
`docs/superpowers/specs/2026-04-11-session-notes-anti-drift-design.md`

---

## Task 1: Note Service Core — Redis CRUD and TTL

**Files:**

- Create: `src/services/session-notes.ts`
- Create: `src/services/session-notes.test.ts`

- [ ] **Step 1: Write failing tests for note append, read, and TTL**

  Write tests that exercise:
  - `writeNote(rootSessionId, text)` → returns
    `{ action: "created", note_id: string }`
  - `readNotes(rootSessionId)` → returns all notes with
    `{ note_id, text, created_at, updated_at }`
  - `readNotes(rootSessionId, noteId)` → returns single note
  - `readNotes(rootSessionId)` when no notes exist → returns `{ notes: [] }`
  - `readNotes(rootSessionId, "nonexistent-id")` → returns `{ notes: [] }`
  - Notes use Redis key namespace `session:{rootSessionId}:notes`
  - Notes expire with `sessionTtlSeconds` TTL
  - Note IDs are stable and unique per session

  Test dependencies: Provide a mock or stub Redis that implements only the
  methods used by `SessionNotesService` (HSET, HGET, HGETALL, HDEL, DEL,
  EXPIRE). Follow the same test-double pattern used in
  `session-mcp-runtime.test.ts` — create minimal in-memory stubs rather than
  mocking the full `RedisClient` class.

- [ ] **Step 2: Write failing tests for replace and clear semantics**

  - `writeNote(rootSessionId, text, { replace: noteId })` →
    `{ action: "replaced", note_id }`
  - `writeNote(rootSessionId, text, { replace: "*" })` →
    `{ action: "replaced", note_id, cleared_count }`
  - `writeNote(rootSessionId, "", { replace: noteId })` →
    `{ action: "deleted", note_id }`
  - `writeNote(rootSessionId, "", { replace: "*" })` →
    `{ action: "replaced", cleared_count }`
  - Replace applies only within the canonical root session

- [ ] **Step 3: Write failing tests for note search**

  - `searchNotes(rootSessionId, query)` → returns note hits with snippet, score,
    note_id
  - Note search uses simple substring/token matching on note text
  - Results include enough metadata for `session_search` merging
  - **Scoring contract:** Scores are `0`–`1` floats where `1.0` = exact full
    match. The scoring must be deterministic for the same query/text pair.
    Memory-hit scores from the existing `session_search` pipeline are also
    `0`–`1` floats, so merged sorting by descending score produces a sensible
    interleaved ranking without further normalization.

- [ ] **Step 4: Implement `SessionNotesService`**

  Implement the minimal service to pass all Step 1–3 tests:

  ```ts
  export class SessionNotesService {
    constructor(
      private readonly redis: RedisClient,
      private readonly options: { sessionTtlSeconds: number },
    ) {}

    async writeNote(
      rootSessionId: string,
      text: string,
      options?: { replace?: string },
    ): Promise<
      | { action: "created"; note_id: string }
      | { action: "replaced"; note_id: string }
      | { action: "deleted"; note_id: string }
      | { action: "replaced"; note_id?: string; cleared_count: number }
    > { ... }

    async readNotes(
      rootSessionId: string,
      noteId?: string,
    ): Promise<{
      notes: Array<{
        note_id: string;
        text: string;
        created_at: string;
        updated_at: string;
      }>;
    }> { ... }

    async searchNotes(
      rootSessionId: string,
      query: string,
    ): Promise<Array<{
      note_id: string;
      snippet: string;
      score: number;
    }>> { ... }
  }
  ```

  Storage model: use Redis HSET with `session:{rootSessionId}:notes` hash key.
  Each field is a note ID; each value is JSON with
  `{ text, created_at, updated_at }`. Set TTL via EXPIRE using
  `sessionTtlSeconds`.

- [ ] **Step 5: Verify**

  ```bash
  deno test -A src/services/session-notes.test.ts
  deno task check
  ```

---

## Task 2: MCP Schema Extensions

**Files:**

- Modify: `src/services/session-mcp-types.ts`

- [ ] **Step 1: Extend `SESSION_MCP_TOOL_NAMES`**

  Add `"session_notes_write"` and `"session_notes_read"` to
  `SESSION_MCP_TOOL_NAMES`.

- [ ] **Step 2: Add request schemas**

  ```ts
  session_notes_write: z.object({
    ...rootSessionIdShape,
    text: z.string(),
    replace: z.string().optional(),
  }).strict(),

  session_notes_read: z.object({
    ...rootSessionIdShape,
    id: z.string().optional(),
  }).strict(),
  ```

- [ ] **Step 3: Add response schemas**

  ```ts
  session_notes_write: z.object({
    action: z.enum(["created", "replaced", "deleted"]),
    note_id: z.string().min(1).optional(),
    cleared_count: z.number().int().nonnegative().optional(),
  }).strict(),

  session_notes_read: z.object({
    notes: z.array(z.object({
      note_id: z.string().min(1),
      text: z.string(),
      created_at: z.string(),
      updated_at: z.string(),
    }).strict()),
  }).strict(),
  ```

  **Note:** These response schemas intentionally omit `status`. Existing MCP
  tool responses include `status`, but note tools return minimal payloads by
  design. `session_notes_write` still makes outcomes explicit through `action`
  and optional `note_id` / `cleared_count` so agents do not need to infer
  deletion or clear behavior from the request inputs. `replaced` may omit
  `note_id` when empty `text` clears all notes.

- [ ] **Step 4: Extend search result schema**

  Add the new optional fields to `searchResultSchema` **while keeping
  `.strict()`**:

  ```ts
  const searchResultSchema = z.object({
    corpus_ref: z.string().min(1),
    snippet: z.string(),
    score: z.number(),
    type: z.enum(["memory", "note"]).optional(),
    note_id: z.string().min(1).optional(),
  }).strict();
  ```

  The existing `sessionSearchResponseSchema` references this schema, so the
  extension propagates automatically. Do NOT remove `.strict()`.

- [ ] **Step 5: Update type maps**

  Extend `SessionMcpRequestMap` and `SessionMcpResponseMap` to include the new
  tool types. Ensure `SessionMcpToolName` union type updates automatically from
  the const array.

- [ ] **Step 6: Verify**

  ```bash
  deno task check
  deno test -A src/services/session-mcp-runtime.test.ts
  ```

---

## Task 3: Tool Registration and Search Merge in MCP Runtime

**Files:**

- Modify: `src/services/session-mcp-runtime.ts`
- Modify: `src/services/session-mcp-runtime.test.ts`

- [ ] **Step 1: Write failing tests for note tool registration**

  - Verify `session_notes_write` and `session_notes_read` are present in
    `runtime.tools`
  - Verify tool descriptions match the verbatim descriptions from this plan
  - Verify args schemas match the request schemas

- [ ] **Step 2: Write failing tests for note tool execution**

- `session_notes_write` with text → returns `{ action: "created", note_id }`
- `session_notes_write` with replace one → returns
  `{ action: "replaced", note_id }`
- `session_notes_write` with replace `"*"` → returns
  `{ action: "replaced", note_id, cleared_count }`
- `session_notes_write` with empty text + replace one → returns
  `{ action: "deleted", note_id }`
- `session_notes_write` with empty text + replace `"*"` → returns
  `{ action: "replaced", cleared_count }`
  - `session_notes_read` without id → returns all notes
  - `session_notes_read` with id → returns single note
  - `session_notes_read` with no notes → returns `{ notes: [] }`
  - Responses validate against the Zod response schemas

- [ ] **Step 3: Write failing tests for `session_search` note merge**

  - `session_search` returns note hits with `type: "note"` and `note_id`
  - Existing memory results have `type: "memory"` (or undefined for backward
    compat)
  - Note hits and memory hits coexist in the results array, sorted by score
    descending
  - Note hits include snippet from note text
  - When no notes exist, search returns only memory results (no empty note
    entries)

- [ ] **Step 4: Accept `SessionNotesService` as runtime option**

  Add `notesService?: SessionNotesService` to `SessionMcpRuntimeOptions`.

- [ ] **Step 5: Register note tool handlers**

  Add `session_notes_write` and `session_notes_read` to `sessionMcpToolArgs`,
  `descriptions`, and `defaultHandlers`. Wire handlers through the notes
  service.

- [ ] **Step 6: Merge note hits into `session_search`**

  In the `session_search` handler, after `searchLocalCorpus()`, also call
  `notesService.searchNotes()`. Merge results:
  - Memory hits: `type: "memory"` (or omit for backward compat)
  - Note hits: `type: "note"`, `note_id` set, `corpus_ref` set to note ref
  - Sort merged results by score descending — both sources produce `0`–`1`
    floats so interleaving by score is meaningful
  - Cap total results conservatively to avoid overwhelming output

- [ ] **Step 7: Update `session_search` baseline description**

  Replace the existing `session_search` description with the verbatim baseline
  description from this plan.

- [ ] **Step 8: Verify**

  ```bash
  deno test -A src/services/session-mcp-runtime.test.ts
  deno task check
  ```

---

## Task 4: Compaction Note Injection

**Files:**

- Modify: `src/session.ts` (internal changes only — see scope note below)
- Modify: `src/session.test.ts` (already exists)
- Modify: `src/handlers/compacting.ts`
- Modify: `src/handlers/compacting.test.ts`

**Scope note:** `buildPreparedInjectionEnvelope`,
`collectPreparedInjectionData`, and `buildPreparedInjection` are all
**private/internal** functions and methods within `src/session.ts`. Changes here
are internal modifications to the `SessionManager` class, not exported API
changes. The public `prepareInjection` method signature gains one new optional
parameter (see gating mechanism below) but remains backward-compatible.

**Dependency ordering:** Step 3 wires `SessionNotesService` into
`SessionManager` as an optional constructor dependency. Steps 4 and 5 depend on
this wiring being in place, so Step 3 must complete before Steps 4–5.

### Compaction-Only Gating Mechanism

The note injection path must be gated so it only activates when building
compaction input, never during normal chat turns. The mechanism is an explicit
`options` parameter on `prepareInjection`:

```ts
interface PrepareInjectionOptions {
  /** When true, include <session_notes> in the envelope. Only the compaction
   *  handler should set this flag. Default: false. */
  forCompaction?: boolean;
}

async prepareInjection(
  sessionId: string,
  lastRequest?: string,
  options?: PrepareInjectionOptions,
): Promise<PreparedSessionMemory | null>
```

- `forCompaction` defaults to `false`. Normal chat-turn callers (`chat.message`,
  `messages.transform`) do not pass this parameter, so notes are never loaded or
  rendered for them.
- The compacting handler passes `{ forCompaction: true }`.
- `collectPreparedInjectionData` receives the flag and only calls
  `notesService.readNotes(rootSessionId)` when `forCompaction === true`.
- `buildPreparedInjectionEnvelope` receives a `notes` parameter (array or
  `null`) and only renders the `<session_notes>` section when notes are present.
  When `forCompaction` is `false`, no notes data is passed through.

This design is testable:

- Call `prepareInjection(id)` → verify no `<session_notes>` in envelope even
  when notes exist.
- Call `prepareInjection(id, undefined, { forCompaction: true })` → verify
  `<session_notes>` is present when notes exist.
- Call `prepareInjection(id, undefined, { forCompaction: true })` → verify
  `<session_notes>` is omitted when no notes exist.

- [ ] **Step 1: Write failing test for `<session_notes>` in compaction
      envelope**

  In `src/session.test.ts`, test that calling
  `prepareInjection(id, undefined, { forCompaction: true })` produces an
  envelope with a `<session_notes>` section when notes are present. The section
  must contain:
  - Complete note bodies (not summarized)
  - Note boundaries with note IDs
  - Provenance annotation indicating note-tool origin
  - Separation from `<session_snapshot>` and `<persistent_memory>`

  Also test that when no notes exist, the `<session_notes>` section is omitted
  entirely (not rendered as an empty tag).

  Example expected shape:
  ```xml
  <session_notes source="note_tools">
    <note id="note-1" created="2026-04-11T..." updated="2026-04-11T...">
  ## Current Task: Fix Redis TTL bug
  - Root cause: TTL not refreshed on read
    </note>
    <note id="note-2" created="2026-04-11T..." updated="2026-04-11T...">
  ## Blocked: API schema migration
  - Waiting on upstream PR #42
    </note>
  </session_notes>
  ```

- [ ] **Step 2: Write failing negative test — normal chat turns do NOT include
      `<session_notes>`**

  In `src/session.test.ts`, verify that `prepareInjection(id)` (no options) and
  `prepareInjection(id, undefined, { forCompaction: false })` both produce an
  envelope that does NOT include a `<session_notes>` section, even when notes
  exist for the session. This confirms the `forCompaction` gate works.

- [ ] **Step 3: Wire `SessionNotesService` into `SessionManager`**

  Accept `SessionNotesService` as an optional dependency in
  `SessionManagerOptions`. Store it as a private field on `SessionManager`. This
  step must complete before Steps 4–5 can use it.

  ```ts
  // In SessionManagerOptions (internal type):
  notesService?: SessionNotesService;
  ```

- [ ] **Step 4: Extend `collectPreparedInjectionData` for compaction notes**

  Add `forCompaction: boolean` to the internal parameters of
  `collectPreparedInjectionData`. When `forCompaction` is `true` and
  `notesService` is available, load notes from
  `SessionNotesService.readNotes(rootSessionId)` alongside the existing parallel
  Redis fetches. Include notes in the returned `PreparedInjectionData`. When
  `forCompaction` is `false`, skip the notes fetch entirely (do not load then
  discard — avoid the I/O).

  **Critical:** The compaction hook feeds the complete note contents as input.
  The compaction agent summarizes both the session and the notes. The plugin
  must NOT pre-summarize, compress, or reinterpret note bodies before injecting
  them.

- [ ] **Step 5: Render `<session_notes>` XML section in envelope**

  In `buildPreparedInjectionEnvelope`, add an optional `notes` parameter (the
  array from `readNotes`, or `null`/`undefined` when not in compaction mode).
  After `<session_snapshot>` and before `<persistent_memory>`, render the
  `<session_notes>` block if the notes array is non-empty. Use `escapeXml` for
  note text. Preserve note boundaries and IDs.

  When notes are empty or the parameter is `null`/`undefined`, omit the
  `<session_notes>` section entirely — do not render an empty
  `<session_notes></session_notes>` tag.

  **Scope guard:** The `notes` parameter is only populated when
  `forCompaction === true` flows through `collectPreparedInjectionData` →
  `buildPreparedInjection` → `buildPreparedInjectionEnvelope`. Normal chat-turn
  callers never supply notes because `collectPreparedInjectionData` does not
  fetch them unless the flag is set.

- [ ] **Step 6: Wire note service into compacting handler**

  Update `CompactingHandlerDeps` to accept the note service. Pass it through to
  `SessionManager` or ensure `SessionManager` already has it from Step 3. The
  compaction handler calls `prepareInjection` with the `{ forCompaction: true }`
  option:

  ```ts
  const prepared = await sessionManager.prepareInjection(
    canonicalSessionId,
    undefined,
    { forCompaction: true },
  );
  ```

  No other caller (`chat.message`, `messages.transform`) passes this option,
  ensuring notes are loaded and rendered exclusively for compaction input.

- [ ] **Step 7: Write failing test — compaction handler loads notes**

  In `src/handlers/compacting.test.ts`, verify:
  - The compaction handler calls `prepareInjection` with
    `{ forCompaction: true }` as the third argument
  - The resulting envelope in `output.context` includes the `<session_notes>`
    block with pre-seeded notes rendered verbatim
  - The mock note service's `readNotes` was called during the compaction path

- [ ] **Step 8: Verify**

  ```bash
  deno test -A src/session.test.ts
  deno test -A src/handlers/compacting.test.ts
  deno task check
  ```

---

## Task 5: Dynamic `session_search` Description Bias via `tool.definition`

**Files:**

- Modify: `src/index.ts`
- Modify: `src/index.test.ts`

### Design: Map-Based Bias State (No Single-Slot Race)

The `tool.definition` hook receives only `{ toolID: string }` as input — no
session context. Because OpenCode may run multiple sessions concurrently, a
single-slot `activeBiasSessionId` would race. Instead, the plugin uses a
**Map-based approach**:

```ts
type BiasState = "normal" | "new-session" | "post-compaction";
const sessionBiasState = new Map<string, BiasState>();
```

- `chat.message` sets `biasState = "new-session"` for the canonical session ID
  when the session has no prior events.
- `session.compacting` sets `biasState = "post-compaction"` for the canonical
  session ID.
- `tool.definition` checks **all tracked sessions** in the Map. If **any**
  session has a non-`"normal"` bias state, emit the strengthened description.
  After emitting, **delete all consumed (non-`"normal"`) entries** from the Map
  to reset them.

**Tradeoff (intentional):** Because `tool.definition` has no session context,
the strengthened description fires if _any_ tracked session is biased, not just
the one the LLM is currently serving. This means an unrelated session's
compaction could trigger one extra strengthened description for another session.
**This is a deliberate design choice, not an accidental side-effect.** The
alternatives considered were:

1. _Single-slot bias_ — simpler but races under concurrent sessions.
2. _Suppress emission entirely when ambiguous_ — avoids false positives but
   misses the critical post-compaction reminder, which is the higher-cost
   failure mode.

The Map approach was chosen because the bias is advisory ("STRONGLY RECOMMENDED:
run a session_search query") — an unnecessary reminder is harmless, while a
missed reminder after compaction actively hurts context recovery. Implementers
should preserve this "err on the side of reminding" behavior and not add
session-matching heuristics that could suppress a legitimate reminder.

The actual `tool.definition` hook signature (from `@opencode-ai/plugin`
v1.2.26):

```ts
"tool.definition"?: (
  input: { toolID: string },
  output: { description: string; parameters: any },
) => Promise<void>;
```

- [ ] **Step 1: Write failing test for `biasState` lifecycle**

  In `src/index.test.ts`, test:
  - `sessionBiasState` Map is empty initially (no bias for unknown sessions)
  - `biasState` = `"new-session"` is set when `chat.message` fires for a session
    with no prior events
  - `biasState` = `"post-compaction"` is set when `session.compacting` fires
  - Entries are deleted from the Map after `tool.definition` emits the
    strengthened description for `session_search`

- [ ] **Step 2: Write failing test for `tool.definition` hook**

  - When any session has `biasState` `"new-session"` or `"post-compaction"`,
    calling `tool.definition` with `{ toolID: "session_search" }` mutates
    `output.description` to the strengthened variant
  - When no session has non-`"normal"` state, description stays at baseline
  - `tool.definition` for non-`session_search` tools is a no-op
  - After one strengthened emit, the next call returns baseline (entries were
    consumed)
  - When multiple sessions are biased, one `tool.definition` call consumes all
    of them

- [ ] **Step 3: Implement per-session `biasState` tracking**

  Add module-scoped (or plugin-context-scoped) state:

  ```ts
  type BiasState = "normal" | "new-session" | "post-compaction";
  const sessionBiasState = new Map<string, BiasState>();
  ```

  - In `chat.message` handler: if the session has no prior events recorded in
    Redis, set `sessionBiasState.set(canonicalSessionId, "new-session")`
  - In `session.compacting` handler: set
    `sessionBiasState.set(canonicalSessionId, "post-compaction")`

- [ ] **Step 4: Register `tool.definition` hook**

  In the plugin return object, add:

  ```ts
  "tool.definition": async (
    input: { toolID: string },
    output: { description: string; parameters: any },
  ) => {
    if (input.toolID !== "session_search") return;

    // Check if any tracked session is biased
    let anyBiased = false;
    for (const [sessionId, state] of sessionBiasState) {
      if (state !== "normal") {
        anyBiased = true;
        sessionBiasState.delete(sessionId); // consume
      }
    }

    if (anyBiased) {
      output.description = STRENGTHENED_SESSION_SEARCH_DESCRIPTION;
    }
  },
  ```

- [ ] **Step 5: Verify**

  ```bash
  deno test -A src/index.test.ts
  deno task check
  ```

---

## Task 6: Plugin Wiring

**Files:**

- Modify: `src/index.ts`
- Modify: `src/index.test.ts`

- [ ] **Step 1: Write failing test for note service instantiation**

  Verify the plugin factory creates a `SessionNotesService` with the Redis
  client and `sessionTtlSeconds` config, and passes it into
  `createSessionMcpRuntime` and `SessionManager`.

- [ ] **Step 2: Instantiate `SessionNotesService` in plugin factory**

  In the `graphiti` plugin function, after creating the `redisClient`, create:
  ```ts
  const sessionNotes = new SessionNotesService(redisClient, {
    sessionTtlSeconds: config.redis.sessionTtlSeconds,
  });
  ```

  Pass `sessionNotes` to:
  - `createSessionMcpRuntime({ ..., notesService: sessionNotes })`
  - `new SessionManager(..., { ..., notesService: sessionNotes })`

- [ ] **Step 3: Add `tool.definition` hook to plugin return**

  Ensure the `tool.definition` hook (from Task 5) is included in the returned
  plugin hook map.

- [ ] **Step 4: Update `GraphitiDependencies` type if needed**

  If `SessionNotesService` is injected via DI, add it to the dependencies type.
  Otherwise, instantiate directly.

- [ ] **Step 5: Verify full integration**

  ```bash
  deno test -A src/index.test.ts
  deno test -A
  deno task check
  deno task lint
  deno task fmt
  ```

---

## Task 7: End-to-End Validation

- [ ] **Step 1: Run full test suite**

  ```bash
  deno test -A
  ```

  All existing tests must pass. No regressions.

- [ ] **Step 2: Run quality checks**

  ```bash
  deno task check
  deno task lint
  deno task fmt
  ```

- [ ] **Step 3: Verify critical evidence**

  Confirm through test output:
  - Notes can be written, replaced, deleted, cleared via `replace: "*"`, and
    read exactly
  - `readNotes` with no notes returns `{ notes: [] }`
  - `readNotes` with nonexistent ID returns `{ notes: [] }`
  - `session_search` includes note hits with `type: "note"` and `note_id`
  - `session_search` description is the verbatim baseline from this plan
  - Compaction receives full note contents as input with explicit
    `<session_notes source="note_tools">` provenance
  - Compaction envelope includes notes as raw material alongside session
    snapshot, not pre-summarized
  - Empty notes produce no `<session_notes>` section (omitted, not empty tag)
  - Normal chat-turn `prepareInjection(id)` does NOT include `<session_notes>`
  - `prepareInjection(id, undefined, { forCompaction: false })` does NOT include
    `<session_notes>`
  - `prepareInjection(id, undefined, { forCompaction: true })` DOES include
    `<session_notes>` when notes exist
  - `tool.definition` strengthens `session_search` when any tracked session is
    biased
  - Bias entries are consumed (deleted from Map) after one strengthened emission
  - Note tool responses omit `status` field

- [ ] **Step 4: Validate multi-line tool description rendering**

  The new tool descriptions are multi-line and substantially longer than the
  previous one-line descriptions. Run the plugin in a local OpenCode instance
  (or inspect the tool registration output in test) and verify:
  - `session_notes_write`, `session_notes_read`, and `session_search`
    descriptions are rendered in full (not truncated)
  - Line breaks, indentation, and markdown formatting survive the tool
    registration → display pipeline
  - No rendering artifacts (e.g., collapsed whitespace, escaped newlines) appear
    in the tool picker or tool description surface

  If the OpenCode tool surface truncates or mangles multi-line descriptions,
  file a follow-up issue and fall back to a condensed single-paragraph
  description that preserves the core behavioral nudges.

---

## Compaction Behavior — Explicit Contract

The compaction hook injects the complete, unmodified note contents as input
context to the compaction agent. The spec requires:

1. The plugin loads all notes for the canonical root session from
   `SessionNotesService.readNotes(rootSessionId)`.
2. Note bodies are rendered verbatim inside a `<session_notes>` XML section
   within the `<session_memory>` envelope.
3. The plugin does NOT pre-summarize, compress, or reinterpret note bodies.
4. The compaction agent receives both the session conversation/tool history AND
   the injected note contents, and summarizes them together.
5. The `<session_notes>` section preserves note boundaries (individual `<note>`
   tags with IDs and timestamps) so the compaction agent can attribute
   provenance.
6. Note injection is compaction-time only — gated by the `forCompaction` flag on
   `prepareInjection`. Normal `chat.message` and `messages.transform` turns do
   NOT pass this flag and therefore do NOT inject notes.
7. When no notes exist for the session, the `<session_notes>` section is omitted
   entirely from the compaction envelope.

---

## Known Risks and Follow-Ups

### Note-Body Budget in Compaction

The compaction envelope has a total size budget. Large or numerous notes could
consume a disproportionate share of the compaction context, potentially crowding
out session event history or persistent memory. The current design does not cap
note injection size separately from the overall envelope budget.

**Follow-up:** After initial implementation, monitor compaction envelope sizes
in practice. If note bodies routinely exceed a significant fraction of the
compaction context limit, add a dedicated note-body budget (analogous to
`PERSISTENT_MEMORY_BODY_BUDGET`) that truncates the oldest notes first while
preserving the most recently updated ones.

### Search Score Interoperability

Note search scores (from `SessionNotesService.searchNotes`) and memory search
scores (from the existing corpus search pipeline) must both be `0`–`1` floats
for merged sorting to produce sensible interleaving. The note service implements
a simple substring/token-match scoring algorithm. The corpus search may use a
different scoring approach. If scoring distributions diverge significantly in
practice (e.g., all note scores cluster near `0.3` while memory scores cluster
near `0.9`), the merged results will be effectively partitioned rather than
interleaved.

**Follow-up:** After initial implementation, sample merged search results to
verify that the score distributions are reasonably compatible. If not, consider
a lightweight normalization or boosting factor.

---

## Out of Scope

- TUI or GUI note display surfaces
- Structured note payloads or typed task-state columns
- Note injection into normal chat turns
- A standalone `session_note_search` / `session_notes_search` tool
- Heuristic pre-compaction reminder nudges
- Turn-local reminder nudges outside description shaping
