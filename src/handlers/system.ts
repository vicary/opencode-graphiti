import type { Hooks } from "@opencode-ai/plugin";
import { logger } from "../services/logger.ts";
import type { SessionManager } from "../session.ts";

type SystemTransformHook = NonNullable<
  Hooks["experimental.chat.system.transform"]
>;
type SystemTransformInput = Parameters<SystemTransformHook>[0];
type SystemTransformOutput = Parameters<SystemTransformHook>[1];

export interface SystemHandlerDeps {
  sessionManager: SessionManager;
}

export function createSystemHandler(deps: SystemHandlerDeps) {
  const { sessionManager } = deps;

  // Assumes chat.message hook completes before system.transform fires for the same turn.
  // deno-lint-ignore require-await
  return async (
    { sessionID }: SystemTransformInput,
    output: SystemTransformOutput,
  ) => {
    if (!sessionID) return;

    const state = sessionManager.getState(sessionID);
    if (!state?.isMain) return;
    if (!state.cachedMemoryContext) return;

    output.system.push(state.cachedMemoryContext);
    state.cachedMemoryContext = undefined;
    logger.info("Injected memory context into system prompt");
  };
}
