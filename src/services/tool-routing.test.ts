import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";

import { ROUTING_BLOCK } from "./tool-guidance.ts";
import { routeToolCall } from "./tool-routing.ts";

class MockGuidanceThrottle {
  calls: Array<{ sessionId: string; guidanceType: string }> = [];

  constructor(private readonly nextResult = true) {}

  shouldEmit(sessionId: string, guidanceType: string): boolean {
    this.calls.push({ sessionId, guidanceType });
    return this.nextResult;
  }
}

describe("tool routing", () => {
  it("returns a Read guidance decision", () => {
    const throttle = new MockGuidanceThrottle(true);

    const decision = routeToolCall({
      canonicalSessionId: "root-session",
      toolName: "Read",
      args: { filePath: "/tmp/example.ts" },
      guidanceThrottle: throttle,
    });

    assertEquals(decision.action, "context");
    if (decision.action !== "context") {
      throw new Error(`Expected context decision, got ${decision.action}`);
    }
    assertEquals(decision.guidanceType, "read");
    assertEquals(decision.reason, "read-guidance");
    assertEquals(throttle.calls, [{
      sessionId: "root-session",
      guidanceType: "read",
    }]);
  });

  it("hard-denies WebFetch", () => {
    const decision = routeToolCall({
      canonicalSessionId: "root-session",
      toolName: "WebFetch",
      args: { url: "https://example.com" },
      guidanceThrottle: new MockGuidanceThrottle(true),
    });

    assertEquals(decision.action, "deny");
    if (decision.action !== "deny") {
      throw new Error(`Expected deny decision, got ${decision.action}`);
    }
    assertEquals(decision.reason, "webfetch-denied");
    assertStringIncludes(decision.guidance, "WebFetch");
    assertStringIncludes(decision.guidance, "session_fetch_and_index");
  });

  it("rewrites Bash curl commands", () => {
    const decision = routeToolCall({
      canonicalSessionId: "root-session",
      toolName: "Bash",
      args: { command: "curl https://example.com/data.json" },
      guidanceThrottle: new MockGuidanceThrottle(true),
    });

    assertEquals(decision.action, "modify");
    if (decision.action !== "modify") {
      throw new Error(`Expected modify decision, got ${decision.action}`);
    }
    assertEquals(decision.reason, "bash-network-rewrite");
    assertStringIncludes(String(decision.args.command), "Routing note");
    assertStringIncludes(String(decision.args.command), "network");
  });

  it("rewrites Bash inline HTTP commands", () => {
    const decision = routeToolCall({
      canonicalSessionId: "root-session",
      toolName: "Bash",
      args: {
        command: 'node -e "fetch("https://example.com/api").then(console.log)"',
      },
      guidanceThrottle: new MockGuidanceThrottle(true),
    });

    assertEquals(decision.action, "modify");
    if (decision.action !== "modify") {
      throw new Error(`Expected modify decision, got ${decision.action}`);
    }
    assertEquals(decision.reason, "bash-inline-http-rewrite");
    assertStringIncludes(String(decision.args.command), "Routing note");
    assertStringIncludes(String(decision.args.command), "HTTP");
  });

  it("rewrites Bash build-tool commands", () => {
    const decision = routeToolCall({
      canonicalSessionId: "root-session",
      toolName: "Bash",
      args: { command: "./gradlew build" },
      guidanceThrottle: new MockGuidanceThrottle(true),
    });

    assertEquals(decision.action, "modify");
    if (decision.action !== "modify") {
      throw new Error(`Expected modify decision, got ${decision.action}`);
    }
    assertEquals(decision.reason, "bash-build-rewrite");
    assertStringIncludes(String(decision.args.command), "build");
    assertStringIncludes(String(decision.args.command), "Routing note");
  });

  it("returns ordinary Bash guidance as a fallback", () => {
    const throttle = new MockGuidanceThrottle(true);

    const decision = routeToolCall({
      canonicalSessionId: "root-session",
      toolName: "Bash",
      args: { command: "deno test src/session.ts" },
      guidanceThrottle: throttle,
    });

    assertEquals(decision.action, "context");
    if (decision.action !== "context") {
      throw new Error(`Expected context decision, got ${decision.action}`);
    }
    assertEquals(decision.guidanceType, "bash");
    assertEquals(decision.reason, "bash-guidance");
    assertEquals(throttle.calls, [{
      sessionId: "root-session",
      guidanceType: "bash",
    }]);
  });

  it("returns a Grep guidance decision", () => {
    const throttle = new MockGuidanceThrottle(true);

    const decision = routeToolCall({
      canonicalSessionId: "root-session",
      toolName: "Grep",
      args: { pattern: "routeToolCall", include: "*.ts" },
      guidanceThrottle: throttle,
    });

    assertEquals(decision.action, "context");
    if (decision.action !== "context") {
      throw new Error(`Expected context decision, got ${decision.action}`);
    }
    assertEquals(decision.guidanceType, "grep");
    assertEquals(decision.reason, "grep-guidance");
    assertEquals(throttle.calls, [{
      sessionId: "root-session",
      guidanceType: "grep",
    }]);
  });

  it("passes Glob through unchanged", () => {
    const throttle = new MockGuidanceThrottle(true);

    const decision = routeToolCall({
      canonicalSessionId: "root-session",
      toolName: "Glob",
      args: { pattern: "src/**/*.ts" },
      guidanceThrottle: throttle,
    });

    assertEquals(decision, { action: "allow", reason: "glob-allow" });
    assertEquals(throttle.calls, []);
  });

  it("rewrites the Task prompt field", () => {
    const decision = routeToolCall({
      canonicalSessionId: "root-session",
      toolName: "Task",
      args: { prompt: "Investigate the failing test", subagent_type: "leaf" },
      guidanceThrottle: new MockGuidanceThrottle(true),
    });

    assertEquals(decision.action, "modify");
    if (decision.action !== "modify") {
      throw new Error(`Expected modify decision, got ${decision.action}`);
    }
    assertEquals(decision.reason, "task-routing-block");
    assertStringIncludes(
      String(decision.args.prompt),
      "Investigate the failing test",
    );
    assertStringIncludes(String(decision.args.prompt), ROUTING_BLOCK);
    assertEquals(decision.args.subagent_type, "leaf");
  });

  it("rewrites the first present Task prompt field in priority order", () => {
    const scenarios = [
      {
        field: "prompt",
        args: {
          prompt: "p",
          request: "r",
          objective: "o",
          question: "q",
          query: "qq",
          task: "t",
        },
      },
      {
        field: "request",
        args: {
          request: "r",
          objective: "o",
          question: "q",
          query: "qq",
          task: "t",
        },
      },
      {
        field: "objective",
        args: { objective: "o", question: "q", query: "qq", task: "t" },
      },
      {
        field: "question",
        args: { question: "q", query: "qq", task: "t" },
      },
      {
        field: "query",
        args: { query: "qq", task: "t" },
      },
      {
        field: "task",
        args: { task: "t" },
      },
    ] as const;

    for (const scenario of scenarios) {
      const decision = routeToolCall({
        canonicalSessionId: "root-session",
        toolName: "Task",
        args: { ...scenario.args },
        guidanceThrottle: new MockGuidanceThrottle(true),
      });

      assertEquals(decision.action, "modify");
      if (decision.action !== "modify") {
        throw new Error(`Expected modify decision, got ${decision.action}`);
      }
      assertStringIncludes(
        String(decision.args[scenario.field]),
        ROUTING_BLOCK,
      );
    }
  });

  it("fails open for unknown tools", () => {
    const decision = routeToolCall({
      canonicalSessionId: "root-session",
      toolName: "UnknownTool",
      args: { anything: true },
      guidanceThrottle: new MockGuidanceThrottle(true),
    });

    assertEquals(decision, { action: "allow", reason: "unknown-tool-allow" });
  });
});
