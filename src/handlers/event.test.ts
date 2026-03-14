import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { createEventHandler } from "./event.ts";
import type { SessionState } from "../session.ts";

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

class MockSessionManager {
  sessions = new Map<string, SessionState>();
  parentIds = new Map<string, string | null>();
  buffered = new Map<string, string>();
  deletedSessions: string[] = [];
  activeMarks: string[] = [];
  idleCleanupCalls: string[] = [];
  private readonly idleRetentionMs: number;
  private readonly setTimerImpl: (
    callback: () => void,
    delayMs: number,
  ) => number;
  private readonly clearTimerImpl: (timer: number) => void;
  private lifecycles = new Map<
    string,
    { generation: number; timerId: number | null }
  >();

  constructor(
    options: {
      idleRetentionMs?: number;
      setTimer?: (callback: () => void, delayMs: number) => number;
      clearTimer?: (timer: number) => void;
    } = {},
  ) {
    this.idleRetentionMs = options.idleRetentionMs ?? 0;
    this.setTimerImpl = options.setTimer ?? (() => 0);
    this.clearTimerImpl = options.clearTimer ?? (() => {});
  }

  createDefaultState(groupId: string, userGroupId: string): SessionState {
    return {
      groupId,
      userGroupId,
      injectedMemories: false,
      lastInjectionFactUuids: [],
      visibleFactUuids: [],
      messageCount: 0,
      pendingMessages: [],
      contextLimit: 200_000,
      isMain: true,
      hotTierReady: false,
      latestUserRequest: undefined,
      latestRefreshQuery: undefined,
      pendingInjection: undefined,
      pendingInjectionGeneration: 0,
    };
  }

  setParentId(sessionId: string, parentId: string | null) {
    this.parentIds.set(sessionId, parentId);
  }

  setState(sessionId: string, state: SessionState) {
    this.sessions.set(sessionId, state);
  }

  markSessionActive(sessionId: string) {
    this.activeMarks.push(sessionId);
    const lifecycle = this.getLifecycle(sessionId);
    lifecycle.generation += 1;
    if (lifecycle.timerId !== null) {
      this.clearTimerImpl(lifecycle.timerId);
      lifecycle.timerId = null;
    }
  }

  captureIdleCleanupGeneration(sessionId: string) {
    const state = this.sessions.get(sessionId);
    if (!state?.isMain) return null;
    return this.getLifecycle(sessionId).generation;
  }

  scheduleIdleSessionCleanup(sessionId: string, expectedGeneration?: number) {
    this.idleCleanupCalls.push(sessionId);
    const state = this.sessions.get(sessionId);
    if (!state?.isMain) {
      this.deleteSession(sessionId);
      return;
    }
    const lifecycle = this.getLifecycle(sessionId);
    if (
      expectedGeneration !== undefined &&
      lifecycle.generation !== expectedGeneration
    ) {
      return;
    }
    if (this.idleRetentionMs <= 0) {
      this.deleteSession(sessionId);
      return;
    }
    if (lifecycle.timerId !== null) this.clearTimerImpl(lifecycle.timerId);
    const generation = expectedGeneration ?? lifecycle.generation;
    lifecycle.timerId = this.setTimerImpl(() => {
      const current = this.lifecycles.get(sessionId);
      if (!current) return;
      if (current.generation !== generation) return;
      this.deleteSession(sessionId);
    }, this.idleRetentionMs);
  }

  getState(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  resolveSessionState(sessionId: string) {
    return { state: this.sessions.get(sessionId) ?? null, resolved: true };
  }

  bufferAssistantPart(sessionId: string, messageId: string, text: string) {
    this.buffered.set(`${sessionId}:${messageId}`, text);
  }

  isAssistantBuffered() {
    return false;
  }

  finalizeAssistantMessage(
    state: SessionState,
    sessionId: string,
    messageId: string,
  ) {
    const text = this.buffered.get(`${sessionId}:${messageId}`) ?? "";
    if (!text) return null;
    state.pendingMessages.push(`Assistant: ${text}`);
    return text;
  }

  deletePendingAssistant() {}

  deleteSession(sessionId: string) {
    this.deletedSessions.push(sessionId);
    const lifecycle = this.lifecycles.get(sessionId);
    if (lifecycle?.timerId != null) this.clearTimerImpl(lifecycle.timerId);
    this.lifecycles.delete(sessionId);
    this.sessions.delete(sessionId);
    this.parentIds.delete(sessionId);
    for (const key of [...this.buffered.keys()]) {
      if (key.startsWith(`${sessionId}:`)) this.buffered.delete(key);
    }
  }

  private getLifecycle(sessionId: string) {
    let lifecycle = this.lifecycles.get(sessionId);
    if (!lifecycle) {
      lifecycle = { generation: 0, timerId: null };
      this.lifecycles.set(sessionId, lifecycle);
    }
    return lifecycle;
  }
}

class MockRedisEvents {
  calls: Array<{
    sessionId: string;
    groupId: string;
    summary: string;
    category?: string;
    body?: string;
    continuityText?: string;
  }> = [];
  touchedSessionIds: string[] = [];

  recordEvent(
    sessionId: string,
    groupId: string,
    event: { summary: string; category?: string },
  ) {
    this.calls.push({
      sessionId,
      groupId,
      summary: event.summary,
      category: event.category,
      body: (event as { body?: string }).body,
      continuityText: (event as { continuityText?: string }).continuityText,
    });
    return 1;
  }

  async getRecentSessionEvents() {
    await Promise.resolve();
    return [
      {
        id: "1",
        ts: Date.now(),
        category: "intent",
        priority: 0,
        role: "user",
        summary: "Finish the overhaul",
      },
    ];
  }

  async touchSessionEvents(sessionId: string) {
    await Promise.resolve();
    this.touchedSessionIds.push(sessionId);
  }
}

class DeferredRedisEvents extends MockRedisEvents {
  resume!: () => void;

  override async getRecentSessionEvents() {
    await new Promise<void>((resolve) => {
      this.resume = resolve;
    });
    return super.getRecentSessionEvents();
  }
}

class MockRedisSnapshot {
  saved: Array<{ sessionId: string; snapshot: string }> = [];
  touchedSessionIds: string[] = [];

  rebuildAndSave(sessionId: string) {
    const snapshot = `<snapshot session="${sessionId}" version="2"></snapshot>`;
    this.saved.push({ sessionId, snapshot });
    return snapshot;
  }

  async touchSnapshot(sessionId: string) {
    await Promise.resolve();
    this.touchedSessionIds.push(sessionId);
  }
}

class MockRedisCache {
  touchedGroupIds: string[] = [];
  metaByGroupId = new Map<
    string,
    { lastQuery?: string; lastRefresh?: number; factUuids: string[] }
  >();

  async touch(groupId: string) {
    await Promise.resolve();
    this.touchedGroupIds.push(groupId);
  }

  async getMeta(groupId: string) {
    await Promise.resolve();
    return this.metaByGroupId.get(groupId) ?? null;
  }
}

class MockGraphitiAsync {
  primerCalls: string[] = [];
  drainCalls: string[] = [];
  refreshCalls: Array<{ groupId: string; query: string }> = [];

  schedulePrimer(groupId: string) {
    this.primerCalls.push(groupId);
  }

  scheduleDrain(groupId: string) {
    this.drainCalls.push(groupId);
  }

  scheduleCacheRefresh(groupId: string, query: string) {
    this.refreshCalls.push({ groupId, query });
  }
}

const createHandler = (sessionManager: MockSessionManager) => {
  const redisEvents = new MockRedisEvents();
  const redisSnapshot = new MockRedisSnapshot();
  const redisCache = new MockRedisCache();
  const graphitiAsync = new MockGraphitiAsync();

  const handler = createEventHandler({
    sessionManager: sessionManager as never,
    redisEvents: redisEvents as never,
    redisCache: redisCache as never,
    redisSnapshot: redisSnapshot as never,
    graphitiAsync: graphitiAsync as never,
    defaultGroupId: "group-1",
    defaultUserGroupId: "user-1",
    sdkClient: { provider: { list: () => ({ data: [] }) } } as never,
    directory: "/tmp/project",
  });

  return { handler, redisEvents, redisCache, redisSnapshot, graphitiAsync };
};

describe("event handler", () => {
  it("bootstraps main sessions and schedules primer on session.created", async () => {
    const sessionManager = new MockSessionManager();
    const { handler, redisEvents, redisCache, redisSnapshot, graphitiAsync } =
      createHandler(
        sessionManager,
      );

    await handler({
      event: {
        type: "session.created",
        properties: { info: { id: "session-1", parentID: null } },
      } as never,
    });

    assertEquals(sessionManager.getState("session-1")?.groupId, "group-1");
    assertEquals(redisEvents.calls.length, 1);
    assertEquals(redisEvents.touchedSessionIds, ["session-1"]);
    assertEquals(redisSnapshot.touchedSessionIds, ["session-1"]);
    assertEquals(redisCache.touchedGroupIds, ["group-1"]);
    assertEquals(graphitiAsync.primerCalls, ["group-1"]);
  });

  it("preserves assistant buffering and writes the completed assistant event on message.updated", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.setState(
      "session-1",
      sessionManager.createDefaultState("group-1", "user-1"),
    );
    const redisEvents = new MockRedisEvents();
    const redisSnapshot = new MockRedisSnapshot();
    const redisCache = new MockRedisCache();
    const graphitiAsync = new MockGraphitiAsync();

    const handler = createEventHandler({
      sessionManager: sessionManager as never,
      redisEvents: redisEvents as never,
      redisCache: redisCache as never,
      redisSnapshot: redisSnapshot as never,
      graphitiAsync: graphitiAsync as never,
      defaultGroupId: "group-1",
      defaultUserGroupId: "user-1",
      sdkClient: { provider: { list: () => ({ data: [] }) } } as never,
      directory: "/tmp/project",
    });

    await handler({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            sessionID: "session-1",
            messageID: "m1",
            text: "Buffered answer",
          },
        },
      } as never,
    });

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "m1",
            sessionID: "session-1",
            role: "assistant",
            time: { created: 1, completed: 2 },
          },
        },
      } as never,
    });

    assertEquals(sessionManager.getState("session-1")?.pendingMessages, [
      "Assistant: Buffered answer",
    ]);
    assertEquals(redisEvents.calls.length >= 1, true);
    assertStringIncludes(redisEvents.calls[0].summary, "Buffered answer");
    assertEquals(redisEvents.calls[0].body, undefined);
    assertEquals(typeof redisEvents.calls[0].continuityText, "string");
  });

  it("records the compaction summary as a structured event before rebuilding the snapshot", async () => {
    const sessionManager = new MockSessionManager();
    const state = sessionManager.createDefaultState("group-1", "user-1");
    sessionManager.setState("session-1", state);
    const redisEvents = new MockRedisEvents();
    const redisSnapshot = new MockRedisSnapshot();
    const redisCache = new MockRedisCache();
    const graphitiAsync = new MockGraphitiAsync();

    const handler = createEventHandler({
      sessionManager: sessionManager as never,
      redisEvents: redisEvents as never,
      redisCache: redisCache as never,
      redisSnapshot: redisSnapshot as never,
      graphitiAsync: graphitiAsync as never,
      defaultGroupId: "group-1",
      defaultUserGroupId: "user-1",
      sdkClient: { provider: { list: () => ({ data: [] }) } } as never,
      directory: "/tmp/project",
    });

    await handler({
      event: {
        type: "session.compacted",
        properties: { sessionID: "session-1", summary: "Compaction summary" },
      } as never,
    });

    assertEquals(
      redisEvents.calls.some((call) =>
        call.summary.includes("Compaction summary")
      ),
      true,
    );
    assertEquals(redisSnapshot.saved.length, 1);
  });

  it("rebuilds the local snapshot and schedules async drain on session.idle", async () => {
    const clock = new FakeClock();
    const sessionManager = new MockSessionManager({
      idleRetentionMs: 100,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const state = sessionManager.createDefaultState("group-1", "user-1");
    state.latestUserRequest = "Refresh the cache";
    sessionManager.setState("session-1", state);
    const redisEvents = new MockRedisEvents();
    const redisSnapshot = new MockRedisSnapshot();
    const redisCache = new MockRedisCache();
    const graphitiAsync = new MockGraphitiAsync();

    const handler = createEventHandler({
      sessionManager: sessionManager as never,
      redisEvents: redisEvents as never,
      redisCache: redisCache as never,
      redisSnapshot: redisSnapshot as never,
      graphitiAsync: graphitiAsync as never,
      defaultGroupId: "group-1",
      defaultUserGroupId: "user-1",
      sdkClient: { provider: { list: () => ({ data: [] }) } } as never,
      directory: "/tmp/project",
    });

    await handler({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-1" },
      } as never,
    });

    assertEquals(redisSnapshot.saved.length, 1);
    assertEquals(graphitiAsync.drainCalls, ["group-1"]);
    assertEquals(sessionManager.idleCleanupCalls, ["session-1"]);
    assertEquals(graphitiAsync.refreshCalls, [{
      groupId: "group-1",
      query: "Refresh the cache",
    }]);
  });

  it("uses Redis-backed refresh query fallback on session.idle after restart", async () => {
    const sessionManager = new MockSessionManager({ idleRetentionMs: 100 });
    const state = sessionManager.createDefaultState("group-1", "user-1");
    sessionManager.setState("session-1", state);
    const redisEvents = new MockRedisEvents();
    const redisSnapshot = new MockRedisSnapshot();
    const redisCache = new MockRedisCache();
    redisCache.metaByGroupId.set("group-1", {
      lastQuery: "resume refresh from redis",
      factUuids: [],
    });
    const graphitiAsync = new MockGraphitiAsync();

    const handler = createEventHandler({
      sessionManager: sessionManager as never,
      redisEvents: redisEvents as never,
      redisCache: redisCache as never,
      redisSnapshot: redisSnapshot as never,
      graphitiAsync: graphitiAsync as never,
      defaultGroupId: "group-1",
      defaultUserGroupId: "user-1",
      sdkClient: { provider: { list: () => ({ data: [] }) } } as never,
      directory: "/tmp/project",
    });

    await handler({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-1" },
      } as never,
    });

    assertEquals(graphitiAsync.refreshCalls, [{
      groupId: "group-1",
      query: "resume refresh from redis",
    }]);
    assertEquals(
      sessionManager.getState("session-1")?.latestRefreshQuery,
      "resume refresh from redis",
    );
  });

  it("cleans session state immediately on session.deleted", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.setState(
      "session-1",
      sessionManager.createDefaultState("group-1", "user-1"),
    );
    const { handler } = createHandler(sessionManager);

    await handler({
      event: {
        type: "session.deleted",
        properties: { sessionID: "session-1" },
      } as never,
    });

    assertEquals(sessionManager.getState("session-1"), undefined);
    assertEquals(sessionManager.deletedSessions, ["session-1"]);
  });

  it("keeps reactivated sessions from being deleted by stale idle cleanup", async () => {
    const clock = new FakeClock();
    const sessionManager = new MockSessionManager({
      idleRetentionMs: 100,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    sessionManager.setState(
      "session-1",
      sessionManager.createDefaultState("group-1", "user-1"),
    );
    const { handler } = createHandler(sessionManager);

    await handler({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-1" },
      } as never,
    });

    clock.tick(50);

    await handler({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            sessionID: "session-1",
            messageID: "m1",
            text: "reactivated",
          },
        },
      } as never,
    });

    clock.tick(60);
    assertEquals(sessionManager.getState("session-1")?.groupId, "group-1");
    assertEquals(sessionManager.deletedSessions, []);

    await handler({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-1" },
      } as never,
    });

    clock.tick(100);
    assertEquals(sessionManager.getState("session-1"), undefined);
    assertEquals(sessionManager.deletedSessions, ["session-1"]);
  });

  it("does not schedule stale idle cleanup when reactivated during async idle work", async () => {
    const clock = new FakeClock();
    const sessionManager = new MockSessionManager({
      idleRetentionMs: 100,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    sessionManager.setState(
      "session-1",
      sessionManager.createDefaultState("group-1", "user-1"),
    );
    const redisEvents = new DeferredRedisEvents();
    const redisSnapshot = new MockRedisSnapshot();
    const redisCache = new MockRedisCache();
    const graphitiAsync = new MockGraphitiAsync();

    const handler = createEventHandler({
      sessionManager: sessionManager as never,
      redisEvents: redisEvents as never,
      redisCache: redisCache as never,
      redisSnapshot: redisSnapshot as never,
      graphitiAsync: graphitiAsync as never,
      defaultGroupId: "group-1",
      defaultUserGroupId: "user-1",
      sdkClient: { provider: { list: () => ({ data: [] }) } } as never,
      directory: "/tmp/project",
    });

    const idleRun = handler({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-1" },
      } as never,
    });

    await Promise.resolve();
    sessionManager.markSessionActive("session-1");
    redisEvents.resume();
    await idleRun;

    clock.tick(150);
    assertEquals(sessionManager.getState("session-1")?.groupId, "group-1");
    assertEquals(sessionManager.deletedSessions, []);
    assertEquals(clock.timers.size, 0);
  });

  it("uses Redis-backed refresh query fallback on session.compacted after restart", async () => {
    const sessionManager = new MockSessionManager();
    const state = sessionManager.createDefaultState("group-1", "user-1");
    sessionManager.setState("session-1", state);
    const redisEvents = new MockRedisEvents();
    const redisSnapshot = new MockRedisSnapshot();
    const redisCache = new MockRedisCache();
    redisCache.metaByGroupId.set("group-1", {
      lastQuery: "refresh after compact restart",
      factUuids: [],
    });
    const graphitiAsync = new MockGraphitiAsync();

    const handler = createEventHandler({
      sessionManager: sessionManager as never,
      redisEvents: redisEvents as never,
      redisCache: redisCache as never,
      redisSnapshot: redisSnapshot as never,
      graphitiAsync: graphitiAsync as never,
      defaultGroupId: "group-1",
      defaultUserGroupId: "user-1",
      sdkClient: { provider: { list: () => ({ data: [] }) } } as never,
      directory: "/tmp/project",
    });

    await handler({
      event: {
        type: "session.compacted",
        properties: { sessionID: "session-1", summary: "Compacted state" },
      } as never,
    });

    assertEquals(graphitiAsync.refreshCalls, [{
      groupId: "group-1",
      query: "refresh after compact restart",
    }]);
    assertEquals(
      sessionManager.getState("session-1")?.latestRefreshQuery,
      "refresh after compact restart",
    );
  });

  it("records supported non-special events into the hot-tier log for main sessions", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.setState(
      "session-1",
      sessionManager.createDefaultState("group-1", "user-1"),
    );
    const { handler, redisEvents, graphitiAsync } = createHandler(
      sessionManager,
    );

    await handler({
      event: {
        type: "task.updated",
        properties: {
          sessionID: "session-1",
          task: {
            id: "task-1",
            path: "src/handlers/event.ts",
            summary: "Implement event handler blocker fix",
          },
        },
      } as never,
    });

    await handler({
      event: {
        type: "rules.loaded",
        properties: {
          sessionID: "session-1",
          name: "CodingGuideline",
          path: "docs/CodingGuideline.md",
        },
      } as never,
    });

    await handler({
      event: {
        type: "environment.updated",
        properties: {
          sessionID: "session-1",
          cwd: "/tmp/project",
          summary: "Working directory changed to /tmp/project",
        },
      } as never,
    });

    await handler({
      event: {
        type: "tool.called",
        properties: {
          sessionID: "session-1",
          tool: "Read",
          path: "src/handlers/event.ts",
          summary: "Read file src/handlers/event.ts",
        },
      } as never,
    });

    await handler({
      event: {
        type: "tool.completed",
        properties: {
          sessionID: "session-1",
          tool: "git status",
          summary: "Checked branch status before commit",
        },
      } as never,
    });

    await handler({
      event: {
        type: "subagent.started",
        properties: {
          sessionID: "session-1",
          agentId: "agent-1",
          summary: "Started review subagent",
        },
      } as never,
    });

    await handler({
      event: {
        type: "subagent.finished",
        properties: {
          sessionID: "session-1",
          agentId: "agent-1",
          summary: "Finished review subagent",
        },
      } as never,
    });

    assertEquals(
      redisEvents.calls.map((call) => call.category),
      [
        "task.create",
        "rule.load",
        "cwd.change",
        "env.change",
        "file.read",
        "git.activity",
        "subagent.start",
        "subagent.finish",
      ],
    );
    assertEquals(
      redisEvents.calls.every((call) => call.groupId === "group-1"),
      true,
    );
    assertEquals(graphitiAsync.primerCalls.length, 0);
    assertEquals(graphitiAsync.drainCalls.length, 0);
    assertEquals(graphitiAsync.refreshCalls.length, 0);
  });

  it("avoids durably storing raw tool output bodies for normal tool activity", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.setState(
      "session-1",
      sessionManager.createDefaultState("group-1", "user-1"),
    );
    const { handler, redisEvents } = createHandler(sessionManager);

    await handler({
      event: {
        type: "tool.completed",
        properties: {
          sessionID: "session-1",
          tool: "Read",
          path: "src/session.ts",
          summary:
            "Read src/session.ts and inspected continuity fields without retaining the raw output transcript",
        },
      } as never,
    });

    assertEquals(redisEvents.calls.length, 1);
    assertEquals(redisEvents.calls[0].category, "file.read");
    assertEquals(redisEvents.calls[0].body, undefined);
    assertEquals(typeof redisEvents.calls[0].continuityText, "string");
  });

  it("skips the catch-all for events without a resolvable main session", async () => {
    const sessionManager = new MockSessionManager();
    const childState = sessionManager.createDefaultState("group-1", "user-1");
    childState.isMain = false;
    sessionManager.setState("child-session", childState);
    const { handler, redisEvents } = createHandler(sessionManager);

    await handler({
      event: {
        type: "tool.called",
        properties: {
          sessionID: "missing-session",
          tool: "Read",
          summary: "Read file src/handlers/event.ts",
        },
      } as never,
    });

    await handler({
      event: {
        type: "tool.called",
        properties: {
          sessionID: "child-session",
          tool: "Read",
          summary: "Read file src/handlers/event.ts",
        },
      } as never,
    });

    assertEquals(redisEvents.calls.length, 0);
  });
});
