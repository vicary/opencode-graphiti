import {
  BASH_GUIDANCE,
  createContextGuidanceOutcome,
  GREP_GUIDANCE,
  READ_GUIDANCE,
  ROUTING_BLOCK,
  type ToolGuidanceType,
} from "./tool-guidance.ts";

export type RoutingDecision =
  | { action: "allow"; reason: string }
  | { action: "modify"; args: Record<string, unknown>; reason: string }
  | { action: "deny"; guidance: string; reason: string }
  | {
    action: "context";
    guidance: string;
    guidanceType: ToolGuidanceType;
    reason: string;
    sdkVisible: {
      argsMutation: "none";
      immediateDelivery: "no-op";
    };
    continuity: {
      recordRoutingNudge: true;
      injectVia: "session_memory_next_turn";
    };
  };

export interface GuidanceThrottle {
  shouldEmit(sessionId: string, guidanceType: ToolGuidanceType): boolean;
}

export interface RouteToolCallInput {
  canonicalSessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  guidanceThrottle: GuidanceThrottle;
}

const TASK_PROMPT_FIELDS = [
  "prompt",
  "request",
  "objective",
  "question",
  "query",
  "task",
] as const;

const withRoutingBlock = (value: string): string =>
  value.includes(ROUTING_BLOCK) ? value : `${value.trim()}\n\n${ROUTING_BLOCK}`;

const buildGuidanceCommand = (details: string): string => {
  const message = `${ROUTING_BLOCK}\n${details}`.replaceAll("'", "'\\''");
  return `printf '%s\n' '${message}'`;
};

const asCommand = (args: Record<string, unknown>): string => {
  const command = args.command;
  return typeof command === "string" ? command : "";
};

const contextDecision = (
  guidanceType: ToolGuidanceType,
  reason: string,
): RoutingDecision => {
  const outcome = createContextGuidanceOutcome(guidanceType);
  return {
    action: "context",
    guidance: outcome.guidance,
    guidanceType: outcome.guidanceType,
    reason,
    sdkVisible: outcome.sdkVisible,
    continuity: outcome.continuity,
  };
};

const routeRead = (
  canonicalSessionId: string,
  guidanceThrottle: GuidanceThrottle,
): RoutingDecision => {
  if (guidanceThrottle.shouldEmit(canonicalSessionId, "read")) {
    return contextDecision("read", "read-guidance");
  }
  return { action: "allow", reason: "read-allow" };
};

const routeGrep = (
  canonicalSessionId: string,
  guidanceThrottle: GuidanceThrottle,
): RoutingDecision => {
  if (guidanceThrottle.shouldEmit(canonicalSessionId, "grep")) {
    return contextDecision("grep", "grep-guidance");
  }
  return { action: "allow", reason: "grep-allow" };
};

const routeWebFetch = (): RoutingDecision => ({
  action: "deny",
  reason: "webfetch-denied",
  guidance:
    "WebFetch is blocked. Use session_fetch_and_index to fetch the URL, then session_search to query the fetched content.",
});

const routeBash = (
  canonicalSessionId: string,
  args: Record<string, unknown>,
  guidanceThrottle: GuidanceThrottle,
): RoutingDecision => {
  const command = asCommand(args);
  const normalized = command.toLowerCase();

  if (/\b(curl|wget)\b/.test(normalized)) {
    return {
      action: "modify",
      reason: "bash-network-rewrite",
      args: {
        ...args,
        command: buildGuidanceCommand(
          "Avoid raw network shell fetches here; use the safer fetch/search path instead.",
        ),
      },
    };
  }

  if (
    /https?:\/\//.test(normalized) ||
    /\bfetch\s*\(/.test(normalized) ||
    /axios\./.test(normalized) ||
    /requests\.(get|post|put|patch|delete)\s*\(/.test(normalized)
  ) {
    return {
      action: "modify",
      reason: "bash-inline-http-rewrite",
      args: {
        ...args,
        command: buildGuidanceCommand(
          "Avoid inline HTTP clients in Bash here; use a bounded fetch/search path instead.",
        ),
      },
    };
  }

  if (/\b(gradle|gradlew|mvn|mvnw)\b/.test(normalized)) {
    return {
      action: "modify",
      reason: "bash-build-rewrite",
      args: {
        ...args,
        command: buildGuidanceCommand(
          "Avoid high-volume build-tool output in ordinary Bash; use a safer bounded execution path.",
        ),
      },
    };
  }

  if (guidanceThrottle.shouldEmit(canonicalSessionId, "bash")) {
    return contextDecision("bash", "bash-guidance");
  }

  return { action: "allow", reason: "bash-allow" };
};

const routeTask = (args: Record<string, unknown>): RoutingDecision => {
  for (const field of TASK_PROMPT_FIELDS) {
    const value = args[field];
    if (typeof value !== "string" || value.trim().length === 0) continue;
    return {
      action: "modify",
      reason: "task-routing-block",
      args: {
        ...args,
        [field]: withRoutingBlock(value),
      },
    };
  }

  return { action: "allow", reason: "task-allow" };
};

export const routeToolCall = ({
  canonicalSessionId,
  toolName,
  args,
  guidanceThrottle,
}: RouteToolCallInput): RoutingDecision => {
  switch (toolName.toLowerCase()) {
    case "read":
      return routeRead(canonicalSessionId, guidanceThrottle);
    case "webfetch":
      return routeWebFetch();
    case "bash":
      return routeBash(canonicalSessionId, args, guidanceThrottle);
    case "grep":
      return routeGrep(canonicalSessionId, guidanceThrottle);
    case "glob":
      return { action: "allow", reason: "glob-allow" };
    case "task":
      return routeTask(args);
    default:
      return { action: "allow", reason: "unknown-tool-allow" };
  }
};

export { BASH_GUIDANCE, GREP_GUIDANCE, READ_GUIDANCE };
