import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { formatMemoryContext } from "./context.ts";
import type { GraphitiFact, GraphitiNode } from "../types/index.ts";

describe("context", () => {
  describe("formatMemoryContext", () => {
    it("should return empty string when no facts or nodes provided", () => {
      const result = formatMemoryContext([], []);
      assertStrictEquals(result, "");
    });

    it("should format facts only", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "fact-1",
          fact: "The API endpoint is at /api/v1",
          source_node: { name: "API", uuid: "node-1" },
          target_node: { name: "Endpoint", uuid: "node-2" },
        },
      ];
      const result = formatMemoryContext(facts, []);

      assertEquals(result.includes("<memory>"), true);
      assertEquals(result.includes("<facts>"), true);
      assertEquals(
        result.includes(
          "<fact>The API endpoint is at /api/v1 [API -> Endpoint]</fact>",
        ),
        true,
      );
    });

    it("should format nodes only", () => {
      const nodes: GraphitiNode[] = [
        {
          uuid: "node-1",
          name: "Deno",
          summary: "A modern JavaScript runtime",
          labels: ["runtime", "javascript"],
        },
      ];
      const result = formatMemoryContext([], nodes);

      assertEquals(result.includes("<memory>"), true);
      assertEquals(result.includes("<nodes>"), true);
      assertEquals(
        result.includes(
          "<node>Deno (runtime, javascript): A modern JavaScript runtime</node>",
        ),
        true,
      );
    });

    it("should format both facts and nodes", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "fact-1",
          fact: "Uses TypeScript",
          source_node: { name: "Project", uuid: "node-1" },
        },
      ];
      const nodes: GraphitiNode[] = [
        {
          uuid: "node-2",
          name: "TypeScript",
          summary: "Typed JavaScript",
          labels: ["language"],
        },
      ];
      const result = formatMemoryContext(facts, nodes);

      assertEquals(result.includes("<facts>"), true);
      assertEquals(result.includes("<nodes>"), true);
      assertEquals(result.includes("Uses TypeScript"), true);
      assertEquals(
        result.includes("<node>TypeScript (language): Typed JavaScript</node>"),
        true,
      );
    });

    it("should handle facts without source or target nodes", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "fact-1",
          fact: "A standalone fact without entity references",
        },
      ];
      const result = formatMemoryContext(facts, []);

      assertEquals(
        result.includes("A standalone fact without entity references"),
        true,
      );
      // Should not have entity brackets when no nodes
      assertEquals(result.includes("[]"), false);
    });

    it("should handle facts with only source node", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "fact-1",
          fact: "Has a source only",
          source_node: { name: "Source", uuid: "node-1" },
        },
      ];
      const result = formatMemoryContext(facts, []);

      assertEquals(result.includes("[Source]"), true);
    });

    it("should handle facts with only target node", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "fact-1",
          fact: "Has a target only",
          target_node: { name: "Target", uuid: "node-2" },
        },
      ];
      const result = formatMemoryContext(facts, []);

      assertEquals(result.includes("[Target]"), true);
    });

    it("should handle nodes without labels", () => {
      const nodes: GraphitiNode[] = [
        {
          uuid: "node-1",
          name: "SimpleNode",
          summary: "Just a node",
        },
      ];
      const result = formatMemoryContext([], nodes);

      assertEquals(
        result.includes("<node>SimpleNode: Just a node</node>"),
        true,
      );
      // Should not have empty parentheses
      assertEquals(result.includes("()"), false);
    });

    it("should handle nodes without summary", () => {
      const nodes: GraphitiNode[] = [
        {
          uuid: "node-1",
          name: "LabelOnly",
          labels: ["category"],
        },
      ];
      const result = formatMemoryContext([], nodes);

      assertEquals(result.includes("<node>LabelOnly (category)</node>"), true);
      // Should not have colon without summary
      assertEquals(result.match(/:\s*<\/node>/), null);
    });

    it("should handle nodes with empty labels array", () => {
      const nodes: GraphitiNode[] = [
        {
          uuid: "node-1",
          name: "EmptyLabels",
          labels: [],
          summary: "Has empty labels",
        },
      ];
      const result = formatMemoryContext([], nodes);

      assertEquals(
        result.includes("<node>EmptyLabels: Has empty labels</node>"),
        true,
      );
      // Should not have empty parentheses
      assertEquals(result.includes("()"), false);
    });

    it("should handle multiple facts and nodes", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "First fact" },
        { uuid: "f2", fact: "Second fact" },
        { uuid: "f3", fact: "Third fact" },
      ];
      const nodes: GraphitiNode[] = [
        { uuid: "n1", name: "Node1" },
        { uuid: "n2", name: "Node2" },
      ];
      const result = formatMemoryContext(facts, nodes);

      assertEquals(result.includes("First fact"), true);
      assertEquals(result.includes("Second fact"), true);
      assertEquals(result.includes("Third fact"), true);
      assertEquals(result.includes("<node>Node1</node>"), true);
      assertEquals(result.includes("<node>Node2</node>"), true);
    });

    it("should format facts with source -> target arrows correctly", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "fact-1",
          fact: "relates to",
          source_node: { name: "A", uuid: "n1" },
          target_node: { name: "B", uuid: "n2" },
        },
      ];
      const result = formatMemoryContext(facts, []);

      assertEquals(result.includes("[A -> B]"), true);
    });

    it("should include instruction block in output", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "Test fact" },
      ];
      const result = formatMemoryContext(facts, []);

      assertEquals(result.includes("<instruction>"), true);
      assertEquals(
        result.includes(
          "Background context only; do not reference in titles, summaries, or opening responses unless directly relevant.",
        ),
        true,
      );
    });

    it("should wrap output in memory tags", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "Test fact" },
      ];
      const result = formatMemoryContext(facts, []);

      assertEquals(result.startsWith("<memory>"), true);
      assertEquals(result.endsWith("</memory>"), true);
    });

    it("should wrap facts in facts tags", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "First" },
        { uuid: "f2", fact: "Second" },
      ];
      const result = formatMemoryContext(facts, []);

      assertEquals(result.includes("<facts>"), true);
      assertEquals(result.includes("</facts>"), true);
      const factsStart = result.indexOf("<facts>");
      const factsEnd = result.indexOf("</facts>");
      const factsSection = result.slice(factsStart, factsEnd);
      assertEquals(factsSection.includes("First"), true);
      assertEquals(factsSection.includes("Second"), true);
    });

    it("should wrap nodes in nodes tags", () => {
      const nodes: GraphitiNode[] = [
        { uuid: "n1", name: "Node1" },
        { uuid: "n2", name: "Node2" },
      ];
      const result = formatMemoryContext([], nodes);

      assertEquals(result.includes("<nodes>"), true);
      assertEquals(result.includes("</nodes>"), true);
      const nodesStart = result.indexOf("<nodes>");
      const nodesEnd = result.indexOf("</nodes>");
      const nodesSection = result.slice(nodesStart, nodesEnd);
      assertEquals(nodesSection.includes("Node1"), true);
      assertEquals(nodesSection.includes("Node2"), true);
    });

    it("should format multiple labels with comma separation", () => {
      const nodes: GraphitiNode[] = [
        {
          uuid: "n1",
          name: "MultiLabel",
          labels: ["type", "category", "tag"],
        },
      ];
      const result = formatMemoryContext([], nodes);

      assertEquals(result.includes("(type, category, tag)"), true);
    });

    it("should handle facts with special characters", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "f1",
          fact: 'Fact with "quotes" and <brackets> & ampersands',
        },
      ];
      const result = formatMemoryContext(facts, []);

      assertEquals(
        result.includes('Fact with "quotes" and <brackets> & ampersands'),
        true,
      );
    });

    it("should handle node names with special characters", () => {
      const nodes: GraphitiNode[] = [
        {
          uuid: "n1",
          name: 'Node <with> "special" & chars',
          summary: "Summary",
        },
      ];
      const result = formatMemoryContext([], nodes);

      assertEquals(result.includes('Node <with> "special" & chars'), true);
    });

    it("should format facts and nodes in correct order", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "Fact content" },
      ];
      const nodes: GraphitiNode[] = [
        { uuid: "n1", name: "Node name" },
      ];
      const result = formatMemoryContext(facts, nodes);

      const memoryIndex = result.indexOf("<memory>");
      const instructionIndex = result.indexOf("<instruction>");
      const factsIndex = result.indexOf("<facts>");
      const nodesIndex = result.indexOf("<nodes>");
      const memoryEndIndex = result.indexOf("</memory>");

      // Verify order
      assertEquals(memoryIndex < instructionIndex, true);
      assertEquals(instructionIndex < factsIndex, true);
      assertEquals(factsIndex < nodesIndex, true);
      assertEquals(nodesIndex < memoryEndIndex, true);
    });

    it("should handle very long fact text", () => {
      const longText = "A".repeat(10000);
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: longText },
      ];
      const result = formatMemoryContext(facts, []);

      assertEquals(result.includes(longText), true);
      assertEquals(result.includes("<fact>"), true);
      assertEquals(result.includes("</fact>"), true);
    });

    it("should handle facts with newlines", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "Line 1\nLine 2\nLine 3" },
      ];
      const result = formatMemoryContext(facts, []);

      assertEquals(result.includes("Line 1\nLine 2\nLine 3"), true);
    });

    it("should handle nodes with empty string summary", () => {
      const nodes: GraphitiNode[] = [
        {
          uuid: "n1",
          name: "Node",
          summary: "",
        },
      ];
      const result = formatMemoryContext([], nodes);

      // Empty summary should not add colon
      assertEquals(result.includes("<node>Node</node>"), true);
      assertEquals(result.includes("Node:"), false);
    });

    it("should handle single label correctly", () => {
      const nodes: GraphitiNode[] = [
        {
          uuid: "n1",
          name: "SingleLabel",
          labels: ["only-one"],
        },
      ];
      const result = formatMemoryContext([], nodes);

      assertEquals(result.includes("(only-one)"), true);
      // For a single label, the formatted string should be exactly "(only-one)" without extra commas
      assertEquals(result.includes("(only-one,"), false);
    });
  });
});
