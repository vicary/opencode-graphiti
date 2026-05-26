import type { Hooks } from "@opencode-ai/plugin";
import type { ToolGuidanceCache } from "../services/tool-guidance-cache.ts";
import {
  routeToolCall as defaultRouteToolCall,
  type RouteToolCallInput,
  type RoutingDecision,
} from "../services/tool-routing.ts";
import { SESSION_MCP_TOOL_NAMES } from "../services/session-mcp-types.ts";
import type { ToolRoutingOutcomeCache } from "../services/tool-routing-outcome-cache.ts";
import type { ToolRoutingSessionCanonicalizer } from "../session.ts";

type ToolBeforeHook = NonNullable<Hooks["tool.execute.before"]>;
type ToolBeforeInput = Parameters<ToolBeforeHook>[0];
type ToolBeforeOutput = Parameters<ToolBeforeHook>[1];

export interface ToolBeforeHandlerDeps {
  sessionCanonicalizer: ToolRoutingSessionCanonicalizer;
  guidanceThrottle: ToolGuidanceCache;
  routingOutcomes: ToolRoutingOutcomeCache;
  routeToolCall?: (input: RouteToolCallInput) => RoutingDecision;
}

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const SESSION_MCP_TOOL_NAME_SET = new Set<string>(SESSION_MCP_TOOL_NAMES);

const isSessionMcpTool = (toolName: string): boolean =>
  SESSION_MCP_TOOL_NAME_SET.has(
    toolName as typeof SESSION_MCP_TOOL_NAMES[number],
  );

const stripRootSessionId = (
  args: Record<string, unknown>,
): Record<string, unknown> => {
  const { root_session_id: _ignored, ...rest } = args;
  return rest;
};

const resolveCanonicalSessionId = async (
  sessionCanonicalizer: ToolRoutingSessionCanonicalizer,
  sessionId: string,
): Promise<string> => {
  const cached = sessionCanonicalizer.getCachedCanonicalSessionId(sessionId);
  if (cached) return cached;

  // Task 2 explicitly chooses the async first-call canonicalization path:
  // if a child lineage is not cached yet, resolve through the SDK-backed
  // session manager path once, then fall back to the raw session ID only when
  // canonical lineage cannot be resolved.
  return await sessionCanonicalizer.resolveCanonicalSessionId(sessionId) ??
    sessionId;
};

export function createToolBeforeHandler(
  deps: ToolBeforeHandlerDeps,
): ToolBeforeHook {
  const route = deps.routeToolCall ?? defaultRouteToolCall;

  return async (
    { tool, sessionID, callID }: ToolBeforeInput,
    output: ToolBeforeOutput,
  ) => {
    const sessionTool = isSessionMcpTool(tool);
    const canonicalSessionId = await resolveCanonicalSessionId(
      deps.sessionCanonicalizer,
      sessionID,
    );
    const args = sessionTool
      ? stripRootSessionId(toRecord(output.args))
      : toRecord(output.args);
    if (sessionTool) {
      output.args = args;
    }
    const decision = route({
      canonicalSessionId,
      toolName: tool,
      args,
      guidanceThrottle: deps.guidanceThrottle,
    });

    switch (decision.action) {
      case "allow":
        return;
      case "modify":
        output.args = sessionTool
          ? stripRootSessionId(toRecord(decision.args))
          : decision.args;
        deps.routingOutcomes.set(callID, {
          source: "tool-routing",
          action: "modify",
          reason: decision.reason,
        });
        return;
      case "context":
        deps.routingOutcomes.set(callID, {
          source: "tool-routing",
          action: "context",
          guidanceType: decision.guidanceType,
          reason: decision.reason,
        });
        return;
      case "deny":
        deps.routingOutcomes.set(callID, {
          source: "tool-routing",
          action: "deny",
          reason: decision.reason,
        });
        throw new Error(decision.guidance || `Tool denied (${tool})`);
    }
  };
}
