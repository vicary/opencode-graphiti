import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { GraphitiOfflineError } from "./connection-manager.ts";
import { GraphitiMcpClient } from "./graphiti-mcp.ts";
import { setLoggerSilentOverride } from "./logger.ts";
import {
  setOpenCodeClient,
  setSuppressConsoleWarningsDuringTestsOverride,
  setWarningTaskScheduler,
} from "./opencode-warning.ts";

describe("GraphitiMcpClient", () => {
  it("connect rejects explicitly after stop", async () => {
    let stopped = false;
    const client = new GraphitiMcpClient({
      start() {
        if (stopped) {
          throw new GraphitiOfflineError(
            "stopped",
            "Graphiti connection manager has been stopped and cannot be restarted",
          );
        }
      },
      stop() {
        stopped = true;
        return Promise.resolve();
      },
      ready() {
        return Promise.resolve(!stopped);
      },
      callTool() {
        return Promise.resolve({});
      },
    });

    assertEquals(await client.connect(), true);
    await client.stop();

    const error = await assertRejects(
      () => client.connect(),
      GraphitiOfflineError,
    );

    assertEquals(error.state, "stopped");
  });

  it("marks unexpected search node failures as degraded", async () => {
    try {
      setLoggerSilentOverride(true);
      const client = new GraphitiMcpClient({
        start() {},
        stop() {
          return Promise.resolve();
        },
        ready() {
          return Promise.resolve(true);
        },
        callTool() {
          return Promise.reject(new Error("boom"));
        },
      });

      assertEquals(await client.searchNodesWithStatus({ query: "test" }), {
        nodes: [],
        degraded: true,
      });
    } finally {
      setLoggerSilentOverride(false);
    }
  });

  it("reports searchNodesWithStatus availability warnings with the correct operation name", async () => {
    const scheduledTasks: Array<() => void> = [];
    const appLogCalls: unknown[] = [];
    setSuppressConsoleWarningsDuringTestsOverride(true);
    setWarningTaskScheduler((callback) => {
      scheduledTasks.push(callback);
    });
    setOpenCodeClient({
      app: {
        log(input: unknown) {
          appLogCalls.push(input);
        },
      },
    });

    try {
      const client = new GraphitiMcpClient({
        start() {},
        stop() {
          return Promise.resolve();
        },
        ready() {
          return Promise.resolve(true);
        },
        callTool() {
          return Promise.reject(new GraphitiOfflineError("offline", "offline"));
        },
      });

      assertEquals(await client.searchNodesWithStatus({ query: "test" }), {
        nodes: [],
        degraded: true,
      });
      assertEquals(scheduledTasks.length, 1);
      assertEquals(appLogCalls.length, 0);
      for (const task of scheduledTasks) task();
      assertEquals(
        (appLogCalls[0] as { body: { extra: { operation: string } } }).body
          .extra.operation,
        "searchNodesWithStatus",
      );
      assertEquals(
        (appLogCalls[0] as { body: { message: string } }).body.message,
        "Graphiti MCP unavailable; continuing without memory nodes.",
      );
    } finally {
      setOpenCodeClient(undefined);
      setWarningTaskScheduler(undefined);
      setSuppressConsoleWarningsDuringTestsOverride(undefined);
    }
  });

  it("uses stable Graphiti MCP availability messages across degraded operations", async () => {
    const scheduledTasks: Array<() => void> = [];
    const appLogCalls: Array<
      { body: { message: string; extra?: { operation?: string } } }
    > = [];
    setSuppressConsoleWarningsDuringTestsOverride(true);
    setWarningTaskScheduler((callback) => {
      scheduledTasks.push(callback);
    });
    setOpenCodeClient({
      app: {
        log(input: unknown) {
          appLogCalls.push(
            input as {
              body: { message: string; extra?: { operation?: string } };
            },
          );
        },
      },
    });

    try {
      const client = new GraphitiMcpClient({
        start() {},
        stop() {
          return Promise.resolve();
        },
        ready() {
          return Promise.resolve(true);
        },
        callTool() {
          return Promise.reject(new GraphitiOfflineError("offline", "offline"));
        },
      });

      await assertRejects(
        () => client.addMemory({ name: "test", episodeBody: "body" }),
        GraphitiOfflineError,
      );
      assertEquals(await client.searchMemoryFacts({ query: "test" }), []);
      assertEquals(await client.getEpisodes({ groupId: "group" }), []);

      assertEquals(scheduledTasks.length, 3);
      for (const task of scheduledTasks) task();

      assertEquals(
        appLogCalls.map((call) => call.body.message),
        [
          "Graphiti MCP unavailable; persistent memory was not saved.",
          "Graphiti MCP unavailable; continuing without memory facts.",
          "Graphiti MCP unavailable; continuing without episode history.",
        ],
      );
      assertEquals(
        appLogCalls.map((call) => call.body.extra?.operation),
        ["addMemory", "searchMemoryFacts", "getEpisodes"],
      );
      for (const call of appLogCalls) {
        assertStringIncludes(call.body.message, "Graphiti MCP unavailable;");
      }
    } finally {
      setOpenCodeClient(undefined);
      setWarningTaskScheduler(undefined);
      setSuppressConsoleWarningsDuringTestsOverride(undefined);
    }
  });
});
