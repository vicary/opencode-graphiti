import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1.0.0";
import { afterEach, describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import os from "node:os";
import { stub } from "jsr:@std/testing@^1.0.0/mock";
import {
  type ConfigExplorerAdapter,
  ConfigLoadError,
  loadConfig,
  resetConfigExplorerAdapterForTesting,
  setConfigExplorerAdapterForTesting,
} from "./config.ts";

function makeAdapter(options?: {
  searchResult?: unknown | null;
  loadResult?: unknown | null;
  searchError?: Error;
  loadError?: Error;
}): ConfigExplorerAdapter {
  return {
    search() {
      if (options?.searchError) throw options.searchError;
      return options?.searchResult == null
        ? null
        : { config: options.searchResult };
    },
    load() {
      if (options?.loadError) throw options.loadError;
      return options?.loadResult == null
        ? null
        : { config: options.loadResult };
    },
  };
}

describe("config", () => {
  afterEach(() => resetConfigExplorerAdapterForTesting());

  it("returns defaults when no config is found", () => {
    setConfigExplorerAdapterForTesting(() => makeAdapter());
    const config = loadConfig();

    assertEquals(config.graphiti.endpoint, "http://localhost:8000/mcp");
    assertEquals(config.graphiti.groupIdPrefix, "opencode");
    assertEquals(config.graphiti.driftThreshold, 0.5);
    assertEquals(config.redis.endpoint, "redis://localhost:6379");
    assertEquals(config.redis.batchSize, 20);
    assertEquals(config.redis.batchMaxBytes, 51_200);
    assertEquals(config.redis.sessionTtlSeconds, 86_400);
    assertEquals(config.redis.cacheTtlSeconds, 600);
    assertEquals(config.redis.drainRetryMax, 3);
  });

  it("prefers nested graphiti and redis values over legacy top-level graphiti keys", () => {
    setConfigExplorerAdapterForTesting(() =>
      makeAdapter({
        searchResult: {
          endpoint: "http://legacy.example/mcp",
          groupIdPrefix: "legacy",
          redis: {
            endpoint: "redis://canonical:6379",
            batchSize: 9,
            batchMaxBytes: 40_000,
          },
          graphiti: {
            endpoint: "http://nested.example/mcp",
            groupIdPrefix: "nested",
            driftThreshold: 0.75,
          },
        },
      })
    );

    const config = loadConfig();

    assertEquals(config.graphiti.endpoint, "http://nested.example/mcp");
    assertEquals(config.graphiti.groupIdPrefix, "nested");
    assertEquals(config.graphiti.driftThreshold, 0.75);
    assertEquals(config.redis.endpoint, "redis://canonical:6379");
    assertEquals(config.redis.batchSize, 9);
    assertEquals(config.redis.batchMaxBytes, 40_000);
    assertEquals(config.endpoint, "http://nested.example/mcp");
    assertEquals(config.driftThreshold, 0.75);
  });

  it("falls back to redis defaults when unsupported falkordb values are provided", () => {
    setConfigExplorerAdapterForTesting(() =>
      makeAdapter({
        searchResult: {
          falkordb: {
            redisEndpoint: "redis://compat-only:6379",
            batchSize: 11,
          },
        },
      })
    );

    const config = loadConfig();

    assertEquals(config.redis.endpoint, "redis://localhost:6379");
    assertEquals(config.redis.batchSize, 20);
  });

  it("ignores removed top-level redis aliases", () => {
    setConfigExplorerAdapterForTesting(() =>
      makeAdapter({
        searchResult: {
          redisEndpoint: "redis://toplevel:6379",
          batchSize: 5,
          batchMaxBytes: 10_000,
          sessionTtlSeconds: 3600,
          cacheTtlSeconds: 300,
          drainRetryMax: 1,
        },
      })
    );

    const config = loadConfig();

    assertEquals(config.redis.endpoint, "redis://localhost:6379");
    assertEquals(config.redis.batchSize, 20);
    assertEquals(config.redis.batchMaxBytes, 51_200);
    assertEquals(config.redis.sessionTtlSeconds, 86_400);
    assertEquals(config.redis.cacheTtlSeconds, 600);
    assertEquals(config.redis.drainRetryMax, 3);
  });

  it("falls back to defaults when only removed top-level redis aliases are provided", () => {
    setConfigExplorerAdapterForTesting(() =>
      makeAdapter({
        searchResult: {
          redisEndpoint: "redis://removed:6379",
          batchSize: 5,
          batchMaxBytes: 10_000,
          sessionTtlSeconds: 3600,
          cacheTtlSeconds: 300,
          drainRetryMax: 1,
        },
      })
    );

    const config = loadConfig();

    assertEquals(config.redis.endpoint, "redis://localhost:6379");
    assertEquals(config.redis.batchSize, 20);
    assertEquals(config.redis.batchMaxBytes, 51_200);
    assertEquals(config.redis.sessionTtlSeconds, 86_400);
    assertEquals(config.redis.cacheTtlSeconds, 600);
    assertEquals(config.redis.drainRetryMax, 3);
  });

  it("uses legacy fallback file when discovery finds nothing", () => {
    using _homedir = stub(os, "homedir", () => "/users/tester");
    setConfigExplorerAdapterForTesting(() =>
      makeAdapter({
        loadResult: {
          endpoint: "http://legacy.example/mcp",
          redis: { endpoint: "redis://legacy:6379" },
        },
      })
    );

    const config = loadConfig();
    assertEquals(config.graphiti.endpoint, "http://legacy.example/mcp");
    assertEquals(config.redis.endpoint, "redis://legacy:6379");
  });

  it("falls back to defaults for invalid numeric config values", () => {
    setConfigExplorerAdapterForTesting(() =>
      makeAdapter({
        searchResult: {
          graphiti: {
            driftThreshold: 2,
          },
          redis: {
            batchSize: 0,
          },
          falkordb: {
            batchMaxBytes: -10,
            sessionTtlSeconds: -1,
            cacheTtlSeconds: 0,
            drainRetryMax: -1,
          },
        },
      })
    );

    const config = loadConfig();

    assertEquals(config.graphiti.driftThreshold, 0.5);
    assertEquals(config.redis.batchSize, 20);
    assertEquals(config.redis.batchMaxBytes, 51_200);
    assertEquals(config.redis.sessionTtlSeconds, 86_400);
    assertEquals(config.redis.cacheTtlSeconds, 600);
    assertEquals(config.redis.drainRetryMax, 3);
  });

  it("prefers defaults when canonical redis values are invalid", () => {
    setConfigExplorerAdapterForTesting(() =>
      makeAdapter({
        searchResult: {
          redis: {
            batchSize: 0,
          },
        },
      })
    );

    const config = loadConfig();

    assertEquals(config.redis.batchSize, 20);
  });

  it("throws when a configured graphiti endpoint is invalid", () => {
    setConfigExplorerAdapterForTesting(() =>
      makeAdapter({
        searchResult: {
          graphiti: {
            endpoint: "not a valid url",
          },
        },
      })
    );

    assertThrows(
      () => loadConfig(),
      ConfigLoadError,
      'Invalid config value for graphiti.endpoint: expected a valid URL, received "not a valid url"',
    );
  });

  it("uses the same neutral validation wording for invalid redis endpoints", () => {
    setConfigExplorerAdapterForTesting(() =>
      makeAdapter({
        searchResult: {
          redis: {
            endpoint: "not a valid redis url",
          },
        },
      })
    );

    assertThrows(
      () => loadConfig(),
      ConfigLoadError,
      'Invalid config value for redis.endpoint: expected a valid URL, received "not a valid redis url"',
    );
  });

  it("redacts credentials from malformed configured endpoint errors", () => {
    setConfigExplorerAdapterForTesting(() =>
      makeAdapter({
        searchResult: {
          graphiti: {
            endpoint: "http://user:secret@bad host",
          },
        },
      })
    );

    assertThrows(
      () => loadConfig(),
      ConfigLoadError,
      'Invalid config value for graphiti.endpoint: expected a valid URL, received "http://bad host"',
    );
  });

  it("accepts endpoint-like config values with incidental surrounding whitespace", () => {
    setConfigExplorerAdapterForTesting(() =>
      makeAdapter({
        searchResult: {
          endpoint: "  http://legacy.example/mcp  ",
          redis: {
            endpoint: "  redis://trimmed:6379  ",
          },
          graphiti: {
            endpoint: "  http://nested.example/mcp  ",
          },
        },
      })
    );

    const config = loadConfig();

    assertEquals(config.endpoint, "http://nested.example/mcp");
    assertEquals(config.graphiti.endpoint, "http://nested.example/mcp");
    assertEquals(config.redis.endpoint, "redis://trimmed:6379");
  });

  it("trims graphiti groupIdPrefix values with incidental surrounding whitespace", () => {
    setConfigExplorerAdapterForTesting(() =>
      makeAdapter({
        searchResult: {
          graphiti: {
            groupIdPrefix: "  nested-prefix  ",
          },
        },
      })
    );

    const config = loadConfig();

    assertEquals(config.graphiti.groupIdPrefix, "nested-prefix");
    assertEquals(config.groupIdPrefix, "nested-prefix");
  });

  it("falls back to the default groupIdPrefix when the configured value is only whitespace", () => {
    setConfigExplorerAdapterForTesting(() =>
      makeAdapter({
        searchResult: {
          groupIdPrefix: "   ",
          graphiti: {
            groupIdPrefix: "\n\t  ",
          },
        },
      })
    );

    const config = loadConfig();

    assertEquals(config.graphiti.groupIdPrefix, "opencode");
    assertEquals(config.groupIdPrefix, "opencode");
  });

  it("fails open to defaults when config discovery search fails", () => {
    using _homedir = stub(os, "homedir", () => "/users/tester");
    setConfigExplorerAdapterForTesting(() =>
      makeAdapter({
        searchError: new Error("search failed"),
        loadResult: {
          endpoint: "http://legacy.example/mcp",
          redis: { endpoint: "redis://legacy:6379" },
        },
      })
    );

    const config = loadConfig();

    assertEquals(config.graphiti.endpoint, "http://localhost:8000/mcp");
    assertEquals(config.graphiti.groupIdPrefix, "opencode");
    assertEquals(config.graphiti.driftThreshold, 0.5);
    assertEquals(config.redis.endpoint, "redis://localhost:6379");
    assertEquals(config.redis.batchSize, 20);
  });

  it("fails open to defaults when the legacy config file cannot be loaded", () => {
    using _homedir = stub(os, "homedir", () => "/users/tester");
    setConfigExplorerAdapterForTesting(() =>
      makeAdapter({
        loadError: new Error("legacy load failed"),
      })
    );

    const config = loadConfig();

    assertEquals(config.graphiti.endpoint, "http://localhost:8000/mcp");
    assertEquals(config.graphiti.groupIdPrefix, "opencode");
    assertEquals(config.graphiti.driftThreshold, 0.5);
    assertEquals(config.redis.endpoint, "redis://localhost:6379");
    assertEquals(config.redis.batchSize, 20);
  });

  it("fails open to defaults when config discovery initialization fails", () => {
    setConfigExplorerAdapterForTesting(() => {
      throw new Error("cosmiconfig unavailable");
    });

    const config = loadConfig();

    assertEquals(config.graphiti.endpoint, "http://localhost:8000/mcp");
    assertEquals(config.redis.endpoint, "redis://localhost:6379");
  });

  it("fails open based on stable discovery error code instead of message text", () => {
    setConfigExplorerAdapterForTesting(() => ({
      search() {
        throw new ConfigLoadError("different discovery wording", {
          code: "config-discovery-search",
        });
      },
      load() {
        return null;
      },
    }));

    const config = loadConfig();

    assertEquals(config.graphiti.endpoint, "http://localhost:8000/mcp");
    assertEquals(config.redis.endpoint, "redis://localhost:6379");
  });

  it("preserves Error.cause semantics when wrapping config load failures", () => {
    const cause = new Error("search failed");
    const error = new ConfigLoadError("Unable to discover Graphiti config", {
      cause,
      code: "config-discovery-search",
    });

    assertEquals(error.cause, cause);
    assert(!Object.prototype.propertyIsEnumerable.call(error, "cause"));
  });

  it("omits cause when no wrapped error is provided", () => {
    const error = new ConfigLoadError("Unable to discover Graphiti config", {
      code: "config-discovery-search",
    });

    assert(!Object.hasOwn(error, "cause"));
  });
});
