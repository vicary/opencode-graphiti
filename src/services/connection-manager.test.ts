import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import {
  GraphitiConnectionManager,
  GraphitiOfflineError,
  GraphitiQueueTimeoutError,
  GraphitiSessionExpiredError,
  GraphitiTransportError,
} from "./connection-manager.ts";
import { logger } from "./logger.ts";

const originalLogger = { ...logger };
logger.info = () => {};
logger.warn = () => {};
logger.error = () => {};
logger.debug = () => {};

addEventListener("unload", () => {
  logger.info = originalLogger.info;
  logger.warn = originalLogger.warn;
  logger.error = originalLogger.error;
  logger.debug = originalLogger.debug;
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settleMicrotasks(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

class FakeClock {
  now = 0;
  nextId = 1;
  timers = new Map<number, { at: number; callback: () => void }>();

  setTimer = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delayMs, callback });
    return id;
  };

  clearTimer = (id: number): void => {
    this.timers.delete(id);
  };

  async advanceBy(ms: number): Promise<void> {
    const target = this.now + ms;
    while (true) {
      let nextId: number | null = null;
      let nextAt = Number.POSITIVE_INFINITY;

      for (const [id, timer] of this.timers) {
        if (timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }

      if (nextId === null || nextAt > target) break;

      this.now = nextAt;
      const timer = this.timers.get(nextId);
      if (!timer) continue;
      this.timers.delete(nextId);
      timer.callback();
      await Promise.resolve();
    }

    this.now = target;
    await Promise.resolve();
  }
}

type FakeConnection = {
  connect: () => Promise<void>;
  close: () => Promise<void>;
  callTool: (request: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<unknown>;
};

describe("connection manager", () => {
  it("ready resolves true on successful connect", async () => {
    const connectGate = deferred<void>();
    const manager = new GraphitiConnectionManager({
      endpoint: "http://test",
      connectionFactory: () => ({
        connect: () => connectGate.promise,
        close: () => Promise.resolve(),
        callTool: () => Promise.resolve({ ok: true }),
      }),
    });

    manager.start();
    const readyPromise = manager.ready(100);
    connectGate.resolve();
    await settleMicrotasks();

    assertEquals(await readyPromise, true);
    assertEquals(manager.getState(), "connected");
  });

  it("ready resolves false on timeout", async () => {
    const clock = new FakeClock();
    const manager = new GraphitiConnectionManager({
      endpoint: "http://test",
      connectionFactory: () => ({
        connect: () => new Promise<void>(() => {}),
        close: () => Promise.resolve(),
        callTool: () => Promise.resolve({ ok: true }),
      }),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    manager.start();
    const readyPromise = manager.ready(50);
    await clock.advanceBy(50);

    assertEquals(await readyPromise, false);
  });

  it("queues requests while connecting and resolves them after connect", async () => {
    const connectGate = deferred<void>();
    const calls: string[] = [];
    const manager = new GraphitiConnectionManager({
      endpoint: "http://test",
      connectionFactory: () => ({
        connect: () => connectGate.promise,
        close: () => Promise.resolve(),
        callTool: ({ name }) => {
          calls.push(name);
          return Promise.resolve({ ok: name });
        },
      }),
    });

    manager.start();
    const queued = manager.callTool("queued", { value: 1 }, 100);
    connectGate.resolve();
    await settleMicrotasks();

    assertEquals(await queued, { ok: "queued" });
    assertEquals(calls, ["queued"]);
  });

  it("queued requests time out before connection", async () => {
    const clock = new FakeClock();
    const manager = new GraphitiConnectionManager({
      endpoint: "http://test",
      connectionFactory: () => ({
        connect: () => new Promise<void>(() => {}),
        close: () => Promise.resolve(),
        callTool: () => Promise.resolve({ ok: true }),
      }),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    manager.start();
    const queued = manager.callTool("queued", {}, 10);
    await clock.advanceBy(10);

    await assertRejects(() => queued, GraphitiQueueTimeoutError);
  });

  it("offline requests reject immediately", async () => {
    const clock = new FakeClock();
    const manager = new GraphitiConnectionManager({
      endpoint: "http://test",
      connectionFactory: () => ({
        connect: () => Promise.reject(new Error("connect failed")),
        close: () => Promise.resolve(),
        callTool: () => Promise.resolve({ ok: true }),
      }),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      random: () => 0.5,
    });

    manager.start();
    await settleMicrotasks();
    assertEquals(manager.getState(), "offline");
    await assertRejects(
      () => manager.callTool("offline", {}),
      GraphitiOfflineError,
    );
  });

  it("retries once after connected transport failure", async () => {
    let calls = 0;
    let connectionIndex = 0;
    const manager = new GraphitiConnectionManager({
      endpoint: "http://test",
      connectionFactory: () => {
        connectionIndex += 1;
        const index = connectionIndex;
        return {
          connect: () => Promise.resolve(),
          close: () => Promise.resolve(),
          callTool: () => {
            calls += 1;
            if (index === 1 && calls === 1) {
              return Promise.reject(new Error("socket hang up"));
            }
            return Promise.resolve({ ok: true, index });
          },
        };
      },
    });

    manager.start();
    assertEquals(await manager.ready(10), true);

    assertEquals(await manager.callTool("search", {}), { ok: true, index: 2 });
    assertEquals(connectionIndex, 2);
  });

  it("retries once after session expiry", async () => {
    let connectionIndex = 0;
    let called = false;
    const manager = new GraphitiConnectionManager({
      endpoint: "http://test",
      connectionFactory: () => {
        connectionIndex += 1;
        const index = connectionIndex;
        return {
          connect: () => Promise.resolve(),
          close: () => Promise.resolve(),
          callTool: () => {
            if (index === 1 && !called) {
              called = true;
              return Promise.reject({ code: 404, message: "session expired" });
            }
            return Promise.resolve({ ok: true, index });
          },
        };
      },
    });

    manager.start();
    assertEquals(await manager.ready(10), true);

    assertEquals(await manager.callTool("search", {}), { ok: true, index: 2 });
    assertEquals(connectionIndex, 2);
  });

  it("request during reconnect shares a single reconnect", async () => {
    let connectionIndex = 0;
    let failed = false;
    const firstFailure = deferred<void>();
    const reconnectGate = deferred<void>();
    const manager = new GraphitiConnectionManager({
      endpoint: "http://test",
      connectionFactory: () => {
        connectionIndex += 1;
        const index = connectionIndex;
        return {
          connect: () =>
            index === 1 ? Promise.resolve() : reconnectGate.promise,
          close: () => Promise.resolve(),
          callTool: async ({ name }) => {
            if (index === 1 && !failed) {
              await firstFailure.promise;
              failed = true;
              return Promise.reject(new Error("connection reset by peer"));
            }
            return Promise.resolve({ ok: name, index });
          },
        };
      },
    });

    manager.start();
    assertEquals(await manager.ready(10), true);

    const firstRequest = manager.callTool("a", {});
    firstFailure.resolve();
    await settleMicrotasks();
    assertEquals(manager.getState(), "connecting");

    const secondRequest = manager.callTool("b", {});
    reconnectGate.resolve();

    const [a, b] = await Promise.all([firstRequest, secondRequest]);

    assertEquals(a, { ok: "a", index: 2 });
    assertEquals(b, { ok: "b", index: 2 });
    assertEquals(connectionIndex, 2);
  });

  it("auto-reconnects from offline with backoff", async () => {
    const clock = new FakeClock();
    let attempts = 0;
    const manager = new GraphitiConnectionManager({
      endpoint: "http://test",
      connectionFactory: () => ({
        connect: () => {
          attempts += 1;
          if (attempts < 2) {
            return Promise.reject(new Error("connect failed"));
          }
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
        callTool: () => Promise.resolve({ ok: true }),
      }),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      random: () => 0.5,
      reconnectInitialDelayMs: 10,
    });

    manager.start();
    await settleMicrotasks();
    assertEquals(manager.getState(), "offline");

    await clock.advanceBy(10);
    await settleMicrotasks();

    assertEquals(manager.getState(), "connected");
    assertEquals(attempts, 2);
  });

  it("queue full drops the oldest request", async () => {
    const connectGate = deferred<void>();
    const manager = new GraphitiConnectionManager({
      endpoint: "http://test",
      queueCapacity: 1,
      connectionFactory: () => ({
        connect: () => connectGate.promise,
        close: () => Promise.resolve(),
        callTool: ({ name }) => Promise.resolve({ ok: name }),
      }),
    });

    manager.start();
    await settleMicrotasks();
    const oldest = manager.callTool("old", {}, 100);
    const newest = manager.callTool("new", {}, 100);

    await assertRejects(() => oldest, GraphitiQueueTimeoutError);

    connectGate.resolve();
    assertEquals(await newest, { ok: "new" });
  });

  it("stop rejects queued requests and cancels reconnect timer", async () => {
    const clock = new FakeClock();
    const connectGate = deferred<void>();
    const manager = new GraphitiConnectionManager({
      endpoint: "http://test",
      connectionFactory: () => ({
        connect: () => connectGate.promise,
        close: () => Promise.resolve(),
        callTool: () => Promise.resolve({ ok: true }),
      }),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    manager.start();
    const queued = manager.callTool("queued", {}, 100);
    await manager.stop();

    await assertRejects(() => queued, GraphitiOfflineError);
    assertEquals(clock.timers.size, 0);
  });

  it("surfaces typed errors after failed retry", async () => {
    let connectionIndex = 0;
    const manager = new GraphitiConnectionManager({
      endpoint: "http://test",
      connectionFactory: () => {
        connectionIndex += 1;
        const index = connectionIndex;
        return {
          connect: () => Promise.resolve(),
          close: () => Promise.resolve(),
          callTool: () => {
            if (index === 1) {
              return Promise.reject(new Error("socket hang up"));
            }
            return Promise.reject({ code: 404, message: "expired again" });
          },
        };
      },
    });

    manager.start();
    assertEquals(await manager.ready(10), true);

    await assertRejects(
      () => manager.callTool("search", {}),
      GraphitiSessionExpiredError,
    );
  });

  it("surfaces transport error after failed reconnect retry", async () => {
    let connectionIndex = 0;
    const manager = new GraphitiConnectionManager({
      endpoint: "http://test",
      connectionFactory: () => {
        connectionIndex += 1;
        return {
          connect: () => Promise.resolve(),
          close: () => Promise.resolve(),
          callTool: () => Promise.reject(new Error("connection reset by peer")),
        };
      },
    });

    manager.start();
    assertEquals(await manager.ready(10), true);

    await assertRejects(
      () => manager.callTool("search", {}),
      GraphitiTransportError,
    );
  });
});
