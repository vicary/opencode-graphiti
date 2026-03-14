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
  prepareInjectionCalls: string[] = [];
  clearPendingInjectionCalls = 0;
  activeCalls: Array<{ sessionId: string; canonicalSessionId?: string }> = [];

  resolveSessionState() {
    return {
      state: this.state,
      resolved: true,
      canonicalSessionId: this.canonicalSessionId,
    };
  }

  prepareInjection(sessionId: string) {
    this.prepareInjectionCalls.push(sessionId);
    const prepared = {
      envelope:
        '<session_memory version="1"><session_snapshot><snapshot /></session_snapshot></session_memory>',
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

  it("injects locally prepared session_memory without Graphiti reads", async () => {
    const sessionManager = new MockSessionManager();
    const handler = createCompactingHandler({
      sessionManager: sessionManager as never,
    });

    const output = { context: ["existing"] };
    await handler({ sessionID: "session-1" }, output as never);

    assertEquals(output.context.length, 2);
    assertStringIncludes(output.context[1], "<session_memory");
    assertEquals(sessionManager.prepareInjectionCalls, ["session-1"]);
    assertEquals(sessionManager.clearPendingInjectionCalls, 1);
    assertEquals(sessionManager.state.pendingInjection, undefined);
    assertEquals(sessionManager.activeCalls, [{
      sessionId: "session-1",
      canonicalSessionId: "session-1",
    }]);
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
    assertStringIncludes(output.context[1], "<session_memory");
    assertEquals(sessionManager.prepareInjectionCalls, ["parent-session"]);
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
