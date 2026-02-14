import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import type { SessionState } from "../session.ts";
import type { GraphitiFact, GraphitiNode } from "../types/index.ts";

/**
 * Tests for planned session snapshot and drift detection utilities:
 * - createSessionSnapshot: Serialize current session state
 * - loadSessionSnapshot: Restore session state from snapshot
 * - computeJaccardSimilarity: Calculate similarity between two contexts
 * - detectContextDrift: Compare current context with stored snapshot
 */

describe("session-snapshot (planned)", () => {
  describe("createSessionSnapshot", () => {
    it("should serialize session state to JSON", () => {
      const state: SessionState = {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: true,
        lastInjectionFactUuids: ["fact-1", "fact-2"],
        messageCount: 10,
        pendingMessages: ["User: Hello", "Assistant: Hi"],
        contextLimit: 200_000,
        isMain: true,
      };
      // Expected: createSessionSnapshot(state) => JSON string
      const serialized = JSON.stringify(state);
      assertEquals(serialized.includes("test:project"), true);
      assertEquals(serialized.includes("pendingMessages"), true);
    });

    it("should include timestamp in snapshot", () => {
      const state: SessionState = {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        messageCount: 0,
        pendingMessages: [],
        contextLimit: 200_000,
        isMain: true,
      };
      // Expected: createSessionSnapshot adds timestamp field
      const snapshot = { ...state, timestamp: Date.now() };
      assertEquals(snapshot.timestamp !== undefined, true);
    });

    it("should handle empty pending messages", () => {
      const state: SessionState = {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: false,
        lastInjectionFactUuids: [],
        messageCount: 0,
        pendingMessages: [],
        contextLimit: 200_000,
        isMain: true,
      };
      // Expected: createSessionSnapshot handles empty arrays
      assertEquals(state.pendingMessages.length, 0);
    });

    it("should include context summary in snapshot", () => {
      const state: SessionState = {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: true,
        lastInjectionFactUuids: ["fact-1"],
        messageCount: 10,
        pendingMessages: ["User: Discuss API design"],
        contextLimit: 200_000,
        isMain: true,
      };
      const facts: GraphitiFact[] = [
        { uuid: "f1", fact: "API uses REST" },
        { uuid: "f2", fact: "Authentication via JWT" },
      ];
      // Expected: createSessionSnapshot can include facts/nodes summary
      const snapshot = {
        ...state,
        contextSummary: facts.map((f) => f.uuid),
      };
      assertEquals(snapshot.contextSummary?.length, 2);
    });

    it("should serialize to valid JSON", () => {
      const state: SessionState = {
        groupId: "test:project",
        userGroupId: "test:user",
        injectedMemories: true,
        lastInjectionFactUuids: ["fact-1"],
        messageCount: 10,
        pendingMessages: ['Message with "quotes"'],
        contextLimit: 200_000,
        isMain: true,
      };
      // Expected: createSessionSnapshot produces valid JSON
      const serialized = JSON.stringify(state);
      const parsed = JSON.parse(serialized);
      assertEquals(parsed.groupId, "test:project");
      assertEquals(parsed.pendingMessages[0], 'Message with "quotes"');
    });
  });

  describe("loadSessionSnapshot", () => {
    it("should deserialize session state from JSON", () => {
      const json =
        '{"groupId":"test:project","userGroupId":"test:user","injectedMemories":true,"lastInjectionFactUuids":["fact-1"],"messageCount":10,"pendingMessages":["User: Hello"],"contextLimit":200000,"isMain":true}';
      // Expected: loadSessionSnapshot(json) => SessionState object
      const state = JSON.parse(json) as SessionState;
      assertEquals(state.groupId, "test:project");
      assertEquals(state.messageCount, 10);
      assertEquals(state.pendingMessages[0], "User: Hello");
    });

    it("should validate required fields", () => {
      const invalidJson = '{"groupId":"test:project"}';
      // Expected: loadSessionSnapshot validates presence of required fields
      const partial = JSON.parse(invalidJson) as Partial<SessionState>;
      assertEquals(partial.groupId, "test:project");
      assertEquals(partial.messageCount, undefined);
    });

    it("should handle missing optional fields gracefully", () => {
      const minimalJson =
        '{"groupId":"test:project","userGroupId":"test:user","injectedMemories":false,"lastInjectionFactUuids":[],"messageCount":0,"pendingMessages":[],"contextLimit":200000,"isMain":true}';
      // Expected: loadSessionSnapshot fills defaults for optional fields
      const state = JSON.parse(minimalJson) as SessionState;
      assertEquals(state.injectedMemories, false);
      assertEquals(state.pendingMessages.length, 0);
    });

    it("should throw on invalid JSON", () => {
      const invalidJson = "{invalid json}";
      // Expected: loadSessionSnapshot throws or returns null
      let error: Error | null = null;
      try {
        JSON.parse(invalidJson);
      } catch (err) {
        error = err as Error;
      }
      assertEquals(error !== null, true);
    });

    it("should restore timestamp field", () => {
      const timestamp = Date.now();
      const json =
        `{"groupId":"test:project","userGroupId":"test:user","injectedMemories":false,"lastInjectionFactUuids":[],"messageCount":0,"pendingMessages":[],"contextLimit":200000,"isMain":true,"timestamp":${timestamp}}`;
      // Expected: loadSessionSnapshot preserves timestamp
      const state = JSON.parse(json) as SessionState & { timestamp?: number };
      assertEquals(state.timestamp, timestamp);
    });

    it("should handle escaped characters in pending messages", () => {
      const json =
        '{"groupId":"test:project","userGroupId":"test:user","injectedMemories":false,"lastInjectionFactUuids":[],"messageCount":1,"pendingMessages":["User: \\"quoted\\" text\\nwith newline"],"contextLimit":200000,"isMain":true}';
      // Expected: loadSessionSnapshot correctly parses escaped strings
      const state = JSON.parse(json) as SessionState;
      assertEquals(state.pendingMessages[0].includes('"quoted"'), true);
      assertEquals(state.pendingMessages[0].includes("\n"), true);
    });

    it("should validate contextLimit is a number", () => {
      const json =
        '{"groupId":"test:project","userGroupId":"test:user","injectedMemories":false,"lastInjectionFactUuids":[],"messageCount":0,"pendingMessages":[],"contextLimit":"not a number","isMain":true}';
      // Expected: loadSessionSnapshot validates type of contextLimit
      const state = JSON.parse(json) as SessionState;
      assertEquals(typeof state.contextLimit, "string"); // Invalid but parsed
      // Implementation should validate and reject
    });
  });

  describe("computeJaccardSimilarity", () => {
    it("should return 1.0 for identical sets", () => {
      const setA = new Set(["fact1", "fact2", "fact3"]);
      const setB = new Set(["fact1", "fact2", "fact3"]);
      // Expected: computeJaccardSimilarity(setA, setB) => 1.0
      // Jaccard = |A ∩ B| / |A ∪ B| = 3 / 3 = 1.0
      const intersection = new Set([...setA].filter((x) => setB.has(x)));
      const union = new Set([...setA, ...setB]);
      const jaccard = intersection.size / union.size;
      assertEquals(jaccard, 1.0);
    });

    it("should return 0.0 for disjoint sets", () => {
      const setA = new Set(["fact1", "fact2"]);
      const setB = new Set(["fact3", "fact4"]);
      // Expected: computeJaccardSimilarity(setA, setB) => 0.0
      // Jaccard = |A ∩ B| / |A ∪ B| = 0 / 4 = 0.0
      const intersection = new Set([...setA].filter((x) => setB.has(x)));
      const union = new Set([...setA, ...setB]);
      const jaccard = intersection.size / union.size;
      assertEquals(jaccard, 0.0);
    });

    it("should compute partial overlap correctly", () => {
      const setA = new Set(["fact1", "fact2", "fact3"]);
      const setB = new Set(["fact2", "fact3", "fact4"]);
      // Expected: computeJaccardSimilarity(setA, setB) => 0.5
      // Jaccard = |A ∩ B| / |A ∪ B| = 2 / 4 = 0.5
      const intersection = new Set([...setA].filter((x) => setB.has(x)));
      const union = new Set([...setA, ...setB]);
      const jaccard = intersection.size / union.size;
      assertEquals(jaccard, 0.5);
    });

    it("should handle empty sets", () => {
      const setA = new Set<string>([]);
      const setB = new Set<string>([]);
      // Expected: computeJaccardSimilarity([], []) => 0.0 or 1.0 (convention)
      // Typically defined as 1.0 for empty sets or 0.0 if division by zero
      const intersection = new Set([...setA].filter((x) => setB.has(x)));
      const union = new Set([...setA, ...setB]);
      const jaccard = union.size === 0 ? 1.0 : intersection.size / union.size;
      assertEquals(jaccard, 1.0);
    });

    it("should handle one empty set", () => {
      const setA = new Set(["fact1", "fact2"]);
      const setB = new Set<string>([]);
      // Expected: computeJaccardSimilarity(setA, []) => 0.0
      // Jaccard = |A ∩ B| / |A ∪ B| = 0 / 2 = 0.0
      const intersection = new Set([...setA].filter((x) => setB.has(x)));
      const union = new Set([...setA, ...setB]);
      const jaccard = intersection.size / union.size;
      assertEquals(jaccard, 0.0);
    });

    it("should compute similarity for fact UUIDs", () => {
      const factsA: GraphitiFact[] = [
        { uuid: "f1", fact: "Fact 1" },
        { uuid: "f2", fact: "Fact 2" },
        { uuid: "f3", fact: "Fact 3" },
      ];
      const factsB: GraphitiFact[] = [
        { uuid: "f2", fact: "Fact 2" },
        { uuid: "f3", fact: "Fact 3" },
        { uuid: "f4", fact: "Fact 4" },
      ];
      // Expected: computeJaccardSimilarity for UUIDs
      const setA = new Set(factsA.map((f) => f.uuid));
      const setB = new Set(factsB.map((f) => f.uuid));
      const intersection = new Set([...setA].filter((x) => setB.has(x)));
      const union = new Set([...setA, ...setB]);
      const jaccard = intersection.size / union.size;
      // Intersection: {f2, f3} = 2
      // Union: {f1, f2, f3, f4} = 4
      // Jaccard = 2 / 4 = 0.5
      assertEquals(jaccard, 0.5);
    });

    it("should compute similarity for node names", () => {
      const nodesA: GraphitiNode[] = [
        { uuid: "n1", name: "TypeScript" },
        { uuid: "n2", name: "Deno" },
      ];
      const nodesB: GraphitiNode[] = [
        { uuid: "n3", name: "Deno" },
        { uuid: "n4", name: "Node.js" },
      ];
      // Expected: computeJaccardSimilarity for node names
      const setA = new Set(nodesA.map((n) => n.name));
      const setB = new Set(nodesB.map((n) => n.name));
      const intersection = new Set([...setA].filter((x) => setB.has(x)));
      const union = new Set([...setA, ...setB]);
      const jaccard = intersection.size / union.size;
      // Intersection: {Deno} = 1
      // Union: {TypeScript, Deno, Node.js} = 3
      // Jaccard = 1 / 3 ≈ 0.333
      assertStrictEquals(Math.abs(jaccard - 0.333) < 0.01, true);
    });
  });

  describe("detectContextDrift", () => {
    it("should detect no drift when similarity is high", () => {
      const currentFacts: GraphitiFact[] = [
        { uuid: "f1", fact: "Fact 1" },
        { uuid: "f2", fact: "Fact 2" },
        { uuid: "f3", fact: "Fact 3" },
      ];
      const snapshotFacts: GraphitiFact[] = [
        { uuid: "f1", fact: "Fact 1" },
        { uuid: "f2", fact: "Fact 2" },
        { uuid: "f3", fact: "Fact 3" },
      ];
      // Expected: detectContextDrift(current, snapshot) => { drifted: false, similarity: 1.0 }
      const currentSet = new Set(currentFacts.map((f) => f.uuid));
      const snapshotSet = new Set(snapshotFacts.map((f) => f.uuid));
      const intersection = new Set(
        [...currentSet].filter((x) => snapshotSet.has(x)),
      );
      const union = new Set([...currentSet, ...snapshotSet]);
      const similarity = intersection.size / union.size;
      assertEquals(similarity, 1.0);
      assertEquals(similarity > 0.8, true); // No drift if > 80%
    });

    it("should detect drift when similarity is low", () => {
      const currentFacts: GraphitiFact[] = [
        { uuid: "f1", fact: "New fact 1" },
        { uuid: "f2", fact: "New fact 2" },
      ];
      const snapshotFacts: GraphitiFact[] = [
        { uuid: "f3", fact: "Old fact 1" },
        { uuid: "f4", fact: "Old fact 2" },
      ];
      // Expected: detectContextDrift => { drifted: true, similarity: 0.0 }
      const currentSet = new Set(currentFacts.map((f) => f.uuid));
      const snapshotSet = new Set(snapshotFacts.map((f) => f.uuid));
      const intersection = new Set(
        [...currentSet].filter((x) => snapshotSet.has(x)),
      );
      const union = new Set([...currentSet, ...snapshotSet]);
      const similarity = intersection.size / union.size;
      assertEquals(similarity, 0.0);
      assertEquals(similarity < 0.5, true); // Drifted if < 50%
    });

    it("should use configurable drift threshold", () => {
      const currentFacts: GraphitiFact[] = [
        { uuid: "f1", fact: "Fact 1" },
        { uuid: "f2", fact: "Fact 2" },
      ];
      const snapshotFacts: GraphitiFact[] = [
        { uuid: "f2", fact: "Fact 2" },
        { uuid: "f3", fact: "Fact 3" },
      ];
      // Similarity = 1 / 3 ≈ 0.333
      const currentSet = new Set(currentFacts.map((f) => f.uuid));
      const snapshotSet = new Set(snapshotFacts.map((f) => f.uuid));
      const intersection = new Set(
        [...currentSet].filter((x) => snapshotSet.has(x)),
      );
      const union = new Set([...currentSet, ...snapshotSet]);
      const similarity = intersection.size / union.size;
      // Expected: detectContextDrift with threshold 0.5 => drifted: true
      // Expected: detectContextDrift with threshold 0.2 => drifted: false
      assertEquals(similarity < 0.5, true); // Drifted at 50% threshold
      assertEquals(similarity > 0.2, true); // Not drifted at 20% threshold
    });

    it("should report added and removed fact counts", () => {
      const currentFacts: GraphitiFact[] = [
        { uuid: "f1", fact: "Kept fact" },
        { uuid: "f2", fact: "New fact" },
      ];
      const snapshotFacts: GraphitiFact[] = [
        { uuid: "f1", fact: "Kept fact" },
        { uuid: "f3", fact: "Removed fact" },
      ];
      // Expected: detectContextDrift => { added: 1, removed: 1 }
      const currentSet = new Set(currentFacts.map((f) => f.uuid));
      const snapshotSet = new Set(snapshotFacts.map((f) => f.uuid));
      const added = [...currentSet].filter((x) => !snapshotSet.has(x));
      const removed = [...snapshotSet].filter((x) => !currentSet.has(x));
      assertEquals(added.length, 1); // f2
      assertEquals(removed.length, 1); // f3
    });

    it("should handle empty current context", () => {
      const currentFacts: GraphitiFact[] = [];
      const snapshotFacts: GraphitiFact[] = [
        { uuid: "f1", fact: "Fact 1" },
      ];
      // Expected: detectContextDrift => { drifted: true, similarity: 0.0 }
      const currentSet = new Set(currentFacts.map((f) => f.uuid));
      const snapshotSet = new Set(snapshotFacts.map((f) => f.uuid));
      const intersection = new Set(
        [...currentSet].filter((x) => snapshotSet.has(x)),
      );
      const union = new Set([...currentSet, ...snapshotSet]);
      const similarity = intersection.size / union.size;
      assertEquals(similarity, 0.0);
    });

    it("should handle empty snapshot context", () => {
      const currentFacts: GraphitiFact[] = [
        { uuid: "f1", fact: "Fact 1" },
      ];
      const snapshotFacts: GraphitiFact[] = [];
      // Expected: detectContextDrift => { drifted: true, similarity: 0.0 }
      const currentSet = new Set(currentFacts.map((f) => f.uuid));
      const snapshotSet = new Set(snapshotFacts.map((f) => f.uuid));
      const intersection = new Set(
        [...currentSet].filter((x) => snapshotSet.has(x)),
      );
      const union = new Set([...currentSet, ...snapshotSet]);
      const similarity = intersection.size / union.size;
      assertEquals(similarity, 0.0);
    });

    it("should compute drift for both facts and nodes", () => {
      const currentFacts: GraphitiFact[] = [
        { uuid: "f1", fact: "Fact 1" },
      ];
      const currentNodes: GraphitiNode[] = [
        { uuid: "n1", name: "Node 1" },
      ];
      const snapshotFacts: GraphitiFact[] = [
        { uuid: "f1", fact: "Fact 1" },
      ];
      const snapshotNodes: GraphitiNode[] = [
        { uuid: "n2", name: "Node 2" },
      ];
      // Expected: detectContextDrift computes combined similarity
      const currentFactSet = new Set(currentFacts.map((f) => f.uuid));
      const snapshotFactSet = new Set(snapshotFacts.map((f) => f.uuid));
      const currentNodeSet = new Set(currentNodes.map((n) => n.uuid));
      const snapshotNodeSet = new Set(snapshotNodes.map((n) => n.uuid));

      const allCurrent = new Set([...currentFactSet, ...currentNodeSet]);
      const allSnapshot = new Set([...snapshotFactSet, ...snapshotNodeSet]);
      const intersection = new Set(
        [...allCurrent].filter((x) => allSnapshot.has(x)),
      );
      const union = new Set([...allCurrent, ...allSnapshot]);
      const similarity = intersection.size / union.size;
      // Intersection: {f1} = 1
      // Union: {f1, n1, n2} = 3
      // Similarity = 1 / 3 ≈ 0.333
      assertStrictEquals(Math.abs(similarity - 0.333) < 0.01, true);
    });
  });
});
