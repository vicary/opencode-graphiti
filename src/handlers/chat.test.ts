import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import type { SessionEvent } from "../types/index.ts";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { setSuppressConsoleWarningsDuringTestsOverride } from "../services/opencode-warning.ts";
import { createChatHandler } from "./chat.ts";

class MockSessionManager {
  canonicalSessionId = "session-1";
  activeCalls: Array<{ sessionId: string; canonicalSessionId?: string }> = [];
  prepareInjectionResult:
    | {
      envelope: string;
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
  prepareInjectionCalls: Array<{
    sessionId: string;
    lastRequest?: string;
    options?: { forCompaction?: boolean };
  }> = [];
  state = {
    groupId: "group-1",
    userGroupId: "user-1",
    injectedMemories: false,
    messageCount: 0,
    contextLimit: 200_000,
    isMain: true,
    hotTierReady: false,
    pendingInjection: undefined as {
      envelope: string;
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

  markResolvedSessionActive(
    sessionId: string,
    canonicalSessionId?: string,
  ): void {
    this.activeCalls.push({ sessionId, canonicalSessionId });
  }

  resolveSessionState() {
    return {
      state: this.state,
      resolved: true,
      canonicalSessionId: this.canonicalSessionId,
    };
  }

  prepareInjection(
    _sessionId: string,
    lastRequest?: string,
    options?: { forCompaction?: boolean },
  ) {
    this.prepareInjectionCalls.push({
      sessionId: _sessionId,
      lastRequest,
      options,
    });
    const prepared = this.prepareInjectionResult === undefined
      ? {
        envelope:
          `<session_memory version="1"><last_request>${lastRequest}</last_request></session_memory>`,
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
  batchCalls: Array<{
    sessionId: string;
    groupId: string;
    summaries: string[];
  }> = [];

  recordEvent(
    sessionId: string,
    groupId: string,
    event: { summary: string },
  ) {
    this.calls.push({ sessionId, groupId, summary: event.summary });
    return this.calls.length;
  }

  recordEvents(
    sessionId: string,
    groupId: string,
    events: SessionEvent[],
  ) {
    this.batchCalls.push({
      sessionId,
      groupId,
      summaries: events.map((event) => event.summary),
    });
    for (const event of events) {
      this.calls.push({ sessionId, groupId, summary: event.summary });
    }
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
  setSuppressConsoleWarningsDuringTestsOverride(true);

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
    assertEquals(
      sessionManager.state.latestUserRequest,
      "Continue the migration",
    );
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
      options: undefined,
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
    assertEquals(redisEvents.batchCalls, [{
      sessionId: "session-1",
      groupId: "group-1",
      summaries: [
        "Please keep Graphiti off the hot path",
        "Please keep Graphiti off the hot path",
        "Please keep Graphiti off the hot path",
      ],
    }]);
  });

  it("uses batched event recording for zero, one, and many extracted chat events", async () => {
    const graphitiAsync = new MockGraphitiAsync();

    const noEventSessionManager = new MockSessionManager();
    const noEventRedisEvents = new MockRedisEvents();
    const noEventHandler = createChatHandler({
      sessionManager: noEventSessionManager as never,
      redisEvents: noEventRedisEvents as never,
      graphitiAsync: graphitiAsync as never,
      drainTriggerSize: 99,
    });

    await noEventHandler(
      { sessionID: "session-1" },
      {
        parts: [{ type: "text", text: "tool: apply_patch\n+line" }],
      } as never,
    );

    assertEquals(noEventRedisEvents.batchCalls, [{
      sessionId: "session-1",
      groupId: "group-1",
      summaries: [],
    }]);
    assertEquals(noEventRedisEvents.calls, []);

    const oneEventSessionManager = new MockSessionManager();
    const oneEventRedisEvents = new MockRedisEvents();
    const oneEventHandler = createChatHandler({
      sessionManager: oneEventSessionManager as never,
      redisEvents: oneEventRedisEvents as never,
      graphitiAsync: graphitiAsync as never,
      drainTriggerSize: 99,
    });

    await oneEventHandler(
      { sessionID: "session-1" },
      { parts: [{ type: "text", text: "Neutral request only" }] } as never,
    );

    assertEquals(oneEventRedisEvents.batchCalls, [{
      sessionId: "session-1",
      groupId: "group-1",
      summaries: ["Neutral request only"],
    }]);

    const manyEventSessionManager = new MockSessionManager();
    const manyEventRedisEvents = new MockRedisEvents();
    const manyEventHandler = createChatHandler({
      sessionManager: manyEventSessionManager as never,
      redisEvents: manyEventRedisEvents as never,
      graphitiAsync: graphitiAsync as never,
      drainTriggerSize: 99,
    });

    await manyEventHandler(
      { sessionID: "session-1" },
      {
        parts: [{
          type: "text",
          text: "Please keep Graphiti off the hot path",
        }],
      } as never,
    );

    assertEquals(manyEventRedisEvents.batchCalls, [{
      sessionId: "session-1",
      groupId: "group-1",
      summaries: [
        "Please keep Graphiti off the hot path",
        "Please keep Graphiti off the hot path",
        "Please keep Graphiti off the hot path",
      ],
    }]);
  });

  it("routes child-session user prompts through the canonical parent session", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.canonicalSessionId = "parent-session";
    const redisEvents = new MockRedisEvents();
    const graphitiAsync = new MockGraphitiAsync();

    const handler = createChatHandler({
      sessionManager: sessionManager as never,
      redisEvents: redisEvents as never,
      graphitiAsync: graphitiAsync as never,
      drainTriggerSize: 99,
    });

    await handler(
      { sessionID: "child-session" },
      { parts: [{ type: "text", text: "Continue the child task" }] } as never,
    );

    assertEquals(redisEvents.calls[0].sessionId, "parent-session");
    assertEquals(sessionManager.activeCalls, [{
      sessionId: "child-session",
      canonicalSessionId: "parent-session",
    }]);
    assertEquals(sessionManager.prepareInjectionCalls, [{
      sessionId: "parent-session",
      lastRequest: "Continue the child task",
      options: undefined,
    }]);
  });

  it("sanitizes injected memory from the user request before recording and refresh", async () => {
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
          text:
            '<session_memory version="1"><last_request>old</last_request></session_memory>\n\nContinue the migration',
        }],
      } as never,
    );

    assertEquals(
      sessionManager.state.latestUserRequest,
      "Continue the migration",
    );
    assertEquals(redisEvents.calls[0].summary, "Continue the migration");
    assertEquals(graphitiAsync.refreshCalls, [{
      groupId: "group-1",
      query: "Continue the migration",
    }]);
  });

  it("schedules a drain when the pending queue reaches the trigger threshold", async () => {
    const sessionManager = new MockSessionManager();
    const _redisEvents = new MockRedisEvents();
    const graphitiAsync = new MockGraphitiAsync();

    const handler = createChatHandler({
      sessionManager: sessionManager as never,
      redisEvents: {
        recordEvents() {
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
      options: undefined,
    }]);
    assertEquals(sessionManager.state.injectedMemories, false);
    assertEquals(sessionManager.state.pendingInjection, undefined);
    assertEquals(graphitiAsync.refreshCalls, []);
  });

  it("prepares local-first session memory even when cached persistent memory is absent", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.prepareInjectionResult = {
      envelope:
        '<session_memory source="graphiti" version="1"><last_request>Continue locally</last_request><session_snapshot><snapshot /></session_snapshot></session_memory>',
      nodeRefs: [],
      refreshDecision: {
        classification: "aligned",
        shouldRefresh: false,
        similarity: 1,
        threshold: 0.5,
        cachedQuery: "Continue locally",
      },
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
      { parts: [{ type: "text", text: "Continue locally" }] } as never,
    );

    assertStringIncludes(
      sessionManager.state.pendingInjection?.envelope ?? "",
      "<session_snapshot>",
    );
    assertEquals(
      sessionManager.state.pendingInjection?.envelope.includes(
        "<persistent_memory",
      ),
      false,
    );
    assertEquals(graphitiAsync.refreshCalls, []);
    assertEquals(graphitiAsync.drainCalls, []);
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

  it("swallows prepareInjection failures so chat hooks degrade gracefully", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.prepareInjection = () => {
      throw new Error("redis unavailable");
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
      { parts: [{ type: "text", text: "Degrade gracefully" }] } as never,
    );

    assertEquals(redisEvents.calls.length >= 1, true);
    assertEquals(sessionManager.state.injectedMemories, false);
    assertEquals(graphitiAsync.refreshCalls, []);
    assertEquals(graphitiAsync.drainCalls, []);
  });

  it("skips session resolution and hot-tier work when no text prompt is present", async () => {
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
      { parts: [{ type: "file", path: "src/index.ts" }] } as never,
    );

    assertEquals(sessionManager.activeCalls, []);
    assertEquals(sessionManager.prepareInjectionCalls, []);
    assertEquals(redisEvents.calls, []);
    assertEquals(graphitiAsync.refreshCalls, []);
    assertEquals(graphitiAsync.drainCalls, []);
  });
});
