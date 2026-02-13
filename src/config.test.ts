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
            driftThreshold: 0.3,
            factStaleDays: 14,
          },
        };
        await Deno.writeTextFile(
          join(cwd, "package.json"),
          JSON.stringify(packageConfig, null, 2),
        );

        Deno.chdir(cwd);
        const config = loadConfig();
        assertStrictEquals(config.endpoint, "http://example.com");
        assertStrictEquals(config.driftThreshold, 0.3);
        assertStrictEquals(config.factStaleDays, 14);
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
          driftThreshold: 0.7,
          factStaleDays: 21,
        };
        await Deno.writeTextFile(
          join(cwd, ".graphitirc"),
          JSON.stringify(rcConfig, null, 2),
        );

        Deno.chdir(cwd);
        const config = loadConfig();
        assertStrictEquals(config.endpoint, "http://rc.local");
        assertStrictEquals(config.driftThreshold, 0.7);
        assertStrictEquals(config.factStaleDays, 21);
      } finally {
        Deno.chdir(previousCwd);
        await Deno.remove(cwd, { recursive: true });
      }
    });

    it("should return default config when file does not exist", async () => {
      const cwd = await Deno.makeTempDir();
      const previousCwd = Deno.cwd();
      try {
        Deno.chdir(cwd);
        const config = loadConfig();
        // Should have all default fields
        assertStrictEquals(typeof config.endpoint, "string");
        assertStrictEquals(typeof config.groupIdPrefix, "string");
        assertStrictEquals(typeof config.driftThreshold, "number");
        assertStrictEquals(typeof config.factStaleDays, "number");

        // Verify default values
        assertStrictEquals(config.endpoint, "http://localhost:8000/mcp");
        assertStrictEquals(config.groupIdPrefix, "opencode");
        assertStrictEquals(config.driftThreshold, 0.5);
        assertStrictEquals(config.factStaleDays, 30);
      } finally {
        Deno.chdir(previousCwd);
        await Deno.remove(cwd, { recursive: true });
      }
    });

    it("should return a valid GraphitiConfig type", async () => {
      const cwd = await Deno.makeTempDir();
      const previousCwd = Deno.cwd();
      try {
        Deno.chdir(cwd);
        const config = loadConfig();
        // Type checking via runtime assertions
        assertFalse(config.endpoint === undefined);
        assertFalse(config.groupIdPrefix === undefined);
        assertFalse(config.driftThreshold === undefined);
        assertFalse(config.factStaleDays === undefined);
      } finally {
        Deno.chdir(previousCwd);
        await Deno.remove(cwd, { recursive: true });
      }
    });
  });
});
