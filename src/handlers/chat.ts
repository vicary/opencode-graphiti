import type { Hooks } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import type { GraphitiClient } from "../services/client.ts";
import { calculateInjectionBudget } from "../services/context-limit.ts";
import { formatMemoryContext } from "../services/context.ts";
import { logger } from "../services/logger.ts";
import type { SessionManager } from "../session.ts";
import { extractTextFromParts } from "../utils.ts";

type ChatMessageHook = NonNullable<Hooks["chat.message"]>;
type ChatMessageInput = Parameters<ChatMessageHook>[0];
type ChatMessageOutput = Parameters<ChatMessageHook>[1];

/** Dependencies for the chat message handler. */
export interface ChatHandlerDeps {
  sessionManager: SessionManager;
  injectionInterval: number;
  client: GraphitiClient;
}

/** Creates the `chat.message` hook handler. */
export function createChatHandler(deps: ChatHandlerDeps) {
  const { sessionManager, injectionInterval, client } = deps;

  const removeSyntheticMemoryParts = (parts: Part[]): Part[] =>
    parts.filter((part) => {
      if (part.type !== "text") return true;
      if (part.id?.startsWith("graphiti-memory-")) return false;
      if (part.id?.startsWith("graphiti-refresh-")) return false;

      return true;
    });

  const injectMemoryContext = async (
    state: {
      groupId: string;
      userGroupId: string;
      contextLimit: number;
    },
    messageText: string,
    output: ChatMessageOutput,
    prefix: string,
    useUserScope: boolean,
    characterBudget: number,
    shouldReinject: boolean,
  ) => {
    const userGroupId = state.userGroupId;
    const projectFactsPromise = client.searchFacts({
      query: messageText,
      groupIds: [state.groupId],
      maxFacts: 50,
    });
    const projectNodesPromise = client.searchNodes({
      query: messageText,
      groupIds: [state.groupId],
      maxNodes: 30,
    });
    const userFactsPromise = useUserScope && userGroupId
      ? client.searchFacts({
        query: messageText,
        groupIds: [userGroupId],
        maxFacts: 20,
      })
      : Promise.resolve([]);
    const userNodesPromise = useUserScope && userGroupId
      ? client.searchNodes({
        query: messageText,
        groupIds: [userGroupId],
        maxNodes: 10,
      })
      : Promise.resolve([]);

    const [projectFacts, projectNodes, userFacts, userNodes] = await Promise
      .all([
        projectFactsPromise,
        projectNodesPromise,
        userFactsPromise,
        userNodesPromise,
      ]);

    const projectContext = formatMemoryContext(projectFacts, projectNodes);
    const userContext = formatMemoryContext(userFacts, userNodes);
    if (!projectContext && !userContext) return;

    const projectBudget = useUserScope
      ? Math.floor(characterBudget * 0.7)
      : characterBudget;
    const userBudget = characterBudget - projectBudget;
    const truncatedProject = projectContext.slice(0, projectBudget);
    const truncatedUser = useUserScope ? userContext.slice(0, userBudget) : "";
    const memoryContext = [truncatedProject, truncatedUser]
      .filter((section) => section.trim().length > 0)
      .join("\n\n")
      .slice(0, characterBudget);
    if (!memoryContext) return;

    if ("system" in output.message) {
      try {
        output.message.system = memoryContext;
        return;
      } catch (_err) {
        // Fall through to synthetic injection.
      }
    }

    if (shouldReinject) {
      output.parts = removeSyntheticMemoryParts(output.parts);
    }

    {
      output.parts.unshift({
        type: "text",
        text: memoryContext,
        id: `${prefix}${Date.now()}`,
        sessionID: output.message.sessionID,
        messageID: output.message.id,
        synthetic: true,
      } as Part);
    }
    logger.info(
      `Injected ${projectFacts.length + userFacts.length} facts and ${
        projectNodes.length + userNodes.length
      } nodes`,
    );
  };

  return async ({ sessionID }: ChatMessageInput, output: ChatMessageOutput) => {
    if (await sessionManager.isSubagentSession(sessionID)) {
      logger.debug("Ignoring subagent chat message:", sessionID);
      return;
    }
    const { state, resolved } = await sessionManager.resolveSessionState(
      sessionID,
    );
    if (!resolved) {
      logger.debug("Unable to resolve session for message:", { sessionID });
      return;
    }

    if (!state?.isMain) {
      logger.debug("Ignoring subagent chat message:", sessionID);
      return;
    }

    state.messageCount++;
    const messageText = extractTextFromParts(output.parts);
    if (!messageText) return;

    state.pendingMessages.push(`User: ${messageText}`);
    logger.info("Buffered user message", {
      hook: "chat.message",
      sessionID,
      messageLength: messageText.length,
    });

    const shouldInjectOnFirst = !state.injectedMemories;
    const shouldReinject = !shouldInjectOnFirst &&
      injectionInterval > 0 &&
      (state.messageCount - state.lastInjectionMessageCount) >=
        injectionInterval;
    if (!shouldInjectOnFirst && !shouldReinject) return;

    try {
      const prefix = shouldReinject ? "graphiti-refresh-" : "graphiti-memory-";
      const useUserScope = shouldInjectOnFirst;
      const characterBudget = calculateInjectionBudget(state.contextLimit);
      await injectMemoryContext(
        state,
        messageText,
        output,
        prefix,
        useUserScope,
        characterBudget,
        shouldReinject,
      );
      state.injectedMemories = true;
      state.lastInjectionMessageCount = state.messageCount;
    } catch (err) {
      logger.error("Failed to inject memories:", err);
    }
  };
}
