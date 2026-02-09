import { assertFalse, assertStrictEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { join } from "node:path";
import { loadConfig } from "./config.ts";

describe("config", () => {
  describe("loadConfig", () => {
    it("should load config from package.json graphiti key", async () => {
      const cwd = await Deno.makeTempDir();
      const previousCwd = Deno.cwd();
      try {
        const packageConfig = {
          name: "opencode-graphiti",
          graphiti: {
            endpoint: "http://example.com",
            maxFacts: 42,
          },
        };
        await Deno.writeTextFile(
          join(cwd, "package.json"),
          JSON.stringify(packageConfig, null, 2),
        );

        Deno.chdir(cwd);
        const config = loadConfig();
        assertStrictEquals(config.endpoint, "http://example.com");
        assertStrictEquals(config.maxFacts, 42);
      } finally {
        Deno.chdir(previousCwd);
        await Deno.remove(cwd, { recursive: true });
      }
    });

    it("should load config from .graphitirc when present", async () => {
      const cwd = await Deno.makeTempDir();
      const previousCwd = Deno.cwd();
      try {
        const rcConfig = {
          endpoint: "http://rc.local",
          maxFacts: 9,
        };
        await Deno.writeTextFile(
          join(cwd, ".graphitirc"),
          JSON.stringify(rcConfig, null, 2),
        );

        Deno.chdir(cwd);
        const config = loadConfig();
        assertStrictEquals(config.endpoint, "http://rc.local");
        assertStrictEquals(config.maxFacts, 9);
      } finally {
        Deno.chdir(previousCwd);
        await Deno.remove(cwd, { recursive: true });
      }
    });

    it("should return default config when file does not exist", () => {
      const config = loadConfig();
      // Should have all default fields
      assertStrictEquals(typeof config.endpoint, "string");
      assertStrictEquals(typeof config.groupIdPrefix, "string");
      assertStrictEquals(typeof config.maxFacts, "number");
      assertStrictEquals(typeof config.maxNodes, "number");
      assertStrictEquals(typeof config.maxEpisodes, "number");
      assertStrictEquals(typeof config.injectOnFirstMessage, "boolean");
      assertStrictEquals(typeof config.enableCompactionSave, "boolean");

      // Verify default values
      assertStrictEquals(config.endpoint, "http://localhost:8000/mcp");
      assertStrictEquals(config.groupIdPrefix, "opencode");
      assertStrictEquals(config.maxFacts, 10);
      assertStrictEquals(config.maxNodes, 5);
      assertStrictEquals(config.maxEpisodes, 5);
      assertStrictEquals(config.injectOnFirstMessage, true);
      assertStrictEquals(config.enableCompactionSave, true);
    });

    it("should return a valid GraphitiConfig type", () => {
      const config = loadConfig();
      // Type checking via runtime assertions
      assertFalse(config.endpoint === undefined);
      assertFalse(config.groupIdPrefix === undefined);
      assertFalse(config.maxFacts === undefined);
      assertFalse(config.maxNodes === undefined);
      assertFalse(config.maxEpisodes === undefined);
      assertFalse(config.injectOnFirstMessage === undefined);
      assertFalse(config.enableCompactionSave === undefined);
    });
  });
});
