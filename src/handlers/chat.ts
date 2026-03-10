import type { Hooks } from "@opencode-ai/plugin";
import type { GraphitiClient } from "../services/client.ts";
import { calculateInjectionBudget } from "../services/context-limit.ts";
import { PROJECT_MAX_FACTS } from "../services/constants.ts";
import {
  formatMemoryContext,
  resolveProjectUserContext,
} from "../services/context.ts";
import { logger } from "../services/logger.ts";
import type { SessionManager } from "../session.ts";
import { extractTextFromParts, truncateAtLineBoundary } from "../utils.ts";

type ChatMessageHook = NonNullable<Hooks["chat.message"]>;
type ChatMessageInput = Parameters<ChatMessageHook>[0];
type ChatMessageOutput = Parameters<ChatMessageHook>[1];
type SearchFactsResult = Awaited<ReturnType<GraphitiClient["searchFacts"]>>;

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

  /**
   * Fetch project facts (and optionally user facts/nodes) then build and cache
   * the formatted memory context string.
   *
   * Task 8: When `seedProjectFacts` is supplied (from the drift check), those
   * facts are used directly for the project scope so we avoid a redundant
   * second searchFacts query.
   */
  const searchAndCacheMemoryContext = async (
    state: {
      groupId: string;
      userGroupId: string;
      contextLimit: number;
      lastInjectionFactUuids: string[];
      cachedMemoryContext?: string;
      cachedFactUuids?: string[];
      visibleFactUuids?: string[];
    },
    messageText: string,
    useUserScope: boolean,
    characterBudget: number,
    seedProjectFacts?: SearchFactsResult,
  ) => {
    const userGroupId = state.userGroupId;

    // Task 8: reuse drift-check project facts when available; only issue a new
    // project searchFacts call when we don't already have them.
    const projectFactsPromise: Promise<SearchFactsResult> =
      seedProjectFacts != null
        ? Promise.resolve(seedProjectFacts)
        : client.searchFacts({
          query: messageText,
          groupIds: [state.groupId],
          maxFacts: PROJECT_MAX_FACTS,
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

    const {
      projectContext,
      userContext,
      projectFacts,
      projectNodes,
      userFacts,
      userNodes,
    } = await resolveProjectUserContext({
      projectFacts: projectFactsPromise,
      projectNodes: projectNodesPromise,
      userFacts: userFactsPromise,
      userNodes: userNodesPromise,
    });

    const visibleSet = new Set(state.visibleFactUuids ?? []);
    const beforeProjectFacts = projectContext.facts.length;
    const beforeUserFacts = userContext.facts.length;
    projectContext.facts = projectContext.facts.filter((fact) =>
      !visibleSet.has(fact.uuid)
    );
    userContext.facts = userContext.facts.filter((fact) =>
      !visibleSet.has(fact.uuid)
    );
    logger.debug("Filtered visible facts from injection", {
      visibleCount: visibleSet.size,
      filteredProjectFacts: beforeProjectFacts - projectContext.facts.length,
      filteredUserFacts: beforeUserFacts - userContext.facts.length,
      remainingProjectFacts: projectContext.facts.length,
      remainingUserFacts: userContext.facts.length,
    });

    if (
      projectContext.facts.length === 0 &&
      userContext.facts.length === 0 &&
      projectContext.nodes.length === 0 &&
      userContext.nodes.length === 0
    ) {
      logger.debug("All facts filtered; skipping context cache", {
        groupId: state.groupId,
        userGroupId: state.userGroupId,
      });
      return;
    }
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
          // Task 2: truncate snapshot at a line boundary.
          const snapshotBudget = Math.min(characterBudget, 1200);
          const snapshotBody = truncateAtLineBoundary(
            snapshot.content,
            snapshotBudget,
          );
          snapshotPrimer = [
            "## Session Snapshot",
            "> Most recent session snapshot; use to restore active strategy and open questions.",
            "",
            snapshotBody,
          ].join("\n");
        }
      } catch (err) {
        logger.error("Failed to load session snapshot", { err });
      }
    }

    // Task 2: truncate project/user context strings at line boundaries.
    const projectBudget = useUserScope
      ? Math.floor(characterBudget * 0.7)
      : characterBudget;
    const userBudget = characterBudget - projectBudget;
    const truncatedProject = truncateAtLineBoundary(
      projectContextString,
      projectBudget,
    );
    const truncatedUser = useUserScope
      ? truncateAtLineBoundary(userContextString, userBudget)
      : "";

    // Task 2: final combined context also truncated at a line boundary.
    const combined = [snapshotPrimer, truncatedProject, truncatedUser]
      .filter((section) => section.trim().length > 0)
      .join("\n\n");
    const memoryContext = truncateAtLineBoundary(combined, characterBudget);
    if (!memoryContext) return;

    const allFactUuids = [
      ...projectContext.facts.map((fact) => fact.uuid),
      ...userContext.facts.map((fact) => fact.uuid),
    ];
    const factUuids = Array.from(new Set(allFactUuids));
    state.cachedMemoryContext = memoryContext;
    state.cachedFactUuids = factUuids;
    logger.info(
      `Cached ${projectFacts.length + userFacts.length} facts and ${
        projectNodes.length + userNodes.length
      } nodes for user message injection`,
    );
    state.lastInjectionFactUuids = factUuids;
  };

  const computeJaccardSimilarity = (
    left: string[],
    right: string[],
  ): number => {
    if (left.length === 0 && right.length === 0) return 1;
    const leftSet = new Set(left);
    const rightSet = new Set(right);
    let intersection = 0;
    for (const value of leftSet) {
      if (rightSet.has(value)) intersection += 1;
    }
    const union = leftSet.size + rightSet.size - intersection;
    return union === 0 ? 1 : intersection / union;
  };

  return async ({ sessionID }: ChatMessageInput, output: ChatMessageOutput) => {
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

    // Task 8: driftFacts from the drift check are passed into
    // searchAndCacheMemoryContext so the project searchFacts is not repeated.
    let driftProjectFacts: SearchFactsResult | null = null;

    if (!shouldInjectOnFirst) {
      try {
        const fetched = await client.searchFacts({
          query: messageText,
          groupIds: [state.groupId],
          maxFacts: PROJECT_MAX_FACTS,
        });
        driftProjectFacts = fetched;
        const currentFactUuids = fetched.map((fact) => fact.uuid);
        const similarity = computeJaccardSimilarity(
          currentFactUuids,
          state.lastInjectionFactUuids,
        );
        const shouldReinject = similarity < driftThreshold;
        if (!shouldReinject) {
          logger.debug("Skipping reinjection; similarity above threshold", {
            sessionID,
            similarity,
          });
          return;
        }
      } catch (err) {
        logger.error("Failed to check topic drift, skipping reinjection", {
          sessionID,
          err,
        });
        return;
      }
    }

    try {
      const useUserScope = shouldInjectOnFirst;
      const characterBudget = calculateInjectionBudget(state.contextLimit);
      await searchAndCacheMemoryContext(
        state,
        messageText,
        useUserScope,
        characterBudget,
        // Task 8: on reinjection, pass the drift facts so the project query is
        // not duplicated.  On first injection driftProjectFacts is null, which
        // triggers a full maxFacts=PROJECT_MAX_FACTS project search.
        driftProjectFacts ?? undefined,
      );
      state.injectedMemories = true;
    } catch (err) {
      logger.error("Failed to inject memories:", err);
    }
  };
}
