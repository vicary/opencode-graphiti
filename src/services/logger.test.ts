import { assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "jsr:@std/testing@^1.0.0/bdd";
import { stub } from "jsr:@std/testing@^1.0.0/mock";
import {
  setOpenCodeClient,
  setSuppressConsoleWarningsDuringTestsOverride,
  setWarningTaskScheduler,
} from "./opencode-warning.ts";
import { setLoggerDebugOverride, setLoggerSilentOverride } from "./logger.ts";

describe("logger", () => {
  // deno-lint-ignore no-explicit-any
  let consoleLogSpy: any;
  // deno-lint-ignore no-explicit-any
  let consoleWarnSpy: any;
  // deno-lint-ignore no-explicit-any
  let consoleErrorSpy: any;
  // deno-lint-ignore no-explicit-any
  let consoleDebugSpy: any;

  beforeEach(() => {
    consoleLogSpy = stub(console, "log", () => {});
    consoleWarnSpy = stub(console, "warn", () => {});
    consoleErrorSpy = stub(console, "error", () => {});
    consoleDebugSpy = stub(console, "debug", () => {});
  });

  afterEach(() => {
    consoleLogSpy.restore();
    consoleWarnSpy.restore();
    consoleErrorSpy.restore();
    consoleDebugSpy.restore();
    setLoggerDebugOverride(undefined);
    setLoggerSilentOverride(false);
    setSuppressConsoleWarningsDuringTestsOverride(undefined);
    setOpenCodeClient(undefined);
    setWarningTaskScheduler(undefined);
  });

  describe("when GRAPHITI_DEBUG is set", () => {
    beforeEach(() => {
      setLoggerDebugOverride(true);
    });

    it("should log info messages with [graphiti] prefix", async () => {
      const { logger } = await import("./logger.ts");
      logger.info("test message");
      assertEquals(consoleLogSpy.calls.length, 1);
      assertEquals(consoleLogSpy.calls[0].args, ["[graphiti]", "test message"]);
    });

    it("should log warn messages with [graphiti] prefix", async () => {
      setSuppressConsoleWarningsDuringTestsOverride(false);
      const { logger } = await import("./logger.ts");
      logger.warn("warning message");
      assertEquals(consoleWarnSpy.calls.length, 1);
      assertEquals(consoleWarnSpy.calls[0].args, [
        "[graphiti]",
        "warning message",
      ]);
    });

    it("should log error messages with [graphiti] prefix", async () => {
      const { logger } = await import("./logger.ts");
      logger.error("error message");
      assertEquals(consoleErrorSpy.calls.length, 1);
      assertEquals(consoleErrorSpy.calls[0].args, [
        "[graphiti]",
        "error message",
      ]);
    });

    it("should log debug messages with [graphiti] prefix", async () => {
      const { logger } = await import("./logger.ts");
      logger.debug("debug message");
      assertEquals(consoleDebugSpy.calls.length, 1);
      assertEquals(consoleDebugSpy.calls[0].args, [
        "[graphiti]",
        "debug message",
      ]);
    });

    it("should forward multiple arguments to info", async () => {
      const { logger } = await import("./logger.ts");
      logger.info("message", 123, { key: "value" });
      assertEquals(consoleLogSpy.calls.length, 1);
      assertEquals(consoleLogSpy.calls[0].args, [
        "[graphiti]",
        "message",
        123,
        { key: "value" },
      ]);
    });

    it("should forward multiple arguments to warn", async () => {
      setSuppressConsoleWarningsDuringTestsOverride(false);
      const { logger } = await import("./logger.ts");
      logger.warn("warning", { code: 42 }, ["array"]);
      assertEquals(consoleWarnSpy.calls.length, 1);
      assertEquals(consoleWarnSpy.calls[0].args, [
        "[graphiti]",
        "warning",
        { code: 42 },
        ["array"],
      ]);
    });

    it("should use structured app logging for warn when client is available", async () => {
      const appLogCalls: unknown[] = [];
      const scheduledTasks: Array<() => void> = [];
      setWarningTaskScheduler((callback) => {
        scheduledTasks.push(callback);
      });
      setOpenCodeClient({
        app: {
          log: (input: unknown) => {
            appLogCalls.push(input);
          },
        },
      });

      const { logger } = await import("./logger.ts");
      logger.warn("warning", { code: 42 }, ["array"]);

      assertEquals(appLogCalls.length, 0);
      assertEquals(consoleWarnSpy.calls.length, 0);
      assertEquals(scheduledTasks.length, 1);
      for (const task of scheduledTasks) task();
      assertEquals(appLogCalls, [{
        body: {
          service: "graphiti",
          level: "warn",
          message: "warning",
          extra: {
            data: [{ code: 42 }, ["array"]],
          },
        },
      }]);
    });

    it("falls back to console.warn when structured warn logging rejects later", async () => {
      setSuppressConsoleWarningsDuringTestsOverride(false);
      const scheduledTasks: Array<() => void> = [];
      setWarningTaskScheduler((callback) => {
        scheduledTasks.push(callback);
      });
      setOpenCodeClient({
        app: {
          log: () => Promise.reject(new Error("structured warn failed")),
        },
      });

      const { logger } = await import("./logger.ts");
      logger.warn("warning", { code: 42 });

      assertEquals(consoleWarnSpy.calls.length, 0);
      assertEquals(scheduledTasks.length, 1);
      for (const task of scheduledTasks) task();
      await Promise.resolve();
      assertEquals(consoleWarnSpy.calls.length, 1);
      assertEquals(consoleWarnSpy.calls[0].args[0], "[graphiti]");
      assertEquals(consoleWarnSpy.calls[0].args[1], "warning");
      assertEquals(consoleWarnSpy.calls[0].args[2], {
        data: [{ code: 42 }],
      });
    });

    it("falls back to console.warn when structured warn scheduling throws", async () => {
      setSuppressConsoleWarningsDuringTestsOverride(false);
      setWarningTaskScheduler(() => {
        throw new Error("schedule failed");
      });
      setOpenCodeClient({
        app: {
          log: () => Promise.resolve(),
        },
      });

      const { logger } = await import("./logger.ts");
      logger.warn("warning", { code: 42 });

      assertEquals(consoleWarnSpy.calls.length, 1);
      assertEquals(consoleWarnSpy.calls[0].args, [
        "[graphiti]",
        "warning",
        { code: 42 },
      ]);
    });

    it("should forward multiple arguments to error", async () => {
      const { logger } = await import("./logger.ts");
      const error = new Error("test");
      logger.error("error occurred", error);
      assertEquals(consoleErrorSpy.calls.length, 1);
      assertEquals(consoleErrorSpy.calls[0].args, [
        "[graphiti]",
        "error occurred",
        error,
      ]);
    });

    it("should forward multiple arguments to debug", async () => {
      const { logger } = await import("./logger.ts");
      logger.debug("debug", 1, 2, 3);
      assertEquals(consoleDebugSpy.calls.length, 1);
      assertEquals(consoleDebugSpy.calls[0].args, [
        "[graphiti]",
        "debug",
        1,
        2,
        3,
      ]);
    });
  });

  describe("when GRAPHITI_DEBUG is NOT set", () => {
    beforeEach(() => {
      setLoggerDebugOverride(false);
    });

    it("should not log info messages", async () => {
      const { logger } = await import("./logger.ts");
      logger.info("test message");
      assertEquals(consoleLogSpy.calls.length, 0);
    });

    it("warn always emits regardless of GRAPHITI_DEBUG", async () => {
      setSuppressConsoleWarningsDuringTestsOverride(false);
      const { logger } = await import("./logger.ts");
      logger.warn("warning message");
      assertEquals(consoleWarnSpy.calls.length, 1);
      assertEquals(consoleWarnSpy.calls[0].args, [
        "[graphiti]",
        "warning message",
      ]);
    });

    it("warn falls back to console when no client is available", async () => {
      setSuppressConsoleWarningsDuringTestsOverride(false);
      const { logger } = await import("./logger.ts");
      logger.warn("warning message");
      assertEquals(consoleWarnSpy.calls.length, 1);
    });

    it("warn still emits error payloads when debug is disabled", async () => {
      setSuppressConsoleWarningsDuringTestsOverride(false);
      const { logger } = await import("./logger.ts");
      const err = new Error("background failure");
      logger.warn("warning message", err);
      assertEquals(consoleWarnSpy.calls.length, 1);
      assertEquals(consoleWarnSpy.calls[0].args, [
        "[graphiti]",
        "warning message",
        err,
      ]);
    });

    it("error always emits regardless of GRAPHITI_DEBUG", async () => {
      const { logger } = await import("./logger.ts");
      logger.error("error message");
      assertEquals(consoleErrorSpy.calls.length, 1);
      assertEquals(consoleErrorSpy.calls[0].args, [
        "[graphiti]",
        "error message",
      ]);
    });

    it("should not log debug messages", async () => {
      const { logger } = await import("./logger.ts");
      logger.debug("debug message");
      assertEquals(consoleDebugSpy.calls.length, 0);
    });

    it("info and debug suppressed; warn and error always emit", async () => {
      setSuppressConsoleWarningsDuringTestsOverride(false);
      const { logger } = await import("./logger.ts");
      const err = new Error("test");
      logger.info("message", 123, { key: "value" });
      logger.warn("warning", { code: 42 });
      logger.error("error", err);
      logger.debug("debug", 1, 2, 3);
      // info suppressed
      assertEquals(consoleLogSpy.calls.length, 0);
      // debug suppressed
      assertEquals(consoleDebugSpy.calls.length, 0);
      // warn always emits
      assertEquals(consoleWarnSpy.calls.length, 1);
      assertEquals(consoleWarnSpy.calls[0].args, [
        "[graphiti]",
        "warning",
        { code: 42 },
      ]);
      // error always emits
      assertEquals(consoleErrorSpy.calls.length, 1);
      assertEquals(consoleErrorSpy.calls[0].args, [
        "[graphiti]",
        "error",
        err,
      ]);
    });
  });

  describe("when GRAPHITI_DEBUG is set to empty string", () => {
    beforeEach(() => {
      setLoggerDebugOverride(false);
    });

    it("should not log info when set to empty string", async () => {
      const { logger } = await import("./logger.ts");
      logger.info("test");
      assertEquals(consoleLogSpy.calls.length, 0);
    });

    it("warn still emits when GRAPHITI_DEBUG is empty string", async () => {
      setSuppressConsoleWarningsDuringTestsOverride(false);
      const { logger } = await import("./logger.ts");
      logger.warn("alert");
      assertEquals(consoleWarnSpy.calls.length, 1);
    });

    it("error still emits when GRAPHITI_DEBUG is empty string", async () => {
      const { logger } = await import("./logger.ts");
      logger.error("boom");
      assertEquals(consoleErrorSpy.calls.length, 1);
    });
  });

  describe("PREFIX constant", () => {
    it("should use [graphiti] as prefix", async () => {
      setLoggerDebugOverride(true);
      const { logger } = await import("./logger.ts");
      logger.info("test");
      assertEquals(consoleLogSpy.calls[0].args[0], "[graphiti]");
    });
  });
});
