import RedisModule from "ioredis";

const Redis = RedisModule as unknown as typeof import("ioredis").default;

type Stats = {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
};

type SampleMode = "set" | "get" | "del" | "ping";

const CLEANUP_DELETE_BATCH_SIZE = 1_000;

// Default to localhost for safe contributor use.
// Pass an explicit endpoint argument to target a different Redis host.
const endpoint = Deno.args[0] ?? "redis://localhost:6379";
const iterationsArg = Number(Deno.args[1] ?? "200");
const iterations = Number.isFinite(iterationsArg) && iterationsArg > 0
  ? Math.floor(iterationsArg)
  : 200;

const percentile = (values: number[], ratio: number): number => {
  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.ceil(values.length * ratio) - 1),
  );
  return values[index] ?? 0;
};

const summarize = (values: number[]): Stats => {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
    avg: sorted.length ? total / sorted.length : 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
};

const fmt = (value: number): string => `${value.toFixed(3)} ms`;

const run = async () => {
  const redis = new Redis(endpoint, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableAutoPipelining: false,
  });
  let connected = false;

  const keyPrefix = `bench:opencode-graphiti:${Date.now()}`;
  const samples: Record<SampleMode, number[]> = {
    ping: [],
    set: [],
    get: [],
    del: [],
  };

  try {
    await redis.connect();
    connected = true;
    await redis.ping();

    for (let index = 0; index < iterations; index += 1) {
      const key = `${keyPrefix}:${index}`;
      const value = `value-${index}`;

      let started = performance.now();
      await redis.ping();
      samples.ping.push(performance.now() - started);

      started = performance.now();
      await redis.set(key, value);
      samples.set.push(performance.now() - started);

      started = performance.now();
      await redis.get(key);
      samples.get.push(performance.now() - started);

      started = performance.now();
      await redis.del(key);
      samples.del.push(performance.now() - started);
    }

    console.log(`Endpoint: ${endpoint}`);
    console.log(`Iterations: ${iterations}`);
    console.log("");

    for (const mode of ["ping", "set", "get", "del"] as const) {
      const stats = summarize(samples[mode]);
      console.log(`${mode.toUpperCase()}`);
      console.log(`  min: ${fmt(stats.min)}`);
      console.log(`  p50: ${fmt(stats.p50)}`);
      console.log(`  p95: ${fmt(stats.p95)}`);
      console.log(`  p99: ${fmt(stats.p99)}`);
      console.log(`  avg: ${fmt(stats.avg)}`);
      console.log(`  max: ${fmt(stats.max)}`);
      console.log("");
    }
  } finally {
    if (connected) {
      try {
        const cleanupKeys = Array.from(
          { length: iterations },
          (_, index) => `${keyPrefix}:${index}`,
        );
        if (cleanupKeys.length) {
          for (
            let index = 0;
            index < cleanupKeys.length;
            index += CLEANUP_DELETE_BATCH_SIZE
          ) {
            await redis.del(
              ...cleanupKeys.slice(index, index + CLEANUP_DELETE_BATCH_SIZE),
            );
          }
        }
      } catch {
        // ignore cleanup failures in benchmarking utility
      }

      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
    } else {
      redis.disconnect();
    }
  }
};

if (import.meta.main) {
  await run();
}
