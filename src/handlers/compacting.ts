import type { Hooks } from "@opencode-ai/plugin";
import { logger } from "../services/logger.ts";
import type { SessionManager } from "../session.ts";

type CompactingHook = NonNullable<Hooks["experimental.session.compacting"]>;
type CompactingInput = Parameters<CompactingHook>[0];
type CompactingOutput = Parameters<CompactingHook>[1];

export interface CompactingHandlerDeps {
  sessionManager: SessionManager;
}

export function createCompactingHandler(
  deps: CompactingHandlerDeps,
): CompactingHook {
  const { sessionManager } = deps;

  return async (
    { sessionID }: CompactingInput,
    output: CompactingOutput,
  ) => {
    try {
      const {
        state,
        resolved,
        canonicalSessionId,
      } = await sessionManager.resolveSessionState(sessionID);
      if (!resolved || !canonicalSessionId) return;
      if (!state?.isMain) return;
      sessionManager.markResolvedSessionActive(sessionID, canonicalSessionId);

      const prepared = await sessionManager.prepareInjection(
        canonicalSessionId,
        undefined,
        { forCompaction: true },
      );
      if (!prepared?.envelope) return;
      output.context.push(prepared.envelope);
      sessionManager.clearPendingInjection(state, prepared);
      logger.info("Injected local memory into compaction context", {
        sessionID: canonicalSessionId,
        sourceSessionID: sessionID,
        hotTierReady: state.hotTierReady,
      });
    } catch (error) {
      logger.warn("Unable to prepare local memory for compaction", {
        sessionID,
        error,
      });
    }
  };
}
