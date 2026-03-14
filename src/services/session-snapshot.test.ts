import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { SessionManager } from "../session.ts";
import type { SessionEvent } from "../types/index.ts";
import { buildSessionSnapshotXml } from "./redis-snapshot.ts";

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

const createExplicitSessionNotFoundError = (
  details: Record<string, unknown> = { status: 404 },
): Error => Object.assign(new Error("Session not found"), details);

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

  it("treats missing startup sessions as temporary roots during canonical resolution", async () => {
    const manager = new SessionManager(
      "group-1",
      "user-1",
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

    const canonicalSessionId = await manager.resolveCanonicalSessionId(
      "session-1",
    );
    const resolved = await manager.resolveSessionState("session-1");

    assertEquals(canonicalSessionId, "session-1");
    assertEquals(resolved.resolved, true);
    assertEquals(resolved.canonicalSessionId, "session-1");
    assertEquals(resolved.state?.isMain, true);
  });

  it("treats structured nested session-not-found codes as temporary roots", async () => {
    const manager = new SessionManager(
      "group-1",
      "user-1",
      {
        session: {
          get() {
            throw {
              response: {
                data: {
                  code: "session_not_found",
                },
              },
            };
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const canonicalSessionId = await manager.resolveCanonicalSessionId(
      "session-1",
    );

    assertEquals(canonicalSessionId, "session-1");
    assertEquals(
      (await manager.resolveSessionState("session-1")).resolved,
      true,
    );
  });

  it("treats message-only session-not-found strings as temporary roots", async () => {
    const manager = new SessionManager(
      "group-1",
      "user-1",
      {
        session: {
          get() {
            throw new Error("Session not found");
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const canonicalSessionId = await manager.resolveCanonicalSessionId(
      "session-1",
    );
    const resolved = await manager.resolveSessionState("session-1");

    assertEquals(canonicalSessionId, "session-1");
    assertEquals(resolved.resolved, true);
    assertEquals(resolved.canonicalSessionId, "session-1");
    assertEquals(resolved.state?.isMain, true);
  });

  it("migrates temporary-root session state into the canonical parent on attachment", async () => {
    const manager = new SessionManager(
      "group-1",
      "user-1",
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

    manager.setParentId("parent-session", null);
    const parentState = manager.createDefaultState("group-1", "user-1");
    parentState.messageCount = 1;
    parentState.latestUserRequest = "parent request";
    parentState.pendingInjectionGeneration = 2;
    manager.setState("parent-session", parentState);

    const childCanonicalSessionId = await manager.resolveCanonicalSessionId(
      "child-session",
    );
    const childResolved = await manager.resolveSessionState("child-session");
    const childState = childResolved.state;

    assertEquals(childCanonicalSessionId, "child-session");
    assertEquals(childResolved.canonicalSessionId, "child-session");

    childState!.messageCount = 2;
    childState!.hotTierReady = true;
    childState!.latestUserRequest = "child request";
    childState!.latestRefreshQuery = "child refresh";
    childState!.pendingInjectionGeneration = 5;

    manager.setParentId("child-session", "parent-session");

    const canonicalResolved = await manager.resolveSessionState(
      "child-session",
    );

    assertEquals(manager.getState("child-session"), undefined);
    assertEquals(canonicalResolved.canonicalSessionId, "parent-session");
    assertEquals(parentState.messageCount, 3);
    assertEquals(parentState.hotTierReady, true);
    assertEquals(parentState.latestUserRequest, "child request");
    assertEquals(parentState.latestRefreshQuery, "child refresh");
    assertEquals(parentState.pendingInjectionGeneration, 5);
  });

  it("keeps the newer canonical pending injection when a provisional child attaches later", () => {
    const manager = new SessionManager(
      "group-1",
      "user-1",
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

    manager.setParentId("parent-session", null);

    const parentState = manager.createDefaultState("group-1", "user-1");
    const newerPrepared = {
      envelope: "<session_memory>newer</session_memory>",
      nodeRefs: ["node-parent"],
      refreshDecision: {
        classification: "aligned" as const,
        shouldRefresh: false,
        similarity: 1,
        threshold: 0.5,
        cachedQuery: "newer query",
      },
    };
    parentState.pendingInjection = newerPrepared;
    parentState.pendingInjectionGeneration = 7;
    manager.setState("parent-session", parentState);

    const childState = manager.createDefaultState("group-1", "user-1");
    const olderPrepared = {
      envelope: "<session_memory>older</session_memory>",
      nodeRefs: ["node-child"],
      refreshDecision: {
        classification: "miss" as const,
        shouldRefresh: true,
        similarity: 0,
        threshold: 0.5,
        cachedQuery: null,
      },
    };
    childState.pendingInjection = olderPrepared;
    childState.pendingInjectionGeneration = 3;
    manager.setState("child-session", childState);

    manager.setParentId("child-session", "parent-session");

    const mergedParentState = manager.getState("parent-session");
    assertEquals(mergedParentState?.pendingInjection, newerPrepared);
    assertEquals(mergedParentState?.pendingInjectionGeneration, 7);
    assertEquals(manager.getState("child-session"), undefined);
  });

  it("re-resolves a provisional temporary root onto its discovered canonical parent later", async () => {
    let childLookupCount = 0;
    const manager = new SessionManager(
      "group-1",
      "user-1",
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

    const firstCanonicalSessionId = await manager.resolveCanonicalSessionId(
      "child-session",
    );
    const provisionalState = manager.createDefaultState("group-1", "user-1");
    provisionalState.messageCount = 2;
    provisionalState.latestUserRequest = "child request";
    manager.setState("child-session", provisionalState);

    const laterResolved = await manager.resolveSessionState("child-session");

    assertEquals(firstCanonicalSessionId, "child-session");
    assertEquals(childLookupCount, 2);
    assertEquals(laterResolved.canonicalSessionId, "parent-session");
    assertEquals(manager.getState("child-session"), undefined);
    assertEquals(manager.getState("parent-session")?.messageCount, 2);
    assertEquals(
      manager.getState("parent-session")?.latestUserRequest,
      "child request",
    );
  });

  it("migrates existing child session state into the canonical parent on attachment", () => {
    const manager = new SessionManager(
      "group-1",
      "user-1",
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

    manager.setParentId("parent-session", null);
    const parentState = manager.createDefaultState("group-1", "user-1");
    parentState.messageCount = 1;
    manager.setState("parent-session", parentState);

    const childState = manager.createDefaultState("group-1", "user-1");
    childState.messageCount = 2;
    childState.contextLimit = 123_456;
    childState.hotTierReady = true;
    childState.latestUserRequest = "child request";
    childState.latestRefreshQuery = "child refresh";
    childState.pendingInjectionGeneration = 5;
    manager.setState("child-session", childState);

    manager.setParentId("child-session", "parent-session");

    assertEquals(manager.getState("child-session"), undefined);
    assertEquals(manager.getState("parent-session")?.messageCount, 3);
    assertEquals(manager.getState("parent-session")?.contextLimit, 200_000);
    assertEquals(manager.getState("parent-session")?.hotTierReady, true);
    assertEquals(
      manager.getState("parent-session")?.latestUserRequest,
      "child request",
    );
    assertEquals(
      manager.getState("parent-session")?.latestRefreshQuery,
      "child refresh",
    );
    assertEquals(
      manager.getState("parent-session")?.pendingInjectionGeneration,
      5,
    );
  });

  it("rekeys assistant pending and finalized buffers onto canonical session ids after attachment", async () => {
    const manager = new SessionManager(
      "group-1",
      "user-1",
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

    manager.setParentId("parent-session", null);
    manager.setState(
      "parent-session",
      manager.createDefaultState("group-1", "user-1"),
    );

    const childResolved = await manager.resolveSessionState("child-session");
    const childState = childResolved.state!;

    manager.bufferAssistantPart(
      "child-session",
      "pending-message",
      "pending text",
    );
    manager.bufferAssistantPart("child-session", "done-message", "done text");
    assertEquals(
      manager.finalizeAssistantMessage(
        childState,
        "child-session",
        "done-message",
        "test",
      ),
      "done text",
    );
    assertEquals(
      manager.isAssistantBuffered("child-session", "done-message"),
      true,
    );

    manager.setParentId("child-session", "parent-session");

    const parentState = manager.getState("parent-session")!;
    assertEquals(
      manager.finalizeAssistantMessage(
        parentState,
        "parent-session",
        "pending-message",
        "test",
      ),
      "pending text",
    );
    assertEquals(
      manager.isAssistantBuffered("parent-session", "pending-message"),
      true,
    );
    assertEquals(
      manager.isAssistantBuffered("child-session", "pending-message"),
      false,
    );
    assertEquals(
      manager.isAssistantBuffered("parent-session", "done-message"),
      true,
    );
    assertEquals(
      manager.isAssistantBuffered("child-session", "done-message"),
      false,
    );
    assertEquals(
      manager.finalizeAssistantMessage(
        parentState,
        "parent-session",
        "done-message",
        "test",
      ),
      null,
    );

    manager.purgeAssistantBufferSource("child-session");
    assertEquals(
      manager.isAssistantBuffered("parent-session", "pending-message"),
      false,
    );
    assertEquals(
      manager.isAssistantBuffered("parent-session", "done-message"),
      false,
    );
  });

  it("migrates idle lifecycle state so parent cleanup semantics continue after attachment", async () => {
    const clock = new FakeClock();
    const manager = new SessionManager(
      "group-1",
      "user-1",
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
        idleRetentionMs: 100,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
    );

    manager.setParentId("parent-session", null);
    manager.setState(
      "parent-session",
      manager.createDefaultState("group-1", "user-1"),
    );
    manager.markSessionActive("parent-session");
    const staleParentGeneration = manager.captureIdleCleanupGeneration(
      "parent-session",
    );
    manager.scheduleIdleSessionCleanup("parent-session");

    await manager.resolveSessionState("child-session");
    manager.markSessionActive("child-session");
    manager.markSessionActive("child-session");
    manager.scheduleIdleSessionCleanup("child-session");

    manager.setParentId("child-session", "parent-session");

    assertEquals(manager.captureIdleCleanupGeneration("parent-session"), 2);

    clock.tick(150);
    assertEquals(manager.getState("parent-session")?.groupId, "group-1");

    manager.scheduleIdleSessionCleanup(
      "parent-session",
      staleParentGeneration ?? undefined,
    );
    clock.tick(150);
    assertEquals(manager.getState("parent-session")?.groupId, "group-1");

    const currentGeneration = manager.captureIdleCleanupGeneration(
      "parent-session",
    );
    manager.scheduleIdleSessionCleanup(
      "parent-session",
      currentGeneration ?? undefined,
    );
    clock.tick(100);
    assertEquals(manager.getState("parent-session"), undefined);
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
            nodes: [{ uuid: "node-1", name: "Context Overhaul" }],
            nodeRefs: ["node-1"],
          };
        },
        getMeta() {
          return null;
        },
        renderPersistentMemory() {
          return {
            body: "<node>Context Overhaul: cached cross-session recall</node>",
            nodeRefs: ["node-1"],
          };
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

    assertStringIncludes(
      prepared?.envelope ?? "",
      '<session_memory source="graphiti" version="1">',
    );
    assertStringIncludes(
      prepared?.envelope ?? "",
      "Keep Graphiti off the hot path",
    );
    assertStringIncludes(prepared?.envelope ?? "", "<persistent_memory");
    assertEquals(prepared?.refreshDecision.classification, "aligned");
  });

  it("prepareInjection stays cache-only while injecting cached node and fact summaries", async () => {
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
            summary: "Use cached memory only",
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
          return {
            query: "Use cached memory only",
            refreshedAt: Date.now(),
            nodes: [{ uuid: "node-1", name: "Cached recall" }],
            episodeSummaries: [
              "ArchitectureDecision → HotPath: Keep Graphiti off synchronous injection",
            ],
            nodeRefs: ["node-1"],
          };
        },
        getMeta() {
          return null;
        },
        renderPersistentMemory() {
          return {
            body:
              "<entity>Cached recall</entity><episode>ArchitectureDecision → HotPath: Keep Graphiti off synchronous injection</episode>",
            nodeRefs: ["node-1"],
          };
        },
        classifyRefresh() {
          return {
            classification: "aligned",
            shouldRefresh: false,
            similarity: 1,
            threshold: 0.5,
            cachedQuery: "Use cached memory only",
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
      "Use cached memory only",
    );

    assertStringIncludes(prepared?.envelope ?? "", "<persistent_memory");
    assertStringIncludes(prepared?.envelope ?? "", "Cached recall");
    assertStringIncludes(
      prepared?.envelope ?? "",
      "Keep Graphiti off synchronous injection",
    );
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
      emptyCache as never,
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

  it("includes child-derived canonical memory in later snapshot and session_memory output", async () => {
    const childDecision =
      "Child session decided to reuse the canonical parent memory flow";
    const childTask =
      "Child session continued the parent implementation after handoff";
    const canonicalEvents: SessionEvent[] = [{
      id: "1",
      ts: Date.now() - 1,
      category: "decision",
      priority: 0,
      role: "user",
      summary: childDecision,
      continuityText: childDecision,
    }, {
      id: "2",
      ts: Date.now(),
      category: "task.update",
      priority: 0,
      role: "user",
      summary: childTask,
      continuityText: childTask,
    }];
    const snapshot = buildSessionSnapshotXml("parent-session", canonicalEvents);

    assertStringIncludes(snapshot, childDecision);
    assertStringIncludes(snapshot, '<snapshot session="parent-session"');

    const manager = new SessionManager(
      "group-1",
      "user-1",
      { session: {} } as never,
      {
        recallSessionEvents() {
          return [];
        },
        getRecentSessionEvents() {
          return canonicalEvents;
        },
      } as never,
      {
        getSnapshot() {
          return snapshot;
        },
      } as never,
      emptyCache as never,
    );

    manager.setParentId("parent-session", null);
    manager.setParentId("child-session", "parent-session");
    manager.setState(
      "parent-session",
      manager.createDefaultState("group-1", "user-1"),
    );
    const prepared = await manager.prepareInjection(
      "parent-session",
      "continue after child handoff",
    );

    assertStringIncludes(prepared?.envelope ?? "", childDecision);
    assertStringIncludes(prepared?.envelope ?? "", childTask);
    assertStringIncludes(prepared?.envelope ?? "", "<active_tasks>");
    assertStringIncludes(prepared?.envelope ?? "", "<session_snapshot>");
  });

  it("prepareInjection reconciles provisional child history onto the real root once discovered", async () => {
    const childDecision =
      "Temporary root captured the delegated child decision";
    const childTask =
      "Temporary root tracked the delegated task before parent discovery";
    let childLookupCount = 0;

    const manager = new SessionManager(
      "group-1",
      "user-1",
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
      {
        recallSessionEvents(sessionId: string) {
          return sessionId === "parent-session" ? [] : [];
        },
        getRecentSessionEvents(sessionId: string) {
          if (sessionId === "parent-session") {
            return [{
              id: "1",
              ts: Date.now() - 1,
              category: "decision",
              priority: 0,
              role: "user",
              summary: childDecision,
              continuityText: childDecision,
            }, {
              id: "2",
              ts: Date.now(),
              category: "task.update",
              priority: 0,
              role: "user",
              summary: childTask,
              continuityText: childTask,
            }];
          }
          throw new Error(`Unexpected recent event lookup: ${sessionId}`);
        },
      } as never,
      {
        getSnapshot(sessionId: string) {
          if (sessionId === "parent-session") {
            return buildSessionSnapshotXml("parent-session", [{
              id: "1",
              ts: Date.now() - 1,
              category: "decision",
              priority: 0,
              role: "user",
              summary: childDecision,
              continuityText: childDecision,
            }]);
          }
          throw new Error(`Unexpected snapshot lookup: ${sessionId}`);
        },
      } as never,
      emptyCache as never,
    );

    const firstCanonicalSessionId = await manager.resolveCanonicalSessionId(
      "child-session",
    );
    assertEquals(firstCanonicalSessionId, "child-session");

    const provisional = manager.createDefaultState("group-1", "user-1");
    provisional.latestUserRequest = childTask;
    manager.setState("child-session", provisional);

    const resolved = await manager.resolveSessionState("child-session");
    assertEquals(resolved.canonicalSessionId, "parent-session");
    assertEquals(manager.getState("child-session"), undefined);

    const prepared = await manager.prepareInjection(
      resolved.canonicalSessionId!,
      "continue after root arrives",
    );

    assertStringIncludes(prepared?.envelope ?? "", childDecision);
    assertStringIncludes(prepared?.envelope ?? "", childTask);
    assertStringIncludes(prepared?.envelope ?? "", "<session_snapshot>");
  });

  it("prepareInjection omits empty continuity sections automatically", async () => {
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
            summary: "continue",
          }];
        },
      } as never,
      {
        getSnapshot() {
          return null;
        },
      } as never,
      emptyCache as never,
    );

    manager.setParentId("session-1", null);
    manager.setState(
      "session-1",
      manager.createDefaultState("group-1", "user-1"),
    );
    const prepared = await manager.prepareInjection("session-1", "continue");

    assertStringIncludes(
      prepared?.envelope ?? "",
      "<last_request>continue</last_request>",
    );
    assertEquals((prepared?.envelope ?? "").includes("<active_tasks>"), false);
    assertEquals((prepared?.envelope ?? "").includes("<key_decisions>"), false);
    assertEquals((prepared?.envelope ?? "").includes("<files_in_play>"), false);
    assertEquals((prepared?.envelope ?? "").includes("<project_rules>"), false);
  });

  it("prepareInjection keeps state.latestUserRequest as the canonical source over history fallback", async () => {
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
      emptyCache as never,
    );

    manager.setParentId("session-1", null);
    manager.setState(
      "session-1",
      manager.createDefaultState("group-1", "user-1"),
    );
    const state = manager.createDefaultState("group-1", "user-1");
    state.latestUserRequest = "canonical request";
    manager.setState("session-1", state);
    const prepared = await manager.prepareInjection(
      "session-1",
      "stale fallback",
    );

    assertStringIncludes(
      prepared?.envelope ?? "",
      "<last_request>canonical request</last_request>",
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
      emptyCache as never,
    );

    manager.setParentId("session-1", null);
    const state = manager.createDefaultState("group-1", "user-1");
    state.latestUserRequest = "fresh request";
    manager.setState("session-1", state);
    const prepared = await manager.prepareInjection(
      "session-1",
      "Investigate recall behavior",
    );

    assertStringIncludes(
      prepared?.envelope ?? "",
      "Prefer recalled decisions for injection",
    );
    assertEquals(
      prepared?.envelope.includes("Investigate recall behavior"),
      false,
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
      emptyCache as never,
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
      emptyCache as never,
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
            nodes: [{
              uuid: "node-1",
              name: "Context Overhaul",
              summary: hugeTranscript,
            }],
            nodeRefs: ["node-1"],
          };
        },
        getMeta() {
          return null;
        },
        renderPersistentMemory() {
          return { body: "", nodeRefs: [] };
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
    assertEquals(snapshot.includes("<active_task>"), false);
  });

  it("snapshot omits active_task when it would duplicate the latest user request", () => {
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

    assertEquals(snapshot.includes("<active_task><goal>"), false);
    assertEquals(snapshot.length <= 3000, true);
  });

  it("prepareInjection sanitizes history fallback and does not override canonical state.latestUserRequest", async () => {
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
            summary:
              '<session_memory version="1"><last_request>old</last_request></session_memory> polluted history',
            body:
              '<memory data-uuids="fact-1">legacy</memory> polluted history',
          }];
        },
      } as never,
      {
        getSnapshot() {
          return null;
        },
      } as never,
      {
        ...emptyCache,
        getMeta() {
          return { lastQuery: "history query" };
        },
      } as never,
    );

    manager.setParentId("session-1", null);
    const state = manager.createDefaultState("group-1", "user-1");
    state.latestUserRequest = "canonical request";
    manager.setState("session-1", state);
    const prepared = await manager.prepareInjection("session-1");

    assertStringIncludes(
      prepared?.envelope ?? "",
      "<last_request>canonical request</last_request>",
    );
    assertEquals(
      (prepared?.envelope ?? "").includes("polluted history"),
      false,
    );
  });

  it("snapshot keeps summary-only errors and avoids duplicating blocker text across sections", () => {
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
    assertEquals(snapshot.includes("<blockers>"), false);
    assertEquals(snapshot.includes("<b>Command failed</b>"), false);
  });

  it("snapshot keeps only the high-value conservative sections when those events exist", () => {
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
    assertEquals(snapshot.includes("<open_questions>"), false);
    assertEquals(snapshot.includes("<discoveries>"), false);
    assertEquals(snapshot.includes("<references>"), false);
    assertEquals(snapshot.includes("<residual_messages>"), false);
  });
});
