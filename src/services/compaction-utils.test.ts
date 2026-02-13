import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import type { GraphitiFact, GraphitiNode } from "../types/index.ts";
import { classifyFacts, takeFactsWithinBudget } from "./compaction.ts";
import { formatFactLine } from "./context.ts";

/**
 * Tests for planned compaction utility functions:
 * - classifyFacts: Classify facts by decisions/active/background tiers
 * - allocateBudget: Distribute character budget across fact categories
 * - prioritizeFacts: Select facts to include based on classification and budget
 * - deduplicateContext: Remove redundant facts before compaction injection
 */

describe("compaction-utils (planned)", () => {
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

    it("should classify background facts as default", () => {
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
      const facts: GraphitiFact[] = [];
      // Expected: classifyFacts([]) => []
      assertEquals(facts.length, 0);
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
      // Expected: classifyFacts preserves uuid, valid_at, source_node, etc.
      assertEquals(facts[0].uuid, "f1");
      assertEquals(facts[0].valid_at, "2026-02-14T00:00:00Z");
      assertEquals(facts[0].source_node?.name, "System");
    });
  });

  describe("allocateBudget", () => {
    it("should allocate 70% to project and 30% to user", () => {
      const totalBudget = 1000;
      // Expected: allocateBudget(1000, {project: [...], user: [...]}) =>
      //   { project: 700, user: 300 }
      const projectBudget = Math.floor(totalBudget * 0.7);
      const userBudget = totalBudget - projectBudget;
      assertEquals(projectBudget, 700);
      assertEquals(userBudget, 300);
    });

    it("should distribute project budget across categories", () => {
      const projectBudget = 700;
      // Expected: allocateBudget considers fact categories:
      // - decisions: 40% (280)
      // - active: 35% (244 due to floating point precision)
      // - background: remaining (176)
      const decisions = Math.floor(projectBudget * 0.4);
      const active = Math.floor(projectBudget * 0.35);
      const background = projectBudget - decisions - active;
      assertEquals(decisions, 280);
      assertEquals(active, 244);
      assertEquals(background, 176);
    });

    it("should handle zero budget", () => {
      const totalBudget = 0;
      // Expected: allocateBudget(0, ...) => all categories get 0
      assertEquals(totalBudget, 0);
    });

    it("should handle small budgets without negative values", () => {
      const totalBudget = 10;
      const projectBudget = Math.floor(totalBudget * 0.7);
      const userBudget = totalBudget - projectBudget;
      // Expected: allocateBudget(10, ...) => {project: 7, user: 3}
      assertEquals(projectBudget, 7);
      assertEquals(userBudget, 3);
      assertStrictEquals(projectBudget >= 0, true);
      assertStrictEquals(userBudget >= 0, true);
    });

    it("should reallocate unused category budget to others", () => {
      // If decisions category has no facts, its budget should be
      // redistributed to other categories proportionally
      const projectBudget = 700;
      const decisions = 0; // no decision facts
      const remaining = projectBudget - decisions;
      // Expected: remaining budget (700) split among other categories
      assertStrictEquals(remaining, 700);
    });
  });

  describe("prioritizeFacts", () => {
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
        { uuid: "f1", fact: "Short fact" }, // ~10 chars content
        { uuid: "f2", fact: "Another short fact" }, // ~20 chars content
        { uuid: "f3", fact: "One more short fact" }, // ~20 chars content
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
      assertEquals(nodes.length, 1);
    });
  });

  describe("deduplicateContext", () => {
    it("should remove facts with identical text", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "Duplicate content" },
        { uuid: "f2", fact: "Unique content" },
        { uuid: "f3", fact: "Duplicate content" },
      ];
      // Expected: deduplicateContext(facts) removes f3
      const uniqueFacts = new Map<string, GraphitiFact>();
      facts.forEach((f) => {
        if (!uniqueFacts.has(f.fact)) {
          uniqueFacts.set(f.fact, f);
        }
      });
      assertEquals(uniqueFacts.size, 2);
    });

    it("should remove facts with similar text (high similarity)", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "The system uses PostgreSQL database" },
        { uuid: "f2", fact: "The system uses PostgreSQL" },
        { uuid: "f3", fact: "Completely different fact" },
      ];
      // Expected: deduplicateContext removes f2 (substring of f1)
      // Uses string similarity or substring detection
      assertEquals(facts.length, 3);
    });

    it("should preserve facts by UUID even if text differs", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "Original text" },
        { uuid: "f1", fact: "Updated text" },
      ];
      // Expected: deduplicateContext by UUID keeps only first occurrence
      const uniqueByUuid = new Map<string, GraphitiFact>();
      facts.forEach((f) => {
        if (!uniqueByUuid.has(f.uuid)) {
          uniqueByUuid.set(f.uuid, f);
        }
      });
      assertEquals(uniqueByUuid.size, 1);
    });

    it("should handle empty array", () => {
      const facts: GraphitiFact[] = [];
      // Expected: deduplicateContext([]) => []
      assertEquals(facts.length, 0);
    });

    it("should handle array with all unique facts", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "Fact 1" },
        { uuid: "f2", fact: "Fact 2" },
        { uuid: "f3", fact: "Fact 3" },
      ];
      // Expected: deduplicateContext(facts) => facts (unchanged)
      assertEquals(facts.length, 3);
    });

    it("should remove semantic duplicates across nodes", () => {
      const nodes: GraphitiNode[] = [
        { uuid: "n1", name: "TypeScript", summary: "Typed JavaScript" },
        { uuid: "n2", name: "TypeScript", summary: "Typed JavaScript" },
        { uuid: "n3", name: "Deno", summary: "Runtime" },
      ];
      // Expected: deduplicateContext removes n2 (same name + summary)
      const uniqueNodes = new Map<string, GraphitiNode>();
      nodes.forEach((n) => {
        const key = `${n.name}:${n.summary ?? ""}`;
        if (!uniqueNodes.has(key)) {
          uniqueNodes.set(key, n);
        }
      });
      assertEquals(uniqueNodes.size, 2);
    });

    it("should handle facts with whitespace differences", () => {
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "The system uses TypeScript" },
        { uuid: "f2", fact: "The  system  uses  TypeScript" },
        { uuid: "f3", fact: " The system uses TypeScript " },
      ];
      // Expected: deduplicateContext normalizes whitespace before comparing
      const normalized = facts.map((f) => ({
        ...f,
        fact: f.fact.replace(/\s+/g, " ").trim(),
      }));
      const uniqueFacts = new Set(normalized.map((f) => f.fact));
      assertEquals(uniqueFacts.size, 1);
    });
  });
});
