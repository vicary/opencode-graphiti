import type { Hooks } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { resolveContextLimit } from "../services/context-limit.ts";
import { extractStructuredEvents } from "../services/event-extractor.ts";
import type { GraphitiAsyncService } from "../services/graphiti-async.ts";
import type { RedisCacheService } from "../services/redis-cache.ts";
import type { RedisEventsService } from "../services/redis-events.ts";
import type { RedisSnapshotService } from "../services/redis-snapshot.ts";
import { logger } from "../services/logger.ts";
import type { SessionManager } from "../session.ts";
import { isTextPart } from "../utils.ts";

type EventHook = NonNullable<Hooks["event"]>;
type EventInput = Parameters<EventHook>[0];

export interface EventHandlerDeps {
  sessionManager: SessionManager;
  redisEvents: RedisEventsService;
  redisCache: RedisCacheService;
  redisSnapshot: RedisSnapshotService;
  graphitiAsync: GraphitiAsyncService;
  defaultGroupId: string;
  defaultUserGroupId: string;
  sdkClient: OpencodeClient;
  directory: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const passthroughEventTypes = new Set([
  "task.updated",
  "rules.loaded",
  "environment.updated",
  "subagent.started",
  "subagent.finished",
  "tool.called",
  "tool.completed",
]);

const getEventSessionId = (value: unknown, depth = 0): string | undefined => {
  if (depth > 4) return undefined;

  if (Array.isArray(value)) {
    for (const item of value) {
      const sessionId = getEventSessionId(item, depth + 1);
      if (sessionId) return sessionId;
    }
    return undefined;
  }

  const record = asRecord(value);
  if (!record) return undefined;

  const directSessionId = asString(record.sessionID) ??
    asString(record.sessionId);
  if (directSessionId) return directSessionId;

  for (const nested of Object.values(record)) {
    const sessionId = getEventSessionId(nested, depth + 1);
    if (sessionId) return sessionId;
  }

  return undefined;
};

const getCompactionSummary = (value: unknown): string => {
  const summary = asRecord(value)?.summary;
  return typeof summary === "string" ? summary : "";
};

export function createEventHandler(deps: EventHandlerDeps) {
  const {
    sessionManager,
    redisEvents,
    redisCache,
    redisSnapshot,
    graphitiAsync,
    defaultGroupId,
    defaultUserGroupId,
    sdkClient,
    directory,
  } = deps;

  const contextLimitCache = new Map<string, number>();

  return async ({ event }: EventInput) => {
    try {
      if (event.type === "session.created") {
        const info = event.properties.info;
        const sessionId = info.id;
        const parentId = info.parentID ?? null;
        const isMain = !parentId;
        sessionManager.setParentId(sessionId, parentId);
        sessionManager.markSessionActive(sessionId);

        if (isMain) {
          const nextState = sessionManager.createDefaultState(
            defaultGroupId,
            defaultUserGroupId,
          );
          sessionManager.setState(
            sessionId,
            nextState,
          );
          for (
            const structured of extractStructuredEvents({
              eventType: event.type,
              sessionId,
              properties: event.properties as Record<string, unknown>,
              role: "system",
            })
          ) {
            await redisEvents.recordEvent(
              sessionId,
              defaultGroupId,
              structured,
            );
          }
          await Promise.all([
            redisEvents.touchSessionEvents(sessionId),
            redisSnapshot.touchSnapshot(sessionId),
            redisCache.touch(defaultGroupId),
          ]);
          graphitiAsync.schedulePrimer(defaultGroupId);
        }
        return;
      }

      if (event.type === "session.idle") {
        const sessionId = event.properties.sessionID;
        const { state, resolved } = await sessionManager.resolveSessionState(
          sessionId,
        );
        if (!resolved || !state?.isMain) return;
        const idleGeneration = sessionManager.captureIdleCleanupGeneration(
          sessionId,
        );
        if (idleGeneration === null) return;

        const events = await redisEvents.getRecentSessionEvents(
          sessionId,
          40,
          true,
        );
        await redisSnapshot.rebuildAndSave(sessionId, events);
        state.hotTierReady = true;
        graphitiAsync.scheduleDrain(state.groupId);
        const refreshQuery = state.latestUserRequest ??
          state.latestRefreshQuery ??
          (await redisCache.getMeta(state.groupId))?.lastQuery;
        if (refreshQuery) {
          state.latestRefreshQuery = refreshQuery;
          graphitiAsync.scheduleCacheRefresh(
            state.groupId,
            refreshQuery,
          );
        }
        sessionManager.scheduleIdleSessionCleanup(sessionId, idleGeneration);
        return;
      }

      if (event.type === "session.deleted") {
        const sessionId = (event.properties as unknown as { sessionID: string })
          .sessionID;
        sessionManager.deleteSession(sessionId);
        return;
      }

      if (event.type === "session.compacted") {
        const sessionId = event.properties.sessionID;
        const { state, resolved } = await sessionManager.resolveSessionState(
          sessionId,
        );
        if (!resolved || !state?.isMain) return;

        const structured = extractStructuredEvents({
          eventType: event.type,
          sessionId,
          properties: event.properties as Record<string, unknown>,
          messageText: getCompactionSummary(event.properties),
          role: "system",
        });
        for (const item of structured) {
          await redisEvents.recordEvent(sessionId, state.groupId, item);
        }
        const events = await redisEvents.getRecentSessionEvents(
          sessionId,
          40,
          true,
        );
        await redisSnapshot.rebuildAndSave(
          sessionId,
          events,
        );
        graphitiAsync.scheduleDrain(state.groupId);
        const refreshQuery = state.latestUserRequest ??
          state.latestRefreshQuery ??
          (await redisCache.getMeta(state.groupId))?.lastQuery;
        if (refreshQuery) {
          state.latestRefreshQuery = refreshQuery;
          graphitiAsync.scheduleCacheRefresh(
            state.groupId,
            refreshQuery,
          );
        }
        return;
      }

      if (event.type === "message.updated") {
        const info = event.properties.info;
        const sessionId = info.sessionID;
        sessionManager.markSessionActive(sessionId);
        const { state, resolved } = await sessionManager.resolveSessionState(
          sessionId,
        );
        if (!resolved || !state?.isMain) return;

        if (info.role !== "assistant") {
          sessionManager.deletePendingAssistant(sessionId, info.id);
          return;
        }

        const time = info.time as { created: number; completed?: number };
        if (!time?.completed) return;
        if (sessionManager.isAssistantBuffered(sessionId, info.id)) return;

        const assistantText = sessionManager.finalizeAssistantMessage(
          state,
          sessionId,
          info.id,
          "message.updated",
        );
        if (assistantText) {
          for (
            const structured of extractStructuredEvents({
              eventType: event.type,
              sessionId,
              properties: event.properties as Record<string, unknown>,
              messageText: assistantText,
              role: "assistant",
            })
          ) {
            await redisEvents.recordEvent(sessionId, state.groupId, structured);
          }
        }

        if (info.tokens && info.providerID && info.modelID) {
          const capturedState = state;
          resolveContextLimit(
            info.providerID as string,
            info.modelID as string,
            sdkClient,
            directory,
            contextLimitCache,
          ).then((limit) => {
            capturedState.contextLimit = limit;
          }).catch((err) =>
            logger.debug("Failed to resolve context limit", err)
          );
        }
        return;
      }

      if (event.type === "message.part.updated") {
        const part = event.properties.part;
        if (!isTextPart(part)) return;
        sessionManager.markSessionActive(part.sessionID);
        sessionManager.bufferAssistantPart(
          part.sessionID,
          part.messageID,
          part.text,
        );
        return;
      }

      if (!passthroughEventTypes.has(event.type)) {
        return;
      }

      const sessionId = getEventSessionId(event.properties);
      if (!sessionId) return;

      const { state, resolved } = await sessionManager.resolveSessionState(
        sessionId,
      );
      if (!resolved || !state?.isMain) return;

      for (
        const structured of extractStructuredEvents({
          eventType: event.type,
          sessionId,
          properties: event.properties as Record<string, unknown>,
        })
      ) {
        await redisEvents.recordEvent(sessionId, state.groupId, structured);
      }
    } catch (err) {
      logger.error("Event handler error", { type: event.type, err });
    }
  };
}
