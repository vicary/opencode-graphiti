import type { Hooks } from "@opencode-ai/plugin";
import type { GraphitiAsyncService } from "../services/graphiti-async.ts";
import { extractStructuredEvents } from "../services/event-extractor.ts";
import type { RedisEventsService } from "../services/redis-events.ts";
import { logger } from "../services/logger.ts";
import { sanitizeMemoryInput } from "../services/render-utils.ts";
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

export function createChatHandler(deps: ChatHandlerDeps): ChatMessageHook {
  const { sessionManager, redisEvents, graphitiAsync, drainTriggerSize } = deps;

  return async ({ sessionID }: ChatMessageInput, output: ChatMessageOutput) => {
    try {
      sessionManager.markSessionActive(sessionID);

      const messageText = extractTextFromParts(output.parts);
      if (!messageText) return;
      const sanitizedMessageText = sanitizeMemoryInput(messageText);
      if (!sanitizedMessageText) return;

      const { state, resolved, canonicalSessionId } = await sessionManager
        .resolveSessionState(
          sessionID,
        );
      if (!resolved || !state?.isMain) return;
      if (!canonicalSessionId) return;
      sessionManager.markResolvedSessionActive(sessionID, canonicalSessionId);

      state.messageCount += 1;
      state.latestUserRequest = sanitizedMessageText;
      state.latestRefreshQuery = sanitizedMessageText;

      const queueLength = await redisEvents.recordEvents(
        canonicalSessionId,
        state.groupId,
        extractStructuredEvents({
          eventType: "chat.message",
          sessionId: sessionID,
          messageText: sanitizedMessageText,
          messageCount: state.messageCount,
          role: "user",
        }),
      );

      const prepared = await sessionManager.prepareInjection(
        canonicalSessionId,
        sanitizedMessageText,
      );
      if (prepared) {
        state.injectedMemories = true;
      }
      logger.info("Prepared local memory for chat transform", {
        sessionID: canonicalSessionId,
        sourceSessionID: sessionID,
        hotTierReady: state.hotTierReady,
        refreshClassification: prepared?.refreshDecision.classification,
      });

      if (prepared && prepared.refreshDecision.shouldRefresh) {
        graphitiAsync.scheduleCacheRefresh(state.groupId, sanitizedMessageText);
      }
      if (queueLength >= drainTriggerSize) {
        graphitiAsync.scheduleDrain(state.groupId);
      }
    } catch (error) {
      logger.warn("Unable to prepare local memory for chat transform", {
        sessionID,
        error,
      });
    }
  };
}
