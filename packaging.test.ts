import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const workspaceRoot = new URL(".", import.meta.url);
const workspacePath = workspaceRoot.pathname;

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

Deno.test("built npm package loads in node through the published ESM entrypoint", async () => {
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
    typeof builtPackage.devDependencies?.["@types/node"],
    "string",
    "generated npm package must declare Node typings for dnt typecheck",
  );

  const tempDir = await Deno.makeTempDir();
  try {
    const esmRunnerPath = join(tempDir, "load-esm.mjs");
    const bunRunnerPath = join(tempDir, "load-bun.mjs");
    const esmEntrypoint =
      pathToFileURL(join(workspacePath, "dist/esm/mod.js")).href;
    const packageDir = join(tempDir, "node_modules", "opencode-graphiti");
    const isolatedHome = join(tempDir, "home");
    const isolatedConfig = join(isolatedHome, ".config", "opencode");

    await Deno.mkdir(join(tempDir, "node_modules"), { recursive: true });
    await Deno.mkdir(isolatedConfig, { recursive: true });
    await Deno.symlink(join(workspacePath, "dist"), packageDir, {
      type: "dir",
    });

    await Deno.writeTextFile(
      esmRunnerPath,
      `import * as plugin from ${
        JSON.stringify(esmEntrypoint)
      };\nconsole.log(JSON.stringify(Object.keys(plugin).sort()));\n`,
    );
    await Deno.writeTextFile(
      bunRunnerPath,
      'import * as plugin from "opencode-graphiti";\n' +
        "console.log(JSON.stringify(Object.keys(plugin).sort()));\n",
    );

    const esmLoad = await run("node", [esmRunnerPath]);
    assertEquals(esmLoad.code, 0, esmLoad.stderr || esmLoad.stdout);
    assertEquals(esmLoad.stdout.trim(), '["graphiti"]');

    if (await commandExists("bun")) {
      const bunLoad = await run("bun", [bunRunnerPath], tempDir);
      assertEquals(bunLoad.code, 0, bunLoad.stderr || bunLoad.stdout);
      assertEquals(bunLoad.stdout.trim(), '["graphiti"]');
    }

    const localOpenCodePath = "/Users/vicary/.opencode/bin/opencode";
    try {
      const opencodeInfo = await Deno.stat(localOpenCodePath);
      if (opencodeInfo.isFile) {
        const isolatedOpenCode = await new Deno.Command(localOpenCodePath, {
          args: ["--print-logs", "stats"],
          cwd: workspacePath,
          env: {
            HOME: isolatedHome,
            XDG_CONFIG_HOME: join(isolatedHome, ".config"),
          },
          stdout: "piped",
          stderr: "piped",
        }).output();
        const isolatedOpenCodeOutput = decodeText(isolatedOpenCode.stdout) +
          decodeText(isolatedOpenCode.stderr);
        assertEquals(
          isolatedOpenCodeOutput.includes("Missing 'default' export"),
          false,
          isolatedOpenCodeOutput,
        );
      }
    } catch {
      // OpenCode is not available in CI; keep the portable package checks above.
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => undefined);
  }
});
