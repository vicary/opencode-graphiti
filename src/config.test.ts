import {
  assertEquals,
  assertFalse,
  assertStrictEquals,
} from "jsr:@std/assert@^1.0.0";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "jsr:@std/testing@^1.0.0/bdd";
import { stub } from "jsr:@std/testing@^1.0.0/mock";
import os from "node:os";
import {
  type ConfigExplorerAdapter,
  loadConfig,
  resetConfigExplorerAdapterForTesting,
  setConfigExplorerAdapterForTesting,
} from "./config.ts";
import type { GraphitiConfig } from "./types/index.ts";

function assertConfigValues(
  config: GraphitiConfig,
  expected: Pick<
    GraphitiConfig,
    "endpoint" | "groupIdPrefix" | "driftThreshold" | "factStaleDays"
  >,
) {
  assertStrictEquals(config.endpoint, expected.endpoint);
  assertStrictEquals(config.groupIdPrefix, expected.groupIdPrefix);
  assertStrictEquals(config.driftThreshold, expected.driftThreshold);
  assertStrictEquals(config.factStaleDays, expected.factStaleDays);
}

function makeAdapter(options?: {
  searchByDirectory?: Record<string, unknown | null>;
  loadResult?: Record<string, unknown | null>;
  searchErrorByDirectory?: Record<string, Error>;
  loadError?: Record<string, Error>;
  onSearch?: (from?: string) => void;
  onLoad?: (filePath: string) => void;
}): ConfigExplorerAdapter {
  return {
    search(from) {
      options?.onSearch?.(from);

      const directory = from ?? "__undefined__";
      const error = options?.searchErrorByDirectory?.[directory];
      if (error) throw error;

      const result = options?.searchByDirectory?.[directory];
      return result === undefined || result === null
        ? null
        : { config: result };
    },
    load(filePath) {
      options?.onLoad?.(filePath);

      const error = options?.loadError?.[filePath];
      if (error) throw error;

      const result = options?.loadResult?.[filePath];
      return result === undefined || result === null
        ? null
        : { config: result };
    },
  };
}

describe("config", () => {
  let originalError: typeof console.error;

  beforeEach(() => {
    originalError = console.error;
    console.error = () => {};
  });

  afterEach(() => {
    console.error = originalError;
    resetConfigExplorerAdapterForTesting();
  });

  describe("loadConfig", () => {
    it("uses cosmiconfig global search from Deno.cwd() when no directory is provided", () => {
      const fakeCwd = "/users/tester/workspace/project/subdir";
      const searchCalls: Array<string | undefined> = [];
      using _cwd = stub(Deno, "cwd", () => fakeCwd);
      setConfigExplorerAdapterForTesting(() =>
        makeAdapter({
          searchByDirectory: {
            __undefined__: {
              endpoint: "http://cwd-global.local/mcp",
              driftThreshold: 0.3,
              factStaleDays: 14,
            },
          },
          onSearch(from) {
            searchCalls.push(from);
          },
        })
      );

      const config = loadConfig();

      assertEquals(searchCalls, [undefined]);
      assertConfigValues(config, {
        endpoint: "http://cwd-global.local/mcp",
        groupIdPrefix: "opencode",
        driftThreshold: 0.3,
        factStaleDays: 14,
      });
    });

    it("uses the explicit directory as the cosmiconfig global-search start", () => {
      const explicitDir = "/users/tester/workspace/project";
      const searchCalls: Array<string | undefined> = [];
      setConfigExplorerAdapterForTesting(() =>
        makeAdapter({
          searchByDirectory: {
            "/users/tester/workspace/project": {
              endpoint: "http://home.local/mcp",
              driftThreshold: 0.7,
              factStaleDays: 21,
            },
          },
          onSearch(from) {
            searchCalls.push(from);
          },
        })
      );

      const config = loadConfig(explicitDir);

      assertEquals(searchCalls, ["/users/tester/workspace/project"]);
      assertConfigValues(config, {
        endpoint: "http://home.local/mcp",
        groupIdPrefix: "opencode",
        driftThreshold: 0.7,
        factStaleDays: 21,
      });
    });

    it("uses legacy fallback only after cosmiconfig search returns no config", () => {
      const fakeHome = "/users/tester";
      const explicitDir = "/users/tester/workspace/project";
      const searchCalls: Array<string | undefined> = [];
      const loadCalls: string[] = [];
      using _homedir = stub(os, "homedir", () => fakeHome);
      setConfigExplorerAdapterForTesting(() =>
        makeAdapter({
          loadResult: {
            "/users/tester/.config/opencode/.graphitirc": {
              endpoint: "http://legacy.local/mcp",
              driftThreshold: 0.8,
              factStaleDays: 42,
            },
          },
          onSearch(from) {
            searchCalls.push(from);
          },
          onLoad(filePath) {
            loadCalls.push(filePath);
          },
        })
      );

      const config = loadConfig(explicitDir);

      assertEquals(searchCalls, ["/users/tester/workspace/project"]);
      assertEquals(loadCalls, [
        "/users/tester/.config/opencode/.graphitirc",
      ]);
      assertConfigValues(config, {
        endpoint: "http://legacy.local/mcp",
        groupIdPrefix: "opencode",
        driftThreshold: 0.8,
        factStaleDays: 42,
      });
    });

    it("does not use legacy fallback when traversal already found config", () => {
      const loadCalls: string[] = [];
      using _cwd = stub(Deno, "cwd", () => "/users/tester/workspace/project");
      setConfigExplorerAdapterForTesting(() =>
        makeAdapter({
          searchByDirectory: {
            __undefined__: {
              endpoint: "http://discovered.local/mcp",
            },
          },
          onLoad(filePath) {
            loadCalls.push(filePath);
          },
        })
      );

      const config = loadConfig();

      assertStrictEquals(loadCalls.length, 0);
      assertStrictEquals(config.endpoint, "http://discovered.local/mcp");
    });

    it("fails open when creating the explorer adapter throws", () => {
      setConfigExplorerAdapterForTesting(() => {
        throw new Deno.errors.PermissionDenied("Denied");
      });

      const config = loadConfig();

      assertConfigValues(config, {
        endpoint: "http://localhost:8000/mcp",
        groupIdPrefix: "opencode",
        driftThreshold: 0.5,
        factStaleDays: 30,
      });
    });

    it("uses legacy fallback when Deno.cwd() throws and cosmiconfig search returns no config", () => {
      const fakeHome = "/users/tester";
      using _cwd = stub(Deno, "cwd", () => {
        throw new Deno.errors.PermissionDenied("Denied");
      });
      using _homedir = stub(os, "homedir", () => fakeHome);
      setConfigExplorerAdapterForTesting(() =>
        makeAdapter({
          loadResult: {
            "/users/tester/.config/opencode/.graphitirc": {
              endpoint: "http://legacy.local/mcp",
            },
          },
        })
      );

      const config = loadConfig();

      assertStrictEquals(config.endpoint, "http://legacy.local/mcp");
    });

    it("fails open when os.homedir() throws during legacy fallback", () => {
      using _homedir = stub(os, "homedir", () => {
        throw new Deno.errors.PermissionDenied("Denied");
      });
      setConfigExplorerAdapterForTesting(() => makeAdapter());

      const config = loadConfig();

      assertConfigValues(config, {
        endpoint: "http://localhost:8000/mcp",
        groupIdPrefix: "opencode",
        driftThreshold: 0.5,
        factStaleDays: 30,
      });
    });

    it("fails open when cosmiconfig search throws", () => {
      const explicitDir = "/users/tester/workspace/project";
      const searchCalls: Array<string | undefined> = [];
      setConfigExplorerAdapterForTesting(() =>
        makeAdapter({
          searchErrorByDirectory: {
            "/users/tester/workspace/project": new Deno.errors.PermissionDenied(
              "Denied",
            ),
          },
          onSearch(from) {
            searchCalls.push(from);
          },
        })
      );

      const config = loadConfig(explicitDir);

      assertEquals(searchCalls, ["/users/tester/workspace/project"]);
      assertConfigValues(config, {
        endpoint: "http://localhost:8000/mcp",
        groupIdPrefix: "opencode",
        driftThreshold: 0.5,
        factStaleDays: 30,
      });
    });

    it("fails open when the legacy fallback load throws", () => {
      const fakeHome = "/users/tester";
      using _homedir = stub(os, "homedir", () => fakeHome);
      setConfigExplorerAdapterForTesting(() =>
        makeAdapter({
          loadError: {
            "/users/tester/.config/opencode/.graphitirc": new Deno.errors
              .PermissionDenied("Denied"),
          },
        })
      );

      const config = loadConfig("/users/tester/workspace/project");

      assertConfigValues(config, {
        endpoint: "http://localhost:8000/mcp",
        groupIdPrefix: "opencode",
        driftThreshold: 0.5,
        factStaleDays: 30,
      });
    });

    it("merges partial discovered config with defaults", () => {
      using _cwd = stub(Deno, "cwd", () => "/users/tester/workspace/project");
      setConfigExplorerAdapterForTesting(() =>
        makeAdapter({
          searchByDirectory: {
            __undefined__: {
              endpoint: "http://partial.local/mcp",
            },
          },
        })
      );

      const config = loadConfig();

      assertStrictEquals(config.endpoint, "http://partial.local/mcp");
      assertStrictEquals(config.groupIdPrefix, "opencode");
      assertStrictEquals(config.driftThreshold, 0.5);
      assertStrictEquals(config.factStaleDays, 30);
    });

    it("merges partial legacy fallback config with defaults", () => {
      const fakeHome = "/users/tester";
      using _homedir = stub(os, "homedir", () => fakeHome);
      setConfigExplorerAdapterForTesting(() =>
        makeAdapter({
          loadResult: {
            "/users/tester/.config/opencode/.graphitirc": {
              endpoint: "http://partial-legacy.local/mcp",
            },
          },
        })
      );

      const config = loadConfig("/users/tester/workspace/project");

      assertStrictEquals(config.endpoint, "http://partial-legacy.local/mcp");
      assertStrictEquals(config.groupIdPrefix, "opencode");
      assertStrictEquals(config.driftThreshold, 0.5);
      assertStrictEquals(config.factStaleDays, 30);
    });

    it("returns a complete GraphitiConfig shape", () => {
      using _cwd = stub(Deno, "cwd", () => "/users/tester/workspace/project");
      setConfigExplorerAdapterForTesting(() => makeAdapter());

      const config = loadConfig();

      assertFalse(config.endpoint === undefined);
      assertFalse(config.groupIdPrefix === undefined);
      assertFalse(config.driftThreshold === undefined);
      assertFalse(config.factStaleDays === undefined);
    });
  });
});
