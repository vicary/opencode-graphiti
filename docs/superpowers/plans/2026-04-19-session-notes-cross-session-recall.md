# Session Notes Cross-Session Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend session notes so `session_search` can surface same-project
notes from other sessions, `session_notes_read` can reopen any same-project note
by `id`, and note mutation stays ownership-safe while compaction remains
current-session-only.

**Architecture:** Keep the existing session-scoped note hash for compaction and
local ownership, and add one project-scoped shared note hash keyed by globally
unique `id` within the project group. Public note/search tool contracts drop
public `root_session_id` for note and search tools, while the plugin still
resolves canonical root session internally before runtime execution.

**Tech Stack:** Deno, TypeScript, Zod, Redis/FalkorDB hot tier,
`@opencode-ai/plugin`.

---

## File Map

### Modify

| File                                       | Responsibility                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `src/services/session-notes.ts`            | Dual-store note persistence, uniqueness checks, direct read by `id`, local/project note search, ownership-aware mutation |
| `src/services/session-notes.test.ts`       | Unit tests for dual-store behavior, upsert/delete semantics, collision retry, and cross-session search                   |
| `src/services/session-mcp-types.ts`        | Public request/response schema updates for `id`, singular note read response, and note search hit metadata               |
| `src/services/session-mcp-runtime.ts`      | Tool descriptions, public tool args, internal root-session resolution, search merge, direct note read routing            |
| `src/services/session-mcp-runtime.test.ts` | Schema compatibility, runtime tool behavior, cross-session search ranking, and direct read-by-id                         |
| `src/index.ts`                             | Continue wiring note service/runtime/canonicalization with no public root parameter exposure                             |
| `src/index.test.ts`                        | Verify exposed tool args and description behavior still match the runtime contract                                       |
| `docs/SmokeTests.md`                       | Update live note-search expectations and exact runtime contracts                                                         |

### Keep unchanged in behavior

| File                         | Why                                                     |
| ---------------------------- | ------------------------------------------------------- |
| `src/session.ts`             | Compaction should still read only current-session notes |
| `src/handlers/compacting.ts` | Compaction remains current-session scoped               |

---

## Task 1: Lock The New Public Contracts In Tests First

**Files:**

- Modify: `src/services/session-mcp-types.ts`
- Modify: `src/services/session-mcp-runtime.test.ts`
- Modify: `src/index.test.ts`

- [ ] **Step 1: Write failing schema tests for the new note/search requests and
      responses**

  Add/replace schema assertions in `src/services/session-mcp-runtime.test.ts` so
  the public contracts become:

  ```ts
  Deno.test("note schema compatibility accepts approved note request and response contracts", () => {
    const writeRequest = sessionMcpRequestSchemas.session_notes_write.safeParse(
      {
        text: "remember this",
        replace: "note-1",
      },
    );
    const deleteResponse = sessionMcpResponseSchemas.session_notes_write
      .safeParse({
        action: "deleted",
        id: "note-1",
      });
    const readRequest = sessionMcpRequestSchemas.session_notes_read.safeParse({
      id: "note-1",
    });
    const readResponse = sessionMcpResponseSchemas.session_notes_read.safeParse(
      {
        note: {
          id: "note-1",
          text: "remember this",
          created_at: "2026-04-11T10:00:00.000Z",
          updated_at: "2026-04-11T10:00:00.000Z",
        },
      },
    );
    const readMiss = sessionMcpResponseSchemas.session_notes_read.safeParse({
      note: null,
    });

    assertEquals(writeRequest.success, true);
    assertEquals(deleteResponse.success, true);
    assertEquals(readRequest.success, true);
    assertEquals(readResponse.success, true);
    assertEquals(readMiss.success, true);
  });

  Deno.test("search schema compatibility accepts note hits with id, root_session_id, and scope", () => {
    const accepted = sessionMcpResponseSchemas.session_search.safeParse({
      status: "ok",
      results: [{
        corpus_ref: "session:root:corpus:1",
        snippet: "remember this",
        score: 0.9,
        type: "note",
        id: "note-1",
        root_session_id: "root-123",
        scope: "project",
      }],
      corpus_refs: ["session:root:corpus:1"],
      truncated: false,
    });

    assertEquals(accepted.success, true);
  });
  ```

- [ ] **Step 2: Write failing runtime-registration tests for rootless public
      note/search args**

  Update the existing args assertions in
  `src/services/session-mcp-runtime.test.ts` and `src/index.test.ts` so they
  expect:

  ```ts
  assertEquals(Object.keys(runtime.tools.session_notes_write.args), [
    "text",
    "replace",
  ]);
  assertEquals(Object.keys(runtime.tools.session_notes_read.args), ["id"]);
  assertEquals(Object.keys(runtime.tools.session_search.args), ["query"]);
  ```

- [ ] **Step 3: Run the narrow schema/runtime test slice and confirm it fails
      for the old contract**

  Run:

  ```bash
  deno test -A src/services/session-mcp-runtime.test.ts src/index.test.ts
  ```

  Expected: FAIL because the current runtime and schemas still require
  `root_session_id`, still use `note_id`, and still return `{ notes: [...] }`.

- [ ] **Step 4: Update `src/services/session-mcp-types.ts` to the new public
      shapes**

  Make the request/response shape changes directly in
  `src/services/session-mcp-types.ts`:

  ```ts
  type SessionNotesWriteRequest = {
    text: string;
    replace?: string;
  };

  type SessionNotesReadRequest = {
    id: string;
  };

  const searchResultSchema = z.object({
    corpus_ref: z.string().min(1),
    snippet: z.string(),
    score: z.number(),
    type: z.enum(["memory", "note"]).optional(),
    id: z.string().min(1).optional(),
    root_session_id: z.string().min(1).optional(),
    scope: z.enum(["local", "project"]).optional(),
  }).strict();

  const sessionNoteSchema = z.object({
    id: z.string().min(1),
    text: z.string(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  }).strict();

  session_notes_write: z.object({
    text: z.string(),
    replace: z.string().min(1).optional(),
  }).strict(),

  session_notes_read: z.object({
    id: z.string().min(1),
  }).strict(),

  session_search: z.object({
    query: z.string().min(1),
  }).strict(),

  session_notes_write: z.object({
    action: z.enum(["created", "replaced", "deleted"]),
    id: z.string().min(1).optional(),
    cleared_count: z.number().int().nonnegative().optional(),
  }).strict(),

  session_notes_read: z.object({
    note: sessionNoteSchema.nullable(),
  }).strict(),
  ```

- [ ] **Step 5: Re-run the same narrow slice and confirm the schema layer now
      passes**

  Run:

  ```bash
  deno test -A src/services/session-mcp-runtime.test.ts src/index.test.ts
  ```

  Expected: still FAIL, but now deeper in runtime behavior rather than the old
  public contract.

---

## Task 2: Rebuild The Note Service Around Dual Stores And Global `id`

**Files:**

- Modify: `src/services/session-notes.ts`
- Modify: `src/services/session-notes.test.ts`

- [ ] **Step 1: Write failing unit tests for project-scoped read/search and
      ownership rules**

  Add tests in `src/services/session-notes.test.ts` covering:

  ```ts
  it("reads one same-project note by id and returns null on miss", async () => {
    const redis = createRedis();
    const service = new SessionNotesService(redis, {
      sessionTtlSeconds: 60,
      groupId: "group-a",
      createNoteId: createSequence(["note-1"]),
      now: createClock("2026-04-19T10:00:00.000Z"),
    });

    await service.writeNote("root-a", "remember this");

    assertEquals(await service.readNoteById("group-a", "note-1"), {
      note: {
        id: "note-1",
        text: "remember this",
        created_at: "2026-04-19T10:00:00.000Z",
        updated_at: "2026-04-19T10:00:00.000Z",
      },
    });
    assertEquals(await service.readNoteById("group-a", "missing"), {
      note: null,
    });
  });

  it("searches local and same-project foreign notes with a project penalty", async () => {
    const redis = createRedis();
    const service = new SessionNotesService(redis, {
      sessionTtlSeconds: 60,
      groupId: "group-a",
      createNoteId: createSequence(["note-1", "note-2"]),
      now: createClock(
        "2026-04-19T10:00:00.000Z",
        "2026-04-19T10:00:01.000Z",
      ),
    });

    await service.writeNote("root-local", "redis ttl drift note");
    await service.writeNote("root-other", "redis ttl drift note");

    const hits = await service.searchProjectNotes(
      "root-local",
      "redis ttl drift note",
    );
    assertEquals(hits.map((hit) => ({ id: hit.id, scope: hit.scope })), [
      { id: "note-1", scope: "local" },
      { id: "note-2", scope: "project" },
    ]);
    assertEquals(hits[0]!.score > hits[1]!.score, true);
  });

  it("allows replace-on-miss, delete-on-miss, and blocks foreign ownership conflicts", async () => {
    const redis = createRedis();
    const service = new SessionNotesService(redis, {
      sessionTtlSeconds: 60,
      groupId: "group-a",
      createNoteId: createSequence(["note-1"]),
      now: createClock(
        "2026-04-19T10:00:00.000Z",
        "2026-04-19T10:00:01.000Z",
        "2026-04-19T10:00:02.000Z",
      ),
    });

    await service.writeNote("root-foreign", "foreign", { replace: "note-1" });
    assertEquals(
      await service.writeNote("root-local", "local replacement", {
        replace: "missing-local",
      }),
      { action: "replaced", id: "missing-local" },
    );
    assertEquals(
      await service.writeNote("root-local", "", {
        replace: "already-gone",
      }),
      { action: "deleted", id: "already-gone" },
    );
    await assertRejects(
      () =>
        service.writeNote("root-local", "cannot steal", { replace: "note-1" }),
      Error,
      "owned by another session",
    );
  });
  ```

- [ ] **Step 2: Add a failing collision-retry test for project-wide `id`
      uniqueness**

  Add:

  ```ts
  it("retries note id generation until the project id is unique", async () => {
    const redis = createRedis();
    const service = new SessionNotesService(redis, {
      sessionTtlSeconds: 60,
      groupId: "group-a",
      createNoteId: createSequence(["collision", "collision", "note-unique"]),
      now: createClock(
        "2026-04-19T10:00:00.000Z",
        "2026-04-19T10:00:01.000Z",
      ),
    });

    await service.writeNote("root-a", "existing", { replace: "collision" });
    assertEquals(await service.writeNote("root-b", "new note"), {
      action: "created",
      id: "note-unique",
    });
  });
  ```

- [ ] **Step 3: Run the note-service unit tests and confirm they fail**

  Run:

  ```bash
  deno test -A src/services/session-notes.test.ts
  ```

  Expected: FAIL because the service is still single-store, `note_id`-based, and
  root-session-only.

- [ ] **Step 4: Implement the dual-store service with normalized `id` shapes**

  Update `src/services/session-notes.ts` to add the second store and the new
  read/search API. The central service shape should look like:

  ```ts
  export type SessionNote = {
    id: string;
    text: string;
    created_at: string;
    updated_at: string;
  };

  export type SessionNoteSearchHit = {
    id: string;
    root_session_id: string;
    scope: "local" | "project";
    snippet: string;
    score: number;
  };

  export type WriteNoteResult =
    | { action: "created"; id: string }
    | { action: "replaced"; id: string }
    | { action: "deleted"; id: string }
    | { action: "replaced"; id: string; cleared_count: number }
    | { action: "replaced"; cleared_count: number };

  export const sessionNotesKey = (rootSessionId: string): string =>
    `session:${rootSessionId}:notes`;

  export const projectNotesKey = (groupId: string): string =>
    `project:${groupId}:notes`;
  ```

  Implement the core methods with these signatures:

  ```ts
  async writeNote(
    rootSessionId: string,
    text: string,
    options?: { replace?: string },
  ): Promise<WriteNoteResult>

  async readNoteById(
    groupId: string,
    id: string,
  ): Promise<{ note: SessionNote | null }>

  async searchProjectNotes(
    rootSessionId: string,
    query: string,
  ): Promise<SessionNoteSearchHit[]>
  ```

  Required implementation rules:

  ```ts
  const projectHitPenalty = 0.85;

  if (replace && text !== "") {
    if (!projectNote) {
      // upsert by exact id into current session
    } else if (projectNote.root_session_id !== rootSessionId) {
      throw new Error(`Note ${replace} is owned by another session`);
    }
  }

  if (replace && text === "") {
    if (!projectNote) {
      return { action: "deleted", id: replace };
    }
    if (projectNote.root_session_id !== rootSessionId) {
      throw new Error(`Note ${replace} is owned by another session`);
    }
  }
  ```

- [ ] **Step 5: Re-run the note-service tests and confirm they pass**

  Run:

  ```bash
  deno test -A src/services/session-notes.test.ts
  ```

  Expected: PASS.

---

## Task 3: Rewire The Runtime To Use Internal Root Resolution And Direct Read By `id`

**Files:**

- Modify: `src/services/session-mcp-runtime.ts`
- Modify: `src/services/session-mcp-runtime.test.ts`

- [ ] **Step 1: Add failing runtime tests for rootless execution and direct
      same-project read**

  Replace the old note runtime tests in
  `src/services/session-mcp-runtime.test.ts` with assertions shaped like:

  ```ts
  it("executes the updated note action contract through the runtime", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-runtime",
    } as never);

    const localContext = createToolContext({ sessionID: "child-local" });
    const foreignContext = createToolContext({ sessionID: "child-foreign" });

    runtime.setSessionCanonicalizer({
      getCachedCanonicalSessionId(sessionId: string) {
        return sessionId === "child-local" ? "root-local" : "root-foreign";
      },
      async resolveCanonicalSessionId(sessionId: string) {
        return sessionId === "child-local" ? "root-local" : "root-foreign";
      },
      async validateRuntimeRootSessionId() {},
    } as never);

    const created = JSON.parse(
      await runtime.tools.session_notes_write.execute(
        { text: "first note" },
        localContext,
      ),
    );
    const read = JSON.parse(
      await runtime.tools.session_notes_read.execute(
        { id: created.id },
        foreignContext,
      ),
    );

    assertEquals(read.note.id, created.id);
    assertEquals(read.note.text, "first note");
  });
  ```

- [ ] **Step 2: Add a failing runtime test for `session_search` local/project
      note ranking**

  Add:

  ```ts
  it("returns local note hits above same-project foreign note hits", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-note-search",
    } as never);

    runtime.setSessionCanonicalizer({
      getCachedCanonicalSessionId() {
        return "root-local";
      },
      async resolveCanonicalSessionId() {
        return "root-local";
      },
      async validateRuntimeRootSessionId() {},
    } as never);

    await runtime.tools.session_notes_write.execute({
      text: "redis ttl drift note",
    }, createToolContext({ sessionID: "local-child" }));
    runtime.setSessionCanonicalizer({
      getCachedCanonicalSessionId(sessionId: string) {
        return sessionId === "local-child" ? "root-local" : "root-other";
      },
      async resolveCanonicalSessionId(sessionId: string) {
        return sessionId === "local-child" ? "root-local" : "root-other";
      },
      async validateRuntimeRootSessionId() {},
    } as never);
    await runtime.tools.session_notes_write.execute({
      text: "redis ttl drift note",
    }, createToolContext({ sessionID: "other-child" }));

    runtime.setSessionCanonicalizer({
      getCachedCanonicalSessionId() {
        return "root-local";
      },
      async resolveCanonicalSessionId() {
        return "root-local";
      },
      async validateRuntimeRootSessionId() {},
    } as never);

    const parsed = JSON.parse(
      await runtime.tools.session_search.execute(
        { query: "redis ttl drift note" },
        createToolContext({ sessionID: "local-child" }),
      ),
    );

    const noteHits = parsed.results.filter((result: { type?: string }) =>
      result.type === "note"
    );
    assertEquals(noteHits[0].scope, "local");
    assertEquals(noteHits[1].scope, "project");
    assertEquals(noteHits[0].score > noteHits[1].score, true);
  });
  ```

- [ ] **Step 3: Run the runtime test slice and confirm it fails**

  Run:

  ```bash
  deno test -A src/services/session-mcp-runtime.test.ts
  ```

  Expected: FAIL because the runtime still expects public `root_session_id`,
  still reads notes by current root, and does not merge same-project foreign
  note hits.

- [ ] **Step 4: Update `src/services/session-mcp-runtime.ts` to resolve root
      internally for note/search tools**

  Add a helper near the runtime setup:

  ```ts
  const resolveCanonicalRuntimeRootSessionId = async (
    context: ToolContext,
    validator: RuntimeRootSessionValidator | undefined,
  ): Promise<string> => {
    const sessionId = context.sessionID;
    if (!sessionId) {
      throw new Error("session_search requires a session context");
    }
    return await validator?.resolveCanonicalSessionId(sessionId) ?? sessionId;
  };
  ```

  Then update the handlers:

  ```ts
  session_search: async (request, context) => {
    const rootSessionId = await resolveCanonicalRuntimeRootSessionId(
      context,
      sessionCanonicalizer,
    );
    return await searchLocalCorpus(rootSessionId, request.query);
  },

  session_notes_write: async (request, context) => {
    const rootSessionId = await resolveCanonicalRuntimeRootSessionId(
      context,
      sessionCanonicalizer,
    );
    return await notes.writeNote(rootSessionId, request.text, {
      replace: request.replace,
    });
  },

  session_notes_read: async (request) => {
    return await notes.readNoteById(groupId, request.id);
  },
  ```

  Also remove public `root_session_id` from the registered `args` for these
  tools.

- [ ] **Step 5: Re-run the runtime test slice and confirm it passes**

  Run:

  ```bash
  deno test -A src/services/session-mcp-runtime.test.ts
  ```

  Expected: PASS.

---

## Task 4: Update Tool Descriptions And Search-Hit Metadata

**Files:**

- Modify: `src/services/session-mcp-runtime.ts`
- Modify: `src/services/session-mcp-runtime.test.ts`
- Modify: `src/index.test.ts`

- [ ] **Step 1: Write failing description assertions for delete semantics and
      new read/search contracts**

  Replace the old description-string checks in
  `src/services/session-mcp-runtime.test.ts` with assertions like:

  ```ts
  assertStringIncludes(
    runtime.tools.session_notes_write.description,
    "If the `id` does not exist, deletion is a no-op and still returns `deleted`.",
  );
  assertStringIncludes(
    runtime.tools.session_notes_write.description,
    "If the `id` exists but is owned by another session in the same project, the delete is rejected.",
  );
  assertStringIncludes(
    runtime.tools.session_notes_read.description,
    '{ "note": null }',
  );
  assertStringIncludes(
    runtime.tools.session_search.description,
    'scope: "local" | "project"',
  );
  ```

- [ ] **Step 2: Run the description-focused test slice and confirm it fails**

  Run:

  ```bash
  deno test -A src/services/session-mcp-runtime.test.ts src/index.test.ts
  ```

  Expected: FAIL because descriptions still mention `note_id`, root-session-only
  reads, and the old `{ notes: [...] }` shape.

- [ ] **Step 3: Replace the shipped tool-description strings in
      `src/services/session-mcp-runtime.ts`**

  Replace the note tool descriptions with the new contract language. The key
  wording that must ship is:

  ```ts
  export const SESSION_NOTES_WRITE_DESCRIPTION = [
    "Pin working context as a session note so it survives topic switches, long tool",
    "loops, and compaction.",
    "",
    'Accepts `text` (markdown body) and optional `replace` (`id` for one note, or `"*"` to replace all notes for the current session).',
    "",
    "Mutation semantics:",
    "- No `replace`: create a new note with a fresh `id`.",
    '- `replace: "<id>"` with non-empty `text`: upsert that note into the current session.',
    '- `replace: "<id>"` with empty `text`: delete that note from the current session.',
    "- If the `id` does not exist, deletion is a no-op and still returns `deleted`.",
    "- If the `id` exists but is owned by another session in the same project, the write or delete is rejected.",
    '- `replace: "*"` with non-empty `text`: replace all notes for the current session with one new note.',
    '- `replace: "*"` with empty `text`: clear all notes for the current session.',
  ].join("\n");
  ```

  And update the read/search descriptions to mention:

  ```ts
  "Returns `{ note: { id, text, created_at, updated_at } }` when found and `{ note: null }` when the id is unknown.",
  "Note hits include `id`, `root_session_id`, and `scope: \"local\" | \"project\"`.",
  ```

- [ ] **Step 4: Re-run the description tests and confirm they pass**

  Run:

  ```bash
  deno test -A src/services/session-mcp-runtime.test.ts src/index.test.ts
  ```

  Expected: PASS.

---

## Task 5: Update Docs And End-To-End Verification

**Files:**

- Modify: `docs/SmokeTests.md`

- [ ] **Step 1: Update the smoke-test docs for the new runtime contract**

  In `docs/SmokeTests.md`, replace old note expectations so the live evidence
  now requires:

  ```md
  - `session_search({ query })` may return note hits with `id`, `root_session_id`,
    and `scope: "local" | "project"`.
  - `session_notes_read({ id })` reopens one note by id and returns
    `{ note: null }` on miss.
  - Same-project foreign note hits should rank below equivalent local note hits.
  - Delete-on-miss remains a successful `{ action: "deleted", id }` no-op.
  ```

- [ ] **Step 2: Run the targeted test suite for the modified files**

  Run:

  ```bash
  deno test -A src/services/session-notes.test.ts src/services/session-mcp-runtime.test.ts src/index.test.ts
  ```

  Expected: PASS.

- [ ] **Step 3: Run the full verification suite**

  Run:

  ```bash
  deno test -A
  deno task check
  deno task lint
  deno task fmt
  ```

  Expected: all PASS.

- [ ] **Step 4: Perform the final spec-to-plan coverage check before
      implementation handoff**

  Confirm each spec requirement maps to a task:

  ```md
  - dual store: Task 2
  - project-unique id: Task 2
  - rootless public note/search contracts: Tasks 1 and 3
  - delete semantics in tool descriptions: Task 4
  - cross-session note search ranking: Tasks 2 and 3
  - current-session-only compaction behavior: preserved by architecture; no code
    change required, but covered by regression awareness during full test run
  ```

  Expected: no uncovered spec requirements remain.

---

## Notes For The Implementer

- Do not add routing nudges, bootstrap prompt logic, or subagent logic here.
  That work is intentionally out of scope for this plan.
- Do not run git commands unless explicitly requested by the user.
- Keep compaction behavior current-session-only even though note search becomes
  same-project aware.
- Preserve legacy note reads/searches by normalizing legacy values on read and
  rewriting touched entries in the new shape on write.
