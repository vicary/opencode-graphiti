import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "jsr:@std/assert@^1.0.0";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "jsr:@std/testing@^1.0.0/bdd";
import { stub } from "jsr:@std/testing@^1.0.0/mock";
import {
  notifyGraphitiAvailabilityIssue,
  setOpenCodeClient,
  setSuppressConsoleWarningsDuringTestsOverride,
  setWarningTaskScheduler,
  showWarningToast,
} from "./opencode-warning.ts";

describe("opencode warning delivery", () => {
  let consoleWarnSpy: {
    restore(): void;
    calls: Array<{ args: unknown[] }>;
  };

  beforeEach(() => {
    consoleWarnSpy = stub(console, "warn", () => {});
  });

  afterEach(() => {
    consoleWarnSpy.restore();
    setOpenCodeClient(undefined);
    setSuppressConsoleWarningsDuringTestsOverride(undefined);
    setWarningTaskScheduler(undefined);
  });

  it("suppresses fallback console warnings while running inside tests", () => {
    setSuppressConsoleWarningsDuringTestsOverride(undefined);

    notifyGraphitiAvailabilityIssue("warning message", {
      endpoint: "http://graphiti.test/mcp",
    });

    assertEquals(consoleWarnSpy.calls.length, 0);
  });

  it("can re-enable fallback console warnings explicitly", () => {
    setSuppressConsoleWarningsDuringTestsOverride(false);

    notifyGraphitiAvailabilityIssue("warning message", {
      endpoint: "http://graphiti.test/mcp",
    });

    assertEquals(consoleWarnSpy.calls.length, 1);
    assertEquals(consoleWarnSpy.calls[0].args[0], "[graphiti]");
    assertEquals(consoleWarnSpy.calls[0].args[1], "warning message");
  });

  it("reports scheduled async toast dispatch immediately", async () => {
    const toastCalls: unknown[] = [];
    const scheduledTasks: Array<() => void> = [];
    setWarningTaskScheduler((callback) => {
      scheduledTasks.push(callback);
    });
    setOpenCodeClient({
      tui: {
        showToast: (input: unknown) => {
          toastCalls.push(input);
          return Promise.resolve();
        },
      },
    });

    const delivered = showWarningToast("warning message");

    assertEquals(delivered, true);
    assertEquals(toastCalls.length, 0);
    assertEquals(scheduledTasks.length, 1);

    scheduledTasks[0]();
    await Promise.resolve();

    assertEquals(toastCalls, [{
      body: {
        message: "warning message",
        variant: "warning",
      },
    }]);
    assertEquals(consoleWarnSpy.calls.length, 0);
  });

  it("falls back to console.warn when toast dispatch rejects", async () => {
    setSuppressConsoleWarningsDuringTestsOverride(false);
    const scheduledTasks: Array<() => void> = [];
    const error = new Error("toast rejected");
    setWarningTaskScheduler((callback) => {
      scheduledTasks.push(callback);
    });
    setOpenCodeClient({
      app: {
        log: () => undefined,
      },
      tui: {
        showToast: () => Promise.reject(error),
      },
    });

    notifyGraphitiAvailabilityIssue("warning message", {
      endpoint: "http://graphiti.test/mcp",
    });

    assertEquals(consoleWarnSpy.calls.length, 0);
    assertEquals(scheduledTasks.length, 2);

    for (const task of scheduledTasks) task();
    await Promise.resolve();
    await Promise.resolve();

    assertEquals(consoleWarnSpy.calls.length, 1);
    assertEquals(consoleWarnSpy.calls[0].args[0], "[graphiti]");
    assertEquals(consoleWarnSpy.calls[0].args[1], "warning message");
    assertEquals(consoleWarnSpy.calls[0].args[2], {
      endpoint: "http://graphiti.test/mcp",
    });
    assertStrictEquals(consoleWarnSpy.calls[0].args[3], error);
  });

  it("falls back to console.warn when toast dispatch throws", () => {
    setSuppressConsoleWarningsDuringTestsOverride(false);
    const scheduledTasks: Array<() => void> = [];
    const error = new Error("toast threw");
    setWarningTaskScheduler((callback) => {
      scheduledTasks.push(callback);
    });
    setOpenCodeClient({
      app: {
        log: () => undefined,
      },
      tui: {
        showToast: () => {
          throw error;
        },
      },
    });

    notifyGraphitiAvailabilityIssue("warning message", {
      endpoint: "http://graphiti.test/mcp",
    });

    assertEquals(consoleWarnSpy.calls.length, 0);
    assertEquals(scheduledTasks.length, 2);

    for (const task of scheduledTasks) task();

    assertEquals(consoleWarnSpy.calls.length, 1);
    assertEquals(consoleWarnSpy.calls[0].args[0], "[graphiti]");
    assertEquals(consoleWarnSpy.calls[0].args[1], "warning message");
    assertEquals(consoleWarnSpy.calls[0].args[2], {
      endpoint: "http://graphiti.test/mcp",
    });
    assertStrictEquals(consoleWarnSpy.calls[0].args[3], error);
  });

  it("contains synchronous scheduler throws and falls back to console.warn", () => {
    setSuppressConsoleWarningsDuringTestsOverride(false);
    setWarningTaskScheduler(() => {
      throw new Error("schedule failed");
    });
    setOpenCodeClient({
      app: {
        log: () => undefined,
      },
      tui: {
        showToast: () => undefined,
      },
    });

    notifyGraphitiAvailabilityIssue("warning message", {
      endpoint: "http://graphiti.test/mcp",
    });

    assertEquals(consoleWarnSpy.calls.length, 1);
    assertEquals(consoleWarnSpy.calls[0].args, [
      "[graphiti]",
      "warning message",
      {
        endpoint: "http://graphiti.test/mcp",
      },
    ]);
  });

  it("does not let synchronous scheduler throws mask original caller failures", async () => {
    setWarningTaskScheduler(() => {
      throw new Error("schedule failed");
    });
    setOpenCodeClient({
      app: {
        log: () => undefined,
      },
    });

    const originalError = new Error("graphiti failed");

    const thrown = await assertRejects(() => {
      return Promise.reject(originalError).catch((err) => {
        notifyGraphitiAvailabilityIssue("warning message", {
          operation: "addMemory",
          err,
        });
        throw err;
      });
    });

    assertStrictEquals(thrown, originalError);
  });
});
