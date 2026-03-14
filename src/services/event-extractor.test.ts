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
    const integrationFailure = extractStructuredEvents({
      eventType: "tool.completed",
      properties: {
        tool: "graphiti-mcp",
        summary: "Graphiti MCP search failed with error",
        resolved: false,
      },
    });
    const resolvedIntegrationFailure = extractStructuredEvents({
      eventType: "tool.completed",
      properties: {
        tool: "graphiti-mcp",
        summary: "Graphiti MCP search failed with error",
        resolved: true,
      },
    });
    const error = extractStructuredEvents({
      eventType: "tool.completed",
      properties: { tool: "shell", summary: "command failed with error" },
    });

    assertEquals(fileEdit[0].category, "file.edit");
    assertEquals(gitActivity[0].category, "git.activity");
    assertEquals(integration[0].category, "integration.call");
    assertEquals(integrationFailure[0].category, "error");
    assertEquals(integrationFailure[0].metadata?.resolved, false);
    assertEquals(resolvedIntegrationFailure[0].category, "integration.call");
    assertEquals(resolvedIntegrationFailure[0].metadata?.resolved, true);
    assertEquals(error[0].category, "error");
  });

  it("suppresses assistant operational chatter while still storing compact tool continuity", () => {
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

    assertEquals(assistant, []);
    assertEquals(tool[0].category, "file.read");
    assertEquals(tool[0].body, undefined);
    assertEquals(typeof tool[0].continuityText, "string");
  });

  it("dedupes repeated continuity fragments for user task-like messages", () => {
    const [event] = extractStructuredEvents({
      eventType: "chat.message",
      sessionId: "session-1",
      messageCount: 2,
      role: "user",
      messageText: "do the cleanup on code and data, don't commit yet",
    });

    assertEquals(
      event.continuityText,
      "do the cleanup on code and data, don't commit yet",
    );
  });

  it("dedupes repeated detail fragments in compactParts-backed task updates", () => {
    const [event] = extractStructuredEvents({
      eventType: "task.updated",
      properties: {
        task: {
          id: "t1",
          summary:
            "yes, keep the review-refine loop until no more issues are found.",
        },
      },
    });

    assertEquals(
      event.detail,
      "Task update — yes, keep the review-refine loop until no more issues are found.",
    );
  });

  it("extracts rules, environment, and subagent signals while filtering assistant operational blocker chatter", () => {
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
    assertEquals(assistant, []);
  });

  it("rejects transcript-heavy user and tool wrapper content from extraction", () => {
    const user = extractStructuredEvents({
      eventType: "chat.message",
      sessionId: "session-1",
      messageCount: 2,
      role: "user",
      messageText:
        '<session_memory version="1"></session_memory>\n<path>src/session.ts</path>\n<content>1: const x = 1</content>',
    });
    const tool = extractStructuredEvents({
      eventType: "tool.completed",
      properties: {
        tool: "Read",
        path: "src/session.ts",
        summary: "Read src/session.ts",
      },
      messageText:
        "<path>src/session.ts</path>\n<content>1: export const huge = true;</content>",
    });

    assertEquals(user, []);
    assertEquals(tool[0].category, "file.read");
    assertEquals(tool[0].body, undefined);
    assertEquals(tool[0].continuityText?.includes("content"), false);
  });

  it("preserves legitimate inline xml-like tags in normal text", () => {
    const [event] = extractStructuredEvents({
      eventType: "chat.message",
      sessionId: "session-1",
      messageCount: 2,
      role: "user",
      messageText:
        "Keep the literal tags <path>docs/notes</path> and <type>manual</type> in the summary.",
    });

    assertEquals(
      event.summary.includes("<path>docs/notes</path>"),
      true,
    );
    assertEquals(event.summary.includes("<type>manual</type>"), true);
  });

  it("extracts refs from nested call payloads", () => {
    const [event] = extractStructuredEvents({
      eventType: "tool.called",
      properties: {
        call: {
          tool: {
            name: "Read",
            refs: ["src/services/event-extractor.ts"],
            path: "src/services/render-utils.ts",
          },
        },
        summary: "Read nested call payload refs",
      },
    });

    assertEquals(
      event.refs?.includes("src/services/event-extractor.ts"),
      true,
    );
    assertEquals(event.refs?.includes("src/services/render-utils.ts"), true);
  });
});
