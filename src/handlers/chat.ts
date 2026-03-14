import type { Hooks } from "@opencode-ai/plugin";
import type { GraphitiAsyncService } from "../services/graphiti-async.ts";
import { extractStructuredEvents } from "../services/event-extractor.ts";
import type { RedisEventsService } from "../services/redis-events.ts";
import { logger } from "../services/logger.ts";
import type { SessionManager } from "../session.ts";
import { extractTextFromParts } from "../utils.ts";

type ChatMessageHook = NonNullable<Hooks["chat.message"]>;
type ChatMessageInput = Parameters<ChatMessageHook>[0];
type ChatMessageOutput = Parameters<ChatMessageHook>[1];

export interface ChatHandlerDeps {
  sessionManager: SessionManager;
  redisEvents: RedisEventsService;
  graphitiAsync: GraphitiAsyncService;
  drainTriggerSize: number;
}

export function createChatHandler(deps: ChatHandlerDeps) {
  const { sessionManager, redisEvents, graphitiAsync, drainTriggerSize } = deps;

  return async ({ sessionID }: ChatMessageInput, output: ChatMessageOutput) => {
    sessionManager.markSessionActive(sessionID);
    const { state, resolved } = await sessionManager.resolveSessionState(
      sessionID,
    );
    if (!resolved || !state?.isMain) return;

    const messageText = extractTextFromParts(output.parts);
    if (!messageText) return;

    state.messageCount += 1;
    state.latestUserRequest = messageText;
    state.latestRefreshQuery = messageText;
    state.pendingMessages.push(`User: ${messageText}`);

    let queueLength = 0;
    for (
      const event of extractStructuredEvents({
        eventType: "chat.message",
        sessionId: sessionID,
        messageText,
        messageCount: state.messageCount,
        role: "user",
      })
    ) {
      queueLength = await redisEvents.recordEvent(
        sessionID,
        state.groupId,
        event,
      );
    }

    const prepared = await sessionManager.prepareInjection(
      sessionID,
      messageText,
    );
    if (prepared) {
      state.injectedMemories = true;
    }
    logger.info("Prepared local session memory for chat transform", {
      sessionID,
      hotTierReady: state.hotTierReady,
      refreshClassification: prepared?.refreshDecision.classification,
    });

    if (prepared && prepared.refreshDecision.shouldRefresh) {
      graphitiAsync.scheduleCacheRefresh(state.groupId, messageText);
    }
    if (queueLength >= drainTriggerSize) {
      graphitiAsync.scheduleDrain(state.groupId);
    }
  };
}
