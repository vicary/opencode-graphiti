import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl } from "jsr:@std/path@^1.0.0/from-file-url";

const SMOKE_FIXTURE_PATH = fromFileUrl(
  new URL(
    "./runtime-teardown.smoke-fixture.ts",
    import.meta.url,
  ),
);

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

const waitForText = async (
  stream: ReadableStream<Uint8Array> | null,
  expected: string,
  timeoutMs: number,
): Promise<{
  seen: string;
  remainder: Promise<string>;
}> => {
  if (!stream) {
    return { seen: "", remainder: Promise.resolve("") };
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      (async () => {
        while (!seen.includes(expected)) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          seen += decoder.decode(value, { stream: true });
        }
      })(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          void reader.cancel();
          reject(
            new Error(`timed out waiting for ${JSON.stringify(expected)}`),
          );
        }, timeoutMs);
      }),
    ]);
    seen += decoder.decode();

    const remainder = (async () => {
      let output = seen;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          output += decoder.decode(value, { stream: true });
        }
        output += decoder.decode();
        return output;
      } finally {
        reader.releaseLock();
      }
    })();

    return { seen, remainder };
  } catch (error) {
    reader.releaseLock();
    throw error;
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

    const stdoutState = await waitForText(child.stdout, "ready\n", 2_000);
    const stderrPromise = new Response(child.stderr).text();

    child.kill("SIGINT");

    const status = await waitForExit(child, 2_000);
    const stdout = await stdoutState.remainder;
    const stderr = await stderrPromise;

    assertEquals(status.success, false);
    assertEquals(status.code, 130);
    assertStringIncludes(stdoutState.seen, "ready\n");
    assertStringIncludes(stdout, "teardown-run\n");
    assertStringIncludes(
      stderr,
      "Graceful shutdown in progress; waiting for pending memory flush.",
    );
  },
});
