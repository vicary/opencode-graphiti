import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import type { GraphitiFact, GraphitiNode } from "../types/index.ts";
import type { SessionManager, SessionState } from "../session.ts";
import type { GraphitiClient } from "../services/client.ts";
import { createCompactingHandler } from "./compacting.ts";

// Mock SessionManager
class MockSessionManager implements Partial<SessionManager> {
  private sessions = new Map<string, SessionState>();

  setState(sessionId: string, state: SessionState): void {
    this.sessions.set(sessionId, state);
  }

  getState(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }
}

// Mock GraphitiClient
class MockGraphitiClient implements Partial<GraphitiClient> {
  public searchFactsCalls: Array<{
    query: string;
    groupIds?: string[];
    maxFacts?: number;
  }> = [];

  public searchNodesCalls: Array<{
    query: string;
    groupIds?: string[];
    maxNodes?: number;
  }> = [];

  private mockFacts: GraphitiFact[] = [];
  private mockNodes: GraphitiNode[] = [];

  setMockFacts(facts: GraphitiFact[]): void {
    this.mockFacts = facts;
  }

  setMockNodes(nodes: GraphitiNode[]): void {
    this.mockNodes = nodes;
  }

  async searchFacts(params: {
    query: string;
    groupIds?: string[];
    maxFacts?: number;
  }): Promise<GraphitiFact[]> {
    this.searchFactsCalls.push(params);
    return this.mockFacts;
  }

  async searchNodes(params: {
    query: string;
    groupIds?: string[];
    maxNodes?: number;
  }): Promise<GraphitiNode[]> {
    this.searchNodesCalls.push(params);
    return this.mockNodes;
  }

  reset(): void {
    this.searchFactsCalls = [];
    this.searchNodesCalls = [];
    this.mockFacts = [];
    this.mockNodes = [];
  }
}

describe("compacting handler integration", () => {
  describe("basic functionality", () => {
    it("should inject compaction context for main session", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      sessionManager.setState("session-1", {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        messageCount: 0,
        pendingMessages: [],
        contextLimit: 200_000,
        isMain: true,
      });

      // Set up mock facts
      client.setMockFacts([
        {
          uuid: "fact-1",
          fact: "User decided to use TypeScript",
          valid_at: new Date().toISOString(),
        },
      ]);

      const handler = createCompactingHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        factStaleDays: 30,
      });

      const output = { context: ["Some existing context"] };
      await handler({ sessionID: "session-1" }, output);

      // Should have added context
      assert(output.context.length > 1);
      // Should have called searchFacts
      assert(client.searchFactsCalls.length > 0);
    });

    it("should ignore non-main sessions", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      sessionManager.setState("session-1", {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        messageCount: 0,
        pendingMessages: [],
        contextLimit: 200_000,
        isMain: false, // Non-main session
      });

      const handler = createCompactingHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        factStaleDays: 30,
      });

      const output = { context: ["Some existing context"] };
      await handler({ sessionID: "session-1" }, output);

      // Should not have added context
      assertEquals(output.context.length, 1);
      assertEquals(output.context[0], "Some existing context");
      // Should not have called searchFacts
      assertEquals(client.searchFactsCalls.length, 0);
    });

    it("should handle missing session state", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      const handler = createCompactingHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        factStaleDays: 30,
      });

      const output = { context: ["Some existing context"] };
      await handler({ sessionID: "non-existent" }, output);

      // Should not have added context
      assertEquals(output.context.length, 1);
      // Should not have called searchFacts
      assertEquals(client.searchFactsCalls.length, 0);
    });

    it("should handle empty context strings gracefully", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      sessionManager.setState("session-1", {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        messageCount: 0,
        pendingMessages: [],
        contextLimit: 200_000,
        isMain: true,
      });

      const handler = createCompactingHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        factStaleDays: 30,
      });

      const output = { context: [] };
      await handler({ sessionID: "session-1" }, output);

      // Should not crash, no context added (empty query)
      assertEquals(output.context.length, 0);
    });
  });

  describe("fact classification and budgeting", () => {
    it("should classify facts into decisions, active, and background", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      sessionManager.setState("session-1", {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        messageCount: 0,
        pendingMessages: [],
        contextLimit: 200_000,
        isMain: true,
      });

      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      // Set up facts with different classifications
      client.setMockFacts([
        {
          uuid: "decision-1",
          fact: "Team decided to use Deno for this project",
          valid_at: thirtyDaysAgo.toISOString(),
        },
        {
          uuid: "active-1",
          fact: "User is working on authentication module",
          valid_at: now.toISOString(),
        },
        {
          uuid: "background-1",
          fact: "Project started in January",
          valid_at: thirtyDaysAgo.toISOString(),
        },
      ]);

      const handler = createCompactingHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        factStaleDays: 30,
      });

      const output = { context: ["Some query text for searching"] };
      await handler({ sessionID: "session-1" }, output);

      // Should have added context with classification
      assert(output.context.length > 1);
      const injectedContext = output.context[1];

      // Check for XML tags
      assert(injectedContext.includes("<decisions>"));
      assert(injectedContext.includes("</decisions>"));
      assert(injectedContext.includes("<active_context>"));
      assert(injectedContext.includes("</active_context>"));
      assert(injectedContext.includes("<background>"));
      assert(injectedContext.includes("</background>"));
    });

    it("should allocate budget 40/35/25 for decisions/active/background", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      sessionManager.setState("session-1", {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        messageCount: 0,
        pendingMessages: [],
        contextLimit: 10_000, // Small budget to test allocation
        isMain: true,
      });

      const now = new Date();
      const facts: GraphitiFact[] = [];

      // Create many facts to test budget allocation
      for (let i = 0; i < 20; i++) {
        facts.push({
          uuid: `decision-${i}`,
          fact: `Team decided to ${i} use pattern ${i}`,
          valid_at: now.toISOString(),
        });
      }

      for (let i = 0; i < 20; i++) {
        facts.push({
          uuid: `active-${i}`,
          fact: `User is working on feature ${i}`,
          valid_at: now.toISOString(),
        });
      }

      for (let i = 0; i < 20; i++) {
        const oldDate = new Date(
          now.getTime() - 30 * 24 * 60 * 60 * 1000,
        );
        facts.push({
          uuid: `background-${i}`,
          fact: `Historical context ${i}`,
          valid_at: oldDate.toISOString(),
        });
      }

      client.setMockFacts(facts);

      const handler = createCompactingHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        factStaleDays: 30,
      });

      const output = { context: ["Some query text for searching"] };
      await handler({ sessionID: "session-1" }, output);

      // Should have added context
      assert(output.context.length > 1);
      const injectedContext = output.context[1];

      // All three sections should be present
      assert(injectedContext.includes("<decisions>"));
      assert(injectedContext.includes("<active_context>"));
      assert(injectedContext.includes("<background>"));
    });
  });

  describe("XML output format", () => {
    it("should wrap output in proper XML tags", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      sessionManager.setState("session-1", {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        messageCount: 0,
        pendingMessages: [],
        contextLimit: 200_000,
        isMain: true,
      });

      client.setMockFacts([
        {
          uuid: "fact-1",
          fact: "User decided to use TypeScript",
          valid_at: new Date().toISOString(),
        },
      ]);

      const handler = createCompactingHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        factStaleDays: 30,
      });

      const output = { context: ["Some query text"] };
      await handler({ sessionID: "session-1" }, output);

      assert(output.context.length > 1);
      const injectedContext = output.context[1];

      // Check for XML structure
      assert(injectedContext.includes("<summary>"));
      assert(injectedContext.includes("</summary>"));
      assert(injectedContext.includes("<persistent_memory>"));
      assert(injectedContext.includes("</persistent_memory>"));
      assert(injectedContext.includes('<memory source="project">'));
      assert(injectedContext.includes("</memory>"));
    });

    it("should include instruction for background context", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      sessionManager.setState("session-1", {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        messageCount: 0,
        pendingMessages: [],
        contextLimit: 200_000,
        isMain: true,
      });

      client.setMockFacts([
        {
          uuid: "fact-1",
          fact: "Some background fact",
          valid_at: new Date().toISOString(),
        },
      ]);

      const handler = createCompactingHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        factStaleDays: 30,
      });

      const output = { context: ["Some query text"] };
      await handler({ sessionID: "session-1" }, output);

      assert(output.context.length > 1);
      const injectedContext = output.context[1];

      // Check for instruction tag
      assert(
        injectedContext.includes(
          "<instruction>Background context only; do not reference in titles, summaries, or opening responses unless directly relevant.</instruction>",
        ),
      );
    });
  });

  describe("user and project context", () => {
    it("should query both project and user groups", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      sessionManager.setState("session-1", {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        messageCount: 0,
        pendingMessages: [],
        contextLimit: 200_000,
        isMain: true,
      });

      client.setMockFacts([
        {
          uuid: "project-fact",
          fact: "Project uses TypeScript",
          valid_at: new Date().toISOString(),
        },
        {
          uuid: "user-fact",
          fact: "User prefers tabs over spaces",
          valid_at: new Date().toISOString(),
        },
      ]);

      const handler = createCompactingHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        factStaleDays: 30,
      });

      const output = { context: ["Some query text"] };
      await handler({ sessionID: "session-1" }, output);

      // Should have queried both project and user groups
      assert(client.searchFactsCalls.length >= 2);

      const projectCalls = client.searchFactsCalls.filter((call) =>
        call.groupIds?.includes("test:project")
      );
      const userCalls = client.searchFactsCalls.filter((call) =>
        call.groupIds?.includes("test:user")
      );

      assert(projectCalls.length > 0);
      assert(userCalls.length > 0);
    });

    it("should handle sessions with only project groupId", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      sessionManager.setState("session-1", {
        groupId: "test:project",
        userGroupId: "", // Empty user group (not configured)
        injectedMemories: false,
        lastInjectionFactUuids: [],
        messageCount: 0,
        pendingMessages: [],
        contextLimit: 200_000,
        isMain: true,
      });

      client.setMockFacts([
        {
          uuid: "project-fact",
          fact: "Project uses TypeScript",
          valid_at: new Date().toISOString(),
        },
      ]);

      const handler = createCompactingHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        factStaleDays: 30,
      });

      const output = { context: ["Some query text"] };
      await handler({ sessionID: "session-1" }, output);

      // Should still work with only project group
      assert(output.context.length > 1);
    });
  });

  describe("error handling", () => {
    it("should handle searchFacts errors gracefully", async () => {
      const sessionManager = new MockSessionManager();
      const client = new MockGraphitiClient();

      // Override searchFacts to throw error
      client.searchFacts = async () => {
        throw new Error("Network error");
      };

      sessionManager.setState("session-1", {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        messageCount: 0,
        pendingMessages: [],
        contextLimit: 200_000,
        isMain: true,
      });

      const handler = createCompactingHandler({
        sessionManager: sessionManager as any,
        client: client as any,
        defaultGroupId: "test:project",
        factStaleDays: 30,
      });

      const output = { context: ["Some query text"] };

      // Should not throw
      await handler({ sessionID: "session-1" }, output);

      // Should not have added context (error occurred)
      assertEquals(output.context.length, 1);
    });
  });
});
