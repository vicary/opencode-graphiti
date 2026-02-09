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

      assertEquals(result.includes("# Persistent Memory"), true);
      assertEquals(result.includes("## Known Facts"), true);
      assertEquals(result.includes("The API endpoint is at /api/v1"), true);
      assertEquals(result.includes("[API -> Endpoint]"), true);
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

      assertEquals(result.includes("# Persistent Memory"), true);
      assertEquals(result.includes("## Known Entities"), true);
      assertEquals(result.includes("**Deno**"), true);
      assertEquals(result.includes("(runtime, javascript)"), true);
      assertEquals(result.includes("A modern JavaScript runtime"), true);
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

      assertEquals(result.includes("## Known Facts"), true);
      assertEquals(result.includes("## Known Entities"), true);
      assertEquals(result.includes("Uses TypeScript"), true);
      assertEquals(result.includes("**TypeScript**"), true);
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

      assertEquals(result.includes("**SimpleNode**"), true);
      assertEquals(result.includes("Just a node"), true);
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

      assertEquals(result.includes("**LabelOnly**"), true);
      assertEquals(result.includes("(category)"), true);
      // Should not have colon without summary
      assertEquals(result.match(/:\s*$/), null);
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

      assertEquals(result.includes("**EmptyLabels**"), true);
      assertEquals(result.includes("Has empty labels"), true);
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
      assertEquals(result.includes("**Node1**"), true);
      assertEquals(result.includes("**Node2**"), true);
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
  });
});
