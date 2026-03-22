import type { Hooks } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { resolveContextLimit } from "../services/context-limit.ts";
import { extractStructuredEvents } from "../services/event-extractor.ts";
import type { GraphitiAsyncService } from "../services/graphiti-async.ts";
import type { RedisCacheService } from "../services/redis-cache.ts";
import type { RedisEventsService } from "../services/redis-events.ts";
import type { RedisSnapshotService } from "../services/redis-snapshot.ts";
import { logger } from "../services/logger.ts";
import type { SessionManager, SessionState } from "../session.ts";
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

const parseJsonRecord = (
  value: unknown,
): Record<string, unknown> | undefined => {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== "string") return undefined;

  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
};

const buildSessionToolActivity = (
  props: Record<string, unknown>,
): {
  properties: Record<string, unknown>;
  messageText?: string;
} => {
  const tool = asString(props.tool) ?? asString(props.name);
  if (!tool?.startsWith("session_")) {
    return { properties: props };
  }

  const args = asRecord(props.args) ?? {};
  const output = parseJsonRecord(props.output) ?? {};
  const merged = {
    ...props,
    ...output,
    paths: args.paths ?? props.paths,
    path: args.path ?? props.path,
    query: args.query ?? props.query,
    url: args.url ?? props.url,
    command: args.command ?? props.command,
    commands: args.commands ?? props.commands,
  };
  const summary = asString(output.summary) ?? asString(props.summary) ?? tool;

  if (tool === "session_execute_file") {
    const paths = Array.isArray(args.paths)
      ? args.paths.filter((value): value is string => typeof value === "string")
      : [];
    const target = paths.slice(0, 2).join(", ");
    return {
      properties: merged,
      messageText: target
        ? `Read file ${target} — ${summary}`
        : `Read file via ${tool} — ${summary}`,
    };
  }

  if (tool === "session_search") {
    const query = asString(args.query);
    return {
      properties: merged,
      messageText: query
        ? `Searched local corpus for ${query}`
        : "Searched local corpus",
    };
  }

  if (tool === "session_fetch_and_index") {
    const url = asString(args.url) ?? asString(output.fetched_url);
    return {
      properties: merged,
      messageText: url
        ? `Fetched and indexed ${url} — ${summary}`
        : `Fetched and indexed content — ${summary}`,
    };
  }

  if (tool === "session_index") {
    return {
      properties: merged,
      messageText: `Indexed local session content — ${summary}`,
    };
  }

  if (tool === "session_execute") {
    const command = asString(args.command);
    return {
      properties: merged,
      messageText: command ? `${summary} — ${command}` : summary,
    };
  }

  if (tool === "session_batch_execute") {
    const commands = Array.isArray(args.commands)
      ? args.commands
        .map((value) => asRecord(value)?.command)
        .filter((value): value is string => typeof value === "string")
      : [];
    return {
      properties: merged,
      messageText: commands.length > 0
        ? `${summary} — ${commands.slice(0, 2).join("; ")}`
        : summary,
    };
  }

  return { properties: merged, messageText: summary };
};

export function createEventHandler(deps: EventHandlerDeps): EventHook {
  const {
    sessionManager,
    redisEvents,
    redisCache,
    redisSnapshot,
    graphitiAsync,
    sdkClient,
    directory,
  } = deps;

  const contextLimitCache = new Map<
    string,
    number | { value: number; expiresAt?: number }
  >();
  const contextLimitLookupGeneration = new Map<string, number>();
  let nextContextLimitLookupGeneration = 0;
  const clearContextLimitLookupGeneration = (
    sessionId: string,
    generation?: number,
  ): void => {
    if (generation === undefined) {
      contextLimitLookupGeneration.delete(sessionId);
      return;
    }
    if (contextLimitLookupGeneration.get(sessionId) === generation) {
      contextLimitLookupGeneration.delete(sessionId);
    }
  };

  const rebuildSnapshotAndScheduleRefresh = async (
    sessionId: string,
    state: SessionState | null,
  ): Promise<void> => {
    if (!state?.isMain) return;
    const events = await redisEvents.getRecentSessionEvents(
      sessionId,
      40,
      true,
    );
    await redisSnapshot.rebuildAndSave(sessionId, events);
    graphitiAsync.scheduleDrain(state.groupId);
    const refreshQuery = state.latestRefreshQuery ??
      (await redisCache.getMeta(state.groupId))?.lastQuery;
    if (!refreshQuery) return;
    state.latestRefreshQuery = refreshQuery;
    graphitiAsync.scheduleCacheRefresh(state.groupId, refreshQuery);
  };

  const handleSessionLifecycleEvent = async (
    event: EventInput["event"],
  ): Promise<boolean> => {
    if (event.type === "session.created") {
      const info = event.properties.info;
      const sessionId = info.id;
      const parentId = info.parentID ?? null;
      sessionManager.setParentId(sessionId, parentId);
      sessionManager.markSessionActive(sessionId);

      const { state, resolved, canonicalSessionId } = await sessionManager
        .resolveSessionState(sessionId);
      if (!resolved || !state?.isMain || !canonicalSessionId) return true;
      sessionManager.markResolvedSessionActive(sessionId, canonicalSessionId);

      for (
        const structured of extractStructuredEvents({
          eventType: event.type,
          sessionId,
          properties: event.properties as Record<string, unknown>,
          role: "system",
        })
      ) {
        await redisEvents.recordEvent(
          canonicalSessionId,
          state.groupId,
          structured,
        );
      }
      await Promise.all([
        redisEvents.touchSessionEvents(canonicalSessionId),
        redisSnapshot.touchSnapshot(canonicalSessionId),
        redisCache.touch(state.groupId),
      ]);
      if (canonicalSessionId === sessionId) {
        graphitiAsync.schedulePrimer(state.groupId);
      }
      return true;
    }

    if (event.type === "session.idle") {
      const sessionId = event.properties.sessionID;
      const { state, resolved, canonicalSessionId } = await sessionManager
        .resolveSessionState(sessionId);
      if (!resolved || !state?.isMain || !canonicalSessionId) return true;
      const idleGeneration = sessionManager.captureIdleCleanupGeneration(
        canonicalSessionId,
      );
      if (idleGeneration === null) return true;

      await rebuildSnapshotAndScheduleRefresh(canonicalSessionId, state);
      state.hotTierReady = true;
      sessionManager.scheduleIdleSessionCleanup(
        canonicalSessionId,
        idleGeneration,
      );
      return true;
    }

    if (event.type === "session.deleted") {
      const sessionId = (event.properties as unknown as { sessionID: string })
        .sessionID;
      const canonicalSessionId = await sessionManager.resolveCanonicalSessionId(
        sessionId,
      );
      clearContextLimitLookupGeneration(sessionId);
      if (canonicalSessionId) {
        clearContextLimitLookupGeneration(canonicalSessionId);
      }
      if (canonicalSessionId && canonicalSessionId !== sessionId) {
        sessionManager.purgeAssistantBufferSource(sessionId);
      }
      sessionManager.deleteSession(sessionId);
      return true;
    }

    if (event.type === "session.compacted") {
      const sessionId = event.properties.sessionID;
      const { state, resolved, canonicalSessionId } = await sessionManager
        .resolveSessionState(sessionId);
      if (!resolved || !state?.isMain || !canonicalSessionId) return true;

      const structured = extractStructuredEvents({
        eventType: event.type,
        sessionId,
        properties: event.properties as Record<string, unknown>,
        messageText: getCompactionSummary(event.properties),
        role: "system",
      });
      for (const item of structured) {
        await redisEvents.recordEvent(canonicalSessionId, state.groupId, item);
      }
      await rebuildSnapshotAndScheduleRefresh(canonicalSessionId, state);
      return true;
    }

    return false;
  };

  const handleMessageEvent = async (
    event: EventInput["event"],
  ): Promise<boolean> => {
    if (event.type === "message.updated") {
      const info = event.properties.info;
      const sessionId = info.sessionID;
      const { state, resolved, canonicalSessionId } = await sessionManager
        .resolveSessionState(sessionId);
      if (!resolved || !state?.isMain || !canonicalSessionId) return true;
      sessionManager.markResolvedSessionActive(sessionId, canonicalSessionId);

      if (info.role !== "assistant") {
        sessionManager.deletePendingAssistant(canonicalSessionId, info.id);
        return true;
      }

      const time = info.time as { created: number; completed?: number };
      if (!time?.completed) return true;
      if (sessionManager.isAssistantBuffered(canonicalSessionId, info.id)) {
        return true;
      }

      const assistantText = sessionManager.finalizeAssistantMessage(
        state,
        canonicalSessionId,
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
          await redisEvents.recordEvent(
            canonicalSessionId,
            state.groupId,
            structured,
          );
        }
      }

      if (info.tokens && info.providerID && info.modelID) {
        const lookupSessionId = canonicalSessionId;
        const lookupGeneration = ++nextContextLimitLookupGeneration;
        contextLimitLookupGeneration.set(lookupSessionId, lookupGeneration);
        const cleanupSessionIds = new Set<string>([lookupSessionId]);
        void (async () => {
          const limit = await resolveContextLimit(
            info.providerID as string,
            info.modelID as string,
            sdkClient,
            directory,
            contextLimitCache,
          );
          if (
            contextLimitLookupGeneration.get(lookupSessionId) !==
              lookupGeneration
          ) {
            return;
          }
          const currentCanonicalSessionId = await sessionManager
            .resolveCanonicalSessionId(sessionId);
          if (!currentCanonicalSessionId) return;
          cleanupSessionIds.add(currentCanonicalSessionId);
          if (
            currentCanonicalSessionId !== lookupSessionId &&
            (contextLimitLookupGeneration.get(currentCanonicalSessionId) ??
                -1) >
              lookupGeneration
          ) {
            return;
          }
          if (currentCanonicalSessionId !== lookupSessionId) {
            contextLimitLookupGeneration.set(
              currentCanonicalSessionId,
              lookupGeneration,
            );
          }
          if (
            contextLimitLookupGeneration.get(currentCanonicalSessionId) !==
              lookupGeneration
          ) {
            return;
          }
          const currentState = sessionManager.getState(
            currentCanonicalSessionId,
          );
          if (!currentState?.isMain) return;
          currentState.contextLimit = limit;
        })().catch((err) =>
          logger.debug("Failed to resolve context limit", err)
        ).finally(() => {
          for (const lookupSessionId of cleanupSessionIds) {
            clearContextLimitLookupGeneration(
              lookupSessionId,
              lookupGeneration,
            );
          }
        });
      }
      return true;
    }

    if (event.type === "message.part.updated") {
      const part = event.properties.part;
      if (!isTextPart(part)) return true;
      const {
        state,
        resolved,
        canonicalSessionId: resolvedCanonicalSessionId,
      } = await sessionManager.resolveSessionState(part.sessionID);
      const canonicalSessionId = resolvedCanonicalSessionId ?? part.sessionID;
      sessionManager.markResolvedSessionActive(
        part.sessionID,
        canonicalSessionId,
      );
      sessionManager.bufferAssistantPart(
        canonicalSessionId,
        part.messageID,
        part.text,
        part.sessionID,
      );
      if (
        !sessionManager.hasPendingAssistantCompletion(
          canonicalSessionId,
          part.messageID,
        )
      ) {
        return true;
      }

      if (!resolved || !state?.isMain) return true;

      const assistantText = sessionManager.finalizeAssistantMessage(
        state,
        canonicalSessionId,
        part.messageID,
        "message.part.updated",
      );
      if (!assistantText) return true;

      for (
        const structured of extractStructuredEvents({
          eventType: "message.updated",
          sessionId: part.sessionID,
          properties: event.properties as Record<string, unknown>,
          messageText: assistantText,
          role: "assistant",
        })
      ) {
        await redisEvents.recordEvent(
          canonicalSessionId,
          state.groupId,
          structured,
        );
      }
      return true;
    }

    return false;
  };

  const handlePassthroughEvent = async (
    event: EventInput["event"],
  ): Promise<void> => {
    if (!passthroughEventTypes.has(event.type)) return;

    const sessionId = getEventSessionId(event.properties);
    if (!sessionId) return;

    sessionManager.markSessionActive(sessionId);

    const { state, resolved, canonicalSessionId } = await sessionManager
      .resolveSessionState(sessionId);
    if (!resolved || !state?.isMain || !canonicalSessionId) return;
    sessionManager.markResolvedSessionActive(sessionId, canonicalSessionId);

    const normalizedToolActivity = buildSessionToolActivity(
      event.properties as Record<string, unknown>,
    );

    for (
      const structured of extractStructuredEvents({
        eventType: event.type,
        sessionId,
        properties: normalizedToolActivity.properties,
        messageText: normalizedToolActivity.messageText,
      })
    ) {
      await redisEvents.recordEvent(
        canonicalSessionId,
        state.groupId,
        structured,
      );
    }
  };

  return async ({ event }: EventInput) => {
    try {
      if (await handleSessionLifecycleEvent(event)) return;
      if (await handleMessageEvent(event)) return;
      await handlePassthroughEvent(event);
    } catch (err) {
      logger.error("Event handler error", { type: event.type, err });
    }
  };
}
