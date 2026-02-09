import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { getCompactionContext, handleCompaction } from "./compaction.ts";
import type { GraphitiConfig, GraphitiFact } from "../types/index.ts";

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

  searchFactsResult: GraphitiFact[] = [];
}

const defaultConfig: GraphitiConfig = {
  endpoint: "http://test.com/mcp",
  groupIdPrefix: "test",
  maxFacts: 10,
  maxNodes: 5,
  maxEpisodes: 5,
  injectOnFirstMessage: true,
  enableCompactionSave: true,
};

describe("compaction", () => {
  describe("handleCompaction", () => {
    it("should save compaction summary when enabled", async () => {
      const client = new MockGraphitiClient();
      const config = { ...defaultConfig, enableCompactionSave: true };

      await handleCompaction({
        client: client as unknown as Parameters<
          typeof handleCompaction
        >[0]["client"],
        config,
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

    it("should not save when enableCompactionSave is false", async () => {
      const client = new MockGraphitiClient();
      const config = { ...defaultConfig, enableCompactionSave: false };

      await handleCompaction({
        client: client as unknown as Parameters<
          typeof handleCompaction
        >[0]["client"],
        config,
        groupId: "test:project",
        summary: "Session summary content",
        sessionId: "session-123",
      });

      assertEquals(client.addEpisodeCalls.length, 0);
    });

    it("should not save when summary is empty", async () => {
      const client = new MockGraphitiClient();
      const config = { ...defaultConfig, enableCompactionSave: true };

      await handleCompaction({
        client: client as unknown as Parameters<
          typeof handleCompaction
        >[0]["client"],
        config,
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
      const config = { ...defaultConfig, enableCompactionSave: true };

      // Should not throw
      await handleCompaction({
        client: client as unknown as Parameters<
          typeof handleCompaction
        >[0]["client"],
        config,
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
        config: defaultConfig,
        groupId: "test:project",
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
        config: defaultConfig,
        groupId: "test:project",
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
        config: defaultConfig,
        groupId: "test:project",
        contextStrings: ["First context", "Second context", "Third context"],
      });

      assertEquals(client.searchFactsCalls.length, 1);
      assertEquals(
        client.searchFactsCalls[0].query,
        "First context Second context Third context",
      );
      assertEquals(client.searchFactsCalls[0].groupIds, ["test:project"]);
      assertEquals(client.searchFactsCalls[0].maxFacts, 10);
    });

    it("should limit query to first 3 context strings", async () => {
      const client = new MockGraphitiClient();
      client.searchFactsResult = [{ uuid: "fact-1", fact: "Fact" }];

      await getCompactionContext({
        client: client as unknown as Parameters<
          typeof getCompactionContext
        >[0]["client"],
        config: defaultConfig,
        groupId: "test:project",
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
        config: defaultConfig,
        groupId: "test:project",
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
        config: defaultConfig,
        groupId: "test:project",
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
        config: defaultConfig,
        groupId: "test:project",
        contextStrings: ["context"],
      });

      assertEquals(result.length, 1);
      assertEquals(result[0].includes("## Persistent Knowledge"), true);
      assertEquals(result[0].includes("- First important fact"), true);
      assertEquals(result[0].includes("- Second important fact"), true);
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
        config: defaultConfig,
        groupId: "test:project",
        contextStrings: ["context"],
      });

      assertEquals(result, []);
    });

    it("should use maxFacts from config", async () => {
      const client = new MockGraphitiClient();
      client.searchFactsResult = [{ uuid: "fact-1", fact: "Fact" }];

      const config = { ...defaultConfig, maxFacts: 25 };

      await getCompactionContext({
        client: client as unknown as Parameters<
          typeof getCompactionContext
        >[0]["client"],
        config,
        groupId: "test:project",
        contextStrings: ["context"],
      });

      assertEquals(client.searchFactsCalls[0].maxFacts, 25);
    });
  });
});
