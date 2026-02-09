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
            injectionInterval: 4,
          },
        };
        await Deno.writeTextFile(
          join(cwd, "package.json"),
          JSON.stringify(packageConfig, null, 2),
        );

        Deno.chdir(cwd);
        const config = loadConfig();
        assertStrictEquals(config.endpoint, "http://example.com");
        assertStrictEquals(config.injectionInterval, 4);
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
          injectionInterval: 6,
        };
        await Deno.writeTextFile(
          join(cwd, ".graphitirc"),
          JSON.stringify(rcConfig, null, 2),
        );

        Deno.chdir(cwd);
        const config = loadConfig();
        assertStrictEquals(config.endpoint, "http://rc.local");
        assertStrictEquals(config.injectionInterval, 6);
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
        assertStrictEquals(typeof config.injectionInterval, "number");

        // Verify default values
        assertStrictEquals(config.endpoint, "http://localhost:8000/mcp");
        assertStrictEquals(config.groupIdPrefix, "opencode");
        assertStrictEquals(config.injectionInterval, 10);
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
        assertFalse(config.injectionInterval === undefined);
      } finally {
        Deno.chdir(previousCwd);
        await Deno.remove(cwd, { recursive: true });
      }
    });
  });
});
