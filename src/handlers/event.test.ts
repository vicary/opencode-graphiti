import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { createEventHandler } from "./event.ts";
import { resolveContextLimit } from "../services/context-limit.ts";
import { setLoggerSilentOverride } from "../services/logger.ts";
import type { SessionState } from "../session.ts";
import type { SessionEvent } from "../types/index.ts";

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
  canonicalIds = new Map<string, string>();
  buffered = new Map<string, { text: string; sourceSessionId: string }>();
  pendingAssistantCompletions = new Set<string>();
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
      messageCount: 0,
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
    const previousCanonicalId = this.canonicalIds.get(sessionId) ??
      (this.parentIds.get(sessionId) === null ? sessionId : undefined);
    this.parentIds.set(sessionId, parentId);
    if (!parentId) {
      this.canonicalIds.set(sessionId, sessionId);
      return;
    }
    const canonicalId = this.canonicalIds.get(parentId) ?? parentId;
    this.canonicalIds.set(sessionId, canonicalId);
    if (previousCanonicalId && previousCanonicalId !== canonicalId) {
      this.migrateState(sessionId, canonicalId);
    }
  }

  setState(sessionId: string, state: SessionState) {
    this.sessions.set(sessionId, state);
    if (!this.parentIds.has(sessionId) && !this.canonicalIds.has(sessionId)) {
      this.parentIds.set(sessionId, null);
      this.canonicalIds.set(sessionId, sessionId);
    }
  }

  markSessionActive(sessionId: string) {
    this.activeMarks.push(sessionId);
    this.markLifecycleActive(sessionId);
    const canonicalId = this.canonicalIds.get(sessionId);
    if (canonicalId && canonicalId !== sessionId) {
      this.activeMarks.push(canonicalId);
      this.markLifecycleActive(canonicalId);
    }
  }

  markResolvedSessionActive(sessionId: string, canonicalSessionId?: string) {
    this.activeMarks.push(sessionId);
    this.markLifecycleActive(sessionId);
    if (canonicalSessionId && canonicalSessionId !== sessionId) {
      this.activeMarks.push(canonicalSessionId);
      this.markLifecycleActive(canonicalSessionId);
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

  resolveCanonicalSessionId(sessionId: string) {
    const parentId = this.parentIds.get(sessionId);
    if (parentId === null) return sessionId;
    if (parentId === undefined) return this.canonicalIds.get(sessionId);
    const canonicalId = this.canonicalIds.get(parentId) ?? parentId;
    this.canonicalIds.set(sessionId, canonicalId);
    this.markLifecycleActive(canonicalId);
    return canonicalId;
  }

  resolveSessionState(sessionId: string) {
    const canonicalSessionId = this.resolveCanonicalSessionId(sessionId);
    let state = canonicalSessionId
      ? this.sessions.get(canonicalSessionId) ?? null
      : null;
    if (canonicalSessionId && !state) {
      state = this.createDefaultState("group-1", "user-1");
      this.sessions.set(canonicalSessionId, state);
    }
    return {
      state,
      resolved: canonicalSessionId !== undefined,
      canonicalSessionId,
    };
  }

  bufferAssistantPart(
    sessionId: string,
    messageId: string,
    text: string,
    sourceSessionId = sessionId,
  ) {
    this.buffered.set(`${sessionId}:${messageId}`, { text, sourceSessionId });
  }

  isAssistantBuffered() {
    return false;
  }

  finalizeAssistantMessage(
    _state: SessionState,
    sessionId: string,
    messageId: string,
  ) {
    const key = `${sessionId}:${messageId}`;
    const buffered = this.buffered.get(key);
    const text = buffered?.text ?? "";
    if (!text) {
      this.pendingAssistantCompletions.add(key);
      return null;
    }
    this.pendingAssistantCompletions.delete(key);
    this.buffered.delete(key);
    return text;
  }

  hasPendingAssistantCompletion(sessionId: string, messageId: string) {
    return this.pendingAssistantCompletions.has(`${sessionId}:${messageId}`);
  }

  deletePendingAssistant(sessionId: string, messageId: string) {
    const key = `${sessionId}:${messageId}`;
    this.buffered.delete(key);
    this.pendingAssistantCompletions.delete(key);
  }

  purgeAssistantBufferSource(sourceSessionId: string) {
    for (const [key, buffered] of [...this.buffered.entries()]) {
      if (buffered.sourceSessionId === sourceSessionId) {
        this.buffered.delete(key);
        this.pendingAssistantCompletions.delete(key);
      }
    }
  }

  deleteSession(sessionId: string) {
    this.deletedSessions.push(sessionId);
    const lifecycle = this.lifecycles.get(sessionId);
    if (lifecycle?.timerId != null) this.clearTimerImpl(lifecycle.timerId);
    this.lifecycles.delete(sessionId);
    this.sessions.delete(sessionId);
    this.parentIds.delete(sessionId);
    this.canonicalIds.delete(sessionId);
    for (const [childSessionId, parentId] of [...this.parentIds.entries()]) {
      if (parentId === sessionId) this.parentIds.delete(childSessionId);
    }
    for (
      const [childSessionId, canonicalId] of [...this.canonicalIds.entries()]
    ) {
      if (canonicalId === sessionId) this.canonicalIds.delete(childSessionId);
    }
    for (const key of [...this.buffered.keys()]) {
      if (key.startsWith(`${sessionId}:`)) {
        this.buffered.delete(key);
        this.pendingAssistantCompletions.delete(key);
      }
    }
  }

  private markLifecycleActive(sessionId: string) {
    const lifecycle = this.getLifecycle(sessionId);
    lifecycle.generation += 1;
    if (lifecycle.timerId !== null) {
      this.clearTimerImpl(lifecycle.timerId);
      lifecycle.timerId = null;
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

  private migrateState(sessionId: string, canonicalSessionId: string) {
    if (sessionId === canonicalSessionId) return;
    const sourceState = this.sessions.get(sessionId);
    if (!sourceState) return;
    const targetState = this.sessions.get(canonicalSessionId);
    if (targetState) {
      targetState.injectedMemories ||= sourceState.injectedMemories;
      targetState.messageCount += sourceState.messageCount;
      targetState.contextLimit = Math.max(
        targetState.contextLimit,
        sourceState.contextLimit,
      );
      targetState.isMain ||= sourceState.isMain;
      targetState.hotTierReady ||= sourceState.hotTierReady;
      if (sourceState.latestUserRequest) {
        targetState.latestUserRequest = sourceState.latestUserRequest;
      }
      if (sourceState.latestRefreshQuery) {
        targetState.latestRefreshQuery = sourceState.latestRefreshQuery;
      }
      if (sourceState.pendingInjection !== undefined) {
        targetState.pendingInjection = sourceState.pendingInjection;
      }
      targetState.pendingInjectionGeneration = Math.max(
        targetState.pendingInjectionGeneration,
        sourceState.pendingInjectionGeneration,
      );
    } else {
      this.sessions.set(canonicalSessionId, sourceState);
    }
    this.sessions.delete(sessionId);
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
  events: SessionEvent[] = [];
  touchedSessionIds: string[] = [];

  recordEvent(
    sessionId: string,
    groupId: string,
    event: SessionEvent,
  ) {
    this.calls.push({
      sessionId,
      groupId,
      summary: event.summary,
      category: event.category,
      body: event.body,
      continuityText: event.continuityText,
    });
    this.events.push(event);
    return 1;
  }

  async getRecentSessionEvents(_sessionId: string, limit = 40) {
    await Promise.resolve();
    return this.events.slice(-limit);
  }

  async touchSessionEvents(sessionId: string) {
    await Promise.resolve();
    this.touchedSessionIds.push(sessionId);
  }
}

class DeferredRedisEvents extends MockRedisEvents {
  resume!: () => void;

  override async getRecentSessionEvents(sessionId: string, limit = 40) {
    await new Promise<void>((resolve) => {
      this.resume = resolve;
    });
    return super.getRecentSessionEvents(sessionId, limit);
  }
}

class MockRedisSnapshot {
  saved: Array<{ sessionId: string; snapshot: string }> = [];
  touchedSessionIds: string[] = [];

  rebuildAndSave(sessionId: string, events: SessionEvent[]) {
    const refs = [...new Set(events.flatMap((event) => event.refs ?? []))].join(
      ",",
    );
    const snapshot = refs.length > 0
      ? `<snapshot session="${sessionId}" version="2">${refs}</snapshot>`
      : `<snapshot session="${sessionId}" version="2"></snapshot>`;
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
    { lastQuery?: string; lastRefresh?: number }
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

const createHandler = (
  sessionManager: MockSessionManager,
  options: {
    sdkClient?: { provider: { list: () => unknown | Promise<unknown> } };
  } = {},
) => {
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
    sdkClient: (options.sdkClient ??
      { provider: { list: () => ({ data: [] }) } }) as never,
    directory: "/tmp/project",
  });

  return { handler, redisEvents, redisCache, redisSnapshot, graphitiAsync };
};

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
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

  it("preserves existing canonical root state on duplicate session.created", async () => {
    const sessionManager = new MockSessionManager();
    const existingState = sessionManager.createDefaultState(
      "group-existing",
      "user-existing",
    );
    existingState.latestUserRequest = "preserve me";
    existingState.contextLimit = 123_456;
    sessionManager.setParentId("session-1", null);
    sessionManager.setState("session-1", existingState);
    const { handler, redisEvents, redisCache, redisSnapshot, graphitiAsync } =
      createHandler(sessionManager);

    await handler({
      event: {
        type: "session.created",
        properties: { info: { id: "session-1", parentID: null } },
      } as never,
    });

    assertEquals(sessionManager.getState("session-1"), existingState);
    assertEquals(
      sessionManager.getState("session-1")?.latestUserRequest,
      "preserve me",
    );
    assertEquals(sessionManager.getState("session-1")?.contextLimit, 123_456);
    assertEquals(redisEvents.calls.length, 1);
    assertEquals(redisEvents.calls[0].sessionId, "session-1");
    assertEquals(redisEvents.calls[0].groupId, "group-existing");
    assertEquals(redisEvents.calls[0].category, "session.meta");
    assertEquals(redisEvents.calls[0].summary, "Session created: session-1");
    assertEquals(
      redisEvents.calls[0].continuityText,
      "session created session-1",
    );
    assertEquals(redisEvents.touchedSessionIds, ["session-1"]);
    assertEquals(redisSnapshot.touchedSessionIds, ["session-1"]);
    assertEquals(redisCache.touchedGroupIds, ["group-existing"]);
    assertEquals(graphitiAsync.primerCalls, ["group-existing"]);
  });

  it("records child session creation and touch activity against the canonical parent session", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.setParentId("session-1", null);
    sessionManager.setState(
      "session-1",
      sessionManager.createDefaultState("group-1", "user-1"),
    );
    const { handler, redisEvents, redisCache, redisSnapshot, graphitiAsync } =
      createHandler(sessionManager);

    await handler({
      event: {
        type: "session.created",
        properties: { info: { id: "child-1", parentID: "session-1" } },
      } as never,
    });

    assertEquals(redisEvents.calls.length, 1);
    assertEquals(redisEvents.calls[0].sessionId, "session-1");
    assertEquals(redisEvents.touchedSessionIds, ["session-1"]);
    assertEquals(redisSnapshot.touchedSessionIds, ["session-1"]);
    assertEquals(redisCache.touchedGroupIds, ["group-1"]);
    assertEquals(graphitiAsync.primerCalls, []);
  });

  it("preserves assistant buffering without durably storing filtered assistant operational chatter", async () => {
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

    assertEquals(redisEvents.calls.length, 0);
  });

  it("records the compaction summary as a structured event before rebuilding the snapshot", async () => {
    const sessionManager = new MockSessionManager({ idleRetentionMs: 100 });
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
    state.latestRefreshQuery = "Refresh the cache";
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

  it("does not treat latestUserRequest alone as an always-on refresh trigger", async () => {
    const sessionManager = new MockSessionManager({ idleRetentionMs: 100 });
    const state = sessionManager.createDefaultState("group-1", "user-1");
    state.latestUserRequest = "latest user request only";
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

    await handler({
      event: {
        type: "session.compacted",
        properties: {
          sessionID: "session-1",
          summary: "Compacted without refresh decision",
        },
      } as never,
    });

    assertEquals(graphitiAsync.refreshCalls, []);
    assertEquals(
      sessionManager.getState("session-1")?.latestRefreshQuery,
      undefined,
    );
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

  it("does not delete canonical parent state when a child session is deleted", async () => {
    const sessionManager = new MockSessionManager();
    const parentState = sessionManager.createDefaultState("group-1", "user-1");
    parentState.latestUserRequest = "keep parent state";
    sessionManager.setParentId("session-1", null);
    sessionManager.setState("session-1", parentState);
    sessionManager.setParentId("child-1", "session-1");
    const { handler } = createHandler(sessionManager);

    await handler({
      event: {
        type: "session.deleted",
        properties: { sessionID: "child-1" },
      } as never,
    });

    assertEquals(sessionManager.deletedSessions, ["child-1"]);
    assertEquals(
      sessionManager.getState("session-1")?.latestUserRequest,
      "keep parent state",
    );
  });

  it("purges child-buffered assistant state without deleting canonical parent state", async () => {
    const sessionManager = new MockSessionManager();
    const parentState = sessionManager.createDefaultState("group-1", "user-1");
    parentState.latestUserRequest = "keep parent state";
    sessionManager.setParentId("session-1", null);
    sessionManager.setState("session-1", parentState);
    sessionManager.setParentId("child-1", "session-1");
    sessionManager.bufferAssistantPart(
      "session-1",
      "m1",
      "buffered child reply",
      "child-1",
    );
    const { handler } = createHandler(sessionManager);

    await handler({
      event: {
        type: "session.deleted",
        properties: { sessionID: "child-1" },
      } as never,
    });

    assertEquals(sessionManager.deletedSessions, ["child-1"]);
    assertEquals(sessionManager.buffered.size, 0);
    assertEquals(
      sessionManager.getState("session-1")?.latestUserRequest,
      "keep parent state",
    );
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

  it("keeps canonical session state alive when child passthrough activity resumes after idle", async () => {
    const clock = new FakeClock();
    const sessionManager = new MockSessionManager({
      idleRetentionMs: 100,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    sessionManager.setParentId("session-1", null);
    sessionManager.setState(
      "session-1",
      sessionManager.createDefaultState("group-1", "user-1"),
    );
    sessionManager.setParentId("child-session", "session-1");
    const { handler, redisEvents } = createHandler(sessionManager);

    await handler({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-1" },
      } as never,
    });

    clock.tick(50);

    await handler({
      event: {
        type: "tool.called",
        properties: {
          sessionID: "child-session",
          tool: "Read",
          path: "src/handlers/event.ts",
          summary: "Read file src/handlers/event.ts",
        },
      } as never,
    });

    clock.tick(60);

    assertEquals(sessionManager.getState("session-1")?.groupId, "group-1");
    assertEquals(sessionManager.deletedSessions, []);
    assertEquals(redisEvents.calls.length, 1);
    assertEquals(redisEvents.calls[0].sessionId, "session-1");
  });

  it("survives buffered child assistant text through delayed parent canonicalization", async () => {
    const sessionManager = new MockSessionManager();
    const parentState = sessionManager.createDefaultState("group-1", "user-1");
    sessionManager.setParentId("session-1", null);
    sessionManager.setState("session-1", parentState);
    sessionManager.setParentId("child-session", "session-1");
    sessionManager.canonicalIds.delete("child-session");
    const { handler } = createHandler(sessionManager);

    await handler({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            sessionID: "child-session",
            messageID: "m1",
            text: "buffered child reply before canonical resolution",
          },
        },
      } as never,
    });

    assertEquals(sessionManager.getState("session-1")?.groupId, "group-1");
    const bufferedKey = "session-1:m1";
    assertEquals(
      sessionManager.buffered.get(bufferedKey)?.text,
      "buffered child reply before canonical resolution",
    );
    assertEquals(
      sessionManager.buffered.get(bufferedKey)?.sourceSessionId,
      "child-session",
    );

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "m1",
            sessionID: "child-session",
            role: "assistant",
            time: { created: 1, completed: 2 },
          },
        },
      } as never,
    });

    assertEquals(sessionManager.buffered.size, 0);
  });

  it("refreshes the canonical parent lifecycle for cold-cache child message updates", async () => {
    const clock = new FakeClock();
    const sessionManager = new MockSessionManager({
      idleRetentionMs: 100,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    sessionManager.setParentId("session-1", null);
    sessionManager.setState(
      "session-1",
      sessionManager.createDefaultState("group-1", "user-1"),
    );
    sessionManager.parentIds.set("child-session", "session-1");
    sessionManager.canonicalIds.delete("child-session");
    const { handler } = createHandler(sessionManager);

    await handler({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-1" },
      } as never,
    });

    clock.tick(50);

    const idleGeneration = sessionManager.captureIdleCleanupGeneration(
      "session-1",
    );
    assertEquals(typeof idleGeneration, "number");

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "m1",
            sessionID: "child-session",
            role: "user",
            time: { created: 1, completed: 2 },
          },
        },
      } as never,
    });

    assertEquals(sessionManager.activeMarks.includes("session-1"), true);
    clock.tick(60);

    assertEquals(sessionManager.getState("session-1")?.groupId, "group-1");
    assertEquals(sessionManager.deletedSessions, []);
  });

  it("refreshes canonical parent on child session.created when canonical mapping is cold", async () => {
    const clock = new FakeClock();
    const sessionManager = new MockSessionManager({
      idleRetentionMs: 100,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    sessionManager.setParentId("session-1", null);
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

    const idleGeneration = sessionManager.captureIdleCleanupGeneration(
      "session-1",
    );
    assertEquals(typeof idleGeneration, "number");

    await handler({
      event: {
        type: "session.created",
        properties: { info: { id: "child-session", parentID: "session-1" } },
      } as never,
    });

    assertEquals(sessionManager.activeMarks.includes("session-1"), true);
    clock.tick(60);

    assertEquals(sessionManager.getState("session-1")?.groupId, "group-1");
    assertEquals(sessionManager.deletedSessions, []);
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

  it("caches the fallback context-limit after a transient provider failure", async () => {
    const sessionManager = new MockSessionManager();
    const state = sessionManager.createDefaultState("group-1", "user-1");
    sessionManager.setState("session-1", state);
    let providerCalls = 0;
    const sdkClient = {
      provider: {
        list: () => {
          providerCalls += 1;
          if (providerCalls === 1) {
            throw new Error("transient provider failure");
          }
          return Promise.resolve({
            data: [{
              id: "openai",
              models: [{ id: "gpt-5", limit: { context: 123_456 } }],
            }],
          });
        },
      },
    };
    const { handler } = createHandler(sessionManager, { sdkClient });

    try {
      setLoggerSilentOverride(true);

      await handler({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "m1",
              sessionID: "session-1",
              role: "assistant",
              time: { created: 1, completed: 2 },
              tokens: { output: 10 },
              providerID: "openai",
              modelID: "gpt-5",
            },
          },
        } as never,
      });
      await flushPromises();

      assertEquals(state.contextLimit, 200_000);

      await handler({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "m2",
              sessionID: "session-1",
              role: "assistant",
              time: { created: 3, completed: 4 },
              tokens: { output: 12 },
              providerID: "openai",
              modelID: "gpt-5",
            },
          },
        } as never,
      });
      await flushPromises();

      assertEquals(providerCalls, 1);
      assertEquals(state.contextLimit, 200_000);
    } finally {
      setLoggerSilentOverride(false);
    }
  });

  it("caches unknown provider/model misses to avoid repeated lookups", async () => {
    const sessionManager = new MockSessionManager();
    const state = sessionManager.createDefaultState("group-1", "user-1");
    sessionManager.setState("session-1", state);
    let providerCalls = 0;
    const sdkClient = {
      provider: {
        list: () => {
          providerCalls += 1;
          return Promise.resolve({
            data: [{
              id: "openai",
              models: [{ id: "gpt-5", limit: { context: 123_456 } }],
            }],
          });
        },
      },
    };
    const { handler } = createHandler(sessionManager, { sdkClient });

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "m1",
            sessionID: "session-1",
            role: "assistant",
            time: { created: 1, completed: 2 },
            tokens: { output: 10 },
            providerID: "unknown-provider",
            modelID: "unknown-model",
          },
        },
      } as never,
    });
    await flushPromises();

    assertEquals(state.contextLimit, 200_000);

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "m2",
            sessionID: "session-1",
            role: "assistant",
            time: { created: 3, completed: 4 },
            tokens: { output: 12 },
            providerID: "unknown-provider",
            modelID: "unknown-model",
          },
        },
      } as never,
    });
    await flushPromises();

    assertEquals(providerCalls, 1);
    assertEquals(state.contextLimit, 200_000);
  });

  it("keeps successful positive context-limits cached across repeated lookups", async () => {
    const sessionManager = new MockSessionManager();
    const firstState = sessionManager.createDefaultState("group-1", "user-1");
    const secondState = sessionManager.createDefaultState("group-1", "user-1");
    sessionManager.setState("session-1", firstState);
    sessionManager.setState("session-2", secondState);
    let providerCalls = 0;
    const sdkClient = {
      provider: {
        list: () => {
          providerCalls += 1;
          return Promise.resolve({
            data: [{
              id: "openai",
              models: [{ id: "gpt-5", limit: { context: 123_456 } }],
            }],
          });
        },
      },
    };
    const { handler } = createHandler(sessionManager, { sdkClient });

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "m1",
            sessionID: "session-1",
            role: "assistant",
            time: { created: 1, completed: 2 },
            tokens: { output: 10 },
            providerID: "openai",
            modelID: "gpt-5",
          },
        },
      } as never,
    });
    await flushPromises();

    assertEquals(providerCalls, 1);
    assertEquals(firstState.contextLimit, 123_456);

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "m2",
            sessionID: "session-2",
            role: "assistant",
            time: { created: 3, completed: 4 },
            tokens: { output: 12 },
            providerID: "openai",
            modelID: "gpt-5",
          },
        },
      } as never,
    });
    await flushPromises();

    assertEquals(providerCalls, 1);
    assertEquals(secondState.contextLimit, 123_456);
  });

  it("separates cached context-limits by directory while preserving directory-less cache hits", async () => {
    const cache = new Map<
      string,
      number | { value: number; expiresAt?: number }
    >();
    const calls: Array<Record<string, unknown>> = [];
    const sdkClient = {
      provider: {
        list: ({ query }: { query?: { directory?: string } }) => {
          calls.push(query ?? {});
          const directory = query?.directory;
          const context = directory === "/tmp/project-a"
            ? 111_111
            : directory === "/tmp/project-b"
            ? 222_222
            : 333_333;
          return Promise.resolve({
            data: [{
              id: "openai",
              models: [{ id: "gpt-5", limit: { context } }],
            }],
          });
        },
      },
    };

    assertEquals(
      await resolveContextLimit(
        "openai",
        "gpt-5",
        sdkClient as never,
        "/tmp/project-a",
        cache,
      ),
      111_111,
    );
    assertEquals(
      await resolveContextLimit(
        "openai",
        "gpt-5",
        sdkClient as never,
        "/tmp/project-b",
        cache,
      ),
      222_222,
    );
    assertEquals(
      await resolveContextLimit(
        "openai",
        "gpt-5",
        sdkClient as never,
        "/tmp/project-a",
        cache,
      ),
      111_111,
    );
    assertEquals(
      await resolveContextLimit(
        "openai",
        "gpt-5",
        sdkClient as never,
        "",
        cache,
      ),
      333_333,
    );
    assertEquals(
      await resolveContextLimit(
        "openai",
        "gpt-5",
        sdkClient as never,
        "   ",
        cache,
      ),
      333_333,
    );

    assertEquals(calls, [
      { directory: "/tmp/project-a" },
      { directory: "/tmp/project-b" },
      {},
    ]);
  });

  it("applies async context-limit updates to the current canonical session state", async () => {
    const sessionManager = new MockSessionManager();
    const parentState = sessionManager.createDefaultState("group-1", "user-1");
    const childState = sessionManager.createDefaultState("group-1", "user-1");
    childState.contextLimit = 1;
    sessionManager.setParentId("session-1", null);
    sessionManager.setState("session-1", parentState);
    sessionManager.setState("child-session", childState);

    let resolveProviders!: (
      value: {
        data: Array<
          {
            id: string;
            models: Array<{ id: string; limit: { context: number } }>;
          }
        >;
      },
    ) => void;
    const sdkClient = {
      provider: {
        list: () =>
          new Promise<typeof providerResponse>((resolve) => {
            resolveProviders = resolve;
          }),
      },
    };
    const providerResponse = {
      data: [{
        id: "openai",
        models: [{ id: "gpt-5", limit: { context: 123_456 } }],
      }],
    };
    const { handler } = createHandler(sessionManager, { sdkClient });

    const eventRun = handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "m1",
            sessionID: "child-session",
            role: "assistant",
            time: { created: 1, completed: 2 },
            tokens: { output: 10 },
            providerID: "openai",
            modelID: "gpt-5",
          },
        },
      } as never,
    });
    await eventRun;

    sessionManager.setParentId("child-session", "session-1");
    resolveProviders(providerResponse);
    await flushPromises();
    await flushPromises();

    assertEquals(sessionManager.getState("child-session"), undefined);
    assertEquals(sessionManager.getState("session-1")?.contextLimit, 123_456);
  });

  it("ignores stale overlapping async context-limit writes for the same session", async () => {
    const sessionManager = new MockSessionManager();
    const state = sessionManager.createDefaultState("group-1", "user-1");
    sessionManager.setState("session-1", state);

    let resolveFirst!: (value: typeof firstProviderResponse) => void;
    let resolveSecond!: (value: typeof secondProviderResponse) => void;
    let providerCalls = 0;
    const firstProviderResponse = {
      data: [{
        id: "openai",
        models: [{ id: "gpt-5", limit: { context: 111_111 } }],
      }],
    };
    const secondProviderResponse = {
      data: [{
        id: "openai",
        models: [{ id: "gpt-5", limit: { context: 222_222 } }],
      }],
    };
    const sdkClient = {
      provider: {
        list: () => {
          providerCalls += 1;
          if (providerCalls === 1) {
            return new Promise<typeof firstProviderResponse>((resolve) => {
              resolveFirst = resolve;
            });
          }
          return new Promise<typeof secondProviderResponse>((resolve) => {
            resolveSecond = resolve;
          });
        },
      },
    };
    const { handler } = createHandler(sessionManager, { sdkClient });

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "m1",
            sessionID: "session-1",
            role: "assistant",
            time: { created: 1, completed: 2 },
            tokens: { output: 10 },
            providerID: "openai",
            modelID: "gpt-5",
          },
        },
      } as never,
    });

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "m2",
            sessionID: "session-1",
            role: "assistant",
            time: { created: 3, completed: 4 },
            tokens: { output: 12 },
            providerID: "openai",
            modelID: "gpt-5",
          },
        },
      } as never,
    });

    resolveSecond(secondProviderResponse);
    await flushPromises();
    await flushPromises();
    assertEquals(state.contextLimit, 222_222);

    resolveFirst(firstProviderResponse);
    await flushPromises();
    await flushPromises();

    assertEquals(providerCalls, 2);
    assertEquals(state.contextLimit, 222_222);
  });

  it("ignores stale child-vs-parent async context-limit races for one canonical session", async () => {
    const sessionManager = new MockSessionManager();
    const parentState = sessionManager.createDefaultState("group-1", "user-1");
    sessionManager.setParentId("session-1", null);
    sessionManager.setState("session-1", parentState);
    sessionManager.setParentId("child-session", "session-1");

    let resolveChild!: (value: typeof childProviderResponse) => void;
    let resolveParent!: (value: typeof parentProviderResponse) => void;
    let providerCalls = 0;
    const childProviderResponse = {
      data: [{
        id: "openai",
        models: [{ id: "gpt-5", limit: { context: 111_111 } }],
      }],
    };
    const parentProviderResponse = {
      data: [{
        id: "openai",
        models: [{ id: "gpt-5", limit: { context: 222_222 } }],
      }],
    };
    const sdkClient = {
      provider: {
        list: () => {
          providerCalls += 1;
          if (providerCalls === 1) {
            return new Promise<typeof childProviderResponse>((resolve) => {
              resolveChild = resolve;
            });
          }
          return new Promise<typeof parentProviderResponse>((resolve) => {
            resolveParent = resolve;
          });
        },
      },
    };
    const { handler } = createHandler(sessionManager, { sdkClient });

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "m1",
            sessionID: "child-session",
            role: "assistant",
            time: { created: 1, completed: 2 },
            tokens: { output: 10 },
            providerID: "openai",
            modelID: "gpt-5",
          },
        },
      } as never,
    });

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "m2",
            sessionID: "session-1",
            role: "assistant",
            time: { created: 3, completed: 4 },
            tokens: { output: 12 },
            providerID: "openai",
            modelID: "gpt-5",
          },
        },
      } as never,
    });

    resolveParent(parentProviderResponse);
    await flushPromises();
    await flushPromises();
    assertEquals(parentState.contextLimit, 222_222);

    resolveChild(childProviderResponse);
    await flushPromises();
    await flushPromises();

    assertEquals(providerCalls, 2);
    assertEquals(parentState.contextLimit, 222_222);
  });

  it("drops late async context-limit completions after session deletion", async () => {
    const sessionManager = new MockSessionManager();
    const state = sessionManager.createDefaultState("group-1", "user-1");
    sessionManager.setState("session-1", state);

    let resolveProviders!: (value: typeof providerResponse) => void;
    const providerResponse = {
      data: [{
        id: "openai",
        models: [{ id: "gpt-5", limit: { context: 123_456 } }],
      }],
    };
    const sdkClient = {
      provider: {
        list: () =>
          new Promise<typeof providerResponse>((resolve) => {
            resolveProviders = resolve;
          }),
      },
    };
    const { handler } = createHandler(sessionManager, { sdkClient });

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "m1",
            sessionID: "session-1",
            role: "assistant",
            time: { created: 1, completed: 2 },
            tokens: { output: 10 },
            providerID: "openai",
            modelID: "gpt-5",
          },
        },
      } as never,
    });

    await handler({
      event: {
        type: "session.deleted",
        properties: { sessionID: "session-1" },
      } as never,
    });

    resolveProviders(providerResponse);
    await flushPromises();
    await flushPromises();

    assertEquals(sessionManager.getState("session-1"), undefined);
    assertEquals(sessionManager.deletedSessions, ["session-1"]);
  });

  it("cleans stale context-limit lookups after superseded overlap and after settled writes", async () => {
    const sessionManager = new MockSessionManager();
    const state = sessionManager.createDefaultState("group-1", "user-1");
    sessionManager.setState("session-1", state);

    let resolveFirst!: (value: typeof firstProviderResponse) => void;
    let resolveSecond!: (value: typeof secondProviderResponse) => void;
    let providerCalls = 0;
    const firstProviderResponse = {
      data: [{
        id: "openai",
        models: [{ id: "gpt-5", limit: { context: 111_111 } }],
      }],
    };
    const secondProviderResponse = {
      data: [{
        id: "openai",
        models: [{ id: "gpt-5", limit: { context: 222_222 } }],
      }],
    };
    const sdkClient = {
      provider: {
        list: () => {
          providerCalls += 1;
          if (providerCalls === 1) {
            return new Promise<typeof firstProviderResponse>((resolve) => {
              resolveFirst = resolve;
            });
          }
          return new Promise<typeof secondProviderResponse>((resolve) => {
            resolveSecond = resolve;
          });
        },
      },
    };
    const { handler } = createHandler(sessionManager, { sdkClient });

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "m1",
            sessionID: "session-1",
            role: "assistant",
            time: { created: 1, completed: 2 },
            tokens: { output: 10 },
            providerID: "openai",
            modelID: "gpt-5",
          },
        },
      } as never,
    });

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "m2",
            sessionID: "session-1",
            role: "assistant",
            time: { created: 3, completed: 4 },
            tokens: { output: 12 },
            providerID: "openai",
            modelID: "gpt-5",
          },
        },
      } as never,
    });

    resolveSecond(secondProviderResponse);
    await flushPromises();
    await flushPromises();
    assertEquals(state.contextLimit, 222_222);

    await handler({
      event: {
        type: "session.deleted",
        properties: { sessionID: "session-1" },
      } as never,
    });

    resolveFirst(firstProviderResponse);
    await flushPromises();
    await flushPromises();

    assertEquals(state.contextLimit, 222_222);
    assertEquals(sessionManager.getState("session-1"), undefined);
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

  it("records compact continuity metadata for session_* tool results without requiring Graphiti on the hot path", async () => {
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
        type: "tool.completed",
        properties: {
          sessionID: "session-1",
          tool: "session_execute_file",
          args: {
            root_session_id: "session-1",
            paths: ["src/session.ts"],
          },
          output: JSON.stringify({
            status: "ok",
            summary: "Indexed src/session.ts for continuity checks",
            artifact_ref: "local://session_execute_file/1",
            corpus_ref: "local://session/root/corpus/1",
            file_count: 1,
            truncated: true,
          }),
        },
      } as never,
    });

    assertEquals(redisEvents.calls.length, 1);
    assertEquals(redisEvents.calls[0].category, "file.read");
    assertStringIncludes(
      redisEvents.calls[0].continuityText ?? "",
      "src/session.ts",
    );
    assertEquals(graphitiAsync.primerCalls, []);
    assertEquals(graphitiAsync.drainCalls, []);
    assertEquals(graphitiAsync.refreshCalls, []);
  });

  it("keeps session_* continuity in the local snapshot model across compaction and idle rebuilds", async () => {
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
        type: "tool.completed",
        properties: {
          sessionID: "session-1",
          tool: "session_execute_file",
          args: {
            root_session_id: "session-1",
            paths: ["src/session.ts"],
          },
          output: JSON.stringify({
            status: "ok",
            summary: "Indexed src/session.ts for continuity checks",
            artifact_ref: "local://session_execute_file/1",
            corpus_ref: "local://session/root/corpus/1",
            file_count: 1,
            truncated: false,
          }),
        },
      } as never,
    });

    await handler({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-1" },
      } as never,
    });

    await handler({
      event: {
        type: "session.compacted",
        properties: {
          sessionID: "session-1",
          summary: "Compacted continuity after session_execute_file",
        },
      } as never,
    });

    assertEquals(redisSnapshot.saved.length, 1);
    assertStringIncludes(redisSnapshot.saved[0].snapshot, "src/session.ts");
    assertEquals(graphitiAsync.drainCalls.length >= 1, true);
  });

  it("routes child-session passthrough events onto the canonical parent session", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.setParentId("session-1", null);
    sessionManager.setState(
      "session-1",
      sessionManager.createDefaultState("group-1", "user-1"),
    );
    sessionManager.setParentId("child-session", "session-1");
    const { handler, redisEvents } = createHandler(sessionManager);

    await handler({
      event: {
        type: "tool.called",
        properties: {
          sessionID: "child-session",
          tool: "Read",
          path: "src/handlers/event.ts",
          summary: "Read file src/handlers/event.ts",
        },
      } as never,
    });

    assertEquals(redisEvents.calls.length, 1);
    assertEquals(redisEvents.calls[0].sessionId, "session-1");
    assertEquals(redisEvents.calls[0].category, "file.read");
    assertEquals(
      sessionManager.activeMarks.includes("child-session"),
      true,
    );
    assertEquals(sessionManager.activeMarks.includes("session-1"), true);
  });

  it("routes child assistant buffering and completion through the canonical parent session", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.setParentId("session-1", null);
    sessionManager.setState(
      "session-1",
      sessionManager.createDefaultState("group-1", "user-1"),
    );
    sessionManager.setParentId("child-session", "session-1");
    const { handler, redisEvents } = createHandler(sessionManager);

    await handler({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            sessionID: "child-session",
            messageID: "m1",
            text: "Implemented the child-session fix",
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
            sessionID: "child-session",
            role: "assistant",
            time: { created: 1, completed: 2 },
          },
        },
      } as never,
    });

    assertEquals(redisEvents.calls.length, 1);
    assertEquals(redisEvents.calls[0].sessionId, "session-1");
  });

  it("records assistant output when completion arrives before the buffered text part", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.setState(
      "session-1",
      sessionManager.createDefaultState("group-1", "user-1"),
    );
    const { handler, redisEvents } = createHandler(sessionManager);

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

    await handler({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            sessionID: "session-1",
            messageID: "m1",
            text: "Discovered the delayed session fix",
          },
        },
      } as never,
    });

    assertEquals(redisEvents.calls.length, 2);
    assertEquals(
      redisEvents.calls.every((call) => call.sessionId === "session-1"),
      true,
    );
  });

  it("skips the catch-all only for events without a resolvable canonical session", async () => {
    const sessionManager = new MockSessionManager();
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
    assertEquals(redisEvents.calls.length, 0);
  });
});
