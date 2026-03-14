import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { RedisCacheService } from "./redis-cache.ts";
import { RedisClient } from "./redis-client.ts";

describe("redis cache", () => {
  it("stores cache entries per group without leaking across groups", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const cache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    await cache.set("group-1", {
      query: "project alpha policy",
      refreshedAt: Date.now(),
      facts: [{ uuid: "fact-1", fact: "Alpha uses kebab-case config names" }],
      nodes: [],
      factUuids: ["fact-1"],
      nodeRefs: [],
    });
    await cache.set("group-2", {
      query: "project beta policy",
      refreshedAt: Date.now(),
      facts: [{ uuid: "fact-2", fact: "Beta uses snake_case env names" }],
      nodes: [],
      factUuids: ["fact-2"],
      nodeRefs: [],
    });

    assertEquals((await cache.get("group-1"))?.factUuids, ["fact-1"]);
    assertEquals((await cache.get("group-2"))?.factUuids, ["fact-2"]);
    assertEquals(await cache.get("group-3"), null);
  });

  it("filters already visible facts and returns little or no persistent memory for noise-only remainder", () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const cache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    const rendered = cache.renderPersistentMemory({
      query: "naming policy",
      refreshedAt: Date.now(),
      facts: [{ uuid: "fact-1", fact: "Use kebab-case route names" }],
      nodes: [],
      factUuids: ["fact-1"],
      nodeRefs: [],
    }, ["fact-1"]);

    assertEquals(rendered.body, "");
    assertEquals(rendered.factUuids, []);
    assertEquals(rendered.nodeRefs, []);
  });

  it("renders bounded persistent memory with deduped visible facts and truncated long content", () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const cache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    const huge = "RAW-TRANSCRIPT-CHUNK ".repeat(200);
    const rendered = cache.renderPersistentMemory({
      query: "context overhaul policy",
      refreshedAt: Date.now(),
      facts: Array.from({ length: 10 }, (_, index) => ({
        uuid: `fact-${index + 1}`,
        fact: `Fact ${index + 1} ${huge}`,
      })),
      nodes: Array.from({ length: 8 }, (_, index) => ({
        uuid: `node-${index + 1}`,
        name: `Node ${index + 1}`,
        summary: huge,
      })),
      episodeSummaries: Array.from(
        { length: 6 },
        (_, index) => `Episode ${index + 1} ${huge}`,
      ),
      factUuids: Array.from({ length: 10 }, (_, index) => `fact-${index + 1}`),
      nodeRefs: Array.from({ length: 8 }, (_, index) => `node-${index + 1}`),
    }, ["fact-1", "fact-2", "fact-3"]);

    assertEquals(rendered.factUuids.includes("fact-1"), false);
    assertEquals(rendered.factUuids.includes("fact-2"), false);
    assertEquals(rendered.factUuids.includes("fact-3"), false);
    assertEquals(rendered.factUuids.length <= 7, true);
    assertEquals(rendered.nodeRefs.length <= 6, true);
    assertEquals(rendered.body.length <= 1800, true);
    assertStringIncludes(rendered.body, "Fact 4");
    assertEquals(rendered.body.includes(huge), false);
  });
});
