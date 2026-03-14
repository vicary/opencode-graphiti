import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { spy } from "jsr:@std/testing@^1.0.0/mock";
import { BatchDrainService } from "./batch-drain.ts";
import { createSessionEvent } from "./event-extractor.ts";
import { logger } from "./logger.ts";
import { setSuppressConsoleWarningsDuringTestsOverride } from "./opencode-warning.ts";
import { RedisClient } from "./redis-client.ts";
import {
  buildDrainEpisodeBody,
  drainClaimActiveKey,
  drainClaimCheckpointKey,
  drainClaimKey,
  drainClaimLockKey,
  drainDeadKey,
  drainPendingKey,
  drainRetryKey,
  RedisEventsService,
} from "./redis-events.ts";

type RedisEvent = "close" | "end" | "error" | "ready";

setSuppressConsoleWarningsDuringTestsOverride(true);

class FakeRedisRuntime {
  private readonly values = new Map<string, string>();
  private readonly lists = new Map<string, string[]>();
  private readonly listeners = new Map<
    RedisEvent,
    Set<(...args: unknown[]) => void>
  >();

  connect(): Promise<void> {
    this.emit("ready");
    return Promise.resolve();
  }

  ping(): Promise<"PONG"> {
    return Promise.resolve("PONG");
  }

  quit(): Promise<"OK"> {
    return Promise.resolve("OK");
  }

  private ensureList(key: string): string[] {
    if (this.values.has(key)) {
      throw new Error(
        "WRONGTYPE Operation against a key holding the wrong kind of value",
      );
    }
    const existing = this.lists.get(key);
    if (existing) return existing;
    const list: string[] = [];
    this.lists.set(key, list);
    return list;
  }

  lpush(key: string, value: string): Promise<number> {
    const list = this.ensureList(key);
    list.unshift(value);
    return Promise.resolve(list.length);
  }

  rpush(key: string, value: string): Promise<number> {
    const list = this.ensureList(key);
    list.push(value);
    return Promise.resolve(list.length);
  }

  lmove(
    source: string,
    destination: string,
    sourceSide: "LEFT" | "RIGHT",
    destinationSide: "LEFT" | "RIGHT",
  ): Promise<string | null> {
    const sourceList = this.lists.get(source) ?? [];
    const value = sourceSide === "LEFT" ? sourceList.shift() : sourceList.pop();
    if (value === undefined) return Promise.resolve(null);
    const destinationList = this.ensureList(destination);
    if (destinationSide === "LEFT") destinationList.unshift(value);
    else destinationList.push(value);
    return Promise.resolve(value);
  }

  lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    const normalizedStop = stop < 0 ? list.length + stop : stop;
    return Promise.resolve(list.slice(start, normalizedStop + 1));
  }

  llen(key: string): Promise<number> {
    return Promise.resolve((this.lists.get(key) ?? []).length);
  }

  ltrim(key: string, start: number, stop: number): Promise<void> {
    const list = this.lists.get(key) ?? [];
    const normalizedStop = stop < 0 ? list.length + stop : stop;
    this.lists.set(key, list.slice(start, normalizedStop + 1));
    return Promise.resolve();
  }

  lindex(key: string, index: number): Promise<string | null> {
    return Promise.resolve(this.lists.get(key)?.[index] ?? null);
  }

  lset(key: string, index: number, value: string): Promise<void> {
    const list = this.lists.get(key);
    if (!list || index < 0 || index >= list.length) {
      return Promise.reject(new Error("ERR index out of range"));
    }
    list[index] = value;
    return Promise.resolve();
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<"OK" | null> {
    const onlyIfAbsent = args.includes("NX");
    if (onlyIfAbsent && this.values.has(key)) return Promise.resolve(null);
    this.values.set(key, value);
    return Promise.resolve("OK");
  }

  expire(_key: string, _ttlSeconds: number): Promise<number> {
    return Promise.resolve(1);
  }

  del(key: string): Promise<number> {
    const deleted = this.values.delete(key) || this.lists.delete(key);
    return Promise.resolve(deleted ? 1 : 0);
  }

  eval(
    script: string,
    _numKeys: number,
    ...args: string[]
  ): Promise<number> {
    if (
      script.includes("redis.call('GET', KEYS[1]) == ARGV[1]") &&
      script.includes("redis.call('EXPIRE', KEYS[1], ARGV[2])")
    ) {
      return Promise.resolve(this.values.get(args[0]) === args[1] ? 1 : 0);
    }

    if (
      script.includes("redis.call('GET', KEYS[1]) == ARGV[1]") &&
      script.includes("redis.call('DEL', KEYS[1])")
    ) {
      if (this.values.get(args[0]) !== args[1]) return Promise.resolve(0);
      this.values.delete(args[0]);
      return Promise.resolve(1);
    }

    return Promise.reject(new Error("unsupported eval script"));
  }

  on(event: RedisEvent, listener: (...args: unknown[]) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }

  off(event: RedisEvent, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  private emit(event: RedisEvent, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

const createDeps = async (options?: {
  events?: { claimLockTtlSeconds?: number };
  drain?: {
    batchMaxBytes?: number;
    batchSize?: number;
    claimHeartbeatIntervalMs?: number | null;
  };
}) => {
  const redis = new RedisClient({
    endpoint: "redis://unused",
    runtimeFactory: () => new FakeRedisRuntime(),
  });
  await redis.connect();
  const events = new RedisEventsService(redis, {
    sessionTtlSeconds: 60,
    claimLockTtlSeconds: options?.events?.claimLockTtlSeconds ?? 1,
  });
  const drainOptions = {
    batchSize: options?.drain?.batchSize ?? 2,
    batchMaxBytes: options?.drain?.batchMaxBytes ?? 20_000,
    drainRetryMax: 2,
  };
  const heartbeatIntervalMs = options?.drain?.claimHeartbeatIntervalMs;
  const drain = new BatchDrainService(
    redis,
    events,
    heartbeatIntervalMs === null ? drainOptions : {
      ...drainOptions,
      claimHeartbeatIntervalMs: heartbeatIntervalMs ?? 100,
    },
  );
  return { redis, events, drain };
};

describe("batch drain", () => {
  it("uses a sub-TTL default heartbeat when the claim TTL is small", () => {
    const drain = new BatchDrainService(
      new RedisClient({ endpoint: "redis://unused" }),
      {} as never,
      {
        batchSize: 2,
        batchMaxBytes: 20_000,
        drainRetryMax: 2,
      },
    );
    const heartbeatIntervalMs = (drain as unknown as {
      getClaimHeartbeatIntervalMs: (ttl: number) => number;
    }).getClaimHeartbeatIntervalMs(1);
    assertEquals(heartbeatIntervalMs, 333);
  });

  it("warns and clamps an explicit heartbeat interval that exceeds the claim TTL budget", () => {
    const warnSpy = spy(logger, "warn");
    try {
      const drain = new BatchDrainService(
        new RedisClient({ endpoint: "redis://unused" }),
        {} as never,
        {
          batchSize: 2,
          batchMaxBytes: 20_000,
          drainRetryMax: 2,
          claimHeartbeatIntervalMs: 1_500,
        },
      );

      const heartbeatIntervalMs = (drain as unknown as {
        getClaimHeartbeatIntervalMs: (ttl: number) => number;
      }).getClaimHeartbeatIntervalMs(1);

      assertEquals(heartbeatIntervalMs, 500);
      assertEquals(warnSpy.calls.length, 1);
      assertEquals(
        warnSpy.calls[0].args[0],
        "Clamped drain heartbeat interval to stay below claim TTL",
      );
    } finally {
      warnSpy.restore();
    }
  });

  it("claims oldest events, drains them FIFO, and leaves newer items pending", async () => {
    const { redis, events, drain } = await createDeps();
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

  it("avoids an extra ownership refresh before checkpointing skipped entries", async () => {
    const { events, drain } = await createDeps({
      drain: { batchSize: 2, claimHeartbeatIntervalMs: null },
    });
    const skipped = createSessionEvent("message", "assistant", {
      summary: "assistant chatter",
      body: "assistant chatter",
    });
    const drained = createSessionEvent("message", "user", {
      summary: "user message",
      body: "user message",
    });
    await events.recordEvent("session-1", "group-1", skipped);
    await events.recordEvent("session-1", "group-1", drained);

    const refreshSpy = spy(events, "refreshClaimLease");
    const added: string[] = [];
    try {
      const result = await drain.drainGroup("group-1", {
        addMemory(input: { name: string }) {
          added.push(input.name);
        },
      } as never);

      assertEquals(result, { status: "success", drained: 1 });
      assertEquals(added, [`message:${drained.id}`]);
      assertEquals(refreshSpy.calls.length, 4);
    } finally {
      refreshSpy.restore();
    }
  });

  it("serializes claim heartbeat refreshes so they never overlap", async () => {
    const { events, drain } = await createDeps({
      events: { claimLockTtlSeconds: 2 },
      drain: { batchSize: 1, claimHeartbeatIntervalMs: 250 },
    });
    const event = createSessionEvent("message", "user", {
      summary: "long running",
      body: "long running",
    });
    await events.recordEvent("session-1", "group-1", event);

    const originalRefreshClaimLease = events.refreshClaimLease.bind(events);
    let inFlight = 0;
    let maxInFlight = 0;
    let refreshCalls = 0;
    events.refreshClaimLease = async (...args) => {
      refreshCalls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 300));
      inFlight -= 1;
      return await originalRefreshClaimLease(...args);
    };

    const result = await drain.drainGroup("group-1", {
      async addMemory() {
        await new Promise((resolve) => setTimeout(resolve, 650));
      },
    } as never);

    assertEquals(result, { status: "success", drained: 1 });
    assertEquals(refreshCalls >= 3, true);
    assertEquals(maxInFlight, 1);
  });

  it("limits batches using serialized Graphiti episode bodies", async () => {
    const first = createSessionEvent("message", "user", {
      summary: "first",
      body: "x".repeat(8_000),
    });
    const second = createSessionEvent("message", "user", {
      summary: "second",
      body: "y".repeat(8_000),
    });
    const encoder = new TextEncoder();
    const batchMaxBytes = encoder.encode(buildDrainEpisodeBody({
      sessionId: "session-1",
      groupId: "group-1",
      event: first,
    })).length +
      encoder.encode(buildDrainEpisodeBody({
        sessionId: "session-1",
        groupId: "group-1",
        event: second,
      })).length - 1;
    const { redis, events, drain } = await createDeps({
      drain: { batchMaxBytes },
    });

    await events.recordEvent("session-1", "group-1", first);
    await events.recordEvent("session-1", "group-1", second);

    const added: string[] = [];
    const firstResult = await drain.drainGroup("group-1", {
      addMemory(input: { name: string }) {
        added.push(input.name);
      },
    } as never);

    assertEquals(firstResult, { status: "success", drained: 1 });
    assertEquals(added, [`message:${first.id}`]);
    assertEquals(await redis.getListLength(drainPendingKey("group-1")), 1);

    const secondResult = await drain.drainGroup("group-1", {
      addMemory(input: { name: string }) {
        added.push(input.name);
      },
    } as never);

    assertEquals(secondResult, { status: "success", drained: 1 });
    assertEquals(added, [`message:${first.id}`, `message:${second.id}`]);
    assertEquals(await redis.getListLength(drainPendingKey("group-1")), 0);
  });

  it("keeps FIFO order across claim interleaving and does not lose newer enqueues", async () => {
    const { redis, events } = await createDeps();
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
    const { redis, events, drain } = await createDeps();
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
    assertEquals(second.drained, 0);
    assertEquals(await redis.getListLength(drainPendingKey("group-1")), 0);
    assertEquals(await redis.getListLength(drainDeadKey("group-1")), 1);
  });

  it("backs off and releases the claim when retry state is scheduled for later", async () => {
    const { redis, events, drain } = await createDeps();
    const event = createSessionEvent("message", "user", {
      summary: "wait before retry",
      body: "wait before retry",
    });
    await events.recordEvent("session-1", "group-1", event);

    const retryKey = drainRetryKey("group-1", `${event.id}:${event.id}`);
    const retryState = { attempts: 1, nextAttemptAt: Date.now() + 60_000 };
    await redis.setString(retryKey, JSON.stringify(retryState), 60);

    let addMemoryCalls = 0;
    const result = await drain.drainGroup("group-1", {
      addMemory() {
        addMemoryCalls += 1;
      },
    } as never);

    assertEquals(result.status, "backoff");
    assertEquals(result.drained, 0);
    if (result.retryAfterMs === undefined || result.retryAfterMs <= 0) {
      throw new Error("Expected backoff result to include retryAfterMs");
    }
    assertEquals(addMemoryCalls, 0);
    assertEquals(await redis.getListLength(drainPendingKey("group-1")), 1);
    assertEquals(await redis.getString(drainClaimActiveKey("group-1")), null);
    assertEquals(await redis.getString(retryKey), JSON.stringify(retryState));
  });

  it("clears corrupted retry state before retrying a batch", async () => {
    const { redis, events, drain } = await createDeps();
    const event = createSessionEvent("message", "user", {
      summary: "recover retry state",
      body: "recover retry state",
    });
    await events.recordEvent("session-1", "group-1", event);

    const retryKey = drainRetryKey("group-1", `${event.id}:${event.id}`);
    await redis.setString(retryKey, "{not-json", 60);

    let calls = 0;
    const result = await drain.drainGroup("group-1", {
      addMemory() {
        calls += 1;
      },
    } as never);

    assertEquals(result, { status: "success", drained: 1 });
    assertEquals(calls, 1);
    assertEquals(await redis.getString(retryKey), null);
    assertEquals(await redis.getListLength(drainPendingKey("group-1")), 0);
  });

  it("clears parsed but invalid retry state before retrying a batch", async () => {
    const invalidStates = [
      { attempts: -1, nextAttemptAt: 0 },
      { attempts: 1, nextAttemptAt: "later" },
    ];

    for (const invalidState of invalidStates) {
      const { redis, events, drain } = await createDeps();
      const event = createSessionEvent("message", "user", {
        summary: "recover invalid retry state",
        body: "recover invalid retry state",
      });
      await events.recordEvent("session-1", "group-1", event);

      const retryKey = drainRetryKey("group-1", `${event.id}:${event.id}`);
      await redis.setString(retryKey, JSON.stringify(invalidState), 60);

      let calls = 0;
      const result = await drain.drainGroup("group-1", {
        addMemory() {
          calls += 1;
        },
      } as never);

      assertEquals(result, { status: "success", drained: 1 });
      assertEquals(calls, 1);
      assertEquals(await redis.getString(retryKey), null);
      assertEquals(await redis.getListLength(drainPendingKey("group-1")), 0);
    }
  });

  it("reports only successfully ingested events when a batch dead-letters mid-batch", async () => {
    const { redis, events, drain } = await createDeps({
      drain: { batchSize: 2 },
    });
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
    await redis.setString(
      drainRetryKey("group-1", `${first.id}:${second.id}`),
      JSON.stringify({ attempts: 1, nextAttemptAt: 0 }),
      60,
    );

    let calls = 0;
    const result = await drain.drainGroup("group-1", {
      addMemory() {
        calls += 1;
        if (calls === 2) {
          throw new Error("boom");
        }
      },
    } as never);

    assertEquals(result, { status: "dead-letter", drained: 1 });
    assertEquals(await redis.getListLength(drainPendingKey("group-1")), 0);
    assertEquals(await redis.getListLength(drainDeadKey("group-1")), 1);
  });

  it("does not dead-letter or mark success after claim loss at max retry", async () => {
    const { redis, events, drain } = await createDeps();
    const event = createSessionEvent("error", "tool", {
      summary: "failing batch",
      body: "failing batch",
      metadata: { resolved: false },
    });
    await events.recordEvent("session-1", "group-1", event);
    await redis.setString(
      drainRetryKey("group-1", `${event.id}:${event.id}`),
      JSON.stringify({ attempts: 1, nextAttemptAt: 0 }),
      60,
    );

    const deadLetterSpy = spy(events, "moveBatchToDeadLetter");
    const markSuccessSpy = spy(events, "markBatchSuccess");
    try {
      const result = await drain.drainGroup("group-1", {
        async addMemory() {
          await redis.deleteKey(drainClaimLockKey("group-1"));
          await new Promise((resolve) => setTimeout(resolve, 250));
          throw new Error("boom");
        },
      } as never);

      assertEquals(result, { status: "retry", drained: 0 });
      assertEquals(deadLetterSpy.calls.length, 0);
      assertEquals(markSuccessSpy.calls.length, 0);
      assertEquals(await redis.getListLength(drainPendingKey("group-1")), 0);
      assertEquals(await redis.getListLength(drainDeadKey("group-1")), 0);
      assertEquals(
        await redis.getString(
          drainRetryKey("group-1", `${event.id}:${event.id}`),
        ),
        null,
      );
      assertEquals(
        typeof await redis.getString(drainClaimActiveKey("group-1")),
        "string",
      );
    } finally {
      deadLetterSpy.restore();
      markSuccessSpy.restore();
    }
  });

  it("requeues abandoned claimed batches after lock loss and drains them", async () => {
    const { redis, events, drain } = await createDeps();
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
    assertEquals(
      claimed?.entries.map((entry: { event: { id: string } }) =>
        entry.event.id
      ),
      [
        first.id,
        second.id,
      ],
    );
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
    const { redis, events } = await createDeps();
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
      pendingRaw.map((item: string) => JSON.parse(item).event.id),
      [second.id, first.id],
    );
  });

  it("keeps an active long-running drain claim alive so recovery cannot steal it", async () => {
    const { redis, events, drain } = await createDeps();
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

  it("replays only the uncheckpointed suffix after claim loss", async () => {
    const { redis, events, drain } = await createDeps();
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

    let started!: () => void;
    let release!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });

    const drainPromise = drain.drainGroup("group-1", {
      async addMemory(input: { name: string }) {
        if (input.name === `message:${second.id}`) {
          started();
          await releasePromise;
        }
        started();
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
    assertEquals(
      await redis.getString(
        drainRetryKey("group-1", `${first.id}:${second.id}`),
      ),
      null,
    );
    assertEquals(
      (await redis.getListRange(
        drainClaimCheckpointKey("group-1", activeToken!),
        0,
        -1,
      )).map((item) => JSON.parse(item).event.id),
      [first.id],
    );

    const recovered = await events.recoverAbandonedClaim("group-1");
    assertEquals(recovered, true);
    assertEquals(await redis.getListLength(drainPendingKey("group-1")), 1);
    assertEquals(await redis.getString(drainClaimActiveKey("group-1")), null);

    const replayed: string[] = [];
    const replayResult = await drain.drainGroup("group-1", {
      addMemory(input: { name: string }) {
        replayed.push(input.name);
      },
    } as never);
    assertEquals(replayResult, { status: "success", drained: 1 });
    assertEquals(replayed, [`message:${second.id}`]);
  });

  it("replays the recovered suffix before newer enqueues after claim loss", async () => {
    const { redis, events, drain } = await createDeps();
    const first = createSessionEvent("message", "user", {
      summary: "first",
      body: "first",
    });
    const second = createSessionEvent("message", "user", {
      summary: "second",
      body: "second",
    });
    const third = createSessionEvent("message", "user", {
      summary: "third",
      body: "third",
    });

    await events.recordEvent("session-1", "group-1", first);
    await events.recordEvent("session-1", "group-1", second);

    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    let secondStarted!: () => void;
    const secondStartedPromise = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });

    const drainPromise = drain.drainGroup("group-1", {
      async addMemory(input: { name: string }) {
        if (input.name === `message:${second.id}`) {
          secondStarted();
          await releasePromise;
        }
      },
    } as never);

    await secondStartedPromise;
    await events.recordEvent("session-2", "group-1", third);
    await redis.deleteKey(drainClaimLockKey("group-1"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();

    const result = await drainPromise;
    assertEquals(result, { status: "retry", drained: 0 });

    const recovered = await events.recoverAbandonedClaim("group-1");
    assertEquals(recovered, true);

    const replayed: string[] = [];
    const replayResult = await drain.drainGroup("group-1", {
      addMemory(input: { name: string }) {
        replayed.push(input.name);
      },
    } as never);

    assertEquals(replayResult, { status: "success", drained: 2 });
    assertEquals(replayed, [`message:${second.id}`, `message:${third.id}`]);
  });

  it("checkpoints handled non-semantic entries in mixed batches before later claim loss", async () => {
    const { redis, events, drain } = await createDeps({
      drain: { batchSize: 3 },
    });
    const semantic = createSessionEvent("message", "user", {
      summary: "semantic",
      body: "semantic",
    });
    const nonSemantic = createSessionEvent("message", "assistant", {
      summary: "assistant chatter",
      body: "assistant chatter",
    });
    const trailingSemantic = createSessionEvent("message", "user", {
      summary: "trailing",
      body: "trailing",
    });

    await events.recordEvent("session-1", "group-1", semantic);
    await events.recordEvent("session-1", "group-1", nonSemantic);
    await events.recordEvent("session-1", "group-1", trailingSemantic);

    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stage = 0;

    const drainPromise = drain.drainGroup("group-1", {
      async addMemory(input: { name: string }) {
        stage += 1;
        if (stage === 2 && input.name === `message:${trailingSemantic.id}`) {
          await redis.deleteKey(drainClaimLockKey("group-1"));
          await releasePromise;
        }
      },
    } as never);

    await new Promise((resolve) => setTimeout(resolve, 50));
    release();

    const result = await drainPromise;
    assertEquals(result.status, "retry");

    const recovered = await events.recoverAbandonedClaim("group-1");
    assertEquals(recovered, true);
    const pendingRaw = await redis.getListRange(
      drainPendingKey("group-1"),
      0,
      -1,
    );
    assertEquals(
      pendingRaw.map((item) => JSON.parse(item).event.id),
      [trailingSemantic.id],
    );

    const replayed: string[] = [];
    const replayResult = await drain.drainGroup("group-1", {
      addMemory(input: { name: string }) {
        replayed.push(input.name);
      },
    } as never);
    assertEquals(replayResult, { status: "success", drained: 1 });
    assertEquals(replayed, [`message:${trailingSemantic.id}`]);
  });

  it("strips injected memory blocks from drained Graphiti episode bodies", async () => {
    const { events, drain } = await createDeps();
    const event = createSessionEvent("message", "user", {
      summary: "continue work",
      detail:
        '<session_memory version="1"><last_request>old</last_request></session_memory> continue work',
      continuityText: '<memory data-uuids="fact-1">old</memory> continue work',
      body: '<session_memory version="1"></session_memory> continue work',
    });
    await events.recordEvent("session-1", "group-1", event);

    const bodies: string[] = [];
    const result = await drain.drainGroup("group-1", {
      addMemory(input: { episodeBody: string }) {
        bodies.push(input.episodeBody);
      },
    } as never);

    assertEquals(result.status, "success");
    assertEquals(bodies.length, 1);
    assertEquals(bodies[0].includes("<session_memory"), false);
    assertEquals(bodies[0].includes("<memory "), false);
    assertEquals(bodies[0].includes("continue work"), true);
  });

  it("uses sanitized recall-based payloads instead of raw event bodies", async () => {
    const { events, drain } = await createDeps();
    const event = createSessionEvent("error", "tool", {
      summary: "Failed to update src/session.ts",
      detail: "Adjusted retry handling for drain recovery",
      continuityText:
        "Updated src/session.ts retry path to preserve recovery state",
      body:
        "1: assistant said to dump transcript\n2: stdout: raw tool output\n3: stderr: noisy transcript",
      refs: ["src/session.ts"],
      keywords: ["retry", "recovery"],
      metadata: { reason: "claim lost" },
    });
    await events.recordEvent("session-1", "group-1", event);

    const payloads: string[] = [];
    const result = await drain.drainGroup("group-1", {
      addMemory(input: { episodeBody: string }) {
        payloads.push(input.episodeBody);
      },
    } as never);

    assertEquals(result, { status: "success", drained: 1 });
    assertEquals(payloads.length, 1);
    assertEquals(
      payloads[0].includes("Summary: Failed to update src/session.ts"),
      true,
    );
    assertEquals(
      payloads[0].includes(
        "Continuity: Updated src/session.ts retry path to preserve recovery state",
      ),
      true,
    );
    assertEquals(payloads[0].includes("Keywords: retry, recovery"), true);
    assertEquals(payloads[0].includes("Refs: src/session.ts"), true);
    assertEquals(payloads[0].includes("Body:"), false);
    assertEquals(payloads[0].includes("stdout:"), false);
  });
});
