import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { GraphitiClient } from "./client.ts";
import { SessionManager } from "../session.ts";

// ---------------------------------------------------------------------------
// Minimal stub clients – only the methods exercised by the tests are needed.
// ---------------------------------------------------------------------------

function makeStubSdk(
  parentID?: string | null,
): Pick<OpencodeClient, "session"> {
  return {
    session: {
      get: async () => ({ data: { parentID: parentID ?? null } }),
      messages: async () => ({ data: [] }),
    } as unknown as OpencodeClient["session"],
  };
}

function makeStubGraphiti(
  addEpisodeSpy?: (p: unknown) => Promise<void>,
): Pick<GraphitiClient, "addEpisode"> {
  return {
    addEpisode: addEpisodeSpy ?? (async () => {}),
  } as unknown as Pick<GraphitiClient, "addEpisode">;
}

// ---------------------------------------------------------------------------
// createDefaultState
// ---------------------------------------------------------------------------
describe("SessionManager.createDefaultState", () => {
  it("returns correct default state shape", () => {
    const sm = new SessionManager(
      "proj-group",
      "user-group",
      makeStubSdk() as unknown as OpencodeClient,
      makeStubGraphiti() as unknown as GraphitiClient,
    );
    const state = sm.createDefaultState("proj-group", "user-group");
    assertEquals(state.groupId, "proj-group");
    assertEquals(state.userGroupId, "user-group");
    assertEquals(state.injectedMemories, false);
    assertEquals(state.lastInjectionFactUuids, []);
    assertEquals(state.pendingMessages, []);
    assertEquals(state.messageCount, 0);
    assertEquals(state.contextLimit, 200_000);
    assertEquals(state.isMain, true);
  });
});

// ---------------------------------------------------------------------------
// getState / setState
// ---------------------------------------------------------------------------
describe("SessionManager.getState / setState", () => {
  it("returns undefined for unknown session", () => {
    const sm = new SessionManager(
      "g",
      "u",
      makeStubSdk() as unknown as OpencodeClient,
      makeStubGraphiti() as unknown as GraphitiClient,
    );
    assertEquals(sm.getState("missing"), undefined);
  });

  it("round-trips state through setState / getState", () => {
    const sm = new SessionManager(
      "g",
      "u",
      makeStubSdk() as unknown as OpencodeClient,
      makeStubGraphiti() as unknown as GraphitiClient,
    );
    const state = sm.createDefaultState("g", "u");
    sm.setState("s1", state);
    assertStrictEquals(sm.getState("s1"), state);
  });
});

// ---------------------------------------------------------------------------
// resolveSessionState — uses cached parentId (no real SDK call needed)
// ---------------------------------------------------------------------------
describe("SessionManager.resolveSessionState", () => {
  it("returns resolved=false when parentId lookup fails", async () => {
    const sdk = {
      session: {
        get: async () => {
          throw new Error("network");
        },
        messages: async () => ({ data: [] }),
      },
    } as unknown as OpencodeClient;
    const sm = new SessionManager(
      "g",
      "u",
      sdk,
      makeStubGraphiti() as unknown as GraphitiClient,
    );
    const result = await sm.resolveSessionState("unknown");
    assertEquals(result.resolved, false);
    assertEquals(result.state, null);
  });

  it("returns resolved=true, state=null for subagent (has parentId)", async () => {
    const sm = new SessionManager(
      "g",
      "u",
      makeStubSdk() as unknown as OpencodeClient,
      makeStubGraphiti() as unknown as GraphitiClient,
    );
    sm.setParentId("sub1", "parent-session");
    const result = await sm.resolveSessionState("sub1");
    assertEquals(result.resolved, true);
    assertEquals(result.state, null);
  });

  it("creates and returns default state for main session", async () => {
    const sm = new SessionManager(
      "proj",
      "user",
      makeStubSdk() as unknown as OpencodeClient,
      makeStubGraphiti() as unknown as GraphitiClient,
    );
    sm.setParentId("main1", null);
    const result = await sm.resolveSessionState("main1");
    assertEquals(result.resolved, true);
    assertEquals(result.state?.groupId, "proj");
    assertEquals(result.state?.isMain, true);
  });

  it("returns existing state on second call", async () => {
    const sm = new SessionManager(
      "proj",
      "user",
      makeStubSdk() as unknown as OpencodeClient,
      makeStubGraphiti() as unknown as GraphitiClient,
    );
    sm.setParentId("main1", null);
    const first = await sm.resolveSessionState("main1");
    first.state!.messageCount = 5;
    const second = await sm.resolveSessionState("main1");
    assertEquals(second.state?.messageCount, 5);
  });
});

// ---------------------------------------------------------------------------
// bufferAssistantPart / isAssistantBuffered / finalizeAssistantMessage
// ---------------------------------------------------------------------------
describe("SessionManager assistant message buffering", () => {
  it("bufferAssistantPart stores text; isAssistantBuffered returns false before finalize", () => {
    const sm = new SessionManager(
      "g",
      "u",
      makeStubSdk() as unknown as OpencodeClient,
      makeStubGraphiti() as unknown as GraphitiClient,
    );
    sm.bufferAssistantPart("s1", "m1", "Hello");
    assertEquals(sm.isAssistantBuffered("s1", "m1"), false);
  });

  it("finalizeAssistantMessage appends to pendingMessages", () => {
    const sm = new SessionManager(
      "g",
      "u",
      makeStubSdk() as unknown as OpencodeClient,
      makeStubGraphiti() as unknown as GraphitiClient,
    );
    const state = sm.createDefaultState("g", "u");
    sm.setState("s1", state);
    sm.bufferAssistantPart("s1", "m1", "World");
    sm.finalizeAssistantMessage(state, "s1", "m1", "test");
    assertEquals(state.pendingMessages[0], "Assistant: World");
    assertEquals(sm.isAssistantBuffered("s1", "m1"), true);
  });

  it("finalizeAssistantMessage is idempotent", () => {
    const sm = new SessionManager(
      "g",
      "u",
      makeStubSdk() as unknown as OpencodeClient,
      makeStubGraphiti() as unknown as GraphitiClient,
    );
    const state = sm.createDefaultState("g", "u");
    sm.setState("s1", state);
    sm.bufferAssistantPart("s1", "m1", "Hi");
    sm.finalizeAssistantMessage(state, "s1", "m1", "test");
    sm.finalizeAssistantMessage(state, "s1", "m1", "test");
    assertEquals(state.pendingMessages.length, 1);
  });

  it("does not append empty buffered text", () => {
    const sm = new SessionManager(
      "g",
      "u",
      makeStubSdk() as unknown as OpencodeClient,
      makeStubGraphiti() as unknown as GraphitiClient,
    );
    const state = sm.createDefaultState("g", "u");
    sm.setState("s1", state);
    sm.bufferAssistantPart("s1", "m1", "   "); // whitespace only
    sm.finalizeAssistantMessage(state, "s1", "m1", "test");
    assertEquals(state.pendingMessages.length, 0);
  });
});

// ---------------------------------------------------------------------------
// flushPendingMessages
// ---------------------------------------------------------------------------
describe("SessionManager.flushPendingMessages", () => {
  it("does nothing when pendingMessages is empty", async () => {
    const calls: unknown[] = [];
    const sm = new SessionManager(
      "g",
      "u",
      makeStubSdk() as unknown as OpencodeClient,
      makeStubGraphiti(async (p) => {
        calls.push(p);
      }) as unknown as GraphitiClient,
    );
    const state = sm.createDefaultState("g", "u");
    sm.setState("s1", state);
    await sm.flushPendingMessages("s1", "test", 0);
    assertEquals(calls.length, 0);
  });

  it("does not flush when combined text is below minBytes", async () => {
    const calls: unknown[] = [];
    const sm = new SessionManager(
      "g",
      "u",
      makeStubSdk() as unknown as OpencodeClient,
      makeStubGraphiti(async (p) => {
        calls.push(p);
      }) as unknown as GraphitiClient,
    );
    const state = sm.createDefaultState("g", "u");
    sm.setState("s1", state);
    state.pendingMessages = ["Assistant: Hi"];
    await sm.flushPendingMessages("s1", "test", 10_000);
    assertEquals(calls.length, 0);
    // Message was preserved (not consumed)
    assertEquals(state.pendingMessages.length, 1);
  });

  it("flushes messages above minBytes threshold", async () => {
    const calls: Array<{ episodeBody: string }> = [];
    const sm = new SessionManager(
      "g",
      "u",
      makeStubSdk() as unknown as OpencodeClient,
      makeStubGraphiti(async (p) => {
        calls.push(p as { episodeBody: string });
      }) as unknown as GraphitiClient,
    );
    const state = sm.createDefaultState("g", "u");
    sm.setState("s1", state);
    state.pendingMessages = ["User: Hello", "Assistant: World"];
    await sm.flushPendingMessages("s1", "my-source", 0);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].episodeBody.includes("User: Hello"), true);
    assertEquals(state.pendingMessages.length, 0);
  });
});

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------
describe("SessionManager.deleteSession", () => {
  it("removes session state and parentId cache", () => {
    const sm = new SessionManager(
      "g",
      "u",
      makeStubSdk() as unknown as OpencodeClient,
      makeStubGraphiti() as unknown as GraphitiClient,
    );
    const state = sm.createDefaultState("g", "u");
    sm.setState("s1", state);
    sm.setParentId("s1", null);
    sm.deleteSession("s1");
    assertEquals(sm.getState("s1"), undefined);
  });
});
