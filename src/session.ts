import type { OpencodeClient } from "@opencode-ai/sdk";
import { DEFAULT_CONTEXT_LIMIT } from "./services/constants.ts";
import { logger } from "./services/logger.ts";
import type { RedisCacheService } from "./services/redis-cache.ts";
import type { RedisEventsService } from "./services/redis-events.ts";
import {
  escapeXml,
  renderXmlListSection,
  uniqueValues,
} from "./services/render-utils.ts";
import type { RedisSnapshotService } from "./services/redis-snapshot.ts";
import {
  getSessionEventPrimaryText,
  type PreparedSessionMemory,
  type SessionEvent,
} from "./types/index.ts";

const findLatestUserRequest = (
  events: SessionEvent[],
  fallback?: string,
): string => {
  const lastUser = events.findLast((event) => event.role === "user");
  return lastUser
    ? getSessionEventPrimaryText(lastUser, fallback)
    : fallback ?? "";
};

const RECENT_BASELINE_LIMIT = 20;
const RECALL_RESULT_LIMIT = 12;

const mergeSessionEvents = (
  recentEvents: SessionEvent[],
  recalledEvents: SessionEvent[],
): SessionEvent[] => {
  const merged = new Map<string, SessionEvent>();
  for (const event of [...recentEvents, ...recalledEvents]) {
    if (!merged.has(event.id)) merged.set(event.id, event);
  }
  return [...merged.values()].sort((left, right) => {
    if (left.ts !== right.ts) return left.ts - right.ts;
    return left.id.localeCompare(right.id);
  });
};

const collectRecentUniqueValues = (
  events: SessionEvent[],
  collect: (event: SessionEvent) => string | string[] | null | undefined,
  limit: number,
): string[] =>
  uniqueValues(
    events.flatMap((event) => {
      const value = collect(event);
      if (value === null || value === undefined) return [];
      return Array.isArray(value) ? value : [value];
    }).reverse(),
    limit,
  );

export type SessionState = {
  groupId: string;
  userGroupId: string;
  injectedMemories: boolean;
  lastInjectionFactUuids: string[];
  visibleFactUuids: string[];
  messageCount: number;
  pendingMessages: string[];
  contextLimit: number;
  isMain: boolean;
  hotTierReady: boolean;
  latestUserRequest?: string;
  latestRefreshQuery?: string;
  pendingInjection?: PreparedSessionMemory;
  pendingInjectionGeneration: number;
};

type TimerHandle = ReturnType<typeof setTimeout> | number;

export interface SessionManagerOptions {
  idleRetentionMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
}

type SessionLifecycle = {
  activityGeneration: number;
  idleCleanupTimer: TimerHandle | null;
};

export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private parentIdCache = new Map<string, string | null>();
  private pendingAssistantMessages = new Map<
    string,
    { sessionId: string; text: string }
  >();
  private bufferedAssistantMessageIds = new Set<string>();
  private sessionLifecycles = new Map<string, SessionLifecycle>();
  private readonly idleRetentionMs: number;
  private readonly setTimerImpl: (
    callback: () => void,
    delayMs: number,
  ) => TimerHandle;
  private readonly clearTimerImpl: (timer: TimerHandle) => void;

  constructor(
    private readonly defaultGroupId: string,
    private readonly defaultUserGroupId: string,
    private readonly sdkClient: OpencodeClient,
    private readonly redisEvents: RedisEventsService,
    private readonly redisSnapshot: RedisSnapshotService,
    private readonly redisCache: RedisCacheService,
    options: SessionManagerOptions = {},
  ) {
    this.idleRetentionMs = Math.max(0, options.idleRetentionMs ?? 0);
    this.setTimerImpl = options.setTimer ??
      ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimerImpl = options.clearTimer ??
      ((timer) => clearTimeout(timer));
  }

  createDefaultState(groupId: string, userGroupId: string): SessionState {
    return {
      groupId,
      userGroupId,
      injectedMemories: false,
      lastInjectionFactUuids: [],
      visibleFactUuids: [],
      messageCount: 0,
      pendingMessages: [],
      contextLimit: DEFAULT_CONTEXT_LIMIT,
      isMain: true,
      hotTierReady: false,
      latestUserRequest: undefined,
      latestRefreshQuery: undefined,
      pendingInjection: undefined,
      pendingInjectionGeneration: 0,
    };
  }

  getState(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  setState(sessionId: string, state: SessionState): void {
    this.sessions.set(sessionId, state);
  }

  markSessionActive(sessionId: string): void {
    const lifecycle = this.getLifecycle(sessionId);
    lifecycle.activityGeneration += 1;
    if (lifecycle.idleCleanupTimer !== null) {
      this.clearTimerImpl(lifecycle.idleCleanupTimer);
      lifecycle.idleCleanupTimer = null;
    }
  }

  captureIdleCleanupGeneration(sessionId: string): number | null {
    const state = this.sessions.get(sessionId);
    if (!state?.isMain) return null;
    return this.getLifecycle(sessionId).activityGeneration;
  }

  scheduleIdleSessionCleanup(
    sessionId: string,
    expectedActivityGeneration?: number,
  ): void {
    const state = this.sessions.get(sessionId);
    if (!state?.isMain) {
      this.deleteSession(sessionId);
      return;
    }

    const lifecycle = this.getLifecycle(sessionId);
    if (
      expectedActivityGeneration !== undefined &&
      lifecycle.activityGeneration !== expectedActivityGeneration
    ) {
      return;
    }

    if (this.idleRetentionMs <= 0) {
      this.deleteSession(sessionId);
      return;
    }

    if (lifecycle.idleCleanupTimer !== null) {
      this.clearTimerImpl(lifecycle.idleCleanupTimer);
      lifecycle.idleCleanupTimer = null;
    }

    const activityGeneration = expectedActivityGeneration ??
      lifecycle.activityGeneration;
    const timerHandle = this.setTimerImpl(() => {
      const currentLifecycle = this.sessionLifecycles.get(sessionId);
      if (!currentLifecycle) return;
      if (currentLifecycle.idleCleanupTimer !== timerHandle) return;
      if (currentLifecycle.activityGeneration !== activityGeneration) return;
      this.deleteSession(sessionId);
    }, this.idleRetentionMs);

    lifecycle.idleCleanupTimer = timerHandle;
  }

  setParentId(sessionId: string, parentId: string | null): void {
    this.parentIdCache.set(sessionId, parentId);
  }

  async resolveParentId(
    sessionId: string,
  ): Promise<string | null | undefined> {
    if (this.parentIdCache.has(sessionId)) {
      return this.parentIdCache.get(sessionId) ?? null;
    }
    try {
      const response = await this.sdkClient.session.get({
        path: { id: sessionId },
      });
      const sessionInfo = typeof response === "object" && response !== null &&
          "data" in response
        ? (response as { data?: { parentID?: string } }).data
        : (response as { parentID?: string });
      if (!sessionInfo) return undefined;
      const parentId = sessionInfo.parentID ?? null;
      this.parentIdCache.set(sessionId, parentId);
      return parentId;
    } catch (err) {
      logger.debug("Failed to resolve session parentID", { sessionId, err });
      return undefined;
    }
  }

  async resolveSessionState(
    sessionId: string,
  ): Promise<{ state: SessionState | null; resolved: boolean }> {
    const parentId = await this.resolveParentId(sessionId);
    if (parentId === undefined) return { state: null, resolved: false };
    if (parentId) {
      this.deleteSession(sessionId);
      return { state: null, resolved: true };
    }

    let state = this.sessions.get(sessionId);
    if (!state) {
      state = this.createDefaultState(
        this.defaultGroupId,
        this.defaultUserGroupId,
      );
      this.sessions.set(sessionId, state);
    }
    return { state, resolved: true };
  }

  bufferAssistantPart(
    sessionId: string,
    messageId: string,
    text: string,
  ): void {
    const key = `${sessionId}:${messageId}`;
    this.pendingAssistantMessages.set(key, { sessionId, text });
  }

  isAssistantBuffered(sessionId: string, messageId: string): boolean {
    return this.bufferedAssistantMessageIds.has(`${sessionId}:${messageId}`);
  }

  finalizeAssistantMessage(
    state: SessionState,
    sessionId: string,
    messageId: string,
    source: string,
  ): string | null {
    const key = `${sessionId}:${messageId}`;
    if (this.bufferedAssistantMessageIds.has(key)) return null;

    const buffered = this.pendingAssistantMessages.get(key);
    this.pendingAssistantMessages.delete(key);
    this.bufferedAssistantMessageIds.add(key);

    const messageText = buffered?.text?.trim() ?? "";
    if (!messageText) return null;
    state.pendingMessages.push(`Assistant: ${messageText}`);
    logger.info("Assistant message completed", {
      hook: source,
      sessionId,
      messageID: messageId,
      messageLength: messageText.length,
    });
    return messageText;
  }

  deletePendingAssistant(sessionId: string, messageId: string): void {
    this.pendingAssistantMessages.delete(`${sessionId}:${messageId}`);
  }

  async prepareInjection(
    sessionId: string,
    lastRequest?: string,
    visibleFactUuids?: string[],
  ): Promise<PreparedSessionMemory | null> {
    const state = this.sessions.get(sessionId);
    if (!state?.isMain) return null;
    const generation = state.pendingInjectionGeneration + 1;
    state.pendingInjectionGeneration = generation;

    const [recentEvents, snapshot, cache, cacheMeta] = await Promise.all([
      this.redisEvents.getRecentSessionEvents(
        sessionId,
        RECENT_BASELINE_LIMIT,
        true,
      ),
      this.redisSnapshot.getSnapshot(sessionId),
      this.redisCache.get(state.groupId),
      this.redisCache.getMeta(state.groupId),
    ]);

    const latestRequest = findLatestUserRequest(
      recentEvents,
      lastRequest ?? state.latestUserRequest ?? state.latestRefreshQuery ??
        cacheMeta?.lastQuery,
    );
    const recalledEvents = latestRequest
      ? await this.redisEvents.recallSessionEvents(sessionId, latestRequest, {
        resultLimit: RECALL_RESULT_LIMIT,
      })
      : [];
    const events = mergeSessionEvents(recentEvents, recalledEvents);
    const activeTasks = collectRecentUniqueValues(
      events,
      (event) =>
        ["task.create", "task.update", "intent"].includes(event.category)
          ? getSessionEventPrimaryText(event)
          : null,
      4,
    );
    const decisions = collectRecentUniqueValues(
      events,
      (event) =>
        ["decision", "preference"].includes(event.category)
          ? getSessionEventPrimaryText(event)
          : null,
      5,
    );
    const files = collectRecentUniqueValues(
      events,
      (event) => event.category.startsWith("file.") ? event.refs ?? [] : [],
      6,
    );
    const rules = collectRecentUniqueValues(
      events,
      (event) =>
        event.category === "rule.load"
          ? getSessionEventPrimaryText(event)
          : null,
      6,
    );
    const unresolvedErrors = collectRecentUniqueValues(
      events,
      (event) =>
        event.category === "error" && event.metadata?.resolved !== true
          ? getSessionEventPrimaryText(event)
          : null,
      4,
    );
    const gitState = collectRecentUniqueValues(
      events,
      (event) =>
        event.category === "git.activity"
          ? getSessionEventPrimaryText(event)
          : null,
      4,
    );
    const subagentWork = collectRecentUniqueValues(
      events,
      (event) =>
        event.category === "subagent.start" ||
          event.category === "subagent.finish"
          ? getSessionEventPrimaryText(event)
          : null,
      4,
    );
    const persistent = this.redisCache.renderPersistentMemory(
      cache,
      visibleFactUuids ?? state.visibleFactUuids,
    );
    const refreshDecision = this.redisCache.classifyRefresh(
      cache,
      latestRequest,
    );

    const sections = [
      `<last_request>${escapeXml(latestRequest)}</last_request>`,
      renderXmlListSection(
        "active_tasks",
        "task",
        activeTasks.length > 0
          ? activeTasks
          : latestRequest
          ? [latestRequest]
          : [],
        { itemCharLimit: 280, includeEmpty: true },
      ),
      renderXmlListSection("key_decisions", "decision", decisions, {
        itemCharLimit: 280,
        includeEmpty: true,
      }),
      renderXmlListSection("files_in_play", "file", files, {
        itemCharLimit: 280,
        includeEmpty: true,
      }),
      renderXmlListSection("project_rules", "rule", rules, {
        itemCharLimit: 280,
        includeEmpty: true,
      }),
      unresolvedErrors.length > 0
        ? renderXmlListSection("unresolved_errors", "error", unresolvedErrors, {
          itemCharLimit: 280,
        })
        : "",
      gitState.length > 0
        ? renderXmlListSection("git_state", "item", gitState, {
          itemCharLimit: 280,
        })
        : "",
      subagentWork.length > 0
        ? renderXmlListSection("subagent_work", "item", subagentWork, {
          itemCharLimit: 280,
        })
        : "",
      snapshot ? `<session_snapshot>${snapshot}</session_snapshot>` : "",
      persistent.body
        ? `<persistent_memory fact_uuids="${
          escapeXml(persistent.factUuids.join(","))
        }" node_refs="${
          escapeXml(persistent.nodeRefs.join(","))
        }">${persistent.body}</persistent_memory>`
        : "",
    ].filter(Boolean);

    const envelope =
      `<session_memory source="falkordb+graphiti-cache" version="1">${
        sections.join("")
      }</session_memory>`;
    const prepared = {
      envelope,
      factUuids: persistent.factUuids,
      nodeRefs: persistent.nodeRefs,
      refreshDecision,
    };

    const currentState = this.sessions.get(sessionId);
    if (currentState !== state || !currentState.isMain) return null;
    if (state.pendingInjectionGeneration !== generation) return null;

    state.pendingInjection = prepared;
    state.lastInjectionFactUuids = persistent.factUuids;
    state.hotTierReady = true;
    state.latestRefreshQuery = latestRequest || cacheMeta?.lastQuery;
    return prepared;
  }

  deleteSession(sessionId: string): void {
    const lifecycle = this.sessionLifecycles.get(sessionId);
    if (lifecycle?.idleCleanupTimer != null) {
      this.clearTimerImpl(lifecycle.idleCleanupTimer);
    }
    this.sessionLifecycles.delete(sessionId);
    this.sessions.delete(sessionId);
    this.parentIdCache.delete(sessionId);
    const prefix = `${sessionId}:`;
    for (const key of [...this.pendingAssistantMessages.keys()]) {
      if (key.startsWith(prefix)) this.pendingAssistantMessages.delete(key);
    }
    for (const key of [...this.bufferedAssistantMessageIds]) {
      if (key.startsWith(prefix)) this.bufferedAssistantMessageIds.delete(key);
    }
  }

  private getLifecycle(sessionId: string): SessionLifecycle {
    let lifecycle = this.sessionLifecycles.get(sessionId);
    if (!lifecycle) {
      lifecycle = {
        activityGeneration: 0,
        idleCleanupTimer: null,
      };
      this.sessionLifecycles.set(sessionId, lifecycle);
    }
    return lifecycle;
  }
}
