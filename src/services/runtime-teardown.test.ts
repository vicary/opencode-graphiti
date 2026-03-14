import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { logger } from "./logger.ts";
import { registerRuntimeTeardown } from "./runtime-teardown.ts";

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

  it("removes signal listeners as soon as graceful shutdown starts from a signal", async () => {
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

    assertEquals(signalHandlers.size, 0);
    assertEquals(removedSignalHandlers.sort(), ["SIGINT", "SIGTERM"]);

    releaseTask();
    await assertRejects(
      async () => {
        await exitPromise;
      },
      Error,
      "exit:130",
    );
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

      assertEquals([...signalHandlers.keys()].sort(), []);
      assertEquals(warnings.length, 1);
      assertEquals(
        warnings[0][0],
        "Graceful shutdown in progress; waiting for pending memory flush. Press Ctrl+C again to exit immediately and drop pending memories.",
      );

      releaseTask();
      await assertRejects(async () => await exitPromise, Error, "exit:130");

      assertEquals(exitCalls, [130]);
      assertEquals(removedSignalHandlers.sort(), ["SIGINT", "SIGTERM"]);
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
});
