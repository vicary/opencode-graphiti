import { assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "jsr:@std/testing@^1.0.0/bdd";
import { spy } from "jsr:@std/testing@^1.0.0/mock";
import process from "node:process";

describe("logger", () => {
  const originalEnv = process.env.GRAPHITI_DEBUG;
  // deno-lint-ignore no-explicit-any
  let consoleLogSpy: any;
  // deno-lint-ignore no-explicit-any
  let consoleWarnSpy: any;
  // deno-lint-ignore no-explicit-any
  let consoleErrorSpy: any;
  // deno-lint-ignore no-explicit-any
  let consoleDebugSpy: any;

  beforeEach(() => {
    // Reset module cache by re-importing
    consoleLogSpy = spy(console, "log");
    consoleWarnSpy = spy(console, "warn");
    consoleErrorSpy = spy(console, "error");
    consoleDebugSpy = spy(console, "debug");
  });

  afterEach(() => {
    consoleLogSpy.restore();
    consoleWarnSpy.restore();
    consoleErrorSpy.restore();
    consoleDebugSpy.restore();
    if (originalEnv === undefined) {
      delete process.env.GRAPHITI_DEBUG;
    } else {
      process.env.GRAPHITI_DEBUG = originalEnv;
    }
  });

  describe("when GRAPHITI_DEBUG is set", () => {
    beforeEach(() => {
      process.env.GRAPHITI_DEBUG = "1";
    });

    it("should log info messages with [graphiti] prefix", async () => {
      const { logger } = await import("./logger.ts");
      logger.info("test message");
      assertEquals(consoleLogSpy.calls.length, 1);
      assertEquals(consoleLogSpy.calls[0].args, ["[graphiti]", "test message"]);
    });

    it("should log warn messages with [graphiti] prefix", async () => {
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
      assertEquals(consoleLogSpy.calls[0].args, ["[graphiti]", "message", 123, {
        key: "value",
      }]);
    });

    it("should forward multiple arguments to warn", async () => {
      const { logger } = await import("./logger.ts");
      logger.warn("warning", { code: 42 }, ["array"]);
      assertEquals(consoleWarnSpy.calls.length, 1);
      assertEquals(consoleWarnSpy.calls[0].args, ["[graphiti]", "warning", {
        code: 42,
      }, ["array"]]);
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
      delete process.env.GRAPHITI_DEBUG;
    });

    it("should not log info messages", async () => {
      const { logger } = await import("./logger.ts");
      logger.info("test message");
      assertEquals(consoleLogSpy.calls.length, 0);
    });

    it("should not log warn messages", async () => {
      const { logger } = await import("./logger.ts");
      logger.warn("warning message");
      assertEquals(consoleWarnSpy.calls.length, 0);
    });

    it("should not log error messages", async () => {
      const { logger } = await import("./logger.ts");
      logger.error("error message");
      assertEquals(consoleErrorSpy.calls.length, 0);
    });

    it("should not log debug messages", async () => {
      const { logger } = await import("./logger.ts");
      logger.debug("debug message");
      assertEquals(consoleDebugSpy.calls.length, 0);
    });

    it("should not log even with multiple arguments", async () => {
      const { logger } = await import("./logger.ts");
      logger.info("message", 123, { key: "value" });
      logger.warn("warning", { code: 42 });
      logger.error("error", new Error("test"));
      logger.debug("debug", 1, 2, 3);
      assertEquals(consoleLogSpy.calls.length, 0);
      assertEquals(consoleWarnSpy.calls.length, 0);
      assertEquals(consoleErrorSpy.calls.length, 0);
      assertEquals(consoleDebugSpy.calls.length, 0);
    });
  });

  describe("when GRAPHITI_DEBUG is set to empty string", () => {
    beforeEach(() => {
      process.env.GRAPHITI_DEBUG = "";
    });

    it("should not log when set to empty string", async () => {
      const { logger } = await import("./logger.ts");
      logger.info("test");
      assertEquals(consoleLogSpy.calls.length, 0);
    });
  });

  describe("PREFIX constant", () => {
    it("should use [graphiti] as prefix", async () => {
      process.env.GRAPHITI_DEBUG = "1";
      const { logger } = await import("./logger.ts");
      logger.info("test");
      assertEquals(consoleLogSpy.calls[0].args[0], "[graphiti]");
    });
  });
});
