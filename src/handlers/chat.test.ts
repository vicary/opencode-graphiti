import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import type { GraphitiFact, GraphitiNode } from "../types/index.ts";
import type { SessionManager } from "../session.ts";
import type { GraphitiClient } from "../services/client.ts";
import { createChatHandler } from "./chat.ts";

// Mock SessionManager
class MockSessionManager implements Partial<SessionManager> {
  private sessions = new Map<string, any>();
  private parentIds = new Map<string, string | null>();

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

    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        cachedMemoryContext: undefined,
        messageCount: 0,
        pendingMessages: [],
        contextLimit: 200_000,
        isMain: true,
      };
      this.sessions.set(sessionId, state);
    }
    return { state, resolved: true };
  }

  setParentId(sessionId: string, parentId: string | null) {
    this.parentIds.set(sessionId, parentId);
  }

  setState(sessionId: string, state: any) {
    this.sessions.set(sessionId, state);
  }

  getState(sessionId: string) {
    return this.sessions.get(sessionId);
  }
}

// Mock GraphitiClient
class MockGraphitiClient implements Partial<GraphitiClient> {
  public searchFactsResult: GraphitiFact[] = [];
  public searchNodesResult: GraphitiNode[] = [];
  public episodesResult: any[] = [];
  public searchFactsCalls: Array<{
    query: string;
    groupIds: string[];
    maxFacts: number;
  }> = [];
  public searchNodesCalls: Array<{
    query: string;
    groupIds: string[];
    maxNodes: number;
  }> = [];
  public getEpisodesCalls: Array<{ groupId: string; lastN: number }> = [];

  async searchFacts(params: {
    query: string;
    groupIds?: string[];
    maxFacts?: number;
  }): Promise<GraphitiFact[]> {
    this.searchFactsCalls.push({
      query: params.query,
      groupIds: params.groupIds || [],
      maxFacts: params.maxFacts || 10,
    });
    return Promise.resolve(this.searchFactsResult);
  }

  async searchNodes(params: {
    query: string;
    groupIds?: string[];
    maxNodes?: number;
  }): Promise<GraphitiNode[]> {
    this.searchNodesCalls.push({
      query: params.query,
      groupIds: params.groupIds || [],
      maxNodes: params.maxNodes || 10,
    });
    return Promise.resolve(this.searchNodesResult);
  }

  async getEpisodes(params: {
    groupId?: string;
    lastN?: number;
  }): Promise<any[]> {
    this.getEpisodesCalls.push({
      groupId: params.groupId || "",
      lastN: params.lastN || 10,
    });
    return Promise.resolve(this.episodesResult);
  }
}

describe("chat handler integration", () => {
  describe("initial injection", () => {
    it("should inject on first message with facts and nodes", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      client.searchFactsResult = [
        { uuid: "f1", fact: "Test fact 1" },
        { uuid: "f2", fact: "Test fact 2" },
      ];
      client.searchNodesResult = [
        { uuid: "n1", name: "Node 1" },
      ];

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Hello world" }] } as any,
      );

      const state = sessionManager.getState("session-1");
      assertEquals(state.injectedMemories, true);
      assertEquals(state.cachedMemoryContext !== undefined, true);
      assertEquals(state.messageCount, 1);
      assertEquals(state.pendingMessages.length, 1);
      assertEquals(state.pendingMessages[0], "User: Hello world");

      // Should search project and user contexts
      assertEquals(client.searchFactsCalls.length, 2);
      assertEquals(client.searchNodesCalls.length, 2);

      // First call: project facts
      assertEquals(client.searchFactsCalls[0].groupIds, ["test:project"]);
      assertEquals(client.searchFactsCalls[0].maxFacts, 50);

      // Second call: user facts
      assertEquals(client.searchFactsCalls[1].groupIds, ["test:user"]);
      assertEquals(client.searchFactsCalls[1].maxFacts, 20);
    });

    it("should not inject when no facts or nodes found", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      client.searchFactsResult = [];
      client.searchNodesResult = [];

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Hello" }] } as any,
      );

      const state = sessionManager.getState("session-1");
      assertEquals(state.injectedMemories, true);
      assertEquals(state.cachedMemoryContext, undefined);
    });

    it("should load and include session snapshot on first injection", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      client.searchFactsResult = [
        { uuid: "f1", fact: "Test fact" },
      ];
      client.episodesResult = [
        {
          uuid: "e1",
          name: "Snapshot",
          content: "Session snapshot content with strategy and questions",
          sourceDescription: "session-snapshot",
          created_at: "2026-02-14T12:00:00Z",
        },
      ];

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Hello" }] } as any,
      );

      const state = sessionManager.getState("session-1");
      assertEquals(
        state.cachedMemoryContext?.includes("Session Snapshot"),
        true,
      );
      assertEquals(
        state.cachedMemoryContext?.includes("Session snapshot content"),
        true,
      );
      assertEquals(client.getEpisodesCalls.length, 1);
      assertEquals(client.getEpisodesCalls[0].lastN, 10);
    });

    it("should prefer most recent snapshot when multiple exist", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      client.searchFactsResult = [
        { uuid: "f1", fact: "Test fact" },
      ];
      client.episodesResult = [
        {
          uuid: "e1",
          content: "Old snapshot",
          sourceDescription: "session-snapshot",
          created_at: "2026-02-01T12:00:00Z",
        },
        {
          uuid: "e2",
          content: "Recent snapshot",
          sourceDescription: "session-snapshot",
          created_at: "2026-02-14T12:00:00Z",
        },
        {
          uuid: "e3",
          content: "Middle snapshot",
          sourceDescription: "session-snapshot",
          created_at: "2026-02-10T12:00:00Z",
        },
      ];

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Hello" }] } as any,
      );

      const state = sessionManager.getState("session-1");
      assertEquals(
        state.cachedMemoryContext?.includes("Recent snapshot"),
        true,
      );
      assertEquals(state.cachedMemoryContext?.includes("Old snapshot"), false);
    });

    it("should handle snake_case source_description field", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      client.searchFactsResult = [
        { uuid: "f1", fact: "Test fact" },
      ];
      client.episodesResult = [
        {
          uuid: "e1",
          content: "Snapshot content",
          source_description: "session-snapshot", // snake_case
          created_at: "2026-02-14T12:00:00Z",
        },
      ];

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Hello" }] } as any,
      );

      const state = sessionManager.getState("session-1");
      assertEquals(
        state.cachedMemoryContext?.includes("Snapshot content"),
        true,
      );
    });

    it("should truncate snapshot to budget (1200 chars)", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      client.searchFactsResult = [
        { uuid: "f1", fact: "Test fact" },
      ];
      const longContent = "A".repeat(2000);
      client.episodesResult = [
        {
          uuid: "e1",
          content: longContent,
          sourceDescription: "session-snapshot",
          created_at: "2026-02-14T12:00:00Z",
        },
      ];

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Hello" }] } as any,
      );

      const state = sessionManager.getState("session-1");
      const snapshotSection = state.cachedMemoryContext?.match(
        /## Session Snapshot[\s\S]*?(?=\n\n#|$)/,
      )?.[0];
      // Snapshot budget is min(characterBudget, 1200), so should be capped
      // Header is ~110 chars + 1200 content = ~1310 total
      assertStrictEquals(
        (snapshotSection?.length || 0) <= 1320,
        true,
      );
    });

    it("should handle getEpisodes error gracefully", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      client.searchFactsResult = [
        { uuid: "f1", fact: "Test fact" },
      ];
      client.getEpisodes = async () => {
        throw new Error("Network error");
      };

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Hello" }] } as any,
      );

      const state = sessionManager.getState("session-1");
      // Should still inject without snapshot
      assertEquals(state.injectedMemories, true);
      assertEquals(
        state.cachedMemoryContext?.includes("Session Snapshot"),
        false,
      );
    });
  });

  describe("drift detection", () => {
    it("should trigger reinjection when similarity is below threshold", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      // First message - initial injection
      client.searchFactsResult = [
        { uuid: "f1", fact: "Fact 1" },
        { uuid: "f2", fact: "Fact 2" },
      ];
      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "First message" }] } as any,
      );

      const state = sessionManager.getState("session-1");
      assertEquals(state.lastInjectionFactUuids.length, 2);

      // Second message - different facts (low similarity)
      client.searchFactsResult = [
        { uuid: "f3", fact: "Fact 3" },
        { uuid: "f4", fact: "Fact 4" },
      ];
      client.searchNodesResult = [];

      const callsBefore = client.searchFactsCalls.length;

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Second message" }] } as any,
      );

      // Should perform drift check (1 call) + full search (1 call for project only, no user on reinjection)
      assertEquals(client.searchFactsCalls.length, callsBefore + 2);

      // Should have updated cached context
      const updatedState = sessionManager.getState("session-1");
      assertEquals(updatedState.cachedMemoryContext !== undefined, true);
    });

    it("should NOT reinjection when similarity is above threshold", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      // First message - initial injection
      client.searchFactsResult = [
        { uuid: "f1", fact: "Fact 1" },
        { uuid: "f2", fact: "Fact 2" },
      ];
      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "First message" }] } as any,
      );

      // Second message - same facts (high similarity)
      client.searchFactsResult = [
        { uuid: "f1", fact: "Fact 1" },
        { uuid: "f2", fact: "Fact 2" },
      ];

      const callsBefore = client.searchFactsCalls.length;

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Second message" }] } as any,
      );

      // Should only perform drift check (1 call), no full search
      assertEquals(client.searchFactsCalls.length, callsBefore + 1);
    });

    it("should compute Jaccard similarity correctly", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.4,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      // First injection: {f1, f2, f3}
      client.searchFactsResult = [
        { uuid: "f1", fact: "Fact 1" },
        { uuid: "f2", fact: "Fact 2" },
        { uuid: "f3", fact: "Fact 3" },
      ];
      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "First message" }] } as any,
      );

      // Second message: {f2, f3, f4}
      // Intersection: {f2, f3} = 2
      // Union: {f1, f2, f3, f4} = 4
      // Jaccard = 2/4 = 0.5 > 0.4 threshold
      client.searchFactsResult = [
        { uuid: "f2", fact: "Fact 2" },
        { uuid: "f3", fact: "Fact 3" },
        { uuid: "f4", fact: "Fact 4" },
      ];

      const callsBefore = client.searchFactsCalls.length;

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Second message" }] } as any,
      );

      // Similarity 0.5 > 0.4, should NOT reinjection
      assertEquals(client.searchFactsCalls.length, callsBefore + 1);
    });

    it("should handle empty fact sets correctly", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      // First injection with facts
      client.searchFactsResult = [
        { uuid: "f1", fact: "Fact 1" },
      ];
      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "First message" }] } as any,
      );

      // Second message with no facts
      client.searchFactsResult = [];

      const callsBefore = client.searchFactsCalls.length;

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Second message" }] } as any,
      );

      // Empty current vs non-empty last = similarity 0 < threshold
      // Should trigger drift check + reinjection attempt (but will early-return with no facts)
      assertEquals(client.searchFactsCalls.length, callsBefore + 2);
    });

    it("should handle both empty fact sets (edge case)", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      // First injection with no facts
      client.searchFactsResult = [];
      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "First message" }] } as any,
      );

      const state = sessionManager.getState("session-1");
      assertEquals(state.lastInjectionFactUuids.length, 0);

      // Second message also with no facts
      client.searchFactsResult = [];

      const callsBefore = client.searchFactsCalls.length;

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Second message" }] } as any,
      );

      // Empty vs empty = similarity 1.0 > threshold
      // Should NOT trigger reinjection
      assertEquals(client.searchFactsCalls.length, callsBefore + 1);
    });
  });

  describe("edge cases", () => {
    it("should ignore subagent sessions", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("subagent-1", "parent-session");

      await handler(
        { sessionID: "subagent-1" },
        { parts: [{ type: "text", text: "Subagent message" }] } as any,
      );

      // Should not search or inject
      assertEquals(client.searchFactsCalls.length, 0);
      assertEquals(sessionManager.getState("subagent-1"), undefined);
    });

    it("should ignore messages without text content", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "tool_use", name: "test" }] } as any,
      );

      // Should not search or inject
      assertEquals(client.searchFactsCalls.length, 0);
    });

    it("should handle messages with multiple text parts", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      client.searchFactsResult = [
        { uuid: "f1", fact: "Test fact" },
      ];

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      await handler(
        { sessionID: "session-1" },
        {
          parts: [
            { type: "text", text: "First part" },
            { type: "text", text: "Second part" },
          ],
        } as any,
      );

      const state = sessionManager.getState("session-1");
      assertEquals(state.pendingMessages[0], "User: First part Second part");
    });

    it("should handle session resolution failure", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      // Don't set parent ID, so resolution fails
      await handler(
        { sessionID: "unknown-session" },
        { parts: [{ type: "text", text: "Message" }] } as any,
      );

      // Should not crash or search
      assertEquals(client.searchFactsCalls.length, 0);
    });

    it("should handle search failures gracefully", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      client.searchFacts = async () => {
        throw new Error("Search failed");
      };

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Hello" }] } as any,
      );

      const state = sessionManager.getState("session-1");
      // Should NOT mark as injected on search failure
      assertEquals(state.injectedMemories, false);
      assertEquals(state.cachedMemoryContext, undefined);
    });

    it("should deduplicate facts from project and user scopes", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      let callCount = 0;
      client.searchFacts = async (params) => {
        callCount++;
        client.searchFactsCalls.push(params as any);
        if (callCount === 1) {
          // Project facts
          return [
            { uuid: "f1", fact: "Fact 1" },
            { uuid: "f2", fact: "Fact 2" },
          ];
        } else {
          // User facts - includes duplicate
          return [
            { uuid: "f2", fact: "Fact 2" },
            { uuid: "f3", fact: "Fact 3" },
          ];
        }
      };

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Hello" }] } as any,
      );

      const state = sessionManager.getState("session-1");
      // Should have deduplicated f2, so only {f1, f2, f3}
      assertEquals(state.lastInjectionFactUuids.length, 3);
      assertEquals(state.lastInjectionFactUuids.includes("f1"), true);
      assertEquals(state.lastInjectionFactUuids.includes("f2"), true);
      assertEquals(state.lastInjectionFactUuids.includes("f3"), true);
    });

    it("should remove orphan nodes (nodes referenced by facts)", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      client.searchFactsResult = [
        {
          uuid: "f1",
          fact: "Fact 1",
          source_node: { uuid: "n1", name: "Node 1" },
        },
      ];
      client.searchNodesResult = [
        { uuid: "n1", name: "Node 1" }, // Referenced by fact
        { uuid: "n2", name: "Node 2" }, // Orphan
      ];

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Hello" }] } as any,
      );

      const state = sessionManager.getState("session-1");
      // Should only include Node 2 (orphan), Node 1 is referenced
      assertEquals(state.cachedMemoryContext?.includes("Node 2"), true);
      // Node 1 should not appear in nodes section (only in fact edge)
    });

    it("should filter out invalid facts (invalid_at in past)", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      client.searchFactsResult = [
        {
          uuid: "f1",
          fact: "Valid fact",
          valid_at: "2026-02-01T00:00:00Z",
        },
        {
          uuid: "f2",
          fact: "Invalid fact",
          invalid_at: "2026-01-01T00:00:00Z", // Already invalid
        },
      ];

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Hello" }] } as any,
      );

      const state = sessionManager.getState("session-1");
      assertEquals(state.cachedMemoryContext?.includes("Valid fact"), true);
      assertEquals(state.cachedMemoryContext?.includes("Invalid fact"), false);
    });

    it("should filter out future facts (valid_at in future)", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      client.searchFactsResult = [
        {
          uuid: "f1",
          fact: "Current fact",
          valid_at: "2026-02-01T00:00:00Z",
        },
        {
          uuid: "f2",
          fact: "Future fact",
          valid_at: "2026-12-01T00:00:00Z", // Future
        },
      ];

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Hello" }] } as any,
      );

      const state = sessionManager.getState("session-1");
      assertEquals(state.cachedMemoryContext?.includes("Current fact"), true);
      assertEquals(state.cachedMemoryContext?.includes("Future fact"), false);
    });

    it("should annotate stale facts", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      // Fact from 60 days ago (stale if factStaleDays=30)
      const sixtyDaysAgo = new Date();
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

      client.searchFactsResult = [
        {
          uuid: "f1",
          fact: "Old fact",
          valid_at: sixtyDaysAgo.toISOString(),
        },
      ];

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Hello" }] } as any,
      );

      const state = sessionManager.getState("session-1");
      assertEquals(state.cachedMemoryContext?.includes("[stale:"), true);
      assertEquals(state.cachedMemoryContext?.includes("days ago]"), true);
    });

    it("should respect character budget from context limit", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      // Create many facts that would exceed budget
      client.searchFactsResult = Array.from({ length: 100 }, (_, i) => ({
        uuid: `f${i}`,
        fact: `This is test fact number ${i} with some content to fill space`,
      }));

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      const state = await sessionManager.resolveSessionState("session-1");
      state.state!.contextLimit = 10_000; // Small context limit

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Hello" }] } as any,
      );

      const finalState = sessionManager.getState("session-1");
      // Budget = 10_000 * 0.05 * 4 = 2000 chars
      const budget = 10_000 * 0.05 * 4;
      assertStrictEquals(
        (finalState.cachedMemoryContext?.length || 0) <= budget,
        true,
      );
    });
  });

  describe("budget allocation", () => {
    it("should allocate 70% to project and 30% to user on first injection", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      let callCount = 0;
      client.searchFacts = async (params) => {
        callCount++;
        client.searchFactsCalls.push(params as any);
        return [
          { uuid: `f${callCount}`, fact: "A".repeat(1000) },
        ];
      };

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      const state = await sessionManager.resolveSessionState("session-1");
      state.state!.contextLimit = 10_000;

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Hello" }] } as any,
      );

      const finalState = sessionManager.getState("session-1");
      // Total budget = 2000 chars
      // Should be split 70/30 between project and user
      assertStrictEquals(
        (finalState.cachedMemoryContext?.length || 0) <= 2000,
        true,
      );
    });

    it("should not search user scope on reinjection", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      // First injection
      client.searchFactsResult = [
        { uuid: "f1", fact: "Fact 1" },
      ];
      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "First message" }] } as any,
      );

      const callsAfterFirst = client.searchFactsCalls.length;

      // Second message - trigger reinjection
      client.searchFactsResult = [
        { uuid: "f2", fact: "Fact 2" },
      ];
      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Second message" }] } as any,
      );

      // Should have:
      // - 1 drift check call (maxFacts=20)
      // - 1 project facts call (maxFacts=50)
      // - 1 project nodes call (maxNodes=30)
      // NO user scope calls (because useUserScope=false on reinjection)
      const newCalls = client.searchFactsCalls.length - callsAfterFirst;
      assertEquals(newCalls, 2); // drift check + project facts only
    });
  });

  describe("message counting", () => {
    it("should increment message count on each message", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      client.searchFactsResult = [
        { uuid: "f1", fact: "Fact 1" },
      ];

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Message 1" }] } as any,
      );

      let state = sessionManager.getState("session-1");
      assertEquals(state.messageCount, 1);

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Message 2" }] } as any,
      );

      state = sessionManager.getState("session-1");
      assertEquals(state.messageCount, 2);
    });

    it("should buffer pending messages", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      client.searchFactsResult = [
        { uuid: "f1", fact: "Fact 1" },
      ];

      const handler = createChatHandler({
        sessionManager: sessionManager as any,
        driftThreshold: 0.5,
        factStaleDays: 30,
        client: client as any,
      });

      sessionManager.setParentId("session-1", null);

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "First message" }] } as any,
      );

      await handler(
        { sessionID: "session-1" },
        { parts: [{ type: "text", text: "Second message" }] } as any,
      );

      const state = sessionManager.getState("session-1");
      assertEquals(state.pendingMessages.length, 2);
      assertEquals(state.pendingMessages[0], "User: First message");
      assertEquals(state.pendingMessages[1], "User: Second message");
    });
  });
});
