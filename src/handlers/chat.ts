import type { Hooks } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import type { GraphitiClient } from "../services/client.ts";
import { calculateInjectionBudget } from "../services/context-limit.ts";
import {
  deduplicateContext,
  formatMemoryContext,
} from "../services/context.ts";
import { logger } from "../services/logger.ts";
import type { SessionManager } from "../session.ts";
import { extractTextFromParts } from "../utils.ts";

type ChatMessageHook = NonNullable<Hooks["chat.message"]>;
type ChatMessageInput = Parameters<ChatMessageHook>[0];
type ChatMessageOutput = Parameters<ChatMessageHook>[1];

/** Dependencies for the chat message handler. */
export interface ChatHandlerDeps {
  sessionManager: SessionManager;
  driftThreshold: number;
  factStaleDays: number;
  client: GraphitiClient;
}

/** Creates the `chat.message` hook handler. */
export function createChatHandler(deps: ChatHandlerDeps) {
  const { sessionManager, driftThreshold, factStaleDays, client } = deps;

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
      lastInjectionFactUuids: Set<string>;
    },
    messageText: string,
    output: ChatMessageOutput,
    prefix: string,
    useUserScope: boolean,
    characterBudget: number,
    shouldReinject: boolean,
    seedFactUuids?: Set<string> | null,
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

    const projectContext = deduplicateContext({
      facts: projectFacts,
      nodes: projectNodes,
    });
    const userContext = deduplicateContext({
      facts: userFacts,
      nodes: userNodes,
    });
    const projectContextString = formatMemoryContext(
      projectContext.facts,
      projectContext.nodes,
      { factStaleDays },
    );
    const userContextString = formatMemoryContext(
      userContext.facts,
      userContext.nodes,
      { factStaleDays },
    );
    if (!projectContextString && !userContextString) return;

    let snapshotPrimer = "";
    if (useUserScope && characterBudget > 0) {
      try {
        const episodes = await client.getEpisodes({
          groupId: state.groupId,
          lastN: 10,
        });
        const snapshot = episodes
          .filter((episode) => {
            const description = episode.sourceDescription ??
              episode.source_description ?? "";
            return description === "session-snapshot";
          })
          .sort((a, b) => {
            const aTime = a.created_at ? Date.parse(a.created_at) : 0;
            const bTime = b.created_at ? Date.parse(b.created_at) : 0;
            return bTime - aTime;
          })[0];
        if (snapshot?.content) {
          const snapshotBudget = Math.min(characterBudget, 1200);
          snapshotPrimer = [
            '<memory source="snapshot">',
            "<instruction>Most recent session snapshot; use to restore active strategy and open questions.</instruction>",
            `<snapshot>${snapshot.content.slice(0, snapshotBudget)}</snapshot>`,
            "</memory>",
          ].join("\n");
        }
      } catch (err) {
        logger.error("Failed to load session snapshot", { err });
      }
    }

    const projectBudget = useUserScope
      ? Math.floor(characterBudget * 0.7)
      : characterBudget;
    const userBudget = characterBudget - projectBudget;
    const truncatedProject = projectContextString.slice(0, projectBudget);
    const truncatedUser = useUserScope
      ? userContextString.slice(0, userBudget)
      : "";
    const memoryContext = [snapshotPrimer, truncatedProject, truncatedUser]
      .filter((section) => section.trim().length > 0)
      .join("\n\n")
      .slice(0, characterBudget);
    if (!memoryContext) return;

    if (shouldReinject) {
      output.parts = removeSyntheticMemoryParts(output.parts);
    }

    const allFactUuids = seedFactUuids ??
      new Set<string>([
        ...projectContext.facts.map((fact) => fact.uuid),
        ...userContext.facts.map((fact) => fact.uuid),
      ]);

    if ("system" in output.message) {
      try {
        output.message.system = memoryContext;
        return;
      } catch (_err) {
        // Fall through to synthetic injection.
      }
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
    state.lastInjectionFactUuids = allFactUuids;
  };

  const computeJaccardSimilarity = (
    left: Set<string>,
    right: Set<string>,
  ): number => {
    if (left.size === 0 && right.size === 0) return 1;
    let intersection = 0;
    for (const value of left) {
      if (right.has(value)) intersection += 1;
    }
    const union = left.size + right.size - intersection;
    return union === 0 ? 1 : intersection / union;
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
    let shouldReinject = false;

    let currentFactUuids: Set<string> | null = null;
    if (!shouldInjectOnFirst) {
      const driftFacts = await client.searchFacts({
        query: messageText,
        groupIds: [state.groupId],
        maxFacts: 20,
      });
      currentFactUuids = new Set(driftFacts.map((fact) => fact.uuid));
      const similarity = computeJaccardSimilarity(
        currentFactUuids,
        state.lastInjectionFactUuids,
      );
      shouldReinject = similarity < driftThreshold;
      if (!shouldReinject) {
        logger.debug("Skipping reinjection; drift above threshold", {
          sessionID,
          similarity,
        });
        return;
      }
    }

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
        currentFactUuids,
      );
      state.injectedMemories = true;
    } catch (err) {
      logger.error("Failed to inject memories:", err);
    }
  };
}
