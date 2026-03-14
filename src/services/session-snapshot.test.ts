import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { SessionManager } from "../session.ts";
import type { PersistentMemoryCacheEntry } from "../types/index.ts";
import { buildSessionSnapshotXml } from "./redis-snapshot.ts";

class FakeClock {
  now = 0;
  nextId = 1;
  timers = new Map<number, { at: number; callback: () => void }>();

  setTimer = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delayMs, callback });
    return id;
  };

  clearTimer = (id: number): void => {
    this.timers.delete(id);
  };

  tick(delayMs: number): void {
    const target = this.now + delayMs;
    while (true) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)
        .find(([, timer]) => timer.at <= target);
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.now = timer.at;
      timer.callback();
    }
    this.now = target;
  }
}

describe("SessionManager", () => {
  it("createDefaultState includes the new hot-tier fields", () => {
    const manager = new SessionManager(
      "group-1",
      "user-1",
      { session: {} } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const state = manager.createDefaultState("group-1", "user-1");
    assertEquals(state.hotTierReady, false);
    assertEquals(state.pendingInjection, undefined);
    assertEquals(state.latestUserRequest, undefined);
    assertEquals(state.latestRefreshQuery, undefined);
    assertEquals(state.pendingInjectionGeneration, 0);
  });

  it("prepareInjection builds canonical session_memory with optional persistent_memory", async () => {
    const manager = new SessionManager(
      "group-1",
      "user-1",
      { session: {} } as never,
      {
        recallSessionEvents() {
          return [];
        },
        getRecentSessionEvents() {
          return [
            {
              id: "1",
              ts: Date.now(),
              category: "intent",
              priority: 0,
              role: "user",
              summary: "Continue the overhaul",
              continuityText:
                "Continue the overhaul using structured continuity fields",
            },
            {
              id: "2",
              ts: Date.now(),
              category: "decision",
              priority: 0,
              role: "user",
              summary: "Keep Graphiti off the hot path",
              continuityText:
                "Keep Graphiti off the hot path and rely on structured continuity in session memory",
            },
          ];
        },
      } as never,
      {
        getSnapshot() {
          return '<snapshot session="session-1" version="2"></snapshot>';
        },
      } as never,
      {
        get() {
          return {
            query: "Continue the overhaul",
            refreshedAt: Date.now(),
            facts: [{
              uuid: "fact-1",
              fact: "The user prefers local injection",
            }],
            nodes: [{ uuid: "node-1", name: "Context Overhaul" }],
            factUuids: ["fact-1"],
            nodeRefs: ["node-1"],
          };
        },
        renderPersistentMemory() {
          return {
            body: "<fact>The user prefers local injection</fact>",
            factUuids: ["fact-1"],
            nodeRefs: ["node-1"],
          };
        },
        getMeta() {
          return null;
        },
        classifyRefresh() {
          return {
            classification: "aligned",
            shouldRefresh: false,
            similarity: 1,
            threshold: 0.5,
            cachedQuery: "Continue the overhaul",
          };
        },
      } as never,
    );

    manager.setParentId("session-1", null);
    manager.setState(
      "session-1",
      manager.createDefaultState("group-1", "user-1"),
    );
    const prepared = await manager.prepareInjection(
      "session-1",
      "Continue the overhaul",
    );

    assertStringIncludes(prepared?.envelope ?? "", "<session_memory");
    assertStringIncludes(prepared?.envelope ?? "", "<persistent_memory");
    assertStringIncludes(
      prepared?.envelope ?? "",
      "Keep Graphiti off the hot path",
    );
    assertEquals(prepared?.factUuids, ["fact-1"]);
    assertEquals(prepared?.refreshDecision.classification, "aligned");
  });

  it("snapshot and injection preserve continuity from structured fields without body text", async () => {
    const decisionText =
      "Keep structured continuity summaries in session memory instead of transcript bodies";
    const snapshot = buildSessionSnapshotXml("session-1", [
      {
        id: "1",
        ts: Date.now() - 1,
        category: "decision",
        priority: 0,
        role: "user",
        summary: "Keep structured continuity summaries",
        continuityText: decisionText,
      },
      {
        id: "2",
        ts: Date.now(),
        category: "message",
        priority: 4,
        role: "user",
        summary: "continue",
        continuityText:
          "continue with continuity-first session memory injection semantics",
      },
    ]);

    assertStringIncludes(snapshot, decisionText);

    const manager = new SessionManager(
      "group-1",
      "user-1",
      { session: {} } as never,
      {
        recallSessionEvents() {
          return [];
        },
        getRecentSessionEvents() {
          return [{
            id: "1",
            ts: Date.now(),
            category: "decision",
            priority: 0,
            role: "user",
            summary: "Keep structured continuity summaries",
            continuityText: decisionText,
          }, {
            id: "2",
            ts: Date.now() + 1,
            category: "intent",
            priority: 0,
            role: "user",
            summary: "continue",
            continuityText:
              "continue with continuity-first session memory injection semantics",
          }];
        },
      } as never,
      {
        getSnapshot() {
          return snapshot;
        },
      } as never,
      {
        get() {
          return null;
        },
        getMeta() {
          return null;
        },
        renderPersistentMemory() {
          return { body: "", factUuids: [], nodeRefs: [] };
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
      } as never,
    );

    manager.setParentId("session-1", null);
    manager.setState(
      "session-1",
      manager.createDefaultState("group-1", "user-1"),
    );
    const prepared = await manager.prepareInjection("session-1", "continue");

    assertStringIncludes(prepared?.envelope ?? "", decisionText);
    assertEquals(prepared?.envelope.includes("<session_snapshot>"), true);
  });

  it("prepareInjection prefers the freshest user event over stale fallback", async () => {
    const manager = new SessionManager(
      "group-1",
      "user-1",
      { session: {} } as never,
      {
        recallSessionEvents() {
          return [];
        },
        getRecentSessionEvents() {
          return [{
            id: "1",
            ts: Date.now(),
            category: "message",
            priority: 4,
            role: "user",
            summary: "fresh request",
            body: "fresh request",
          }];
        },
      } as never,
      {
        getSnapshot() {
          return null;
        },
      } as never,
      {
        get() {
          return null;
        },
        getMeta() {
          return null;
        },
        renderPersistentMemory() {
          return { body: "", factUuids: [], nodeRefs: [] };
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
      } as never,
    );

    manager.setParentId("session-1", null);
    manager.setState(
      "session-1",
      manager.createDefaultState("group-1", "user-1"),
    );
    const prepared = await manager.prepareInjection(
      "session-1",
      "stale fallback",
    );

    assertStringIncludes(
      prepared?.envelope ?? "",
      "<last_request>fresh request</last_request>",
    );
    assertEquals(prepared?.refreshDecision.classification, "miss");
  });

  it("prepareInjection recalls older relevant events and merges them deterministically", async () => {
    const olderDecisionTs = Date.now() - 10_000;
    const recentIntentTs = Date.now();
    const manager = new SessionManager(
      "group-1",
      "user-1",
      { session: {} } as never,
      {
        getRecentSessionEvents() {
          return [{
            id: "recent-intent",
            ts: recentIntentTs,
            category: "intent",
            priority: 0,
            role: "user",
            summary: "Investigate recall behavior",
            body: "Investigate recall behavior",
          }];
        },
        recallSessionEvents() {
          return [{
            id: "older-decision",
            ts: olderDecisionTs,
            category: "decision",
            priority: 0,
            role: "user",
            summary: "Prefer recalled decisions for injection",
          }, {
            id: "recent-intent",
            ts: recentIntentTs,
            category: "intent",
            priority: 0,
            role: "user",
            summary: "Investigate recall behavior",
            body: "Investigate recall behavior",
          }];
        },
      } as never,
      {
        getSnapshot() {
          return null;
        },
      } as never,
      {
        get() {
          return null;
        },
        getMeta() {
          return null;
        },
        renderPersistentMemory() {
          return { body: "", factUuids: [], nodeRefs: [] };
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
      } as never,
    );

    manager.setParentId("session-1", null);
    manager.setState(
      "session-1",
      manager.createDefaultState("group-1", "user-1"),
    );
    const prepared = await manager.prepareInjection(
      "session-1",
      "Investigate recall behavior",
    );

    assertStringIncludes(
      prepared?.envelope ?? "",
      "Prefer recalled decisions for injection",
    );
    assertEquals(
      prepared?.envelope.match(/Investigate recall behavior/g)?.length,
      2,
    );
  });

  it("prepareInjection drops stale late completions after a newer prepare wins", async () => {
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    let recentCallCount = 0;
    const manager = new SessionManager(
      "group-1",
      "user-1",
      { session: {} } as never,
      {
        recallSessionEvents() {
          return [];
        },
        async getRecentSessionEvents() {
          recentCallCount += 1;
          if (recentCallCount === 1) {
            await new Promise<void>((resolve) => {
              resolveFirst = resolve;
            });
            return [{
              id: "1",
              ts: Date.now(),
              category: "message",
              priority: 4,
              role: "user",
              summary: "stale request",
              body: "stale request",
            }];
          }
          await new Promise<void>((resolve) => {
            resolveSecond = resolve;
          });
          return [{
            id: "2",
            ts: Date.now(),
            category: "message",
            priority: 4,
            role: "user",
            summary: "fresh request",
            body: "fresh request",
          }];
        },
      } as never,
      {
        getSnapshot() {
          return null;
        },
      } as never,
      {
        get() {
          return null;
        },
        getMeta() {
          return null;
        },
        renderPersistentMemory() {
          return { body: "", factUuids: [], nodeRefs: [] };
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
      } as never,
    );

    manager.setParentId("session-1", null);
    manager.setState(
      "session-1",
      manager.createDefaultState("group-1", "user-1"),
    );

    const firstPrepare = manager.prepareInjection("session-1", "stale request");
    const secondPrepare = manager.prepareInjection(
      "session-1",
      "fresh request",
    );

    resolveSecond();
    const freshPrepared = await secondPrepare;
    resolveFirst();
    const stalePrepared = await firstPrepare;

    const state = manager.getState("session-1");
    assertStringIncludes(
      freshPrepared?.envelope ?? "",
      "<last_request>fresh request</last_request>",
    );
    assertEquals(stalePrepared, null);
    assertEquals(state?.pendingInjection, freshPrepared);
    assertEquals(freshPrepared?.refreshDecision.classification, "miss");
  });

  it("prepareInjection preserves required continuity sections after restore", async () => {
    const snapshot = buildSessionSnapshotXml("session-1", [{
      id: "snap-1",
      ts: Date.now() - 10,
      category: "decision",
      priority: 0,
      role: "user",
      summary: "Keep Graphiti off the hot path",
    }]);
    const manager = new SessionManager(
      "group-1",
      "user-1",
      { session: {} } as never,
      {
        recallSessionEvents() {
          return [];
        },
        getRecentSessionEvents() {
          return [{
            id: "1",
            ts: Date.now(),
            category: "intent",
            priority: 0,
            role: "user",
            summary: "Continue the context overhaul",
          }, {
            id: "2",
            ts: Date.now() + 1,
            category: "task.update",
            priority: 0,
            role: "user",
            summary: "Implement deterministic CI-safe tests",
          }, {
            id: "3",
            ts: Date.now() + 2,
            category: "decision",
            priority: 0,
            role: "user",
            summary: "Keep Graphiti off the hot path",
          }, {
            id: "4",
            ts: Date.now() + 3,
            category: "file.edit",
            priority: 1,
            role: "tool",
            summary: "Edited src/session.ts",
            refs: ["src/session.ts"],
          }, {
            id: "5",
            ts: Date.now() + 4,
            category: "rule.load",
            priority: 0,
            role: "system",
            summary: "Stay within scoped tests only",
          }, {
            id: "6",
            ts: Date.now() + 5,
            category: "error",
            priority: 2,
            role: "tool",
            summary: "Redis refresh blocked",
            continuityText: "Redis refresh blocked until reconnect succeeds",
            metadata: { resolved: false, blocking: true },
          }, {
            id: "7",
            ts: Date.now() + 6,
            category: "git.activity",
            priority: 3,
            role: "tool",
            summary: "Working tree has local changes",
          }, {
            id: "8",
            ts: Date.now() + 7,
            category: "subagent.finish",
            priority: 1,
            role: "system",
            summary: "Reviewer subagent finished",
          }];
        },
      } as never,
      {
        getSnapshot() {
          return snapshot;
        },
      } as never,
      {
        get() {
          return null;
        },
        getMeta() {
          return null;
        },
        renderPersistentMemory() {
          return { body: "", factUuids: [], nodeRefs: [] };
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
      } as never,
    );

    manager.setParentId("session-1", null);
    manager.setState(
      "session-1",
      manager.createDefaultState("group-1", "user-1"),
    );
    const prepared = await manager.prepareInjection(
      "session-1",
      "Continue the context overhaul",
    );

    assertStringIncludes(prepared?.envelope ?? "", "<last_request>");
    assertStringIncludes(prepared?.envelope ?? "", "<active_tasks>");
    assertStringIncludes(prepared?.envelope ?? "", "<key_decisions>");
    assertStringIncludes(prepared?.envelope ?? "", "<files_in_play>");
    assertStringIncludes(prepared?.envelope ?? "", "<project_rules>");
    assertStringIncludes(prepared?.envelope ?? "", "<unresolved_errors>");
    assertStringIncludes(prepared?.envelope ?? "", "<git_state>");
    assertStringIncludes(prepared?.envelope ?? "", "<subagent_work>");
    assertStringIncludes(prepared?.envelope ?? "", "<session_snapshot>");
  });

  it("prepareInjection stays compact and avoids raw transcript dumps under large tool output", async () => {
    const hugeTranscript = "TOOL-OUTPUT ".repeat(1200);
    const manager = new SessionManager(
      "group-1",
      "user-1",
      { session: {} } as never,
      {
        recallSessionEvents() {
          return [];
        },
        getRecentSessionEvents() {
          return [{
            id: "1",
            ts: Date.now(),
            category: "intent",
            priority: 0,
            role: "user",
            summary: "Continue compact session memory work",
          }, {
            id: "2",
            ts: Date.now() + 1,
            category: "file.edit",
            priority: 1,
            role: "tool",
            summary: "Edited src/services/redis-cache.ts",
            continuityText:
              "Edited src/services/redis-cache.ts to keep persistent memory compact",
            body: hugeTranscript,
            refs: ["src/services/redis-cache.ts"],
          }];
        },
      } as never,
      {
        getSnapshot() {
          return buildSessionSnapshotXml("session-1", [{
            id: "snap-1",
            ts: Date.now(),
            category: "file.edit",
            priority: 1,
            role: "tool",
            summary: "Edited src/services/redis-cache.ts",
            continuityText:
              "Edited src/services/redis-cache.ts to keep persistent memory compact",
            body: hugeTranscript,
            refs: ["src/services/redis-cache.ts"],
          }]);
        },
      } as never,
      {
        get() {
          return {
            query: "compact session memory",
            refreshedAt: Date.now(),
            facts: [{ uuid: "fact-1", fact: hugeTranscript }],
            nodes: [{
              uuid: "node-1",
              name: "Context Overhaul",
              summary: hugeTranscript,
            }],
            factUuids: ["fact-1"],
            nodeRefs: ["node-1"],
          };
        },
        getMeta() {
          return null;
        },
        renderPersistentMemory(cache: PersistentMemoryCacheEntry | null) {
          return {
            body: cache
              ? `<fact>${cache.facts[0].fact.slice(0, 220)}</fact>`
              : "",
            factUuids: cache ? ["fact-1"] : [],
            nodeRefs: cache ? ["node-1"] : [],
          };
        },
        classifyRefresh() {
          return {
            classification: "aligned",
            shouldRefresh: false,
            similarity: 1,
            threshold: 0.5,
            cachedQuery: "compact session memory",
          };
        },
      } as never,
    );

    manager.setParentId("session-1", null);
    manager.setState(
      "session-1",
      manager.createDefaultState("group-1", "user-1"),
    );
    const prepared = await manager.prepareInjection(
      "session-1",
      "Continue compact session memory work",
    );

    assertEquals((prepared?.envelope.length ?? 0) < 5000, true);
    assertStringIncludes(
      prepared?.envelope ?? "",
      "Edited src/services/redis-cache.ts to keep persistent memory compact",
    );
    assertEquals((prepared?.envelope ?? "").includes(hugeTranscript), false);
  });

  it("deletes idle sessions after retention when still inactive", () => {
    const clock = new FakeClock();
    const manager = new SessionManager(
      "group-1",
      "user-1",
      { session: {} } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        idleRetentionMs: 100,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
    );

    manager.setParentId("session-1", null);
    manager.setState(
      "session-1",
      manager.createDefaultState("group-1", "user-1"),
    );

    manager.scheduleIdleSessionCleanup("session-1");
    clock.tick(99);
    assertEquals(manager.getState("session-1")?.groupId, "group-1");

    clock.tick(1);
    assertEquals(manager.getState("session-1"), undefined);
  });

  it("cancels stale idle cleanup when the session is reactivated", () => {
    const clock = new FakeClock();
    const manager = new SessionManager(
      "group-1",
      "user-1",
      { session: {} } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        idleRetentionMs: 100,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
    );

    manager.setParentId("session-1", null);
    manager.setState(
      "session-1",
      manager.createDefaultState("group-1", "user-1"),
    );

    manager.scheduleIdleSessionCleanup("session-1");
    clock.tick(50);
    manager.markSessionActive("session-1");

    clock.tick(60);
    assertEquals(manager.getState("session-1")?.groupId, "group-1");

    manager.scheduleIdleSessionCleanup("session-1");
    clock.tick(100);
    assertEquals(manager.getState("session-1"), undefined);
  });

  it("rejects stale idle scheduling when the captured generation is outdated", () => {
    const clock = new FakeClock();
    const manager = new SessionManager(
      "group-1",
      "user-1",
      { session: {} } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        idleRetentionMs: 100,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
    );

    manager.setParentId("session-1", null);
    manager.setState(
      "session-1",
      manager.createDefaultState("group-1", "user-1"),
    );

    const idleGeneration = manager.captureIdleCleanupGeneration("session-1");
    manager.markSessionActive("session-1");
    manager.scheduleIdleSessionCleanup(
      "session-1",
      idleGeneration ?? undefined,
    );

    clock.tick(150);
    assertEquals(manager.getState("session-1")?.groupId, "group-1");
  });

  it("snapshot builder admits sections against the current remaining budget", () => {
    const long = "x".repeat(500);
    const snapshot = buildSessionSnapshotXml("session-1", [
      {
        id: "1",
        ts: Date.now(),
        category: "decision",
        priority: 0,
        role: "user",
        summary: long,
      },
      {
        id: "2",
        ts: Date.now(),
        category: "rule.load",
        priority: 0,
        role: "system",
        summary: long,
      },
      {
        id: "3",
        ts: Date.now(),
        category: "intent",
        priority: 0,
        role: "user",
        summary: long,
      },
      {
        id: "4",
        ts: Date.now(),
        category: "file.edit",
        priority: 1,
        role: "tool",
        summary: "edited",
        refs: ["src/session.ts"],
      },
      {
        id: "5",
        ts: Date.now(),
        category: "error",
        priority: 2,
        role: "tool",
        summary: "error",
        metadata: { resolved: false },
      },
    ]);

    assertEquals(snapshot.length <= 3000, true);
    assertStringIncludes(snapshot, "<decisions>");
    assertStringIncludes(snapshot, "<constraints>");
  });

  it("snapshot keeps an active_task section by falling back to the latest user request", () => {
    const long = "plan ".repeat(120);
    const snapshot = buildSessionSnapshotXml("session-1", [
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `d-${index}`,
        ts: Date.now(),
        category: "decision" as const,
        priority: 0 as const,
        role: "user" as const,
        summary: `${index} ${long}`,
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `r-${index}`,
        ts: Date.now(),
        category: "rule.load" as const,
        priority: 0 as const,
        role: "system" as const,
        summary: `${index} ${long}`,
      })),
      {
        id: "m-1",
        ts: Date.now(),
        category: "message",
        priority: 4,
        role: "user",
        summary: long,
        body: long,
      },
    ]);

    assertStringIncludes(snapshot, "<active_task><goal>");
    assertEquals(snapshot.length <= 3000, true);
  });

  it("snapshot keeps blockers distinct from summary-only errors", () => {
    const snapshot = buildSessionSnapshotXml("session-1", [
      {
        id: "1",
        ts: Date.now() - 2,
        category: "error",
        priority: 2,
        role: "tool",
        summary: "Command failed",
        continuityText: "Command failed",
        metadata: { resolved: false },
      },
      {
        id: "2",
        ts: Date.now() - 1,
        category: "error",
        priority: 2,
        role: "tool",
        summary: "Refresh blocked",
        continuityText: "Refresh blocked while waiting on Redis lock",
        metadata: { resolved: false },
      },
    ]);

    assertStringIncludes(snapshot, "<errors>");
    assertStringIncludes(snapshot, "<e>Command failed</e>");
    assertStringIncludes(
      snapshot,
      "<e>Refresh blocked while waiting on Redis lock</e>",
    );
    assertStringIncludes(
      snapshot,
      "<blockers><b>Refresh blocked while waiting on Redis lock</b></blockers>",
    );
    assertEquals(snapshot.includes("<b>Command failed</b>"), false);
  });

  it("snapshot renders the expanded context sections when those events exist", () => {
    const snapshot = buildSessionSnapshotXml("session-1", [
      {
        id: "1",
        ts: Date.now() - 8,
        category: "env.change",
        priority: 0,
        role: "system",
        summary: "Environment switched to staging",
      },
      {
        id: "2",
        ts: Date.now() - 7,
        category: "git.activity",
        priority: 0,
        role: "tool",
        summary: "Working tree has local changes",
      },
      {
        id: "3",
        ts: Date.now() - 6,
        category: "subagent.start",
        priority: 1,
        role: "system",
        summary: "Started reviewer subagent",
      },
      {
        id: "4",
        ts: Date.now() - 5,
        category: "subagent.finish",
        priority: 1,
        role: "system",
        summary: "Reviewer subagent finished cleanly",
      },
      {
        id: "5",
        ts: Date.now() - 4,
        category: "task.update",
        priority: 0,
        role: "user",
        summary: "Need confirmation on restart-safe refresh scheduling",
      },
      {
        id: "6",
        ts: Date.now() - 3,
        category: "discovery",
        priority: 0,
        role: "assistant",
        summary: "Redis metadata already stores the last refresh query",
      },
      {
        id: "7",
        ts: Date.now() - 2,
        category: "data.import",
        priority: 0,
        role: "system",
        summary: "Imported prior refresh hints",
      },
      {
        id: "8",
        ts: Date.now() - 1,
        category: "message",
        priority: 4,
        role: "assistant",
        summary: "Residual assistant summary",
      },
    ]);

    assertStringIncludes(snapshot, "<environment>");
    assertStringIncludes(snapshot, "<git_state>");
    assertStringIncludes(snapshot, "<subagents_open>");
    assertStringIncludes(snapshot, "<subagents_done>");
    assertStringIncludes(snapshot, "<open_questions>");
    assertStringIncludes(snapshot, "<discoveries>");
    assertStringIncludes(snapshot, "<references>");
    assertStringIncludes(snapshot, "<residual_messages>");
  });
});
