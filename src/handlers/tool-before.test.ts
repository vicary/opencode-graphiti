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

  it("throws on denied WebFetch calls", async () => {
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
      "WebFetch",
    );

    assertEquals(routingOutcomes.take("call-1"), {
      source: "tool-routing",
      action: "deny",
      reason: "webfetch-denied",
    });
  });

  it("throws on denied WebFetch calls from a child session after first-call canonical lookup", async () => {
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
      "WebFetch",
    );

    assertEquals(canonicalizer.cachedCalls, ["child-session"]);
    assertEquals(canonicalizer.resolveCalls, ["child-session"]);
    assertEquals(routingOutcomes.take("call-2"), {
      source: "tool-routing",
      action: "deny",
      reason: "webfetch-denied",
    });
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

  it("does not perform Redis or Graphiti access on the before-hook path", async () => {
    const canonicalizer = new MockSessionCanonicalizer();
    canonicalizer.cached.set("root-session", "root-session");
    const unexpectedCalls: string[] = [];
    const handler = createToolBeforeHandler({
      sessionCanonicalizer: canonicalizer as never,
      guidanceThrottle: new ToolGuidanceCache(),
      routingOutcomes,
      routeToolCall,
      redisEvents: {
        recordEvent: () => {
          unexpectedCalls.push("redisEvents.recordEvent");
        },
      },
      graphitiAsync: {
        scheduleDrain: () => {
          unexpectedCalls.push("graphitiAsync.scheduleDrain");
        },
      },
    } as never);

    await handler(
      {
        tool: "Read",
        sessionID: "root-session",
        callID: "call-7",
      } as never,
      { args: { filePath: "/tmp/a.ts" } } as never,
    );

    assertEquals(unexpectedCalls, []);
  });
});
