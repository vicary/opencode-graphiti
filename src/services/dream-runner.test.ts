import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";

import { RedisClient } from "./redis-client.ts";
import { DreamStore } from "./dream-store.ts";
import { createDreamRunner, type DreamSummarizer } from "./dream-runner.ts";
import type { NormalizedMemoryResult } from "../types/index.ts";

describe("DreamStore", () => {
  it("returns summaries before and after the reference time in chronological order", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const store = new DreamStore(redis);

    await store.putSummary({
      rootSessionId: "root-1",
      granularity: "day",
      created_at: "2026-04-19T00:00:00.000Z",
      body: "far before",
    });
    await store.putSummary({
      rootSessionId: "root-1",
      granularity: "day",
      created_at: "2026-04-20T00:00:00.000Z",
      body: "before",
    });
    await store.putSummary({
      rootSessionId: "root-1",
      granularity: "day",
      created_at: "2026-04-22T00:00:00.000Z",
      body: "after",
    });
    await store.putSummary({
      rootSessionId: "root-1",
      granularity: "day",
      created_at: "2026-04-23T00:00:00.000Z",
      body: "far after",
    });

    const results = await store.getSummariesAround({
      rootSessionId: "root-1",
      when: "2026-04-21T12:00:00.000Z",
    });

    assertEquals(results.map((item: NormalizedMemoryResult) => item.type), [
      "summary",
      "summary",
    ]);
    assertEquals(
      results.map((item: NormalizedMemoryResult) => item.created_at),
      [
        "2026-04-20T00:00:00.000Z",
        "2026-04-22T00:00:00.000Z",
      ],
    );
  });

  it("stores watermark without expiry semantics in the API", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const store = new DreamStore(redis);

    assertEquals(await store.getWatermark("root-1"), null);
    await store.setWatermark("root-1", "2026-04-21T12:00:00.000Z");
    assertEquals(
      await store.getWatermark("root-1"),
      "2026-04-21T12:00:00.000Z",
    );
  });
});

describe("createDreamRunner", () => {
  it("stores deterministic summaries and advances the watermark", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const store = new DreamStore(redis);
    const summarizeCalls: Array<{ granularity: string; snippets: string[] }> =
      [];

    const runner = createDreamRunner({
      store,
      summarize(input: Parameters<DreamSummarizer>[0]) {
        summarizeCalls.push(input);
        return `${input.granularity}:${input.snippets.join(" | ")}`;
      },
    });

    await runner.refresh("root-1", null, [
      {
        created_at: "2026-04-20T09:00:00.000Z",
        snippet: "alpha",
      },
      {
        created_at: "2026-04-20T12:00:00.000Z",
        snippet: "beta",
      },
      {
        created_at: "2026-04-21T08:00:00.000Z",
        snippet: "gamma",
      },
    ]);

    assertEquals(summarizeCalls, [
      { granularity: "day", snippets: ["alpha", "beta"] },
      { granularity: "day", snippets: ["gamma"] },
    ]);

    const summaries = await store.getSummariesAround({
      rootSessionId: "root-1",
      when: "2026-04-20T18:00:00.000Z",
    });

    assertEquals(
      summaries.map((item: NormalizedMemoryResult) => item.snippet),
      [
        "day:alpha | beta",
        "day:gamma",
      ],
    );
    assertEquals(
      await store.getWatermark("root-1"),
      "2026-04-21T08:00:00.000Z",
    );
  });
});
