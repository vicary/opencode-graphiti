import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { spy } from "jsr:@std/testing@^1.0.0/mock";
import { logger } from "../services/logger.ts";
import { createMessagesHandler } from "./messages.ts";

class MockSessionManager {
  canonicalSessionId = "session-1";
  state = {
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
  };
  prepareInjectionImpl?: (sessionId: string, lastRequest?: string) => unknown;
  activeCalls: Array<{ sessionId: string; canonicalSessionId?: string }> = [];
  clearPendingInjection(state: typeof this.state, prepared?: unknown) {
    if (state.pendingInjection === prepared) {
      state.pendingInjection = undefined;
    }
  }

  resolveSessionState() {
    return {
      state: this.state,
      resolved: true,
      canonicalSessionId: this.canonicalSessionId,
    };
  }

  prepareInjection(sessionId: string, lastRequest?: string) {
    if (this.prepareInjectionImpl) {
      return this.prepareInjectionImpl(sessionId, lastRequest);
    }
    return this.state.pendingInjection;
  }

  markResolvedSessionActive(sessionId: string, canonicalSessionId?: string) {
    this.activeCalls.push({ sessionId, canonicalSessionId });
  }
}

describe("messages handler", () => {
  it("injects pending session memory into the latest user message", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<session_memory version="1"><last_request>fresh</last_request></session_memory>',
      nodeRefs: [],
      refreshDecision: {
        classification: "aligned",
        shouldRefresh: false,
        similarity: 1,
        threshold: 0.5,
        cachedQuery: "fresh",
      },
    };
    const handler = createMessagesHandler({
      sessionManager: sessionManager as never,
    });

    const output = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{ type: "text", text: "Continue work" }],
      }],
    };
    await handler({}, output as never);

    assertStringIncludes(output.messages[0].parts[0].text, "<session_memory");
    assertEquals(sessionManager.state.pendingInjection, undefined);
    assertEquals(sessionManager.activeCalls, [{
      sessionId: "session-1",
      canonicalSessionId: "session-1",
    }]);
  });

  it("prepares injection on transform when chat hook has not populated it yet", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = undefined;
    sessionManager.prepareInjectionImpl = (
      sessionId: string,
      lastRequest?: string,
    ) => {
      assertEquals(sessionId, "session-1");
      assertEquals(lastRequest, "fallback request");
      return {
        envelope:
          '<session_memory version="1"><last_request>fallback request</last_request></session_memory>',
        nodeRefs: [],
        refreshDecision: {
          classification: "miss",
          shouldRefresh: true,
          similarity: 0,
          threshold: 0.5,
          cachedQuery: null,
        },
      };
    };
    const handler = createMessagesHandler({
      sessionManager: sessionManager as never,
    });

    const output = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{ type: "text", text: "fallback request" }],
      }],
    };
    await handler({ message: "fallback request" } as never, output as never);

    assertStringIncludes(output.messages[0].parts[0].text, "<session_memory");
  });

  it("falls back to latest user text when transform fallback message is non-string", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = undefined;
    sessionManager.prepareInjectionImpl = (
      sessionId: string,
      lastRequest?: string,
    ) => {
      assertEquals(sessionId, "session-1");
      assertEquals(lastRequest, "fallback request");
      return {
        envelope: '<session_memory version="1"></session_memory>',
        nodeRefs: [],
        refreshDecision: {
          classification: "miss",
          shouldRefresh: true,
          similarity: 0,
          threshold: 0.5,
          cachedQuery: null,
        },
      };
    };
    const handler = createMessagesHandler({
      sessionManager: sessionManager as never,
    });

    const output = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{ type: "text", text: "fallback request" }],
      }],
    };
    await handler(
      { message: { text: "fallback request" } } as never,
      output as never,
    );

    assertStringIncludes(output.messages[0].parts[0].text, "<session_memory");
  });

  it("falls back to the latest user text as the recall query", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = undefined;
    sessionManager.prepareInjectionImpl = (
      sessionId: string,
      lastRequest?: string,
    ) => {
      assertEquals(sessionId, "session-1");
      assertEquals(lastRequest, "message body query");
      return {
        envelope:
          '<session_memory version="1"><last_request>message body query</last_request></session_memory>',
        nodeRefs: [],
        refreshDecision: {
          classification: "miss",
          shouldRefresh: true,
          similarity: 0,
          threshold: 0.5,
          cachedQuery: null,
        },
      };
    };
    const handler = createMessagesHandler({
      sessionManager: sessionManager as never,
    });

    const output = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{ type: "text", text: "message body query" }],
      }],
    };
    await handler({} as never, output as never);

    assertStringIncludes(output.messages[0].parts[0].text, "<session_memory");
  });

  it("does not mutate assistant history text while reinjecting the latest user prompt", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope: '<session_memory version="1"></session_memory>',
      nodeRefs: [],
      refreshDecision: {
        classification: "aligned",
        shouldRefresh: false,
        similarity: 1,
        threshold: 0.5,
        cachedQuery: "next",
      },
    };
    const handler = createMessagesHandler({
      sessionManager: sessionManager as never,
    });

    const output = {
      messages: [
        {
          info: { role: "assistant", sessionID: "session-1" },
          parts: [{
            type: "text",
            text:
              '<persistent_memory fact_uuids="fact-1,fact-2"></persistent_memory>',
          }],
        },
        {
          info: { role: "user", sessionID: "session-1" },
          parts: [{ type: "text", text: "next" }],
        },
      ],
    };
    await handler({}, output as never);

    assertStringIncludes(output.messages[1].parts[0].text, "<session_memory");
    assertEquals(
      output.messages[0].parts[0].text,
      '<persistent_memory fact_uuids="fact-1,fact-2"></persistent_memory>',
    );
  });

  it("rewrites legacy memory at the latest user prompt into a single canonical injection", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<session_memory version="1"><last_request>next</last_request></session_memory>',
      nodeRefs: [],
      refreshDecision: {
        classification: "aligned",
        shouldRefresh: false,
        similarity: 1,
        threshold: 0.5,
        cachedQuery: "next",
      },
    };
    const handler = createMessagesHandler({
      sessionManager: sessionManager as never,
    });

    const output = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{
          type: "text",
          text: '<memory data-uuids="fact-legacy-1"></memory>\n\nnext',
        }],
      }],
    };

    await handler({}, output as never);

    assertStringIncludes(output.messages[0].parts[0].text, "<session_memory");
    assertEquals(
      output.messages[0].parts[0].text.includes(
        '<memory data-uuids="fact-legacy-1"></memory>',
      ),
      false,
    );
    assertStringIncludes(output.messages[0].parts[0].text, "next");
  });

  it("rewrites leading legacy memory blocks with empty or missing data-uuids", async () => {
    const cases = [
      '<memory data-uuids=""></memory>\n\nnext',
      "<memory></memory>\n\nnext",
    ];

    for (const text of cases) {
      const sessionManager = new MockSessionManager();
      sessionManager.state.pendingInjection = {
        envelope:
          '<session_memory version="1"><last_request>next</last_request></session_memory>',
        nodeRefs: [],
        refreshDecision: {
          classification: "aligned",
          shouldRefresh: false,
          similarity: 1,
          threshold: 0.5,
          cachedQuery: "next",
        },
      };
      const handler = createMessagesHandler({
        sessionManager: sessionManager as never,
      });
      const output = {
        messages: [{
          info: { role: "user", sessionID: "session-1" },
          parts: [{ type: "text", text }],
        }],
      };

      await handler({}, output as never);

      assertStringIncludes(output.messages[0].parts[0].text, "<session_memory");
      assertEquals(output.messages[0].parts[0].text.includes("<memory"), false);
      assertStringIncludes(output.messages[0].parts[0].text, "next");
    }
  });

  it("preserves user-authored persistent memory blocks away from the reinjection prefix", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<session_memory version="1"><last_request>next</last_request></session_memory>',
      nodeRefs: [],
      refreshDecision: {
        classification: "aligned",
        shouldRefresh: false,
        similarity: 1,
        threshold: 0.5,
        cachedQuery: "next",
      },
    };
    const handler = createMessagesHandler({
      sessionManager: sessionManager as never,
    });

    const output = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{
          type: "text",
          text:
            'next\n\n<persistent_memory fact_uuids="fact-standalone-1,fact-standalone-2">stale memory</persistent_memory>',
        }],
      }],
    };

    await handler({}, output as never);

    assertStringIncludes(output.messages[0].parts[0].text, "<session_memory");
    assertStringIncludes(
      output.messages[0].parts[0].text,
      '<persistent_memory fact_uuids="fact-standalone-1,fact-standalone-2">stale memory</persistent_memory>',
    );
  });

  it("preserves literal user-authored session memory XML in the latest user message", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<session_memory version="1"><last_request>inspect example</last_request></session_memory>',
      nodeRefs: [],
      refreshDecision: {
        classification: "aligned",
        shouldRefresh: false,
        similarity: 1,
        threshold: 0.5,
        cachedQuery: "inspect example",
      },
    };
    const handler = createMessagesHandler({
      sessionManager: sessionManager as never,
    });

    const output = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{
          type: "text",
          text:
            'Please inspect this example:\n\n<session_memory version="1"><last_request>example</last_request></session_memory>',
        }],
      }],
    };

    await handler({} as never, output as never);

    assertStringIncludes(output.messages[0].parts[0].text, "<session_memory");
    assertStringIncludes(
      output.messages[0].parts[0].text,
      '<session_memory version="1"><last_request>example</last_request></session_memory>',
    );
  });

  it("preserves leading user-authored session_memory blocks that do not match the injected shape", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<session_memory source="graphiti" version="1"><last_request>inspect example</last_request></session_memory>',
      nodeRefs: [],
      refreshDecision: {
        classification: "aligned",
        shouldRefresh: false,
        similarity: 1,
        threshold: 0.5,
        cachedQuery: "inspect example",
      },
    };
    const handler = createMessagesHandler({
      sessionManager: sessionManager as never,
    });

    const userAuthoredBlock =
      '<session_memory version="1"><last_request>user-authored example</last_request></session_memory>';
    const output = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{
          type: "text",
          text: `${userAuthoredBlock}\n\ninspect example`,
        }],
      }],
    };

    await handler({} as never, output as never);

    assertStringIncludes(output.messages[0].parts[0].text, userAuthoredBlock);
  });

  it("preserves leading user-authored legacy and persistent memory blocks", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<session_memory source="graphiti" version="1"><last_request>inspect example</last_request></session_memory>',
      nodeRefs: [],
      refreshDecision: {
        classification: "aligned",
        shouldRefresh: false,
        similarity: 1,
        threshold: 0.5,
        cachedQuery: "inspect example",
      },
    };
    const handler = createMessagesHandler({
      sessionManager: sessionManager as never,
    });

    const cases = [
      "<memory>user-authored example</memory>",
      "<persistent_memory>user-authored example</persistent_memory>",
    ];

    for (const userAuthoredBlock of cases) {
      const output = {
        messages: [{
          info: { role: "user", sessionID: "session-1" },
          parts: [{
            type: "text",
            text: `${userAuthoredBlock}\n\ninspect example`,
          }],
        }],
      };

      await handler({} as never, output as never);

      assertStringIncludes(output.messages[0].parts[0].text, userAuthoredBlock);
    }
  });

  it("preserves leading user-authored non-empty legacy memory blocks without data-uuids", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<session_memory source="graphiti" version="1"><last_request>inspect example</last_request></session_memory>',
      nodeRefs: [],
      refreshDecision: {
        classification: "aligned",
        shouldRefresh: false,
        similarity: 1,
        threshold: 0.5,
        cachedQuery: "inspect example",
      },
    };
    const handler = createMessagesHandler({
      sessionManager: sessionManager as never,
    });

    const userAuthoredBlock = "<memory>user-authored example</memory>";
    const output = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{
          type: "text",
          text: `${userAuthoredBlock}\n\ninspect example`,
        }],
      }],
    };

    await handler({} as never, output as never);

    assertStringIncludes(output.messages[0].parts[0].text, userAuthoredBlock);
  });

  it("reports rewroteExistingMemory when canonical or legacy blocks were scrubbed", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<session_memory version="1"><last_request>next</last_request></session_memory>',
      nodeRefs: [],
      refreshDecision: {
        classification: "aligned",
        shouldRefresh: false,
        similarity: 1,
        threshold: 0.5,
        cachedQuery: "next",
      },
    };
    const infoSpy = spy(logger, "info");
    try {
      const handler = createMessagesHandler({
        sessionManager: sessionManager as never,
      });

      const output = {
        messages: [{
          info: { role: "user", sessionID: "session-1" },
          parts: [{
            type: "text",
            text: '<memory data-uuids="fact-legacy-1"></memory>\n\nnext',
          }],
        }],
      };

      await handler({}, output as never);

      const call = infoSpy.calls.find((entry) =>
        entry.args[0] === "Injected canonical session_memory block"
      );
      assertEquals(Boolean(call), true);
      assertEquals(
        (call?.args[1] as { rewroteExistingMemory: boolean })
          .rewroteExistingMemory,
        true,
      );
    } finally {
      infoSpy.restore();
    }
  });

  it("does not scrub canonical and legacy memory blocks from earlier prompt history", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<session_memory version="1"><last_request>continue</last_request></session_memory>',
      nodeRefs: [],
      refreshDecision: {
        classification: "aligned",
        shouldRefresh: false,
        similarity: 1,
        threshold: 0.5,
        cachedQuery: "continue",
      },
    };
    const handler = createMessagesHandler({
      sessionManager: sessionManager as never,
    });

    const output = {
      messages: [
        {
          info: { role: "assistant", sessionID: "session-1" },
          parts: [{
            type: "text",
            text:
              'before canonical <session_memory version="1"><facts><fact uuid="fact-1">alpha</fact></facts></session_memory> after canonical',
          }],
        },
        {
          info: { role: "user", sessionID: "session-1" },
          parts: [{
            type: "text",
            text:
              'before legacy <memory data-uuids="fact-2,fact-3">old memory</memory> after legacy',
          }],
        },
        {
          info: { role: "user", sessionID: "session-1" },
          parts: [{ type: "text", text: "continue" }],
        },
      ],
    };

    await handler({} as never, output as never);

    assertEquals(
      output.messages[0].parts[0].text,
      'before canonical <session_memory version="1"><facts><fact uuid="fact-1">alpha</fact></facts></session_memory> after canonical',
    );
    assertEquals(
      output.messages[1].parts[0].text,
      'before legacy <memory data-uuids="fact-2,fact-3">old memory</memory> after legacy',
    );
    assertStringIncludes(output.messages[2].parts[0].text, "<session_memory");
    assertEquals(
      output.messages[2].parts[0].text.match(/<session_memory/g)?.length,
      1,
    );
  });

  it("does not scrub standalone persistent memory blocks from earlier prompt history", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<session_memory version="1"><last_request>continue</last_request></session_memory>',
      nodeRefs: [],
      refreshDecision: {
        classification: "aligned",
        shouldRefresh: false,
        similarity: 1,
        threshold: 0.5,
        cachedQuery: "continue",
      },
    };
    const handler = createMessagesHandler({
      sessionManager: sessionManager as never,
    });

    const output = {
      messages: [
        {
          info: { role: "assistant", sessionID: "session-1" },
          parts: [{
            type: "text",
            text:
              'before standalone <persistent_memory fact_uuids="fact-4,fact-5">stale memory</persistent_memory> after standalone',
          }],
        },
        {
          info: { role: "user", sessionID: "session-1" },
          parts: [{ type: "text", text: "continue" }],
        },
      ],
    };

    await handler({} as never, output as never);

    assertEquals(
      output.messages[0].parts[0].text,
      'before standalone <persistent_memory fact_uuids="fact-4,fact-5">stale memory</persistent_memory> after standalone',
    );
    assertStringIncludes(output.messages[1].parts[0].text, "<session_memory");
    assertEquals(
      output.messages[1].parts[0].text.match(/<session_memory/g)?.length,
      1,
    );
  });

  it("does not clear a newer pending injection after awaiting prepareInjection", async () => {
    const newerPrepared = {
      envelope:
        '<session_memory version="1"><last_request>newer</last_request></session_memory>',
      nodeRefs: [],
      refreshDecision: {
        classification: "aligned",
        shouldRefresh: false,
        similarity: 1,
        threshold: 0.5,
        cachedQuery: "newer",
      },
    };
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = undefined;
    sessionManager.prepareInjectionImpl = () => {
      sessionManager.state.pendingInjection = newerPrepared;
      return {
        envelope:
          '<session_memory version="1"><last_request>older</last_request></session_memory>',
        nodeRefs: [],
        refreshDecision: {
          classification: "miss",
          shouldRefresh: true,
          similarity: 0,
          threshold: 0.5,
          cachedQuery: null,
        },
      };
    };
    const handler = createMessagesHandler({
      sessionManager: sessionManager as never,
    });

    const output = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{ type: "text", text: "current request" }],
      }],
    };
    await handler({ message: "current request" } as never, output as never);

    assertEquals(sessionManager.state.pendingInjection, newerPrepared);
    assertStringIncludes(output.messages[0].parts[0].text, "older");
  });

  it("preserves existing memory blocks when prepareInjection returns null", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = undefined;
    sessionManager.prepareInjectionImpl = () => null;
    const handler = createMessagesHandler({
      sessionManager: sessionManager as never,
    });

    const assistantText =
      'before canonical <session_memory version="1"><facts><fact uuid="fact-1">alpha</fact></facts></session_memory> after canonical';
    const userText = '<memory data-uuids="fact-legacy-1"></memory>\n\ncontinue';
    const output = {
      messages: [
        {
          info: { role: "assistant", sessionID: "session-1" },
          parts: [{ type: "text", text: assistantText }],
        },
        {
          info: { role: "user", sessionID: "session-1" },
          parts: [{ type: "text", text: userText }],
        },
      ],
    };

    await handler({ message: "continue" } as never, output as never);

    assertEquals(output.messages[0].parts[0].text, assistantText);
    assertEquals(output.messages[1].parts[0].text, userText);
  });

  it("preserves whitespace-sensitive history text outside the reinjection target", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<session_memory version="1"><last_request>continue</last_request></session_memory>',
      nodeRefs: [],
      refreshDecision: {
        classification: "aligned",
        shouldRefresh: false,
        similarity: 1,
        threshold: 0.5,
        cachedQuery: "continue",
      },
    };
    const handler = createMessagesHandler({
      sessionManager: sessionManager as never,
    });

    const assistantText =
      'assistant    spacing\n\n<session_memory version="1"><facts><fact uuid="fact-1">alpha</fact></facts></session_memory>\n\n  keep-indentation';
    const output = {
      messages: [
        {
          info: { role: "assistant", sessionID: "session-1" },
          parts: [{ type: "text", text: assistantText }],
        },
        {
          info: { role: "user", sessionID: "session-1" },
          parts: [{ type: "text", text: "continue" }],
        },
      ],
    };

    await handler({} as never, output as never);

    assertEquals(output.messages[0].parts[0].text, assistantText);
    assertStringIncludes(output.messages[1].parts[0].text, "<session_memory");
  });

  it("scrubs only the leading injected block from the latest user prompt", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<session_memory version="1"><last_request>continue</last_request></session_memory>',
      nodeRefs: [],
      refreshDecision: {
        classification: "aligned",
        shouldRefresh: false,
        similarity: 1,
        threshold: 0.5,
        cachedQuery: "continue",
      },
    };
    const handler = createMessagesHandler({
      sessionManager: sessionManager as never,
    });

    const trailingExample =
      'keep transcript\n\n<session_memory version="1"><last_request>example</last_request></session_memory>';
    const output = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{
          type: "text",
          text:
            `<session_memory source="graphiti" version="1"><last_request>stale</last_request></session_memory>\n\n${trailingExample}`,
        }],
      }],
    };

    await handler({} as never, output as never);

    assertEquals(
      output.messages[0].parts[0].text,
      `<session_memory version="1"><last_request>continue</last_request></session_memory>\n\n${trailingExample}`,
    );
  });

  it("remains compatible with extended prepareInjection results", async () => {
    const prepared = {
      envelope: '<session_memory version="1"></session_memory>',
      nodeRefs: ["node-1"],
      refreshDecision: {
        classification: "drifted",
        shouldRefresh: true,
        similarity: 0.25,
        threshold: 0.5,
        cachedQuery: "prior topic",
      },
    };
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = prepared;
    const handler = createMessagesHandler({
      sessionManager: sessionManager as never,
    });

    const output = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{ type: "text", text: "compatibility check" }],
      }],
    };
    await handler({}, output as never);

    assertStringIncludes(output.messages[0].parts[0].text, "<session_memory");
    assertEquals(sessionManager.state.pendingInjection, undefined);
  });

  it("routes child-session prompts through the canonical parent session", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.canonicalSessionId = "parent-session";
    sessionManager.prepareInjectionImpl = (
      sessionId: string,
      lastRequest?: string,
    ) => {
      assertEquals(sessionId, "parent-session");
      assertEquals(lastRequest, "follow up from child");
      return {
        envelope:
          '<session_memory version="1"><last_request>follow up from child</last_request></session_memory>',
        nodeRefs: [],
        refreshDecision: {
          classification: "miss",
          shouldRefresh: true,
          similarity: 0,
          threshold: 0.5,
          cachedQuery: null,
        },
      };
    };
    const handler = createMessagesHandler({
      sessionManager: sessionManager as never,
    });

    const output = {
      messages: [{
        info: { role: "user", sessionID: "child-session" },
        parts: [{ type: "text", text: "follow up from child" }],
      }],
    };

    await handler({}, output as never);

    assertStringIncludes(output.messages[0].parts[0].text, "<session_memory");
    assertStringIncludes(
      output.messages[0].parts[0].text,
      "follow up from child",
    );
    assertEquals(sessionManager.activeCalls, [{
      sessionId: "child-session",
      canonicalSessionId: "parent-session",
    }]);
  });

  it("swallows missing-session resolution failures so startup does not throw", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.resolveSessionState = () => {
      throw new Error("Session not found");
    };
    const handler = createMessagesHandler({
      sessionManager: sessionManager as never,
    });

    const output = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{ type: "text", text: "startup prompt" }],
      }],
    };

    await handler({} as never, output as never);

    assertEquals(output.messages[0].parts[0].text, "startup prompt");
  });

  it("skips transform work when the latest user entry has no text part", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.prepareInjectionImpl = () => {
      throw new Error("prepareInjection should not run");
    };
    const handler = createMessagesHandler({
      sessionManager: sessionManager as never,
    });

    const output = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{ type: "file", path: "src/index.ts" }],
      }],
    };

    await handler({ message: "should be ignored" } as never, output as never);

    assertEquals(sessionManager.activeCalls, []);
    assertEquals(sessionManager.state.pendingInjection, undefined);
  });
});
