import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { logger } from "./logger.ts";
import { registerRuntimeTeardown } from "./runtime-teardown.ts";

const runtimeTeardownModuleUrl = new URL(
  "./runtime-teardown.ts",
  import.meta.url,
).href;

const writeRuntimeTeardownScript = async (source: string): Promise<string> => {
  const scriptPath = await Deno.makeTempFile({
    prefix: "runtime-teardown-",
    suffix: ".ts",
  });
  await Deno.writeTextFile(scriptPath, source);
  return scriptPath;
};

const cleanupTempScript = async (scriptPath: string): Promise<void> => {
  await Deno.remove(scriptPath).catch(() => undefined);
};

describe("runtime teardown", () => {
  it("runs teardown tasks only once even when invoked repeatedly", async () => {
    const calls: string[] = [];
    const registration = registerRuntimeTeardown([
      { name: "redis", run: () => void calls.push("redis") },
      { name: "graphiti", run: () => void calls.push("graphiti") },
    ], {});

    await Promise.all([
      registration.run(),
      registration.run(),
      registration.run(),
    ]);

    assertEquals(calls, ["redis", "graphiti"]);
  });

  it("registers best-effort unload and signal handlers that share the same idempotent path", async () => {
    const eventHandlers = new Map<string, () => void>();
    const signalHandlers = new Map<"SIGINT" | "SIGTERM", () => void>();
    const removedEventHandlers: string[] = [];
    const removedSignalHandlers: Array<"SIGINT" | "SIGTERM"> = [];
    const calls: string[] = [];
    const registration = registerRuntimeTeardown([
      {
        name: "runtime",
        run: () => {
          calls.push("runtime");
        },
      },
    ], {
      addEventListener(type, listener) {
        eventHandlers.set(type, listener as () => void);
      },
      removeEventListener(type) {
        removedEventHandlers.push(type);
        eventHandlers.delete(type);
      },
      Deno: {
        addSignalListener(signal, handler) {
          signalHandlers.set(signal, handler);
        },
        removeSignalListener(signal) {
          removedSignalHandlers.push(signal);
          signalHandlers.delete(signal);
        },
      },
    });

    assertEquals([...eventHandlers.keys()].sort(), ["beforeunload", "unload"]);
    assertEquals([...signalHandlers.keys()].sort(), ["SIGINT", "SIGTERM"]);

    eventHandlers.get("unload")?.();
    signalHandlers.get("SIGINT")?.();
    await registration.run();

    assertEquals(calls, ["runtime"]);
    assertEquals(removedEventHandlers.sort(), ["beforeunload", "unload"]);
    assertEquals(removedSignalHandlers.sort(), ["SIGINT", "SIGTERM"]);
    assertEquals(eventHandlers.size, 0);
    assertEquals(signalHandlers.size, 0);
  });

  it("keeps signal listeners active while graceful shutdown is running from a signal", async () => {
    const signalHandlers = new Map<"SIGINT" | "SIGTERM", () => void>();
    const removedSignalHandlers: Array<"SIGINT" | "SIGTERM"> = [];
    let releaseTask!: () => void;
    const taskFinished = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    let exitReject!: (reason?: unknown) => void;
    const exitPromise = new Promise<never>((_, reject) => {
      exitReject = reject;
    });

    registerRuntimeTeardown([
      {
        name: "flush",
        run: () => taskFinished,
      },
    ], {
      Deno: {
        addSignalListener(signal, handler) {
          signalHandlers.set(signal, handler);
        },
        removeSignalListener(signal) {
          removedSignalHandlers.push(signal);
          signalHandlers.delete(signal);
        },
        exit(code) {
          exitReject(new Error(`exit:${code ?? 0}`));
          return undefined as never;
        },
      },
    });

    signalHandlers.get("SIGINT")?.();

    assertEquals([...signalHandlers.keys()].sort(), ["SIGINT", "SIGTERM"]);
    assertEquals(removedSignalHandlers, []);

    releaseTask();
    await assertRejects(
      async () => {
        await exitPromise;
      },
      Error,
      "exit:130",
    );

    assertEquals(removedSignalHandlers.sort(), ["SIGINT", "SIGTERM"]);
  });

  it("removes signal listeners when graceful shutdown starts from unload", async () => {
    const eventHandlers = new Map<string, () => void>();
    const signalHandlers = new Map<"SIGINT" | "SIGTERM", () => void>();
    const removedSignalHandlers: Array<"SIGINT" | "SIGTERM"> = [];
    let releaseTask!: () => void;
    const taskFinished = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });

    const registration = registerRuntimeTeardown([
      {
        name: "flush",
        run: () => taskFinished,
      },
    ], {
      addEventListener(type, listener) {
        eventHandlers.set(type, listener as () => void);
      },
      removeEventListener(type) {
        eventHandlers.delete(type);
      },
      Deno: {
        addSignalListener(signal, handler) {
          signalHandlers.set(signal, handler);
        },
        removeSignalListener(signal) {
          removedSignalHandlers.push(signal);
          signalHandlers.delete(signal);
        },
      },
    });

    eventHandlers.get("unload")?.();

    assertEquals(signalHandlers.size, 0);
    assertEquals(removedSignalHandlers.sort(), ["SIGINT", "SIGTERM"]);

    releaseTask();
    await registration.run();
  });

  it("registers one listener set per registration and keeps them independent", () => {
    const eventHandlers = new Map<string, Set<() => void>>();
    const signalHandlers = new Map<"SIGINT" | "SIGTERM", Set<() => void>>();

    const runtime = {
      addEventListener(type: string, listener: (event?: Event) => void) {
        const handlers = eventHandlers.get(type) ?? new Set<() => void>();
        handlers.add(listener as () => void);
        eventHandlers.set(type, handlers);
      },
      removeEventListener(type: string, listener: (event?: Event) => void) {
        eventHandlers.get(type)?.delete(listener as () => void);
      },
      Deno: {
        addSignalListener(signal: "SIGINT" | "SIGTERM", handler: () => void) {
          const handlers = signalHandlers.get(signal) ?? new Set<() => void>();
          handlers.add(handler);
          signalHandlers.set(signal, handlers);
        },
        removeSignalListener(
          signal: "SIGINT" | "SIGTERM",
          handler: () => void,
        ) {
          signalHandlers.get(signal)?.delete(handler);
        },
      },
    };

    const firstRegistration = registerRuntimeTeardown([], runtime);
    const secondRegistration = registerRuntimeTeardown([], runtime);

    assertEquals(firstRegistration === secondRegistration, false);
    assertEquals(
      [...eventHandlers.values()].map((handlers) => handlers.size),
      [2, 2],
    );
    assertEquals(
      [...signalHandlers.values()].map((handlers) => handlers.size),
      [2, 2],
    );

    firstRegistration.dispose();

    assertEquals(
      [...eventHandlers.values()].map((handlers) => handlers.size),
      [1, 1],
    );
    assertEquals(
      [...signalHandlers.values()].map((handlers) => handlers.size),
      [1, 1],
    );

    secondRegistration.dispose();

    assertEquals(
      [...eventHandlers.values()].map((handlers) => handlers.size),
      [0, 0],
    );
    assertEquals(
      [...signalHandlers.values()].map((handlers) => handlers.size),
      [0, 0],
    );
  });

  it("registers process signal handlers for node-style runtimes", () => {
    const processHandlers = new Map<string, Set<() => void>>();

    const runtime = {
      process: {
        on(event: string, handler: () => void) {
          const handlers = processHandlers.get(event) ?? new Set<() => void>();
          handlers.add(handler);
          processHandlers.set(event, handlers);
        },
        off(event: string, handler: () => void) {
          processHandlers.get(event)?.delete(handler);
        },
      },
    };

    const registration = registerRuntimeTeardown([], runtime);

    assertEquals(
      [...processHandlers.keys()].sort(),
      ["SIGINT", "SIGTERM", "beforeExit", "exit"],
    );

    registration.dispose();

    assertEquals(
      [...processHandlers.values()].map((handlers) => handlers.size),
      [0, 0, 0, 0],
    );
  });

  it("keeps multiple runtime registrations active until each is disposed", () => {
    const eventHandlers = new Map<string, Set<() => void>>();
    const signalHandlers = new Map<"SIGINT" | "SIGTERM", Set<() => void>>();

    const runtime = {
      addEventListener(type: string, listener: (event?: Event) => void) {
        const handlers = eventHandlers.get(type) ?? new Set<() => void>();
        handlers.add(listener as () => void);
        eventHandlers.set(type, handlers);
      },
      removeEventListener(type: string, listener: (event?: Event) => void) {
        eventHandlers.get(type)?.delete(listener as () => void);
      },
      Deno: {
        addSignalListener(signal: "SIGINT" | "SIGTERM", handler: () => void) {
          const handlers = signalHandlers.get(signal) ?? new Set<() => void>();
          handlers.add(handler);
          signalHandlers.set(signal, handlers);
        },
        removeSignalListener(
          signal: "SIGINT" | "SIGTERM",
          handler: () => void,
        ) {
          signalHandlers.get(signal)?.delete(handler);
        },
      },
    };

    const firstRegistration = registerRuntimeTeardown([], runtime);
    const secondRegistration = registerRuntimeTeardown([], runtime);

    assertEquals(
      [...eventHandlers.values()].map((handlers) => handlers.size),
      [2, 2],
    );
    assertEquals(
      [...signalHandlers.values()].map((handlers) => handlers.size),
      [2, 2],
    );

    firstRegistration.dispose();

    assertEquals(
      [...eventHandlers.values()].map((handlers) => handlers.size),
      [1, 1],
    );
    assertEquals(
      [...signalHandlers.values()].map((handlers) => handlers.size),
      [1, 1],
    );

    secondRegistration.dispose();

    assertEquals(
      [...eventHandlers.values()].map((handlers) => handlers.size),
      [0, 0],
    );
    assertEquals(
      [...signalHandlers.values()].map((handlers) => handlers.size),
      [0, 0],
    );
  });

  it("continues teardown after a task failure", async () => {
    const warnings: unknown[] = [];
    const originalWarn = logger.warn;
    logger.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      const calls: string[] = [];
      const registration = registerRuntimeTeardown([
        {
          name: "redis",
          run: () => {
            calls.push("redis");
            throw new Error("boom");
          },
        },
        {
          name: "graphiti",
          run: () => {
            calls.push("graphiti");
          },
        },
      ], {});

      await registration.run();

      assertEquals(calls, ["redis", "graphiti"]);
      assertEquals(warnings.length, 1);
    } finally {
      logger.warn = originalWarn;
    }
  });

  it("keeps signal listeners active during graceful SIGINT teardown so a second Ctrl+C can force exit", async () => {
    const signalHandlers = new Map<"SIGINT" | "SIGTERM", () => void>();
    const removedSignalHandlers: Array<"SIGINT" | "SIGTERM"> = [];
    const warnings: unknown[][] = [];
    const exitCalls: number[] = [];
    let resolveTask!: () => void;
    const taskStarted = new Promise<void>((resolve) => {
      resolveTask = resolve;
    });
    let releaseTask!: () => void;
    const taskFinished = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    let exitReject!: (reason?: unknown) => void;
    const exitPromise = new Promise<never>((_, reject) => {
      exitReject = reject;
    });
    const originalWarn = logger.warn;
    logger.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      registerRuntimeTeardown([
        {
          name: "graphiti-drain",
          run: async () => {
            resolveTask();
            await taskFinished;
          },
        },
      ], {
        Deno: {
          addSignalListener(signal, handler) {
            signalHandlers.set(signal, handler);
          },
          removeSignalListener(signal) {
            removedSignalHandlers.push(signal);
            signalHandlers.delete(signal);
          },
          exit(code) {
            exitCalls.push(code ?? 0);
            exitReject(new Error(`exit:${code ?? 0}`));
            return undefined as never;
          },
        },
      });

      signalHandlers.get("SIGINT")?.();
      await taskStarted;

      assertEquals([...signalHandlers.keys()].sort(), ["SIGINT", "SIGTERM"]);
      assertEquals(warnings.length, 1);
      assertEquals(
        warnings[0][0],
        "Graceful shutdown in progress; waiting for pending memory flush. Press Ctrl+C again to exit immediately and drop pending memories.",
      );

      signalHandlers.get("SIGINT")?.();
      await assertRejects(async () => await exitPromise, Error, "exit:130");

      assertEquals(exitCalls, [130]);
      assertEquals(warnings.length, 2);
      assertEquals(
        warnings[1][0],
        "Forced shutdown requested; exiting immediately and dropping pending memories.",
      );
      assertEquals(removedSignalHandlers.sort(), ["SIGINT", "SIGTERM"]);

      releaseTask();
    } finally {
      logger.warn = originalWarn;
    }
  });

  it("exits after graceful teardown completes on first SIGINT", async () => {
    const signalHandlers = new Map<"SIGINT" | "SIGTERM", () => void>();
    const removedSignalHandlers: Array<"SIGINT" | "SIGTERM"> = [];
    const exitCalls: number[] = [];
    const warnings: unknown[][] = [];
    let exitReject!: (reason?: unknown) => void;
    const exitPromise = new Promise<never>((_, reject) => {
      exitReject = reject;
    });
    const originalWarn = logger.warn;
    logger.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      registerRuntimeTeardown([
        {
          name: "redis",
          run: () => Promise.resolve(),
        },
      ], {
        Deno: {
          addSignalListener(signal, handler) {
            signalHandlers.set(signal, handler);
          },
          removeSignalListener(signal) {
            removedSignalHandlers.push(signal);
            signalHandlers.delete(signal);
          },
          exit(code) {
            exitCalls.push(code ?? 0);
            exitReject(new Error(`exit:${code ?? 0}`));
            return undefined as never;
          },
        },
      });

      await assertRejects(
        async () => {
          signalHandlers.get("SIGINT")?.();
          await exitPromise;
        },
        Error,
        "exit:130",
      );

      assertEquals(exitCalls, [130]);
      assertEquals(warnings.length, 1);
      assertEquals(removedSignalHandlers.sort(), ["SIGINT", "SIGTERM"]);
      assertEquals(signalHandlers.size, 0);
    } finally {
      logger.warn = originalWarn;
    }
  });

  it("forces process exit after graceful SIGINT teardown completes in node-style runtimes", async () => {
    const signalHandlers = new Map<"SIGINT" | "SIGTERM", () => void>();
    const warnings: unknown[][] = [];
    const exitCalls: number[] = [];
    let exitReject!: (reason?: unknown) => void;
    const exitPromise = new Promise<never>((_, reject) => {
      exitReject = reject;
    });
    const originalWarn = logger.warn;
    logger.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      registerRuntimeTeardown([
        {
          name: "redis",
          run: () => Promise.resolve(),
        },
      ], {
        process: {
          on(event: string, handler: () => void) {
            if (event === "SIGINT" || event === "SIGTERM") {
              signalHandlers.set(event, handler);
            }
          },
          off(event: string, _handler: () => void) {
            if (event === "SIGINT" || event === "SIGTERM") {
              signalHandlers.delete(event);
            }
          },
          exit(code?: number) {
            exitCalls.push(code ?? 0);
            exitReject(new Error(`exit:${code ?? 0}`));
            return undefined as never;
          },
          exitCode: undefined,
        } as unknown as {
          on?: (event: string, handler: () => void) => void;
          off?: (event: string, handler: () => void) => void;
          exitCode?: number;
        },
      });

      await assertRejects(
        async () => {
          signalHandlers.get("SIGINT")?.();
          await exitPromise;
        },
        Error,
        "exit:130",
      );

      assertEquals(exitCalls, [130]);
      assertEquals(warnings.length, 1);
    } finally {
      logger.warn = originalWarn;
    }
  });

  it("waits for registered teardown completion before exiting after SIGINT in a live runtime", async () => {
    const teardownDelayMs = 150;
    const scriptPath = await writeRuntimeTeardownScript(`
import { registerRuntimeTeardown } from ${
      JSON.stringify(runtimeTeardownModuleUrl)
    };

registerRuntimeTeardown([
  {
    name: "proof",
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, ${teardownDelayMs}));
      console.log("teardown-run");
    },
  },
]);

console.log("ready");
setInterval(() => {}, 1_000);
`);

    try {
      const child = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", scriptPath],
        stdout: "piped",
        stderr: "piped",
      }).spawn();

      // Wait for the child to signal it is ready before sending SIGINT so that
      // the signal handler is guaranteed to be registered.
      const decoder = new TextDecoder();
      const stdoutChunks: Uint8Array[] = [];
      const stdoutReader = child.stdout.getReader();
      let accumulated = "";
      while (!accumulated.includes("ready")) {
        const { value, done } = await stdoutReader.read();
        if (done) break;
        stdoutChunks.push(value);
        accumulated += decoder.decode(value, { stream: true });
      }
      stdoutReader.releaseLock();

      const shutdownStartedAt = Date.now();
      child.kill("SIGINT");

      // Drain remaining stdout and stderr after the kill.
      const [remainingStdout, stderrBytes] = await Promise.all([
        (async () => {
          const remaining: Uint8Array[] = [];
          const reader = child.stdout.getReader();
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              remaining.push(value);
            }
          } finally {
            reader.releaseLock();
          }
          return remaining;
        })(),
        (async () => {
          const chunks: Uint8Array[] = [];
          const reader = child.stderr.getReader();
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
          } finally {
            reader.releaseLock();
          }
          return chunks;
        })(),
      ]);

      const { code } = await child.status;
      const elapsedMs = Date.now() - shutdownStartedAt;

      const allStdout = [...stdoutChunks, ...remainingStdout];
      const totalLen = allStdout.reduce((n, c) => n + c.length, 0);
      const merged = new Uint8Array(totalLen);
      let off = 0;
      for (const chunk of allStdout) {
        merged.set(chunk, off);
        off += chunk.length;
      }
      const output = decoder.decode(merged);
      const stderrMergedLen = stderrBytes.reduce((n, c) => n + c.length, 0);
      const stderrMerged = new Uint8Array(stderrMergedLen);
      let sOff = 0;
      for (const chunk of stderrBytes) {
        stderrMerged.set(chunk, sOff);
        sOff += chunk.length;
      }
      const errorOutput = decoder.decode(stderrMerged);

      assertEquals(code, 130);
      assert(output.includes("ready"));
      assert(output.includes("teardown-run"));
      assert(
        elapsedMs >= teardownDelayMs - 25,
        `expected SIGINT shutdown to wait about ${teardownDelayMs}ms, got ${elapsedMs}ms\nstdout:\n${output}\nstderr:\n${errorOutput}`,
      );
    } finally {
      await cleanupTempScript(scriptPath);
    }
  });

  it("waits for registered teardown completion on the beforeExit path in a live node-style runtime", async () => {
    const teardownDelayMs = 150;
    const scriptPath = await writeRuntimeTeardownScript(`
import process from "node:process";
import { registerRuntimeTeardown } from ${
      JSON.stringify(runtimeTeardownModuleUrl)
    };

registerRuntimeTeardown([
  {
    name: "proof",
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, ${teardownDelayMs}));
      console.log("teardown-run");
    },
  },
], { process });

console.log("ready");
`);

    try {
      const startedAt = Date.now();
      const { code, signal, stdout, stderr } = await new Deno.Command(
        Deno.execPath(),
        {
          args: ["run", "-A", scriptPath],
          stdout: "piped",
          stderr: "piped",
        },
      ).output();
      const elapsedMs = Date.now() - startedAt;
      const output = new TextDecoder().decode(stdout);
      const errorOutput = new TextDecoder().decode(stderr);

      assertEquals(code, 0);
      assertEquals(signal, null);
      assert(output.includes("ready"));
      assert(output.includes("teardown-run"));
      assert(
        elapsedMs >= teardownDelayMs - 25,
        `expected beforeExit shutdown to wait about ${teardownDelayMs}ms, got ${elapsedMs}ms\nstdout:\n${output}\nstderr:\n${errorOutput}`,
      );
    } finally {
      await cleanupTempScript(scriptPath);
    }
  });
});
