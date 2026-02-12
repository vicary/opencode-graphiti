import type { Hooks } from "@opencode-ai/plugin";
import type { GraphitiClient } from "../services/client.ts";
import { getCompactionContext } from "../services/compaction.ts";
import { calculateInjectionBudget } from "../services/context-limit.ts";
import { logger } from "../services/logger.ts";
import type { SessionManager } from "../session.ts";

type CompactingHook = NonNullable<Hooks["experimental.session.compacting"]>;
type CompactingInput = Parameters<CompactingHook>[0];
type CompactingOutput = Parameters<CompactingHook>[1];

/** Dependencies for the compacting handler. */
export interface CompactingHandlerDeps {
  sessionManager: SessionManager;
  client: GraphitiClient;
  defaultGroupId: string;
}

/** Creates the `experimental.session.compacting` hook handler. */
export function createCompactingHandler(deps: CompactingHandlerDeps) {
  const { sessionManager, client, defaultGroupId } = deps;

  return async (
    { sessionID }: CompactingInput,
    output: CompactingOutput,
  ) => {
    const state = sessionManager.getState(sessionID);
    if (!state?.isMain) {
      logger.debug("Ignoring non-main compaction context:", sessionID);
      return;
    }

    const groupId = state.groupId || defaultGroupId;
    const characterBudget = calculateInjectionBudget(state.contextLimit);
    const additionalContext = await getCompactionContext({
      client,
      characterBudget,
      groupIds: {
        project: groupId,
        user: state.userGroupId,
      },
      contextStrings: output.context,
    });

    if (additionalContext.length > 0) {
      output.context.push(...additionalContext);
      logger.info("Injected persistent knowledge into compaction context");
    }
  };
}
