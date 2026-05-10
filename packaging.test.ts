import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl } from "jsr:@std/path@^1.0.0/from-file-url";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import manifest from "./deno.json" with { type: "json" };

const workspaceRoot = new URL(".", import.meta.url);
const workspacePath = fromFileUrl(workspaceRoot);
const expectedSdkVersionFromDenoJson = manifest.imports[
  "@modelcontextprotocol/sdk"
].replace("npm:@modelcontextprotocol/sdk@", "");
const packagingRunPermissions = await Promise.all([
  Deno.permissions.query({ name: "run", command: "deno" }),
  Deno.permissions.query({ name: "run", command: "node" }),
  Deno.permissions.query({
    name: "run",
    command: Deno.build.os === "windows" ? "where" : "which",
  }),
  Deno.permissions.query({ name: "run", command: "bun" }),
]);
const packagingRunPermissionGranted = packagingRunPermissions.every(
  (permission, index) => index === 3 || permission.state === "granted",
);
const bunRunPermissionGranted = packagingRunPermissions[3]?.state === "granted";

const decodeText = (value: Uint8Array): string =>
  new TextDecoder().decode(value);

const commandExists = async (command: string): Promise<boolean> => {
  const whichCommand = Deno.build.os === "windows" ? "where" : "which";
  try {
    const output = await new Deno.Command(whichCommand, {
      args: [command],
      stdout: "null",
      stderr: "null",
    }).output();
    return output.code === 0;
  } catch {
    return false;
  }
};

const run = async (
  command: string,
  args: string[],
  cwd = workspacePath,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const output = await new Deno.Command(command, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: decodeText(output.stdout),
    stderr: decodeText(output.stderr),
  };
};

Deno.test({
  name: "built npm package loads in node through the published ESM entrypoint",
  ignore: !packagingRunPermissionGranted,
  fn: async () => {
    const build = await run("deno", ["task", "build"]);
    assertEquals(build.code, 0, build.stderr || build.stdout);

    const builtPackage = JSON.parse(
      await Deno.readTextFile(join(workspacePath, "dist/package.json")),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    assertEquals(
      builtPackage.dependencies?.cosmiconfig,
      "^9.0.0",
      "generated npm package must declare cosmiconfig for runtime config loading",
    );
    assertEquals(
      builtPackage.dependencies?.["@modelcontextprotocol/sdk"],
      expectedSdkVersionFromDenoJson,
      "generated npm package must declare the MCP SDK for runtime loading",
    );
    assertEquals(
      typeof builtPackage.devDependencies?.["@types/node"],
      "string",
      "generated npm package must declare Node typings for dnt typecheck",
    );
    const tempDir = await Deno.makeTempDir();
    try {
      let optionalOpenCodePath: string | undefined;
      try {
        optionalOpenCodePath = Deno.env.get("OPENCODE_BIN") ?? undefined;
      } catch {
        optionalOpenCodePath = undefined;
      }

      const installRoot = join(tempDir, "package-install");
      const isolatedCwd = join(tempDir, "bare-cwd");
      const installNodeModules = join(installRoot, "node_modules");
      const packageDir = join(installNodeModules, "opencode-graphiti");
      const esmRunnerPath = join(installRoot, "load-esm.mjs");
      const configRunnerPath = join(installRoot, "load-config.mjs");
      const nodePackageRunnerPath = join(installRoot, "load-node-package.mjs");
      const bunRunnerPath = join(installRoot, "load-bun-package.mjs");
      const esmEntrypoint =
        pathToFileURL(join(workspacePath, "dist/esm/mod.js")).href;
      const isolatedHome = join(tempDir, "home");
      const isolatedConfig = join(isolatedHome, ".config", "opencode");
      const isolatedConfigPackageDir = join(
        isolatedConfig,
        "node_modules",
        "opencode-graphiti",
      );

      await Deno.mkdir(installNodeModules, { recursive: true });
      await Deno.mkdir(isolatedCwd, { recursive: true });
      await Deno.mkdir(isolatedConfig, { recursive: true });
      await Deno.writeTextFile(
        join(isolatedCwd, ".graphitirc"),
        `${
          JSON.stringify(
            { graphiti: { endpoint: "http://127.0.0.1:8899/mcp" } },
            null,
            2,
          )
        }\n`,
      );
      await Deno.symlink(join(workspacePath, "dist"), packageDir, {
        type: "dir",
      });
      await Deno.mkdir(join(isolatedConfig, "node_modules"), {
        recursive: true,
      });
      await Deno.symlink(
        join(workspacePath, "dist"),
        isolatedConfigPackageDir,
        {
          type: "dir",
        },
      );
      await Deno.writeTextFile(
        join(isolatedConfig, "opencode.json"),
        `${JSON.stringify({ plugin: ["opencode-graphiti"] }, null, 2)}\n`,
      );

      await Deno.writeTextFile(
        esmRunnerPath,
        `import * as plugin from ${
          JSON.stringify(esmEntrypoint)
        };\nconsole.log(JSON.stringify(Object.keys(plugin).sort()));\n`,
      );
      await Deno.writeTextFile(
        configRunnerPath,
        'import "opencode-graphiti";\n' +
          `const { loadConfig } = await import(${
            JSON.stringify(
              pathToFileURL(join(packageDir, "esm/src/config.js")).href,
            )
          });\n` +
          "const config = loadConfig(process.cwd());\n" +
          "console.log(JSON.stringify({ endpoint: config.endpoint, graphiti: config.graphiti.endpoint, redis: config.redis.endpoint }));\n",
      );
      await Deno.writeTextFile(
        nodePackageRunnerPath,
        'import * as plugin from "opencode-graphiti";\n' +
          "console.log(JSON.stringify(Object.keys(plugin).sort()));\n" +
          "plugin.graphiti({ client: {}, directory: process.cwd() }).then(async () => {\n" +
          "  await new Promise((resolve) => setTimeout(resolve, 1000));\n" +
          '  console.log("initialized");\n' +
          "  process.exit(0);\n" +
          "}, (error) => {\n" +
          "  console.error(error);\n" +
          "  process.exit(1);\n" +
          "});\n",
      );
      await Deno.writeTextFile(
        bunRunnerPath,
        'import * as plugin from "opencode-graphiti";\n' +
          "console.log(JSON.stringify(Object.keys(plugin).sort()));\n",
      );

      const esmLoad = await run("node", [esmRunnerPath], isolatedCwd);
      assertEquals(esmLoad.code, 0, esmLoad.stderr || esmLoad.stdout);
      assertEquals(esmLoad.stdout.trim(), '["graphiti"]');

      const configLoad = await run("node", [configRunnerPath], isolatedCwd);
      assertEquals(
        configLoad.code,
        0,
        [
          "config loader should resolve cosmiconfig from the plugin package instead of process.cwd()",
          configLoad.stderr || configLoad.stdout,
        ].filter(Boolean).join("\n\n"),
      );
      assertEquals(
        configLoad.stdout.trim(),
        '{"endpoint":"http://127.0.0.1:8899/mcp","graphiti":"http://127.0.0.1:8899/mcp","redis":"redis://127.0.0.1:6379"}',
      );

      const nodePackageLoad = await run(
        "node",
        [nodePackageRunnerPath],
        isolatedCwd,
      );
      assertEquals(
        nodePackageLoad.code,
        0,
        [
          "node package-name import from a bare cwd should succeed; this is the primary regression for cwd-sensitive runtime resolution",
          nodePackageLoad.stderr || nodePackageLoad.stdout,
        ].filter(Boolean).join("\n\n"),
      );
      assertEquals(
        nodePackageLoad.stdout.trim(),
        '["graphiti"]\ninitialized',
      );
      assertEquals(
        nodePackageLoad.stderr.includes(
          "Cannot find module '@modelcontextprotocol/sdk/client/index.js'",
        ),
        false,
        [
          "node package-name import from a bare cwd should not resolve runtime dependencies through process.cwd()",
          nodePackageLoad.stderr || nodePackageLoad.stdout,
        ].filter(Boolean).join("\n\n"),
      );

      if (bunRunPermissionGranted && await commandExists("bun")) {
        const bunLoad = await run("bun", [bunRunnerPath], isolatedCwd);
        assertEquals(bunLoad.code, 0, bunLoad.stderr || bunLoad.stdout);
        assertEquals(bunLoad.stdout.trim(), '["graphiti"]');
      }

      if (optionalOpenCodePath) {
        try {
          const opencodeInfo = await Deno.stat(optionalOpenCodePath);
          if (opencodeInfo.isFile) {
            const isolatedOpenCode = await new Deno.Command(
              optionalOpenCodePath,
              {
                args: ["--print-logs", "stats"],
                cwd: isolatedCwd,
                env: {
                  HOME: isolatedHome,
                  XDG_CONFIG_HOME: join(isolatedHome, ".config"),
                },
                stdout: "piped",
                stderr: "piped",
              },
            ).output();
            const isolatedOpenCodeOutput = decodeText(isolatedOpenCode.stdout) +
              decodeText(isolatedOpenCode.stderr);
            assertEquals(
              isolatedOpenCode.code,
              0,
              isolatedOpenCodeOutput,
            );
            assertEquals(
              isolatedOpenCodeOutput.includes("Missing 'default' export"),
              false,
              isolatedOpenCodeOutput,
            );
            assertEquals(
              isolatedOpenCodeOutput.includes(
                "Cannot find module '@modelcontextprotocol/sdk/client/index.js'",
              ),
              false,
              isolatedOpenCodeOutput,
            );
          }
        } catch {
          // OPENCODE_BIN is optional; keep the portable package checks above.
        }
      }
    } finally {
      await Deno.remove(tempDir, { recursive: true }).catch(() => undefined);
    }
  },
});
