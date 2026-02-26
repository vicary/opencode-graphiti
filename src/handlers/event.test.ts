import {
  assert,
  assertEquals,
  assertStrictEquals,
} from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import type { GraphitiFact, GraphitiNode } from "../types/index.ts";
import type { SessionManager, SessionState } from "../session.ts";
import type { GraphitiClient } from "../services/client.ts";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { createEventHandler } from "./event.ts";

// Mock SessionManager
class MockSessionManager implements Partial<SessionManager> {
  private sessions = new Map<string, SessionState>();
  private parentIds = new Map<string, string | null>();
  public flushCalls: Array<{
    sessionId: string;
    sourceDescription: string;
    minBytes: number;
  }> = [];

  async isSubagentSession(sessionId: string): Promise<boolean> {
    return this.parentIds.get(sessionId) !== null &&
      this.parentIds.get(sessionId) !== undefined;
  }

  async resolveSessionState(sessionId: string) {
    const parentId = this.parentIds.get(sessionId);
    if (parentId === undefined) return { state: null, resolved: false };
    if (parentId) {
      this.sessions.delete(sessionId);
      return { state: null, resolved: true };
    }

    const state = this.sessions.get(sessionId);
    if (!state) return { state: null, resolved: false };
    return { state, resolved: true };
  }

  setParentId(sessionId: string, parentId: string | null) {
    this.parentIds.set(sessionId, parentId);
  }

  setState(sessionId: string, state: SessionState) {
    this.sessions.set(sessionId, state);
  }

  getState(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  async flushPendingMessages(
    sessionId: string,
    sourceDescription: string,
    minBytes: number,
  ): Promise<void> {
    this.flushCalls.push({ sessionId, sourceDescription, minBytes });
  }

  bufferAssistantPart(sessionId: string, messageId: string, text: string) {
    // Simple mock implementation
  }

  isAssistantBuffered(sessionId: string, messageId: string): boolean {
    return false;
  }

  finalizeAssistantMessage(
    state: SessionState,
    sessionId: string,
    messageId: string,
    source: string,
  ): void {
    // Simple mock implementation
  }

  deletePendingAssistant(sessionId: string, messageId: string): void {
    // Simple mock implementation
  }
}

// Mock GraphitiClient
class MockGraphitiClient implements Partial<GraphitiClient> {
  public addEpisodeCalls: Array<{
    name: string;
    episodeBody: string;
    groupId?: string;
    source?: "text" | "json" | "message";
    sourceDescription?: string;
  }> = [];

  async addEpisode(params: {
    name: string;
    episodeBody: string;
    groupId?: string;
    source?: "text" | "json" | "message";
    sourceDescription?: string;
  }): Promise<void> {
    this.addEpisodeCalls.push(params);
  }

  async searchFacts(params: {
    query: string;
    groupIds?: string[];
    maxFacts?: number;
  }): Promise<GraphitiFact[]> {
    return [];
  }

  async searchNodes(params: {
    query: string;
    groupIds?: string[];
    maxNodes?: number;
  }): Promise<GraphitiNode[]> {
    return [];
  }
}

// Mock OpencodeClient
class MockSdkClient implements Partial<OpencodeClient> {
  // Minimal mock for now
}

describe("event handler integration", () => {
  describe("session.created", () => {
    it("should initialize state for main session", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();
      const sdkClient = new MockSdkClient();

      const handler = createEventHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        sdkClient: sdkClient as any,
        directory: "/test/dir",
        groupIdPrefix: "test",
      });

      await handler({
        event: {
          type: "session.created",
          properties: {
            info: {
              id: "session-1",
              parentID: null,
            },
          },
        } as any,
      });

      const state = sessionManager.getState("session-1");
      assertEquals(state?.groupId, "test:project");
      // userGroupId is derived from makeUserGroupId(groupIdPrefix)
      // which creates format: "<prefix>-<projectName>__user-<userName>"
      assert(state?.userGroupId?.startsWith("test-"));
      assert(state?.userGroupId?.includes("__user-"));
      assertEquals(state?.injectedMemories, false);
      assertEquals(state?.lastInjectionFactUuids, []);
      assertEquals(state?.messageCount, 0);
      assertEquals(state?.pendingMessages, []);
      assertEquals(state?.contextLimit, 200_000);
      assertEquals(state?.isMain, true);
    });

    it("should not initialize state for subagent session", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();
      const sdkClient = new MockSdkClient();

      const handler = createEventHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        sdkClient: sdkClient as any,
        directory: "/test/dir",
        groupIdPrefix: "test",
      });

      await handler({
        event: {
          type: "session.created",
          properties: {
            info: {
              id: "session-2",
              parentID: "session-1",
            },
          },
        } as any,
      });

      const state = sessionManager.getState("session-2");
      assertEquals(state, undefined);
    });

    it("should cache parentId correctly", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();
      const sdkClient = new MockSdkClient();

      const handler = createEventHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        sdkClient: sdkClient as any,
        directory: "/test/dir",
        groupIdPrefix: "test",
      });

      await handler({
        event: {
          type: "session.created",
          properties: {
            info: {
              id: "session-1",
              parentID: null,
            },
          },
        } as any,
      });

      const isSubagent = await sessionManager.isSubagentSession("session-1");
      assertEquals(isSubagent, false);
    });
  });

  describe("session.idle", () => {
    it("should generate and save snapshot with buildSessionSnapshot", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();
      const sdkClient = new MockSdkClient();

      sessionManager.setParentId("session-1", null);
      sessionManager.setState("session-1", {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: true,
        lastInjectionFactUuids: [],
        visibleFactUuids: [],
        messageCount: 5,
        pendingMessages: [
          "User: What is TypeScript?",
          "Assistant: TypeScript is a strongly typed programming language.",
          "User: How does it work?",
          "Assistant: It compiles to JavaScript and adds type checking.",
        ],
        contextLimit: 200_000,
        isMain: true,
      });

      const handler = createEventHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        sdkClient: sdkClient as any,
        directory: "/test/dir",
        groupIdPrefix: "test",
      });

      await handler({
        event: {
          type: "session.idle",
          properties: {
            sessionID: "session-1",
          },
        } as any,
      });

      // Should call addEpisode with snapshot
      assertEquals(client.addEpisodeCalls.length, 1);
      assertEquals(client.addEpisodeCalls[0].name, "Snapshot: session-1");
      assertEquals(
        client.addEpisodeCalls[0].sourceDescription,
        "session-snapshot",
      );
      assertEquals(client.addEpisodeCalls[0].groupId, "test:project");
      assertEquals(client.addEpisodeCalls[0].source, "text");

      // Verify snapshot content includes recent messages
      const snapshot = client.addEpisodeCalls[0].episodeBody;
      assertStrictEquals(snapshot.includes("session-1"), true);
      assertStrictEquals(snapshot.includes("Recent user focus:"), true);
      assertStrictEquals(snapshot.includes("Recent assistant focus:"), true);

      // Should flush messages after snapshot
      assertEquals(sessionManager.flushCalls.length, 1);
      assertEquals(sessionManager.flushCalls[0].sessionId, "session-1");
      assertEquals(
        sessionManager.flushCalls[0].sourceDescription,
        "Buffered messages from OpenCode session",
      );
      assertEquals(sessionManager.flushCalls[0].minBytes, 50);
    });

    it("should extract questions from messages", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();
      const sdkClient = new MockSdkClient();

      sessionManager.setParentId("session-1", null);
      sessionManager.setState("session-1", {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        visibleFactUuids: [],
        messageCount: 2,
        pendingMessages: [
          "User: What is Deno?",
          "Assistant: Deno is a JavaScript runtime.",
          "User: How is it different from Node.js?",
        ],
        contextLimit: 200_000,
        isMain: true,
      });

      const handler = createEventHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        sdkClient: sdkClient as any,
        directory: "/test/dir",
        groupIdPrefix: "test",
      });

      await handler({
        event: {
          type: "session.idle",
          properties: {
            sessionID: "session-1",
          },
        } as any,
      });

      const snapshot = client.addEpisodeCalls[0].episodeBody;
      assertStrictEquals(snapshot.includes("Open questions:"), true);
      assertStrictEquals(snapshot.includes("What is Deno?"), true);
      assertStrictEquals(
        snapshot.includes("How is it different from Node.js?"),
        true,
      );
    });

    it("should handle empty pending messages", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();
      const sdkClient = new MockSdkClient();

      sessionManager.setParentId("session-1", null);
      sessionManager.setState("session-1", {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        visibleFactUuids: [],
        messageCount: 0,
        pendingMessages: [],
        contextLimit: 200_000,
        isMain: true,
      });

      const handler = createEventHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        sdkClient: sdkClient as any,
        directory: "/test/dir",
        groupIdPrefix: "test",
      });

      await handler({
        event: {
          type: "session.idle",
          properties: {
            sessionID: "session-1",
          },
        } as any,
      });

      // Should call addEpisode even with empty messages (snapshot has session ID)
      assertEquals(client.addEpisodeCalls.length, 1);
      assertEquals(
        client.addEpisodeCalls[0].name,
        "Snapshot: session-1",
      );
      assertEquals(
        client.addEpisodeCalls[0].episodeBody,
        "Session session-1 working snapshot",
      );

      // Should still flush (though nothing to flush)
      assertEquals(sessionManager.flushCalls.length, 1);
    });

    it("should ignore non-main sessions", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();
      const sdkClient = new MockSdkClient();

      sessionManager.setParentId("session-2", "session-1");
      sessionManager.setState("session-2", {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        visibleFactUuids: [],
        messageCount: 0,
        pendingMessages: ["User: Hello"],
        contextLimit: 200_000,
        isMain: false,
      });

      const handler = createEventHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        sdkClient: sdkClient as any,
        directory: "/test/dir",
        groupIdPrefix: "test",
      });

      await handler({
        event: {
          type: "session.idle",
          properties: {
            sessionID: "session-2",
          },
        } as any,
      });

      // Should not save snapshot for non-main
      assertEquals(client.addEpisodeCalls.length, 0);
      assertEquals(sessionManager.flushCalls.length, 0);
    });

    it("should handle unresolved session gracefully", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();
      const sdkClient = new MockSdkClient();

      const handler = createEventHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        sdkClient: sdkClient as any,
        directory: "/test/dir",
        groupIdPrefix: "test",
      });

      await handler({
        event: {
          type: "session.idle",
          properties: {
            sessionID: "unknown-session",
          },
        } as any,
      });

      // Should not crash, just skip
      assertEquals(client.addEpisodeCalls.length, 0);
      assertEquals(sessionManager.flushCalls.length, 0);
    });

    it("should handle addEpisode error gracefully", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();
      const sdkClient = new MockSdkClient();

      client.addEpisode = async () => {
        throw new Error("Network error");
      };

      sessionManager.setParentId("session-1", null);
      sessionManager.setState("session-1", {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        visibleFactUuids: [],
        messageCount: 1,
        pendingMessages: ["User: Hello"],
        contextLimit: 200_000,
        isMain: true,
      });

      const handler = createEventHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        sdkClient: sdkClient as any,
        directory: "/test/dir",
        groupIdPrefix: "test",
      });

      await handler({
        event: {
          type: "session.idle",
          properties: {
            sessionID: "session-1",
          },
        } as any,
      });

      // Should still flush despite error
      assertEquals(sessionManager.flushCalls.length, 1);
    });
  });

  describe("session.compacted", () => {
    it("should flush messages before compaction", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();
      const sdkClient = new MockSdkClient();

      sessionManager.setParentId("session-1", null);
      sessionManager.setState("session-1", {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: true,
        lastInjectionFactUuids: [],
        visibleFactUuids: [],
        messageCount: 3,
        pendingMessages: ["User: Test message"],
        contextLimit: 200_000,
        isMain: true,
      });

      const handler = createEventHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        sdkClient: sdkClient as any,
        directory: "/test/dir",
        groupIdPrefix: "test",
      });

      await handler({
        event: {
          type: "session.compacted",
          properties: {
            sessionID: "session-1",
            summary: "Discussion about testing",
          },
        } as any,
      });

      // Should flush with compaction description and minBytes 0
      assertEquals(sessionManager.flushCalls.length, 1);
      assertEquals(sessionManager.flushCalls[0].sessionId, "session-1");
      assertEquals(
        sessionManager.flushCalls[0].sourceDescription,
        "Buffered messages flushed before compaction",
      );
      assertEquals(sessionManager.flushCalls[0].minBytes, 0);
    });

    it("should ignore non-main sessions", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();
      const sdkClient = new MockSdkClient();

      sessionManager.setParentId("session-2", "session-1");
      sessionManager.setState("session-2", {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        visibleFactUuids: [],
        messageCount: 0,
        pendingMessages: ["User: Hello"],
        contextLimit: 200_000,
        isMain: false,
      });

      const handler = createEventHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        sdkClient: sdkClient as any,
        directory: "/test/dir",
        groupIdPrefix: "test",
      });

      await handler({
        event: {
          type: "session.compacted",
          properties: {
            sessionID: "session-2",
            summary: "Test summary",
          },
        } as any,
      });

      // Should not flush for non-main
      assertEquals(sessionManager.flushCalls.length, 0);
    });

    it("should handle unresolved session gracefully", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();
      const sdkClient = new MockSdkClient();

      const handler = createEventHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        sdkClient: sdkClient as any,
        directory: "/test/dir",
        groupIdPrefix: "test",
      });

      await handler({
        event: {
          type: "session.compacted",
          properties: {
            sessionID: "unknown-session",
            summary: "Test summary",
          },
        } as any,
      });

      // Should not crash
      assertEquals(sessionManager.flushCalls.length, 0);
    });

    it("should skip when summary is empty", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();
      const sdkClient = new MockSdkClient();

      sessionManager.setParentId("session-1", null);
      sessionManager.setState("session-1", {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        visibleFactUuids: [],
        messageCount: 0,
        pendingMessages: [],
        contextLimit: 200_000,
        isMain: true,
      });

      const handler = createEventHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        sdkClient: sdkClient as any,
        directory: "/test/dir",
        groupIdPrefix: "test",
      });

      await handler({
        event: {
          type: "session.compacted",
          properties: {
            sessionID: "session-1",
            summary: "",
          },
        } as any,
      });

      // Should flush but not call handleCompaction
      assertEquals(sessionManager.flushCalls.length, 1);
    });
  });

  describe("message.updated", () => {
    it("should finalize completed assistant message", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();
      const sdkClient = new MockSdkClient();

      sessionManager.setParentId("session-1", null);
      sessionManager.setState("session-1", {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        visibleFactUuids: [],
        messageCount: 0,
        pendingMessages: [],
        contextLimit: 200_000,
        isMain: true,
      });

      let finalizeCalled = false;
      sessionManager.finalizeAssistantMessage = (
        state,
        sessionId,
        messageId,
        source,
      ) => {
        finalizeCalled = true;
        assertEquals(sessionId, "session-1");
        assertEquals(messageId, "msg-1");
        assertEquals(source, "message.updated");
      };

      const handler = createEventHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        sdkClient: sdkClient as any,
        directory: "/test/dir",
        groupIdPrefix: "test",
      });

      await handler({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-1",
              sessionID: "session-1",
              role: "assistant",
              time: { created: 1000, completed: 2000 },
              tokens: { input: 10, output: 20 },
              providerID: "openai",
              modelID: "gpt-4",
            },
          },
        } as any,
      });

      assertEquals(finalizeCalled, true);
    });

    it("should delete pending assistant for non-assistant messages", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();
      const sdkClient = new MockSdkClient();

      sessionManager.setParentId("session-1", null);
      sessionManager.setState("session-1", {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        visibleFactUuids: [],
        messageCount: 0,
        pendingMessages: [],
        contextLimit: 200_000,
        isMain: true,
      });

      let deleteCalled = false;
      sessionManager.deletePendingAssistant = (sessionId, messageId) => {
        deleteCalled = true;
        assertEquals(sessionId, "session-1");
        assertEquals(messageId, "msg-1");
      };

      const handler = createEventHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        sdkClient: sdkClient as any,
        directory: "/test/dir",
        groupIdPrefix: "test",
      });

      await handler({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-1",
              sessionID: "session-1",
              role: "user",
              time: { created: 1000, completed: 2000 },
            },
          },
        } as any,
      });

      assertEquals(deleteCalled, true);
    });

    it("should skip if message is not completed", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();
      const sdkClient = new MockSdkClient();

      sessionManager.setParentId("session-1", null);
      sessionManager.setState("session-1", {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        visibleFactUuids: [],
        messageCount: 0,
        pendingMessages: [],
        contextLimit: 200_000,
        isMain: true,
      });

      let finalizeCalled = false;
      sessionManager.finalizeAssistantMessage = () => {
        finalizeCalled = true;
      };

      const handler = createEventHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        sdkClient: sdkClient as any,
        directory: "/test/dir",
        groupIdPrefix: "test",
      });

      await handler({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-1",
              sessionID: "session-1",
              role: "assistant",
              time: { created: 1000 }, // No completed time
            },
          },
        } as any,
      });

      assertEquals(finalizeCalled, false);
    });

    it("should skip if already buffered", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();
      const sdkClient = new MockSdkClient();

      sessionManager.setParentId("session-1", null);
      sessionManager.setState("session-1", {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        visibleFactUuids: [],
        messageCount: 0,
        pendingMessages: [],
        contextLimit: 200_000,
        isMain: true,
      });

      sessionManager.isAssistantBuffered = () => true;

      let finalizeCalled = false;
      sessionManager.finalizeAssistantMessage = () => {
        finalizeCalled = true;
      };

      const handler = createEventHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        sdkClient: sdkClient as any,
        directory: "/test/dir",
        groupIdPrefix: "test",
      });

      await handler({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-1",
              sessionID: "session-1",
              role: "assistant",
              time: { created: 1000, completed: 2000 },
            },
          },
        } as any,
      });

      assertEquals(finalizeCalled, false);
    });

    it("should ignore non-main sessions", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();
      const sdkClient = new MockSdkClient();

      sessionManager.setParentId("session-2", "session-1");
      sessionManager.setState("session-2", {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        visibleFactUuids: [],
        messageCount: 0,
        pendingMessages: [],
        contextLimit: 200_000,
        isMain: false,
      });

      let finalizeCalled = false;
      sessionManager.finalizeAssistantMessage = () => {
        finalizeCalled = true;
      };

      const handler = createEventHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        sdkClient: sdkClient as any,
        directory: "/test/dir",
        groupIdPrefix: "test",
      });

      await handler({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-1",
              sessionID: "session-2",
              role: "assistant",
              time: { created: 1000, completed: 2000 },
            },
          },
        } as any,
      });

      assertEquals(finalizeCalled, false);
    });
  });

  describe("message.part.updated", () => {
    it("should buffer text parts for assistant messages", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();
      const sdkClient = new MockSdkClient();

      let bufferCalled = false;
      sessionManager.bufferAssistantPart = (sessionId, messageId, text) => {
        bufferCalled = true;
        assertEquals(sessionId, "session-1");
        assertEquals(messageId, "msg-1");
        assertEquals(text, "Hello world");
      };

      const handler = createEventHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        sdkClient: sdkClient as any,
        directory: "/test/dir",
        groupIdPrefix: "test",
      });

      await handler({
        event: {
          type: "message.part.updated",
          properties: {
            part: {
              type: "text",
              text: "Hello world",
              sessionID: "session-1",
              messageID: "msg-1",
            },
          },
        } as any,
      });

      assertEquals(bufferCalled, true);
    });

    it("should ignore non-text parts", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();
      const sdkClient = new MockSdkClient();

      let bufferCalled = false;
      sessionManager.bufferAssistantPart = () => {
        bufferCalled = true;
      };

      const handler = createEventHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        sdkClient: sdkClient as any,
        directory: "/test/dir",
        groupIdPrefix: "test",
      });

      await handler({
        event: {
          type: "message.part.updated",
          properties: {
            part: {
              type: "tool_call",
              sessionID: "session-1",
              messageID: "msg-1",
            },
          },
        } as any,
      });

      assertEquals(bufferCalled, false);
    });

    it("should ignore synthetic text parts", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();
      const sdkClient = new MockSdkClient();

      let bufferCalled = false;
      sessionManager.bufferAssistantPart = () => {
        bufferCalled = true;
      };

      const handler = createEventHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        sdkClient: sdkClient as any,
        directory: "/test/dir",
        groupIdPrefix: "test",
      });

      await handler({
        event: {
          type: "message.part.updated",
          properties: {
            part: {
              type: "text",
              text: "Synthetic text",
              synthetic: true,
              sessionID: "session-1",
              messageID: "msg-1",
            },
          },
        } as any,
      });

      assertEquals(bufferCalled, false);
    });
  });

  describe("error handling", () => {
    it("should catch and log errors without crashing", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();
      const sdkClient = new MockSdkClient();

      // Make resolveSessionState throw
      sessionManager.resolveSessionState = async () => {
        throw new Error("Test error");
      };

      const handler = createEventHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        sdkClient: sdkClient as any,
        directory: "/test/dir",
        groupIdPrefix: "test",
      });

      // Should not throw
      await handler({
        event: {
          type: "session.idle",
          properties: {
            sessionID: "session-1",
          },
        } as any,
      });

      // Test passed if no error thrown
    });
  });
});
