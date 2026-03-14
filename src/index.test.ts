import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { afterEach, describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { graphiti, warnOnGraphitiStartupUnavailable } from "./index.ts";
import {
  setOpenCodeClient,
  setWarningTaskScheduler,
} from "./services/opencode-warning.ts";
import { makeGroupId, makeUserGroupId } from "./utils.ts";

describe("index", () => {
  afterEach(() => {
    setOpenCodeClient(undefined);
    setWarningTaskScheduler(undefined);
  });

  describe("makeGroupId", () => {
    it("should omit undefined prefix text when prefix is missing", () => {
      const groupId = makeGroupId(undefined, "/home/user/my-project");
      assertEquals(groupId, "my-project__main");
    });

    it("should create group ID from simple directory path", () => {
      const groupId = makeGroupId("opencode", "/home/user/my-project");
      assertEquals(groupId, "opencode-my-project__main");
    });

    it("should use last directory component as project name", () => {
      const groupId = makeGroupId("test", "/var/www/html/app");
      assertEquals(groupId, "test-app__main");
    });

    it("should handle single directory name", () => {
      const groupId = makeGroupId("prefix", "project");
      assertEquals(groupId, "prefix-project__main");
    });

    it("should return default when directory is empty", () => {
      const groupId = makeGroupId("prefix", "");
      assertEquals(groupId, "prefix-default__main");
    });

    it("should return default when directory is just slashes", () => {
      const groupId = makeGroupId("prefix", "///");
      assertEquals(groupId, "prefix-default__main");
    });

    it("should sanitize special characters to underscores", () => {
      const groupId = makeGroupId("opencode", "/home/user/my-project@2.0");
      assertEquals(groupId, "opencode-my-project_2_0__main");
    });

    it("should sanitize multiple special characters", () => {
      const groupId = makeGroupId("test", "/projects/my project (v1.0)");
      assertEquals(groupId, "test-my_project__v1_0___main");
    });

    it("should preserve hyphens and underscores", () => {
      const groupId = makeGroupId("prefix", "/dir/my_project-name");
      assertEquals(groupId, "prefix-my_project-name__main");
    });

    it("should handle directory with dots", () => {
      const groupId = makeGroupId("test", "/projects/app.example.com");
      assertEquals(groupId, "test-app_example_com__main");
    });

    it("should handle directory with spaces", () => {
      const groupId = makeGroupId("test", "/home/my projects/app name");
      assertEquals(groupId, "test-app_name__main");
    });

    it("should handle directory ending with slash", () => {
      const groupId = makeGroupId("test", "/home/user/project/");
      assertEquals(groupId, "test-project__main");
    });

    it("should handle complex path with multiple special chars", () => {
      const groupId = makeGroupId(
        "opencode",
        "/Users/name/Projects/my-app@v2.0 (beta)",
      );
      assertEquals(groupId, "opencode-my-app_v2_0__beta___main");
    });

    it("should use different prefixes correctly", () => {
      const groupId1 = makeGroupId("prod", "/apps/myapp");
      const groupId2 = makeGroupId("dev", "/apps/myapp");
      assertEquals(groupId1, "prod-myapp__main");
      assertEquals(groupId2, "dev-myapp__main");
    });

    it("should handle unicode characters", () => {
      const groupId = makeGroupId("test", "/projects/مشروع");
      assertEquals(groupId.startsWith("test-"), true);
      assertEquals(groupId.endsWith("__main"), true);
    });

    it("should handle very long directory names", () => {
      const longName = "a".repeat(200);
      const groupId = makeGroupId("test", `/projects/${longName}`);
      assertEquals(groupId, `test-${longName}__main`);
    });

    it("should be deterministic", () => {
      const path = "/home/user/project";
      const groupId1 = makeGroupId("prefix", path);
      const groupId2 = makeGroupId("prefix", path);
      assertEquals(groupId1, groupId2);
    });
  });

  describe("makeUserGroupId", () => {
    it("should omit undefined prefix text when prefix is missing", () => {
      const groupId = makeUserGroupId(undefined, "/home/user/my-project");
      assertEquals(groupId.startsWith("undefined"), false);
      assertEquals(groupId.startsWith("my-project__user-"), true);
    });
  });

  describe("warnOnGraphitiStartupUnavailable", () => {
    it("shows a native warning toast and structured log when Graphiti is unavailable", () => {
      const appLogCalls: unknown[] = [];
      const toastCalls: unknown[] = [];
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
        tui: {
          showToast: (input: unknown) => {
            toastCalls.push(input);
          },
        },
      });

      warnOnGraphitiStartupUnavailable(false, "http://graphiti.test/mcp");

      assertEquals(appLogCalls.length, 0);
      assertEquals(toastCalls.length, 0);
      assertEquals(scheduledTasks.length, 2);
      for (const task of scheduledTasks) task();

      assertEquals(appLogCalls.length, 1);
      assertEquals(toastCalls, [{
        body: {
          message:
            "Graphiti MCP unavailable at http://graphiti.test/mcp; continuing without persistent memory.",
          variant: "warning",
        },
      }]);
    });

    it("does nothing when Graphiti is connected", () => {
      const appLogCalls: unknown[] = [];
      const toastCalls: unknown[] = [];
      setOpenCodeClient({
        app: {
          log: (input: unknown) => {
            appLogCalls.push(input);
          },
        },
        tui: {
          showToast: (input: unknown) => {
            toastCalls.push(input);
          },
        },
      });

      warnOnGraphitiStartupUnavailable(true, "http://graphiti.test/mcp");

      assertEquals(appLogCalls.length, 0);
      assertEquals(toastCalls.length, 0);
    });
  });

  describe("plugin export shape", () => {
    it("exports graphiti as the plugin entrypoint", () => {
      assertEquals(typeof graphiti, "function");
    });
  });

  // NOTE: The main `graphiti()` plugin function requires a live Graphiti MCP
  // server and cannot be integration-tested here without mocking the MCP
  // transport layer.  All testable units are covered in the files listed below:
  //
  // - makeGroupId / makeUserGroupId (this file)
  // - logger                        (src/services/logger.test.ts)
  // - handleCompaction / getCompactionContext
  //                                 (src/services/compaction.test.ts)
  // - formatMemoryContext           (src/services/context.test.ts)
  // - GraphitiClient parsing        (src/services/client.test.ts)
  // - createChatHandler             (src/handlers/chat.test.ts)
  // - createEventHandler            (src/handlers/event.test.ts)
  // - SessionManager                (src/services/session-snapshot.test.ts)
  // - context utilities             (src/services/context-utils.test.ts)
  // - compaction utilities          (src/services/compaction-utils.test.ts)
});
