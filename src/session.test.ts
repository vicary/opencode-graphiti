import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { SessionManager } from "./session.ts";
import { setSuppressConsoleWarningsDuringTestsOverride } from "./services/opencode-warning.ts";
import { RedisClient } from "./services/redis-client.ts";
import { createSessionCorpusService } from "./services/session-corpus.ts";

const createExplicitSessionNotFoundError = (
  details: Record<string, unknown> = { status: 404 },
): Error => Object.assign(new Error("Session not found"), details);

describe("SessionManager Task 6 runtime migration", () => {
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
});
