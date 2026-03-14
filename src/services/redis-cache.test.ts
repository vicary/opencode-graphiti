import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { setLoggerSilentOverride } from "./logger.ts";
import { RedisCacheService } from "./redis-cache.ts";
import { RedisClient } from "./redis-client.ts";
import { memoryCacheMetaKey } from "./redis-events.ts";

type RedisEvent = "close" | "end" | "error" | "ready";

class HashRedisRuntime {
  private readonly values = new Map<string, string>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly listeners = new Map<
    RedisEvent,
    Set<(...args: unknown[]) => void>
  >();

  constructor(private readonly state: { available: boolean }) {}

  connect(): Promise<void> {
    this.ensureAvailable();
    this.emit("ready");
    return Promise.resolve();
  }

  ping(): Promise<"PONG"> {
    this.ensureAvailable();
    return Promise.resolve("PONG");
  }

  quit(): Promise<"OK"> {
    return Promise.resolve("OK");
  }

  private ensureAvailable(): void {
    if (!this.state.available) throw new Error("redis unavailable");
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

  hset(key: string, values: Record<string, string>): Promise<number> {
    this.ensureAvailable();
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    let added = 0;
    for (const [field, value] of Object.entries(values)) {
      if (!hash.has(field)) added += 1;
      hash.set(field, value);
    }
    this.hashes.set(key, hash);
    return Promise.resolve(added);
  }

  hgetall(key: string): Promise<Record<string, string>> {
    this.ensureAvailable();
    return Promise.resolve(
      Object.fromEntries((this.hashes.get(key) ?? new Map()).entries()),
    );
  }

  expire(_key: string, _ttlSeconds: number): Promise<number> {
    this.ensureAvailable();
    return Promise.resolve(1);
  }

  del(key: string): Promise<number> {
    this.ensureAvailable();
    const deleted = this.values.delete(key) || this.hashes.delete(key);
    return Promise.resolve(deleted ? 1 : 0);
  }

  lpush(_key: string, _value: string): Promise<number> {
    throw new Error("not implemented");
  }

  rpush(_key: string, _value: string): Promise<number> {
    throw new Error("not implemented");
  }

  lmove(
    _source: string,
    _destination: string,
    _sourceSide: "LEFT" | "RIGHT",
    _destinationSide: "LEFT" | "RIGHT",
  ): Promise<string | null> {
    throw new Error("not implemented");
  }

  lrange(_key: string, _start: number, _stop: number): Promise<string[]> {
    throw new Error("not implemented");
  }

  llen(_key: string): Promise<number> {
    throw new Error("not implemented");
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

const createRedis = (state = { available: true }) =>
  new RedisClient({
    endpoint: "redis://unused",
    runtimeFactory: () => new HashRedisRuntime(state),
  });

describe("redis cache", () => {
  it("stores cache entries per group without leaking across groups", async () => {
    const redis = createRedis();
    const cache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    await cache.set("group-1", {
      query: "project alpha policy",
      refreshedAt: Date.now(),
      nodes: [],
      nodeRefs: [],
    });
    await cache.set("group-2", {
      query: "project beta policy",
      refreshedAt: Date.now(),
      nodes: [],
      nodeRefs: [],
    });

    assertEquals((await cache.get("group-1"))?.query, "project alpha policy");
    assertEquals((await cache.get("group-2"))?.query, "project beta policy");
    assertEquals(await cache.get("group-3"), null);
  });

  it("returns little or no persistent memory for noise-only remainder", () => {
    const redis = createRedis();
    const cache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    const rendered = cache.renderPersistentMemory({
      query: "naming policy",
      refreshedAt: Date.now(),
      nodes: [],
      nodeRefs: [],
    });

    assertEquals(rendered.body, "");
    assertEquals(rendered.nodeRefs, []);
  });

  it("renders cached node and fact summaries without leaking node refs into the body", () => {
    const redis = createRedis();
    const cache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    const rendered = cache.renderPersistentMemory({
      query: "naming policy",
      refreshedAt: Date.now(),
      nodes: [{
        uuid: "node-1",
        name: "Policy Guidelines",
        summary: "Enforce kebab-case naming decision for all routes",
      }],
      episodeSummaries: [
        "Policy Guidelines → Routing: Prefer kebab-case route names",
      ],
      nodeRefs: ["node-1"],
    });

    assertEquals(rendered.body.includes("node-1"), false);
    assertEquals(rendered.nodeRefs.includes("node-1"), true);
    assertStringIncludes(rendered.body, "Prefer kebab-case route names");
  });

  it("dedupes equivalent rendered nodes and episodes while keeping the first node ref", () => {
    const redis = createRedis();
    const cache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    const rendered = cache.renderPersistentMemory({
      query: "redis hot path",
      refreshedAt: Date.now(),
      nodes: [
        {
          uuid: "node-1",
          name: "Redis policy",
          summary: "Keep hot path deduped for persistent memory",
        },
        {
          uuid: "node-2",
          name: "  Redis policy  ",
          summary: "Keep hot path deduped for persistent memory",
        },
      ],
      episodeSummaries: [
        "Redis policy decision for persistent memory",
        '<memory data-uuids="fact-1">old</memory> Redis policy decision for persistent memory',
      ],
      nodeRefs: ["node-1", "node-2"],
    });

    assertEquals(
      rendered.body,
      "<node>Redis policy: Keep hot path deduped for persistent memory</node><episode>Redis policy decision for persistent memory</episode>",
    );
    assertEquals(rendered.nodeRefs, ["node-1"]);
  });

  it("suppresses persistent memory when the remaining facts and nodes are transcript-heavy noise", () => {
    const redis = createRedis();
    const cache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    const huge = "RAW-TRANSCRIPT-CHUNK ".repeat(200);
    const rendered = cache.renderPersistentMemory({
      query: "context overhaul policy",
      refreshedAt: Date.now(),
      nodes: Array.from({ length: 8 }, (_, index) => ({
        uuid: `node-${index + 1}`,
        name: `Node ${index + 1}`,
        summary: huge,
      })),
      episodeSummaries: Array.from(
        { length: 6 },
        (_, index) => `Episode ${index + 1} ${huge}`,
      ),
      nodeRefs: Array.from({ length: 8 }, (_, index) => `node-${index + 1}`),
    });

    assertEquals(rendered.nodeRefs, []);
    assertEquals(rendered.body, "");
  });

  it("sanitizes injected memory blocks before storing cache entries", async () => {
    const redis = createRedis();
    const cache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    await cache.set("group-1", {
      query:
        '<session_memory version="1"><last_request>old</last_request></session_memory> next query',
      refreshedAt: Date.now(),
      nodes: [{
        uuid: "node-1",
        name: "Context Overhaul",
        summary:
          '<session_memory version="1"></session_memory> Hot path uses Redis',
      }],
      episodeSummaries: [
        '<memory data-uuids="fact-ep">old</memory> Durable project note',
      ],
      nodeRefs: ["node-1"],
    });

    const stored = await cache.get("group-1");
    assertEquals(stored?.query, "next query");
    assertEquals(stored?.nodes[0].summary, "Hot path uses Redis");
    assertEquals(stored?.episodeSummaries, ["Durable project note"]);
  });

  it("persists query metadata without fact uuid state", async () => {
    const redis = createRedis();
    const cache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    await cache.set("group-1", {
      query: "query",
      refreshedAt: Date.now(),
      nodes: [],
      nodeRefs: [],
    });

    assertEquals(await cache.getMeta("group-1"), {
      lastQuery: "query",
      lastRefresh: (await cache.get("group-1"))?.refreshedAt,
    });
  });

  it("preserves a string lastRefresh value of 0 in metadata", async () => {
    const redis = createRedis();
    const cache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    await redis.setHashFields(memoryCacheMetaKey("group-1"), {
      lastQuery: "query",
      lastRefresh: "0",
    }, 300);

    assertEquals(await cache.getMeta("group-1"), {
      lastQuery: "query",
      lastRefresh: 0,
    });
  });

  it("keeps cache entry and metadata alive through fallback after a live touch", async () => {
    const state = { available: true };
    const redis = new RedisClient({
      endpoint: "redis://unused",
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      runtimeFactory: () => new HashRedisRuntime(state),
    });
    const cache = new RedisCacheService(redis, {
      ttlSeconds: 1.2,
      driftThreshold: 0.5,
    });
    try {
      setLoggerSilentOverride(true);
      await redis.connect();
      await cache.set("group-1", {
        query: "query",
        refreshedAt: Date.now(),
        nodes: [],
        nodeRefs: [],
      });

      await new Promise((resolve) => setTimeout(resolve, 750));
      await cache.touch("group-1");

      state.available = false;
      (redis as unknown as { redis: HashRedisRuntime | null }).redis?.emit(
        "close",
      );
      await new Promise((resolve) => setTimeout(resolve, 500));

      assertEquals((await cache.get("group-1"))?.query, "query");
      assertEquals((await cache.getMeta("group-1"))?.lastQuery, "query");
    } finally {
      setLoggerSilentOverride(false);
      await redis.close();
    }
  });
});
