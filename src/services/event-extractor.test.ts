import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { extractStructuredEvents } from "./event-extractor.ts";

describe("event-extractor", () => {
  it("extracts intent, preference, decision, and data.import from chat input", () => {
    const events = extractStructuredEvents({
      eventType: "chat.message",
      sessionId: "session-1",
      messageCount: 1,
      role: "user",
      messageText:
        "Please keep Graphiti off the hot path and import this json dataset from src/data.json",
    });

    assertEquals(events.map((event) => event.category), [
      "intent",
      "preference",
      "decision",
      "data.import",
    ]);
    assert(events.some((event) => event.refs?.includes("src/data.json")));
  });

  it("extracts task lifecycle categories from task updates", () => {
    const created = extractStructuredEvents({
      eventType: "task.updated",
      properties: {
        task: {
          id: "t1",
          path: "plans/ContextOverhaul.md",
          summary: "Start implementing the overhaul",
        },
      },
    });
    const completed = extractStructuredEvents({
      eventType: "task.updated",
      properties: {
        task: { id: "t1", summary: "Completed the overhaul fixes" },
      },
    });

    assertEquals(created[0].category, "task.create");
    assertEquals(completed[0].category, "task.complete");
    assert(created[0].refs?.includes("plans/ContextOverhaul.md"));
  });

  it("extracts file, git, integration, and error activity from tool events", () => {
    const fileEdit = extractStructuredEvents({
      eventType: "tool.completed",
      properties: {
        tool: "apply_patch",
        path: "src/session.ts",
        summary: "edited src/session.ts",
      },
    });
    const gitActivity = extractStructuredEvents({
      eventType: "tool.completed",
      properties: {
        tool: "shell",
        summary: "branch status and commit inspection",
      },
    });
    const integration = extractStructuredEvents({
      eventType: "tool.called",
      properties: { tool: "graphiti-mcp", summary: "Graphiti MCP search" },
    });
    const error = extractStructuredEvents({
      eventType: "tool.completed",
      properties: { tool: "shell", summary: "command failed with error" },
    });

    assertEquals(fileEdit[0].category, "file.edit");
    assertEquals(gitActivity[0].category, "git.activity");
    assertEquals(integration[0].category, "integration.call");
    assertEquals(error[0].category, "error");
  });

  it("stores continuity for assistant/tool events without transcript-heavy bodies by default", () => {
    const assistant = extractStructuredEvents({
      eventType: "message.updated",
      role: "assistant",
      messageText:
        "Implemented structured continuity extraction for hot-tier snapshots and recall.",
    });
    const tool = extractStructuredEvents({
      eventType: "tool.completed",
      messageText:
        "Read src/session.ts and extracted continuity fields from the current implementation without storing the raw output transcript.",
      properties: {
        tool: "Read",
        path: "src/session.ts",
        summary: "Read src/session.ts",
      },
    });

    assertEquals(assistant[0].category, "message");
    assertEquals(assistant[0].body, undefined);
    assertEquals(typeof assistant[0].continuityText, "string");
    assertEquals(tool[0].category, "file.read");
    assertEquals(tool[0].body, undefined);
    assertEquals(typeof tool[0].continuityText, "string");
  });

  it("extracts rules, environment, subagent, discovery, and assistant error signals", () => {
    const rules = extractStructuredEvents({
      eventType: "rules.loaded",
      properties: {
        path: "AGENTS.md",
        source: "workspace",
        name: "project rules",
      },
    });
    const env = extractStructuredEvents({
      eventType: "environment.updated",
      properties: {
        cwd: "/workspace/project",
        summary:
          "working directory moved to /workspace/project and env updated",
      },
    });
    const started = extractStructuredEvents({
      eventType: "subagent.started",
      properties: {
        agentId: "agent-1",
        sessionId: "child-1",
        summary: "Spawned subagent for tests",
      },
    });
    const finished = extractStructuredEvents({
      eventType: "subagent.finished",
      properties: {
        agentId: "agent-1",
        sessionId: "child-1",
        summary: "Subagent finished tests",
      },
    });
    const assistant = extractStructuredEvents({
      eventType: "message.updated",
      role: "assistant",
      messageText: "I discovered a blocker and cannot complete the task",
    });

    assertEquals(rules[0].category, "rule.load");
    assertEquals(env.map((event) => event.category), [
      "cwd.change",
      "env.change",
    ]);
    assertEquals(started[0].category, "subagent.start");
    assertEquals(finished[0].category, "subagent.finish");
    assertEquals(assistant.map((event) => event.category), [
      "message",
      "discovery",
      "error",
    ]);
  });
});
