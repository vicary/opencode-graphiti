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
  prepareInjectionImpl?: (
    sessionId: string,
    lastRequest?: string,
    options?: { forCompaction?: boolean },
  ) => unknown;
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

  prepareInjection(
    sessionId: string,
    lastRequest?: string,
    options?: { forCompaction?: boolean },
  ) {
    if (this.prepareInjectionImpl) {
      return this.prepareInjectionImpl(sessionId, lastRequest, options);
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
        '<memory version="2"><last_request>fresh</last_request><persistent_memory></persistent_memory></memory>',
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

    assertStringIncludes(
      output.messages[0].parts[0].text,
      '<memory version="2">',
    );
    assertEquals(
      output.messages[0].parts[0].text.includes("<session_memory"),
      false,
    );
    assertEquals(sessionManager.state.pendingInjection, undefined);
    assertEquals(sessionManager.activeCalls, [{
      sessionId: "session-1",
      canonicalSessionId: "session-1",
    }]);
  });

  it("expects one top-level memory wrapper with nested persistent_memory", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<memory version="2"><session_snapshot><snapshot><summary scope="session" source="snapshot">Current snapshot</summary></snapshot></session_snapshot><persistent_memory><summary scope="project" source="graphiti">Cached summary</summary></persistent_memory></memory>',
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

    const rendered = output.messages[0].parts[0].text;
    assertStringIncludes(rendered, '<memory version="2">');
    assertStringIncludes(rendered, "<persistent_memory>");
    assertEquals(rendered.includes("<session_memory"), false);
    assertEquals(rendered.includes("<entry"), false);
    assertEquals(rendered.match(/<memory\b/g)?.length, 1);
  });

  it("injects local-first session memory with optional cached persistent memory unchanged", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<memory version="2"><last_request>fresh</last_request><session_snapshot><snapshot /></session_snapshot><persistent_memory node_refs="node-1"><node>cached recall</node></persistent_memory></memory>',
      nodeRefs: ["node-1"],
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

    assertStringIncludes(
      output.messages[0].parts[0].text,
      "<session_snapshot>",
    );
    assertStringIncludes(
      output.messages[0].parts[0].text,
      "<persistent_memory",
    );
    assertStringIncludes(output.messages[0].parts[0].text, "cached recall");
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
          '<memory version="2"><last_request>fallback request</last_request><persistent_memory></persistent_memory></memory>',
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

    assertStringIncludes(
      output.messages[0].parts[0].text,
      '<memory version="2">',
    );
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
        envelope:
          '<memory version="2"><persistent_memory></persistent_memory></memory>',
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

    assertStringIncludes(
      output.messages[0].parts[0].text,
      '<memory version="2">',
    );
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
          '<memory version="2"><last_request>message body query</last_request><persistent_memory></persistent_memory></memory>',
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

    assertStringIncludes(
      output.messages[0].parts[0].text,
      '<memory version="2">',
    );
  });

  it("does not mutate assistant history text while reinjecting the latest user prompt", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<memory version="2"><persistent_memory></persistent_memory></memory>',
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

    assertStringIncludes(
      output.messages[1].parts[0].text,
      '<memory version="2">',
    );
    assertEquals(
      output.messages[0].parts[0].text,
      '<persistent_memory fact_uuids="fact-1,fact-2"></persistent_memory>',
    );
  });

  it("rewrites legacy memory at the latest user prompt into a single canonical injection", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<memory version="2"><last_request>next</last_request><persistent_memory></persistent_memory></memory>',
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

    assertStringIncludes(
      output.messages[0].parts[0].text,
      '<memory version="2">',
    );
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
          '<memory version="2"><last_request>next</last_request><persistent_memory></persistent_memory></memory>',
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

      assertStringIncludes(
        output.messages[0].parts[0].text,
        '<memory version="2">',
      );
      assertEquals(
        output.messages[0].parts[0].text.includes(text.split("\n\n")[0]),
        false,
      );
      assertStringIncludes(output.messages[0].parts[0].text, "next");
    }
  });

  it("neutralizes user-authored persistent memory blocks away from the reinjection prefix", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<memory version="2"><last_request>next</last_request><persistent_memory></persistent_memory></memory>',
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

    assertStringIncludes(
      output.messages[0].parts[0].text,
      '<memory version="2">',
    );
    assertStringIncludes(
      output.messages[0].parts[0].text,
      "&lt;persistent_memory fact_uuids=&quot;fact-standalone-1,fact-standalone-2&quot;&gt;stale memory&lt;/persistent_memory&gt;",
    );
  });

  it("neutralizes literal user-authored session memory XML in the latest user message", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<memory version="2"><last_request>inspect example</last_request><persistent_memory></persistent_memory></memory>',
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

    assertStringIncludes(
      output.messages[0].parts[0].text,
      '<memory version="2">',
    );
    assertStringIncludes(
      output.messages[0].parts[0].text,
      "&lt;session_memory version=&quot;1&quot;&gt;<last_request>example</last_request>&lt;/session_memory&gt;",
    );
  });

  it("neutralizes leading user-authored session_memory blocks that do not match the injected shape", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<memory version="2"><last_request>inspect example</last_request><persistent_memory></persistent_memory></memory>',
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

    assertStringIncludes(
      output.messages[0].parts[0].text,
      "&lt;session_memory version=&quot;1&quot;&gt;<last_request>user-authored example</last_request>&lt;/session_memory&gt;",
    );
  });

  it("neutralizes leading user-authored legacy and persistent memory blocks", async () => {
    const cases = [
      {
        input: "<memory>user-authored example</memory>",
        escaped: "&lt;memory&gt;user-authored example&lt;/memory&gt;",
      },
      {
        input: "<persistent_memory>user-authored example</persistent_memory>",
        escaped:
          "&lt;persistent_memory&gt;user-authored example&lt;/persistent_memory&gt;",
      },
    ];

    for (const { input, escaped } of cases) {
      const sessionManager = new MockSessionManager();
      sessionManager.state.pendingInjection = {
        envelope:
          '<memory version="2"><last_request>inspect example</last_request><persistent_memory></persistent_memory></memory>',
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
            text: `${input}\n\ninspect example`,
          }],
        }],
      };

      await handler({} as never, output as never);

      assertEquals(
        output.messages[0].parts[0].text.includes(input),
        false,
      );
      assertStringIncludes(output.messages[0].parts[0].text, escaped);
    }
  });

  it("neutralizes leading user-authored non-empty legacy memory blocks without data-uuids", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<memory version="2"><last_request>inspect example</last_request><persistent_memory></persistent_memory></memory>',
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

    assertStringIncludes(
      output.messages[0].parts[0].text,
      "&lt;memory&gt;user-authored example&lt;/memory&gt;",
    );
  });

  it("preserves the canonical injected block while neutralizing user-authored memory-envelope tags", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<memory version="2"><last_request>inspect example</last_request><persistent_memory></persistent_memory></memory>',
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
            'Inspect this literal XML:\n\n<session_memory version="1"><last_request>example</last_request></session_memory>',
        }],
      }],
    };

    await handler({} as never, output as never);

    assertEquals(
      output.messages[0].parts[0].text.match(/<memory\b/g)?.length,
      1,
    );
    assertStringIncludes(
      output.messages[0].parts[0].text,
      "&lt;session_memory version=&quot;1&quot;&gt;<last_request>example</last_request>&lt;/session_memory&gt;",
    );
  });

  it("reports rewroteExistingMemory when canonical or legacy blocks were scrubbed", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<memory version="2"><last_request>next</last_request><persistent_memory></persistent_memory></memory>',
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
        entry.args[0] === "Injected canonical memory block"
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
        '<memory version="2"><last_request>continue</last_request><persistent_memory></persistent_memory></memory>',
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
    assertStringIncludes(
      output.messages[2].parts[0].text,
      '<memory version="2">',
    );
    assertEquals(
      output.messages[2].parts[0].text.match(/<memory\b/g)?.length,
      1,
    );
  });

  it("does not scrub standalone persistent memory blocks from earlier prompt history", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<memory version="2"><last_request>continue</last_request><persistent_memory></persistent_memory></memory>',
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
    assertStringIncludes(
      output.messages[1].parts[0].text,
      '<memory version="2">',
    );
    assertEquals(
      output.messages[1].parts[0].text.match(/<memory\b/g)?.length,
      1,
    );
  });

  it("does not clear a newer pending injection after awaiting prepareInjection", async () => {
    const newerPrepared = {
      envelope:
        '<memory version="2"><last_request>newer</last_request><persistent_memory></persistent_memory></memory>',
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
          '<memory version="2"><last_request>older</last_request><persistent_memory></persistent_memory></memory>',
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
        '<memory version="2"><last_request>continue</last_request><persistent_memory></persistent_memory></memory>',
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
    assertStringIncludes(
      output.messages[1].parts[0].text,
      '<memory version="2">',
    );
  });

  it("scrubs only the leading injected block from the latest user prompt", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<memory version="2"><last_request>continue</last_request><persistent_memory></persistent_memory></memory>',
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
            `<memory version="2"><last_request>stale</last_request><persistent_memory></persistent_memory></memory>\n\n${trailingExample}`,
        }],
      }],
    };

    await handler({} as never, output as never);

    assertEquals(
      output.messages[0].parts[0].text,
      '<memory version="2"><last_request>continue</last_request><persistent_memory></persistent_memory></memory>\n\nkeep transcript\n\n&lt;session_memory version=&quot;1&quot;&gt;<last_request>example</last_request>&lt;/session_memory&gt;',
    );
  });

  it("scrubs leading normalized memory envelopes regardless of source/version values", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<memory source="local" version="2"><last_request>continue</last_request><persistent_memory></persistent_memory></memory>',
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
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{
          type: "text",
          text:
            '<memory source="local" version="2"><last_request>stale</last_request><session_snapshot><snapshot /></session_snapshot><persistent_memory></persistent_memory></memory>\n\ncontinue',
        }],
      }],
    };

    await handler({} as never, output as never);

    assertEquals(
      output.messages[0].parts[0].text,
      '<memory source="local" version="2"><last_request>continue</last_request><persistent_memory></persistent_memory></memory>\n\ncontinue',
    );
  });

  it("scrubs multiple sequential leading memory envelopes even when later blocks omit attrs", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<memory version="2"><last_request>continue</last_request><persistent_memory></persistent_memory></memory>',
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
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{
          type: "text",
          text:
            '<memory version="2"><last_request>stale</last_request><persistent_memory></persistent_memory></memory>\n\n<memory><last_request>older stale</last_request></memory>\n\ncontinue',
        }],
      }],
    };

    await handler({} as never, output as never);

    assertEquals(
      output.messages[0].parts[0].text,
      '<memory version="2"><last_request>continue</last_request><persistent_memory></persistent_memory></memory>\n\ncontinue',
    );
  });

  it("scrubs leading standalone persistent_memory envelopes even without identifying attrs", async () => {
    const sessionManager = new MockSessionManager();
    sessionManager.state.pendingInjection = {
      envelope:
        '<memory version="2"><last_request>continue</last_request><persistent_memory></persistent_memory></memory>',
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
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{
          type: "text",
          text:
            "<persistent_memory><node>stale cached recall</node></persistent_memory>\n\ncontinue",
        }],
      }],
    };

    await handler({} as never, output as never);

    assertEquals(
      output.messages[0].parts[0].text,
      '<memory version="2"><last_request>continue</last_request><persistent_memory></persistent_memory></memory>\n\ncontinue',
    );
  });

  it("remains compatible with extended prepareInjection results", async () => {
    const prepared = {
      envelope:
        '<memory version="2"><persistent_memory></persistent_memory></memory>',
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

    assertStringIncludes(
      output.messages[0].parts[0].text,
      '<memory version="2">',
    );
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
          '<memory version="2"><last_request>follow up from child</last_request><persistent_memory></persistent_memory></memory>',
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

    assertStringIncludes(
      output.messages[0].parts[0].text,
      '<memory version="2">',
    );
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

  it("skips transform work when the latest user text part is synthetic", async () => {
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
        parts: [{ type: "text", text: "synthetic", synthetic: true }],
      }],
    };

    await handler({ message: "should be ignored" } as never, output as never);

    assertEquals(sessionManager.activeCalls, []);
    assertEquals(sessionManager.state.pendingInjection, undefined);
    assertEquals(output.messages[0].parts[0].text, "synthetic");
  });
});
