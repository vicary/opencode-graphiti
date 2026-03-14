import type { Hooks } from "@opencode-ai/plugin";
import { logger } from "../services/logger.ts";
import type { SessionManager } from "../session.ts";

type CompactingHook = NonNullable<Hooks["experimental.session.compacting"]>;
type CompactingInput = Parameters<CompactingHook>[0];
type CompactingOutput = Parameters<CompactingHook>[1];

export interface CompactingHandlerDeps {
  sessionManager: SessionManager;
}

export function createCompactingHandler(deps: CompactingHandlerDeps) {
  const { sessionManager } = deps;

  return async (
    { sessionID }: CompactingInput,
    output: CompactingOutput,
  ) => {
    const state = sessionManager.getState(sessionID);
    if (!state?.isMain) return;

    const prepared = await sessionManager.prepareInjection(sessionID);
    if (!prepared?.envelope) return;
    output.context.push(prepared.envelope);
    logger.info("Injected local session_memory into compaction context", {
      sessionID,
      hotTierReady: state.hotTierReady,
    });
  };
}
