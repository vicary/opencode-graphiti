import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { BatchDrainService } from "./batch-drain.ts";
import { createSessionEvent } from "./event-extractor.ts";
import { RedisClient } from "./redis-client.ts";
import {
  drainClaimActiveKey,
  drainClaimKey,
  drainClaimLockKey,
  drainDeadKey,
  drainPendingKey,
  drainRetryKey,
  RedisEventsService,
} from "./redis-events.ts";

const createDeps = () => {
  const redis = new RedisClient({ endpoint: "redis://unused" });
  const events = new RedisEventsService(redis, {
    sessionTtlSeconds: 60,
    claimLockTtlSeconds: 1,
  });
  const drain = new BatchDrainService(redis, events, {
    batchSize: 2,
    batchMaxBytes: 20_000,
    drainRetryMax: 2,
    claimHeartbeatIntervalMs: 100,
  });
  return { redis, events, drain };
};

describe("batch drain", () => {
  it("claims oldest events, drains them FIFO, and leaves newer items pending", async () => {
    const { redis, events, drain } = createDeps();
    const added: string[] = [];
    const recorded = [];
    for (const summary of ["first", "second", "third"]) {
      const event = createSessionEvent("message", "user", {
        summary,
        body: summary,
      });
      recorded.push(event);
      await events.recordEvent(
        "session-1",
        "group-1",
        event,
      );
    }

    const result = await drain.drainGroup("group-1", {
      addMemory(input: { name: string }) {
        added.push(input.name);
      },
    } as never);

    assertEquals(result, { status: "success", drained: 2 });
    assertEquals(
      added,
      [
        `message:${recorded[0].id}`,
        `message:${recorded[1].id}`,
      ],
    );
    const remaining = await redis.getListLength(drainPendingKey("group-1"));
    assertEquals(remaining, 1);

    const pendingRaw = await redis.getListRange(
      drainPendingKey("group-1"),
      0,
      -1,
    );
    assertEquals(
      pendingRaw.map((item) => JSON.parse(item).event.id),
      [recorded[2].id],
    );
  });

  it("keeps FIFO order across claim interleaving and does not lose newer enqueues", async () => {
    const { redis, events } = createDeps();
    const first = createSessionEvent("message", "user", {
      summary: "first",
      body: "first",
    });
    const second = createSessionEvent("message", "user", {
      summary: "second",
      body: "second",
    });

    await events.recordEvent("session-1", "group-1", first);
    await events.recordEvent("session-1", "group-1", second);

    const claimed = await events.getPendingBatch("group-1", 2, 20_000);
    assertEquals(claimed?.entries.map((entry) => entry.event.id), [
      first.id,
      second.id,
    ]);
    assertEquals(await redis.getListLength(drainPendingKey("group-1")), 0);
    assertEquals(
      await redis.getListLength(drainClaimKey("group-1", claimed!.claimToken)),
      2,
    );

    const third = createSessionEvent("message", "user", {
      summary: "third",
      body: "third",
    });
    await events.recordEvent("session-2", "group-1", third);

    const concurrentClaim = await events.getPendingBatch("group-1", 2, 20_000);
    assertEquals(concurrentClaim, null);

    await events.releaseClaim("group-1", claimed!.claimToken);

    const pendingAfterRelease = await redis.getListRange(
      drainPendingKey("group-1"),
      0,
      -1,
    );
    assertEquals(
      pendingAfterRelease.map((item) => JSON.parse(item).event.id),
      [third.id, second.id, first.id],
    );

    const reclaimed = await events.getPendingBatch("group-1", 3, 20_000);
    assertEquals(reclaimed?.entries.map((entry) => entry.event.id), [
      first.id,
      second.id,
      third.id,
    ]);
  });

  it("releases claims on retry and dead-letters after max attempts", async () => {
    const { redis, events, drain } = createDeps();
    const event = createSessionEvent("error", "tool", {
      summary: "failing batch",
      body: "failing batch",
      metadata: { resolved: false },
    });
    await events.recordEvent("session-1", "group-1", event);

    const failingGraphiti = {
      addMemory() {
        throw new Error("boom");
      },
    };

    const first = await drain.drainGroup("group-1", failingGraphiti as never);
    assertEquals(first.status, "retry");
    assertEquals(await redis.getListLength(drainPendingKey("group-1")), 1);

    await redis.setString(
      drainRetryKey("group-1", `${event.id}:${event.id}`),
      JSON.stringify({ attempts: 1, nextAttemptAt: 0 }),
      60,
    );

    const second = await drain.drainGroup("group-1", failingGraphiti as never);
    assertEquals(second.status, "dead-letter");
    assertEquals(await redis.getListLength(drainPendingKey("group-1")), 0);
    assertEquals(await redis.getListLength(drainDeadKey("group-1")), 1);
  });

  it("requeues abandoned claimed batches after lock loss and drains them", async () => {
    const { redis, events, drain } = createDeps();
    const first = createSessionEvent("message", "user", {
      summary: "first",
      body: "first",
    });
    const second = createSessionEvent("message", "user", {
      summary: "second",
      body: "second",
    });

    await events.recordEvent("session-1", "group-1", first);
    await events.recordEvent("session-1", "group-1", second);

    const claimed = await events.getPendingBatch("group-1", 2, 20_000);
    assertEquals(claimed?.entries.map((entry) => entry.event.id), [
      first.id,
      second.id,
    ]);
    assertEquals(await redis.getListLength(drainPendingKey("group-1")), 0);

    await redis.deleteKey(drainClaimLockKey("group-1"));

    const added: string[] = [];
    const result = await drain.drainGroup("group-1", {
      addMemory(input: { name: string }) {
        added.push(input.name);
      },
    } as never);

    assertEquals(result, { status: "success", drained: 2 });
    assertEquals(added, [`message:${first.id}`, `message:${second.id}`]);
    assertEquals(await redis.getListLength(drainPendingKey("group-1")), 0);
    assertEquals(
      await redis.getListLength(drainClaimKey("group-1", claimed!.claimToken)),
      0,
    );
    assertEquals(await redis.getString(drainClaimActiveKey("group-1")), null);
  });

  it("can recover an abandoned claim before the next drain attempt", async () => {
    const { redis, events } = createDeps();
    const first = createSessionEvent("message", "user", {
      summary: "first",
      body: "first",
    });
    const second = createSessionEvent("message", "user", {
      summary: "second",
      body: "second",
    });

    await events.recordEvent("session-1", "group-1", first);
    await events.recordEvent("session-1", "group-1", second);

    const claimed = await events.getPendingBatch("group-1", 2, 20_000);
    await redis.deleteKey(drainClaimLockKey("group-1"));

    const recovered = await events.recoverAbandonedClaim("group-1");

    assertEquals(recovered, true);
    assertEquals(
      await redis.getListLength(drainClaimKey("group-1", claimed!.claimToken)),
      0,
    );
    const pendingRaw = await redis.getListRange(
      drainPendingKey("group-1"),
      0,
      -1,
    );
    assertEquals(
      pendingRaw.map((item) => JSON.parse(item).event.id),
      [second.id, first.id],
    );
  });

  it("keeps an active long-running drain claim alive so recovery cannot steal it", async () => {
    const { redis, events, drain } = createDeps();
    const first = createSessionEvent("message", "user", {
      summary: "first",
      body: "first",
    });
    const second = createSessionEvent("message", "user", {
      summary: "second",
      body: "second",
    });

    await events.recordEvent("session-1", "group-1", first);
    await events.recordEvent("session-1", "group-1", second);

    let firstAddStarted!: () => void;
    let finishFirstAdd!: () => void;
    const firstAddStartedPromise = new Promise<void>((resolve) => {
      firstAddStarted = resolve;
    });
    const finishFirstAddPromise = new Promise<void>((resolve) => {
      finishFirstAdd = resolve;
    });

    const added: string[] = [];
    const drainPromise = drain.drainGroup("group-1", {
      async addMemory(input: { name: string }) {
        added.push(input.name);
        if (added.length === 1) {
          firstAddStarted();
          await finishFirstAddPromise;
        }
      },
    } as never);

    await firstAddStartedPromise;
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const recoveredWhileActive = await events.recoverAbandonedClaim("group-1");
    const concurrentClaim = await events.getPendingBatch("group-1", 2, 20_000);

    assertEquals(recoveredWhileActive, false);
    assertEquals(concurrentClaim, null);

    finishFirstAdd();

    const result = await drainPromise;
    assertEquals(result, { status: "success", drained: 2 });
    assertEquals(added, [`message:${first.id}`, `message:${second.id}`]);
    assertEquals(await redis.getListLength(drainPendingKey("group-1")), 0);
    assertEquals(await redis.getString(drainClaimActiveKey("group-1")), null);
  });

  it("fails and requeues when heartbeat loses ownership during a long drain", async () => {
    const { redis, events, drain } = createDeps();
    const event = createSessionEvent("message", "user", {
      summary: "first",
      body: "first",
    });

    await events.recordEvent("session-1", "group-1", event);

    let started!: () => void;
    let release!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });

    const drainPromise = drain.drainGroup("group-1", {
      async addMemory() {
        started();
        await releasePromise;
      },
    } as never);

    await startedPromise;
    const activeToken = await redis.getString(drainClaimActiveKey("group-1"));
    assertEquals(typeof activeToken, "string");

    await redis.deleteKey(drainClaimLockKey("group-1"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();

    const result = await drainPromise;
    assertEquals(result.status, "retry");
    assertEquals(await redis.getListLength(drainPendingKey("group-1")), 1);
    assertEquals(await redis.getString(drainClaimActiveKey("group-1")), null);
    assertEquals(
      await redis.getString(
        drainRetryKey("group-1", `${event.id}:${event.id}`),
      ) !==
        null,
      true,
    );

    const recovered = await events.recoverAbandonedClaim("group-1");
    assertEquals(recovered, false);
  });
});
