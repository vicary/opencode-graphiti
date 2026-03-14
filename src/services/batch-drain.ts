import {
  type DrainQueueEntry,
  getSessionEventRecallText,
} from "../types/index.ts";
import type { GraphitiMcpClient } from "./graphiti-mcp.ts";
import { drainRetryKey } from "./redis-events.ts";
import type { RedisEventsService } from "./redis-events.ts";
import type { RedisClient } from "./redis-client.ts";
import { logger } from "./logger.ts";

export interface BatchDrainServiceOptions {
  batchSize: number;
  batchMaxBytes: number;
  drainRetryMax: number;
  claimHeartbeatIntervalMs?: number;
}

type RetryState = { attempts: number; nextAttemptAt: number };

class DrainClaimLostError extends Error {
  constructor() {
    super("Drain claim lease lost during batch processing");
    this.name = "DrainClaimLostError";
  }
}

const makeBatchKey = (entries: DrainQueueEntry[]): string =>
  `${entries[0]?.event.id ?? "empty"}:${entries.at(-1)?.event.id ?? "empty"}`;

const buildEpisodeBody = (entry: DrainQueueEntry): string => {
  const refs = entry.event.refs?.length
    ? `\nRefs: ${entry.event.refs.join(", ")}`
    : "";
  const keywords = entry.event.keywords?.length
    ? `\nKeywords: ${entry.event.keywords.join(", ")}`
    : "";
  return [
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
  ].filter(Boolean).join("\n");
};

export class BatchDrainService {
  constructor(
    private readonly redis: RedisClient,
    private readonly events: RedisEventsService,
    private readonly options: BatchDrainServiceOptions,
  ) {}

  private getClaimHeartbeatIntervalMs(lockTtlSeconds: number): number {
    return this.options.claimHeartbeatIntervalMs ??
      Math.max(1_000, Math.floor((lockTtlSeconds * 1000) / 3));
  }

  private async getRetryState(
    groupId: string,
    batchKey: string,
  ): Promise<RetryState | null> {
    const raw = await this.redis.getString(drainRetryKey(groupId, batchKey));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as RetryState;
    } catch {
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

    const batchKey = makeBatchKey(batch);
    const retryState = await this.getRetryState(groupId, batchKey);
    if (retryState && retryState.nextAttemptAt > Date.now()) {
      await this.events.releaseClaim(groupId, claimed.claimToken);
      return { status: "backoff", drained: 0 };
    }

    let lostClaim = false;
    const refreshClaimHeartbeat = async (): Promise<void> => {
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
    };
    const heartbeatInterval = setInterval(() => {
      void refreshClaimHeartbeat();
    }, this.getClaimHeartbeatIntervalMs(claimed.lockTtlSeconds));

    try {
      for (const entry of batch) {
        await graphiti.addMemory({
          name: `${entry.event.category}:${entry.event.id}`,
          episodeBody: buildEpisodeBody(entry),
          groupId,
          source: "text",
          sourceDescription: `session-event:${entry.event.category}`,
        });
        if (lostClaim) throw new DrainClaimLostError();
      }
      clearInterval(heartbeatInterval);
      const stillOwned = await this.events.refreshClaimLease(
        groupId,
        claimed.claimToken,
        claimed.lockTtlSeconds,
      );
      if (lostClaim || !stillOwned) throw new DrainClaimLostError();
      await this.events.markBatchSuccess(groupId, claimed.claimToken, batch);
      await this.redis.deleteKey(drainRetryKey(groupId, batchKey));
      return { status: "success", drained: batch.length };
    } catch (err) {
      if (err instanceof DrainClaimLostError) {
        logger.warn("Drain claim heartbeat lost ownership", {
          groupId,
          eventIds: batch.map((entry) => entry.event.id),
        });
      }
      const attempts = (retryState?.attempts ?? 0) + 1;
      if (attempts >= this.options.drainRetryMax) {
        logger.warn("Moving drain batch to dead-letter", {
          groupId,
          eventIds: batch.map((entry) => entry.event.id),
        });
        await this.events.moveBatchToDeadLetter(groupId, batch);
        await this.events.markBatchSuccess(groupId, claimed.claimToken, batch);
        await this.redis.deleteKey(drainRetryKey(groupId, batchKey));
        return { status: "dead-letter", drained: batch.length };
      }

      await this.events.releaseClaim(groupId, claimed.claimToken);
      await this.setRetryState(groupId, batchKey, {
        attempts,
        nextAttemptAt: Date.now() + 1_000 * (2 ** (attempts - 1)),
      });
      logger.warn("Drain batch failed; will retry later", { groupId, err });
      return { status: "retry", drained: 0 };
    } finally {
      clearInterval(heartbeatInterval);
    }
  }
}
