import { assertFalse, assertStrictEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
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
  });
});
