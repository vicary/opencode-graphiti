import type {
  ClaimedDrainBatch,
  DrainQueueEntry,
  SessionEvent,
} from "../types/index.ts";
import { getSessionEventRecallText } from "../types/index.ts";
import type { RedisClient } from "./redis-client.ts";

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
export const drainClaimActiveKey = (groupId: string): string =>
  `drain:claim-active:${groupId}`;
export const drainClaimLockKey = (groupId: string): string =>
  `drain:claim-lock:${groupId}`;

const makeClaimToken = (): string => crypto.randomUUID();

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
  constructor(
    private readonly redis: RedisClient,
    private readonly options: RedisEventsServiceOptions,
  ) {}

  getClaimLockTtlSeconds(): number {
    return this.options.claimLockTtlSeconds ?? CLAIM_LOCK_TTL_SECONDS;
  }

  async recordEvent(
    sessionId: string,
    groupId: string,
    event: SessionEvent,
  ): Promise<number> {
    const queueEntry: DrainQueueEntry = { sessionId, groupId, event };
    await this.redis.prependToList(
      sessionEventsKey(sessionId),
      JSON.stringify(event),
      this.options.sessionTtlSeconds,
    );
    return await this.redis.prependToList(
      drainPendingKey(groupId),
      JSON.stringify(queueEntry),
      DRAIN_TTL_SECONDS,
    );
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
    const lockAcquired = await this.redis.setStringIfAbsent(
      drainClaimLockKey(groupId),
      claimToken,
      this.getClaimLockTtlSeconds(),
    );
    if (!lockAcquired) return null;

    await this.redis.setString(
      drainClaimActiveKey(groupId),
      claimToken,
      DRAIN_TTL_SECONDS,
    );

    const selected: DrainQueueEntry[] = [];
    let totalBytes = 0;

    try {
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
        if (!entry) continue;

        const bytes = new TextEncoder().encode(
          getSessionEventRecallText(entry.event),
        ).length;
        if (selected.length > 0 && totalBytes + bytes > maxBytes) {
          await this.redis.moveListItem(claimKey, pendingKey, "RIGHT", "RIGHT");
          break;
        }

        selected.push(entry);
        totalBytes += bytes;
      }

      if (selected.length === 0) {
        await this.redis.deleteKey(claimKey);
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
    ttlSeconds = this.getClaimLockTtlSeconds(),
  ): Promise<boolean> {
    const lockRefreshed = await this.redis.compareAndTouch(
      drainClaimLockKey(groupId),
      claimToken,
      ttlSeconds,
    );
    if (!lockRefreshed) return false;

    const activeRefreshed = await this.redis.compareAndTouch(
      drainClaimActiveKey(groupId),
      claimToken,
      DRAIN_TTL_SECONDS,
    );
    if (!activeRefreshed) return false;

    await this.redis.touch(
      drainClaimKey(groupId, claimToken),
      DRAIN_TTL_SECONDS,
    );
    return true;
  }

  async markBatchSuccess(
    groupId: string,
    claimToken: string,
    entries: DrainQueueEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;

    await this.redis.deleteKey(drainClaimKey(groupId, claimToken));
    await this.redis.deleteKeyIfValue(drainClaimActiveKey(groupId), claimToken);
    await this.redis.deleteKeyIfValue(drainClaimLockKey(groupId), claimToken);
    await this.redis.setString(
      drainCursorKey(groupId),
      entries.at(-1)?.event.id ?? "",
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
    await this.redis.deleteKeyIfValue(drainClaimActiveKey(groupId), claimToken);
    await this.redis.deleteKeyIfValue(drainClaimLockKey(groupId), claimToken);
  }

  async recoverAbandonedClaim(groupId: string): Promise<boolean> {
    const claimToken = await this.redis.getString(drainClaimActiveKey(groupId));
    if (!claimToken) return false;

    const lockToken = await this.redis.getString(drainClaimLockKey(groupId));
    if (lockToken) return false;

    await this.releaseClaim(groupId, claimToken);
    return true;
  }
}
