import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "jsr:@std/testing@^1.0.0/bdd";
import {
  createDetachedDreamProofPlugin,
  PROOF_WAIT_MS,
} from "./detached-dream-proof.ts";
import { setWarningTaskScheduler } from "../services/opencode-warning.ts";

const readJson = async (path: string): Promise<Record<string, unknown>> => {
  const text = await Deno.readTextFile(path);
  return JSON.parse(text) as Record<string, unknown>;
};

describe("detached dream proof", () => {
  beforeEach(() => {
    // Run scheduled callbacks synchronously so toast assertions are deterministic.
    setWarningTaskScheduler((cb) => cb());
  });

  afterEach(() => {
    setWarningTaskScheduler(undefined);
  });

  it("registers a TUI teardown task and writes a TUI artifact during shutdown", async () => {
    const directory = await Deno.makeTempDir({ prefix: "dream-proof-tui-" });
    const toasts: string[] = [];
    const logs: string[] = [];
    const registrations: Array<{
      name: string;
      run: () => void | Promise<void>;
    }> = [];

    try {
      const plugin = createDetachedDreamProofPlugin({
        host: "tui",
        waitMs: 0,
        registerRuntimeTeardown: (tasks) => {
          registrations.push(...tasks);
          return {
            run: async () => {
              for (const task of tasks) await task.run();
            },
            dispose: () => {},
          };
        },
      });

      const hooks = await plugin({
        client: {
          tui: {
            showToast: ({ body }: { body: { message: string } }) => {
              toasts.push(body.message);
            },
          },
          app: {
            log: ({ body }: { body: { message: string } }) => {
              logs.push(body.message);
            },
          },
        } as never,
        directory,
      } as never);

      assertEquals(registrations.length, 0);

      const result = await hooks.tool!.detached_dream_proof_tui.execute(
        {},
        {} as never,
      );
      assertStringIncludes(
        String(result),
        "Detached dream proof for tui armed",
      );

      assertEquals(registrations.length, 1);
      assertEquals(registrations[0].name, "detached_dream_proof_tui");

      await registrations[0].run();

      const artifact = await readJson(
        `${directory}/.opencode-detached-dream-proof-tui.json`,
      );
      assertEquals(artifact.proof, "detached_dream_proof_tui");
      assertEquals(artifact.host, "tui");
      assertEquals(artifact.wait_ms, 0);
      assertEquals(toasts.length, 2);
      assertStringIncludes(
        toasts[0],
        "Gracefully exit the TUI host",
      );
      assertStringIncludes(toasts[1], "waiting about 0 seconds");
      assertEquals(logs.length, 1);
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  });

  it("registers a startup-armed server teardown task and writes a server artifact during shutdown", async () => {
    const directory = await Deno.makeTempDir({ prefix: "dream-proof-server-" });
    const toasts: string[] = [];
    const logs: string[] = [];
    const registrations: Array<{
      name: string;
      run: () => void | Promise<void>;
    }> = [];

    try {
      const plugin = createDetachedDreamProofPlugin({
        host: "server",
        waitMs: 0,
        registerRuntimeTeardown: (tasks) => {
          registrations.push(...tasks);
          return {
            run: async () => {
              for (const task of tasks) await task.run();
            },
            dispose: () => {},
          };
        },
      });

      const hooks = await plugin({
        client: {
          tui: {
            showToast: ({ body }: { body: { message: string } }) => {
              toasts.push(body.message);
            },
          },
          app: {
            log: ({ body }: { body: { message: string } }) => {
              logs.push(body.message);
            },
          },
        } as never,
        directory,
      } as never);

      assertEquals(registrations.length, 0);

      const result = await hooks.tool!.detached_dream_proof_server.execute(
        {},
        {} as never,
      );
      assertStringIncludes(
        String(result),
        "Detached dream proof for server armed",
      );

      assertEquals(registrations.length, 1);
      assertEquals(registrations[0].name, "detached_dream_proof_server");

      await registrations[0].run();

      const artifact = await readJson(
        `${directory}/.opencode-detached-dream-proof-server.json`,
      );
      assertEquals(artifact.proof, "detached_dream_proof_server");
      assertEquals(artifact.host, "server");
      assertEquals(artifact.wait_ms, 0);
      assertEquals(toasts.length, 2);
      assertStringIncludes(
        toasts[0],
        "Gracefully exit the server/web/serve host",
      );
      assertStringIncludes(toasts[1], "waiting about 0 seconds");
      assertEquals(logs.length, 1);
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  });

  it("keeps the default proof wait at ten seconds", () => {
    assertEquals(PROOF_WAIT_MS, 10_000);
  });

  it("returns already-armed message on second tool invocation", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "dream-proof-rearm-",
    });

    try {
      const plugin = createDetachedDreamProofPlugin({
        host: "tui",
        waitMs: 0,
        registerRuntimeTeardown: () => ({
          run: () => Promise.resolve(),
          dispose: () => {},
        }),
      });

      const hooks = await plugin({
        client: {
          tui: { showToast: () => {} },
          app: { log: () => {} },
        } as never,
        directory,
      } as never);

      await hooks.tool!.detached_dream_proof_tui.execute({}, {} as never);
      const result = await hooks.tool!.detached_dream_proof_tui.execute(
        {},
        {} as never,
      );
      assertStringIncludes(
        String(result),
        "Detached dream proof for tui already armed",
      );
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => undefined);
    }
  });
});
