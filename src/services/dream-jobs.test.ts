import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";

import { RedisClient } from "./redis-client.ts";
import { type DreamJob, DreamJobStore } from "./dream-jobs.ts";

describe("DreamJobStore", () => {
  it("writes, reads, and clears a pending dream job", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const store = new DreamJobStore(redis);
    const job: DreamJob = {
      rootSessionId: "root-1",
      fromWatermark: "2026-04-20T00:00:00.000Z",
      targetWatermark: "2026-04-21T00:00:00.000Z",
      created_at: "2026-04-21T01:00:00.000Z",
    };

    assertEquals(await store.readPendingJob("root-1"), null);

    await store.writeJob(job);

    assertEquals(await store.readPendingJob("root-1"), job);

    await store.clearJob("root-1");

    assertEquals(await store.readPendingJob("root-1"), null);
  });

  it("prepares a pending job only when the target watermark is ahead", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const store = new DreamJobStore(redis, {
      readWatermark: (rootSessionId: string) =>
        Promise.resolve(
          rootSessionId === "root-gap"
            ? "2026-04-20T00:00:00.000Z"
            : "2026-04-21T00:00:00.000Z",
        ),
      now: () => "2026-04-21T12:00:00.000Z",
    });

    const job = await store.preparePendingJobs([
      {
        rootSessionId: "root-caught-up",
        targetWatermark: "2026-04-21T00:00:00.000Z",
      },
      {
        rootSessionId: "root-gap",
        targetWatermark: "2026-04-21T08:00:00.000Z",
      },
    ]);

    assertEquals(job, {
      rootSessionId: "root-gap",
      fromWatermark: "2026-04-20T00:00:00.000Z",
      targetWatermark: "2026-04-21T08:00:00.000Z",
      created_at: "2026-04-21T12:00:00.000Z",
    });
    assertEquals(await store.readPendingJob("root-gap"), job);
  });
});
