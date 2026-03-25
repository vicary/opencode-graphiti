import type { Hooks } from "@opencode-ai/plugin";
import type { ToolRoutingOutcomeCache } from "../services/tool-routing-outcome-cache.ts";

type ToolAfterHook = NonNullable<Hooks["tool.execute.after"]>;
type ToolAfterInput = Parameters<ToolAfterHook>[0];
type ToolAfterOutput = Parameters<ToolAfterHook>[1];

export interface ToolAfterHandlerDeps {
  routingOutcomes: ToolRoutingOutcomeCache;
}

const asMetadataRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};

export function createToolAfterHandler(
  deps: ToolAfterHandlerDeps,
): ToolAfterHook {
  return (
    { callID: callId }: ToolAfterInput,
    output: ToolAfterOutput,
  ) => {
    const outcome = deps.routingOutcomes.take(callId);
    if (!outcome) return Promise.resolve();

    output.metadata = {
      ...asMetadataRecord(output.metadata),
      toolRouting: outcome,
    };
    return Promise.resolve();
  };
}
