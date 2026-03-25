import { assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  type ContextLimitCacheEntry,
  resolveContextLimit,
} from "./context-limit.ts";

Deno.test("resolveContextLimit re-probes after fallback cache expiry", async () => {
  let now = 100_000;
  const cache = new Map<string, ContextLimitCacheEntry>();
  let calls = 0;
  const client = {
    provider: {
      list: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new Error("provider unavailable"));
        }

        return Promise.resolve({
          providers: [
            {
              id: "openai",
              models: [{ id: "gpt-5", limit: { context: 123_456 } }],
            },
          ],
        });
      },
    },
  };

  assertEquals(
    await resolveContextLimit(
      "openai",
      "gpt-5",
      client as never,
      undefined,
      cache,
      () => now,
    ),
    200_000,
  );
  assertEquals(
    await resolveContextLimit(
      "openai",
      "gpt-5",
      client as never,
      undefined,
      cache,
      () => now,
    ),
    200_000,
  );
  assertEquals(calls, 1);

  now += 60_001;

  assertEquals(
    await resolveContextLimit(
      "openai",
      "gpt-5",
      client as never,
      undefined,
      cache,
      () => now,
    ),
    123_456,
  );
  assertEquals(calls, 2);
});

Deno.test("resolveContextLimit keeps fallback caches scoped per normalized directory until expiry", async () => {
  let now = 200_000;
  const cache = new Map<string, ContextLimitCacheEntry>();
  const calls: string[] = [];
  const client = {
    provider: {
      list: ({ query }: { query?: { directory?: string } }) => {
        calls.push(query?.directory ?? "");
        return Promise.reject(new Error("provider unavailable"));
      },
    },
  };

  assertEquals(
    await resolveContextLimit(
      "openai",
      "gpt-5",
      client as never,
      "/tmp/project-a",
      cache,
      () => now,
    ),
    200_000,
  );
  assertEquals(
    await resolveContextLimit(
      "openai",
      "gpt-5",
      client as never,
      "/tmp/project-a",
      cache,
      () => now,
    ),
    200_000,
  );
  assertEquals(
    await resolveContextLimit(
      "openai",
      "gpt-5",
      client as never,
      "   ",
      cache,
      () => now,
    ),
    200_000,
  );
  assertEquals(
    await resolveContextLimit(
      "openai",
      "gpt-5",
      client as never,
      "",
      cache,
      () => now,
    ),
    200_000,
  );
  assertEquals(calls, ["/tmp/project-a", ""]);

  now += 60_001;

  assertEquals(
    await resolveContextLimit(
      "openai",
      "gpt-5",
      client as never,
      "/tmp/project-a",
      cache,
      () => now,
    ),
    200_000,
  );
  assertEquals(
    await resolveContextLimit(
      "openai",
      "gpt-5",
      client as never,
      "",
      cache,
      () => now,
    ),
    200_000,
  );
  assertEquals(calls, ["/tmp/project-a", "", "/tmp/project-a", ""]);
});

Deno.test("resolveContextLimit keeps positive cache entries without expiry re-probes", async () => {
  const cache = new Map<string, ContextLimitCacheEntry>();
  let calls = 0;
  const client = {
    provider: {
      list: () => {
        calls += 1;
        return Promise.resolve({
          providers: [
            {
              id: "openai",
              models: [{ id: "gpt-5", limit: { context: 321_000 } }],
            },
          ],
        });
      },
    },
  };

  assertEquals(
    await resolveContextLimit(
      "openai",
      "gpt-5",
      client as never,
      undefined,
      cache,
    ),
    321_000,
  );
  assertEquals(
    await resolveContextLimit(
      "openai",
      "gpt-5",
      client as never,
      undefined,
      cache,
    ),
    321_000,
  );

  assertEquals(calls, 1);
});

Deno.test("resolveContextLimit re-probes when legacy numeric cache entry is non-positive", async () => {
  const cache = new Map<string, ContextLimitCacheEntry>();
  cache.set("openai/gpt-5", -1);

  let calls = 0;
  const client = {
    provider: {
      list: () => {
        calls += 1;
        return Promise.resolve({
          providers: [
            {
              id: "openai",
              models: [{ id: "gpt-5", limit: { context: 456_000 } }],
            },
          ],
        });
      },
    },
  };

  assertEquals(
    await resolveContextLimit(
      "openai",
      "gpt-5",
      client as never,
      undefined,
      cache,
    ),
    456_000,
  );

  assertEquals(calls, 1);
  assertEquals(cache.get("openai/gpt-5"), 456_000);
});

Deno.test("resolveContextLimit re-probes when legacy object cache entry is non-positive without expiry", async () => {
  const cache = new Map<string, ContextLimitCacheEntry>();
  cache.set("openai/gpt-5", { value: -1 });

  let calls = 0;
  const client = {
    provider: {
      list: () => {
        calls += 1;
        return Promise.resolve({
          providers: [
            {
              id: "openai",
              models: [{ id: "gpt-5", limit: { context: 654_321 } }],
            },
          ],
        });
      },
    },
  };

  assertEquals(
    await resolveContextLimit(
      "openai",
      "gpt-5",
      client as never,
      undefined,
      cache,
    ),
    654_321,
  );

  assertEquals(calls, 1);
  assertEquals(cache.get("openai/gpt-5"), 654_321);
});
