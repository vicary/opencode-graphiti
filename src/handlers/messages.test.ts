import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { createMessagesHandler } from "./messages.ts";

describe("messages handler", () => {
  it("injects pending session memory into the latest user message", async () => {
    const state = {
      isMain: true,
      visibleFactUuids: [],
      pendingInjection: {
        envelope:
          '<session_memory version="1"><last_request>fresh</last_request></session_memory>',
        factUuids: ["fact-1"],
        nodeRefs: [],
        refreshDecision: {
          classification: "aligned",
          shouldRefresh: false,
          similarity: 1,
          threshold: 0.5,
          cachedQuery: "fresh",
        },
      },
    };
    const handler = createMessagesHandler({
      sessionManager: {
        getState() {
          return state;
        },
        prepareInjection() {
          throw new Error("should not be called");
        },
      } as never,
    });

    const output = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{ type: "text", text: "Continue work" }],
      }],
    };
    await handler({}, output as never);

    assertStringIncludes(output.messages[0].parts[0].text, "<session_memory");
    assertEquals(state.pendingInjection, undefined);
  });

  it("prepares injection on transform when chat hook has not populated it yet", async () => {
    const state = {
      isMain: true,
      visibleFactUuids: [] as string[],
      pendingInjection: undefined as unknown,
    };
    const handler = createMessagesHandler({
      sessionManager: {
        getState() {
          return state;
        },
        prepareInjection(sessionId: string, lastRequest?: string) {
          assertEquals(sessionId, "session-1");
          assertEquals(lastRequest, "fallback request");
          return {
            envelope:
              '<session_memory version="1"><last_request>fallback request</last_request></session_memory>',
            factUuids: [],
            nodeRefs: [],
            refreshDecision: {
              classification: "miss",
              shouldRefresh: true,
              similarity: 0,
              threshold: 0.5,
              cachedQuery: null,
            },
          };
        },
      } as never,
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
    const state = {
      isMain: true,
      visibleFactUuids: [] as string[],
      pendingInjection: undefined as unknown,
    };
    const handler = createMessagesHandler({
      sessionManager: {
        getState() {
          return state;
        },
        prepareInjection(sessionId: string, lastRequest?: string) {
          assertEquals(sessionId, "session-1");
          assertEquals(lastRequest, "fallback request");
          return {
            envelope: '<session_memory version="1"></session_memory>',
            factUuids: [],
            nodeRefs: [],
            refreshDecision: {
              classification: "miss",
              shouldRefresh: true,
              similarity: 0,
              threshold: 0.5,
              cachedQuery: null,
            },
          };
        },
      } as never,
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
    const state = {
      isMain: true,
      visibleFactUuids: [] as string[],
      pendingInjection: undefined as unknown,
    };
    const handler = createMessagesHandler({
      sessionManager: {
        getState() {
          return state;
        },
        prepareInjection(sessionId: string, lastRequest?: string) {
          assertEquals(sessionId, "session-1");
          assertEquals(lastRequest, "message body query");
          return {
            envelope:
              '<session_memory version="1"><last_request>message body query</last_request></session_memory>',
            factUuids: [],
            nodeRefs: [],
            refreshDecision: {
              classification: "miss",
              shouldRefresh: true,
              similarity: 0,
              threshold: 0.5,
              cachedQuery: null,
            },
          };
        },
      } as never,
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

  it("tracks visible fact uuids from prior injected memory", async () => {
    const state = {
      isMain: true,
      visibleFactUuids: [] as string[],
      pendingInjection: {
        envelope: '<session_memory version="1"></session_memory>',
        factUuids: [],
        nodeRefs: [],
        refreshDecision: {
          classification: "aligned",
          shouldRefresh: false,
          similarity: 1,
          threshold: 0.5,
          cachedQuery: "next",
        },
      },
    };
    const handler = createMessagesHandler({
      sessionManager: {
        getState() {
          return state;
        },
        prepareInjection() {
          return state.pendingInjection;
        },
      } as never,
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

    assertEquals(state.visibleFactUuids, ["fact-1", "fact-2"]);
  });

  it("preserves legacy Graphiti memory data-uuids extraction semantics", async () => {
    const state = {
      isMain: true,
      visibleFactUuids: [] as string[],
      pendingInjection: undefined as unknown,
    };
    const handler = createMessagesHandler({
      sessionManager: {
        getState() {
          return state;
        },
        prepareInjection() {
          return {
            envelope: '<session_memory version="1"></session_memory>',
            factUuids: [],
            nodeRefs: [],
            refreshDecision: {
              classification: "aligned",
              shouldRefresh: false,
              similarity: 1,
              threshold: 0.5,
              cachedQuery: "next",
            },
          };
        },
      } as never,
    });

    const output = {
      messages: [
        {
          info: { role: "assistant", sessionID: "session-1" },
          parts: [{
            type: "text",
            text: '<memory data-uuids="fact-legacy-1,fact-legacy-2"></memory>',
          }],
        },
        {
          info: { role: "user", sessionID: "session-1" },
          parts: [{ type: "text", text: "next" }],
        },
      ],
    };

    await handler({}, output as never);

    assertEquals(state.visibleFactUuids, ["fact-legacy-1", "fact-legacy-2"]);
  });

  it("passes current-turn visible fact uuids into prepareInjection", async () => {
    const state = {
      isMain: true,
      visibleFactUuids: ["stale-fact"] as string[],
      pendingInjection: undefined as unknown,
    };
    const handler = createMessagesHandler({
      sessionManager: {
        getState() {
          return state;
        },
        prepareInjection(
          sessionId: string,
          lastRequest?: string,
          visibleFactUuids?: string[],
        ) {
          assertEquals(sessionId, "session-1");
          assertEquals(lastRequest, "next");
          assertEquals(visibleFactUuids, ["fact-1", "fact-2"]);
          return {
            envelope: '<session_memory version="1"></session_memory>',
            factUuids: [],
            nodeRefs: [],
            refreshDecision: {
              classification: "aligned",
              shouldRefresh: false,
              similarity: 1,
              threshold: 0.5,
              cachedQuery: "next",
            },
          };
        },
      } as never,
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

    await handler({} as never, output as never);

    assertEquals(state.visibleFactUuids, ["fact-1", "fact-2"]);
    assertStringIncludes(output.messages[1].parts[0].text, "<session_memory");
  });

  it("dedupes canonical and legacy visible fact uuids before prepareInjection", async () => {
    const state = {
      isMain: true,
      visibleFactUuids: [] as string[],
      pendingInjection: undefined as unknown,
    };
    const handler = createMessagesHandler({
      sessionManager: {
        getState() {
          return state;
        },
        prepareInjection(
          sessionId: string,
          lastRequest?: string,
          visibleFactUuids?: string[],
        ) {
          assertEquals(sessionId, "session-1");
          assertEquals(lastRequest, "continue");
          assertEquals(visibleFactUuids, ["fact-1", "fact-2", "fact-3"]);
          return {
            envelope:
              '<session_memory version="1"><last_request>continue</last_request></session_memory>',
            factUuids: [],
            nodeRefs: [],
            refreshDecision: {
              classification: "aligned",
              shouldRefresh: false,
              similarity: 1,
              threshold: 0.5,
              cachedQuery: "continue",
            },
          };
        },
      } as never,
    });

    const output = {
      messages: [
        {
          info: { role: "assistant", sessionID: "session-1" },
          parts: [{
            type: "text",
            text:
              '<persistent_memory fact_uuids="fact-1,fact-2,fact-1"></persistent_memory>',
          }],
        },
        {
          info: { role: "assistant", sessionID: "session-1" },
          parts: [{
            type: "text",
            text: '<memory data-uuids="fact-2,fact-3"></memory>',
          }],
        },
        {
          info: { role: "user", sessionID: "session-1" },
          parts: [{ type: "text", text: "continue" }],
        },
      ],
    };

    await handler({}, output as never);

    assertEquals(state.visibleFactUuids, ["fact-1", "fact-2", "fact-3"]);
    assertStringIncludes(output.messages[2].parts[0].text, "<session_memory");
  });

  it("does not clear a newer pending injection after awaiting prepareInjection", async () => {
    const newerPrepared = {
      envelope:
        '<session_memory version="1"><last_request>newer</last_request></session_memory>',
      factUuids: ["fact-2"],
      nodeRefs: [],
      refreshDecision: {
        classification: "aligned",
        shouldRefresh: false,
        similarity: 1,
        threshold: 0.5,
        cachedQuery: "newer",
      },
    };
    const state = {
      isMain: true,
      visibleFactUuids: [] as string[],
      pendingInjection: undefined as typeof newerPrepared | undefined,
    };
    const handler = createMessagesHandler({
      sessionManager: {
        getState() {
          return state;
        },
        prepareInjection() {
          state.pendingInjection = newerPrepared;
          return {
            envelope:
              '<session_memory version="1"><last_request>older</last_request></session_memory>',
            factUuids: ["fact-1"],
            nodeRefs: [],
            refreshDecision: {
              classification: "miss",
              shouldRefresh: true,
              similarity: 0,
              threshold: 0.5,
              cachedQuery: null,
            },
          };
        },
      } as never,
    });

    const output = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{ type: "text", text: "current request" }],
      }],
    };
    await handler({ message: "current request" } as never, output as never);

    assertEquals(state.pendingInjection, newerPrepared);
    assertStringIncludes(output.messages[0].parts[0].text, "older");
  });

  it("remains compatible with extended prepareInjection results", async () => {
    const prepared = {
      envelope: '<session_memory version="1"></session_memory>',
      factUuids: ["fact-1"],
      nodeRefs: ["node-1"],
      refreshDecision: {
        classification: "drifted",
        shouldRefresh: true,
        similarity: 0.25,
        threshold: 0.5,
        cachedQuery: "prior topic",
      },
    };
    const state = {
      isMain: true,
      visibleFactUuids: [] as string[],
      pendingInjection: prepared,
    };
    const handler = createMessagesHandler({
      sessionManager: {
        getState() {
          return state;
        },
        prepareInjection() {
          return prepared;
        },
      } as never,
    });

    const output = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{ type: "text", text: "compatibility check" }],
      }],
    };
    await handler({}, output as never);

    assertStringIncludes(output.messages[0].parts[0].text, "<session_memory");
    assertEquals(state.pendingInjection, undefined);
  });
});
