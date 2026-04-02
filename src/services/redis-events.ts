import type {
  ClaimedDrainBatch,
  DrainQueueEntry,
  PreparedDrainQueueEntry,
  SessionEvent,
} from "../types/index.ts";
import { getSessionEventRecallText } from "../types/index.ts";
import { logger } from "./logger.ts";
import type { RedisClient } from "./redis-client.ts";
import {
  sanitizeMemoryInput,
  stripInjectedMemoryBlocks,
} from "./render-utils.ts";

const SESSION_EVENT_LIMIT = 40;
const SESSION_RECALL_SCAN_LIMIT = 120;
const SESSION_RECALL_RESULT_LIMIT = 12;
const DRAIN_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEAD_LETTER_TTL_SECONDS = 30 * 24 * 60 * 60;
const CLAIM_LOCK_TTL_SECONDS = 60;

const RECALL_ELIGIBLE_CATEGORIES = new Set<SessionEvent["category"]>([
  "task.create",
  "task.update",
  "task.complete",
  "decision",
  "preference",
  "rule.load",
  "file.read",
  "file.write",
  "file.edit",
  "file.search",
  "error",
  "git.activity",
  "subagent.start",
  "subagent.finish",
  "intent",
]);

const RECALL_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "always",
  "been",
  "before",
  "between",
  "could",
  "from",
  "have",
  "into",
  "keep",
  "more",
  "please",
  "should",
  "that",
  "the",
  "their",
  "them",
  "there",
  "these",
  "this",
  "those",
  "with",
  "without",
]);

export const sessionEventsKey = (sessionId: string): string =>
  `session:${sessionId}:events`;
export const sessionSnapshotKey = (sessionId: string): string =>
  `session:${sessionId}:snapshot`;
export const memoryCacheKey = (groupId: string): string =>
  `memory-cache:${groupId}`;
export const memoryCacheMetaKey = (groupId: string): string =>
  `memory-cache:${groupId}:meta`;
export const drainPendingKey = (groupId: string): string =>
  `drain:pending:${groupId}`;
export const drainCursorKey = (groupId: string): string =>
  `drain:cursor:${groupId}`;
export const drainDeadKey = (groupId: string): string =>
  `drain:dead:${groupId}`;
export const drainRetryKey = (groupId: string, batchKey: string): string =>
  `drain:retry:${groupId}:${batchKey}`;
export const drainClaimKey = (groupId: string, claimToken: string): string =>
  `drain:claim:${groupId}:${claimToken}`;
export const drainClaimCheckpointKey = (
  groupId: string,
  claimToken: string,
): string => `drain:claim-checkpoint:${groupId}:${claimToken}`;
export const drainClaimActiveKey = (groupId: string): string =>
  `drain:claim-active:${groupId}`;
export const drainClaimLockKey = (groupId: string): string =>
  `drain:claim-lock:${groupId}`;

const makeClaimToken = (): string => crypto.randomUUID();
const textEncoder = new TextEncoder();
const DURABLE_DRAIN_MUTATION_UNAVAILABLE =
  "Redis hot tier unavailable for durable drain-state mutation";

const parseEntry = (raw: string): DrainQueueEntry | null => {
  try {
    return JSON.parse(raw) as DrainQueueEntry;
  } catch {
    return null;
  }
};

const parseSessionEvent = (raw: string): SessionEvent | null => {
  try {
    return JSON.parse(raw) as SessionEvent;
  } catch {
    return null;
  }
};

export const buildDrainEpisodeBody = (entry: DrainQueueEntry): string => {
  const refs = entry.event.refs?.length
    ? `\nRefs: ${entry.event.refs.join(", ")}`
    : "";
  const keywords = entry.event.keywords?.length
    ? `\nKeywords: ${entry.event.keywords.join(", ")}`
    : "";
  return sanitizeMemoryInput(stripInjectedMemoryBlocks(
    [
      `Category: ${entry.event.category}`,
      `Role: ${entry.event.role}`,
      `Summary: ${entry.event.summary}`,
      entry.event.detail ? `Detail: ${entry.event.detail}` : "",
      entry.event.continuityText
        ? `Continuity: ${entry.event.continuityText}`
        : getSessionEventRecallText(entry.event),
      entry.event.body ? `Body: ${entry.event.body}` : "",
      keywords,
      refs,
    ].filter(Boolean).join("\n"),
  ));
};

export const prepareDrainQueueEntry = (
  entry: DrainQueueEntry,
): PreparedDrainQueueEntry => {
  const episodeBody = buildDrainEpisodeBody(entry);
  return {
    ...entry,
    episodeBody,
    episodeBodyBytes: textEncoder.encode(episodeBody).length,
  };
};

export const getDrainEpisodeBodyBytes = (entry: DrainQueueEntry): number =>
  prepareDrainQueueEntry(entry).episodeBodyBytes;

const sanitizeStoredValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    const sanitized = sanitizeMemoryInput(value);
    return sanitized || undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeStoredValue(item)).filter((item) =>
      item !== undefined
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) => {
        const sanitized = sanitizeStoredValue(entry);
        return sanitized === undefined ? [] : [[key, sanitized]];
      }),
    );
  }
  return value;
};

const sanitizedStoredString = (value: unknown): string | undefined => {
  const sanitized = sanitizeStoredValue(value);
  return typeof sanitized === "string" ? sanitized : undefined;
};

const sanitizedStoredStringArray = (value: unknown): string[] | undefined => {
  const sanitized = sanitizeStoredValue(value);
  return Array.isArray(sanitized) ? sanitized as string[] : undefined;
};

const sanitizedStoredMetadata = (
  value: unknown,
): Record<string, unknown> | undefined => {
  const sanitized = sanitizeStoredValue(value);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : undefined;
};

const sanitizeStoredEvent = (event: SessionEvent): SessionEvent => ({
  ...event,
  summary: sanitizeMemoryInput(event.summary),
  body: sanitizedStoredString(event.body),
  detail: sanitizedStoredString(event.detail),
  continuityText: sanitizedStoredString(event.continuityText),
  refs: sanitizedStoredStringArray(event.refs),
  keywords: sanitizedStoredStringArray(event.keywords),
  metadata: sanitizedStoredMetadata(event.metadata),
});

const tokenizeRecallQuery = (query: string): string[] => {
  const matches = query.toLowerCase().match(/[a-z0-9._/-]{3,}/g) ?? [];
  return [...new Set(matches.filter((token) => !RECALL_STOP_WORDS.has(token)))];
};

const scoreSessionEventRecall = (
  event: SessionEvent,
  query: string,
  tokens: string[],
): number => {
  if (!RECALL_ELIGIBLE_CATEGORIES.has(event.category)) return 0;

  const summary = event.summary.toLowerCase();
  const continuity = (event.continuityText ?? "").toLowerCase();
  const detail = (event.detail ?? "").toLowerCase();
  const refs = (event.refs ?? []).join(" ").toLowerCase();
  const keywords = (event.keywords ?? []).join(" ").toLowerCase();
  const recallText = getSessionEventRecallText(event).toLowerCase();
  let score = 0;

  if (summary.includes(query)) score += 8;
  else if (continuity.includes(query)) score += 7;
  else if (detail.includes(query)) score += 5;
  else if (recallText.includes(query)) score += 4;

  for (const token of tokens) {
    if (summary.includes(token)) score += 4;
    if (continuity.includes(token)) score += 4;
    if (detail.includes(token)) score += 3;
    if (refs.includes(token)) score += 3;
    if (keywords.includes(token)) score += 3;
    if (recallText.includes(token)) score += 1;
  }

  return score;
};

export interface RedisEventsServiceOptions {
  sessionTtlSeconds: number;
  claimLockTtlSeconds?: number;
}

export class RedisEventsService {
  private warnedInvalidClaimLockTtl = false;

  constructor(
    private readonly redis: RedisClient,
    private readonly options: RedisEventsServiceOptions,
  ) {}

  getClaimLockTtlSeconds(): number {
    const configured = this.options.claimLockTtlSeconds;
    if (configured === undefined) return CLAIM_LOCK_TTL_SECONDS;

    if (!Number.isFinite(configured) || configured <= 0) {
      if (!this.warnedInvalidClaimLockTtl) {
        logger.warn("Invalid drain claim TTL; falling back to default", {
          configuredClaimLockTtlSeconds: configured,
          effectiveClaimLockTtlSeconds: CLAIM_LOCK_TTL_SECONDS,
        });
        this.warnedInvalidClaimLockTtl = true;
      }
      return CLAIM_LOCK_TTL_SECONDS;
    }

    const normalized = Math.max(1, Math.ceil(configured));
    if (normalized !== configured && !this.warnedInvalidClaimLockTtl) {
      logger.warn("Raised drain claim TTL to a sane minimum", {
        configuredClaimLockTtlSeconds: configured,
        effectiveClaimLockTtlSeconds: normalized,
      });
      this.warnedInvalidClaimLockTtl = true;
    }
    return normalized;
  }

  async recordEvent(
    sessionId: string,
    groupId: string,
    event: SessionEvent,
  ): Promise<number> {
    const sanitizedEvent = sanitizeStoredEvent(event);
    const queueEntry: DrainQueueEntry = {
      sessionId,
      groupId,
      event: sanitizedEvent,
    };
    await this.redis.prependToList(
      sessionEventsKey(sessionId),
      JSON.stringify(sanitizedEvent),
      this.options.sessionTtlSeconds,
    );
    try {
      return await this.redis.prependToList(
        drainPendingKey(groupId),
        JSON.stringify(queueEntry),
        DRAIN_TTL_SECONDS,
      );
    } catch (error) {
      if (!this.isDurableDrainMutationUnavailable(error)) {
        throw error;
      }

      logger.warn("Durable drain queue unavailable; skipping enqueue", {
        groupId,
        sessionId,
        eventId: sanitizedEvent.id,
        category: sanitizedEvent.category,
      });
      return 0;
    }
  }

  async recordEvents(
    sessionId: string,
    groupId: string,
    events: SessionEvent[],
  ): Promise<number> {
    if (events.length === 0) return 0;

    const sanitizedEvents = events.map(sanitizeStoredEvent);
    const sessionValues = sanitizedEvents.map((event) => JSON.stringify(event));
    const drainValues = sanitizedEvents.map((event) =>
      JSON.stringify(
        {
          sessionId,
          groupId,
          event,
        } satisfies DrainQueueEntry,
      )
    );

    try {
      return await this.redis.prependToTwoLists(
        sessionEventsKey(sessionId),
        sessionValues,
        this.options.sessionTtlSeconds,
        drainPendingKey(groupId),
        drainValues,
        DRAIN_TTL_SECONDS,
      );
    } catch (error) {
      if (!this.isDurableDrainMutationUnavailable(error)) {
        throw error;
      }

      let queueLength = 0;
      for (const event of sanitizedEvents) {
        queueLength = await this.recordEvent(sessionId, groupId, event);
      }
      return queueLength;
    }
  }

  private isDurableDrainMutationUnavailable(error: unknown): boolean {
    return error instanceof Error &&
      error.message === DURABLE_DRAIN_MUTATION_UNAVAILABLE;
  }

  private isRedisUnavailable(error: unknown): boolean {
    return error instanceof Error &&
      (error.message === DURABLE_DRAIN_MUTATION_UNAVAILABLE ||
        error.message.includes("redis unavailable"));
  }

  async getRecentSessionEvents(
    sessionId: string,
    limit = SESSION_EVENT_LIMIT,
    chronological = true,
  ): Promise<SessionEvent[]> {
    const raw = await this.redis.getRecentList(
      sessionEventsKey(sessionId),
      limit,
    );
    const events = raw.flatMap((item) => {
      try {
        return [JSON.parse(item) as SessionEvent];
      } catch {
        return [];
      }
    });
    return chronological ? [...events].reverse() : events;
  }

  async touchSessionEvents(sessionId: string): Promise<void> {
    await this.redis.touch(
      sessionEventsKey(sessionId),
      this.options.sessionTtlSeconds,
    );
  }

  async recallSessionEvents(
    sessionId: string,
    query: string,
    options: {
      scanLimit?: number;
      resultLimit?: number;
    } = {},
  ): Promise<SessionEvent[]> {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return [];

    const tokens = tokenizeRecallQuery(normalizedQuery);
    if (tokens.length === 0 && normalizedQuery.length < 3) return [];

    const raw = await this.redis.getListRange(
      sessionEventsKey(sessionId),
      0,
      Math.max((options.scanLimit ?? SESSION_RECALL_SCAN_LIMIT) - 1, 0),
    );

    return raw
      .flatMap((item) => {
        const event = parseSessionEvent(item);
        if (!event) return [];
        const score = scoreSessionEventRecall(event, normalizedQuery, tokens);
        return score > 0 ? [{ event, score }] : [];
      })
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        if (right.event.ts !== left.event.ts) {
          return right.event.ts - left.event.ts;
        }
        return left.event.id.localeCompare(right.event.id);
      })
      .slice(0, options.resultLimit ?? SESSION_RECALL_RESULT_LIMIT)
      .map(({ event }) => event);
  }

  async getPendingCount(groupId: string): Promise<number> {
    return await this.redis.getListLength(drainPendingKey(groupId));
  }

  async getPendingBatch(
    groupId: string,
    maxItems: number,
    maxBytes: number,
  ): Promise<ClaimedDrainBatch | null> {
    if (maxItems <= 0) return null;

    await this.recoverAbandonedClaim(groupId);

    const pendingKey = drainPendingKey(groupId);
    if (await this.redis.getListLength(pendingKey) === 0) return null;

    const claimToken = makeClaimToken();
    const claimKey = drainClaimKey(groupId, claimToken);
    const checkpointKey = drainClaimCheckpointKey(groupId, claimToken);
    const lockAcquired = await this.redis.setStringIfAbsent(
      drainClaimLockKey(groupId),
      claimToken,
      this.getClaimLockTtlSeconds(),
    );
    if (!lockAcquired) return null;

    const selected: PreparedDrainQueueEntry[] = [];
    let totalBytes = 0;

    try {
      await this.redis.setString(
        drainClaimActiveKey(groupId),
        claimToken,
        DRAIN_TTL_SECONDS,
      );

      while (selected.length < maxItems) {
        const raw = await this.redis.moveListItem(
          pendingKey,
          claimKey,
          "RIGHT",
          "RIGHT",
        );
        if (!raw) break;

        await this.redis.touch(claimKey, DRAIN_TTL_SECONDS);
        const entry = parseEntry(raw);
        if (!entry) {
          await this.redis.moveListItem(
            claimKey,
            drainDeadKey(groupId),
            "RIGHT",
            "RIGHT",
          );
          await this.redis.touch(
            drainDeadKey(groupId),
            DEAD_LETTER_TTL_SECONDS,
          );
          logger.warn("Dead-lettered malformed claimed drain payload", {
            groupId,
            claimToken,
            raw,
          });
          continue;
        }

        const preparedEntry = prepareDrainQueueEntry(entry);
        const bytes = preparedEntry.episodeBodyBytes;
        if (bytes > maxBytes) {
          await this.redis.moveListItem(
            claimKey,
            drainDeadKey(groupId),
            "RIGHT",
            "RIGHT",
          );
          await this.redis.touch(
            drainDeadKey(groupId),
            DEAD_LETTER_TTL_SECONDS,
          );
          logger.warn("Dead-lettered oversized claimed drain payload", {
            groupId,
            claimToken,
            eventId: entry.event.id,
            eventBytes: bytes,
            batchMaxBytes: maxBytes,
          });
          continue;
        }

        if (selected.length > 0 && totalBytes + bytes > maxBytes) {
          await this.redis.moveListItem(claimKey, pendingKey, "RIGHT", "RIGHT");
          break;
        }

        selected.push(preparedEntry);
        totalBytes += bytes;
      }

      if (selected.length === 0) {
        await this.redis.deleteKey(claimKey);
        await this.redis.deleteKey(checkpointKey);
        await this.redis.deleteKeyIfValue(
          drainClaimActiveKey(groupId),
          claimToken,
        );
        await this.redis.deleteKeyIfValue(
          drainClaimLockKey(groupId),
          claimToken,
        );
        return null;
      }

      return {
        claimToken,
        claimKey,
        lockTtlSeconds: this.getClaimLockTtlSeconds(),
        entries: selected,
      };
    } catch (err) {
      await this.releaseClaim(groupId, claimToken);
      throw err;
    }
  }

  async refreshClaimLease(
    groupId: string,
    claimToken: string,
    ttlSeconds: number = this.getClaimLockTtlSeconds(),
  ): Promise<boolean> {
    try {
      const lockRefreshed = await this.redis.compareAndTouch(
        drainClaimLockKey(groupId),
        claimToken,
        ttlSeconds,
      );
      if (!lockRefreshed) {
        return false;
      }

      const activeRefreshed = await this.redis.compareAndTouch(
        drainClaimActiveKey(groupId),
        claimToken,
        DRAIN_TTL_SECONDS,
      );
      if (!activeRefreshed) {
        return false;
      }

      await this.redis.touch(
        drainClaimKey(groupId, claimToken),
        DRAIN_TTL_SECONDS,
      );
      return true;
    } catch (error) {
      if (!this.isRedisUnavailable(error)) throw error;
      return false;
    }
  }

  private async cleanupStaleClaimIfConnected(
    groupId: string,
    claimToken: string,
  ): Promise<boolean> {
    if (!this.redis.isConnected()) return false;

    const activeKey = drainClaimActiveKey(groupId);
    const lockKey = drainClaimLockKey(groupId);
    const claimKey = drainClaimKey(groupId, claimToken);
    const checkpointKey = drainClaimCheckpointKey(groupId, claimToken);
    let activeToken: string | null;
    let lockToken: string | null;
    let claimLength: number;
    let checkpointLength: number;
    try {
      [activeToken, lockToken, claimLength, checkpointLength] = await Promise
        .all([
          this.redis.getString(activeKey),
          this.redis.getString(lockKey),
          this.redis.getListLength(claimKey),
          this.redis.getListLength(checkpointKey),
        ]);
    } catch (error) {
      if (!this.isRedisUnavailable(error)) throw error;
      return false;
    }

    if (claimLength === 0 && checkpointLength === 0) return false;

    const missingLockForSameActive = activeToken === claimToken &&
      lockToken === null;
    const missingActiveForSameLock = lockToken === claimToken &&
      activeToken !== claimToken;
    const orphanedPointers = activeToken === null && lockToken === null;

    if (
      !missingLockForSameActive &&
      !missingActiveForSameLock &&
      !orphanedPointers
    ) {
      return false;
    }
    try {
      await this.releaseClaim(groupId, claimToken);
      return true;
    } catch (error) {
      if (!this.isRedisUnavailable(error)) throw error;
      return false;
    }
  }

  async markBatchSuccess(
    groupId: string,
    claimToken: string,
    entries: DrainQueueEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;

    await this.redis.deleteKey(drainClaimKey(groupId, claimToken));
    await this.redis.deleteKey(drainClaimCheckpointKey(groupId, claimToken));
    await this.redis.deleteKeyIfValue(drainClaimActiveKey(groupId), claimToken);
    await this.redis.deleteKeyIfValue(drainClaimLockKey(groupId), claimToken);
    await this.redis.setString(
      drainCursorKey(groupId),
      entries[entries.length - 1]?.event.id ?? "",
      DRAIN_TTL_SECONDS,
    );
  }

  async moveBatchToDeadLetter(
    groupId: string,
    entries: DrainQueueEntry[],
  ): Promise<void> {
    for (const entry of entries) {
      await this.redis.appendToList(
        drainDeadKey(groupId),
        JSON.stringify(entry),
        DEAD_LETTER_TTL_SECONDS,
      );
    }
  }

  async releaseClaim(
    groupId: string,
    claimToken: string,
  ): Promise<void> {
    const pendingKey = drainPendingKey(groupId);
    const claimKey = drainClaimKey(groupId, claimToken);
    const checkpointKey = drainClaimCheckpointKey(groupId, claimToken);

    while (true) {
      const raw = await this.redis.moveListItem(
        claimKey,
        pendingKey,
        "RIGHT",
        "RIGHT",
      );
      if (!raw) break;
    }

    await this.redis.deleteKey(claimKey);
    await this.redis.deleteKey(checkpointKey);
    await this.redis.deleteKeyIfValue(drainClaimActiveKey(groupId), claimToken);
    await this.redis.deleteKeyIfValue(drainClaimLockKey(groupId), claimToken);
  }

  async markClaimEntrySuccess(
    groupId: string,
    claimToken: string,
    entry: DrainQueueEntry,
  ): Promise<void> {
    const checkpointKey = drainClaimCheckpointKey(groupId, claimToken);
    const checkpointCount = await this.redis.getListLength(checkpointKey);
    if (checkpointCount > 0) {
      const latestCheckpoint = await this.redis.getListRange(
        checkpointKey,
        checkpointCount - 1,
        checkpointCount - 1,
      );
      if (parseEntry(latestCheckpoint[0] ?? "")?.event.id === entry.event.id) {
        return;
      }
    }

    const raw = await this.redis.moveListItem(
      drainClaimKey(groupId, claimToken),
      checkpointKey,
      "LEFT",
      "RIGHT",
    );
    if (!raw) return;

    const claimedEntry = parseEntry(raw);
    if (claimedEntry?.event.id !== entry.event.id) {
      throw new Error(
        `Drain claim checkpoint order mismatch for event ${entry.event.id}`,
      );
    }

    await this.redis.touch(checkpointKey, DRAIN_TTL_SECONDS);
    await this.redis.setString(
      drainCursorKey(groupId),
      entry.event.id,
      DRAIN_TTL_SECONDS,
    );
  }

  async recoverAbandonedClaim(groupId: string): Promise<boolean> {
    if (!this.redis.isConnected()) return false;

    let activeToken: string | null;
    let lockToken: string | null;
    try {
      [activeToken, lockToken] = await Promise.all([
        this.redis.getString(drainClaimActiveKey(groupId)),
        this.redis.getString(drainClaimLockKey(groupId)),
      ]);
    } catch (error) {
      if (!this.isRedisUnavailable(error)) throw error;
      return false;
    }
    const claimTokens = [activeToken, lockToken].filter(
      (token): token is string => {
        return typeof token === "string" && token.length > 0;
      },
    );
    if (claimTokens.length === 0) return false;

    for (const claimToken of new Set(claimTokens)) {
      if (await this.cleanupStaleClaimIfConnected(groupId, claimToken)) {
        return true;
      }
    }

    return false;
  }
}
