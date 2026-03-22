import { logger } from "./logger.ts";

type TimerValue = string | string[] | Map<string, string>;

type TimerHandle = ReturnType<typeof setTimeout>;

type RedisEvent = "close" | "end" | "error" | "ready";

type RedisRuntime = {
  ping(): Promise<unknown>;
  quit(): Promise<unknown>;
  lpush(key: string, value: string): Promise<number>;
  rpush(key: string, value: string): Promise<number>;
  lmove(
    source: string,
    destination: string,
    sourceSide: "LEFT" | "RIGHT",
    destinationSide: "LEFT" | "RIGHT",
  ): Promise<string | null>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  llen(key: string): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lindex(key: string, index: number): Promise<string | null>;
  lset(key: string, index: number, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  hset?(key: string, values: Record<string, string>): Promise<number>;
  hgetall?(key: string): Promise<Record<string, string>>;
  set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<unknown>;
  expire(key: string, ttlSeconds: number): Promise<number>;
  del(key: string): Promise<number>;
  eval?(script: string, numKeys: number, ...args: string[]): Promise<number>;
  connect?(): Promise<void>;
  on?(event: RedisEvent, listener: (...args: unknown[]) => void): unknown;
  off?(event: RedisEvent, listener: (...args: unknown[]) => void): unknown;
};

type RedisRuntimeFactory = (
  endpoint: string,
) => Promise<RedisRuntime> | RedisRuntime;

type RuntimeListeners = {
  close: () => void;
  end: () => void;
  error: (error: unknown) => void;
  ready: () => void;
};

type StoredValue = {
  value: TimerValue;
  expiresAt?: number;
};

export type RedisKeySnapshot =
  | { kind: "missing" }
  | { kind: "string"; value: string; ttlSeconds?: number }
  | { kind: "list"; values: string[]; ttlSeconds?: number }
  | { kind: "hash"; values: Record<string, string>; ttlSeconds?: number };

class InMemoryRedisStore implements RedisRuntime {
  private readonly values = new Map<string, StoredValue>();

  ping(): Promise<"PONG"> {
    return Promise.resolve("PONG");
  }

  quit(): Promise<"OK"> {
    return Promise.resolve("OK");
  }

  private cleanup(key: string): void {
    const value = this.values.get(key);
    if (!value?.expiresAt) return;
    if (value.expiresAt <= Date.now()) this.values.delete(key);
  }

  private ensureList(key: string): string[] {
    this.cleanup(key);
    const existing = this.values.get(key);
    if (existing) {
      if (!Array.isArray(existing.value)) {
        throw new Error(
          "WRONGTYPE Operation against a key holding the wrong kind of value",
        );
      }
      return existing.value;
    }
    const list: string[] = [];
    this.values.set(key, { value: list });
    return list;
  }

  private ensureHash(key: string): Map<string, string> {
    this.cleanup(key);
    const existing = this.values.get(key);
    if (existing) {
      if (!(existing.value instanceof Map)) {
        throw new Error(
          "WRONGTYPE Operation against a key holding the wrong kind of value",
        );
      }
      return existing.value;
    }
    const hash = new Map<string, string>();
    this.values.set(key, { value: hash });
    return hash;
  }

  private parseSetArgs(args: Array<string | number>): {
    onlyIfAbsent: boolean;
    ttlSeconds?: number;
  } {
    let onlyIfAbsent = false;
    let ttlSeconds: number | undefined;

    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "NX") {
        onlyIfAbsent = true;
        continue;
      }
      if (arg === "EX") {
        const next = args[index + 1];
        if (typeof next !== "number") {
          throw new Error("ERR unsupported in-memory Redis SET arguments");
        }
        ttlSeconds = next;
        index += 1;
        continue;
      }
      throw new Error("ERR unsupported in-memory Redis SET arguments");
    }

    return { onlyIfAbsent, ttlSeconds };
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
    this.cleanup(source);
    this.cleanup(destination);
    const existing = this.values.get(source);
    if (
      !existing || !Array.isArray(existing.value) || existing.value.length === 0
    ) {
      return Promise.resolve(null);
    }

    const sourceList = existing.value;
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
    this.cleanup(key);
    const existing = this.values.get(key);
    if (!existing || !Array.isArray(existing.value)) return Promise.resolve([]);
    const list = existing.value;
    const normalizeIndex = (index: number): number =>
      index < 0 ? Math.max(list.length + index, 0) : index;
    const from = normalizeIndex(start);
    const to = stop < 0 ? list.length + stop : stop;
    return Promise.resolve(list.slice(from, to + 1));
  }

  llen(key: string): Promise<number> {
    this.cleanup(key);
    const existing = this.values.get(key);
    return Promise.resolve(
      existing && Array.isArray(existing.value) ? existing.value.length : 0,
    );
  }

  lindex(key: string, index: number): Promise<string | null> {
    this.cleanup(key);
    const existing = this.values.get(key);
    if (!existing || !Array.isArray(existing.value)) {
      return Promise.resolve(null);
    }
    const list = existing.value;
    const normalized = index < 0 ? list.length + index : index;
    return Promise.resolve(list[normalized] ?? null);
  }

  lset(key: string, index: number, value: string): Promise<void> {
    this.cleanup(key);
    const existing = this.values.get(key);
    if (!existing || !Array.isArray(existing.value)) {
      return Promise.reject(new Error("ERR no such key"));
    }
    const list = existing.value;
    const normalized = index < 0 ? list.length + index : index;
    if (normalized < 0 || normalized >= list.length) {
      return Promise.reject(new Error("ERR index out of range"));
    }
    list[normalized] = value;
    return Promise.resolve();
  }

  ltrim(key: string, start: number, stop: number): Promise<void> {
    this.cleanup(key);
    const existing = this.values.get(key);
    if (!existing || !Array.isArray(existing.value)) return Promise.resolve();
    const list = existing.value;
    const normalizeIndex = (index: number): number =>
      index < 0 ? Math.max(list.length + index, 0) : index;
    const trimmed = list.slice(
      normalizeIndex(start),
      stop < 0 ? list.length + stop + 1 : stop + 1,
    );
    existing.value = trimmed;
    return Promise.resolve();
  }

  get(key: string): Promise<string | null> {
    this.cleanup(key);
    const existing = this.values.get(key);
    return Promise.resolve(
      existing && typeof existing.value === "string" ? existing.value : null,
    );
  }

  hset(key: string, values: Record<string, string>): Promise<number> {
    const hash = this.ensureHash(key);
    let added = 0;
    for (const [field, value] of Object.entries(values)) {
      if (!hash.has(field)) added += 1;
      hash.set(field, value);
    }
    return Promise.resolve(added);
  }

  hgetall(key: string): Promise<Record<string, string>> {
    this.cleanup(key);
    const existing = this.values.get(key);
    if (!existing) return Promise.resolve({});
    if (!(existing.value instanceof Map)) {
      return Promise.reject(
        new Error(
          "WRONGTYPE Operation against a key holding the wrong kind of value",
        ),
      );
    }
    return Promise.resolve(Object.fromEntries(existing.value.entries()));
  }

  set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<"OK" | null> {
    this.cleanup(key);
    const { onlyIfAbsent, ttlSeconds } = this.parseSetArgs(args);
    if (onlyIfAbsent && this.values.has(key)) return Promise.resolve(null);
    this.values.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    });
    return Promise.resolve("OK");
  }

  expire(key: string, ttlSeconds: number): Promise<number> {
    this.cleanup(key);
    const existing = this.values.get(key);
    if (!existing) return Promise.resolve(0);
    existing.expiresAt = Date.now() + ttlSeconds * 1000;
    return Promise.resolve(1);
  }

  del(key: string): Promise<number> {
    return Promise.resolve(this.values.delete(key) ? 1 : 0);
  }

  setIfAbsent(
    key: string,
    value: string,
    ttlSeconds?: number,
  ): Promise<boolean> {
    this.cleanup(key);
    if (this.values.has(key)) return Promise.resolve(false);
    this.values.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    });
    return Promise.resolve(true);
  }

  deleteIfValue(key: string, expectedValue: string): Promise<boolean> {
    this.cleanup(key);
    const existing = this.values.get(key);
    if (!existing || typeof existing.value !== "string") {
      return Promise.resolve(false);
    }
    if (existing.value !== expectedValue) return Promise.resolve(false);
    this.values.delete(key);
    return Promise.resolve(true);
  }

  compareAndExpire(
    key: string,
    expectedValue: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    this.cleanup(key);
    const existing = this.values.get(key);
    if (!existing || typeof existing.value !== "string") {
      return Promise.resolve(false);
    }
    if (existing.value !== expectedValue) return Promise.resolve(false);
    existing.expiresAt = Date.now() + ttlSeconds * 1000;
    return Promise.resolve(true);
  }

  keys(prefix = ""): string[] {
    const results: string[] = [];
    for (const key of [...this.values.keys()]) {
      this.cleanup(key);
      if (this.values.has(key) && key.startsWith(prefix)) results.push(key);
    }
    return results.sort();
  }

  snapshot(key: string): RedisKeySnapshot {
    this.cleanup(key);
    const existing = this.values.get(key);
    if (!existing) return { kind: "missing" };

    const ttlSeconds = existing.expiresAt
      ? Math.max(Math.ceil((existing.expiresAt - Date.now()) / 1000), 1)
      : undefined;

    if (typeof existing.value === "string") {
      return { kind: "string", value: existing.value, ttlSeconds };
    }

    if (Array.isArray(existing.value)) {
      return { kind: "list", values: [...existing.value], ttlSeconds };
    }

    return {
      kind: "hash",
      values: Object.fromEntries(existing.value.entries()),
      ttlSeconds,
    };
  }
}

export interface RedisClientOptions {
  endpoint: string;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  runtimeFactory?: RedisRuntimeFactory;
}

export class RedisClient {
  private readonly memory = new InMemoryRedisStore();
  private readonly hashFallbackKeys = new Set<string>();
  private readonly pendingFallbackReplays = new Map<
    string,
    (runtime: RedisRuntime) => Promise<void>
  >();
  private readonly runtimeListeners = new WeakMap<
    RedisRuntime,
    RuntimeListeners
  >();
  private redis: RedisRuntime | null = null;
  private connected = false;
  private closed = false;
  private finalizingRuntime = false;
  private reconnectTimer: TimerHandle | null = null;
  private reconnectAttempts = 0;
  private connectAttempt: Promise<boolean> | null = null;

  constructor(private readonly options: RedisClientOptions) {}

  async connect(): Promise<void> {
    this.closed = false;
    await this.tryConnectOnce();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearReconnectTimer();
    const runtime = this.redis;
    if (!runtime) return;

    this.detachRuntimeListeners(runtime);
    try {
      await runtime.quit();
    } finally {
      this.redis = null;
      this.connected = false;
    }
  }

  private getReconnectDelayMs(): number {
    const baseDelay = this.options.reconnectBaseDelayMs ?? 1_000;
    const maxDelay = this.options.reconnectMaxDelayMs ?? 30_000;
    return Math.min(
      baseDelay * (2 ** Math.max(this.reconnectAttempts - 1, 0)),
      maxDelay,
    );
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.connected || this.reconnectTimer !== null) return;
    const delayMs = this.getReconnectDelayMs();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.tryConnectOnce();
    }, delayMs);
  }

  private async createRuntime(): Promise<RedisRuntime> {
    if (this.options.runtimeFactory) {
      return await this.options.runtimeFactory(this.options.endpoint);
    }

    const module = await import("npm:ioredis@^5.7.0");
    const RedisCtor = (module as unknown as {
      default: new (
        endpoint: string,
        options: {
          lazyConnect: boolean;
          maxRetriesPerRequest: number;
          retryStrategy: () => null;
        },
      ) => RedisRuntime & { connect(): Promise<void> };
    }).default;

    return new RedisCtor(this.options.endpoint, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
  }

  private attachRuntimeListeners(runtime: RedisRuntime): void {
    const listeners: RuntimeListeners = {
      close: () => {
        this.handleDisconnect(runtime);
      },
      end: () => {
        this.handleDisconnect(runtime);
      },
      error: (error: unknown) => {
        this.handleDisconnect(runtime, error);
      },
      ready: () => {
        if (runtime !== this.redis || this.finalizingRuntime) return;
        this.connected = true;
        this.reconnectAttempts = 0;
        this.clearReconnectTimer();
      },
    };

    this.runtimeListeners.set(runtime, listeners);

    runtime.on?.("close", listeners.close);
    runtime.on?.("end", listeners.end);
    runtime.on?.("error", listeners.error);
    runtime.on?.("ready", listeners.ready);
  }

  private detachRuntimeListeners(runtime: RedisRuntime): void {
    const listeners = this.runtimeListeners.get(runtime);
    if (!listeners) return;

    runtime.off?.("close", listeners.close);
    runtime.off?.("end", listeners.end);
    runtime.off?.("error", listeners.error);
    runtime.off?.("ready", listeners.ready);
    this.runtimeListeners.delete(runtime);
  }

  private async replaceRuntime(runtime: RedisRuntime): Promise<void> {
    if (this.closed) {
      await this.disposeFailedRuntime(runtime);
      this.connected = false;
      return;
    }

    const previous = this.redis;
    if (previous === runtime) return;

    this.redis = runtime;
    this.connected = false;
    this.finalizingRuntime = true;

    try {
      await this.replayPendingFallbackMutations(runtime);
      this.connected = true;
      this.reconnectAttempts = 0;
      this.clearReconnectTimer();
    } catch (error) {
      this.finalizingRuntime = false;
      this.handleDisconnect(runtime, error);
      return;
    }

    this.finalizingRuntime = false;

    if (!previous) return;

    this.detachRuntimeListeners(previous);
    try {
      await previous.quit();
    } catch {
      // Ignore teardown errors for stale runtimes.
    }
  }

  private async disposeFailedRuntime(runtime: RedisRuntime): Promise<void> {
    this.detachRuntimeListeners(runtime);
    try {
      await runtime.quit();
    } catch {
      // Best-effort cleanup only.
    }
  }

  private handleDisconnect(
    runtime: RedisRuntime | null,
    error?: unknown,
  ): void {
    if (this.closed) return;
    if (runtime && runtime !== this.redis) return;
    if (error) {
      logger.warn(
        "Redis hot tier unavailable; using in-memory fallback",
        error,
      );
    }

    if (runtime && this.redis === runtime) {
      this.redis = null;
      this.detachRuntimeListeners(runtime);
      void runtime.quit().catch(() => {
        // Ignore teardown errors for disconnected runtimes.
      });
    }

    this.connected = false;
    this.scheduleReconnect();
  }

  private async tryConnectOnce(): Promise<boolean> {
    if (this.closed) return false;
    if (this.connected && this.redis) return true;
    if (this.connectAttempt) return await this.connectAttempt;

    this.connectAttempt = (async () => {
      let runtime: RedisRuntime | null = null;
      try {
        runtime = await this.createRuntime();
        this.attachRuntimeListeners(runtime);
        await runtime.connect?.();
        await runtime.ping();
        await this.replaceRuntime(runtime);
        return true;
      } catch (error) {
        if (runtime) {
          await this.disposeFailedRuntime(runtime);
        }

        this.redis = null;
        this.connected = false;
        this.reconnectAttempts += 1;
        logger.warn(
          "Redis hot tier unavailable; using in-memory fallback",
          error,
        );
        this.scheduleReconnect();
        return false;
      } finally {
        this.connectAttempt = null;
      }
    })();

    return await this.connectAttempt;
  }

  private async useRuntime<T>(
    operation: (runtime: RedisRuntime) => Promise<T>,
    options?: { allowMemoryFallback?: boolean },
  ): Promise<T> {
    const runtime = this.redis;
    if (this.connected && runtime) {
      try {
        return await operation(runtime);
      } catch (error) {
        this.handleDisconnect(runtime, error);
        if (options?.allowMemoryFallback === false) throw error;
      }
    }

    if (options?.allowMemoryFallback === false) {
      throw new Error(
        "Redis hot tier unavailable for durable drain-state mutation",
      );
    }

    return await operation(this.memory);
  }

  private queuePendingFallbackReplay(
    replayKey: string,
    replay: (runtime: RedisRuntime) => Promise<void>,
  ): void {
    this.pendingFallbackReplays.set(replayKey, replay);
  }

  private async replayPendingFallbackMutations(
    runtime: RedisRuntime,
  ): Promise<void> {
    while (this.pendingFallbackReplays.size > 0) {
      const nextReplay = this.pendingFallbackReplays.entries().next().value;
      if (!nextReplay) return;
      const [replayKey, replay] = nextReplay;
      await replay(runtime);
      this.pendingFallbackReplays.delete(replayKey);
    }
  }

  private queuePendingStringSnapshotReplay(key: string): void {
    this.queuePendingFallbackReplay(`string:${key}`, async (runtime) => {
      this.hashFallbackKeys.delete(key);
      const snapshot = this.memory.snapshot(key);
      await runtime.del(key);

      if (snapshot.kind === "missing") return;
      if (snapshot.kind !== "string") return;

      if (snapshot.ttlSeconds) {
        await runtime.set(key, snapshot.value, "EX", snapshot.ttlSeconds);
        return;
      }

      await runtime.set(key, snapshot.value);
    });
  }

  private queuePendingHashSnapshotReplay(key: string): void {
    this.queuePendingFallbackReplay(`hash:${key}`, async (runtime) => {
      if (!runtime.hset) return;
      const snapshot = this.memory.snapshot(key);
      if (snapshot.kind !== "hash") return;

      await runtime.del(key);
      this.hashFallbackKeys.delete(key);
      await runtime.hset(key, snapshot.values);
      if (snapshot.ttlSeconds) await runtime.expire(key, snapshot.ttlSeconds);
    });
  }

  private queuePendingListSnapshotReplay(key: string): void {
    this.queuePendingFallbackReplay(`list:${key}`, async (runtime) => {
      const snapshot = this.memory.snapshot(key);
      await runtime.del(key);
      if (snapshot.kind !== "list") return;

      for (const value of snapshot.values) {
        await runtime.rpush(key, value);
      }
      if (snapshot.ttlSeconds) {
        await runtime.expire(key, snapshot.ttlSeconds);
      }
    });
  }

  private isDurableDrainKey(key: string): boolean {
    return key.startsWith("drain:");
  }

  private async replaceMemoryList(
    key: string,
    values: string[],
    ttlSeconds?: number,
  ): Promise<void> {
    await this.memory.del(key);
    for (const value of values) {
      await this.memory.rpush(key, value);
    }
    if (ttlSeconds && values.length > 0) {
      await this.memory.expire(key, ttlSeconds);
    }
  }

  private async syncNonDurableSourceListAfterLiveMove(
    key: string,
    side: "LEFT" | "RIGHT",
  ): Promise<void> {
    const snapshot = this.memory.snapshot(key);
    if (snapshot.kind !== "list") return;
    const values = side === "LEFT"
      ? snapshot.values.slice(1)
      : snapshot.values.slice(0, -1);
    await this.replaceMemoryList(key, values, snapshot.ttlSeconds);
  }

  private async syncNonDurableDestinationListAfterLiveMove(
    key: string,
    side: "LEFT" | "RIGHT",
    value: string,
  ): Promise<void> {
    if (side === "LEFT") {
      await this.memory.lpush(key, value);
      return;
    }
    await this.memory.rpush(key, value);
  }

  private async useMutationRuntime<T>(
    keys: string[],
    operation: (runtime: RedisRuntime) => Promise<T>,
    onFallbackSuccess?: (result: T) => void | Promise<void>,
  ): Promise<T> {
    return await this.useRuntime(async (runtime) => {
      const result = await operation(runtime);
      if (runtime === this.memory) {
        await onFallbackSuccess?.(result);
      }
      return result;
    }, {
      allowMemoryFallback: !keys.some((key) => this.isDurableDrainKey(key)),
    });
  }

  async prependToList(
    key: string,
    value: string,
    ttlSeconds?: number,
  ): Promise<number> {
    return await this.useMutationRuntime([key], async (runtime) => {
      const length = await runtime.lpush(key, value);
      if (ttlSeconds) await runtime.expire(key, ttlSeconds);
      if (runtime !== this.memory && !this.isDurableDrainKey(key)) {
        await this.memory.lpush(key, value);
        if (ttlSeconds) await this.memory.expire(key, ttlSeconds);
      }
      return length;
    }, () => {
      this.queuePendingListSnapshotReplay(key);
    });
  }

  async appendToList(
    key: string,
    value: string,
    ttlSeconds?: number,
  ): Promise<number> {
    return await this.useMutationRuntime([key], async (runtime) => {
      const length = await runtime.rpush(key, value);
      if (ttlSeconds) await runtime.expire(key, ttlSeconds);
      if (runtime !== this.memory && !this.isDurableDrainKey(key)) {
        await this.memory.rpush(key, value);
        if (ttlSeconds) await this.memory.expire(key, ttlSeconds);
      }
      return length;
    }, () => {
      this.queuePendingListSnapshotReplay(key);
    });
  }

  async getRecentList(key: string, limit: number): Promise<string[]> {
    return await this.useRuntime((runtime) =>
      runtime.lrange(key, 0, Math.max(limit - 1, 0))
    );
  }

  async getOldestList(key: string, limit: number): Promise<string[]> {
    return await this.useRuntime(async (runtime) => {
      const length = await runtime.llen(key);
      if (length === 0) return [];
      const start = Math.max(length - limit, 0);
      return await runtime.lrange(key, start, length - 1);
    });
  }

  async getListRange(
    key: string,
    start: number,
    stop: number,
  ): Promise<string[]> {
    return await this.useRuntime((runtime) => runtime.lrange(key, start, stop));
  }

  async getListItem(key: string, index: number): Promise<string | null> {
    return await this.useRuntime((runtime) => runtime.lindex(key, index));
  }

  async setListItem(key: string, index: number, value: string): Promise<void> {
    await this.useMutationRuntime(
      [key],
      async (runtime) => {
        await runtime.lset(key, index, value);
        if (runtime !== this.memory && !this.isDurableDrainKey(key)) {
          await this.memory.lset(key, index, value);
        }
      },
      () => {
        this.queuePendingListSnapshotReplay(key);
      },
    );
  }

  async getListLength(key: string): Promise<number> {
    return await this.useRuntime((runtime) => runtime.llen(key));
  }

  async moveListItem(
    source: string,
    destination: string,
    sourceSide: "LEFT" | "RIGHT",
    destinationSide: "LEFT" | "RIGHT",
  ): Promise<string | null> {
    return await this.useMutationRuntime(
      [source, destination],
      async (runtime) => {
        const sourceDurable = this.isDurableDrainKey(source);
        const destinationDurable = this.isDurableDrainKey(destination);
        const result = await runtime.lmove(
          source,
          destination,
          sourceSide,
          destinationSide,
        );
        if (result !== null && runtime !== this.memory) {
          if (!sourceDurable) {
            await this.syncNonDurableSourceListAfterLiveMove(
              source,
              sourceSide,
            );
          }
          if (!destinationDurable) {
            await this.syncNonDurableDestinationListAfterLiveMove(
              destination,
              destinationSide,
              result,
            );
          }
        }
        return result;
      },
      (result) => {
        if (result === null) return;
        this.queuePendingListSnapshotReplay(source);
        this.queuePendingListSnapshotReplay(destination);
      },
    );
  }

  async trimOldest(key: string, count: number): Promise<void> {
    if (count <= 0) return;
    await this.useMutationRuntime([key], async (runtime) => {
      const length = await runtime.llen(key);
      if (length <= count) {
        await runtime.del(key);
        if (runtime !== this.memory && !this.isDurableDrainKey(key)) {
          await this.memory.del(key);
        }
        return length > 0;
      }
      await runtime.ltrim(key, 0, length - count - 1);
      if (runtime !== this.memory && !this.isDurableDrainKey(key)) {
        const memoryLength = await this.memory.llen(key);
        if (memoryLength <= count) {
          await this.memory.del(key);
        } else {
          await this.memory.ltrim(key, 0, memoryLength - count - 1);
        }
      }
      return true;
    }, (changed) => {
      if (!changed) return;
      this.queuePendingListSnapshotReplay(key);
    });
  }

  async getString(key: string): Promise<string | null> {
    return await this.useRuntime((runtime) => runtime.get(key));
  }

  async setString(
    key: string,
    value: string,
    ttlSeconds?: number,
  ): Promise<void> {
    await this.useMutationRuntime([key], async (runtime) => {
      if (ttlSeconds) {
        await runtime.set(key, value, "EX", ttlSeconds);
        if (runtime !== this.memory && !this.isDurableDrainKey(key)) {
          this.hashFallbackKeys.delete(key);
          await this.memory.set(key, value, "EX", ttlSeconds);
        }
        return;
      }
      await runtime.set(key, value);
      if (runtime !== this.memory && !this.isDurableDrainKey(key)) {
        this.hashFallbackKeys.delete(key);
        await this.memory.set(key, value);
      }
    }, () => {
      this.queuePendingStringSnapshotReplay(key);
    });
  }

  async setStringIfAbsent(
    key: string,
    value: string,
    ttlSeconds?: number,
  ): Promise<boolean> {
    return await this.useMutationRuntime([key], async (runtime) => {
      if (runtime === this.memory) {
        return await this.memory.setIfAbsent(key, value, ttlSeconds);
      }

      const result = ttlSeconds
        ? await runtime.set(key, value, "NX", "EX", ttlSeconds)
        : await runtime.set(key, value, "NX");
      if (result === "OK" && !this.isDurableDrainKey(key)) {
        this.hashFallbackKeys.delete(key);
        if (ttlSeconds) {
          await this.memory.set(key, value, "EX", ttlSeconds);
        } else {
          await this.memory.set(key, value);
        }
      }
      return result === "OK";
    }, (acquired) => {
      if (!acquired) return;
      this.queuePendingStringSnapshotReplay(key);
    });
  }

  async touch(key: string, ttlSeconds: number): Promise<void> {
    await this.useMutationRuntime(
      [key],
      async (runtime) => {
        const changed = await runtime.expire(key, ttlSeconds);
        if (
          changed !== 0 && runtime !== this.memory &&
          !this.isDurableDrainKey(key)
        ) {
          await this.memory.expire(key, ttlSeconds);
        }
        return changed;
      },
      (changed) => {
        if (changed === 0) return;
        this.queuePendingFallbackReplay(
          `expire:${key}`,
          (runtime) => runtime.expire(key, ttlSeconds).then(() => undefined),
        );
      },
    );
  }

  async getHashAll(key: string): Promise<Record<string, string>> {
    return await this.useRuntime(async (runtime) => {
      if (runtime === this.memory) {
        return await this.memory.hgetall(key);
      }
      if (this.hashFallbackKeys.has(key)) {
        const fallbackValues = await this.memory.hgetall(key);
        if (!runtime.hgetall) {
          return fallbackValues;
        }

        const liveValues = await runtime.hgetall(key);
        return {
          ...liveValues,
          ...fallbackValues,
        };
      }
      return await runtime.hgetall?.(key) ?? {};
    });
  }

  async setHashFields(
    key: string,
    values: Record<string, string | number | undefined>,
    ttlSeconds?: number,
  ): Promise<void> {
    const serialized = Object.fromEntries(
      Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([field, value]) => [field, String(value)]),
    );
    if (Object.keys(serialized).length === 0) return;

    await this.useMutationRuntime([key], async (runtime) => {
      let ttlTarget: RedisRuntime = runtime;
      if (runtime === this.memory) {
        this.hashFallbackKeys.add(key);
        await this.memory.hset(key, serialized);
        ttlTarget = this.memory;
      } else if (runtime.hset) {
        this.hashFallbackKeys.delete(key);
        await runtime.hset(key, serialized);
        if (!this.isDurableDrainKey(key)) {
          await this.memory.hset(key, serialized);
          if (ttlSeconds) await this.memory.expire(key, ttlSeconds);
        }
      } else {
        const existing = await runtime.get(key);
        if (existing !== null) {
          throw new Error(
            "WRONGTYPE Operation against a key holding the wrong kind of value",
          );
        }
        this.hashFallbackKeys.add(key);
        await this.memory.hset(key, serialized);
        ttlTarget = this.memory;
      }

      if (ttlSeconds) await ttlTarget.expire(key, ttlSeconds);
    }, () => {
      this.queuePendingHashSnapshotReplay(key);
    });
  }

  async compareAndTouch(
    key: string,
    expectedValue: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    return await this.useMutationRuntime([key], async (runtime) => {
      if (runtime === this.memory) {
        return await this.memory.compareAndExpire(
          key,
          expectedValue,
          ttlSeconds,
        );
      }

      const extended = await runtime.eval?.(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) else return 0 end",
        1,
        key,
        expectedValue,
        String(ttlSeconds),
      ) ?? 0;
      return extended === 1;
    }, (extended) => {
      if (!extended) return;
      this.queuePendingFallbackReplay(
        `compareAndTouch:${key}`,
        async (runtime) => {
          await runtime.eval?.(
            "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) else return 0 end",
            1,
            key,
            expectedValue,
            String(ttlSeconds),
          );
        },
      );
    });
  }

  async deleteKey(key: string): Promise<void> {
    await this.useMutationRuntime(
      [key],
      async (runtime) => {
        const deleted = await runtime.del(key);
        if (
          deleted !== 0 && runtime !== this.memory &&
          !this.isDurableDrainKey(key)
        ) {
          this.hashFallbackKeys.delete(key);
          await this.memory.del(key);
        }
        return deleted;
      },
      (deleted) => {
        if (deleted === 0) return;
        this.queuePendingFallbackReplay(`del:${key}`, async (runtime) => {
          this.hashFallbackKeys.delete(key);
          await runtime.del(key);
        });
      },
    );
  }

  snapshot(key: string): Promise<RedisKeySnapshot> {
    return Promise.resolve(this.memory.snapshot(key));
  }

  keysByPrefix(prefix: string): Promise<string[]> {
    return Promise.resolve(this.memory.keys(prefix));
  }

  async restoreSnapshot(
    key: string,
    snapshot: RedisKeySnapshot,
  ): Promise<void> {
    switch (snapshot.kind) {
      case "missing":
        await this.deleteKey(key);
        return;
      case "string":
        await this.setString(key, snapshot.value, snapshot.ttlSeconds);
        return;
      case "hash":
        await this.deleteKey(key);
        if (Object.keys(snapshot.values).length === 0) return;
        await this.setHashFields(key, snapshot.values, snapshot.ttlSeconds);
        return;
      case "list":
        await this.deleteKey(key);
        if (snapshot.values.length === 0) return;
        for (const value of snapshot.values) {
          await this.appendToList(key, value, snapshot.ttlSeconds);
        }
        return;
    }
  }

  async deleteKeyIfValue(key: string, expectedValue: string): Promise<boolean> {
    return await this.useMutationRuntime([key], async (runtime) => {
      if (runtime === this.memory) {
        return await this.memory.deleteIfValue(key, expectedValue);
      }

      const deleted = await runtime.eval?.(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
        1,
        key,
        expectedValue,
      ) ?? 0;
      if (deleted === 1 && !this.isDurableDrainKey(key)) {
        this.hashFallbackKeys.delete(key);
        await this.memory.del(key);
      }
      return deleted === 1;
    }, (deleted) => {
      if (!deleted) return;
      this.queuePendingFallbackReplay(`delIfValue:${key}`, async (runtime) => {
        this.hashFallbackKeys.delete(key);
        await runtime.del(key);
      });
    });
  }
}
