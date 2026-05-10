# Session Notes Freshness Without TTL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make session notes durable without TTL, rank note hits by relevance
plus write/read freshness, allow same-project delete-by-id, and expose
`created_at` plus `updated_at` on `session_search` note results.

**Architecture:** Keep the existing two-store note model, but remove TTL from
the session-local note hash, extend the project note record with `last_read_at`,
and move note ranking from the old local-vs-project multiplier to a
freshness-based score. Preserve the existing tool surface and compaction
boundary, while updating the note service and MCP response schema so freshness
metadata is observable and testable.

**Tech Stack:** Deno, TypeScript, Zod schemas, in-memory Redis test double via
`RedisClient`, existing `session_*` MCP runtime and note service tests.

---

## File Map

- Modify: `src/services/session-notes.ts` Responsibility: note storage, project
  note metadata, delete semantics, read freshness updates, note ranking, note
  hit shape.
- Modify: `src/services/session-notes.test.ts` Responsibility: note
  persistence/no-TTL behavior, same-project delete semantics, read freshness,
  ranking expectations, returned timestamps.
- Modify: `src/services/session-mcp-types.ts` Responsibility: public
  `session_search` response schema already supports note timestamps; verify and
  align any note-result typing if needed.
- Modify: `src/services/session-mcp-runtime.ts` Responsibility: keep tool
  descriptions aligned with search/read behavior and make sure runtime wiring
  still constructs `SessionNotesService` correctly after option changes.
- Modify: `src/services/session-mcp-runtime.test.ts` Responsibility: assert
  public `session_search` note hits include `created_at` and `updated_at`, and
  that `session_notes_read` remains the exact reopen path.
- Modify: `src/index.ts` Responsibility: pass the updated note-service options
  from config/runtime setup.
- Modify: `src/index.test.ts` Responsibility: assert entrypoint wiring matches
  the updated `SessionNotesService` constructor options.
- Modify: `docs/SmokeTests.md` Responsibility: update manual validation guidance
  for durable notes, same-project deletion, and freshness-aware ranking.

### Task 1: Lock The Public Search Contract First

**Files:**

- Modify: `src/services/session-mcp-runtime.test.ts`
- Modify: `src/services/session-mcp-types.ts`

- [ ] **Step 1: Add a failing runtime test for timestamped note hits**

Add a focused test near the existing note-tool/runtime coverage in
`src/services/session-mcp-runtime.test.ts`:

```ts
it("returns note hits with created_at and updated_at in session_search", async () => {
  const redis = new RedisClient({ endpoint: "redis://unused" });
  const runtime = createSessionMcpRuntime({
    redisClient: redis,
    groupId: "group-note-search-shape",
    sessionTtlSeconds: 60,
  } as never);

  try {
    await runtime.tools.session_notes_write.execute(
      { text: "## Redis freshness\nTrack note ranking with timestamps." },
      createToolContext({
        sessionID: "root-note-shape",
        worktree: Deno.cwd(),
        directory: Deno.cwd(),
      }),
    );

    const search = JSON.parse(
      await runtime.tools.session_search.execute(
        { query: "redis freshness" },
        createToolContext({
          sessionID: "root-note-shape",
          worktree: Deno.cwd(),
          directory: Deno.cwd(),
        }),
      ),
    );

    const noteHit = search.results.find((result: { type: string }) =>
      result.type === "note"
    );
    assertExists(noteHit);
    assertEquals(typeof noteHit.created_at, "string");
    assertEquals(typeof noteHit.updated_at, "string");
  } finally {
    await runtime.dispose();
  }
});
```

- [ ] **Step 2: Run the focused runtime test and confirm it fails for the right
      reason**

Run:
`deno test -A src/services/session-mcp-runtime.test.ts --filter "returns note hits with created_at and updated_at in session_search"`

Expected: FAIL because note hits currently omit one or both timestamps.

- [ ] **Step 3: Align the search result schema if needed**

Make the note-hit timestamp fields explicit in
`src/services/session-mcp-types.ts` if the new test shows a schema mismatch. The
relevant shape should stay equivalent to:

```ts
const searchResultSchema = z.object({
  ref: z.string().min(1),
  snippet: z.string(),
  score: z.number(),
  type: z.enum(["entry", "note", "summary"]),
  id: z.string().min(1).optional(),
  root_session_id: z.string().min(1).optional(),
  scope: z.enum(["session", "local", "project"]).optional(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1).optional(),
  granularity: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
}).strict();
```

If the schema already matches, leave this file unchanged.

- [ ] **Step 4: Re-run the focused runtime test**

Run:
`deno test -A src/services/session-mcp-runtime.test.ts --filter "returns note hits with created_at and updated_at in session_search"`

Expected: PASS.

### Task 2: Remove Session-Note TTL And Add Read Metadata

**Files:**

- Modify: `src/services/session-notes.test.ts`
- Modify: `src/services/session-notes.ts`

- [ ] **Step 1: Replace the TTL-refresh test with a durable-note test**

Update the first note-service test in `src/services/session-notes.test.ts` so it
proves the local session hash has no TTL and reads do not reintroduce one:

```ts
it("appends and reads durable notes without setting a session TTL", async () => {
  const redis = createRedis();
  const service = new SessionNotesService(redis, {
    groupId: "project-1",
    createNoteId: createSequence(["note-1", "note-2"]),
    now: createClock(
      "2026-04-11T10:00:00.000Z",
      "2026-04-11T10:00:01.000Z",
      "2026-04-11T10:00:02.000Z",
    ),
  });

  await service.writeNote("root-1", "## First note");
  await service.writeNote("root-1", "## Second note");

  const key = sessionNotesKey("root-1");
  const writtenSnapshot = await redis.snapshot(key);
  assertEquals(writtenSnapshot.kind, "hash");
  if (writtenSnapshot.kind === "hash") {
    assertEquals(writtenSnapshot.ttlSeconds, null);
  }

  await service.readNotes("root-1");

  const readSnapshot = await redis.snapshot(key);
  assertEquals(readSnapshot.kind, "hash");
  if (readSnapshot.kind === "hash") {
    assertEquals(readSnapshot.ttlSeconds, null);
  }
});
```

- [ ] **Step 2: Add a failing read-freshness test**

Add a new test in `src/services/session-notes.test.ts`:

```ts
it("updates last_read_at when reopening a note", async () => {
  const redis = createRedis();
  const service = new SessionNotesService(redis, {
    groupId: "project-1",
    createNoteId: createSequence(["note-1"]),
    now: createClock(
      "2026-04-11T16:00:00.000Z",
      "2026-04-11T16:05:00.000Z",
    ),
  });

  await service.writeNote("root-a", "useful note body");
  await service.readNote("note-1");

  const projectSnapshot = await redis.snapshot("session:notes:project-1");
  assertEquals(projectSnapshot.kind, "hash");
  if (projectSnapshot.kind === "hash") {
    const stored = JSON.parse(projectSnapshot.values["note-1"]!);
    assertEquals(stored.last_read_at, "2026-04-11T16:05:00.000Z");
  }
});
```

- [ ] **Step 3: Run the note-service tests to verify the red state**

Run: `deno test -A src/services/session-notes.test.ts`

Expected: FAIL because the service still sets and refreshes TTL, and
`readNote()` does not record `last_read_at`.

- [ ] **Step 4: Remove TTL from the note-service option surface and storage
      writes**

In `src/services/session-notes.ts`, make the constructor options and write paths
stop requiring or using `sessionTtlSeconds`:

```ts
type SessionNotesServiceOptions = {
  groupId: string;
  now?: () => Date;
  createNoteId?: () => string;
};
```

Update the write helpers to stop passing TTL values:

```ts
private async writeNotesHash(
  rootSessionId: string,
  notes: ReadonlyMap<string, StoredNote>,
): Promise<void> {
  const key = sessionNotesKey(rootSessionId);
  if (notes.size === 0) {
    await this.redis.deleteKey(key);
    return;
  }

  await this.redis.deleteKey(key);
  await this.redis.setHashFields(
    key,
    Object.fromEntries(
      [...notes.entries()].map(([noteId, note]) => [noteId, JSON.stringify(note)]),
    ),
  );
}

private async writeSingleNote(
  rootSessionId: string,
  noteId: string,
  note: StoredNote,
): Promise<void> {
  await this.redis.setHashFields(sessionNotesKey(rootSessionId), {
    [noteId]: JSON.stringify(note),
  });
}
```

Remove the read-time TTL refresh from `readNotes()` entirely.

- [ ] **Step 5: Extend project-note parsing and persistence for `last_read_at`**

Update `StoredProjectNote`, the parser, and the project-note writers in
`src/services/session-notes.ts`:

```ts
type StoredProjectNote = StoredNote & {
  root_session_id: string;
  last_read_at?: string | null;
};
```

```ts
const parseStoredProjectNote = (value: string): StoredProjectNote | null => {
  try {
    const parsed = JSON.parse(value) as Partial<StoredProjectNote> & {
      rootSessionId?: string;
    };
    if (
      typeof parsed.text !== "string" ||
      typeof parsed.created_at !== "string" ||
      typeof parsed.updated_at !== "string"
    ) {
      return null;
    }

    const rootSessionId = typeof parsed.root_session_id === "string"
      ? parsed.root_session_id
      : typeof parsed.rootSessionId === "string"
      ? parsed.rootSessionId
      : null;
    if (!rootSessionId) return null;

    return {
      text: parsed.text,
      created_at: parsed.created_at,
      updated_at: parsed.updated_at,
      root_session_id: rootSessionId,
      last_read_at: typeof parsed.last_read_at === "string"
        ? parsed.last_read_at
        : null,
    };
  } catch {
    return null;
  }
};
```

- [ ] **Step 6: Update `readNote()` to record `last_read_at` on successful
      reads**

In `src/services/session-notes.ts`, update `readNote()` along these lines:

```ts
async readNote(noteId: string): Promise<{ note: SessionNote | null }> {
  const projectNotes = await this.loadProjectNotes();
  const note = projectNotes.get(noteId);
  if (!note) return { note: null };

  const lastReadAt = this.now().toISOString();
  await this.writeSingleProjectNote(noteId, {
    ...note,
    last_read_at: lastReadAt,
  });

  return {
    note: {
      id: noteId,
      text: note.text,
      created_at: note.created_at,
      updated_at: note.updated_at,
    },
  };
}
```

- [ ] **Step 7: Re-run the note-service tests**

Run: `deno test -A src/services/session-notes.test.ts`

Expected: PASS for the durable-note and read-freshness tests.

### Task 3: Change Delete Semantics To Same-Project Scope

**Files:**

- Modify: `src/services/session-notes.test.ts`
- Modify: `src/services/session-notes.ts`

- [ ] **Step 1: Turn the foreign-session delete rejection into a failing
      cross-session delete success test**

Replace the current delete rejection assertion in
`src/services/session-notes.test.ts` with:

```ts
const crossSessionDelete = await service.writeNote("root-a", "", {
  replace: "note-3",
});
assertEquals(crossSessionDelete, { action: "deleted", id: "note-3" });
assertEquals(await service.readNotes("root-b"), { notes: [] });
assertEquals(await service.readNote("note-3"), { note: null });
```

- [ ] **Step 2: Run the focused replace/clear test and confirm the red state**

Run:
`deno test -A src/services/session-notes.test.ts --filter "supports replace and clear semantics within a single root session"`

Expected: FAIL because delete still throws on foreign-session ownership.

- [ ] **Step 3: Narrow ownership checks to non-empty replace writes only**

Adjust the `replace` branch in `src/services/session-notes.ts` so only non-empty
writes reject foreign ownership:

```ts
if (replace) {
  const projectNote = projectNotes.get(replace);

  if (text === "") {
    if (!projectNote) {
      notes.delete(replace);
      await this.writeNotesHash(rootSessionId, notes);
      return { action: "deleted", id: replace };
    }

    const ownerNotes = await this.loadNotes(projectNote.root_session_id);
    await this.deleteOwnedNote(
      projectNote.root_session_id,
      replace,
      ownerNotes,
      projectNotes,
    );
    return { action: "deleted", id: replace };
  }

  if (projectNote && projectNote.root_session_id !== rootSessionId) {
    throw new Error(`Note ${replace} is owned by another session`);
  }

  // existing upsert logic continues here
}
```

- [ ] **Step 4: Re-run the focused replace/clear test**

Run:
`deno test -A src/services/session-notes.test.ts --filter "supports replace and clear semantics within a single root session"`

Expected: PASS.

### Task 4: Replace The Hard-Coded Locality Penalty With Freshness Ranking

**Files:**

- Modify: `src/services/session-notes.test.ts`
- Modify: `src/services/session-notes.ts`

- [ ] **Step 1: Replace the old ranking expectations with failing
      freshness-driven tests**

Add or rewrite tests in `src/services/session-notes.test.ts` to cover:

```ts
it("includes created_at and updated_at on note search hits", async () => {
  const redis = createRedis();
  const service = new SessionNotesService(redis, {
    groupId: "project-1",
    createNoteId: createSequence(["note-1"]),
    now: createClock("2026-04-11T12:00:00.000Z"),
  });

  await service.writeNote("root-search", "timestamped note body");
  const [hit] = await service.searchNotes("root-search", "timestamped");

  assert(hit);
  assertEquals(hit.created_at, "2026-04-11T12:00:00.000Z");
  assertEquals(hit.updated_at, "2026-04-11T12:00:00.000Z");
});
```

```ts
it("ranks an old recently read note above a newer weaker match", async () => {
  const redis = createRedis();
  const service = new SessionNotesService(redis, {
    groupId: "project-1",
    createNoteId: createSequence(["note-1", "note-2"]),
    now: createClock(
      "2026-01-01T00:00:00.000Z",
      "2026-04-01T00:00:00.000Z",
      "2026-04-11T00:00:00.000Z",
      "2026-04-11T00:10:00.000Z",
    ),
  });

  await service.writeNote(
    "root-old",
    "graphiti async drain retry and dead-letter recovery",
  );
  await service.writeNote(
    "root-new",
    "graphiti retry",
  );
  await service.readNote("note-1");

  const [first, second] = await service.searchNotes(
    "root-new",
    "graphiti async drain retry dead-letter",
  );

  assertEquals(first?.id, "note-1");
  assertEquals(second?.id, "note-2");
  assert(first!.score > second!.score);
});
```

- [ ] **Step 2: Run the targeted freshness-ranking tests and confirm they fail**

Run:
`deno test -A src/services/session-notes.test.ts --filter "note search hits|recently read note"`

Expected: FAIL because search hits do not return timestamps and still use the
old `* 0.85` project penalty.

- [ ] **Step 3: Add timestamp fields to `SessionNoteSearchHit` and implement
      freshness helpers**

In `src/services/session-notes.ts`, extend the hit type and add the smallest
helper set needed:

```ts
export type SessionNoteSearchHit = {
  id: string;
  root_session_id: string;
  scope: "local" | "project";
  snippet: string;
  score: number;
  created_at: string;
  updated_at: string;
};
```

```ts
const WRITE_FRESHNESS_HALF_LIFE_DAYS = 30;
const READ_FRESHNESS_HALF_LIFE_DAYS = 14;
const READ_FRESHNESS_ALPHA = 0.35;
const SCORE_EPSILON = 1e-6;

const ageInDays = (now: Date, iso: string): number =>
  Math.max(0, (now.getTime() - new Date(iso).getTime()) / 86_400_000);

const exponentialFreshness = (ageDays: number, halfLifeDays: number): number =>
  Math.exp(-Math.log(2) * ageDays / halfLifeDays);
```

- [ ] **Step 4: Implement freshness-based note scoring and local tie-breaks**

In `src/services/session-notes.ts`, replace the old project penalty logic in
`searchNotes()` with score composition equivalent to:

```ts
const toSearchHit = (
  note: {
    id: string;
    text: string;
    created_at: string;
    updated_at: string;
    root_session_id: string;
    last_read_at?: string | null;
  },
  scope: "local" | "project",
  currentRootSessionId: string,
): SessionNoteSearchHit & { locality_rank: number } => {
  const relevance = scoreNote(note.text, normalizedQuery);
  const write_freshness = exponentialFreshness(
    ageInDays(now, note.updated_at),
    WRITE_FRESHNESS_HALF_LIFE_DAYS,
  );
  const read_freshness = 1 + READ_FRESHNESS_ALPHA * exponentialFreshness(
        note.last_read_at
          ? ageInDays(now, note.last_read_at)
          : Number.POSITIVE_INFINITY,
        READ_FRESHNESS_HALF_LIFE_DAYS,
      );

  return {
    id: note.id,
    root_session_id: note.root_session_id ?? currentRootSessionId,
    scope,
    snippet: buildSnippet(note.text, normalizedQuery),
    score: clampScore(relevance * write_freshness * read_freshness),
    created_at: note.created_at,
    updated_at: note.updated_at,
    locality_rank: scope === "local" ? 0 : 1,
  };
};
```

Update sort behavior so it prefers higher score, then local scope only for
effectively equal scores, then newer `updated_at`, then `id`.

- [ ] **Step 5: Re-run the full note-service test file**

Run: `deno test -A src/services/session-notes.test.ts`

Expected: PASS.

### Task 5: Update Entrypoint Wiring And Tool Descriptions

**Files:**

- Modify: `src/index.ts`
- Modify: `src/index.test.ts`
- Modify: `src/services/session-mcp-runtime.ts`

- [ ] **Step 1: Add a failing entrypoint wiring assertion for the new
      note-service options**

Update the `MockSessionNotesService` constructor shape in `src/index.test.ts`:

```ts
class MockSessionNotesService {
  constructor(
    redisClient: unknown,
    options: { groupId: string },
  ) {
    records.sessionNotesArgs.push([redisClient, options]);
    records.sessionNotesInstances.push(this);
  }
}
```

Update the corresponding assertions so they expect only `groupId`.

- [ ] **Step 2: Run the focused entrypoint test and confirm it fails**

Run: `deno test -A src/index.test.ts --filter "SessionNotesService"`

Expected: FAIL because `src/index.ts` still passes `sessionTtlSeconds`.

- [ ] **Step 3: Remove `sessionTtlSeconds` from note-service construction and
      refresh the note-tool wording**

Update `src/index.ts` to construct the note service like this:

```ts
const notesService = new dependencies.SessionNotesService(redisClient, {
  groupId: defaultGroupId,
});
```

In `src/services/session-mcp-runtime.ts`, keep the search/read descriptions
aligned with the new behavior. The descriptions should continue to say search
returns note hits and `session_notes_read` reopens the full note text, while
avoiding wording that implies TTL-based note retention.

- [ ] **Step 4: Re-run the focused entrypoint test**

Run: `deno test -A src/index.test.ts --filter "SessionNotesService"`

Expected: PASS.

### Task 6: Update Smoke-Test Documentation And Run Full Verification

**Files:**

- Modify: `docs/SmokeTests.md`

- [ ] **Step 1: Update the smoke-test manual for durable notes and
      freshness-aware ranking**

Add or revise the relevant note sections in `docs/SmokeTests.md` so they
explicitly check:

```md
- Session notes persist without TTL expiry until explicitly deleted.
- `session_search` note hits include `created_at` and `updated_at`.
- Same-project sessions can delete obsolete note ids from earlier sessions.
- Reopening a note through `session_notes_read` contributes to read freshness,
  which can keep an older but useful note competitive in later searches.
```

- [ ] **Step 2: Run the targeted verification commands**

Run:

```bash
deno test -A src/services/session-notes.test.ts
deno test -A src/services/session-mcp-runtime.test.ts --filter "note"
deno test -A src/index.test.ts --filter "SessionNotesService"
```

Expected: PASS.

- [ ] **Step 3: Run full project verification**

Run:

```bash
deno test -A
deno task check
deno task lint
deno task fmt --check
```

Expected: PASS with no new failures.
