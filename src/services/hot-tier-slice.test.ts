import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { spy } from "jsr:@std/testing@^1.0.0/mock";
import { createChatHandler } from "../handlers/chat.ts";
import { createCompactingHandler } from "../handlers/compacting.ts";
import { createMessagesHandler } from "../handlers/messages.ts";
import { SessionManager } from "../session.ts";
import { BatchDrainService } from "./batch-drain.ts";
import { GraphitiAsyncService } from "./graphiti-async.ts";
import { logger, setLoggerDebugOverride } from "./logger.ts";
import { setSuppressConsoleWarningsDuringTestsOverride } from "./opencode-warning.ts";
import { RedisCacheService } from "./redis-cache.ts";
import { RedisClient } from "./redis-client.ts";
import { RedisEventsService } from "./redis-events.ts";
import { RedisSnapshotService } from "./redis-snapshot.ts";
import type { RedisEvent } from "./test-helpers.ts";

setSuppressConsoleWarningsDuringTestsOverride(true);

class ReconnectingRedisRuntime {
  private readonly values = new Map<string, string>();
  private readonly lists = new Map<string, string[]>();
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
    if (!this.state.available) {
      throw new Error("redis unavailable");
    }
  }

  private ensureList(key: string): string[] {
    if (this.values.has(key) || this.hashes.has(key)) {
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

  private ensureHash(key: string): Map<string, string> {
    if (this.values.has(key) || this.lists.has(key)) {
      throw new Error(
        "WRONGTYPE Operation against a key holding the wrong kind of value",
      );
    }
    const existing = this.hashes.get(key);
    if (existing) return existing;
    const hash = new Map<string, string>();
    this.hashes.set(key, hash);
    return hash;
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
    source: string,
    destination: string,
    sourceSide: "LEFT" | "RIGHT",
    destinationSide: "LEFT" | "RIGHT",
  ): Promise<string | null> {
    this.ensureAvailable();
    if (this.values.has(source) || this.hashes.has(source)) {
      throw new Error(
        "WRONGTYPE Operation against a key holding the wrong kind of value",
      );
    }
    const sourceList = this.lists.get(source) ?? [];
    const value = sourceSide === "LEFT" ? sourceList.shift() : sourceList.pop();
    if (value === undefined) return Promise.resolve(null);

    const destinationList = this.ensureList(destination);
    if (destinationSide === "LEFT") {
      destinationList.unshift(value);
    } else {
      destinationList.push(value);
    }
    return Promise.resolve(value);
  }

  lrange(key: string, start: number, stop: number): Promise<string[]> {
    this.ensureAvailable();
    if (this.values.has(key) || this.hashes.has(key)) {
      throw new Error(
        "WRONGTYPE Operation against a key holding the wrong kind of value",
      );
    }
    const list = this.lists.get(key) ?? [];
    return Promise.resolve(list.slice(start, stop + 1));
  }

  llen(key: string): Promise<number> {
    this.ensureAvailable();
    if (this.values.has(key) || this.hashes.has(key)) {
      throw new Error(
        "WRONGTYPE Operation against a key holding the wrong kind of value",
      );
    }
    return Promise.resolve((this.lists.get(key) ?? []).length);
  }

  ltrim(key: string, start: number, stop: number): Promise<void> {
    this.ensureAvailable();
    if (this.values.has(key) || this.hashes.has(key)) {
      throw new Error(
        "WRONGTYPE Operation against a key holding the wrong kind of value",
      );
    }
    const list = this.lists.get(key) ?? [];
    this.lists.set(key, list.slice(start, stop + 1));
    return Promise.resolve();
  }

  lindex(key: string, index: number): Promise<string | null> {
    this.ensureAvailable();
    if (this.values.has(key) || this.hashes.has(key)) {
      throw new Error(
        "WRONGTYPE Operation against a key holding the wrong kind of value",
      );
    }
    return Promise.resolve(this.lists.get(key)?.[index] ?? null);
  }

  lset(key: string, index: number, value: string): Promise<void> {
    this.ensureAvailable();
    if (this.values.has(key) || this.hashes.has(key)) {
      throw new Error(
        "WRONGTYPE Operation against a key holding the wrong kind of value",
      );
    }
    const list = this.lists.get(key);
    if (!list || index < 0 || index >= list.length) {
      return Promise.reject(new Error("ERR index out of range"));
    }
    list[index] = value;
    return Promise.resolve();
  }

  get(key: string): Promise<string | null> {
    this.ensureAvailable();
    return Promise.resolve(this.values.get(key) ?? null);
  }

  hset(key: string, values: Record<string, string>): Promise<number> {
    this.ensureAvailable();
    const hash = this.ensureHash(key);
    let added = 0;
    for (const [field, value] of Object.entries(values)) {
      if (!hash.has(field)) added += 1;
      hash.set(field, value);
    }
    return Promise.resolve(added);
  }

  hgetall(key: string): Promise<Record<string, string>> {
    this.ensureAvailable();
    if (this.values.has(key) || this.lists.has(key)) {
      throw new Error(
        "WRONGTYPE Operation against a key holding the wrong kind of value",
      );
    }
    return Promise.resolve(
      Object.fromEntries((this.hashes.get(key) ?? new Map()).entries()),
    );
  }

  set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<"OK" | null> {
    this.ensureAvailable();
    if (this.lists.has(key) || this.hashes.has(key)) {
      throw new Error(
        "WRONGTYPE Operation against a key holding the wrong kind of value",
      );
    }

    const onlyIfAbsent = args.includes("NX");
    if (onlyIfAbsent && this.values.has(key)) return Promise.resolve(null);
    this.values.set(key, value);
    return Promise.resolve("OK");
  }

  expire(_key: string, _ttlSeconds: number): Promise<number> {
    this.ensureAvailable();
    return Promise.resolve(1);
  }

  del(key: string): Promise<number> {
    this.ensureAvailable();
    const deleted = this.values.delete(key) || this.lists.delete(key) ||
      this.hashes.delete(key);
    return Promise.resolve(deleted ? 1 : 0);
  }

  eval(
    script: string,
    _numKeys: number,
    ...args: string[]
  ): Promise<number> {
    this.ensureAvailable();

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

  emit(event: RedisEvent, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert(condition(), "condition not met before timeout");
}

Deno.test("hot-tier reconnect recovery integrates event/cache/drain flow", async () => {
  const state = { available: true };
  const runtime = new ReconnectingRedisRuntime(state);
  const redis = new RedisClient({
    endpoint: "redis://unused",
    reconnectBaseDelayMs: 10,
    reconnectMaxDelayMs: 10,
    runtimeFactory: () => runtime,
  });
  await redis.connect();

  const redisEvents = new RedisEventsService(redis, {
    sessionTtlSeconds: 300,
  });
  const redisCache = new RedisCacheService(redis, {
    ttlSeconds: 300,
    driftThreshold: 0.5,
  });
  const drain = new BatchDrainService(redis, redisEvents, {
    batchSize: 8,
    batchMaxBytes: 8_192,
    drainRetryMax: 2,
  });

  try {
    await redisCache.set("group-1", {
      query: "recovery query",
      refreshedAt: Date.now(),
      nodes: [{
        uuid: "node-1",
        name: "RECOVERY-NODE-1",
        summary: "Recovered persistent memory after reconnect",
      }],
      nodeRefs: ["node-1"],
    });
    await redisEvents.recordEvent("session-1", "group-1", {
      id: "event-1",
      ts: Date.now(),
      category: "decision",
      priority: 0,
      role: "user",
      summary: "Use reconnect-safe recovery flow",
      continuityText:
        "RECOVERY-TOKEN keeps event recall and drain recovery aligned after reconnect",
    });

    state.available = false;
    runtime.emit("close");
    assertEquals(redis.isConnected(), false);

    state.available = true;
    await waitFor(() => redis.isConnected());

    const recoveredCache = await redisCache.get("group-1");
    assertEquals(recoveredCache?.query, "recovery query");
    assertEquals(recoveredCache?.nodeRefs, ["node-1"]);

    const recalled = await redisEvents.recallSessionEvents(
      "session-1",
      "RECOVERY-TOKEN",
    );
    assertEquals(recalled.map((event) => event.id), ["event-1"]);

    const calls: Array<{ name: string; episodeBody: string }> = [];
    const result = await drain.drainGroup("group-1", {
      addMemory(input: { name: string; episodeBody: string }) {
        calls.push(input);
        return Promise.resolve();
      },
    } as never);

    assertEquals(result, { status: "success", drained: 1 });
    assertEquals(await redisEvents.getPendingCount("group-1"), 0);
    assertEquals(calls.length, 1);
    assertStringIncludes(calls[0].name, "decision:event-1");
    assertStringIncludes(calls[0].episodeBody, "RECOVERY-TOKEN");
  } finally {
    await redis.close();
  }
});

describe("hot-tier vertical slice", () => {
  it("records local state, prepares injection, transforms messages, and serves compaction context without live MCP", async () => {
    const redis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () => new ReconnectingRedisRuntime({ available: true }),
    });
    await redis.connect();
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 300,
    });
    const redisSnapshot = new RedisSnapshotService(redis, { ttlSeconds: 600 });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });
    await redisCache.set("group-1", {
      query: "Continue the overhaul",
      refreshedAt: Date.now(),
      nodes: [{ uuid: "node-1", name: "ContextOverhaul" }],
      nodeRefs: ["node-1"],
    });

    const manager = new SessionManager(
      "group-1",
      "user-1",
      { session: { get: () => ({ parentID: null }) } } as never,
      redisEvents,
      redisSnapshot,
      redisCache,
      {} as never,
    );
    manager.setParentId("session-1", null);
    manager.setState(
      "session-1",
      manager.createDefaultState("group-1", "user-1"),
    );

    const graphitiAsync = {
      scheduleCacheRefresh() {},
      scheduleDrain() {},
    };

    const chat = createChatHandler({
      sessionManager: manager,
      redisEvents,
      graphitiAsync: graphitiAsync as never,
      drainTriggerSize: 99,
    });
    const transform = createMessagesHandler({ sessionManager: manager });
    const compacting = createCompactingHandler({ sessionManager: manager });

    await chat(
      { sessionID: "session-1" } as never,
      {
        parts: [{
          type: "text",
          text: "Please keep Graphiti off the hot path",
        }],
      } as never,
    );

    const transformOutput = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{
          type: "text",
          text: "Please keep Graphiti off the hot path",
        }],
      }],
    };
    await transform(
      { message: "Please keep Graphiti off the hot path" } as never,
      transformOutput as never,
    );

    assertStringIncludes(
      transformOutput.messages[0].parts[0].text,
      "<session_memory",
    );
    assertEquals(
      transformOutput.messages[0].parts[0].text.includes("<persistent_memory"),
      false,
    );

    const events = await redisEvents.getRecentSessionEvents(
      "session-1",
      10,
      true,
    );
    const snapshot = await redisSnapshot.rebuildAndSave("session-1", events);
    assertStringIncludes(snapshot, "<decisions>");

    const compactOutput = { context: [] as string[] };
    await compacting(
      { sessionID: "session-1" } as never,
      compactOutput as never,
    );
    assertEquals(compactOutput.context.length, 1);
    assertStringIncludes(compactOutput.context[0], "<session_memory");
  });

  it("keeps chat, transform, and compaction on the cache-only hook path while rendering cached long-term summaries", async () => {
    const redis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () => new ReconnectingRedisRuntime({ available: true }),
    });
    await redis.connect();
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 300,
    });
    const redisSnapshot = new RedisSnapshotService(redis, { ttlSeconds: 600 });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });
    await redisCache.set("group-1", {
      query: "cache-only recall",
      refreshedAt: Date.now(),
      nodes: [{
        uuid: "node-1",
        name: "ArchitectureDecision",
        summary:
          "Cached cross-session recall about keeping Graphiti off hook-time injection",
      }],
      episodeSummaries: [
        "ArchitectureDecision → HotPath: Cached fact summary about Redis-backed injection",
      ],
      nodeRefs: ["node-1"],
    });

    const manager = new SessionManager(
      "group-1",
      "user-1",
      { session: { get: () => ({ parentID: null }) } } as never,
      redisEvents,
      redisSnapshot,
      redisCache,
      {} as never,
    );
    manager.setParentId("session-1", null);
    manager.setState(
      "session-1",
      manager.createDefaultState("group-1", "user-1"),
    );

    const graphitiAsync = {
      scheduleCacheRefresh() {},
      scheduleDrain() {},
    };

    const chat = createChatHandler({
      sessionManager: manager,
      redisEvents,
      graphitiAsync: graphitiAsync as never,
      drainTriggerSize: 99,
    });
    const transform = createMessagesHandler({ sessionManager: manager });
    const compacting = createCompactingHandler({ sessionManager: manager });

    await chat(
      { sessionID: "session-1" } as never,
      {
        parts: [{
          type: "text",
          text: "cache-only recall",
        }],
      } as never,
    );

    const transformOutput = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{
          type: "text",
          text: "cache-only recall",
        }],
      }],
    };
    await transform(
      { message: "cache-only recall" } as never,
      transformOutput as never,
    );

    const compactOutput = { context: [] as string[] };
    await compacting(
      { sessionID: "session-1" } as never,
      compactOutput as never,
    );

    assertStringIncludes(
      transformOutput.messages[0].parts[0].text,
      "<session_memory",
    );
    assertEquals(compactOutput.context.length, 1);
    assertStringIncludes(compactOutput.context[0], "<persistent_memory");
    assertStringIncludes(
      compactOutput.context[0],
      "Cached fact summary about Redis-backed injection",
    );
  });

  it("recalls older relevant Redis events into injection while still scheduling async refresh", async () => {
    const redis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () => new ReconnectingRedisRuntime({ available: true }),
    });
    await redis.connect();
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 300,
    });
    const redisSnapshot = new RedisSnapshotService(redis, { ttlSeconds: 600 });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    const manager = new SessionManager(
      "group-1",
      "user-1",
      { session: { get: () => ({ parentID: null }) } } as never,
      redisEvents,
      redisSnapshot,
      redisCache,
      {} as never,
    );
    manager.setParentId("session-1", null);
    manager.setState(
      "session-1",
      manager.createDefaultState("group-1", "user-1"),
    );

    await redisEvents.recordEvent("session-1", "group-1", {
      id: "older-decision",
      ts: Date.now() - 60_000,
      category: "decision",
      priority: 0,
      role: "user",
      summary: "Use deterministic merge behavior for recall",
      continuityText:
        "Use deterministic merge behavior for recall when injecting session memory",
    });

    for (let index = 0; index < 25; index += 1) {
      await redisEvents.recordEvent("session-1", "group-1", {
        id: `recent-${index}`,
        ts: Date.now() - 1_000 + index,
        category: "message",
        priority: 4,
        role: "assistant",
        summary: `Recent unrelated event ${index}`,
        continuityText: `Recent unrelated event ${index}`,
      });
    }

    const refreshCalls: Array<{ groupId: string; query: string }> = [];
    const graphitiAsync = {
      scheduleCacheRefresh(groupId: string, query: string) {
        refreshCalls.push({ groupId, query });
      },
      scheduleDrain() {},
    };

    const chat = createChatHandler({
      sessionManager: manager,
      redisEvents,
      graphitiAsync: graphitiAsync as never,
      drainTriggerSize: 999,
    });
    const transform = createMessagesHandler({ sessionManager: manager });

    await chat(
      { sessionID: "session-1" } as never,
      {
        parts: [{
          type: "text",
          text: "Can you revisit deterministic merge behavior for recall?",
        }],
      } as never,
    );

    const transformOutput = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{
          type: "text",
          text: "Can you revisit deterministic merge behavior for recall?",
        }],
      }],
    };
    await transform(
      {
        message: "Can you revisit deterministic merge behavior for recall?",
      } as never,
      transformOutput as never,
    );

    assertStringIncludes(
      transformOutput.messages[0].parts[0].text,
      "Use deterministic merge behavior for recall",
    );
    assertEquals(refreshCalls, [{
      groupId: "group-1",
      query: "Can you revisit deterministic merge behavior for recall?",
    }]);
  });

  it("recalls continuity-rich events without relying on transcript bodies", async () => {
    const redis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () => new ReconnectingRedisRuntime({ available: true }),
    });
    await redis.connect();
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 300,
    });

    await redisEvents.recordEvent("session-1", "group-1", {
      id: "decision-1",
      ts: Date.now(),
      category: "decision",
      priority: 0,
      role: "user",
      summary: "Use continuity-first injection",
      continuityText:
        "Use continuity-first injection for hot-tier recall and session memory selection",
    });

    const recalled = await redisEvents.recallSessionEvents(
      "session-1",
      "continuity-first injection",
    );

    assertEquals(recalled.length, 1);
    assertEquals(recalled[0].id, "decision-1");
    assertEquals(recalled[0].body, undefined);
  });

  it("drains structured semantic payloads to Graphiti asynchronously", async () => {
    const redis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () => new ReconnectingRedisRuntime({ available: true }),
    });
    await redis.connect();
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 300,
    });
    const drain = new BatchDrainService(redis, redisEvents, {
      batchSize: 8,
      batchMaxBytes: 8_192,
      drainRetryMax: 2,
    });

    await redisEvents.recordEvent("session-1", "group-1", {
      id: "event-1",
      ts: Date.now(),
      category: "file.edit",
      priority: 1,
      role: "tool",
      summary: "Edited src/session.ts",
      detail: "Updated session injection selection",
      continuityText:
        "Edited src/session.ts to prefer continuity fields during session-memory injection",
      refs: ["src/session.ts"],
      keywords: ["session", "continuity", "injection"],
    });

    const calls: Array<{ name: string; episodeBody: string }> = [];
    const result = await drain.drainGroup("group-1", {
      addMemory(input: { name: string; episodeBody: string }) {
        calls.push(input);
        return Promise.resolve();
      },
    } as never);

    assertEquals(result.status, "success");
    assertEquals(calls.length, 1);
    assertStringIncludes(calls[0].name, "file.edit:event-1");
    assertStringIncludes(
      calls[0].episodeBody,
      "Summary: Edited src/session.ts",
    );
    assertStringIncludes(
      calls[0].episodeBody,
      "Continuity: Edited src/session.ts to prefer continuity fields during session-memory injection",
    );
    assertEquals(calls[0].episodeBody.includes("Body:"), false);
  });

  it("updates only the refresh query field without clobbering cache metadata", async () => {
    const redis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () => new ReconnectingRedisRuntime({ available: true }),
    });
    await redis.connect();
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    await redis.setHashFields("memory-cache:group-1:meta", {
      lastQuery: "previous query",
      lastRefresh: 123,
      retainedField: "fact-1,fact-2",
    }, 300);

    await redisCache.rememberRefreshQuery("group-1", "next query");

    assertEquals(await redis.getHashAll("memory-cache:group-1:meta"), {
      lastQuery: "next query",
      lastRefresh: "123",
      retainedField: "fact-1,fact-2",
    });
  });

  it("serializes same-group refreshes and follows up with the newest queued query", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    let resolveAlpha!: (
      value: {
        nodes: Array<{ uuid: string; name: string }>;
        degraded: boolean;
      },
    ) => void;
    let resolveBeta!: (
      value: {
        nodes: Array<{ uuid: string; name: string }>;
        degraded: boolean;
      },
    ) => void;
    const alphaStarted = new Promise<void>((resolve) => {
      resolveAlpha = (value) => {
        resolve();
        alphaResult.resolve(value);
      };
    });
    const betaStarted = new Promise<void>((resolve) => {
      resolveBeta = (value) => {
        resolve();
        betaResult.resolve(value);
      };
    });

    const alphaResult = Promise.withResolvers<{
      nodes: Array<{ uuid: string; name: string }>;
      degraded: boolean;
    }>();
    const betaResult = Promise.withResolvers<{
      nodes: Array<{ uuid: string; name: string }>;
      degraded: boolean;
    }>();

    const searchCalls: string[] = [];
    const graphitiAsync = new GraphitiAsyncService(
      {
        getEpisodes() {
          return Promise.resolve([]);
        },
        searchMemoryFacts() {
          return Promise.resolve([]);
        },
        searchNodesWithStatus(input: { query: string }) {
          searchCalls.push(input.query);
          if (input.query === "Alpha query") return alphaResult.promise;
          if (input.query === "Beta query") return betaResult.promise;
          return Promise.reject(new Error(`unexpected query: ${input.query}`));
        },
      } as never,
      redisCache,
      {
        drainGroup() {
          return Promise.resolve({ status: "empty" as const, drained: 0 });
        },
      } as never,
    );

    graphitiAsync.scheduleCacheRefresh("group-1", "Alpha query");
    await waitFor(() => searchCalls.includes("Alpha query"));
    graphitiAsync.scheduleCacheRefresh("group-1", "Beta query");
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveAlpha({
      nodes: [{ uuid: "alpha-node", name: "AlphaNode" }],
      degraded: false,
    });
    await alphaStarted;
    await waitFor(() =>
      searchCalls.filter((query) => query === "Beta query").length === 1
    );
    resolveBeta({
      nodes: [{ uuid: "beta-node", name: "BetaNode" }],
      degraded: false,
    });
    await betaStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cached = await redisCache.get("group-1");
    const meta = await redisCache.getMeta("group-1");

    assertEquals(searchCalls, ["Alpha query", "Beta query"]);
    assertEquals(cached?.query, "Beta query");
    assertEquals(cached?.nodeRefs, ["beta-node"]);
    assertEquals(cached?.nodes, [{ uuid: "beta-node", name: "BetaNode" }]);
    assertEquals(meta?.lastQuery, "Beta query");
  });

  it("coalesces duplicate follow-up refresh requests while one refresh is in flight", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    const alphaResult = Promise.withResolvers<{
      nodes: Array<{ uuid: string; name: string }>;
      degraded: boolean;
    }>();
    const betaResult = Promise.withResolvers<{
      nodes: Array<{ uuid: string; name: string }>;
      degraded: boolean;
    }>();

    const searchCalls: string[] = [];
    const graphitiAsync = new GraphitiAsyncService(
      {
        getEpisodes() {
          return Promise.resolve([]);
        },
        searchMemoryFacts() {
          return Promise.resolve([]);
        },
        searchNodesWithStatus(input: { query: string }) {
          searchCalls.push(input.query);
          if (input.query === "Alpha query") return alphaResult.promise;
          if (input.query === "Beta query") return betaResult.promise;
          return Promise.reject(new Error(`unexpected query: ${input.query}`));
        },
      } as never,
      redisCache,
      {
        drainGroup() {
          return Promise.resolve({ status: "empty" as const, drained: 0 });
        },
      } as never,
    );

    graphitiAsync.scheduleCacheRefresh("group-1", "Alpha query");
    await waitFor(() => searchCalls.includes("Alpha query"));

    graphitiAsync.scheduleCacheRefresh("group-1", "Beta query");
    graphitiAsync.scheduleCacheRefresh("group-1", "Beta query");
    graphitiAsync.scheduleCacheRefresh("group-1", "  Beta query  ");

    alphaResult.resolve({
      nodes: [{ uuid: "alpha-node", name: "AlphaNode" }],
      degraded: false,
    });
    await waitFor(() =>
      searchCalls.filter((query) => query === "Beta query").length === 1
    );

    betaResult.resolve({
      nodes: [{ uuid: "beta-node", name: "BetaNode" }],
      degraded: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cached = await redisCache.get("group-1");
    const meta = await redisCache.getMeta("group-1");

    assertEquals(searchCalls, ["Alpha query", "Beta query"]);
    assertEquals(cached?.query, "Beta query");
    assertEquals(cached?.nodeRefs, ["beta-node"]);
    assertEquals(meta?.lastQuery, "Beta query");
  });

  it("stores fact-derived summaries alongside refreshed nodes", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    const graphitiAsync = new GraphitiAsyncService(
      {
        getEpisodes() {
          return Promise.resolve([]);
        },
        searchMemoryFacts() {
          return Promise.resolve([{
            uuid: "fact-1",
            fact: "Keep Graphiti off the hot path",
            source_node: { uuid: "source-1", name: "ArchitectureDecision" },
            target_node: { uuid: "target-1", name: "HotPath" },
          }]);
        },
        searchNodesWithStatus() {
          return Promise.resolve({
            nodes: [{ uuid: "node-1", name: "HotPath" }],
            degraded: false,
          });
        },
      } as never,
      redisCache,
      {
        drainGroup() {
          return Promise.resolve({ status: "empty" as const, drained: 0 });
        },
      } as never,
    );

    graphitiAsync.scheduleCacheRefresh("group-1", "hot path recall");
    let committed = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      committed = (await redisCache.get("group-1"))?.query ===
        "hot path recall";
      if (committed) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert(committed, "fact-backed refresh did not commit before timeout");

    const cached = await redisCache.get("group-1");
    assertEquals(cached?.nodeRefs, ["node-1"]);
    assertEquals(cached?.episodeSummaries, [
      "ArchitectureDecision → HotPath: Keep Graphiti off the hot path",
    ]);
  });

  it("dedupes same-query case and whitespace variants on the canonical key", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    const searchCalls: string[] = [];
    const searchResult = Promise.withResolvers<{
      nodes: Array<{ uuid: string; name: string }>;
      degraded: boolean;
    }>();
    const graphitiAsync = new GraphitiAsyncService(
      {
        getEpisodes() {
          return Promise.resolve([]);
        },
        searchMemoryFacts() {
          return Promise.resolve([]);
        },
        searchNodesWithStatus(input: { query: string }) {
          searchCalls.push(input.query);
          return searchResult.promise;
        },
      } as never,
      redisCache,
      {
        drainGroup() {
          return Promise.resolve({ status: "empty" as const, drained: 0 });
        },
      } as never,
    );

    graphitiAsync.scheduleCacheRefresh("group-1", "  Alpha Query  ");
    await waitFor(() => searchCalls.length === 1);
    graphitiAsync.scheduleCacheRefresh("group-1", "alpha query");
    await new Promise((resolve) => setTimeout(resolve, 0));

    searchResult.resolve({
      nodes: [{ uuid: "alpha-node", name: "AlphaNode" }],
      degraded: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cached = await redisCache.get("group-1");
    const meta = await redisCache.getMeta("group-1");

    assertEquals(searchCalls, ["Alpha Query"]);
    assertEquals(cached?.query, "Alpha Query");
    assertEquals(cached?.nodeRefs, ["alpha-node"]);
    assertEquals(meta?.lastQuery, "Alpha Query");
  });

  it("prefers remembered metadata query over stale cached query after drain success", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    await redisCache.set("group-1", {
      query: "older cached query",
      refreshedAt: Date.now() - 60_000,
      nodes: [],
      nodeRefs: [],
    });
    await redisCache.rememberRefreshQuery("group-1", "newer remembered query");

    const refreshCalls: Array<{ groupId: string; query: string }> = [];
    let drainCalls = 0;
    const graphitiAsync = new GraphitiAsyncService(
      {
        getEpisodes() {
          return Promise.resolve([]);
        },
        searchMemoryFacts() {
          return Promise.resolve([]);
        },
        searchNodesWithStatus(input: { query: string; groupIds: string[] }) {
          refreshCalls.push({ groupId: input.groupIds[0], query: input.query });
          return Promise.resolve({ nodes: [], degraded: false });
        },
      } as never,
      redisCache,
      {
        drainGroup() {
          drainCalls += 1;
          return Promise.resolve(
            drainCalls === 1
              ? { status: "success" as const, drained: 1 }
              : { status: "empty" as const, drained: 0 },
          );
        },
      } as never,
    );

    graphitiAsync.scheduleDrain("group-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assertEquals(refreshCalls, [{
      groupId: "group-1",
      query: "newer remembered query",
    }]);
  });

  it("drains multiple claimable batches from one scheduled trigger before refreshing", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    await redisCache.set("group-1", {
      query: "cached query",
      refreshedAt: Date.now(),
      nodes: [],
      nodeRefs: [],
    });
    await redisCache.rememberRefreshQuery("group-1", "remembered query");

    const drainStatuses = [
      { status: "success" as const, drained: 2 },
      { status: "success" as const, drained: 1 },
      { status: "empty" as const, drained: 0 },
    ];
    const drainCalls: string[] = [];
    const refreshCalls: Array<{ groupId: string; query: string }> = [];
    const graphitiAsync = new GraphitiAsyncService(
      {
        getEpisodes() {
          return Promise.resolve([]);
        },
        searchMemoryFacts() {
          return Promise.resolve([]);
        },
        searchNodesWithStatus(input: { query: string; groupIds: string[] }) {
          refreshCalls.push({ groupId: input.groupIds[0], query: input.query });
          return Promise.resolve({ nodes: [], degraded: false });
        },
      } as never,
      redisCache,
      {
        drainGroup(groupId: string) {
          drainCalls.push(groupId);
          return Promise.resolve(
            drainStatuses.shift() ?? {
              status: "empty" as const,
              drained: 0,
            },
          );
        },
      } as never,
    );

    graphitiAsync.scheduleDrain("group-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assertEquals(drainCalls, ["group-1", "group-1", "group-1"]);
    assertEquals(refreshCalls, [{
      groupId: "group-1",
      query: "remembered query",
    }]);
  });

  it("preserves an armed retry when a duplicate schedule arrives during in-flight cleanup", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    await redisCache.set("group-1", {
      query: "cached query",
      refreshedAt: Date.now(),
      nodes: [],
      nodeRefs: [],
    });

    const refreshCalls: Array<{ groupId: string; query: string }> = [];
    let releaseDrain!: () => void;
    const firstDrainStarted = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const drainCalls: string[] = [];
    let callCount = 0;
    const graphitiAsync = new GraphitiAsyncService(
      {
        getEpisodes() {
          return Promise.resolve([]);
        },
        searchMemoryFacts() {
          return Promise.resolve([]);
        },
        searchNodesWithStatus(input: { query: string; groupIds: string[] }) {
          refreshCalls.push({ groupId: input.groupIds[0], query: input.query });
          return Promise.resolve({ nodes: [], degraded: false });
        },
      } as never,
      redisCache,
      {
        async drainGroup(groupId: string) {
          drainCalls.push(groupId);
          callCount += 1;
          if (callCount === 1) {
            await firstDrainStarted;
            return { status: "retry" as const, drained: 0 };
          }
          if (callCount === 2) {
            return { status: "success" as const, drained: 1 };
          }
          return { status: "empty" as const, drained: 0 };
        },
      } as never,
      1,
    );

    const drainRetryTimers = (
      graphitiAsync as unknown as {
        drainRetryTimers: Map<string, ReturnType<typeof setTimeout>>;
      }
    ).drainRetryTimers;
    const originalSet = drainRetryTimers.set.bind(drainRetryTimers);
    drainRetryTimers.set = ((groupId, timer) => {
      const result = originalSet(groupId, timer);
      graphitiAsync.scheduleDrain(groupId);
      return result;
    }) as typeof drainRetryTimers.set;

    graphitiAsync.scheduleDrain("group-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseDrain();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitFor(() => drainCalls.length === 3);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assertEquals(drainCalls, ["group-1", "group-1", "group-1"]);
    assertEquals(refreshCalls, [{
      groupId: "group-1",
      query: "cached query",
    }]);
  });

  it("re-arms a delayed drain after backoff without stacking duplicate timers", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    await redisCache.set("group-1", {
      query: "cached query",
      refreshedAt: Date.now(),
      nodes: [],
      nodeRefs: [],
    });

    const drainStatuses = [
      { status: "backoff" as const, drained: 0 },
      { status: "success" as const, drained: 1 },
      { status: "empty" as const, drained: 0 },
    ];
    const drainCalls: string[] = [];
    const refreshCalls: Array<{ groupId: string; query: string }> = [];
    const graphitiAsync = new GraphitiAsyncService(
      {
        getEpisodes() {
          return Promise.resolve([]);
        },
        searchMemoryFacts() {
          return Promise.resolve([]);
        },
        searchNodesWithStatus(input: { query: string; groupIds: string[] }) {
          refreshCalls.push({ groupId: input.groupIds[0], query: input.query });
          return Promise.resolve({ nodes: [], degraded: false });
        },
      } as never,
      redisCache,
      {
        drainGroup(groupId: string) {
          drainCalls.push(groupId);
          return Promise.resolve(
            drainStatuses.shift() ?? {
              status: "empty" as const,
              drained: 0,
            },
          );
        },
      } as never,
      1,
    );

    graphitiAsync.scheduleDrain("group-1");
    graphitiAsync.scheduleDrain("group-1");
    await waitFor(() => drainCalls.length === 3);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assertEquals(drainCalls, ["group-1", "group-1", "group-1"]);
    assertEquals(refreshCalls, [{
      groupId: "group-1",
      query: "cached query",
    }]);
  });

  it("keeps one bounded recovery timer for a stuck same-group drain", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    await redisCache.set("group-1", {
      query: "cached query",
      refreshedAt: Date.now(),
      nodes: [],
      nodeRefs: [],
    });

    const neverSettles = new Promise<never>(() => {});
    const drainCalls: string[] = [];
    const warnSpy = spy(logger, "warn");
    const graphitiAsync = new GraphitiAsyncService(
      {
        getEpisodes() {
          return Promise.resolve([]);
        },
        searchMemoryFacts() {
          return Promise.resolve([]);
        },
        searchNodesWithStatus() {
          return Promise.resolve({ nodes: [], degraded: false });
        },
      } as never,
      redisCache,
      {
        drainGroup(groupId: string) {
          drainCalls.push(groupId);
          return neverSettles;
        },
      } as never,
      1,
      1,
    );

    try {
      const drainRecoveryTimers = (
        graphitiAsync as unknown as {
          drainRecoveryTimers: Map<
            string,
            { run: Promise<void>; timer: ReturnType<typeof setTimeout> }
          >;
        }
      ).drainRecoveryTimers;

      graphitiAsync.scheduleDrain("group-1");
      await new Promise((resolve) => setTimeout(resolve, 0));
      graphitiAsync.scheduleDrain("group-1");
      graphitiAsync.scheduleDrain("group-1");

      assertEquals(drainRecoveryTimers.size, 1);

      await waitFor(() => warnSpy.calls.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assertEquals(drainCalls, ["group-1"]);
      assertEquals(
        warnSpy.calls[0].args[0],
        "Graphiti drain recovery timeout exceeded; leaving in-flight drain intact",
      );
      assertEquals(warnSpy.calls[0].args[1], {
        groupId: "group-1",
        timeoutMs: 1,
      });
      assertEquals(drainRecoveryTimers.size, 0);
    } finally {
      warnSpy.restore();
    }
  });

  it("warns on a stuck drain even without a duplicate schedule signal", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    await redisCache.set("group-1", {
      query: "cached query",
      refreshedAt: Date.now(),
      nodes: [],
      nodeRefs: [],
    });

    const neverSettles = new Promise<never>(() => {});
    const drainCalls: string[] = [];
    const warnSpy = spy(logger, "warn");
    const graphitiAsync = new GraphitiAsyncService(
      {
        getEpisodes() {
          return Promise.resolve([]);
        },
        searchMemoryFacts() {
          return Promise.resolve([]);
        },
        searchNodesWithStatus() {
          return Promise.resolve({ nodes: [], degraded: false });
        },
      } as never,
      redisCache,
      {
        drainGroup(groupId: string) {
          drainCalls.push(groupId);
          return neverSettles;
        },
      } as never,
      1,
      1,
    );

    try {
      graphitiAsync.scheduleDrain("group-1");

      await waitFor(() => warnSpy.calls.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 0));

      assertEquals(drainCalls, ["group-1"]);
      assertEquals(
        warnSpy.calls[0].args[0],
        "Graphiti drain recovery timeout exceeded; leaving in-flight drain intact",
      );
      assertEquals(warnSpy.calls[0].args[1], {
        groupId: "group-1",
        timeoutMs: 1,
      });
    } finally {
      warnSpy.restore();
    }
  });

  it("stores fact-only refreshes with empty nodes when node search degrades", async () => {
    const redis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () => new ReconnectingRedisRuntime({ available: true }),
    });
    await redis.connect();
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    await redisCache.set("group-1", {
      query: "warm query",
      refreshedAt: 111,
      nodes: [{
        uuid: "warm-node",
        name: "WarmNode",
        summary: "Existing warm cache entry",
      }],
      nodeRefs: ["warm-node"],
    });

    const graphitiAsync = new GraphitiAsyncService(
      {
        getEpisodes() {
          return Promise.resolve([]);
        },
        searchMemoryFacts() {
          return Promise.resolve([
            {
              fact: "fact:outage",
              source_node: { name: "WarmNode" },
              target_node: { name: "OutageTopic" },
            },
          ]);
        },
        searchNodesWithStatus() {
          return Promise.resolve({ nodes: [], degraded: true });
        },
      } as never,
      redisCache,
      {
        drainGroup() {
          return Promise.resolve({ status: "success" as const });
        },
      } as never,
    );

    graphitiAsync.scheduleCacheRefresh("group-1", "outage query");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cached = await redisCache.get("group-1");
    const meta = await redisCache.getMeta("group-1");

    assertEquals(cached?.query, "outage query");
    assertEquals(cached?.nodes, []);
    assertEquals(cached?.nodeRefs, []);
    assertEquals(cached?.episodeSummaries, [
      "WarmNode → OutageTopic: fact:outage",
    ]);
    assertEquals(meta?.lastQuery, "outage query");
  });

  it("writes successful empty refresh results into cache", async () => {
    const redis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () => new ReconnectingRedisRuntime({ available: true }),
    });
    await redis.connect();
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    await redisCache.set("group-1", {
      query: "warm query",
      refreshedAt: 111,
      nodes: [{
        uuid: "warm-node",
        name: "WarmNode",
      }],
      nodeRefs: ["warm-node"],
    });

    const graphitiAsync = new GraphitiAsyncService(
      {
        getEpisodes() {
          return Promise.resolve([]);
        },
        searchMemoryFacts() {
          return Promise.resolve([]);
        },
        searchNodesWithStatus() {
          return Promise.resolve({ nodes: [], degraded: false });
        },
      } as never,
      redisCache,
      {
        drainGroup() {
          return Promise.resolve({ status: "success" as const });
        },
      } as never,
    );

    const startedAt = Date.now();
    graphitiAsync.scheduleCacheRefresh("group-1", "empty query");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cached = await redisCache.get("group-1");
    const meta = await redisCache.getMeta("group-1");

    assert(cached);
    assertEquals(cached.query, "empty query");
    assertEquals(cached.nodes, []);
    assertEquals(cached.nodeRefs, []);
    assert(cached.refreshedAt >= startedAt);
    assertEquals(meta?.lastQuery, "empty query");
  });

  it("surfaces unexpected async background failures at warn level when debug is disabled", async () => {
    setLoggerDebugOverride(false);
    const warnSpy = spy(logger, "warn");
    const debugSpy = spy(logger, "debug");
    let graphitiAsync: GraphitiAsyncService | undefined;

    try {
      graphitiAsync = new GraphitiAsyncService(
        {
          getEpisodes() {
            return Promise.reject(new Error("primer failed"));
          },
          searchMemoryFacts() {
            return Promise.resolve([]);
          },
          searchNodesWithStatus() {
            return Promise.reject(new Error("refresh failed"));
          },
        } as never,
        {
          get() {
            return Promise.resolve(null);
          },
          set() {
            return Promise.resolve();
          },
          rememberRefreshQuery() {
            return Promise.resolve();
          },
          getMeta() {
            return Promise.resolve(null);
          },
        } as never,
        {
          drainGroup() {
            return Promise.reject(new Error("drain failed"));
          },
        } as never,
      );

      graphitiAsync.schedulePrimer("group-1");
      graphitiAsync.scheduleCacheRefresh("group-1", "refresh me");
      graphitiAsync.scheduleDrain("group-1");

      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      assertEquals(warnSpy.calls.length, 3);
      assertEquals(
        new Set(warnSpy.calls.map((call) => call.args[0])),
        new Set([
          "Graphiti primer failed",
          "Graphiti cache refresh failed",
          "Graphiti drain failed",
        ]),
      );
      assertEquals(
        new Set(warnSpy.calls.map((call) => (call.args[1] as Error).message)),
        new Set(["primer failed", "refresh failed", "drain failed"]),
      );
      assertEquals(debugSpy.calls.length, 0);
    } finally {
      graphitiAsync?.dispose();
      warnSpy.restore();
      debugSpy.restore();
      setLoggerDebugOverride(undefined);
    }
  });

  it("clears pending retry and recovery timers when disposed", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    const neverSettles = new Promise<never>(() => {});
    const drainCalls: string[] = [];
    const graphitiAsync = new GraphitiAsyncService(
      {
        getEpisodes() {
          return Promise.resolve([]);
        },
        searchMemoryFacts() {
          return Promise.resolve([]);
        },
        searchNodesWithStatus() {
          return Promise.resolve({ nodes: [], degraded: false });
        },
      } as never,
      redisCache,
      {
        drainGroup(groupId: string) {
          drainCalls.push(groupId);
          return neverSettles;
        },
      } as never,
      50,
    );

    graphitiAsync.scheduleDrain("group-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    graphitiAsync.scheduleDrain("group-1");

    const internals = graphitiAsync as unknown as {
      drainRecoveryTimers: Map<
        string,
        { run: Promise<void>; timer: ReturnType<typeof setTimeout> }
      >;
      drainRetryTimers: Map<string, ReturnType<typeof setTimeout>>;
      drainInFlight: Map<string, Promise<void>>;
    };
    assertEquals(internals.drainRecoveryTimers.size, 1);
    assertEquals(internals.drainInFlight.size, 1);

    graphitiAsync.dispose();
    await new Promise((resolve) => setTimeout(resolve, 75));

    assertEquals(drainCalls, ["group-1"]);
    assertEquals(internals.drainRecoveryTimers.size, 0);
    assertEquals(internals.drainRetryTimers.size, 0);
    assertEquals(internals.drainInFlight.size, 0);
  });

  it("flushes undersized pending groups before dispose completes", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    const drainCalls: string[] = [];
    const graphitiAsync = new GraphitiAsyncService(
      {
        getEpisodes() {
          return Promise.resolve([]);
        },
        searchMemoryFacts() {
          return Promise.resolve([]);
        },
        searchNodesWithStatus() {
          return Promise.resolve({ nodes: [], degraded: false });
        },
      } as never,
      redisCache,
      {
        drainGroup(groupId: string) {
          drainCalls.push(groupId);
          return Promise.resolve(
            drainCalls.length === 1
              ? { status: "success" as const, drained: 1 }
              : { status: "empty" as const, drained: 0 },
          );
        },
      } as never,
    );

    await graphitiAsync.flushPendingGroups(["group-1"]);
    await graphitiAsync.dispose();

    assertEquals(drainCalls, ["group-1", "group-1"]);
  });

  it("classifies drift deterministically at the configured threshold boundary", () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    const aligned = redisCache.classifyRefresh({
      query: "alpha beta",
      refreshedAt: Date.now(),
      nodes: [],
      nodeRefs: [],
    }, "alpha beta gamma delta");
    const drifted = redisCache.classifyRefresh({
      query: "alpha beta",
      refreshedAt: Date.now(),
      nodes: [],
      nodeRefs: [],
    }, "alpha delta epsilon");

    assertEquals(aligned.classification, "aligned");
    assertEquals(aligned.shouldRefresh, false);
    assertEquals(aligned.similarity, 0.5);
    assertEquals(drifted.classification, "drifted");
    assertEquals(drifted.shouldRefresh, true);
  });

  it("detects primer-only and stale cache states while keeping injection available", async () => {
    const redis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () => new ReconnectingRedisRuntime({ available: true }),
    });
    await redis.connect();
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 300,
    });
    const redisSnapshot = new RedisSnapshotService(redis, { ttlSeconds: 600 });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });
    const manager = new SessionManager(
      "group-1",
      "user-1",
      { session: { get: () => ({ parentID: null }) } } as never,
      redisEvents,
      redisSnapshot,
      redisCache,
      {} as never,
    );
    manager.setParentId("session-1", null);
    manager.setState(
      "session-1",
      manager.createDefaultState("group-1", "user-1"),
    );

    await redisCache.set("group-1", {
      query: "primer",
      refreshedAt: Date.now(),
      nodes: [],
      nodeRefs: [],
      episodeSummaries: ["Primer episode"],
    });
    const primerPrepared = await manager.prepareInjection(
      "session-1",
      "real query",
    );
    assertEquals(primerPrepared?.refreshDecision.classification, "primer-only");
    assertStringIncludes(primerPrepared?.envelope ?? "", "<session_memory");

    await redisCache.set("group-1", {
      query: "older query",
      refreshedAt: Date.now() - 301_000,
      nodes: [],
      nodeRefs: [],
    });
    const stalePrepared = await manager.prepareInjection(
      "session-1",
      "older query",
    );
    assertEquals(stalePrepared?.refreshDecision.classification, "stale");
    assertStringIncludes(stalePrepared?.envelope ?? "", "<session_memory");
    assertEquals((stalePrepared?.envelope ?? "").includes("Stale fact"), false);
  });

  it("reuses same-group persistent memory across sessions while isolating other groups", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 300,
    });
    const redisSnapshot = new RedisSnapshotService(redis, { ttlSeconds: 600 });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    await redisCache.set("group-1", {
      query: "architecture token",
      refreshedAt: Date.now(),
      nodes: [{
        uuid: "node-1",
        name: "ALPHA-RECALL-42 architecture decision",
      }],
      nodeRefs: ["node-1"],
    });

    const sameGroupManager = new SessionManager(
      "group-1",
      "user-1",
      { session: { get: () => ({ parentID: null }) } } as never,
      redisEvents,
      redisSnapshot,
      redisCache,
      {} as never,
    );
    sameGroupManager.setParentId("session-b", null);
    sameGroupManager.setState(
      "session-b",
      sameGroupManager.createDefaultState("group-1", "user-1"),
    );

    const otherGroupManager = new SessionManager(
      "group-2",
      "user-2",
      { session: { get: () => ({ parentID: null }) } } as never,
      redisEvents,
      redisSnapshot,
      redisCache,
      {} as never,
    );
    otherGroupManager.setParentId("session-c", null);
    otherGroupManager.setState(
      "session-c",
      otherGroupManager.createDefaultState("group-2", "user-2"),
    );

    const sameGroupPrepared = await sameGroupManager.prepareInjection(
      "session-b",
      "architecture token",
    );
    const otherGroupPrepared = await otherGroupManager.prepareInjection(
      "session-c",
      "architecture token",
    );

    assertStringIncludes(sameGroupPrepared?.envelope ?? "", "ALPHA-RECALL-42");
    assertEquals(
      (otherGroupPrepared?.envelope ?? "").includes("ALPHA-RECALL-42"),
      false,
    );
  });

  it("schedules async refresh for stale cache while suppressing low-value stale persistent memory", async () => {
    const redis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () => new ReconnectingRedisRuntime({ available: true }),
    });
    await redis.connect();
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 300,
    });
    const redisSnapshot = new RedisSnapshotService(redis, { ttlSeconds: 600 });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    await redisCache.set("group-1", {
      query: "old recall topic",
      refreshedAt: Date.now() - 301_000,
      nodes: [],
      nodeRefs: [],
    });

    const manager = new SessionManager(
      "group-1",
      "user-1",
      { session: { get: () => ({ parentID: null }) } } as never,
      redisEvents,
      redisSnapshot,
      redisCache,
      {} as never,
    );
    manager.setParentId("session-1", null);
    manager.setState(
      "session-1",
      manager.createDefaultState("group-1", "user-1"),
    );

    const refreshCalls: Array<{ groupId: string; query: string }> = [];
    const graphitiAsync = {
      scheduleCacheRefresh(groupId: string, query: string) {
        refreshCalls.push({ groupId, query });
      },
      scheduleDrain() {},
    };

    const chat = createChatHandler({
      sessionManager: manager,
      redisEvents,
      graphitiAsync: graphitiAsync as never,
      drainTriggerSize: 999,
    });
    const transform = createMessagesHandler({ sessionManager: manager });

    await chat(
      { sessionID: "session-1" } as never,
      {
        parts: [{
          type: "text",
          text: "new recall topic",
        }],
      } as never,
    );

    const transformOutput = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{
          type: "text",
          text: "new recall topic",
        }],
      }],
    };
    await transform(
      { message: "new recall topic" } as never,
      transformOutput as never,
    );

    assertEquals(refreshCalls, [{
      groupId: "group-1",
      query: "new recall topic",
    }]);
    assertStringIncludes(
      transformOutput.messages[0].parts[0].text,
      "<session_memory",
    );
    assertEquals(
      transformOutput.messages[0].parts[0].text.includes(
        "Stale but still useful recall fact",
      ),
      false,
    );
  });
});
