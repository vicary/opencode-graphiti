import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@^1.0.0";
import { afterEach, describe, it } from "jsr:@std/testing@^1.0.0/bdd";

import { createToolBeforeHandler } from "./tool-before.ts";
import { ToolGuidanceCache } from "../services/tool-guidance-cache.ts";
import { ToolRoutingOutcomeCache } from "../services/tool-routing-outcome-cache.ts";
import { routeToolCall } from "../services/tool-routing.ts";

class MockSessionCanonicalizer {
  cached = new Map<string, string>();
  resolved = new Map<string, string>();
  cachedCalls: string[] = [];
  resolveCalls: string[] = [];

  getCachedCanonicalSessionId(sessionId: string): string | undefined {
    this.cachedCalls.push(sessionId);
    return this.cached.get(sessionId);
  }

  resolveCanonicalSessionId(sessionId: string): Promise<string | undefined> {
    this.resolveCalls.push(sessionId);
    return Promise.resolve(this.resolved.get(sessionId));
  }
}

describe("tool execute before handler", () => {
  const routingOutcomes = new ToolRoutingOutcomeCache();

  afterEach(() => {
    routingOutcomes.clearAll();
  });

  it("throws guidance on denied WebFetch calls", async () => {
    const canonicalizer = new MockSessionCanonicalizer();
    canonicalizer.cached.set("root-session", "root-session");
    const handler = createToolBeforeHandler({
      sessionCanonicalizer: canonicalizer as never,
      guidanceThrottle: new ToolGuidanceCache(),
      routingOutcomes,
      routeToolCall,
    });

    await assertRejects(
      () =>
        handler(
          {
            tool: "WebFetch",
            sessionID: "root-session",
            callID: "call-1",
          } as never,
          { args: { url: "https://example.com" } } as never,
        ),
      Error,
      "WebFetch is blocked",
    );

    assertEquals(routingOutcomes.take("call-1"), {
      source: "tool-routing",
      action: "deny",
      reason: "webfetch-denied",
    });
  });

  it("throws guidance on denied WebFetch calls from a child session after first-call canonical lookup", async () => {
    const canonicalizer = new MockSessionCanonicalizer();
    canonicalizer.resolved.set("child-session", "root-session");
    const handler = createToolBeforeHandler({
      sessionCanonicalizer: canonicalizer as never,
      guidanceThrottle: new ToolGuidanceCache(),
      routingOutcomes,
      routeToolCall,
    });

    await assertRejects(
      () =>
        handler(
          {
            tool: "WebFetch",
            sessionID: "child-session",
            callID: "call-2",
          } as never,
          { args: { url: "https://example.com" } } as never,
        ),
      Error,
      "WebFetch is blocked",
    );

    assertEquals(canonicalizer.cachedCalls, ["child-session"]);
    assertEquals(canonicalizer.resolveCalls, ["child-session"]);
    assertEquals(routingOutcomes.take("call-2"), {
      source: "tool-routing",
      action: "deny",
      reason: "webfetch-denied",
    });
  });

  it("throws the deny guidance text when provided", async () => {
    const canonicalizer = new MockSessionCanonicalizer();
    canonicalizer.cached.set("root-session", "root-session");
    const handler = createToolBeforeHandler({
      sessionCanonicalizer: canonicalizer as never,
      guidanceThrottle: new ToolGuidanceCache(),
      routingOutcomes,
      routeToolCall: () => ({
        action: "deny",
        reason: "test-deny",
        guidance:
          "Dynamic guidance details that should stay out of the thrown error.",
      }),
    });

    const error = await assertRejects(
      () =>
        handler(
          {
            tool: "Bash",
            sessionID: "root-session",
            callID: "call-stable-deny",
          } as never,
          { args: { command: "curl https://example.com" } } as never,
        ),
      Error,
      "Dynamic guidance details that should stay out of the thrown error.",
    );

    assertEquals(
      error.message,
      "Dynamic guidance details that should stay out of the thrown error.",
    );
    assertStringIncludes(
      String(routingOutcomes.take("call-stable-deny")?.reason),
      "test-deny",
    );
  });

  it("falls back to the generic denial message when guidance is absent", async () => {
    const canonicalizer = new MockSessionCanonicalizer();
    canonicalizer.cached.set("root-session", "root-session");
    const handler = createToolBeforeHandler({
      sessionCanonicalizer: canonicalizer as never,
      guidanceThrottle: new ToolGuidanceCache(),
      routingOutcomes,
      routeToolCall: () => ({
        action: "deny",
        reason: "test-deny-no-guidance",
        guidance: "",
      }),
    });

    const error = await assertRejects(
      () =>
        handler(
          {
            tool: "Bash",
            sessionID: "root-session",
            callID: "call-generic-deny",
          } as never,
          { args: { command: "curl https://example.com" } } as never,
        ),
      Error,
      "Tool denied (Bash)",
    );

    assertEquals(error.message, "Tool denied (Bash)");
    assertStringIncludes(
      String(routingOutcomes.take("call-generic-deny")?.reason),
      "test-deny-no-guidance",
    );
  });

  it("mutates args for Bash rewrite cases", async () => {
    const canonicalizer = new MockSessionCanonicalizer();
    canonicalizer.cached.set("root-session", "root-session");
    const handler = createToolBeforeHandler({
      sessionCanonicalizer: canonicalizer as never,
      guidanceThrottle: new ToolGuidanceCache(),
      routingOutcomes,
      routeToolCall,
    });
    const output = { args: { command: "curl https://example.com/api" } };

    await handler(
      {
        tool: "Bash",
        sessionID: "root-session",
        callID: "call-3",
      } as never,
      output as never,
    );

    assertStringIncludes(String(output.args.command), "Routing note");
    assertEquals(routingOutcomes.take("call-3"), {
      source: "tool-routing",
      action: "modify",
      reason: "bash-network-rewrite",
    });
  });

  it("emits guidance only once per canonical root session across parent and child sessions", async () => {
    const canonicalizer = new MockSessionCanonicalizer();
    canonicalizer.cached.set("root-session", "root-session");
    canonicalizer.cached.set("child-session", "root-session");
    const handler = createToolBeforeHandler({
      sessionCanonicalizer: canonicalizer as never,
      guidanceThrottle: new ToolGuidanceCache(),
      routingOutcomes,
      routeToolCall,
    });

    await handler(
      {
        tool: "Read",
        sessionID: "root-session",
        callID: "call-4",
      } as never,
      { args: { filePath: "/tmp/a.ts" } } as never,
    );
    await handler(
      {
        tool: "Read",
        sessionID: "child-session",
        callID: "call-5",
      } as never,
      { args: { filePath: "/tmp/b.ts" } } as never,
    );

    assertEquals(routingOutcomes.take("call-4"), {
      source: "tool-routing",
      action: "context",
      guidanceType: "read",
      reason: "read-guidance",
    });
    assertEquals(routingOutcomes.take("call-5"), undefined);
  });

  it("keeps allow decisions as true no-op passthrough", async () => {
    const canonicalizer = new MockSessionCanonicalizer();
    canonicalizer.cached.set("root-session", "root-session");
    const handler = createToolBeforeHandler({
      sessionCanonicalizer: canonicalizer as never,
      guidanceThrottle: new ToolGuidanceCache(),
      routingOutcomes,
      routeToolCall,
    });
    const args = { pattern: "src/**/*.ts", path: "/workspace/project" };
    const output = { args };

    await handler(
      {
        tool: "Glob",
        sessionID: "root-session",
        callID: "call-6",
      } as never,
      output as never,
    );

    assertEquals(output.args, args);
    assertEquals(routingOutcomes.take("call-6"), undefined);
  });

  it("injects canonical root_session_id into every session tool call", async () => {
    const canonicalizer = new MockSessionCanonicalizer();
    canonicalizer.cached.set("root-session", "root-session");
    const handler = createToolBeforeHandler({
      sessionCanonicalizer: canonicalizer as never,
      guidanceThrottle: new ToolGuidanceCache(),
      routingOutcomes,
      routeToolCall,
    });

    const scenarios = [
      ["session_execute", { command: "pwd" }],
      ["session_execute_file", { paths: ["README.md"] }],
      ["session_batch_execute", { commands: [{ command: "pwd" }] }],
      ["session_index", { content: "indexed content" }],
      ["session_search", { query: "indexed" }],
      ["session_fetch_and_index", { url: "https://example.com" }],
      ["session_stats", {}],
      ["session_doctor", {}],
    ] as const;

    for (const [tool, args] of scenarios) {
      const output: { args: Record<string, unknown> } = { args: { ...args } };

      await handler(
        {
          tool,
          sessionID: "root-session",
          callID: `${tool}-call`,
        } as never,
        output as never,
      );

      assertEquals(output.args.root_session_id, "root-session", tool);
    }
  });

  it("injects the canonical parent root_session_id for child session tools", async () => {
    const canonicalizer = new MockSessionCanonicalizer();
    canonicalizer.resolved.set("child-session", "root-session");
    const handler = createToolBeforeHandler({
      sessionCanonicalizer: canonicalizer as never,
      guidanceThrottle: new ToolGuidanceCache(),
      routingOutcomes,
      routeToolCall,
    });
    const output: { args: Record<string, unknown> } = {
      args: { query: "indexed" },
    };

    await handler(
      {
        tool: "session_search",
        sessionID: "child-session",
        callID: "call-8",
      } as never,
      output as never,
    );

    assertEquals(output.args.root_session_id, "root-session");
    assertEquals(canonicalizer.cachedCalls, ["child-session"]);
    assertEquals(canonicalizer.resolveCalls, ["child-session"]);
    assertEquals(routingOutcomes.take("call-8"), undefined);
  });

  it("normalizes an already-present mismatched root_session_id for session tools", async () => {
    const canonicalizer = new MockSessionCanonicalizer();
    canonicalizer.cached.set("child-session", "root-session");
    const handler = createToolBeforeHandler({
      sessionCanonicalizer: canonicalizer as never,
      guidanceThrottle: new ToolGuidanceCache(),
      routingOutcomes,
      routeToolCall,
    });
    const output = {
      args: { root_session_id: "wrong-root", command: "pwd" },
    };

    await handler(
      {
        tool: "session_execute",
        sessionID: "child-session",
        callID: "call-9",
      } as never,
      output as never,
    );

    assertEquals(output.args.root_session_id, "root-session");
    assertEquals(routingOutcomes.take("call-9"), undefined);
  });

  it("preserves root_session_id when a session tool is modified by routing", async () => {
    const canonicalizer = new MockSessionCanonicalizer();
    canonicalizer.cached.set("child-session", "root-session");
    let routedArgs: Record<string, unknown> | undefined;
    const handler = createToolBeforeHandler({
      sessionCanonicalizer: canonicalizer as never,
      guidanceThrottle: new ToolGuidanceCache(),
      routingOutcomes,
      routeToolCall: ({ args }) => {
        routedArgs = args;
        return {
          action: "modify",
          args: { query: "rewritten" },
          reason: "test-modify",
        };
      },
    });
    const output = {
      args: { root_session_id: "wrong-root", query: "original" },
    };

    await handler(
      {
        tool: "session_search",
        sessionID: "child-session",
        callID: "call-10",
      } as never,
      output as never,
    );

    assertEquals(routedArgs, {
      root_session_id: "root-session",
      query: "original",
    });
    assertEquals(output.args, {
      root_session_id: "root-session",
      query: "rewritten",
    });
    assertEquals(routingOutcomes.take("call-10"), {
      source: "tool-routing",
      action: "modify",
      reason: "test-modify",
    });
  });

  it("does not inject root_session_id into native tools", async () => {
    const canonicalizer = new MockSessionCanonicalizer();
    canonicalizer.cached.set("root-session", "root-session");
    const handler = createToolBeforeHandler({
      sessionCanonicalizer: canonicalizer as never,
      guidanceThrottle: new ToolGuidanceCache(),
      routingOutcomes,
      routeToolCall,
    });

    const scenarios = [
      ["Read", { filePath: "/tmp/example.ts" }],
      ["Bash", { command: "curl https://example.com/data.json" }],
      ["Grep", { pattern: "routeToolCall", include: "*.ts" }],
      ["Glob", { pattern: "src/**/*.ts" }],
      ["WebFetch", { url: "https://example.com" }],
      ["Task", { prompt: "Investigate the failing test" }],
    ] as const;

    for (const [tool, args] of scenarios) {
      const output = { args: { ...args } };
      try {
        await handler(
          {
            tool,
            sessionID: "root-session",
            callID: `${tool}-native-call`,
          } as never,
          output as never,
        );
      } catch {
        // WebFetch is denied by design; we only care about root_session_id injection.
      }

      assertEquals("root_session_id" in output.args, false, tool);
    }
  });

  it("runs the before-hook path for Read without unexpected side effects", async () => {
    const canonicalizer = new MockSessionCanonicalizer();
    canonicalizer.cached.set("root-session", "root-session");
    const handler = createToolBeforeHandler({
      sessionCanonicalizer: canonicalizer as never,
      guidanceThrottle: new ToolGuidanceCache(),
      routingOutcomes,
      routeToolCall,
    });
    const output = { args: { filePath: "/tmp/a.ts" } };

    await handler(
      {
        tool: "Read",
        sessionID: "root-session",
        callID: "call-7",
      } as never,
      output as never,
    );

    assertEquals(output.args.filePath, "/tmp/a.ts");
    assertEquals(canonicalizer.cachedCalls, ["root-session"]);
    assertEquals(canonicalizer.resolveCalls, []);
    assertEquals(routingOutcomes.take("call-7"), {
      source: "tool-routing",
      action: "context",
      guidanceType: "read",
      reason: "read-guidance",
    });
  });
});
