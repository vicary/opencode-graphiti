import type { RedisClient } from "./redis-client.ts";

export type DreamJob = {
  rootSessionId: string;
  fromWatermark: string | null;
  targetWatermark: string;
  created_at: string;
};

type PendingDreamCandidate = {
  rootSessionId: string;
  targetWatermark: string;
  created_at?: string;
};

type DreamJobStoreOptions = {
  readWatermark?: (rootSessionId: string) => Promise<string | null>;
  now?: () => string;
};

const dreamJobKey = (rootSessionId: string): string =>
  `session:${rootSessionId}:dream:job:pending`;

const isDreamJob = (value: unknown): value is DreamJob => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.rootSessionId === "string" &&
    (typeof candidate.fromWatermark === "string" ||
      candidate.fromWatermark === null) &&
    typeof candidate.targetWatermark === "string" &&
    typeof candidate.created_at === "string";
};

const parseDreamJob = (value: string | null): DreamJob | null => {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value);
    return isDreamJob(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export class DreamJobStore {
  private readonly readWatermark: (
    rootSessionId: string,
  ) => Promise<string | null>;
  private readonly now: () => string;

  constructor(
    private readonly redis: RedisClient,
    options: DreamJobStoreOptions = {},
  ) {
    this.readWatermark = options.readWatermark ?? (() => Promise.resolve(null));
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async writeJob(job: DreamJob): Promise<void> {
    await this.redis.setString(
      dreamJobKey(job.rootSessionId),
      JSON.stringify(job),
    );
  }

  async readPendingJob(rootSessionId: string): Promise<DreamJob | null> {
    return parseDreamJob(
      await this.redis.getString(dreamJobKey(rootSessionId)),
    );
  }

  async clearJob(rootSessionId: string): Promise<void> {
    await this.redis.deleteKey(dreamJobKey(rootSessionId));
  }

  async preparePendingJobs(
    candidates: Iterable<PendingDreamCandidate>,
  ): Promise<DreamJob | null> {
    for (const candidate of candidates) {
      const existing = await this.readPendingJob(candidate.rootSessionId);
      if (existing) return existing;

      const fromWatermark = await this.readWatermark(candidate.rootSessionId);
      if (
        fromWatermark !== null &&
        fromWatermark >= candidate.targetWatermark
      ) {
        continue;
      }

      const job = {
        rootSessionId: candidate.rootSessionId,
        fromWatermark,
        targetWatermark: candidate.targetWatermark,
        created_at: candidate.created_at ?? this.now(),
      } satisfies DreamJob;
      await this.writeJob(job);
      return job;
    }

    return null;
  }
}
