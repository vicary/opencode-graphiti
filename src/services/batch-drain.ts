import {
  type DrainQueueEntry,
  getSessionEventRecallText,
} from "../types/index.ts";
import type { GraphitiMcpClient } from "./graphiti-mcp.ts";
import { logger } from "./logger.ts";
import type { RedisClient } from "./redis-client.ts";
import type { RedisEventsService } from "./redis-events.ts";
import { drainRetryKey } from "./redis-events.ts";
import {
  looksLikeOperationalChatter,
  looksLikeToolTranscript,
  looksTranscriptHeavy,
  sanitizeMemoryInput,
} from "./render-utils.ts";

export interface BatchDrainServiceOptions {
  batchSize: number;
  batchMaxBytes: number;
  drainRetryMax: number;
  claimHeartbeatIntervalMs?: number;
}

type RetryState = { attempts: number; nextAttemptAt: number };

const isValidRetryState = (value: unknown): value is RetryState => {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<RetryState>;
  return typeof state.attempts === "number" &&
    Number.isFinite(state.attempts) &&
    state.attempts >= 0 &&
    typeof state.nextAttemptAt === "number" &&
    Number.isFinite(state.nextAttemptAt);
};

class DrainClaimLostError extends Error {
  constructor() {
    super("Drain claim lease lost during batch processing");
    this.name = "DrainClaimLostError";
  }
}

const makeBatchKey = (entries: DrainQueueEntry[]): string =>
  `${entries[0]?.event.id ?? "empty"}:${entries.at(-1)?.event.id ?? "empty"}`;

type PreparedDrainEntry = {
  entry: DrainQueueEntry;
  recallText: string;
};

const prepareDrainEntries = (
  entries: DrainQueueEntry[],
): PreparedDrainEntry[] =>
  entries.map((entry) => ({
    entry,
    recallText: getDrainEntryRecallText(entry),
  }));

const getDrainableEntryIds = (entries: PreparedDrainEntry[]): Set<string> => {
  const drainableEntryIds = new Set<string>();
  for (const entry of entries) {
    if (shouldDrainEntry(entry)) {
      drainableEntryIds.add(entry.entry.event.id);
    }
  }
  return drainableEntryIds;
};

const getDrainEntryRecallText = (entry: DrainQueueEntry): string =>
  sanitizeMemoryInput(getSessionEventRecallText(entry.event));

const buildGraphitiEpisodeBody = (entry: PreparedDrainEntry): string => {
  const refs = entry.entry.event.refs?.length
    ? `\nRefs: ${entry.entry.event.refs.join(", ")}`
    : "";
  const keywords = entry.entry.event.keywords?.length
    ? `\nKeywords: ${entry.entry.event.keywords.join(", ")}`
    : "";
  return sanitizeMemoryInput(
    [
      `Category: ${entry.entry.event.category}`,
      `Role: ${entry.entry.event.role}`,
      `Summary: ${entry.entry.event.summary}`,
      entry.entry.event.detail ? `Detail: ${entry.entry.event.detail}` : "",
      entry.entry.event.continuityText
        ? `Continuity: ${entry.entry.event.continuityText}`
        : entry.recallText,
      keywords,
      refs,
    ].filter(Boolean).join("\n"),
  );
};

const shouldDrainEntry = (entry: PreparedDrainEntry): boolean => {
  const text = entry.recallText;
  if (!text) return false;
  if (looksLikeToolTranscript(text)) return false;
  if (looksLikeOperationalChatter(text)) return false;
  if (looksTranscriptHeavy(text)) return false;
  if (
    entry.entry.event.role === "assistant" &&
    entry.entry.event.category !== "discovery"
  ) {
    return false;
  }
  if (
    entry.entry.event.category === "message" &&
    entry.entry.event.role !== "user"
  ) {
    return false;
  }
  return true;
};

export class BatchDrainService {
  constructor(
    private readonly redis: RedisClient,
    private readonly events: RedisEventsService,
    private readonly options: BatchDrainServiceOptions,
  ) {}

  private getClaimHeartbeatIntervalMs(lockTtlSeconds: number): number {
    const ttlMs = Math.max(1_000, Math.floor(lockTtlSeconds * 1000));
    const defaultIntervalMs = Math.max(250, Math.floor(ttlMs / 3));
    const configuredIntervalMs = this.options.claimHeartbeatIntervalMs;
    const requestedIntervalMs = configuredIntervalMs ?? defaultIntervalMs;
    const minSafeIntervalMs = 250;
    const maxSafeIntervalMs = Math.max(250, Math.floor(ttlMs / 2));

    if (requestedIntervalMs < minSafeIntervalMs) {
      if (configuredIntervalMs !== undefined) {
        logger.warn("Clamped drain heartbeat interval to a safe minimum", {
          claimLockTtlSeconds: lockTtlSeconds,
          requestedHeartbeatIntervalMs: requestedIntervalMs,
          effectiveHeartbeatIntervalMs: minSafeIntervalMs,
          configuredHeartbeatIntervalMs: configuredIntervalMs,
        });
      }
      return minSafeIntervalMs;
    }

    if (requestedIntervalMs <= maxSafeIntervalMs) {
      return requestedIntervalMs;
    }

    logger.warn("Clamped drain heartbeat interval to stay below claim TTL", {
      claimLockTtlSeconds: lockTtlSeconds,
      requestedHeartbeatIntervalMs: requestedIntervalMs,
      effectiveHeartbeatIntervalMs: maxSafeIntervalMs,
      configuredHeartbeatIntervalMs: configuredIntervalMs,
    });
    return maxSafeIntervalMs;
  }

  private async getRetryState(
    groupId: string,
    batchKey: string,
  ): Promise<RetryState | null> {
    const key = drainRetryKey(groupId, batchKey);
    const raw = await this.redis.getString(key);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (isValidRetryState(parsed)) return parsed;
      await this.redis.deleteKey(key);
      logger.warn("Cleared invalid drain retry state", {
        groupId,
        batchKey,
      });
      return null;
    } catch {
      await this.redis.deleteKey(key);
      logger.warn("Cleared corrupted drain retry state", {
        groupId,
        batchKey,
      });
      return null;
    }
  }

  private async setRetryState(
    groupId: string,
    batchKey: string,
    state: RetryState,
  ): Promise<void> {
    await this.redis.setString(
      drainRetryKey(groupId, batchKey),
      JSON.stringify(state),
      7 * 24 * 60 * 60,
    );
  }

  async drainGroup(
    groupId: string,
    graphiti: GraphitiMcpClient,
  ): Promise<
    {
      status: "empty" | "backoff" | "success" | "dead-letter" | "retry";
      drained: number;
      retryAfterMs?: number;
    }
  > {
    const claimed = await this.events.getPendingBatch(
      groupId,
      this.options.batchSize,
      this.options.batchMaxBytes,
    );
    if (!claimed || claimed.entries.length === 0) {
      return { status: "empty", drained: 0 };
    }

    const batch = claimed.entries;
    const preparedBatch = prepareDrainEntries(batch);
    const batchKey = makeBatchKey(batch);
    const eventIds = batch.map((entry) => entry.event.id);
    const drainableEntryIds = getDrainableEntryIds(preparedBatch);
    if (drainableEntryIds.size === 0) {
      await this.events.markBatchSuccess(groupId, claimed.claimToken, batch);
      await this.redis.deleteKey(drainRetryKey(groupId, batchKey));
      return { status: "success", drained: 0 };
    }

    const retryState = await this.getRetryState(groupId, batchKey);
    if (retryState && retryState.nextAttemptAt > Date.now()) {
      const retryAfterMs = Math.max(0, retryState.nextAttemptAt - Date.now());
      await this.events.releaseClaim(groupId, claimed.claimToken);
      return { status: "backoff", drained: 0, retryAfterMs };
    }

    let lostClaim = false;
    let claimRefreshChain: Promise<void> = Promise.resolve();
    let heartbeatTimer: number | null = null;
    let refreshClaimHeartbeatRunning = false;
    const refreshClaimOwnership = (): Promise<boolean> => {
      const refreshTask = claimRefreshChain.then(async () => {
        if (lostClaim) return false;
        try {
          const refreshed = await this.events.refreshClaimLease(
            groupId,
            claimed.claimToken,
            claimed.lockTtlSeconds,
          );
          if (!refreshed) lostClaim = true;
        } catch {
          lostClaim = true;
        }
        return !lostClaim;
      });
      claimRefreshChain = refreshTask.then(() => undefined, () => undefined);
      return refreshTask;
    };
    const refreshClaimHeartbeat = async (): Promise<void> => {
      if (refreshClaimHeartbeatRunning) return;
      refreshClaimHeartbeatRunning = true;
      try {
        await refreshClaimOwnership();
      } finally {
        refreshClaimHeartbeatRunning = false;
        if (!lostClaim) {
          heartbeatTimer = setTimeout(
            refreshClaimHeartbeat,
            this.getClaimHeartbeatIntervalMs(claimed.lockTtlSeconds),
          ) as unknown as number;
        }
      }
    };
    const confirmClaimOwnership = (): Promise<boolean> =>
      refreshClaimOwnership();
    const assertClaimOwnership = async (): Promise<void> => {
      if (!await confirmClaimOwnership()) {
        throw new DrainClaimLostError();
      }
    };
    heartbeatTimer = setTimeout(
      refreshClaimHeartbeat,
      this.getClaimHeartbeatIntervalMs(claimed.lockTtlSeconds),
    ) as unknown as number;
    let checkpointedCount = 0;

    try {
      for (const preparedEntry of preparedBatch) {
        const entry = preparedEntry.entry;
        if (drainableEntryIds.has(entry.event.id)) {
          await assertClaimOwnership();
          await graphiti.addMemory({
            name: `${entry.event.category}:${entry.event.id}`,
            episodeBody: buildGraphitiEpisodeBody(preparedEntry),
            groupId,
            source: "text",
            sourceDescription: `session-event:${entry.event.category}`,
          });
        }
        await assertClaimOwnership();
        await this.events.markClaimEntrySuccess(
          groupId,
          claimed.claimToken,
          entry,
        );
        checkpointedCount += 1;
      }
      await assertClaimOwnership();
      await this.events.markBatchSuccess(groupId, claimed.claimToken, batch);
      await this.redis.deleteKey(drainRetryKey(groupId, batchKey));
      return { status: "success", drained: drainableEntryIds.size };
    } catch (err) {
      const lostOwnership = err instanceof DrainClaimLostError;
      if (lostOwnership) {
        logger.warn("Drain claim heartbeat lost ownership", {
          groupId,
          eventIds,
        });
      }
      const attempts = (retryState?.attempts ?? 0) + 1;
      const stillOwnClaim = await confirmClaimOwnership();
      if (!stillOwnClaim) {
        if (!lostOwnership) {
          logger.warn("Drain claim heartbeat lost ownership", {
            groupId,
            eventIds,
          });
        }
        await this.redis.deleteKey(drainRetryKey(groupId, batchKey));
        logger.warn(
          "Drain batch failed after claim loss; waiting for recovery",
          {
            groupId,
            err,
          },
        );
        return { status: "retry", drained: 0 };
      }

      if (attempts >= this.options.drainRetryMax) {
        const remainingEntries = batch.slice(checkpointedCount);
        let drainedCount = 0;
        for (const entry of batch.slice(0, checkpointedCount)) {
          if (drainableEntryIds.has(entry.event.id)) drainedCount += 1;
        }
        logger.warn("Moving drain batch to dead-letter", {
          groupId,
          eventIds: remainingEntries.map((entry) => entry.event.id),
        });
        await this.events.moveBatchToDeadLetter(groupId, remainingEntries);
        await this.events.markBatchSuccess(
          groupId,
          claimed.claimToken,
          batch,
        );
        await this.redis.deleteKey(drainRetryKey(groupId, batchKey));
        return { status: "dead-letter", drained: drainedCount };
      }

      await this.events.releaseClaim(groupId, claimed.claimToken);
      await this.setRetryState(groupId, batchKey, {
        attempts,
        nextAttemptAt: Date.now() + 1_000 * (2 ** (attempts - 1)),
      });
      logger.warn("Drain batch failed; will retry later", { groupId, err });
      return { status: "retry", drained: 0 };
    } finally {
      if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
      await claimRefreshChain;
    }
  }
}
