import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";

const SMOKE_FIXTURE_PATH = new URL(
  "./runtime-teardown.smoke-fixture.ts",
  import.meta.url,
).pathname;

const smokeRunPermission = await Deno.permissions.query({
  name: "run",
  command: Deno.execPath(),
});
const smokeReadPermission = await Deno.permissions.query({
  name: "read",
  path: SMOKE_FIXTURE_PATH,
});

const waitForExit = async (
  child: Deno.ChildProcess,
  timeoutMs: number,
): Promise<Deno.CommandStatus> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.status,
      new Promise<Deno.CommandStatus>((_, reject) => {
        timeoutId = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Best-effort timeout cleanup only.
          }
          reject(new Error(`subprocess did not exit within ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

Deno.test({
  name:
    "runtime teardown smoke: gracefully exits a live node-style host process on first SIGINT",
  ignore: smokeRunPermission.state !== "granted" ||
    smokeReadPermission.state === "denied",
  fn: async () => {
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", SMOKE_FIXTURE_PATH],
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    const stdoutPromise = new Response(child.stdout).text();
    const stderrPromise = new Response(child.stderr).text();

    await new Promise((resolve) => setTimeout(resolve, 100));
    child.kill("SIGINT");

    const status = await waitForExit(child, 2_000);
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

    assertEquals(status.success, false);
    assertEquals(status.code, 130);
    assertStringIncludes(stdout, "ready\n");
    assertStringIncludes(stdout, "teardown-run\n");
    assertStringIncludes(
      stderr,
      "Graceful shutdown in progress; waiting for pending memory flush.",
    );
  },
});
