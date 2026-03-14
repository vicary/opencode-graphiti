import type { OpencodeClient } from "@opencode-ai/sdk";
import { DEFAULT_CONTEXT_LIMIT } from "./services/constants.ts";
import { logger } from "./services/logger.ts";
import {
  PERSISTENT_MEMORY_BODY_BUDGET,
  type RedisCacheService,
} from "./services/redis-cache.ts";
import type { RedisEventsService } from "./services/redis-events.ts";
import type { RedisSnapshotService } from "./services/redis-snapshot.ts";
import {
  escapeXml,
  normalizeMemoryText,
  renderXmlListSection,
  sanitizeMemoryInput,
  uniqueNormalizedValues,
} from "./services/render-utils.ts";
import {
  getSessionEventPrimaryText,
  type PersistentMemoryCacheEntry,
  type PersistentMemoryCacheMeta,
  type PreparedSessionMemory,
  type SessionEvent,
} from "./types/index.ts";

const findLatestUserRequest = (
  events: SessionEvent[],
): string => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.role !== "user") continue;
    const candidate = sanitizeMemoryInput(getSessionEventPrimaryText(event));
    if (candidate) return candidate;
  }
  return "";
};

const RECENT_BASELINE_LIMIT = 20;
const RECALL_RESULT_LIMIT = 12;

const EXPLICIT_NOT_FOUND_CODES = new Set([
  "not_found",
  "session_not_found",
]);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;

const normalizeErrorToken = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
};

const isExplicitNotFoundCode = (value: unknown): boolean => {
  const normalized = normalizeErrorToken(value);
  return normalized !== null && EXPLICIT_NOT_FOUND_CODES.has(normalized);
};

const isExplicitSessionNotFoundMessage = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  return /\bsession not found\b/i.test(value);
};

const isExplicitSessionNotFoundError = (error: unknown): boolean => {
  const queue: unknown[] = [error];
  const visited = new Set<object>();

  while (queue.length > 0) {
    const current = queue.shift();
    const record = asRecord(current);
    if (!record) continue;
    if (visited.has(record)) continue;
    visited.add(record);

    const status = record.status;
    const statusCode = record.statusCode;
    if (status === 404 || statusCode === 404) return true;

    if (
      isExplicitNotFoundCode(record.code) ||
      isExplicitNotFoundCode(record.errorCode) ||
      isExplicitNotFoundCode(record.type) ||
      isExplicitSessionNotFoundMessage(record.message)
    ) {
      return true;
    }

    queue.push(
      record.cause,
      record.data,
      record.body,
      record.error,
      record.response,
    );
  }

  return false;
};

const mergeSessionEvents = (
  recentEvents: SessionEvent[],
  recalledEvents: SessionEvent[],
): SessionEvent[] => {
  const merged = new Map<string, SessionEvent>();
  for (const event of recentEvents) {
    if (!merged.has(event.id)) merged.set(event.id, event);
  }
  for (const event of recalledEvents) {
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
  excludedNormalized = new Set<string>(),
): string[] =>
  uniqueNormalizedValues(
    events.flatMap((event) => {
      const value = collect(event);
      if (value === null || value === undefined) return [];
      return Array.isArray(value) ? value : [value];
    }).reverse(),
    limit,
    excludedNormalized,
  );

const addNormalizedValues = (target: Set<string>, values: string[]): void => {
  for (const value of values) {
    const normalized = normalizeMemoryText(value);
    if (normalized) target.add(normalized);
  }
};

const filterDuplicateSnapshotLeaves = (
  snapshot: string | null,
  excludedNormalized: Set<string>,
): string => {
  if (!snapshot) return "";
  let filtered = snapshot.replace(
    /<([a-z_]+)>([^<>]*)<\/\1>/gi,
    (match, tag: string, text: string) => {
      if (tag.toLowerCase() === "snapshot") return match;
      const normalized = normalizeMemoryText(text);
      return normalized && excludedNormalized.has(normalized) ? "" : match;
    },
  );
  filtered = filtered.replace(/<(?!snapshot\b)([a-z_]+)>\s*<\/\1>/gi, "");
  return filtered;
};

const collectSectionValues = (
  events: SessionEvent[],
  predicate: (event: SessionEvent) => boolean,
  limit: number,
  excludedNormalized = new Set<string>(),
): string[] =>
  collectRecentUniqueValues(
    events,
    (event) =>
      predicate(event)
        ? sanitizeMemoryInput(getSessionEventPrimaryText(event))
        : null,
    limit,
    excludedNormalized,
  );

const collectPathValues = (
  events: SessionEvent[],
  limit: number,
  excludedNormalized = new Set<string>(),
): string[] =>
  collectRecentUniqueValues(
    events,
    (event) => event.category.startsWith("file.") ? event.refs ?? [] : [],
    limit,
    excludedNormalized,
  );

export type SessionState = {
  groupId: string;
  userGroupId: string;
  injectedMemories: boolean;
  messageCount: number;
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

type PreparedInjectionData = {
  cache: PersistentMemoryCacheEntry | null;
  cacheMeta: PersistentMemoryCacheMeta | null;
  events: SessionEvent[];
  latestRequest: string;
  snapshot: string | null;
};

class AssistantMessageBuffer {
  private pendingMessages = new Map<
    string,
    { sessionId: string; text: string; sourceSessionId: string }
  >();
  private pendingCompletions = new Set<string>();
  private bufferedMessageIds = new Map<string, string>();

  bufferPart(
    sessionId: string,
    messageId: string,
    text: string,
    sourceSessionId = sessionId,
  ): void {
    this.pendingMessages.set(`${sessionId}:${messageId}`, {
      sessionId,
      text,
      sourceSessionId,
    });
  }

  isBuffered(sessionId: string, messageId: string): boolean {
    return this.bufferedMessageIds.has(`${sessionId}:${messageId}`);
  }

  hasPendingCompletion(sessionId: string, messageId: string): boolean {
    return this.pendingCompletions.has(`${sessionId}:${messageId}`);
  }

  finalize(
    sessionId: string,
    messageId: string,
    source: string,
  ): string | null {
    const key = `${sessionId}:${messageId}`;
    if (this.bufferedMessageIds.has(key)) return null;

    const buffered = this.pendingMessages.get(key);
    const messageText = buffered?.text?.trim() ?? "";
    if (!messageText) {
      this.pendingCompletions.add(key);
      return null;
    }

    this.pendingCompletions.delete(key);
    this.pendingMessages.delete(key);
    this.bufferedMessageIds.set(key, buffered?.sourceSessionId ?? sessionId);
    logger.info("Assistant message completed", {
      hook: source,
      sessionId,
      messageID: messageId,
      messageLength: messageText.length,
    });
    return messageText;
  }

  deletePending(sessionId: string, messageId: string): void {
    const key = `${sessionId}:${messageId}`;
    this.pendingMessages.delete(key);
    this.pendingCompletions.delete(key);
  }

  purgeSource(sourceSessionId: string): void {
    for (const [key, buffered] of [...this.pendingMessages.entries()]) {
      if (buffered.sourceSessionId === sourceSessionId) {
        this.pendingMessages.delete(key);
        this.pendingCompletions.delete(key);
      }
    }
    for (
      const [key, bufferedSourceSessionId] of [
        ...this.bufferedMessageIds.entries(),
      ]
    ) {
      if (bufferedSourceSessionId === sourceSessionId) {
        this.bufferedMessageIds.delete(key);
      }
    }
  }

  migrateSession(sessionId: string, canonicalSessionId: string): void {
    const sessionPrefix = `${sessionId}:`;
    for (const [key, buffered] of [...this.pendingMessages.entries()]) {
      if (!key.startsWith(sessionPrefix)) continue;
      const messageId = key.slice(sessionPrefix.length);
      const canonicalKey = `${canonicalSessionId}:${messageId}`;
      if (!this.pendingMessages.has(canonicalKey)) {
        this.pendingMessages.set(canonicalKey, {
          ...buffered,
          sessionId: canonicalSessionId,
        });
      }
      this.pendingMessages.delete(key);
    }

    for (
      const [key, sourceSessionId] of [...this.bufferedMessageIds.entries()]
    ) {
      if (!key.startsWith(sessionPrefix)) continue;
      const messageId = key.slice(sessionPrefix.length);
      const canonicalKey = `${canonicalSessionId}:${messageId}`;
      if (!this.bufferedMessageIds.has(canonicalKey)) {
        this.bufferedMessageIds.set(canonicalKey, sourceSessionId);
      }
      this.bufferedMessageIds.delete(key);
    }

    for (const key of [...this.pendingCompletions]) {
      if (!key.startsWith(sessionPrefix)) continue;
      const messageId = key.slice(sessionPrefix.length);
      this.pendingCompletions.add(`${canonicalSessionId}:${messageId}`);
      this.pendingCompletions.delete(key);
    }
  }

  deleteSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of [...this.pendingMessages.keys()]) {
      if (key.startsWith(prefix)) {
        this.pendingMessages.delete(key);
        this.pendingCompletions.delete(key);
      }
    }
    for (const [key] of [...this.bufferedMessageIds.entries()]) {
      if (key.startsWith(prefix)) this.bufferedMessageIds.delete(key);
    }
    for (const key of [...this.pendingCompletions]) {
      if (key.startsWith(prefix)) this.pendingCompletions.delete(key);
    }
  }
}

class SessionLifecycleRegistry {
  private lifecycles = new Map<string, SessionLifecycle>();

  constructor(
    private readonly idleRetentionMs: number,
    private readonly setTimerImpl: (
      callback: () => void,
      delayMs: number,
    ) => TimerHandle,
    private readonly clearTimerImpl: (timer: TimerHandle) => void,
  ) {}

  markActive(sessionId: string): void {
    const lifecycle = this.get(sessionId);
    lifecycle.activityGeneration += 1;
    if (lifecycle.idleCleanupTimer !== null) {
      this.clearTimerImpl(lifecycle.idleCleanupTimer);
      lifecycle.idleCleanupTimer = null;
    }
  }

  captureGeneration(sessionId: string, isMain: boolean): number | null {
    if (!isMain) return null;
    return this.get(sessionId).activityGeneration;
  }

  scheduleCleanup(
    sessionId: string,
    isMain: boolean,
    deleteSession: () => void,
    expectedActivityGeneration?: number,
  ): void {
    if (!isMain) {
      deleteSession();
      return;
    }

    const lifecycle = this.get(sessionId);
    if (
      expectedActivityGeneration !== undefined &&
      lifecycle.activityGeneration !== expectedActivityGeneration
    ) {
      return;
    }

    if (this.idleRetentionMs <= 0) {
      deleteSession();
      return;
    }

    if (lifecycle.idleCleanupTimer !== null) {
      this.clearTimerImpl(lifecycle.idleCleanupTimer);
      lifecycle.idleCleanupTimer = null;
    }

    const activityGeneration = expectedActivityGeneration ??
      lifecycle.activityGeneration;
    const timerHandle = this.setTimerImpl(() => {
      const currentLifecycle = this.lifecycles.get(sessionId);
      if (!currentLifecycle) return;
      if (currentLifecycle.idleCleanupTimer !== timerHandle) return;
      if (currentLifecycle.activityGeneration !== activityGeneration) return;
      deleteSession();
    }, this.idleRetentionMs);

    lifecycle.idleCleanupTimer = timerHandle;
  }

  migrate(sessionId: string, canonicalSessionId: string): void {
    const sourceLifecycle = this.lifecycles.get(sessionId);
    const targetLifecycle = this.lifecycles.get(canonicalSessionId);
    if (!sourceLifecycle) return;

    const targetIdleCleanupTimer = targetLifecycle?.idleCleanupTimer ?? null;
    if (sourceLifecycle.idleCleanupTimer !== null) {
      this.clearTimerImpl(sourceLifecycle.idleCleanupTimer);
    }
    if (targetIdleCleanupTimer !== null) {
      this.clearTimerImpl(targetIdleCleanupTimer);
    }
    this.lifecycles.set(canonicalSessionId, {
      activityGeneration: Math.max(
        targetLifecycle?.activityGeneration ?? 0,
        sourceLifecycle.activityGeneration,
      ),
      idleCleanupTimer: null,
    });
    this.lifecycles.delete(sessionId);
  }

  delete(sessionId: string): void {
    const lifecycle = this.lifecycles.get(sessionId);
    if (lifecycle?.idleCleanupTimer != null) {
      this.clearTimerImpl(lifecycle.idleCleanupTimer);
    }
    this.lifecycles.delete(sessionId);
  }

  private get(sessionId: string): SessionLifecycle {
    let lifecycle = this.lifecycles.get(sessionId);
    if (!lifecycle) {
      lifecycle = { activityGeneration: 0, idleCleanupTimer: null };
      this.lifecycles.set(sessionId, lifecycle);
    }
    return lifecycle;
  }
}

const buildPreparedInjectionEnvelope = (
  events: SessionEvent[],
  snapshot: string | null,
  latestRequest: string,
  persistent: { body: string; nodeRefs: string[] },
): string => {
  const occupiedNormalized = new Set<string>();
  const normalizedLatestRequest = normalizeMemoryText(latestRequest);
  if (normalizedLatestRequest) {
    occupiedNormalized.add(normalizedLatestRequest);
  }

  const activeTasks = collectSectionValues(
    events,
    (event) =>
      ["task.create", "task.update", "task.complete"].includes(
        event.category,
      ),
    4,
    occupiedNormalized,
  );
  addNormalizedValues(occupiedNormalized, activeTasks);

  const decisions = collectSectionValues(
    events,
    (event) => ["decision", "preference"].includes(event.category),
    5,
    occupiedNormalized,
  );
  addNormalizedValues(occupiedNormalized, decisions);

  const files = collectPathValues(events, 6, occupiedNormalized);
  addNormalizedValues(occupiedNormalized, files);

  const rules = collectSectionValues(
    events,
    (event) => event.category === "rule.load",
    6,
    occupiedNormalized,
  );
  addNormalizedValues(occupiedNormalized, rules);

  const unresolvedErrors = collectRecentUniqueValues(
    events,
    (event) =>
      event.category === "error" && event.metadata?.resolved !== true &&
        event.role !== "assistant"
        ? sanitizeMemoryInput(getSessionEventPrimaryText(event))
        : null,
    4,
    occupiedNormalized,
  );
  addNormalizedValues(occupiedNormalized, unresolvedErrors);

  const gitState = collectSectionValues(
    events,
    (event) => event.category === "git.activity",
    4,
    occupiedNormalized,
  );
  addNormalizedValues(occupiedNormalized, gitState);

  const subagentWork = collectSectionValues(
    events,
    (event) =>
      event.category === "subagent.start" ||
      event.category === "subagent.finish",
    4,
    occupiedNormalized,
  );
  addNormalizedValues(occupiedNormalized, subagentWork);

  const filteredSnapshot = filterDuplicateSnapshotLeaves(
    snapshot,
    occupiedNormalized,
  );

  const sections = [
    `<last_request>${escapeXml(latestRequest)}</last_request>`,
    renderXmlListSection(
      "active_tasks",
      "task",
      activeTasks,
      { itemCharLimit: 280 },
    ),
    renderXmlListSection("key_decisions", "decision", decisions, {
      itemCharLimit: 280,
    }),
    renderXmlListSection("files_in_play", "file", files, {
      itemCharLimit: 280,
    }),
    renderXmlListSection("project_rules", "rule", rules, {
      itemCharLimit: 280,
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
    filteredSnapshot
      ? `<session_snapshot>${filteredSnapshot}</session_snapshot>`
      : "",
    persistent.body
      ? `<persistent_memory node_refs="${
        escapeXml(persistent.nodeRefs.join(","))
      }">${persistent.body}</persistent_memory>`
      : "",
  ].filter(Boolean);

  return `<session_memory source="graphiti" version="1">${
    sections.join("")
  }</session_memory>`;
};

export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private parentIdCache = new Map<string, string | null>();
  private canonicalSessionIdCache = new Map<string, string>();
  private temporaryRootSessionIds = new Set<string>();
  private readonly assistantBuffer = new AssistantMessageBuffer();
  private readonly lifecycleRegistry: SessionLifecycleRegistry;
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
    this.lifecycleRegistry = new SessionLifecycleRegistry(
      this.idleRetentionMs,
      this.setTimerImpl,
      this.clearTimerImpl,
    );
  }

  createDefaultState(groupId: string, userGroupId: string): SessionState {
    return {
      groupId,
      userGroupId,
      injectedMemories: false,
      messageCount: 0,
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

  getTrackedGroupIds(): string[] {
    return [
      ...new Set(
        [...this.sessions.values()]
          .filter((state) => state.isMain)
          .map((state) => state.groupId)
          .filter(Boolean),
      ),
    ];
  }

  setState(sessionId: string, state: SessionState): void {
    this.sessions.set(sessionId, state);
  }

  markSessionActive(sessionId: string): void {
    this.markLifecycleActive(sessionId);
    const canonicalSessionId = this.canonicalSessionIdCache.get(sessionId);
    if (canonicalSessionId && canonicalSessionId !== sessionId) {
      this.markLifecycleActive(canonicalSessionId);
    }
  }

  markResolvedSessionActive(
    sessionId: string,
    canonicalSessionId?: string,
  ): void {
    this.markLifecycleActive(sessionId);
    if (canonicalSessionId && canonicalSessionId !== sessionId) {
      this.markLifecycleActive(canonicalSessionId);
    }
  }

  private markLifecycleActive(sessionId: string): void {
    this.lifecycleRegistry.markActive(sessionId);
  }

  captureIdleCleanupGeneration(sessionId: string): number | null {
    const state = this.sessions.get(sessionId);
    return this.lifecycleRegistry.captureGeneration(
      sessionId,
      state?.isMain === true,
    );
  }

  scheduleIdleSessionCleanup(
    sessionId: string,
    expectedActivityGeneration?: number,
  ): void {
    const state = this.sessions.get(sessionId);
    this.lifecycleRegistry.scheduleCleanup(
      sessionId,
      state?.isMain === true,
      () => this.deleteSession(sessionId),
      expectedActivityGeneration,
    );
  }

  setParentId(sessionId: string, parentId: string | null): void {
    const wasTemporaryRoot = this.temporaryRootSessionIds.has(sessionId);
    this.parentIdCache.set(sessionId, parentId);
    if (!parentId) {
      this.temporaryRootSessionIds.delete(sessionId);
      this.canonicalSessionIdCache.set(sessionId, sessionId);
      return;
    }

    const parentCanonical = this.canonicalSessionIdCache.get(parentId);
    if (parentCanonical) {
      this.canonicalSessionIdCache.set(sessionId, parentCanonical);
      if (parentCanonical !== sessionId) {
        this.migrateTemporaryRootRuntimeState(sessionId, parentCanonical);
      }
      if (wasTemporaryRoot) {
        this.temporaryRootSessionIds.delete(sessionId);
      }
      return;
    }

    this.canonicalSessionIdCache.delete(sessionId);
  }

  private mergeSessionState(
    target: SessionState,
    source: SessionState,
  ): void {
    target.injectedMemories ||= source.injectedMemories;
    target.messageCount += source.messageCount;
    target.contextLimit = Math.max(target.contextLimit, source.contextLimit);
    target.isMain ||= source.isMain;
    target.hotTierReady ||= source.hotTierReady;
    if (source.latestUserRequest) {
      target.latestUserRequest = source.latestUserRequest;
    }
    if (source.latestRefreshQuery) {
      target.latestRefreshQuery = source.latestRefreshQuery;
    }
    if (
      source.pendingInjection !== undefined &&
      (
        source.pendingInjectionGeneration > target.pendingInjectionGeneration ||
        (
          source.pendingInjectionGeneration ===
            target.pendingInjectionGeneration &&
          target.pendingInjection === undefined
        )
      )
    ) {
      target.pendingInjection = source.pendingInjection;
    }
    target.pendingInjectionGeneration = Math.max(
      target.pendingInjectionGeneration,
      source.pendingInjectionGeneration,
    );
  }

  private migrateTemporaryRootRuntimeState(
    sessionId: string,
    canonicalSessionId: string,
  ): void {
    if (sessionId === canonicalSessionId) return;

    const sourceState = this.sessions.get(sessionId);
    const targetState = this.sessions.get(canonicalSessionId);
    if (sourceState) {
      if (targetState) {
        this.mergeSessionState(targetState, sourceState);
      } else {
        this.sessions.set(canonicalSessionId, sourceState);
      }
      this.sessions.delete(sessionId);
    }

    this.lifecycleRegistry.migrate(sessionId, canonicalSessionId);
    this.assistantBuffer.migrateSession(sessionId, canonicalSessionId);

    for (
      const [cachedSessionId, cachedCanonicalSessionId] of [
        ...this.canonicalSessionIdCache.entries(),
      ]
    ) {
      if (cachedCanonicalSessionId === sessionId) {
        this.canonicalSessionIdCache.set(cachedSessionId, canonicalSessionId);
      }
    }
  }

  async resolveParentId(
    sessionId: string,
  ): Promise<string | null | undefined> {
    if (
      this.parentIdCache.has(sessionId) &&
      !this.temporaryRootSessionIds.has(sessionId)
    ) {
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
      this.temporaryRootSessionIds.delete(sessionId);
      if (parentId === null) {
        this.canonicalSessionIdCache.set(sessionId, sessionId);
      } else {
        this.canonicalSessionIdCache.delete(sessionId);
      }
      return parentId;
    } catch (err) {
      if (isExplicitSessionNotFoundError(err)) {
        this.parentIdCache.set(sessionId, null);
        this.canonicalSessionIdCache.set(sessionId, sessionId);
        this.temporaryRootSessionIds.add(sessionId);
        logger.debug(
          "Session not found during parent resolution; treating as temporary root",
          { sessionId },
        );
        return null;
      }
      logger.debug("Failed to resolve session parentID", { sessionId, err });
      return undefined;
    }
  }

  async resolveCanonicalSessionId(
    sessionId: string,
    visited: Set<string> = new Set<string>(),
  ): Promise<string | undefined> {
    const cached = this.canonicalSessionIdCache.get(sessionId);
    const hasProvisionalTemporaryRoot =
      this.temporaryRootSessionIds.has(sessionId) && cached === sessionId;
    if (cached && !hasProvisionalTemporaryRoot) return cached;
    if (visited.has(sessionId)) {
      logger.debug("Detected cycle while resolving canonical session", {
        sessionId,
        visited: [...visited],
      });
      return undefined;
    }

    visited.add(sessionId);
    const parentId = await this.resolveParentId(sessionId);
    if (parentId === undefined) {
      return hasProvisionalTemporaryRoot ? cached : undefined;
    }
    if (!parentId) {
      this.canonicalSessionIdCache.set(sessionId, sessionId);
      return sessionId;
    }

    const canonicalSessionId = await this.resolveCanonicalSessionId(
      parentId,
      visited,
    );
    if (!canonicalSessionId) return undefined;
    if (canonicalSessionId !== sessionId) {
      this.migrateTemporaryRootRuntimeState(sessionId, canonicalSessionId);
      this.temporaryRootSessionIds.delete(sessionId);
    }
    this.canonicalSessionIdCache.set(sessionId, canonicalSessionId);
    return canonicalSessionId;
  }

  async resolveSessionState(
    sessionId: string,
  ): Promise<{
    state: SessionState | null;
    resolved: boolean;
    canonicalSessionId?: string;
  }> {
    const canonicalSessionId = await this.resolveCanonicalSessionId(sessionId);
    if (!canonicalSessionId) {
      return { state: null, resolved: false, canonicalSessionId: undefined };
    }

    let state = this.sessions.get(canonicalSessionId);
    if (!state) {
      state = this.createDefaultState(
        this.defaultGroupId,
        this.defaultUserGroupId,
      );
      this.sessions.set(canonicalSessionId, state);
    }
    return { state, resolved: true, canonicalSessionId };
  }

  bufferAssistantPart(
    sessionId: string,
    messageId: string,
    text: string,
    sourceSessionId = sessionId,
  ): void {
    this.assistantBuffer.bufferPart(
      sessionId,
      messageId,
      text,
      sourceSessionId,
    );
  }

  isAssistantBuffered(sessionId: string, messageId: string): boolean {
    return this.assistantBuffer.isBuffered(sessionId, messageId);
  }

  hasPendingAssistantCompletion(sessionId: string, messageId: string): boolean {
    return this.assistantBuffer.hasPendingCompletion(sessionId, messageId);
  }

  finalizeAssistantMessage(
    _state: SessionState,
    sessionId: string,
    messageId: string,
    source: string,
  ): string | null {
    return this.assistantBuffer.finalize(sessionId, messageId, source);
  }

  deletePendingAssistant(sessionId: string, messageId: string): void {
    this.assistantBuffer.deletePending(sessionId, messageId);
  }

  clearPendingInjection(
    state: SessionState,
    prepared?: PreparedSessionMemory | null,
  ): void {
    if (!prepared) return;
    if (state.pendingInjection === prepared) {
      state.pendingInjection = undefined;
    }
  }

  purgeAssistantBufferSource(sourceSessionId: string): void {
    this.assistantBuffer.purgeSource(sourceSessionId);
  }

  async prepareInjection(
    sessionId: string,
    lastRequest?: string,
  ): Promise<PreparedSessionMemory | null> {
    const state = this.sessions.get(sessionId);
    if (!state?.isMain) return null;
    const generation = state.pendingInjectionGeneration + 1;
    state.pendingInjectionGeneration = generation;

    const data = await this.collectPreparedInjectionData(
      sessionId,
      state,
      lastRequest,
    );
    const prepared = this.buildPreparedInjection(state, data);
    if (!prepared) return null;

    const currentState = this.sessions.get(sessionId);
    if (currentState !== state || !currentState.isMain) return null;
    if (state.pendingInjectionGeneration !== generation) return null;

    this.applyPreparedInjection(
      state,
      prepared,
      data.cacheMeta,
      data.latestRequest,
    );
    return prepared;
  }

  private async collectPreparedInjectionData(
    sessionId: string,
    state: SessionState,
    lastRequest?: string,
  ): Promise<PreparedInjectionData> {
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

    const canonicalLatestRequest = sanitizeMemoryInput(
      state.latestUserRequest ?? "",
    );
    const directFallbackRequest = sanitizeMemoryInput(lastRequest ?? "");
    const cachedFallbackRequest = sanitizeMemoryInput(
      state.latestRefreshQuery ?? cacheMeta?.lastQuery ?? "",
    );
    const historyFallbackRequest = findLatestUserRequest(recentEvents);
    const latestRequest = canonicalLatestRequest || directFallbackRequest ||
      cachedFallbackRequest || historyFallbackRequest;
    const recalledEvents = latestRequest
      ? await this.redisEvents.recallSessionEvents(sessionId, latestRequest, {
        resultLimit: RECALL_RESULT_LIMIT,
      })
      : [];
    return {
      cache,
      cacheMeta,
      events: mergeSessionEvents(recentEvents, recalledEvents),
      latestRequest,
      snapshot,
    };
  }

  private buildPreparedInjection(
    _state: SessionState,
    data: PreparedInjectionData,
  ): PreparedSessionMemory {
    const persistent = this.redisCache.renderPersistentMemory(
      data.cache,
      PERSISTENT_MEMORY_BODY_BUDGET,
    );
    const refreshDecision = this.redisCache.classifyRefresh(
      data.cache,
      data.latestRequest,
    );

    return {
      envelope: buildPreparedInjectionEnvelope(
        data.events,
        data.snapshot,
        data.latestRequest,
        persistent,
      ),
      nodeRefs: persistent.nodeRefs,
      refreshDecision,
    };
  }

  private applyPreparedInjection(
    state: SessionState,
    prepared: PreparedSessionMemory,
    cacheMeta: PersistentMemoryCacheMeta | null,
    latestRequest: string,
  ): void {
    state.pendingInjection = prepared;
    state.hotTierReady = true;
    state.latestRefreshQuery = latestRequest || cacheMeta?.lastQuery;
  }

  deleteSession(sessionId: string): void {
    this.lifecycleRegistry.delete(sessionId);
    this.sessions.delete(sessionId);
    this.parentIdCache.delete(sessionId);
    this.canonicalSessionIdCache.delete(sessionId);
    this.temporaryRootSessionIds.delete(sessionId);
    for (
      const [childSessionId, parentId] of [...this.parentIdCache.entries()]
    ) {
      if (parentId === sessionId) this.parentIdCache.delete(childSessionId);
    }
    for (
      const [childSessionId, canonicalSessionId] of [
        ...this.canonicalSessionIdCache.entries(),
      ]
    ) {
      if (canonicalSessionId === sessionId) {
        this.canonicalSessionIdCache.delete(childSessionId);
      }
    }
    this.assistantBuffer.deleteSession(sessionId);
  }
}
