import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import type { GraphitiFact, GraphitiNode } from "../types/index.ts";
import {
  deduplicateFactsByUuid,
  deduplicateNodesByUuid,
  filterAndAnnotateFacts,
  removeNodesReferencedByFacts,
  sortFactsByRecency,
} from "./context.ts";

/**
 * Tests for planned context utility functions:
 * - filterStaleFactsUtility: Remove facts outside valid_at/invalid_at window
 * - annotateFacts: Add stale annotations to fact text
 * - sortFactsByRelevance: Order facts by recency and importance
 * - deduplicateByUuid: Remove duplicate facts/nodes by UUID
 * - removeOrphanNodes: Remove nodes not referenced by any fact
 */

describe("context-utils (planned)", () => {
  describe("filterStaleFactsUtility", () => {
    it("should keep facts without valid_at or invalid_at", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "Always valid fact" },
      ];
      const now = new Date("2026-02-14T12:00:00Z");
      const result = filterAndAnnotateFacts(facts, { now });
      assertEquals(result.length, 1);
    });

    it("should keep facts within valid window", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "f1",
          fact: "Currently valid",
          valid_at: "2026-02-01T00:00:00Z",
          invalid_at: "2026-02-28T00:00:00Z",
        },
      ];
      const now = new Date("2026-02-14T12:00:00Z");
      const result = filterAndAnnotateFacts(facts, { now });
      assertEquals(result.length, 1);
    });

    it("should filter out facts before valid_at", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "f1",
          fact: "Future fact",
          valid_at: "2026-03-01T00:00:00Z",
        },
      ];
      const now = new Date("2026-02-14T12:00:00Z");
      const result = filterAndAnnotateFacts(facts, { now });
      assertStrictEquals(result.length, 0);
    });

    it("should filter out facts after invalid_at", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "f1",
          fact: "Expired fact",
          invalid_at: "2026-01-31T00:00:00Z",
        },
      ];
      const now = new Date("2026-02-14T12:00:00Z");
      const result = filterAndAnnotateFacts(facts, { now });
      assertStrictEquals(result.length, 0);
    });

    it("should handle mixed valid and stale facts", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "Valid fact 1" },
        {
          uuid: "f2",
          fact: "Future fact",
          valid_at: "2026-03-01T00:00:00Z",
        },
        {
          uuid: "f3",
          fact: "Valid fact 2",
          valid_at: "2026-02-01T00:00:00Z",
        },
        {
          uuid: "f4",
          fact: "Expired fact",
          invalid_at: "2026-01-31T00:00:00Z",
        },
      ];
      const now = new Date("2026-02-14T12:00:00Z");
      const result = filterAndAnnotateFacts(facts, { now });
      assertEquals(result.map((fact: GraphitiFact) => fact.uuid), [
        "f3",
        "f1",
      ]);
    });

    it("should handle invalid date strings gracefully", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "f1",
          fact: "Invalid date",
          valid_at: "not-a-date",
        },
      ];
      const now = new Date("2026-02-14T12:00:00Z");
      const result = filterAndAnnotateFacts(facts, { now });
      assertEquals(result.length, 1);
    });
  });

  describe("annotateFacts", () => {
    it("should add stale annotation to facts with valid_at", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "f1",
          fact: "Event occurred",
          valid_at: "2026-02-01T10:30:00Z",
        },
      ];
      const now = new Date("2026-02-14T12:00:00Z");
      const result = filterAndAnnotateFacts(facts, {
        now,
        factStaleDays: 10,
      });
      assertEquals(result[0].fact.startsWith("[stale:"), true);
    });

    it("should ignore invalid_at for stale annotation", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "f1",
          fact: "Temporary state",
          invalid_at: "2026-02-28T00:00:00Z",
        },
      ];
      const now = new Date("2026-02-14T12:00:00Z");
      const result = filterAndAnnotateFacts(facts, {
        now,
        factStaleDays: 10,
      });
      assertEquals(result[0].fact, "Temporary state");
    });

    it("should add stale annotation when valid_at is old", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "f1",
          fact: "Limited period event",
          valid_at: "2026-02-01T00:00:00Z",
          invalid_at: "2026-02-28T00:00:00Z",
        },
      ];
      const now = new Date("2026-02-14T12:00:00Z");
      const result = filterAndAnnotateFacts(facts, {
        now,
        factStaleDays: 5,
      });
      assertEquals(result[0].fact.startsWith("[stale:"), true);
    });

    it("should not modify facts without timestamps", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "No timestamp fact" },
      ];
      const now = new Date("2026-02-14T12:00:00Z");
      const result = filterAndAnnotateFacts(facts, { now });
      assertEquals(result[0].fact, "No timestamp fact");
    });

    it("should preserve source and target node references", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "f1",
          fact: "Relationship",
          valid_at: "2026-02-14T00:00:00Z",
          source_node: { name: "NodeA", uuid: "n1" },
          target_node: { name: "NodeB", uuid: "n2" },
        },
      ];
      const now = new Date("2026-02-14T12:00:00Z");
      const result = filterAndAnnotateFacts(facts, { now });
      assertEquals(result[0].source_node?.name, "NodeA");
      assertEquals(result[0].target_node?.name, "NodeB");
    });
  });

  describe("sortFactsByRelevance", () => {
    it("should sort facts by recency (most recent first)", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "f1",
          fact: "Old fact",
          valid_at: "2026-01-01T00:00:00Z",
        },
        {
          uuid: "f2",
          fact: "Recent fact",
          valid_at: "2026-02-14T00:00:00Z",
        },
        {
          uuid: "f3",
          fact: "Middle fact",
          valid_at: "2026-02-01T00:00:00Z",
        },
      ];
      const sorted = sortFactsByRecency(facts);
      assertEquals(sorted.map((fact) => fact.uuid), ["f2", "f3", "f1"]);
    });

    it("should keep stable order without timestamps", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "Standalone fact" },
        {
          uuid: "f2",
          fact: "Connected fact",
          source_node: { name: "Node", uuid: "n1" },
        },
      ];
      const sorted = sortFactsByRecency(facts);
      assertEquals(sorted.map((fact) => fact.uuid), ["f1", "f2"]);
    });

    it("should handle facts without valid_at consistently", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "No timestamp A" },
        {
          uuid: "f2",
          fact: "Has timestamp",
          valid_at: "2026-02-14T00:00:00Z",
        },
        { uuid: "f3", fact: "No timestamp B" },
      ];
      const sorted = sortFactsByRecency(facts);
      assertEquals(sorted.map((fact) => fact.uuid), ["f2", "f1", "f3"]);
    });

    it("should handle empty array", () => {
      const facts: GraphitiFact[] = [];
      const sorted = sortFactsByRecency(facts);
      assertEquals(sorted.length, 0);
    });

    it("should maintain stable sort for equal relevance", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "f1",
          fact: "First",
          valid_at: "2026-02-14T10:00:00Z",
        },
        {
          uuid: "f2",
          fact: "Second",
          valid_at: "2026-02-14T10:00:00Z",
        },
      ];
      const sorted = sortFactsByRecency(facts);
      assertEquals(sorted[0].uuid, "f1");
      assertEquals(sorted[1].uuid, "f2");
    });
  });

  describe("deduplicateByUuid", () => {
    it("should remove duplicate facts by UUID", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "First occurrence" },
        { uuid: "f2", fact: "Unique fact" },
        { uuid: "f1", fact: "Duplicate occurrence" },
      ];
      const deduped = deduplicateFactsByUuid(facts);
      assertEquals(deduped.map((fact) => fact.uuid), ["f1", "f2"]);
    });

    it("should remove duplicate nodes by UUID", () => {
      const nodes: GraphitiNode[] = [
        { uuid: "n1", name: "Node A" },
        { uuid: "n2", name: "Node B" },
        { uuid: "n1", name: "Node A duplicate" },
      ];
      const deduped = deduplicateNodesByUuid(nodes);
      assertEquals(deduped.map((node) => node.uuid), ["n1", "n2"]);
    });

    it("should preserve first occurrence when deduplicating", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "Keep this one" },
        { uuid: "f1", fact: "Discard this one" },
      ];
      const deduped = deduplicateFactsByUuid(facts);
      assertEquals(deduped[0].fact, "Keep this one");
    });

    it("should handle empty array", () => {
      const facts: GraphitiFact[] = [];
      const deduped = deduplicateFactsByUuid(facts);
      assertEquals(deduped.length, 0);
    });

    it("should handle array with all unique items", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "Fact 1" },
        { uuid: "f2", fact: "Fact 2" },
        { uuid: "f3", fact: "Fact 3" },
      ];
      const deduped = deduplicateFactsByUuid(facts);
      assertEquals(deduped.length, 3);
    });

    it("should handle array with all duplicate items", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "Same fact" },
        { uuid: "f1", fact: "Same fact" },
        { uuid: "f1", fact: "Same fact" },
      ];
      const deduped = deduplicateFactsByUuid(facts);
      assertEquals(deduped.length, 1);
    });
  });

  describe("removeOrphanNodes", () => {
    it("should remove nodes referenced by facts", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "f1",
          fact: "Relationship",
          source_node: { name: "Node A", uuid: "n1" },
          target_node: { name: "Node B", uuid: "n2" },
        },
      ];
      const _nodes: GraphitiNode[] = [
        { uuid: "n1", name: "Node A" },
        { uuid: "n2", name: "Node B" },
        { uuid: "n3", name: "Orphan Node" },
      ];
      const filtered = removeNodesReferencedByFacts(facts, _nodes);
      assertEquals(filtered.map((node) => node.uuid), ["n3"]);
    });

    it("should keep all nodes when no facts exist", () => {
      const _facts: GraphitiFact[] = [];
      const _nodes: GraphitiNode[] = [
        { uuid: "n1", name: "Node A" },
        { uuid: "n2", name: "Node B" },
      ];
      const filtered = removeNodesReferencedByFacts(_facts, _nodes);
      assertEquals(filtered.map((node) => node.uuid), ["n1", "n2"]);
    });

    it("should remove all nodes when all are referenced", () => {
      const _facts: GraphitiFact[] = [
        {
          uuid: "f1",
          fact: "Fact 1",
          source_node: { name: "Node A", uuid: "n1" },
        },
        {
          uuid: "f2",
          fact: "Fact 2",
          target_node: { name: "Node B", uuid: "n2" },
        },
      ];
      const _nodes: GraphitiNode[] = [
        { uuid: "n1", name: "Node A" },
        { uuid: "n2", name: "Node B" },
      ];
      const filtered = removeNodesReferencedByFacts(_facts, _nodes);
      assertEquals(filtered.length, 0);
    });

    it("should keep nodes when facts have no references", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "Standalone fact" },
      ];
      const _nodes: GraphitiNode[] = [
        { uuid: "n1", name: "Node A" },
      ];
      const filtered = removeNodesReferencedByFacts(facts, _nodes);
      assertEquals(filtered.map((node) => node.uuid), ["n1"]);
    });

    it("should remove nodes referenced as source only", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "f1",
          fact: "Source only",
          source_node: { name: "Node A", uuid: "n1" },
        },
      ];
      const _nodes: GraphitiNode[] = [
        { uuid: "n1", name: "Node A" },
        { uuid: "n2", name: "Node B" },
      ];
      const filtered = removeNodesReferencedByFacts(facts, _nodes);
      assertEquals(filtered.map((node) => node.uuid), ["n2"]);
    });

    it("should remove nodes referenced as target only", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "f1",
          fact: "Target only",
          target_node: { name: "Node B", uuid: "n2" },
        },
      ];
      const _nodes: GraphitiNode[] = [
        { uuid: "n1", name: "Node A" },
        { uuid: "n2", name: "Node B" },
      ];
      const filtered = removeNodesReferencedByFacts(facts, _nodes);
      assertEquals(filtered.map((node) => node.uuid), ["n1"]);
    });

    it("should handle empty nodes array", () => {
      const _facts: GraphitiFact[] = [
        {
          uuid: "f1",
          fact: "Fact",
          source_node: { name: "Node A", uuid: "n1" },
        },
      ];
      const _nodes: GraphitiNode[] = [];
      const filtered = removeNodesReferencedByFacts(_facts, _nodes);
      assertEquals(filtered.length, 0);
    });
  });
});
