import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import * as sessionModule from "./session.ts";
import { setSuppressConsoleWarningsDuringTestsOverride } from "./services/opencode-warning.ts";
import { RedisClient } from "./services/redis-client.ts";
import { createSessionCorpusService } from "./services/session-corpus.ts";

const { SessionManager } = sessionModule;

const createExplicitSessionNotFoundError = (
  details: Record<string, unknown> = { status: 404 },
): Error => Object.assign(new Error("Session not found"), details);

const emptyCache = {
  get() {
    return null;
  },
  getMeta() {
    return null;
  },
  renderPersistentMemory() {
    return { body: "", nodeRefs: [] };
  },
  classifyRefresh() {
    return {
      classification: "miss",
      shouldRefresh: true,
      similarity: 0,
      threshold: 0.5,
      cachedQuery: null,
    };
  },
};

const createSessionManagerForInjection = (
  notes: Array<{
    id: string;
    text: string;
    created_at: string;
    updated_at: string;
  }> = [],
) => {
  const readNotesCalls: Array<{ sessionId: string; noteId?: string }> = [];
  const manager = new SessionManager(
    "group-notes",
    "user-notes",
    { session: {} } as never,
    {
      getRecentSessionEvents() {
        return [{
          id: "evt-1",
          ts: Date.now(),
          category: "intent",
          priority: 0,
          role: "user",
          summary: "Continue compaction work",
        }];
      },
      recallSessionEvents() {
        return [];
      },
    } as never,
    {
      getSnapshot() {
        return "<snapshot><summary>Current snapshot</summary></snapshot>";
      },
    } as never,
    emptyCache as never,
    {
      notesService: {
        readNotes(sessionId: string, noteId?: string) {
          readNotesCalls.push({ sessionId, noteId });
          return { notes };
        },
      } as never,
    },
  );

  manager.setParentId("session-1", null);
  manager.setState(
    "session-1",
    manager.createDefaultState("group-notes", "user-notes"),
  );

  return { manager, readNotesCalls };
};

describe("SessionManager Task 6 runtime migration", () => {
  it("resolves child sessions to the canonical parent root session id", async () => {
    const manager = new SessionManager(
      "group-task-1",
      "user-task-1",
      {
        session: {
          get() {
            throw createExplicitSessionNotFoundError();
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    manager.setParentId("root-session", null);
    manager.setParentId("child-session", "root-session");

    assertEquals(
      await manager.resolveCanonicalSessionId("child-session"),
      "root-session",
    );
  });

  it("migrates temporary-root corpora and stats onto the canonical parent root", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 120,
      groupId: "group-task-6",
    });
    const manager = new SessionManager(
      "group-task-6",
      "user-task-6",
      {
        session: {
          get() {
            throw createExplicitSessionNotFoundError();
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        runtimeStateMigrator: {
          migrateRootSessionState: (
            sourceSessionId: string,
            canonicalSessionId: string,
          ) =>
            corpus.migrateRootSessionState(sourceSessionId, canonicalSessionId),
        },
      } as never,
    );

    await manager.resolveCanonicalSessionId("child-session");
    const parentIndexed = await corpus.index({
      rootSessionId: "parent-session",
      content: ["# Parent Root", "", "Canonical parent corpus lives here."]
        .join("\n"),
    });
    const childIndexed = await corpus.index({
      rootSessionId: "child-session",
      content: ["# Child Root", "", "Temporary child corpus migrates here."]
        .join("\n"),
    });

    manager.setParentId("parent-session", null);
    manager.setParentId("child-session", "parent-session");
    const resolved = await manager.resolveSessionState("child-session");
    const search = await corpus.search({
      rootSessionId: "parent-session",
      query: "canonical migrates",
    });
    const stats = await corpus.getStats("parent-session");

    assertEquals(resolved.canonicalSessionId, "parent-session");
    assertEquals(search.corpusRefs.includes(parentIndexed.corpusRef), true);
    assertEquals(search.corpusRefs.includes(childIndexed.corpusRef), false);
    assertEquals(
      search.results.some((result) =>
        result.snippet.includes("Temporary child corpus migrates here")
      ),
      true,
    );
    assertEquals(stats.corpusCount, 2);
  });

  it("does not delete root-owned corpora or stats when deleting a child after migration", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 120,
      groupId: "group-task-6-delete",
    });
    const manager = new SessionManager(
      "group-task-6-delete",
      "user-task-6-delete",
      {
        session: {
          get() {
            throw createExplicitSessionNotFoundError();
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        runtimeStateMigrator: {
          migrateRootSessionState: (
            sourceSessionId: string,
            canonicalSessionId: string,
          ) =>
            corpus.migrateRootSessionState(sourceSessionId, canonicalSessionId),
        },
      } as never,
    );

    await manager.resolveCanonicalSessionId("child-session");
    await corpus.storeArtifact({
      rootSessionId: "child-session",
      toolName: "session_execute",
      body: "child artifact body survives migration",
    });

    manager.setParentId("parent-session", null);
    manager.setParentId("child-session", "parent-session");
    await manager.resolveSessionState("child-session");
    manager.deleteSession("child-session");

    const search = await corpus.search({
      rootSessionId: "parent-session",
      query: "artifact survives migration",
    });
    const stats = await corpus.getStats("parent-session");

    assertEquals(search.results.length > 0, true);
    assertEquals(stats.artifactCount, 1);
    assertEquals(stats.corpusCount, 1);
  });

  it("surfaces temporary-root runtime migration failures instead of continuing with split ownership", async () => {
    const originalWarn = console.warn;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
    setSuppressConsoleWarningsDuringTestsOverride(true);

    const manager = new SessionManager(
      "group-task-6-failure",
      "user-task-6-failure",
      {
        session: {
          get() {
            throw createExplicitSessionNotFoundError();
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        runtimeStateMigrator: {
          migrateRootSessionState: () =>
            Promise.reject(new Error("migration failed")),
        },
      } as never,
    );

    try {
      await manager.resolveCanonicalSessionId("child-session");
      manager.setParentId("parent-session", null);
      manager.setParentId("child-session", "parent-session");

      await assertRejects(
        () => manager.resolveCanonicalSessionId("child-session"),
        Error,
        "migration failed",
      );
      assertEquals(warnCalls, []);
    } finally {
      setSuppressConsoleWarningsDuringTestsOverride(undefined);
      console.warn = originalWarn;
    }
  });

  it("retries temporary-root runtime migration after a transient failure", async () => {
    let childLookupCount = 0;
    let migrationAttempts = 0;
    const manager = new SessionManager(
      "group-task-6-retry",
      "user-task-6-retry",
      {
        session: {
          get({ path }: { path: { id: string } }) {
            if (path.id === "child-session") {
              childLookupCount += 1;
              if (childLookupCount === 1) {
                throw createExplicitSessionNotFoundError();
              }
              return { data: { parentID: "parent-session" } };
            }
            if (path.id === "parent-session") {
              return { data: { parentID: null } };
            }
            throw new Error(`Unexpected session lookup: ${path.id}`);
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        runtimeStateMigrator: {
          migrateRootSessionState: () => {
            migrationAttempts += 1;
            if (migrationAttempts === 1) {
              return Promise.reject(new Error("transient migration failure"));
            }
            return Promise.resolve();
          },
        },
      } as never,
    );

    await manager.resolveCanonicalSessionId("child-session");

    await assertRejects(
      () => manager.resolveCanonicalSessionId("child-session"),
      Error,
      "transient migration failure",
    );
    assertEquals(
      await manager.resolveCanonicalSessionId("child-session"),
      "parent-session",
    );
    assertEquals(migrationAttempts, 2);
  });

  it("accepts a canonical child root only when it matches the resolved lineage", async () => {
    const manager = new SessionManager(
      "group-task-2-lineage",
      "user-task-2-lineage",
      {
        session: {
          get() {
            throw createExplicitSessionNotFoundError();
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    manager.setParentId("root-session", null);
    manager.setParentId("child-session", "root-session");

    assertEquals(
      await manager.validateRuntimeRootSessionId(
        "child-session",
        "root-session",
      ),
      "root-session",
    );
    await assertRejects(
      () => manager.validateRuntimeRootSessionId("child-session", "wrong-root"),
      Error,
      "root_session_id mismatch",
    );
  });

  it("keeps provisional temporary roots valid until a canonical migration resolves them", async () => {
    let childLookupCount = 0;
    const manager = new SessionManager(
      "group-task-2-provisional",
      "user-task-2-provisional",
      {
        session: {
          get({ path }: { path: { id: string } }) {
            if (path.id === "child-session") {
              childLookupCount += 1;
              if (childLookupCount === 1) {
                throw createExplicitSessionNotFoundError();
              }
              return { data: { parentID: "parent-session" } };
            }
            if (path.id === "parent-session") {
              return { data: { parentID: null } };
            }
            throw new Error(`Unexpected session lookup: ${path.id}`);
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    assertEquals(
      await manager.validateRuntimeRootSessionId(
        "child-session",
        "child-session",
      ),
      "child-session",
    );
    assertEquals(
      await manager.validateRuntimeRootSessionId(
        "child-session",
        "parent-session",
      ),
      "parent-session",
    );
    await assertRejects(
      () =>
        manager.validateRuntimeRootSessionId("child-session", "child-session"),
      Error,
      "root_session_id mismatch",
    );
  });

  it("does not expose the dead global runtime validator API", () => {
    assertEquals(
      "getRegisteredRuntimeRootSessionValidator" in sessionModule,
      false,
    );
    assertEquals(
      "setRegisteredRuntimeRootSessionValidator" in sessionModule,
      false,
    );
  });
});

describe("SessionManager compaction notes injection", () => {
  it("includes full session_notes with note ids and timestamps for compaction", async () => {
    const { manager, readNotesCalls } = createSessionManagerForInjection([
      {
        id: "note-1",
        text: "First full note body",
        created_at: "2026-04-10T10:00:00.000Z",
        updated_at: "2026-04-10T10:05:00.000Z",
      },
      {
        id: "note-2",
        text: "Second full note body",
        created_at: "2026-04-10T11:00:00.000Z",
        updated_at: "2026-04-10T11:05:00.000Z",
      },
    ]);

    const prepared = await manager.prepareInjection(
      "session-1",
      undefined,
      { forCompaction: true },
    );

    assertEquals(readNotesCalls, [{
      sessionId: "session-1",
      noteId: undefined,
    }]);
    assertStringIncludes(
      prepared?.envelope ?? "",
      '<session_notes source="note_tools">',
    );
    assertStringIncludes(
      prepared?.envelope ?? "",
      '<note id="note-1" created="2026-04-10T10:00:00.000Z" updated="2026-04-10T10:05:00.000Z">First full note body</note>',
    );
    assertStringIncludes(
      prepared?.envelope ?? "",
      '<note id="note-2" created="2026-04-10T11:00:00.000Z" updated="2026-04-10T11:05:00.000Z">Second full note body</note>',
    );
  });

  it("escapes XML special characters in rendered compaction notes", async () => {
    const { manager } = createSessionManagerForInjection([
      {
        id: `note-&<>'"`,
        text: `Keep <tag> & "quotes" and 'apostrophes' safe`,
        created_at: `2026-04-10T10:00:00&<>'"Z`,
        updated_at: `2026-04-10T10:05:00&<>'"Z`,
      },
    ]);

    const prepared = await manager.prepareInjection(
      "session-1",
      undefined,
      { forCompaction: true },
    );

    assertStringIncludes(
      prepared?.envelope ?? "",
      '<note id="note-&amp;&lt;&gt;&apos;&quot;" created="2026-04-10T10:00:00&amp;&lt;&gt;&apos;&quot;Z" updated="2026-04-10T10:05:00&amp;&lt;&gt;&apos;&quot;Z">Keep &lt;tag&gt; &amp; &quot;quotes&quot; and &apos;apostrophes&apos; safe</note>',
    );
  });

  it("omits session_notes during compaction when no notes exist", async () => {
    const { manager, readNotesCalls } = createSessionManagerForInjection([]);

    const prepared = await manager.prepareInjection(
      "session-1",
      undefined,
      { forCompaction: true },
    );

    assertEquals(readNotesCalls, [{
      sessionId: "session-1",
      noteId: undefined,
    }]);
    assertEquals(
      (prepared?.envelope ?? "").includes("<session_notes"),
      false,
    );
  });

  it("omits session_notes on the normal non-compaction prepareInjection path", async () => {
    const { manager, readNotesCalls } = createSessionManagerForInjection([
      {
        id: "note-1",
        text: "Should stay out of normal injection",
        created_at: "2026-04-10T10:00:00.000Z",
        updated_at: "2026-04-10T10:05:00.000Z",
      },
    ]);

    const prepared = await manager.prepareInjection("session-1", "continue");

    assertEquals(readNotesCalls, []);
    assertEquals(
      (prepared?.envelope ?? "").includes("<session_notes"),
      false,
    );
  });
});
