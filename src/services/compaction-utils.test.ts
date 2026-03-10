import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import type { GraphitiFact, GraphitiNode } from "../types/index.ts";
import { classifyFacts, takeFactsWithinBudget } from "./compaction.ts";
import { formatFactLine } from "./context.ts";

describe("compaction-utils", () => {
  describe("classifyFacts", () => {
    it("should classify decision facts", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "f1",
          fact: "The system must use a microservices architecture",
        },
        { uuid: "f2", fact: "Database schema includes users table" },
      ];
      const result = classifyFacts(
        facts,
        new Date("2026-02-14T00:00:00Z"),
      );
      assertEquals(result.decisions.length, 2);
    });

    it("should classify active facts by recency", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "f1",
          fact: "Recent update",
          valid_at: "2026-02-10T00:00:00Z",
        },
        {
          uuid: "f2",
          fact: "Older update",
          valid_at: "2025-12-01T00:00:00Z",
        },
      ];
      const result = classifyFacts(
        facts,
        new Date("2026-02-14T00:00:00Z"),
      );
      assertEquals(result.active.map((fact) => fact.uuid), ["f1"]);
    });

    it("should classify background facts as default", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "General context fact" },
        { uuid: "f2", fact: "Historical note" },
      ];
      const result = classifyFacts(
        facts,
        new Date("2026-02-14T00:00:00Z"),
      );
      assertEquals(result.background.length, 2);
    });

    it("should classify decision facts by keywords", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "Decided to use PostgreSQL instead of MySQL" },
        { uuid: "f2", fact: "Team agreed on REST API design" },
      ];
      const result = classifyFacts(
        facts,
        new Date("2026-02-14T00:00:00Z"),
      );
      assertEquals(result.decisions.length, 2);
    });

    it("should classify background facts (no decision keyword, no recency)", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "The user prefers dark mode" },
        { uuid: "f2", fact: "Recent conversation about API endpoints" },
      ];
      const result = classifyFacts(
        facts,
        new Date("2026-02-14T00:00:00Z"),
      );
      assertEquals(result.background.length, 2);
    });

    it("should handle mixed fact types", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "System should use microservices" }, // decision
        { uuid: "f2", fact: "Recent change", valid_at: "2026-02-10T00:00:00Z" }, // active
        { uuid: "f3", fact: "Decided to use TypeScript" }, // decision
        { uuid: "f4", fact: "Must be GDPR compliant" }, // decision
        { uuid: "f5", fact: "User mentioned preferences" }, // background
      ];
      const result = classifyFacts(
        facts,
        new Date("2026-02-14T00:00:00Z"),
      );
      assertEquals(result.decisions.length, 3);
      assertEquals(result.active.length, 1);
      assertEquals(result.background.length, 1);
    });

    it("should handle empty array", () => {
      const result = classifyFacts([], new Date("2026-02-14T00:00:00Z"));
      assertEquals(result.decisions.length, 0);
      assertEquals(result.active.length, 0);
      assertEquals(result.background.length, 0);
    });

    it("should preserve original fact properties", () => {
      const facts: GraphitiFact[] = [
        {
          uuid: "f1",
          fact: "System architecture detail",
          valid_at: "2026-02-14T00:00:00Z",
          source_node: { name: "System", uuid: "n1" },
        },
      ];
      const result = classifyFacts(facts, new Date("2026-02-14T00:00:00Z"));
      const found = [
        ...result.decisions,
        ...result.active,
        ...result.background,
      ].find((f) => f.uuid === "f1");
      assertEquals(found?.uuid, "f1");
      assertEquals(found?.valid_at, "2026-02-14T00:00:00Z");
      assertEquals(found?.source_node?.name, "System");
    });
  });

  describe("takeFactsWithinBudget", () => {
    it("should prioritize decision facts in compaction", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "Background fact" },
        { uuid: "f2", fact: "Must use Graphiti" },
        { uuid: "f3", fact: "Recent update", valid_at: "2026-02-10T00:00:00Z" },
      ];
      const selected = takeFactsWithinBudget(
        facts,
        formatFactLine(facts[1]).length + 1,
        {
          factStaleDays: 30,
          now: new Date("2026-02-14T00:00:00Z"),
        },
      );
      assertEquals(selected.map((fact) => fact.uuid), ["f2"]);
    });

    it("should include facts up to character budget", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "Short fact" },
        { uuid: "f2", fact: "Another short fact" },
        { uuid: "f3", fact: "One more short fact" },
      ];
      const budget = formatFactLine(facts[0]).length + 1 +
        formatFactLine(facts[1]).length + 1;
      const selected = takeFactsWithinBudget(
        facts,
        budget,
        {
          factStaleDays: 30,
          now: new Date("2026-02-14T00:00:00Z"),
        },
      );
      assertEquals(selected.map((fact) => fact.uuid), ["f1", "f2"]);
    });

    it("should not exceed budget even if single fact is too large", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "A".repeat(200) },
      ];
      const budget = 100;
      const selected = takeFactsWithinBudget(
        facts,
        budget,
        {
          factStaleDays: 30,
          now: new Date("2026-02-14T00:00:00Z"),
        },
      );
      assertEquals(selected.length, 0);
    });

    it("should handle empty facts array", () => {
      const facts: GraphitiFact[] = [];
      const selected = takeFactsWithinBudget(
        facts,
        1000,
        {
          factStaleDays: 30,
          now: new Date("2026-02-14T00:00:00Z"),
        },
      );
      assertEquals(selected.length, 0);
    });

    it("should respect category budget allocations", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "Must use Graphiti" },
        { uuid: "f2", fact: "Decided on REST" },
        { uuid: "f3", fact: "Recent update", valid_at: "2026-02-10T00:00:00Z" },
      ];
      const selected = takeFactsWithinBudget(
        facts,
        formatFactLine(facts[0]).length + 1,
        {
          factStaleDays: 30,
          now: new Date("2026-02-14T00:00:00Z"),
        },
      );
      assertEquals(selected.map((fact) => fact.uuid), ["f1"]);
    });

    it("should ignore nodes when selecting facts", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "Fact 1" },
      ];
      const nodes: GraphitiNode[] = [
        { uuid: "n1", name: "Node A", summary: "Summary" },
      ];
      const selected = takeFactsWithinBudget(
        facts,
        200,
        {
          factStaleDays: 30,
          now: new Date("2026-02-14T00:00:00Z"),
        },
      );
      assertEquals(selected.map((fact) => fact.uuid), ["f1"]);
      assertEquals(nodes.length, 1); // nodes param not consumed by this helper
    });
  });
});
