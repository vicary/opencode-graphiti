export const READ_GUIDANCE =
  "Use Read only for a narrow, known file slice; prefer targeted reads over broad transcript-heavy file dumps.";

export const GREP_GUIDANCE =
  "Use Grep to locate exact matches first, then follow with the smallest Read needed for the matched lines.";

export const BASH_GUIDANCE =
  "Use ordinary Bash only for execution-oriented shell work; prefer Read, Grep, and Glob for file inspection to avoid noisy output.";

export const ROUTING_BLOCK = `Routing note: prefer bounded tool usage.
- Use Read for targeted file slices, not broad dumps.
- Use Grep before Read when searching content.
- Use ordinary Bash for execution work, not codebase inspection.
- Keep tool output as small and task-focused as possible.`;

export type ToolGuidanceType = "read" | "grep" | "bash";

export const TOOL_GUIDANCE_TEXT: Record<ToolGuidanceType, string> = {
  read: READ_GUIDANCE,
  grep: GREP_GUIDANCE,
  bash: BASH_GUIDANCE,
};

export type ContextGuidanceOutcome = {
  decision: "context";
  guidanceType: ToolGuidanceType;
  guidance: string;
  sdkVisible: {
    argsMutation: "none";
    immediateDelivery: "no-op";
  };
  continuity: {
    recordRoutingNudge: true;
    injectVia: "session_memory_next_turn";
  };
};

/**
 * Implementation refinement of plans/ContextOverhaul.md §5.2:
 * `context` guidance remains a no-op for the current SDK-visible tool call, but
 * is still materialized as a compact routing outcome so the normal
 * `<session_memory>` continuity path can inject the once-per-session nudge on
 * the next model turn. This refines delivery timing only; it does not change
 * the plan's hot-path semantics.
 */
export const createContextGuidanceOutcome = (
  guidanceType: ToolGuidanceType,
): ContextGuidanceOutcome => ({
  decision: "context",
  guidanceType,
  guidance: TOOL_GUIDANCE_TEXT[guidanceType],
  sdkVisible: {
    argsMutation: "none",
    immediateDelivery: "no-op",
  },
  continuity: {
    recordRoutingNudge: true,
    injectVia: "session_memory_next_turn",
  },
});
