import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const workspaceRoot = new URL(".", import.meta.url);
const workspacePath = workspaceRoot.pathname;

const decodeText = (value: Uint8Array): string =>
  new TextDecoder().decode(value);

const run = async (
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const output = await new Deno.Command(command, {
    args,
    cwd: workspacePath,
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

  const tempDir = await Deno.makeTempDir();
  try {
    const esmRunnerPath = join(tempDir, "load-esm.mjs");
    const esmEntrypoint =
      pathToFileURL(join(workspacePath, "dist/esm/mod.js")).href;

    await Deno.writeTextFile(
      esmRunnerPath,
      `import * as plugin from ${
        JSON.stringify(esmEntrypoint)
      };\nconsole.log(JSON.stringify(Object.keys(plugin).sort()));\n`,
    );

    const esmLoad = await run("node", [esmRunnerPath]);
    assertEquals(esmLoad.code, 0, esmLoad.stderr || esmLoad.stdout);
    assertEquals(esmLoad.stdout.trim(), '["graphiti"]');
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => undefined);
  }
});
