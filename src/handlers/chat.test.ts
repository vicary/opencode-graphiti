import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { createChatHandler } from "./chat.ts";

class MockSessionManager {
  prepareInjectionResult:
    | {
      envelope: string;
      factUuids: string[];
      nodeRefs: string[];
      refreshDecision: {
        classification: string;
        shouldRefresh: boolean;
        similarity: number;
        threshold: number;
        cachedQuery: string | null;
      };
    }
    | null
    | undefined = undefined;
  nextRefreshDecision: {
    classification: string;
    shouldRefresh: boolean;
    similarity: number;
    threshold: number;
    cachedQuery: string | null;
  } = {
    classification: "miss",
    shouldRefresh: true,
    similarity: 0,
    threshold: 0.5,
    cachedQuery: null,
  };
  prepareInjectionCalls: Array<{ sessionId: string; lastRequest?: string }> =
    [];
  state = {
    groupId: "group-1",
    userGroupId: "user-1",
    injectedMemories: false,
    lastInjectionFactUuids: [],
    visibleFactUuids: [],
    messageCount: 0,
    pendingMessages: [] as string[],
    contextLimit: 200_000,
    isMain: true,
    hotTierReady: false,
    pendingInjection: undefined as {
      envelope: string;
      factUuids: string[];
      nodeRefs: string[];
      refreshDecision: {
        classification: string;
        shouldRefresh: boolean;
        similarity: number;
        threshold: number;
        cachedQuery: string | null;
      };
    } | undefined,
    pendingInjectionGeneration: 0,
    latestUserRequest: undefined as string | undefined,
  };
  markSessionActive(_sessionId: string): void {
    // no-op for tests: activity tracking is not under test here
  }

  resolveSessionState() {
    return { state: this.state, resolved: true };
  }

  prepareInjection(_sessionId: string, lastRequest?: string) {
    this.prepareInjectionCalls.push({
      sessionId: _sessionId,
      lastRequest,
    });
    const prepared = this.prepareInjectionResult === undefined
      ? {
        envelope:
          `<session_memory version="1"><last_request>${lastRequest}</last_request></session_memory>`,
        factUuids: [],
        nodeRefs: [],
        refreshDecision: this.nextRefreshDecision,
      }
      : this.prepareInjectionResult;
    this.state.pendingInjection = prepared ?? undefined;
    this.state.hotTierReady = true;
    return prepared ?? null;
  }
}

class MockRedisEvents {
  calls: Array<{ sessionId: string; groupId: string; summary: string }> = [];

  recordEvent(
    sessionId: string,
    groupId: string,
    event: { summary: string },
  ) {
    this.calls.push({ sessionId, groupId, summary: event.summary });
    return this.calls.length;
  }
}

class MockGraphitiAsync {
  refreshCalls: Array<{ groupId: string; query: string }> = [];
  drainCalls: string[] = [];

  scheduleCacheRefresh(groupId: string, query: string) {
    this.refreshCalls.push({ groupId, query });
  }

  scheduleDrain(groupId: string) {
    this.drainCalls.push(groupId);
  }
}

describe("chat handler", () => {
  it("records a user event, prepares session_memory, and schedules async refresh on cache miss", async () => {
    const sessionManager = new MockSessionManager();
    const redisEvents = new MockRedisEvents();
    const graphitiAsync = new MockGraphitiAsync();

    const handler = createChatHandler({
      sessionManager: sessionManager as never,
      redisEvents: redisEvents as never,
      graphitiAsync: graphitiAsync as never,
      drainTriggerSize: 2,
    });

    await handler(
      { sessionID: "session-1" },
      { parts: [{ type: "text", text: "Continue the migration" }] } as never,
    );

    assertEquals(redisEvents.calls.length >= 1, true);
    assertEquals(redisEvents.calls[0].sessionId, "session-1");
    assertEquals(sessionManager.state.messageCount, 1);
    assertEquals(sessionManager.state.injectedMemories, true);
    assertEquals(sessionManager.state.pendingMessages, [
      "User: Continue the migration",
    ]);
    assertStringIncludes(
      sessionManager.state.pendingInjection?.envelope ?? "",
      "<session_memory",
    );
    assertEquals(graphitiAsync.refreshCalls, [{
      groupId: "group-1",
      query: "Continue the migration",
    }]);
    assertEquals(sessionManager.prepareInjectionCalls, [{
      sessionId: "session-1",
      lastRequest: "Continue the migration",
    }]);
    assertEquals(graphitiAsync.drainCalls, []);
  });

  it("records multiple structured user events when the request includes preferences and decisions", async () => {
    const sessionManager = new MockSessionManager();
    const redisEvents = new MockRedisEvents();
    const graphitiAsync = new MockGraphitiAsync();

    const handler = createChatHandler({
      sessionManager: sessionManager as never,
      redisEvents: redisEvents as never,
      graphitiAsync: graphitiAsync as never,
      drainTriggerSize: 99,
    });

    await handler(
      { sessionID: "session-1" },
      {
        parts: [{
          type: "text",
          text: "Please keep Graphiti off the hot path",
        }],
      } as never,
    );

    assertEquals(redisEvents.calls.length, 3);
  });

  it("schedules a drain when the pending queue reaches the trigger threshold", async () => {
    const sessionManager = new MockSessionManager();
    const _redisEvents = new MockRedisEvents();
    const graphitiAsync = new MockGraphitiAsync();

    const handler = createChatHandler({
      sessionManager: sessionManager as never,
      redisEvents: {
        recordEvent() {
          return 3;
        },
      } as never,
      graphitiAsync: graphitiAsync as never,
      drainTriggerSize: 2,
    });

    await handler(
      { sessionID: "session-1" },
      { parts: [{ type: "text", text: "Queue enough work" }] } as never,
    );

    assertEquals(graphitiAsync.drainCalls, ["group-1"]);
  });

  it("skips async refresh when cache is fresh and aligned", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.nextRefreshDecision = {
      classification: "aligned",
      shouldRefresh: false,
      similarity: 0.5,
      threshold: 0.5,
      cachedQuery: "continue migration",
    };
    const redisEvents = new MockRedisEvents();
    const graphitiAsync = new MockGraphitiAsync();

    const handler = createChatHandler({
      sessionManager: sessionManager as never,
      redisEvents: redisEvents as never,
      graphitiAsync: graphitiAsync as never,
      drainTriggerSize: 99,
    });

    await handler(
      { sessionID: "session-1" },
      { parts: [{ type: "text", text: "Continue migration" }] } as never,
    );

    assertEquals(graphitiAsync.refreshCalls, []);
  });

  it("does not schedule async refresh when prepareInjection returns null during a race", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.prepareInjectionResult = null;
    const redisEvents = new MockRedisEvents();
    const graphitiAsync = new MockGraphitiAsync();

    const handler = createChatHandler({
      sessionManager: sessionManager as never,
      redisEvents: redisEvents as never,
      graphitiAsync: graphitiAsync as never,
      drainTriggerSize: 99,
    });

    await handler(
      { sessionID: "session-1" },
      { parts: [{ type: "text", text: "Race the refresh" }] } as never,
    );

    assertEquals(sessionManager.prepareInjectionCalls, [{
      sessionId: "session-1",
      lastRequest: "Race the refresh",
    }]);
    assertEquals(sessionManager.state.injectedMemories, false);
    assertEquals(sessionManager.state.pendingInjection, undefined);
    assertEquals(graphitiAsync.refreshCalls, []);
  });

  it("refreshes stale cache, primer-only cache, and drifted cache", async () => {
    for (
      const decision of [
        {
          classification: "stale",
          shouldRefresh: true,
          similarity: 0,
          threshold: 0.5,
          cachedQuery: "older query",
        },
        {
          classification: "primer-only",
          shouldRefresh: true,
          similarity: 0,
          threshold: 0.5,
          cachedQuery: "primer",
        },
        {
          classification: "drifted",
          shouldRefresh: true,
          similarity: 0.2,
          threshold: 0.5,
          cachedQuery: "old topic",
        },
      ]
    ) {
      const sessionManager = new MockSessionManager();
      sessionManager.nextRefreshDecision = decision;
      const graphitiAsync = new MockGraphitiAsync();

      const handler = createChatHandler({
        sessionManager: sessionManager as never,
        redisEvents: new MockRedisEvents() as never,
        graphitiAsync: graphitiAsync as never,
        drainTriggerSize: 99,
      });

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Need a refresh" }] } as never,
      );

      assertEquals(graphitiAsync.refreshCalls, [{
        groupId: "group-1",
        query: "Need a refresh",
      }]);
    }
  });
});
