import { assertEquals } from "jsr:@std/assert@^1.0.0";
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
      Deno: {
        addSignalListener(signal, handler) {
          signalHandlers.set(signal, handler);
        },
      },
    });

    assertEquals([...eventHandlers.keys()].sort(), ["beforeunload", "unload"]);
    assertEquals([...signalHandlers.keys()].sort(), ["SIGINT", "SIGTERM"]);

    eventHandlers.get("unload")?.();
    signalHandlers.get("SIGINT")?.();
    await registration.run();

    assertEquals(calls, ["runtime"]);
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
});
