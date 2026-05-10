import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { setSuppressConsoleWarningsDuringTestsOverride } from "../services/opencode-warning.ts";
import { createCompactingHandler } from "./compacting.ts";

class MockSessionManager {
  canonicalSessionId = "session-1";
  state = {
    isMain: true,
    hotTierReady: true,
    pendingInjection: undefined as unknown,
  };
  prepareInjectionCalls: Array<{
    sessionId: string;
    lastRequest?: string;
    options?: { forCompaction?: boolean };
  }> = [];
  clearPendingInjectionCalls = 0;
  activeCalls: Array<{ sessionId: string; canonicalSessionId?: string }> = [];

  resolveSessionState() {
    return {
      state: this.state,
      resolved: true,
      canonicalSessionId: this.canonicalSessionId,
    };
  }

  prepareInjection(
    sessionId: string,
    lastRequest?: string,
    options?: { forCompaction?: boolean },
  ) {
    this.prepareInjectionCalls.push({ sessionId, lastRequest, options });
    const prepared = {
      envelope:
        '<memory version="2"><session_snapshot><snapshot /></session_snapshot><persistent_memory></persistent_memory></memory>',
      nodeRefs: [],
      refreshDecision: {
        classification: "aligned",
        shouldRefresh: false,
        similarity: 1,
        threshold: 0.5,
        cachedQuery: "continue",
      },
    };
    this.state.pendingInjection = prepared;
    return prepared;
  }

  markResolvedSessionActive(sessionId: string, canonicalSessionId?: string) {
    this.activeCalls.push({ sessionId, canonicalSessionId });
  }

  clearPendingInjection() {
    this.clearPendingInjectionCalls += 1;
    this.state.pendingInjection = undefined;
  }
}

describe("compacting handler", () => {
  setSuppressConsoleWarningsDuringTestsOverride(true);

  it("injects locally prepared memory without Graphiti reads", async () => {
    const sessionManager = new MockSessionManager();
    const handler = createCompactingHandler({
      sessionManager: sessionManager as never,
    });

    const output = { context: ["existing"] };
    await handler({ sessionID: "session-1" }, output as never);

    assertEquals(output.context.length, 2);
    assertStringIncludes(output.context[1], '<memory version="2">');
    assertEquals(output.context[1].includes("<session_memory"), false);
    assertEquals(output.context[1].includes("<entry"), false);
    assertEquals(sessionManager.prepareInjectionCalls, [{
      sessionId: "session-1",
      lastRequest: undefined,
      options: { forCompaction: true },
    }]);
    assertEquals(sessionManager.clearPendingInjectionCalls, 1);
    assertEquals(sessionManager.state.pendingInjection, undefined);
    assertEquals(sessionManager.activeCalls, [{
      sessionId: "session-1",
      canonicalSessionId: "session-1",
    }]);
  });

  it("preserves normalized memory shape during compaction with cached persistent memory optional", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.prepareInjection = ((
      sessionId: string,
      lastRequest?: string,
      options?: { forCompaction?: boolean },
    ) => {
      sessionManager.prepareInjectionCalls.push({
        sessionId,
        lastRequest,
        options,
      });
      const prepared = {
        envelope:
          '<memory version="2"><last_request>continue</last_request><session_snapshot><snapshot /></session_snapshot><persistent_memory node_refs="node-1"><node>cached recall</node></persistent_memory></memory>',
        nodeRefs: ["node-1"],
        refreshDecision: {
          classification: "aligned",
          shouldRefresh: false,
          similarity: 1,
          threshold: 0.5,
          cachedQuery: "continue",
        },
      };
      sessionManager.state.pendingInjection = prepared;
      return prepared;
    }) as typeof sessionManager.prepareInjection;
    const handler = createCompactingHandler({
      sessionManager: sessionManager as never,
    });

    const output = { context: [] as string[] };
    await handler({ sessionID: "session-1" }, output as never);

    assertEquals(output.context.length, 1);
    assertStringIncludes(output.context[0], '<memory version="2">');
    assertStringIncludes(output.context[0], "<session_snapshot>");
    assertStringIncludes(output.context[0], "<persistent_memory");
    assertStringIncludes(output.context[0], "cached recall");
    assertEquals(output.context[0].includes("<session_memory"), false);
  });

  it("routes child-session compaction through the canonical parent session", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.canonicalSessionId = "parent-session";
    const handler = createCompactingHandler({
      sessionManager: sessionManager as never,
    });

    const output = { context: ["existing"] };
    await handler({ sessionID: "child-session" }, output as never);

    assertEquals(output.context.length, 2);
    assertStringIncludes(output.context[1], '<memory version="2">');
    assertEquals(sessionManager.prepareInjectionCalls, [{
      sessionId: "parent-session",
      lastRequest: undefined,
      options: { forCompaction: true },
    }]);
    assertEquals(sessionManager.activeCalls, [{
      sessionId: "child-session",
      canonicalSessionId: "parent-session",
    }]);
  });

  it("swallows prepareInjection failures so compaction can continue", async () => {
    const handler = createCompactingHandler({
      sessionManager: {
        resolveSessionState() {
          return {
            state: { isMain: true, hotTierReady: false },
            resolved: true,
            canonicalSessionId: "session-1",
          };
        },
        prepareInjection() {
          throw new Error("redis unavailable");
        },
      } as never,
    });

    const output = { context: ["existing"] };
    await handler({ sessionID: "session-1" }, output as never);

    assertEquals(output.context, ["existing"]);
  });

  it("skips compaction injection when the canonical session cannot be resolved", async () => {
    const handler = createCompactingHandler({
      sessionManager: {
        resolveSessionState() {
          return {
            state: null,
            resolved: false,
            canonicalSessionId: undefined,
          };
        },
      } as never,
    });

    const output = { context: ["existing"] };
    await handler({ sessionID: "unknown-session" }, output as never);

    assertEquals(output.context, ["existing"]);
  });
});
