import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { afterEach, describe, it } from "jsr:@std/testing@^1.0.0/bdd";

import { createToolAfterHandler } from "./tool-after.ts";
import { ToolRoutingOutcomeCache } from "../services/tool-routing-outcome-cache.ts";

describe("tool execute after handler", () => {
  const routingOutcomes = new ToolRoutingOutcomeCache();

  afterEach(() => {
    routingOutcomes.clearAll();
  });

  it("makes routed rewrite outcomes available to continuity capture after tool execution", async () => {
    routingOutcomes.set("call-1", {
      source: "tool-routing",
      action: "modify",
      reason: "bash-network-rewrite",
    });
    const handler = createToolAfterHandler({ routingOutcomes });
    const output: {
      title: string;
      output: string;
      metadata: Record<string, unknown>;
    } = {
      title: "Bash",
      output: "tool output",
      metadata: { existing: true },
    };

    await handler(
      {
        tool: "Bash",
        sessionID: "root-session",
        callID: "call-1",
        args: { command: "curl https://example.com" },
      } as never,
      output as never,
    );

    assertEquals(output.metadata, {
      existing: true,
      toolRouting: {
        source: "tool-routing",
        action: "modify",
        reason: "bash-network-rewrite",
      },
    });
  });

  it("surfaces denied outcomes as compact continuity metadata without requiring raw tool payloads", async () => {
    routingOutcomes.set("call-2", {
      source: "tool-routing",
      action: "deny",
      reason: "webfetch-denied",
    });
    const handler = createToolAfterHandler({ routingOutcomes });
    const output: {
      title: string;
      output: string;
      metadata?: Record<string, unknown>;
    } = {
      title: "WebFetch",
      output: "",
      metadata: undefined,
    };

    await handler(
      {
        tool: "WebFetch",
        sessionID: "root-session",
        callID: "call-2",
        args: { url: "https://example.com" },
      } as never,
      output as never,
    );

    assertEquals(output.metadata, {
      toolRouting: {
        source: "tool-routing",
        action: "deny",
        reason: "webfetch-denied",
      },
    });
  });

  it("remains continuity-focused and does not rewrite visible tool output", async () => {
    routingOutcomes.set("call-3", {
      source: "tool-routing",
      action: "context",
      guidanceType: "read",
      reason: "read-guidance",
    });
    const handler = createToolAfterHandler({ routingOutcomes });
    const output: {
      title: string;
      output: string;
      metadata: Record<string, unknown>;
    } = {
      title: "Read",
      output: "visible tool output",
      metadata: {},
    };

    await handler(
      {
        tool: "Read",
        sessionID: "root-session",
        callID: "call-3",
        args: { filePath: "/tmp/example.ts" },
      } as never,
      output as never,
    );

    assertEquals(output.title, "Read");
    assertEquals(output.output, "visible tool output");
    assertEquals(output.metadata, {
      toolRouting: {
        source: "tool-routing",
        action: "context",
        guidanceType: "read",
        reason: "read-guidance",
      },
    });
  });
});
