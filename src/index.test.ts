import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { makeGroupId } from "./utils.ts";

describe("index", () => {
  describe("makeGroupId", () => {
    it("should create group ID from simple directory path", () => {
      const groupId = makeGroupId("opencode", "/home/user/my-project");
      assertEquals(groupId, "opencode_my-project");
    });

    it("should use last directory component as project name", () => {
      const groupId = makeGroupId("test", "/var/www/html/app");
      assertEquals(groupId, "test_app");
    });

    it("should handle single directory name", () => {
      const groupId = makeGroupId("prefix", "project");
      assertEquals(groupId, "prefix_project");
    });

    it("should return default when directory is empty", () => {
      const groupId = makeGroupId("prefix", "");
      assertEquals(groupId, "prefix_default");
    });

    it("should return default when directory is just slashes", () => {
      const groupId = makeGroupId("prefix", "///");
      assertEquals(groupId, "prefix_default");
    });

    it("should sanitize special characters to underscores", () => {
      const groupId = makeGroupId("opencode", "/home/user/my-project@2.0");
      assertEquals(groupId, "opencode_my-project_2_0");
    });

    it("should sanitize multiple special characters", () => {
      const groupId = makeGroupId("test", "/projects/my project (v1.0)");
      assertEquals(groupId, "test_my_project__v1_0_");
    });

    it("should preserve hyphens and underscores", () => {
      const groupId = makeGroupId("prefix", "/dir/my_project-name");
      assertEquals(groupId, "prefix_my_project-name");
    });

    it("should handle directory with dots", () => {
      const groupId = makeGroupId("test", "/projects/app.example.com");
      assertEquals(groupId, "test_app_example_com");
    });

    it("should handle directory with spaces", () => {
      const groupId = makeGroupId("test", "/home/my projects/app name");
      assertEquals(groupId, "test_app_name");
    });

    it("should handle directory ending with slash", () => {
      const groupId = makeGroupId("test", "/home/user/project/");
      assertEquals(groupId, "test_project");
    });

    it("should handle complex path with multiple special chars", () => {
      const groupId = makeGroupId(
        "opencode",
        "/Users/name/Projects/my-app@v2.0 (beta)",
      );
      assertEquals(groupId, "opencode_my-app_v2_0__beta_");
    });

    it("should use different prefixes correctly", () => {
      const groupId1 = makeGroupId("prod", "/apps/myapp");
      const groupId2 = makeGroupId("dev", "/apps/myapp");
      assertEquals(groupId1, "prod_myapp");
      assertEquals(groupId2, "dev_myapp");
    });

    it("should handle unicode characters", () => {
      const groupId = makeGroupId("test", "/projects/مشروع");
      assertEquals(groupId.startsWith("test_"), true);
      assertEquals(groupId.includes("_"), true);
    });

    it("should handle very long directory names", () => {
      const longName = "a".repeat(200);
      const groupId = makeGroupId("test", `/projects/${longName}`);
      assertEquals(groupId, `test_${longName}`);
    });

    it("should be deterministic", () => {
      const path = "/home/user/project";
      const groupId1 = makeGroupId("prefix", path);
      const groupId2 = makeGroupId("prefix", path);
      assertEquals(groupId1, groupId2);
    });
  });

  // NOTE: The main `graphiti()` plugin function and its hooks cannot be properly
  // tested without mocking the entire MCP client infrastructure. These tests would
  // require:
  //
  // 1. Integration-style tests that mock the MCP transport layer
  // 2. Tests for event handlers (session.created, session.compacted, session.idle, etc.)
  // 3. Tests for chat.message hook (memory injection, buffering)
  // 4. Tests for experimental.session.compacting hook
  //
  // These tests should be added after Phase 2 refactoring, when the plugin logic
  // is extracted into testable units. For now, the individual helper functions
  // and services are comprehensively tested:
  //
  // - logger (src/services/logger.test.ts) - 100% coverage
  // - handleCompaction (src/services/compaction.test.ts) - 100% coverage
  // - getCompactionContext (src/services/compaction.test.ts) - 100% coverage
  // - formatMemoryContext (src/services/context.test.ts) - 100% coverage
  // - GraphitiClient parsing (src/services/client.test.ts) - 100% coverage
  // - makeGroupId (this file) - 100% coverage
  //
  // What remains untestable without major refactoring:
  // - isTextPart() - helper function not exported
  // - extractTextFromParts() - helper function not exported
  // - Plugin hook handlers - tightly coupled to MCP infrastructure
  // - Session state management - internal to plugin
  // - Message buffering logic - internal to plugin
  // - Memory injection logic - requires mocking client.searchFacts/searchNodes
});
