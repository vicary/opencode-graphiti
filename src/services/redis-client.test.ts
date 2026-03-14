import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { setSuppressConsoleWarningsDuringTestsOverride } from "./opencode-warning.ts";
import { RedisClient } from "./redis-client.ts";
import { RedisSnapshotService } from "./redis-snapshot.ts";

type RedisEvent = "close" | "end" | "error" | "ready";

setSuppressConsoleWarningsDuringTestsOverride(true);

class FakeRedisRuntime {
  private readonly values = new Map<string, string>();
  private readonly lists = new Map<string, string[]>();
  private readonly listeners = new Map<
    RedisEvent,
    Set<(...args: unknown[]) => void>
  >();

  constructor(protected readonly state: { available: boolean }) {}

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
    if (this.values.has(source) || this.values.has(destination)) {
      return Promise.reject(
        new Error(
          "WRONGTYPE Operation against a key holding the wrong kind of value",
        ),
      );
    }

    const sourceList = this.lists.get(source);
    if (!sourceList || sourceList.length === 0) return Promise.resolve(null);

    const value = sourceSide === "LEFT" ? sourceList.shift() : sourceList.pop();
    if (value === undefined) return Promise.resolve(null);

    if (sourceList.length === 0) {
      this.lists.delete(source);
    }

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
    if (this.values.has(key)) {
      return Promise.reject(
        new Error(
          "WRONGTYPE Operation against a key holding the wrong kind of value",
        ),
      );
    }
    const list = this.lists.get(key) ?? [];
    return Promise.resolve(list.slice(start, stop + 1));
  }

  llen(key: string): Promise<number> {
    this.ensureAvailable();
    if (this.values.has(key)) {
      return Promise.reject(
        new Error(
          "WRONGTYPE Operation against a key holding the wrong kind of value",
        ),
      );
    }
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
    if (!this.state.available) {
      return Promise.reject(new Error("redis unavailable"));
    }
    return Promise.resolve(this.values.get(key) ?? null);
  }

  set(
    key: string,
    value: string,
    ..._args: Array<string | number>
  ): Promise<"OK"> {
    if (this.lists.has(key)) {
      return Promise.reject(
        new Error(
          "WRONGTYPE Operation against a key holding the wrong kind of value",
        ),
      );
    }
    this.ensureAvailable();
    this.values.set(key, value);
    return Promise.resolve("OK");
  }

  expire(_key: string, _ttlSeconds: number): Promise<number> {
    if (!this.state.available) {
      return Promise.reject(new Error("redis unavailable"));
    }
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

  getStringValue(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  getListValues(key: string): string[] {
    return [...(this.lists.get(key) ?? [])];
  }
}

class HashReadOnlyRedisRuntime extends FakeRedisRuntime {
  protected readonly hashes = new Map<string, Map<string, string>>();

  hgetall(key: string): Promise<Record<string, string>> {
    this.ensureAvailable();
    return Promise.resolve(
      Object.fromEntries((this.hashes.get(key) ?? new Map()).entries()),
    );
  }

  override del(key: string): Promise<number> {
    this.ensureAvailable();
    const deletedHash = this.hashes.delete(key);
    return super.del(key).then((
      deleted,
    ) => (deletedHash || deleted === 1 ? 1 : 0));
  }

  seedHash(key: string, values: Record<string, string>): void {
    this.hashes.set(key, new Map(Object.entries(values)));
  }
}

class HashRedisRuntime extends HashReadOnlyRedisRuntime {
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
}

class DeferredConnectRedisRuntime extends FakeRedisRuntime {
  private resolveConnect?: () => void;
  private readonly connectGate = new Promise<void>((resolve) => {
    this.resolveConnect = resolve;
  });

  override async connect(): Promise<void> {
    await this.connectGate;
    await super.connect();
  }

  resumeConnect(): void {
    this.resolveConnect?.();
  }
}

class ObservableDeferredConnectRedisRuntime
  extends DeferredConnectRedisRuntime {
  quitCalls = 0;

  override quit(): Promise<"OK"> {
    this.quitCalls += 1;
    return super.quit();
  }
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert(condition(), "condition not met before timeout");
}

describe("redis client", () => {
  it("honors NX semantics in the in-memory fallback store", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const memory = (redis as unknown as {
      memory: {
        set(
          key: string,
          value: string,
          ...args: Array<string | number>
        ): Promise<"OK" | null>;
      };
    }).memory;

    assertEquals(await memory.set("lock", "first", "NX", "EX", 30), "OK");
    assertEquals(await memory.set("lock", "second", "NX", "EX", 30), null);
    assertEquals(await redis.getString("lock"), "first");
  });

  it("touches only when the stored token matches", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });

    await redis.setString("lock", "first", 1);

    assertEquals(await redis.compareAndTouch("lock", "second", 60), false);
    assertEquals(await redis.getString("lock"), "first");

    assertEquals(await redis.compareAndTouch("lock", "first", 60), true);
    assertEquals(await redis.getString("lock"), "first");
  });

  it("matches Redis WRONGTYPE behavior in the in-memory fallback list helpers", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });

    await redis.setString("queue", "not-a-list");

    await assertRejects(
      () => redis.appendToList("queue", "value"),
      Error,
      "WRONGTYPE",
    );
  });

  it("stores cache metadata in hashes and reads it back", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });

    await redis.setHashFields("memory-cache:group-1:meta", {
      lastQuery: "Continue overhaul",
      lastRefresh: 123,
      retainedField: "fact-1,fact-2",
    }, 60);

    assertEquals(await redis.getHashAll("memory-cache:group-1:meta"), {
      lastQuery: "Continue overhaul",
      lastRefresh: "123",
      retainedField: "fact-1,fact-2",
    });
  });

  it("enforces TTL on in-memory hash fallbacks when the runtime lacks hash support", async () => {
    const redis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () => new FakeRedisRuntime({ available: true }),
    });

    await redis.connect();
    await redis.setHashFields("memory-cache:group-1:meta", {
      lastQuery: "Continue overhaul",
    }, 0.001);
    assertEquals(await redis.getHashAll("memory-cache:group-1:meta"), {
      lastQuery: "Continue overhaul",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    assertEquals(await redis.getHashAll("memory-cache:group-1:meta"), {});
    await redis.close();
  });

  it("merges fallback hash fields with live hgetall reads when hset is unavailable", async () => {
    const runtime = new HashReadOnlyRedisRuntime({ available: true });
    const redis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () => runtime,
    });

    await redis.connect();
    await redis.setHashFields("memory-cache:group-1:meta", {
      fallbackOnly: "local",
      shared: "fallback",
    });
    runtime.seedHash("memory-cache:group-1:meta", {
      liveOnly: "remote",
      shared: "live",
    });

    assertEquals(await redis.getHashAll("memory-cache:group-1:meta"), {
      liveOnly: "remote",
      shared: "fallback",
      fallbackOnly: "local",
    });

    await redis.close();
  });

  it("keeps fallback hash reads consistent after reconnecting to a runtime without hset", async () => {
    const state = { available: false };
    const runtime = new HashReadOnlyRedisRuntime(state);
    const redis = new RedisClient({
      endpoint: "redis://unused",
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      runtimeFactory: () => runtime,
    });

    await redis.connect();
    await redis.setHashFields("memory-cache:group-1:meta", {
      fallbackOnly: "local",
    });

    state.available = true;
    runtime.seedHash("memory-cache:group-1:meta", {
      liveOnly: "remote",
    });
    await waitFor(() => redis.isConnected());

    assertEquals(await redis.getHashAll("memory-cache:group-1:meta"), {
      liveOnly: "remote",
      fallbackOnly: "local",
    });

    await redis.close();
  });

  it("reconnects after startup failure and swaps back to live redis", async () => {
    const state = { available: false };
    const runtime = new FakeRedisRuntime(state);
    const redis = new RedisClient({
      endpoint: "redis://unused",
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      runtimeFactory: () => runtime,
    });

    await redis.connect();
    assertEquals(redis.isConnected(), false);

    await redis.setString("key", "memory-value");
    assertEquals(await redis.getString("key"), "memory-value");

    state.available = true;
    await waitFor(() => redis.isConnected());

    await redis.setString("key", "redis-value");
    assertEquals(await redis.getString("key"), "redis-value");

    await redis.close();
  });

  it("reconnects after a transient disconnect and resumes live redis reads", async () => {
    const state = { available: true };
    const runtime = new FakeRedisRuntime(state);
    const redis = new RedisClient({
      endpoint: "redis://unused",
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      runtimeFactory: () => runtime,
    });

    await redis.connect();
    assertEquals(redis.isConnected(), true);

    await redis.setString("key", "before-disconnect");
    assertEquals(await redis.getString("key"), "before-disconnect");

    state.available = false;
    runtime.emit("close");
    assertEquals(redis.isConnected(), false);

    await redis.setString("key", "memory-during-outage");
    assertEquals(await redis.getString("key"), "memory-during-outage");

    state.available = true;
    await waitFor(() => redis.isConnected());

    assertEquals(await redis.getString("key"), "memory-during-outage");
    assertEquals(runtime.getStringValue("key"), "memory-during-outage");
    await redis.setString("key", "after-reconnect");
    assertEquals(await redis.getString("key"), "after-reconnect");

    await redis.close();
  });

  it("does not resurrect a stale fallback string after a live update and later reconnect", async () => {
    const state = { available: true };
    const runtime = new FakeRedisRuntime(state);
    const redis = new RedisClient({
      endpoint: "redis://unused",
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      runtimeFactory: () => runtime,
    });

    await redis.connect();
    assertEquals(redis.isConnected(), true);

    state.available = false;
    runtime.emit("close");
    assertEquals(redis.isConnected(), false);

    await redis.setString("key", "fallback-value");
    assertEquals(await redis.getString("key"), "fallback-value");

    state.available = true;
    await waitFor(() => redis.isConnected());
    await waitFor(() => runtime.getStringValue("key") === "fallback-value");

    await redis.setString("key", "live-after-reconnect");
    assertEquals(await redis.getString("key"), "live-after-reconnect");
    assertEquals(runtime.getStringValue("key"), "live-after-reconnect");

    state.available = false;
    runtime.emit("close");
    assertEquals(redis.isConnected(), false);

    state.available = true;
    await waitFor(() => redis.isConnected());

    assertEquals(await redis.getString("key"), "live-after-reconnect");
    assertEquals(runtime.getStringValue("key"), "live-after-reconnect");

    await redis.close();
  });

  it("does not resurrect a stale fallback string after a live delete and later reconnect", async () => {
    const state = { available: true };
    const runtime = new FakeRedisRuntime(state);
    const redis = new RedisClient({
      endpoint: "redis://unused",
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      runtimeFactory: () => runtime,
    });

    await redis.connect();
    assertEquals(redis.isConnected(), true);

    state.available = false;
    runtime.emit("close");
    assertEquals(redis.isConnected(), false);

    await redis.setString("key", "fallback-value");
    assertEquals(await redis.getString("key"), "fallback-value");

    state.available = true;
    await waitFor(() => redis.isConnected());
    await waitFor(() => runtime.getStringValue("key") === "fallback-value");

    await redis.deleteKey("key");
    assertEquals(await redis.getString("key"), null);
    assertEquals(runtime.getStringValue("key"), null);

    state.available = false;
    runtime.emit("close");
    assertEquals(redis.isConnected(), false);

    state.available = true;
    await waitFor(() => redis.isConnected());

    assertEquals(await redis.getString("key"), null);
    assertEquals(runtime.getStringValue("key"), null);

    await redis.close();
  });

  it("replays startup-race fallback writes before initial live runtime use", async () => {
    const state = { available: true };
    const runtime = new DeferredConnectRedisRuntime(state);
    const redis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () => runtime,
    });

    const connectPromise = redis.connect();
    await redis.setString("key", "written-during-connect");
    assertEquals(await redis.getString("key"), "written-during-connect");

    runtime.resumeConnect();
    await connectPromise;

    assertEquals(redis.isConnected(), true);
    assertEquals(await redis.getString("key"), "written-during-connect");
    assertEquals(runtime.getStringValue("key"), "written-during-connect");

    await redis.close();
  });

  it("replays pending fallback mutations only once across repeated ready paths", async () => {
    const state = { available: true };
    const runtime = new DeferredConnectRedisRuntime(state);
    const redis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () => runtime,
    });

    const connectPromise = redis.connect();
    await redis.appendToList("queue", "entry-1");
    await redis.appendToList("queue", "entry-2");

    runtime.resumeConnect();
    await connectPromise;
    runtime.emit("ready");
    runtime.emit("ready");

    assertEquals(await redis.getRecentList("queue", 10), [
      "entry-1",
      "entry-2",
    ]);
    assertEquals(runtime.getListValues("queue"), ["entry-1", "entry-2"]);

    await redis.close();
  });

  it("does not replay the same pending fallback mutation set more than once across reconnect cycles", async () => {
    const state = { available: true };
    const runtime = new FakeRedisRuntime(state);
    const redis = new RedisClient({
      endpoint: "redis://unused",
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      runtimeFactory: () => runtime,
    });

    await redis.connect();
    await redis.appendToList("queue", "live-entry");

    state.available = false;
    runtime.emit("close");
    await redis.appendToList("queue", "fallback-entry");

    state.available = true;
    await waitFor(() => redis.isConnected());
    assertEquals(await redis.getRecentList("queue", 10), [
      "live-entry",
      "fallback-entry",
    ]);
    assertEquals(runtime.getListValues("queue"), [
      "live-entry",
      "fallback-entry",
    ]);

    state.available = false;
    runtime.emit("close");
    state.available = true;
    await waitFor(() => redis.isConnected());

    assertEquals(await redis.getRecentList("queue", 10), [
      "live-entry",
      "fallback-entry",
    ]);
    assertEquals(runtime.getListValues("queue"), [
      "live-entry",
      "fallback-entry",
    ]);

    await redis.close();
  });

  it("coalesces repeated fallback list replays for the same key while disconnected", async () => {
    const state = { available: true };
    const runtime = new FakeRedisRuntime(state);
    const redis = new RedisClient({
      endpoint: "redis://unused",
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      runtimeFactory: () => runtime,
    });

    await redis.connect();
    state.available = false;
    runtime.emit("close");

    await redis.appendToList("queue", "first");
    await redis.appendToList("queue", "second");

    const pendingFallbackReplays = (redis as unknown as {
      pendingFallbackReplays: Map<string, unknown>;
    }).pendingFallbackReplays;
    assertEquals(pendingFallbackReplays.size, 1);

    state.available = true;
    await waitFor(() => redis.isConnected());

    assertEquals(await redis.getRecentList("queue", 10), ["first", "second"]);
    assertEquals(runtime.getListValues("queue"), ["first", "second"]);

    await redis.close();
  });

  it("keeps the non-durable side of a live mixed move synchronized for outage fallback", async () => {
    const state = { available: true };
    const runtime = new FakeRedisRuntime(state);
    const redis = new RedisClient({
      endpoint: "redis://unused",
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      runtimeFactory: () => runtime,
    });

    await redis.connect();
    await redis.appendToList("cache:queue:group-1", "live-before-move");
    assertEquals(
      await redis.moveListItem(
        "cache:queue:group-1",
        "drain:pending:group-1",
        "LEFT",
        "RIGHT",
      ),
      "live-before-move",
    );

    assertEquals(runtime.getListValues("cache:queue:group-1"), []);
    assertEquals(runtime.getListValues("drain:pending:group-1"), [
      "live-before-move",
    ]);

    state.available = false;
    runtime.emit("close");

    assertEquals(await redis.getRecentList("cache:queue:group-1", 10), []);
    assertEquals(runtime.getListValues("cache:queue:group-1"), []);
    assertEquals(await redis.getRecentList("drain:pending:group-1", 10), []);

    state.available = true;
    await waitFor(() => redis.isConnected());

    assertEquals(runtime.getListValues("cache:queue:group-1"), []);
    assertEquals(runtime.getListValues("drain:pending:group-1"), [
      "live-before-move",
    ]);

    await redis.close();
  });

  it("keeps live hash metadata available through outage fallback after reconnect", async () => {
    const state = { available: true };
    const runtime = new HashRedisRuntime(state);
    const redis = new RedisClient({
      endpoint: "redis://unused",
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      runtimeFactory: () => runtime,
    });

    await redis.connect();
    await redis.setHashFields("memory-cache:group-1:meta", {
      lastQuery: "before outage",
    });

    state.available = false;
    runtime.emit("close");
    await redis.setHashFields("memory-cache:group-1:meta", {
      fallbackOnly: "during outage",
    });

    state.available = true;
    await waitFor(() => redis.isConnected());
    await redis.setHashFields("memory-cache:group-1:meta", {
      lastRefresh: 456,
    }, 60);
    assertEquals(await redis.getHashAll("memory-cache:group-1:meta"), {
      lastQuery: "before outage",
      fallbackOnly: "during outage",
      lastRefresh: "456",
    });

    state.available = false;
    runtime.emit("close");

    assertEquals(await redis.getHashAll("memory-cache:group-1:meta"), {
      lastQuery: "before outage",
      fallbackOnly: "during outage",
      lastRefresh: "456",
    });

    await redis.close();
  });

  it("mirrors live snapshot touch TTL into fallback memory", async () => {
    const state = { available: true };
    const runtime = new FakeRedisRuntime(state);
    const redis = new RedisClient({
      endpoint: "redis://unused",
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      runtimeFactory: () => runtime,
    });
    const snapshots = new RedisSnapshotService(redis, { ttlSeconds: 1.2 });

    await redis.connect();
    await snapshots.saveSnapshot("session-1", "snapshot-value");
    await new Promise((resolve) => setTimeout(resolve, 750));
    await snapshots.touchSnapshot("session-1");

    state.available = false;
    runtime.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 500));

    assertEquals(await snapshots.getSnapshot("session-1"), "snapshot-value");

    await redis.close();
  });

  it("fails closed for durable drain lock writes during an outage", async () => {
    const state = { available: true };
    const runtime = new FakeRedisRuntime(state);
    const redis = new RedisClient({
      endpoint: "redis://unused",
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      runtimeFactory: () => runtime,
    });

    await redis.connect();
    assertEquals(redis.isConnected(), true);

    assertEquals(
      await redis.setStringIfAbsent(
        "drain:claim-lock:group-1",
        "live-token",
        30,
      ),
      true,
    );
    assertEquals(
      await redis.getString("drain:claim-lock:group-1"),
      "live-token",
    );

    state.available = false;
    runtime.emit("close");
    assertEquals(redis.isConnected(), false);

    await assertRejects(
      () =>
        redis.setStringIfAbsent("drain:claim-lock:group-1", "outage-token", 30),
      Error,
      "Redis hot tier unavailable for durable drain-state mutation",
    );
    assertEquals(await redis.getString("drain:claim-lock:group-1"), null);

    state.available = true;
    await waitFor(() => redis.isConnected());

    assertEquals(
      await redis.getString("drain:claim-lock:group-1"),
      "live-token",
    );

    await redis.close();
  });

  it("fails closed for durable drain queue writes during an outage", async () => {
    const state = { available: true };
    const runtime = new FakeRedisRuntime(state);
    const redis = new RedisClient({
      endpoint: "redis://unused",
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      runtimeFactory: () => runtime,
    });

    await redis.connect();
    assertEquals(redis.isConnected(), true);

    state.available = false;
    runtime.emit("close");
    assertEquals(redis.isConnected(), false);

    await assertRejects(
      () => redis.appendToList("drain:pending:group-1", '{"id":"entry-1"}', 30),
      Error,
      "Redis hot tier unavailable for durable drain-state mutation",
    );
    assertEquals(await redis.getListLength("drain:pending:group-1"), 0);

    state.available = true;
    await waitFor(() => redis.isConnected());

    assertEquals(
      await redis.appendToList("drain:pending:group-1", '{"id":"entry-2"}', 30),
      1,
    );
    assertEquals(await redis.getListLength("drain:pending:group-1"), 1);

    await redis.close();
  });

  it("ignores stale runtime ready events during reconnect", async () => {
    const firstState = { available: true };
    const secondState = { available: true };
    const firstRuntime = new FakeRedisRuntime(firstState);
    const secondRuntime = new DeferredConnectRedisRuntime(secondState);
    let factoryCalls = 0;
    const redis = new RedisClient({
      endpoint: "redis://unused",
      reconnectBaseDelayMs: 10,
      reconnectMaxDelayMs: 10,
      runtimeFactory: () => {
        factoryCalls += 1;
        return factoryCalls === 1 ? firstRuntime : secondRuntime;
      },
    });

    await redis.connect();
    assertEquals(redis.isConnected(), true);

    firstState.available = false;
    firstRuntime.emit("close");
    assertEquals(redis.isConnected(), false);

    await waitFor(() => factoryCalls === 2);
    firstRuntime.emit("ready");
    assertEquals(redis.isConnected(), false);

    secondRuntime.resumeConnect();
    await waitFor(() => redis.isConnected());
    assertEquals(redis.isConnected(), true);

    await redis.close();
  });

  it("does not reinstall a runtime after close during an in-flight connect", async () => {
    const state = { available: true };
    const runtime = new ObservableDeferredConnectRedisRuntime(state);
    const redis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () => runtime,
    });

    const connectPromise = redis.connect();
    await redis.close();
    runtime.resumeConnect();
    await connectPromise;

    assertEquals(redis.isConnected(), false);
    assertEquals(runtime.quitCalls, 1);
  });
});
