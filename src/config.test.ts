import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { afterEach, describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import os from "node:os";
import { stub } from "jsr:@std/testing@^1.0.0/mock";
import {
  type ConfigExplorerAdapter,
  loadConfig,
  resetConfigExplorerAdapterForTesting,
  setConfigExplorerAdapterForTesting,
} from "./config.ts";

function makeAdapter(options?: {
  searchResult?: unknown | null;
  loadResult?: unknown | null;
}): ConfigExplorerAdapter {
  return {
    search() {
      return options?.searchResult == null
        ? null
        : { config: options.searchResult };
    },
    load() {
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
    assertEquals(config.falkordb.redisEndpoint, "redis://localhost:6379");
    assertEquals(config.falkordb.batchSize, 20);
  });

  it("prefers nested graphiti and falkordb values over legacy top-level keys", () => {
    setConfigExplorerAdapterForTesting(() =>
      makeAdapter({
        searchResult: {
          endpoint: "http://legacy.example/mcp",
          groupIdPrefix: "legacy",
          redisEndpoint: "redis://legacy:6379",
          graphiti: {
            endpoint: "http://nested.example/mcp",
            groupIdPrefix: "nested",
            driftThreshold: 0.75,
          },
          falkordb: {
            redisEndpoint: "redis://nested:6379",
            batchSize: 9,
          },
        },
      })
    );

    const config = loadConfig();

    assertEquals(config.graphiti.endpoint, "http://nested.example/mcp");
    assertEquals(config.graphiti.groupIdPrefix, "nested");
    assertEquals(config.graphiti.driftThreshold, 0.75);
    assertEquals(config.falkordb.redisEndpoint, "redis://nested:6379");
    assertEquals(config.falkordb.batchSize, 9);
    assertEquals(config.endpoint, "http://nested.example/mcp");
    assertEquals(config.driftThreshold, 0.75);
    assertEquals(config.redisEndpoint, "redis://nested:6379");
  });

  it("uses legacy fallback file when discovery finds nothing", () => {
    using _homedir = stub(os, "homedir", () => "/users/tester");
    setConfigExplorerAdapterForTesting(() =>
      makeAdapter({
        loadResult: {
          endpoint: "http://legacy.example/mcp",
          redisEndpoint: "redis://legacy:6379",
        },
      })
    );

    const config = loadConfig();
    assertEquals(config.graphiti.endpoint, "http://legacy.example/mcp");
    assertEquals(config.falkordb.redisEndpoint, "redis://legacy:6379");
  });

  it("falls back to defaults for invalid numeric config values", () => {
    setConfigExplorerAdapterForTesting(() =>
      makeAdapter({
        searchResult: {
          graphiti: {
            driftThreshold: 2,
            factStaleDays: 0,
          },
          falkordb: {
            batchSize: 0,
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
    assertEquals(config.graphiti.factStaleDays, 30);
    assertEquals(config.falkordb.batchSize, 20);
    assertEquals(config.falkordb.batchMaxBytes, 51_200);
    assertEquals(config.falkordb.sessionTtlSeconds, 86_400);
    assertEquals(config.falkordb.cacheTtlSeconds, 600);
    assertEquals(config.falkordb.drainRetryMax, 3);
  });
});
