import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { GraphitiAsyncService } from "./graphiti-async.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(count = 6) {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
}

function createFakeTimers() {
  let nextId = 0;
  const scheduledTimeouts: number[] = [];
  const clearedTimers: number[] = [];
  const active = new Map<number, { callback: () => void; delayMs: number }>();

  return {
    scheduledTimeouts,
    clearedTimers,
    setTimer(callback: () => void, delayMs: number) {
      const id = ++nextId;
      active.set(id, { callback, delayMs });
      scheduledTimeouts.push(delayMs);
      return id;
    },
    clearTimer(timer: number) {
      if (!active.has(timer)) return;
      active.delete(timer);
      clearedTimers.push(timer);
    },
    runNext(delayMs?: number) {
      const entry = [...active.entries()].find(([_, timer]) =>
        delayMs === undefined || timer.delayMs === delayMs
      );
      if (!entry) return false;
      const [id, timer] = entry;
      active.delete(id);
      timer.callback();
      return true;
    },
  };
}

describe("GraphitiAsyncService", () => {
  it("coalesces concurrent cache refreshes and follows up with the latest query", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const searchCalls: string[] = [];
    const nodeSearchCalls: string[] = [];
    const rememberCalls: string[] = [];
    const cacheSets: string[] = [];

    const firstFacts = deferred<
      Array<{
        fact: string;
        source_node?: { name?: string };
        target_node?: { name?: string };
      }>
    >();
    const firstNodes = deferred<{
      nodes: Array<{ uuid: string; name: string; summary: string }>;
      degraded: boolean;
    }>();

    let refreshRuns = 0;
    const graphiti = {
      searchMemoryFacts({ query }: { query: string }) {
        searchCalls.push(query);
        refreshRuns += 1;
        if (refreshRuns === 1) return firstFacts.promise;
        return Promise.resolve([
          {
            fact: `fact:${query}`,
            source_node: { name: "Source" },
            target_node: { name: query },
          },
        ]);
      },
      searchNodesWithStatus({ query }: { query: string }) {
        nodeSearchCalls.push(query);
        if (nodeSearchCalls.length === 1) return firstNodes.promise;
        return Promise.resolve({
          nodes: [{
            uuid: `node:${query}`,
            name: query,
            summary: `summary:${query}`,
          }],
          degraded: false,
        });
      },
      getEpisodes() {
        return Promise.resolve([]);
      },
    };

    const meta = new Map<string, { lastQuery?: string }>();
    const entries = new Map<string, { query: string }>();
    const cache = {
      rememberRefreshQuery(groupId: string, query: string) {
        rememberCalls.push(query);
        meta.set(groupId, { lastQuery: query });
        return Promise.resolve();
      },
      getMeta(groupId: string) {
        return Promise.resolve(meta.get(groupId) ?? null);
      },
      get(groupId: string) {
        return Promise.resolve(entries.get(groupId) ?? null);
      },
      set(
        groupId: string,
        entry: {
          query: string;
          refreshedAt: number;
          nodes: Array<{ uuid: string; name: string; summary: string }>;
          episodeSummaries?: string[];
          nodeRefs: string[];
        },
      ) {
        cacheSets.push(entry.query);
        entries.set(groupId, { query: entry.query });
        return Promise.resolve();
      },
    };

    const service = new GraphitiAsyncService(
      graphiti as never,
      cache as never,
      {
        drainGroup: () => Promise.resolve({ status: "idle" as const }),
      } as never,
    );

    service.scheduleCacheRefresh("group-1", "alpha");
    service.scheduleCacheRefresh("group-1", "beta");

    await Promise.resolve();
    assertEquals(searchCalls, ["alpha"]);
    assertEquals(nodeSearchCalls, ["alpha"]);
    assertEquals(rememberCalls, ["alpha", "beta"]);

    firstFacts.resolve([
      {
        fact: "fact:alpha",
        source_node: { name: "Source" },
        target_node: { name: "alpha" },
      },
    ]);
    firstNodes.resolve({
      nodes: [{ uuid: "node:alpha", name: "alpha", summary: "summary:alpha" }],
      degraded: false,
    });

    await flushMicrotasks();
    await new Promise((resolve) => realSetTimeout(resolve, 0));
    await service.dispose();

    assertEquals(searchCalls, ["alpha", "beta"]);
    assertEquals(nodeSearchCalls, ["alpha", "beta"]);
    assertEquals(cacheSets, ["beta"]);
  });

  it("dispose clears timers and waits for in-flight work", async () => {
    const timers = createFakeTimers();

    const drainDeferred = deferred<{ status: "retry" }>();
    const refreshFactsDeferred = deferred<
      Array<{
        fact: string;
        source_node?: { name?: string };
        target_node?: { name?: string };
      }>
    >();
    const refreshNodesDeferred = deferred<{
      nodes: Array<{ uuid: string; name: string; summary: string }>;
      degraded: boolean;
    }>();
    const primerDeferred = deferred<Array<{ name: string; content: string }>>();

    const graphiti = {
      searchMemoryFacts() {
        return refreshFactsDeferred.promise;
      },
      searchNodesWithStatus() {
        return refreshNodesDeferred.promise;
      },
      getEpisodes() {
        return primerDeferred.promise;
      },
    };

    const cache = {
      get() {
        return Promise.resolve(null);
      },
      getMeta() {
        return Promise.resolve({ lastQuery: "alpha" });
      },
      set() {
        return Promise.resolve();
      },
      rememberRefreshQuery() {
        return Promise.resolve();
      },
    };

    const service = new GraphitiAsyncService(
      graphiti as never,
      cache as never,
      { drainGroup: () => drainDeferred.promise } as never,
      25,
      undefined,
      timers,
    );

    service.scheduleDrain("group-1");
    service.scheduleCacheRefresh("group-1", "alpha");
    service.schedulePrimer("group-1");

    await Promise.resolve();

    let disposed = false;
    const disposePromise = service.dispose().then(() => {
      disposed = true;
    });

    await Promise.resolve();
    assertEquals(disposed, false);
    assertEquals(timers.clearedTimers.length, 1);

    drainDeferred.resolve({ status: "retry" });
    refreshFactsDeferred.resolve([]);
    refreshNodesDeferred.resolve({ nodes: [], degraded: true });
    primerDeferred.resolve([{ name: "episode", content: "content" }]);

    await disposePromise;

    assert(disposed);
    assertEquals(timers.clearedTimers.length, 1);
  });

  it("preserves fact-only cache refreshes when node search degrades", async () => {
    const cacheSets: Array<{
      query: string;
      nodes: Array<{ uuid: string; name: string; summary: string }>;
      episodeSummaries?: string[];
      nodeRefs: string[];
    }> = [];

    const service = new GraphitiAsyncService(
      {
        getEpisodes() {
          return Promise.resolve([]);
        },
        searchMemoryFacts() {
          return Promise.resolve([
            {
              fact: "fact:alpha",
              source_node: { name: "Source" },
              target_node: { name: "alpha" },
            },
          ]);
        },
        searchNodesWithStatus() {
          return Promise.resolve({
            nodes: [{ uuid: "node:alpha", name: "alpha", summary: "unused" }],
            degraded: true,
          });
        },
      } as never,
      {
        get() {
          return Promise.resolve(null);
        },
        getMeta() {
          return Promise.resolve({ lastQuery: "alpha" });
        },
        rememberRefreshQuery() {
          return Promise.resolve();
        },
        set(
          _groupId: string,
          entry: {
            query: string;
            refreshedAt: number;
            nodes: Array<{ uuid: string; name: string; summary: string }>;
            episodeSummaries?: string[];
            nodeRefs: string[];
          },
        ) {
          cacheSets.push(entry);
          return Promise.resolve();
        },
      } as never,
      {
        drainGroup: () => Promise.resolve({ status: "idle" as const }),
      } as never,
    );

    service.scheduleCacheRefresh("group-1", "alpha");
    await flushMicrotasks();
    await service.dispose();

    assertEquals(cacheSets.length, 1);
    assertEquals(cacheSets[0]?.query, "alpha");
    assertEquals(cacheSets[0]?.nodes, []);
    assertEquals(cacheSets[0]?.episodeSummaries, [
      "Source → alpha: fact:alpha",
    ]);
    assertEquals(cacheSets[0]?.nodeRefs, []);
  });

  it("does not start a second drain while a slow drain is still in flight", async () => {
    const timers = createFakeTimers();
    const drainDeferred = deferred<{ status: "idle" }>();
    let drainCalls = 0;

    const service = new GraphitiAsyncService(
      {
        getEpisodes() {
          return Promise.resolve([]);
        },
        searchMemoryFacts() {
          return Promise.resolve([]);
        },
        searchNodesWithStatus() {
          return Promise.resolve({ nodes: [], degraded: true });
        },
      } as never,
      {
        get() {
          return Promise.resolve(null);
        },
        getMeta() {
          return Promise.resolve(null);
        },
        rememberRefreshQuery() {
          return Promise.resolve();
        },
        set() {
          return Promise.resolve();
        },
      } as never,
      {
        drainGroup() {
          drainCalls += 1;
          return drainDeferred.promise;
        },
      } as never,
      25,
      50,
      timers,
    );

    service.scheduleDrain("group-1");
    await Promise.resolve();
    service.scheduleDrain("group-1");

    assertEquals(drainCalls, 1);
    assert(timers.runNext(50));
    await Promise.resolve();

    assertEquals(drainCalls, 1);

    drainDeferred.resolve({ status: "idle" });
    await service.dispose();

    assertEquals(drainCalls, 1);
  });

  it("uses returned backoff timing while keeping fixed delay for retry", async () => {
    const timers = createFakeTimers();
    const drainResults = [
      { status: "backoff" as const, drained: 0, retryAfterMs: 250 },
      { status: "retry" as const, drained: 0 },
    ];

    const service = new GraphitiAsyncService(
      {
        getEpisodes() {
          return Promise.resolve([]);
        },
        searchMemoryFacts() {
          return Promise.resolve([]);
        },
        searchNodesWithStatus() {
          return Promise.resolve({ nodes: [], degraded: true });
        },
      } as never,
      {
        get() {
          return Promise.resolve(null);
        },
        getMeta() {
          return Promise.resolve(null);
        },
        rememberRefreshQuery() {
          return Promise.resolve();
        },
        set() {
          return Promise.resolve();
        },
      } as never,
      {
        drainGroup() {
          const result = drainResults.shift();
          if (!result) throw new Error("Unexpected extra drainGroup call");
          return Promise.resolve(result);
        },
      } as never,
      25,
      50,
      timers,
    );

    service.scheduleDrain("group-1");
    await Promise.resolve();
    service.scheduleDrain("group-2");
    await Promise.resolve();
    await service.dispose();

    assertEquals(timers.scheduledTimeouts, [50, 250, 50, 25]);
  });
});
