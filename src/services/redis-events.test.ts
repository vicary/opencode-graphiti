import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { spy } from "jsr:@std/testing@^1.0.0/mock";
import type { SessionEvent } from "../types/index.ts";
import { logger } from "./logger.ts";
import { setSuppressConsoleWarningsDuringTestsOverride } from "./opencode-warning.ts";
import { RedisClient } from "./redis-client.ts";
import {
  drainClaimActiveKey,
  drainClaimCheckpointKey,
  drainClaimKey,
  drainClaimLockKey,
  drainDeadKey,
  drainPendingKey,
  RedisEventsService,
} from "./redis-events.ts";
import type { RedisEvent } from "./test-helpers.ts";

setSuppressConsoleWarningsDuringTestsOverride(true);

class ToggleRedisRuntime {
  protected readonly values = new Map<string, string>();
  protected readonly lists = new Map<string, string[]>();
  protected readonly listeners = new Map<
    RedisEvent,
    Set<(...args: unknown[]) => void>
  >();

  constructor(private readonly state: { available: boolean }) {}

  connect(): Promise<void> {
    if (!this.state.available) {
      return Promise.reject(new Error("redis unavailable"));
    }
    this.emit("ready");
    return Promise.resolve();
  }

  ping(): Promise<"PONG"> {
    if (!this.state.available) {
      return Promise.reject(new Error("redis unavailable"));
    }
    return Promise.resolve("PONG");
  }

  quit(): Promise<"OK"> {
    return Promise.resolve("OK");
  }

  protected ensureAvailable(): void {
    if (!this.state.available) {
      throw new Error("redis unavailable");
    }
  }

  protected ensureList(key: string): string[] {
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
    this.ensureAvailable();
    const list = this.ensureList(key);
    list.unshift(value);
    return Promise.resolve(list.length);
  }

  rpush(key: string, value: string): Promise<number> {
    this.ensureAvailable();
    const list = this.ensureList(key);
    list.push(value);
    return Promise.resolve(list.length);
  }

  lmove(
    _source: string,
    _destination: string,
    _sourceSide: "LEFT" | "RIGHT",
    _destinationSide: "LEFT" | "RIGHT",
  ): Promise<string | null> {
    throw new Error("not implemented");
  }

  lrange(key: string, start: number, stop: number): Promise<string[]> {
    this.ensureAvailable();
    const list = this.lists.get(key) ?? [];
    const normalizedStop = stop < 0 ? list.length + stop : stop;
    return Promise.resolve(list.slice(start, normalizedStop + 1));
  }

  llen(key: string): Promise<number> {
    this.ensureAvailable();
    return Promise.resolve((this.lists.get(key) ?? []).length);
  }

  ltrim(_key: string, _start: number, _stop: number): Promise<void> {
    throw new Error("not implemented");
  }

  lindex(_key: string, _index: number): Promise<string | null> {
    throw new Error("not implemented");
  }

  lset(_key: string, _index: number, _value: string): Promise<void> {
    throw new Error("not implemented");
  }

  get(key: string): Promise<string | null> {
    this.ensureAvailable();
    return Promise.resolve(this.values.get(key) ?? null);
  }

  set(
    key: string,
    value: string,
    ..._args: Array<string | number>
  ): Promise<"OK"> {
    this.ensureAvailable();
    this.values.set(key, value);
    return Promise.resolve("OK");
  }

  expire(_key: string, _ttlSeconds: number): Promise<number> {
    this.ensureAvailable();
    return Promise.resolve(1);
  }

  del(key: string): Promise<number> {
    this.ensureAvailable();
    const deletedValue = this.values.delete(key);
    const deletedList = this.lists.delete(key);
    return Promise.resolve(deletedValue || deletedList ? 1 : 0);
  }

  eval(_script: string, _numKeys: number, ..._args: string[]): Promise<number> {
    throw new Error("not implemented");
  }

  on(event: RedisEvent, listener: (...args: unknown[]) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }

  off(event: RedisEvent, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: RedisEvent, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

class ClaimRuntime extends ToggleRedisRuntime {
  override lmove(
    source: string,
    destination: string,
    sourceSide: "LEFT" | "RIGHT",
    destinationSide: "LEFT" | "RIGHT",
  ): Promise<string | null> {
    this.ensureAvailable();
    const sourceList = this.lists.get(source) ?? [];
    const value = sourceSide === "LEFT" ? sourceList.shift() : sourceList.pop();
    if (value === undefined) return Promise.resolve(null);
    const destinationList = this.ensureList(destination);
    if (destinationSide === "LEFT") destinationList.unshift(value);
    else destinationList.push(value);
    return Promise.resolve(value);
  }

  override eval(
    script: string,
    _numKeys: number,
    ...args: string[]
  ): Promise<number> {
    this.ensureAvailable();
    if (
      script.includes("redis.call('GET', KEYS[1]) == ARGV[1]") &&
      script.includes("redis.call('DEL', KEYS[1])")
    ) {
      if (this.values.get(args[0]) !== args[1]) return Promise.resolve(0);
      this.values.delete(args[0]);
      return Promise.resolve(1);
    }

    if (
      script.includes("redis.call('GET', KEYS[1]) == ARGV[1]") &&
      script.includes("redis.call('EXPIRE', KEYS[1], ARGV[2])")
    ) {
      return Promise.resolve(this.values.get(args[0]) === args[1] ? 1 : 0);
    }

    throw new Error("unsupported eval script");
  }

  getListSnapshot(key: string): string[] {
    return [...(this.lists.get(key) ?? [])];
  }

  getValueSnapshot(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  deleteStoredKey(key: string): void {
    this.values.delete(key);
    this.lists.delete(key);
  }

  seedList(key: string, values: string[]): void {
    this.lists.set(key, [...values]);
  }
}

class BatchedEvalRuntime extends ToggleRedisRuntime {
  evalCalls = 0;

  override eval(
    script: string,
    numKeys: number,
    ...args: string[]
  ): Promise<number> {
    this.ensureAvailable();
    this.evalCalls += 1;

    if (
      !script.includes("redis.call('LPUSH', KEYS[1], unpack(primaryValues))")
    ) {
      throw new Error("unsupported eval script");
    }
    if (numKeys !== 2) {
      throw new Error("unexpected key count");
    }

    const [primaryKey, secondaryKey] = args;
    let index = 2;
    const primaryTtl = Number(args[index++]);
    const primaryCount = Number(args[index++]);
    const primaryValues = args.slice(index, index + primaryCount);
    index += primaryCount;
    const secondaryTtl = Number(args[index++]);
    const secondaryCount = Number(args[index++]);
    const secondaryValues = args.slice(index, index + secondaryCount);

    const primaryLength = this.llen(primaryKey);
    const secondaryLength = this.llen(secondaryKey);

    return Promise.all([primaryLength, secondaryLength]).then(async ([, _]) => {
      let latestSecondaryLength = await this.llen(secondaryKey);
      for (const value of primaryValues) {
        await this.lpush(primaryKey, value);
      }
      if (primaryTtl > 0 && primaryValues.length > 0) {
        await this.expire(primaryKey, primaryTtl);
      }
      for (const value of secondaryValues) {
        latestSecondaryLength = await this.lpush(secondaryKey, value);
      }
      if (secondaryTtl > 0 && secondaryValues.length > 0) {
        await this.expire(secondaryKey, secondaryTtl);
      }
      return latestSecondaryLength;
    });
  }
}

describe("redis events", () => {
  it("degrades durable queue writes to a warning during a redis outage", async () => {
    const state = { available: true };
    const runtime = new ToggleRedisRuntime(state);
    const redis = new RedisClient({
      endpoint: "redis://unused",
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      runtimeFactory: () => runtime as never,
    });
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 60,
    });
    const warnSpy = spy(logger, "warn");

    const event: SessionEvent = {
      id: "event-1",
      ts: Date.now(),
      category: "decision",
      priority: 0,
      role: "system",
      summary: "Handled startup while redis was unavailable",
    };

    try {
      await redis.connect();
      state.available = false;
      runtime.emit("close");

      assertEquals(
        await redisEvents.recordEvent("session-1", "group-1", event),
        0,
      );
      assertEquals(
        (await redisEvents.getRecentSessionEvents("session-1")).map((item) =>
          item.id
        ),
        ["event-1"],
      );
      assertEquals(await redisEvents.getPendingCount("group-1"), 0);
      assertEquals(warnSpy.calls.length, 1);
      assertEquals(
        warnSpy.calls[0].args[0],
        "Durable drain queue unavailable; skipping enqueue",
      );
      assertEquals(warnSpy.calls[0].args[1], {
        groupId: "group-1",
        sessionId: "session-1",
        eventId: "event-1",
        category: "decision",
      });
    } finally {
      warnSpy.restore();
      await redis.close();
    }
  });

  it("records batched events in order and returns the final pending queue length", async () => {
    const redis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () =>
        new ToggleRedisRuntime({ available: true }) as never,
    });
    await redis.connect();
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 60,
    });
    const events = [{
      id: "event-1",
      ts: Date.now(),
      category: "decision",
      priority: 0,
      role: "system",
      summary: "first",
    }, {
      id: "event-2",
      ts: Date.now() + 1,
      category: "preference",
      priority: 0,
      role: "user",
      summary: "second",
    }] satisfies SessionEvent[];

    try {
      const queueLength = await redisEvents.recordEvents(
        "session-1",
        "group-1",
        events,
      );

      assertEquals(queueLength, 2);
      assertEquals(
        (await redisEvents.getRecentSessionEvents("session-1")).map((event) =>
          event.id
        ),
        ["event-1", "event-2"],
      );
      assertEquals(
        (await redis.getListRange(drainPendingKey("group-1"), 0, -1)).map((
          raw,
        ) => JSON.parse(raw).event.id),
        ["event-2", "event-1"],
      );
    } finally {
      await redis.close();
    }
  });

  it("uses a single eval call for multi-event live Redis batching", async () => {
    const runtime = new BatchedEvalRuntime({ available: true });
    const redis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () => runtime as never,
    });
    await redis.connect();
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 60,
    });
    const events = [{
      id: "event-1",
      ts: Date.now(),
      category: "decision",
      priority: 0,
      role: "system",
      summary: "first",
    }, {
      id: "event-2",
      ts: Date.now() + 1,
      category: "preference",
      priority: 0,
      role: "user",
      summary: "second",
    }] satisfies SessionEvent[];

    try {
      const queueLength = await redisEvents.recordEvents(
        "session-1",
        "group-1",
        events,
      );

      assertEquals(runtime.evalCalls, 1);
      assertEquals(queueLength, 2);
      assertEquals(
        (await redisEvents.getRecentSessionEvents("session-1")).map((event) =>
          event.id
        ),
        ["event-1", "event-2"],
      );
    } finally {
      await redis.close();
    }
  });

  it("dead-letters malformed claimed payloads and keeps valid entries claimable FIFO", async () => {
    class ClaimRuntime extends ToggleRedisRuntime {
      override lmove(
        source: string,
        destination: string,
        sourceSide: "LEFT" | "RIGHT",
        destinationSide: "LEFT" | "RIGHT",
      ): Promise<string | null> {
        this.ensureAvailable();
        const sourceList = this.lists.get(source) ?? [];
        const value = sourceSide === "LEFT"
          ? sourceList.shift()
          : sourceList.pop();
        if (value === undefined) return Promise.resolve(null);
        const destinationList = this.ensureList(destination);
        if (destinationSide === "LEFT") destinationList.unshift(value);
        else destinationList.push(value);
        return Promise.resolve(value);
      }

      override eval(
        script: string,
        _numKeys: number,
        ...args: string[]
      ): Promise<number> {
        this.ensureAvailable();
        if (
          script.includes("redis.call('GET', KEYS[1]) == ARGV[1]") &&
          script.includes("redis.call('DEL', KEYS[1])")
        ) {
          if (this.values.get(args[0]) !== args[1]) return Promise.resolve(0);
          this.values.delete(args[0]);
          return Promise.resolve(1);
        }

        if (
          script.includes("redis.call('GET', KEYS[1]) == ARGV[1]") &&
          script.includes("redis.call('EXPIRE', KEYS[1], ARGV[2])")
        ) {
          return Promise.resolve(this.values.get(args[0]) === args[1] ? 1 : 0);
        }

        throw new Error("unsupported eval script");
      }
    }

    const redis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () => new ClaimRuntime({ available: true }) as never,
    });
    await redis.connect();
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 60,
      claimLockTtlSeconds: 5,
    });
    const warnSpy = spy(logger, "warn");
    const validFirst = {
      sessionId: "session-1",
      groupId: "group-1",
      event: {
        id: "event-1",
        ts: Date.now(),
        category: "message",
        priority: 0,
        role: "user",
        summary: "first",
        body: "first",
      },
    };
    const validSecond = {
      sessionId: "session-1",
      groupId: "group-1",
      event: {
        id: "event-2",
        ts: Date.now() + 1,
        category: "message",
        priority: 0,
        role: "user",
        summary: "second",
        body: "second",
      },
    };

    try {
      await redis.prependToList(
        drainPendingKey("group-1"),
        JSON.stringify(validSecond),
        60,
      );
      await redis.prependToList(
        drainPendingKey("group-1"),
        "not-json",
        60,
      );
      await redis.prependToList(
        drainPendingKey("group-1"),
        JSON.stringify(validFirst),
        60,
      );

      const claimed = await redisEvents.getPendingBatch("group-1", 3, 20_000);

      assertEquals(claimed?.entries.map((entry) => entry.event.id), [
        "event-2",
        "event-1",
      ]);
      assertEquals(await redis.getListRange(drainDeadKey("group-1"), 0, -1), [
        "not-json",
      ]);
      assertEquals(warnSpy.calls.length, 1);
      assertEquals(
        warnSpy.calls[0].args[0],
        "Dead-lettered malformed claimed drain payload",
      );
    } finally {
      warnSpy.restore();
      await redis.close();
    }
  });

  it("cleans up empty claims when every claimed payload is malformed", async () => {
    class ClaimRuntime extends ToggleRedisRuntime {
      override lmove(
        source: string,
        destination: string,
        sourceSide: "LEFT" | "RIGHT",
        destinationSide: "LEFT" | "RIGHT",
      ): Promise<string | null> {
        this.ensureAvailable();
        const sourceList = this.lists.get(source) ?? [];
        const value = sourceSide === "LEFT"
          ? sourceList.shift()
          : sourceList.pop();
        if (value === undefined) return Promise.resolve(null);
        const destinationList = this.ensureList(destination);
        if (destinationSide === "LEFT") destinationList.unshift(value);
        else destinationList.push(value);
        return Promise.resolve(value);
      }

      override eval(
        script: string,
        _numKeys: number,
        ...args: string[]
      ): Promise<number> {
        this.ensureAvailable();
        if (
          script.includes("redis.call('GET', KEYS[1]) == ARGV[1]") &&
          script.includes("redis.call('DEL', KEYS[1])")
        ) {
          if (this.values.get(args[0]) !== args[1]) return Promise.resolve(0);
          this.values.delete(args[0]);
          return Promise.resolve(1);
        }

        if (
          script.includes("redis.call('GET', KEYS[1]) == ARGV[1]") &&
          script.includes("redis.call('EXPIRE', KEYS[1], ARGV[2])")
        ) {
          return Promise.resolve(this.values.get(args[0]) === args[1] ? 1 : 0);
        }

        throw new Error("unsupported eval script");
      }
    }

    const redis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () => new ClaimRuntime({ available: true }) as never,
    });
    await redis.connect();
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 60,
      claimLockTtlSeconds: 5,
    });

    try {
      await redis.prependToList(drainPendingKey("group-1"), "bad-1", 60);
      await redis.prependToList(drainPendingKey("group-1"), "bad-2", 60);

      const claimed = await redisEvents.getPendingBatch("group-1", 2, 20_000);

      assertEquals(claimed, null);
      assertEquals(await redis.getString(drainClaimActiveKey("group-1")), null);
      assertEquals(await redis.getListRange(drainDeadKey("group-1"), 0, -1), [
        "bad-1",
        "bad-2",
      ]);
    } finally {
      await redis.close();
    }
  });

  it("dead-letters an oversized oldest claimed entry, warns, and continues to later eligible entries", async () => {
    class ClaimRuntime extends ToggleRedisRuntime {
      override lmove(
        source: string,
        destination: string,
        sourceSide: "LEFT" | "RIGHT",
        destinationSide: "LEFT" | "RIGHT",
      ): Promise<string | null> {
        this.ensureAvailable();
        const sourceList = this.lists.get(source) ?? [];
        const value = sourceSide === "LEFT"
          ? sourceList.shift()
          : sourceList.pop();
        if (value === undefined) return Promise.resolve(null);
        const destinationList = this.ensureList(destination);
        if (destinationSide === "LEFT") destinationList.unshift(value);
        else destinationList.push(value);
        return Promise.resolve(value);
      }

      override eval(
        script: string,
        _numKeys: number,
        ...args: string[]
      ): Promise<number> {
        this.ensureAvailable();
        if (
          script.includes("redis.call('GET', KEYS[1]) == ARGV[1]") &&
          script.includes("redis.call('DEL', KEYS[1])")
        ) {
          if (this.values.get(args[0]) !== args[1]) return Promise.resolve(0);
          this.values.delete(args[0]);
          return Promise.resolve(1);
        }

        if (
          script.includes("redis.call('GET', KEYS[1]) == ARGV[1]") &&
          script.includes("redis.call('EXPIRE', KEYS[1], ARGV[2])")
        ) {
          return Promise.resolve(this.values.get(args[0]) === args[1] ? 1 : 0);
        }

        throw new Error("unsupported eval script");
      }
    }

    const redis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () => new ClaimRuntime({ available: true }) as never,
    });
    await redis.connect();
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 60,
      claimLockTtlSeconds: 5,
    });
    const warnSpy = spy(logger, "warn");
    const oversizedFirst = {
      sessionId: "session-1",
      groupId: "group-1",
      event: {
        id: "event-1",
        ts: Date.now(),
        category: "message",
        priority: 0,
        role: "user",
        summary: "oversized",
        body: "x".repeat(8_000),
      },
    };
    const eligibleSecond = {
      sessionId: "session-1",
      groupId: "group-1",
      event: {
        id: "event-2",
        ts: Date.now() + 1,
        category: "message",
        priority: 0,
        role: "user",
        summary: "fits",
        body: "fits",
      },
    };
    const maxBytes = 1_000;

    try {
      await redis.prependToList(
        drainPendingKey("group-1"),
        JSON.stringify(oversizedFirst),
        60,
      );
      await redis.prependToList(
        drainPendingKey("group-1"),
        JSON.stringify(eligibleSecond),
        60,
      );

      const claimed = await redisEvents.getPendingBatch("group-1", 2, maxBytes);

      assertEquals(claimed?.entries.map((entry) => entry.event.id), [
        "event-2",
      ]);
      assertEquals(
        (await redis.getListRange(drainDeadKey("group-1"), 0, -1)).map((item) =>
          JSON.parse(item).event.id
        ),
        ["event-1"],
      );
      assertEquals(await redis.getListLength(drainPendingKey("group-1")), 0);
      assertEquals(warnSpy.calls.length, 1);
      const warning = warnSpy.calls[0].args[1] as {
        groupId: string;
        claimToken: string;
        eventId: string;
        eventBytes: unknown;
        batchMaxBytes: number;
      };
      assertEquals(
        warnSpy.calls[0].args[0],
        "Dead-lettered oversized claimed drain payload",
      );
      assertEquals(warning, {
        groupId: "group-1",
        claimToken: claimed!.claimToken,
        eventId: "event-1",
        eventBytes: warning.eventBytes,
        batchMaxBytes: maxBytes,
      });
      assertEquals(typeof warning.eventBytes, "number");
    } finally {
      warnSpy.restore();
      await redis.close();
    }
  });

  it("recovers only the uncheckpointed suffix ahead of newer pending entries", async () => {
    class ClaimRuntime extends ToggleRedisRuntime {
      override lmove(
        source: string,
        destination: string,
        sourceSide: "LEFT" | "RIGHT",
        destinationSide: "LEFT" | "RIGHT",
      ): Promise<string | null> {
        this.ensureAvailable();
        const sourceList = this.lists.get(source) ?? [];
        const value = sourceSide === "LEFT"
          ? sourceList.shift()
          : sourceList.pop();
        if (value === undefined) return Promise.resolve(null);
        const destinationList = this.ensureList(destination);
        if (destinationSide === "LEFT") destinationList.unshift(value);
        else destinationList.push(value);
        return Promise.resolve(value);
      }

      override eval(
        script: string,
        _numKeys: number,
        ...args: string[]
      ): Promise<number> {
        this.ensureAvailable();
        if (
          script.includes("redis.call('GET', KEYS[1]) == ARGV[1]") &&
          script.includes("redis.call('DEL', KEYS[1])")
        ) {
          if (this.values.get(args[0]) !== args[1]) return Promise.resolve(0);
          this.values.delete(args[0]);
          return Promise.resolve(1);
        }

        if (
          script.includes("redis.call('GET', KEYS[1]) == ARGV[1]") &&
          script.includes("redis.call('EXPIRE', KEYS[1], ARGV[2])")
        ) {
          return Promise.resolve(this.values.get(args[0]) === args[1] ? 1 : 0);
        }

        throw new Error("unsupported eval script");
      }
    }

    const redis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () => new ClaimRuntime({ available: true }) as never,
    });
    await redis.connect();
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 60,
      claimLockTtlSeconds: 5,
    });
    const first: { sessionId: string; groupId: string; event: SessionEvent } = {
      sessionId: "session-1",
      groupId: "group-1",
      event: {
        id: "event-1",
        ts: Date.now(),
        category: "message",
        priority: 0,
        role: "user",
        summary: "first",
        body: "first",
      },
    };
    const second: { sessionId: string; groupId: string; event: SessionEvent } =
      {
        sessionId: "session-1",
        groupId: "group-1",
        event: {
          id: "event-2",
          ts: Date.now() + 1,
          category: "message",
          priority: 0,
          role: "user",
          summary: "second",
          body: "second",
        },
      };
    const third: { sessionId: string; groupId: string; event: SessionEvent } = {
      sessionId: "session-2",
      groupId: "group-1",
      event: {
        id: "event-3",
        ts: Date.now() + 2,
        category: "message",
        priority: 0,
        role: "user",
        summary: "third",
        body: "third",
      },
    };

    try {
      await redis.prependToList(
        drainPendingKey("group-1"),
        JSON.stringify(first),
        60,
      );
      await redis.prependToList(
        drainPendingKey("group-1"),
        JSON.stringify(second),
        60,
      );

      const claimed = await redisEvents.getPendingBatch("group-1", 2, 20_000);
      assertEquals(claimed?.entries.map((entry) => entry.event.id), [
        "event-1",
        "event-2",
      ]);

      await redisEvents.markClaimEntrySuccess("group-1", claimed!.claimToken, {
        sessionId: first.sessionId,
        groupId: first.groupId,
        event: first.event,
      });
      await redis.prependToList(
        drainPendingKey("group-1"),
        JSON.stringify(third),
        60,
      );
      await redis.deleteKey(drainClaimLockKey("group-1"));

      const recovered = await redisEvents.recoverAbandonedClaim("group-1");

      assertEquals(recovered, true);
      assertEquals(
        (await redis.getListRange(drainPendingKey("group-1"), 0, -1)).map(
          (item) => JSON.parse(item).event.id,
        ),
        ["event-3", "event-2"],
      );

      const replayed = await redisEvents.getPendingBatch("group-1", 2, 20_000);
      assertEquals(replayed?.entries.map((entry) => entry.event.id), [
        "event-2",
        "event-3",
      ]);
      assertEquals(
        await redis.getString(drainClaimActiveKey("group-1")),
        replayed?.claimToken ?? null,
      );
    } finally {
      await redis.close();
    }
  });

  it("fails closed for abandoned-claim recovery while redis is disconnected", async () => {
    const state = { available: true };
    const runtime = new ClaimRuntime(state);
    const redis = new RedisClient({
      endpoint: "redis://unused",
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      runtimeFactory: () => runtime as never,
    });
    await redis.connect();
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 60,
      claimLockTtlSeconds: 5,
    });
    const first = {
      sessionId: "session-1",
      groupId: "group-1",
      event: {
        id: "event-1",
        ts: Date.now(),
        category: "message",
        priority: 0,
        role: "user",
        summary: "first",
        body: "first",
      } satisfies SessionEvent,
    };
    const second = {
      sessionId: "session-1",
      groupId: "group-1",
      event: {
        id: "event-2",
        ts: Date.now() + 1,
        category: "message",
        priority: 0,
        role: "user",
        summary: "second",
        body: "second",
      } satisfies SessionEvent,
    };

    try {
      await redis.prependToList(
        drainPendingKey("group-1"),
        JSON.stringify(first),
        60,
      );
      await redis.prependToList(
        drainPendingKey("group-1"),
        JSON.stringify(second),
        60,
      );

      const claimed = await redisEvents.getPendingBatch("group-1", 2, 20_000);
      await redis.deleteKey(drainClaimLockKey("group-1"));

      state.available = false;
      runtime.emit("close");

      const recovered = await redisEvents.recoverAbandonedClaim("group-1");

      assertEquals(recovered, false);
      assertEquals(redis.isConnected(), false);
      assertEquals(
        runtime.getValueSnapshot(drainClaimActiveKey("group-1")),
        claimed?.claimToken ?? null,
      );
      assertEquals(runtime.getListSnapshot(drainPendingKey("group-1")), []);
      assertEquals(
        runtime.getListSnapshot(drainClaimKey("group-1", claimed!.claimToken)),
        claimed!.entries.map((entry) =>
          JSON.stringify({
            sessionId: entry.sessionId,
            groupId: entry.groupId,
            event: entry.event,
          })
        ),
      );
    } finally {
      await redis.close();
    }
  });

  it("fails closed for claim lease refresh when redis disconnects", async () => {
    const state = { available: true };
    const runtime = new ClaimRuntime(state);
    const redis = new RedisClient({
      endpoint: "redis://unused",
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      runtimeFactory: () => runtime as never,
    });
    await redis.connect();
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 60,
      claimLockTtlSeconds: 5,
    });

    try {
      await redis.prependToList(
        drainPendingKey("group-1"),
        JSON.stringify({
          sessionId: "session-1",
          groupId: "group-1",
          event: {
            id: "event-1",
            ts: Date.now(),
            category: "message",
            priority: 0,
            role: "user",
            summary: "first",
            body: "first",
          } satisfies SessionEvent,
        }),
        60,
      );

      const claimed = await redisEvents.getPendingBatch("group-1", 1, 20_000);
      state.available = false;
      runtime.emit("close");

      const refreshed = await redisEvents.refreshClaimLease(
        "group-1",
        claimed!.claimToken,
        5,
      );

      assertEquals(refreshed, false);
      assertEquals(redis.isConnected(), false);
      assertEquals(
        runtime.getValueSnapshot(drainClaimActiveKey("group-1")),
        claimed!.claimToken,
      );
    } finally {
      await redis.close();
    }
  });

  it("cleans up only the same-token stale claim residue after reconnect", async () => {
    const state = { available: true };
    const runtime = new ClaimRuntime(state);
    const redis = new RedisClient({
      endpoint: "redis://unused",
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      runtimeFactory: () => runtime as never,
    });
    await redis.connect();
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 60,
      claimLockTtlSeconds: 5,
    });
    const first = {
      sessionId: "session-1",
      groupId: "group-1",
      event: {
        id: "event-1",
        ts: Date.now(),
        category: "message",
        priority: 0,
        role: "user",
        summary: "first",
        body: "first",
      } satisfies SessionEvent,
    };
    const second = {
      sessionId: "session-1",
      groupId: "group-1",
      event: {
        id: "event-2",
        ts: Date.now() + 1,
        category: "message",
        priority: 0,
        role: "user",
        summary: "second",
        body: "second",
      } satisfies SessionEvent,
    };
    const unrelated = {
      sessionId: "session-9",
      groupId: "group-1",
      event: {
        id: "event-9",
        ts: Date.now() + 9,
        category: "message",
        priority: 0,
        role: "user",
        summary: "unrelated",
        body: "unrelated",
      } satisfies SessionEvent,
    };
    const unrelatedToken = "other-token";

    try {
      await redis.prependToList(
        drainPendingKey("group-1"),
        JSON.stringify(first),
        60,
      );
      await redis.prependToList(
        drainPendingKey("group-1"),
        JSON.stringify(second),
        60,
      );

      const claimed = await redisEvents.getPendingBatch("group-1", 2, 20_000);
      runtime.seedList(drainClaimKey("group-1", unrelatedToken), [
        JSON.stringify(unrelated),
      ]);
      runtime.seedList(drainClaimCheckpointKey("group-1", unrelatedToken), []);

      state.available = false;
      runtime.emit("error", new Error("redis unavailable"));
      runtime.deleteStoredKey(drainClaimLockKey("group-1"));

      state.available = true;
      await new Promise((resolve) => setTimeout(resolve, 30));

      const refreshed = await redisEvents.refreshClaimLease(
        "group-1",
        claimed!.claimToken,
        5,
      );

      assertEquals(redis.isConnected(), true);
      assertEquals(refreshed, false);
      assertEquals(
        await redis.getString(drainClaimActiveKey("group-1")),
        claimed!.claimToken,
      );
      assertEquals(
        await redis.getListRange(
          drainClaimKey("group-1", claimed!.claimToken),
          0,
          -1,
        ),
        [JSON.stringify(first), JSON.stringify(second)],
      );
      const recovered = await redisEvents.recoverAbandonedClaim("group-1");
      assertEquals(recovered, true);
      assertEquals(await redis.getString(drainClaimActiveKey("group-1")), null);
      assertEquals(
        (await redis.getListRange(drainPendingKey("group-1"), 0, -1)).map((
          raw,
        ) => JSON.parse(raw).event.id),
        ["event-2", "event-1"],
      );
      assertEquals(
        await redis.getListRange(
          drainClaimKey("group-1", unrelatedToken),
          0,
          -1,
        ),
        [JSON.stringify(unrelated)],
      );
    } finally {
      await redis.close();
    }
  });
});
