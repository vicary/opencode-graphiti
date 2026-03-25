import type { ToolGuidanceType } from "./tool-guidance.ts";

export type ToolRoutingOutcome = {
  source: "tool-routing";
  action: "modify" | "deny" | "context";
  reason: string;
  guidanceType?: ToolGuidanceType;
};

export class ToolRoutingOutcomeCache {
  private readonly outcomes = new Map<string, ToolRoutingOutcome>();

  set(callId: string, outcome: ToolRoutingOutcome): void {
    this.outcomes.set(callId, outcome);
  }

  take(callId: string): ToolRoutingOutcome | undefined {
    const outcome = this.outcomes.get(callId);
    this.outcomes.delete(callId);
    return outcome;
  }

  clearAll(): void {
    this.outcomes.clear();
  }
}
