import { assertFalse, assertStrictEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { stub } from "jsr:@std/testing@^1.0.0/mock";
import os from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import type { GraphitiConfig } from "./types/index.ts";

async function withTempDir<T>(
  fn: (directory: string) => T | Promise<T>,
): Promise<T> {
  const directory = await Deno.makeTempDir();

  try {
    return await fn(directory);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

function withTempDirAsCwd<T>(
  fn: (directory: string) => T | Promise<T>,
): Promise<T> {
  const previousCwd = Deno.cwd();

  return withTempDir(async (directory) => {
    try {
      Deno.chdir(directory);
      return await fn(directory);
    } finally {
      Deno.chdir(previousCwd);
    }
  });
}

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

const explicitDirectoryConfigCases = [
  {
    name:
      "should load project-local .graphitirc via explicit directory argument",
    fileName: ".graphitirc",
    fileContents: {
      endpoint: "http://project.local/mcp",
      driftThreshold: 0.4,
      factStaleDays: 7,
    },
    expected: {
      endpoint: "http://project.local/mcp",
      groupIdPrefix: "opencode",
      driftThreshold: 0.4,
      factStaleDays: 7,
    },
  },
  {
    name:
      "should load project-local package.json graphiti key via explicit directory argument",
    fileName: "package.json",
    fileContents: {
      name: "my-project",
      graphiti: {
        endpoint: "http://pkg-project.local/mcp",
        driftThreshold: 0.2,
        factStaleDays: 5,
      },
    },
    expected: {
      endpoint: "http://pkg-project.local/mcp",
      groupIdPrefix: "opencode",
      driftThreshold: 0.2,
      factStaleDays: 5,
    },
  },
] satisfies Array<{
  name: string;
  fileName: string;
  fileContents: unknown;
  expected: Pick<
    GraphitiConfig,
    "endpoint" | "groupIdPrefix" | "driftThreshold" | "factStaleDays"
  >;
}>;

describe("config", () => {
  describe("loadConfig", () => {
    it("should load config from package.json graphiti key", async () => {
      await withTempDirAsCwd(async (cwd) => {
        const packageConfig = {
          name: "opencode-graphiti",
          graphiti: {
            endpoint: "http://example.com",
            driftThreshold: 0.3,
            factStaleDays: 14,
          },
        };
        await Deno.writeTextFile(
          join(cwd, "package.json"),
          JSON.stringify(packageConfig, null, 2),
        );

        const config = loadConfig();
        assertConfigValues(config, {
          endpoint: "http://example.com",
          groupIdPrefix: "opencode",
          driftThreshold: 0.3,
          factStaleDays: 14,
        });
      });
    });

    it("should load config from .graphitirc when present", async () => {
      await withTempDirAsCwd(async (cwd) => {
        const rcConfig = {
          endpoint: "http://rc.local",
          driftThreshold: 0.7,
          factStaleDays: 21,
        };
        await Deno.writeTextFile(
          join(cwd, ".graphitirc"),
          JSON.stringify(rcConfig, null, 2),
        );

        const config = loadConfig();
        assertConfigValues(config, {
          endpoint: "http://rc.local",
          groupIdPrefix: "opencode",
          driftThreshold: 0.7,
          factStaleDays: 21,
        });
      });
    });

    it("should return default config when file does not exist", async () => {
      await withTempDirAsCwd(() => {
        const config = loadConfig();
        assertConfigValues(config, {
          endpoint: "http://localhost:8000/mcp",
          groupIdPrefix: "opencode",
          driftThreshold: 0.5,
          factStaleDays: 30,
        });
      });
    });

    it("should return a valid GraphitiConfig type", async () => {
      await withTempDirAsCwd(() => {
        const config = loadConfig();
        // Type checking via runtime assertions
        assertFalse(config.endpoint === undefined);
        assertFalse(config.groupIdPrefix === undefined);
        assertFalse(config.driftThreshold === undefined);
        assertFalse(config.factStaleDays === undefined);
      });
    });

    // --- directory-argument tests ---

    for (const testCase of explicitDirectoryConfigCases) {
      it(testCase.name, async () => {
        await withTempDir(async (projectDir) => {
          await Deno.writeTextFile(
            join(projectDir, testCase.fileName),
            JSON.stringify(testCase.fileContents, null, 2),
          );

          const config = loadConfig(projectDir);
          assertConfigValues(config, testCase.expected);
        });
      });
    }

    it("should fall back to the same global/default config when directory argument points to a dir with no config", async () => {
      await withTempDirAsCwd(async () => {
        const fallbackConfig = loadConfig();

        await withTempDir((emptyDir) => {
          const config = loadConfig(emptyDir);
          assertConfigValues(config, fallbackConfig);
        });
      });
    });

    it("project-local config overrides when both project and CWD configs differ", async () => {
      await withTempDir(async (projectDir) => {
        await withTempDirAsCwd(async (otherDir) => {
          // CWD has one endpoint, project dir has another
          await Deno.writeTextFile(
            join(otherDir, ".graphitirc"),
            JSON.stringify({ endpoint: "http://cwd.local/mcp" }, null, 2),
          );
          await Deno.writeTextFile(
            join(projectDir, ".graphitirc"),
            JSON.stringify(
              { endpoint: "http://project-override.local/mcp" },
              null,
              2,
            ),
          );

          const config = loadConfig(projectDir);
          // Must pick project dir, not CWD
          assertStrictEquals(
            config.endpoint,
            "http://project-override.local/mcp",
          );
        });
      });
    });

    // --- legacy home fallback tests ---
    //
    // README documents a legacy fallback at ~/.config/opencode/.graphitirc (step 3 in
    // lookup order).  These tests are deterministic regression tests that verify this
    // exact path is read when no project-local or standard global config is found.
    //
    // The tests use an isolated fake home directory (via os.homedir() stub) so the
    // real home directory is never touched.

    it("loads ~/.config/opencode/.graphitirc as legacy fallback when no other config exists", async () => {
      // Create an isolated fake home dir so the real ~ is never touched.
      const fakeHome = await Deno.makeTempDir({ prefix: "graphiti_fakehome_" });
      const legacyDir = join(fakeHome, ".config", "opencode");

      try {
        await Deno.mkdir(legacyDir, { recursive: true });
        await Deno.writeTextFile(
          join(legacyDir, ".graphitirc"),
          JSON.stringify({
            endpoint: "http://legacy-opencode.local/mcp",
            driftThreshold: 0.8,
            factStaleDays: 42,
          }),
        );

        // Redirect os.homedir() for the duration of this test only.
        // CWD is outside fakeHome so the upward walk never reaches it.
        using _homedirStub = stub(os, "homedir", () => fakeHome);

        await withTempDirAsCwd(() => {
          const config = loadConfig();
          assertConfigValues(config, {
            endpoint: "http://legacy-opencode.local/mcp",
            groupIdPrefix: "opencode", // default, not in file
            driftThreshold: 0.8,
            factStaleDays: 42,
          });
        });
      } finally {
        await Deno.remove(fakeHome, { recursive: true });
      }
    });

    it("merges partial ~/.config/opencode/.graphitirc with defaults", async () => {
      const fakeHome = await Deno.makeTempDir({ prefix: "graphiti_fakehome_" });
      const legacyDir = join(fakeHome, ".config", "opencode");

      try {
        await Deno.mkdir(legacyDir, { recursive: true });
        // Only override one field; remaining fields must come from DEFAULT_CONFIG.
        await Deno.writeTextFile(
          join(legacyDir, ".graphitirc"),
          JSON.stringify({ endpoint: "http://partial-legacy.local/mcp" }),
        );

        using _homedirStub = stub(os, "homedir", () => fakeHome);

        await withTempDirAsCwd(() => {
          const config = loadConfig();
          assertStrictEquals(
            config.endpoint,
            "http://partial-legacy.local/mcp",
          );
          assertStrictEquals(config.groupIdPrefix, "opencode"); // default
          assertStrictEquals(config.driftThreshold, 0.5); // default
          assertStrictEquals(config.factStaleDays, 30); // default
        });
      } finally {
        await Deno.remove(fakeHome, { recursive: true });
      }
    });

    it("project-local config takes precedence over ~/.config/opencode/.graphitirc", async () => {
      const fakeHome = await Deno.makeTempDir({ prefix: "graphiti_fakehome_" });
      const legacyDir = join(fakeHome, ".config", "opencode");

      try {
        await Deno.mkdir(legacyDir, { recursive: true });
        await Deno.writeTextFile(
          join(legacyDir, ".graphitirc"),
          JSON.stringify({
            endpoint: "http://legacy-should-be-ignored.local/mcp",
          }),
        );

        using _homedirStub = stub(os, "homedir", () => fakeHome);

        await withTempDir(async (projectDir) => {
          await Deno.writeTextFile(
            join(projectDir, ".graphitirc"),
            JSON.stringify({ endpoint: "http://project-wins.local/mcp" }),
          );

          const config = loadConfig(projectDir);
          assertStrictEquals(config.endpoint, "http://project-wins.local/mcp");
        });
      } finally {
        await Deno.remove(fakeHome, { recursive: true });
      }
    });
  });
});
