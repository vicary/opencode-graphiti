import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { RedisClient } from "./redis-client.ts";

type RedisEvent = "close" | "end" | "error" | "ready";

class FakeRedisRuntime {
  private readonly values = new Map<string, string>();
  private readonly listeners = new Map<
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
    if (!this.state.available) {
      return Promise.reject(new Error("redis unavailable"));
    }
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
    if (!this.state.available) {
      return Promise.reject(new Error("redis unavailable"));
    }
    return Promise.resolve(this.values.delete(key) ? 1 : 0);
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
      factUuids: "fact-1,fact-2",
    }, 60);

    assertEquals(await redis.getHashAll("memory-cache:group-1:meta"), {
      lastQuery: "Continue overhaul",
      lastRefresh: "123",
      factUuids: "fact-1,fact-2",
    });
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

    assertEquals(await redis.getString("key"), "before-disconnect");
    await redis.setString("key", "after-reconnect");
    assertEquals(await redis.getString("key"), "after-reconnect");

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
