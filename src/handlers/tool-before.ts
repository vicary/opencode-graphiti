import type { Hooks } from "@opencode-ai/plugin";
import type { ToolGuidanceCache } from "../services/tool-guidance-cache.ts";
import {
  routeToolCall as defaultRouteToolCall,
  type RouteToolCallInput,
  type RoutingDecision,
} from "../services/tool-routing.ts";
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
    const canonicalSessionId = await resolveCanonicalSessionId(
      deps.sessionCanonicalizer,
      sessionID,
    );
    const args = toRecord(output.args);
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
        output.args = decision.args;
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
        throw new Error(decision.guidance);
    }
  };
}
