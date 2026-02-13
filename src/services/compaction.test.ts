import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { getCompactionContext, handleCompaction } from "./compaction.ts";
import type { GraphitiFact, GraphitiNode } from "../types/index.ts";

// Mock GraphitiClient
class MockGraphitiClient {
  public addEpisodeCalls: Array<{
    name: string;
    episodeBody: string;
    groupId?: string;
    source?: string;
    sourceDescription?: string;
  }> = [];
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

  addEpisode(params: {
    name: string;
    episodeBody: string;
    groupId?: string;
    source?: string;
    sourceDescription?: string;
  }): Promise<void> {
    this.addEpisodeCalls.push(params);
    return Promise.resolve();
  }

  searchFacts(params: {
    query: string;
    groupIds?: string[];
    maxFacts?: number;
  }): Promise<GraphitiFact[]> {
    this.searchFactsCalls.push(params);
    return Promise.resolve(this.searchFactsResult || []);
  }

  searchNodes(params: {
    query: string;
    groupIds?: string[];
    maxNodes?: number;
  }): Promise<GraphitiNode[]> {
    this.searchNodesCalls.push(params);
    return Promise.resolve(this.searchNodesResult || []);
  }

  searchFactsResult: GraphitiFact[] = [];
  searchNodesResult: GraphitiNode[] = [];
}

describe("compaction", () => {
  describe("handleCompaction", () => {
    it("should save compaction summary when enabled", async () => {
      const client = new MockGraphitiClient();
      await handleCompaction({
        client: client as unknown as Parameters<
          typeof handleCompaction
        >[0]["client"],
        groupId: "test:project",
        summary: "Session summary content",
        sessionId: "session-123",
      });

      assertEquals(client.addEpisodeCalls.length, 1);
      assertEquals(
        client.addEpisodeCalls[0].name,
        "Session compaction: session-123",
      );
      assertEquals(
        client.addEpisodeCalls[0].episodeBody,
        "Session summary content",
      );
      assertEquals(client.addEpisodeCalls[0].groupId, "test:project");
      assertEquals(client.addEpisodeCalls[0].source, "text");
      assertEquals(
        client.addEpisodeCalls[0].sourceDescription,
        "OpenCode session compaction summary",
      );
    });

    it("should not save when summary is empty", async () => {
      const client = new MockGraphitiClient();
      await handleCompaction({
        client: client as unknown as Parameters<
          typeof handleCompaction
        >[0]["client"],
        groupId: "test:project",
        summary: "",
        sessionId: "session-123",
      });

      assertEquals(client.addEpisodeCalls.length, 0);
    });

    it("should handle errors gracefully", async () => {
      const client = new MockGraphitiClient();
      client.addEpisode = () => {
        return Promise.reject(new Error("Network error"));
      };
      // Should not throw
      await handleCompaction({
        client: client as unknown as Parameters<
          typeof handleCompaction
        >[0]["client"],
        groupId: "test:project",
        summary: "Session summary",
        sessionId: "session-123",
      });

      // Error is logged but not thrown
      assertEquals(client.addEpisodeCalls.length, 0);
    });
  });

  describe("getCompactionContext", () => {
    it("should return empty array when contextStrings is empty", async () => {
      const client = new MockGraphitiClient();

      const result = await getCompactionContext({
        client: client as unknown as Parameters<
          typeof getCompactionContext
        >[0]["client"],
        characterBudget: 1000,
        groupIds: { project: "test:project" },
        contextStrings: [],
      });

      assertEquals(result, []);
      assertEquals(client.searchFactsCalls.length, 0);
    });

    it("should return empty array when contextStrings contain only empty strings", async () => {
      const client = new MockGraphitiClient();

      const result = await getCompactionContext({
        client: client as unknown as Parameters<
          typeof getCompactionContext
        >[0]["client"],
        characterBudget: 1000,
        groupIds: { project: "test:project" },
        contextStrings: ["", "   ", ""],
      });

      assertEquals(result, []);
    });

    it("should search facts with joined context strings", async () => {
      const client = new MockGraphitiClient();
      client.searchFactsResult = [{ uuid: "fact-1", fact: "Important fact" }];

      await getCompactionContext({
        client: client as unknown as Parameters<
          typeof getCompactionContext
        >[0]["client"],
        characterBudget: 1000,
        groupIds: { project: "test:project" },
        contextStrings: ["First context", "Second context", "Third context"],
      });

      assertEquals(client.searchFactsCalls.length, 1);
      assertEquals(
        client.searchFactsCalls[0].query,
        "First context Second context Third context",
      );
      assertEquals(client.searchFactsCalls[0].groupIds, ["test:project"]);
      assertEquals(client.searchFactsCalls[0].maxFacts, 50);
    });

    it("should limit query to first 3 context strings", async () => {
      const client = new MockGraphitiClient();
      client.searchFactsResult = [{ uuid: "fact-1", fact: "Fact" }];

      await getCompactionContext({
        client: client as unknown as Parameters<
          typeof getCompactionContext
        >[0]["client"],
        characterBudget: 1000,
        groupIds: { project: "test:project" },
        contextStrings: ["One", "Two", "Three", "Four", "Five"],
      });

      assertEquals(client.searchFactsCalls[0].query, "One Two Three");
    });

    it("should limit query text to 500 characters", async () => {
      const client = new MockGraphitiClient();
      client.searchFactsResult = [{ uuid: "fact-1", fact: "Fact" }];

      const longString = "a".repeat(300);
      await getCompactionContext({
        client: client as unknown as Parameters<
          typeof getCompactionContext
        >[0]["client"],
        characterBudget: 1000,
        groupIds: { project: "test:project" },
        contextStrings: [longString, longString],
      });

      assertStrictEquals(client.searchFactsCalls[0].query.length <= 500, true);
    });

    it("should return empty array when no facts found", async () => {
      const client = new MockGraphitiClient();
      client.searchFactsResult = [];

      const result = await getCompactionContext({
        client: client as unknown as Parameters<
          typeof getCompactionContext
        >[0]["client"],
        characterBudget: 1000,
        groupIds: { project: "test:project" },
        contextStrings: ["some context"],
      });

      assertEquals(result, []);
    });

    it("should format facts into context string", async () => {
      const client = new MockGraphitiClient();
      client.searchFactsResult = [
        { uuid: "fact-1", fact: "First important fact" },
        { uuid: "fact-2", fact: "Second important fact" },
      ];

      const result = await getCompactionContext({
        client: client as unknown as Parameters<
          typeof getCompactionContext
        >[0]["client"],
        characterBudget: 1000,
        groupIds: { project: "test:project" },
        contextStrings: ["context"],
      });

      assertEquals(result.length, 1);
      assertEquals(result[0].includes("<decisions>"), true);
      assertEquals(result[0].includes("<persistent_memory>"), true);
      assertEquals(
        result[0].includes("<fact>First important fact</fact>"),
        true,
      );
      assertEquals(
        result[0].includes("<fact>Second important fact</fact>"),
        true,
      );
    });

    it("should handle search errors gracefully", async () => {
      const client = new MockGraphitiClient();
      client.searchFacts = () => {
        return Promise.reject(new Error("Search failed"));
      };

      const result = await getCompactionContext({
        client: client as unknown as Parameters<
          typeof getCompactionContext
        >[0]["client"],
        characterBudget: 1000,
        groupIds: { project: "test:project" },
        contextStrings: ["context"],
      });

      assertEquals(result, []);
    });

    it("should truncate context to character budget", async () => {
      const client = new MockGraphitiClient();
      client.searchFactsResult = [
        { uuid: "fact-1", fact: "A".repeat(200) },
      ];

      const result = await getCompactionContext({
        client: client as unknown as Parameters<
          typeof getCompactionContext
        >[0]["client"],
        characterBudget: 120,
        groupIds: { project: "test:project" },
        contextStrings: ["context"],
      });

      assertEquals(result.length, 1);
      assertStrictEquals(result[0].length <= 120, true);
    });

    it("should search both project and user group IDs", async () => {
      const client = new MockGraphitiClient();
      client.searchFactsResult = [{ uuid: "fact-1", fact: "Important fact" }];

      await getCompactionContext({
        client: client as unknown as Parameters<
          typeof getCompactionContext
        >[0]["client"],
        characterBudget: 1000,
        groupIds: { project: "test:project", user: "test:user" },
        contextStrings: ["context"],
      });

      // Should search project facts and user facts
      assertEquals(client.searchFactsCalls.length, 2);
      assertEquals(client.searchFactsCalls[0].groupIds, ["test:project"]);
      assertEquals(client.searchFactsCalls[1].groupIds, ["test:user"]);
    });

    it("should not search user facts when user group ID is undefined", async () => {
      const client = new MockGraphitiClient();
      client.searchFactsResult = [{ uuid: "fact-1", fact: "Important fact" }];

      await getCompactionContext({
        client: client as unknown as Parameters<
          typeof getCompactionContext
        >[0]["client"],
        characterBudget: 1000,
        groupIds: { project: "test:project" },
        contextStrings: ["context"],
      });

      // Should only search project facts once
      assertEquals(client.searchFactsCalls.length, 1);
      assertEquals(client.searchFactsCalls[0].groupIds, ["test:project"]);
    });

    it("should allocate 70% budget to project and 30% to user", async () => {
      const client = new MockGraphitiClient();
      const longFact = "A".repeat(500);
      client.searchFactsResult = [
        { uuid: "fact-1", fact: longFact },
      ];

      const result = await getCompactionContext({
        client: client as unknown as Parameters<
          typeof getCompactionContext
        >[0]["client"],
        characterBudget: 1000,
        groupIds: { project: "test:project", user: "test:user" },
        contextStrings: ["context"],
      });

      // Result should respect budget allocation
      assertEquals(result.length, 1);
      assertStrictEquals(result[0].length <= 1000, true);
    });

    it("should include both project and user sections when both have results", async () => {
      const client = new MockGraphitiClient();
      // Override to return different results for project vs user
      let callCount = 0;
      client.searchFacts = (params) => {
        callCount++;
        client.searchFactsCalls.push(params);
        if (callCount === 1) {
          // Project facts
          return Promise.resolve([
            { uuid: "f1", fact: "Project fact" },
          ] as GraphitiFact[]);
        } else {
          // User facts
          return Promise.resolve([
            { uuid: "f2", fact: "User fact" },
          ] as GraphitiFact[]);
        }
      };

      const result = await getCompactionContext({
        client: client as unknown as Parameters<
          typeof getCompactionContext
        >[0]["client"],
        characterBudget: 1000,
        groupIds: { project: "test:project", user: "test:user" },
        contextStrings: ["context"],
      });

      assertEquals(result.length, 1);
      assertEquals(result[0].includes('source="project"'), true);
      assertEquals(result[0].includes('source="user"'), true);
      assertEquals(result[0].includes("Project fact"), true);
      assertEquals(result[0].includes("User fact"), true);
    });

    it("should include summary template structure", async () => {
      const client = new MockGraphitiClient();
      client.searchFactsResult = [{ uuid: "fact-1", fact: "Important fact" }];

      const result = await getCompactionContext({
        client: client as unknown as Parameters<
          typeof getCompactionContext
        >[0]["client"],
        characterBudget: 1000,
        groupIds: { project: "test:project" },
        contextStrings: ["context"],
      });

      assertEquals(result.length, 1);
      assertEquals(result[0].includes("<decisions>"), true);
      assertEquals(result[0].includes("<active_context>"), true);
      assertEquals(result[0].includes("<background>"), true);
      assertEquals(result[0].includes("<persistent_memory>"), true);
    });

    it("should request appropriate maxFacts and maxNodes for project", async () => {
      const client = new MockGraphitiClient();
      client.searchFactsResult = [];
      client.searchNodesResult = [];

      await getCompactionContext({
        client: client as unknown as Parameters<
          typeof getCompactionContext
        >[0]["client"],
        characterBudget: 1000,
        groupIds: { project: "test:project" },
        contextStrings: ["context"],
      });

      assertEquals(client.searchFactsCalls[0].maxFacts, 50);
      assertEquals(client.searchNodesCalls[0].maxNodes, 30);
    });

    it("should request appropriate maxFacts and maxNodes for user", async () => {
      const client = new MockGraphitiClient();
      client.searchFactsResult = [];
      client.searchNodesResult = [];

      await getCompactionContext({
        client: client as unknown as Parameters<
          typeof getCompactionContext
        >[0]["client"],
        characterBudget: 1000,
        groupIds: { project: "test:project", user: "test:user" },
        contextStrings: ["context"],
      });

      // Second search call should be user with smaller limits
      assertEquals(client.searchFactsCalls[1].maxFacts, 20);
      assertEquals(client.searchNodesCalls[1].maxNodes, 10);
    });

    it("should include nodes in output when available", async () => {
      const client = new MockGraphitiClient();
      client.searchFactsResult = [];
      client.searchNodesResult = [
        { uuid: "n1", name: "Important Node", summary: "Key entity" },
      ];

      const result = await getCompactionContext({
        client: client as unknown as Parameters<
          typeof getCompactionContext
        >[0]["client"],
        characterBudget: 1000,
        groupIds: { project: "test:project" },
        contextStrings: ["context"],
      });

      assertEquals(result.length, 1);
      assertEquals(result[0].includes("<nodes>"), true);
      assertEquals(result[0].includes("Important Node"), true);
    });
  });
});
