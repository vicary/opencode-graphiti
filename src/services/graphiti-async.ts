import type { PersistentMemoryCacheEntry } from "../types/index.ts";
import type { BatchDrainService } from "./batch-drain.ts";
import type { GraphitiMcpClient } from "./graphiti-mcp.ts";
import { logger } from "./logger.ts";
import type { RedisCacheService } from "./redis-cache.ts";

type TimerHandle = ReturnType<typeof setTimeout> | number;

type GraphitiAsyncServiceOptions = {
  setTimer?(callback: () => void, delayMs: number): TimerHandle;
  clearTimer?(timer: TimerHandle): void;
};

export class GraphitiAsyncService {
  private static readonly DEFAULT_DRAIN_RECOVERY_DELAY_MS = 30_000;
  private readonly drainInFlight = new Map<string, Promise<void>>();
  private readonly setTimerImpl: (
    callback: () => void,
    delayMs: number,
  ) => TimerHandle;
  private readonly clearTimerImpl: (timer: TimerHandle) => void;
  private readonly drainRetryTimers = new Map<string, TimerHandle>();
  private readonly drainRecoveryTimers = new Map<
    string,
    {
      run: Promise<void>;
      timer: TimerHandle;
    }
  >();
  private readonly refreshInFlight = new Map<string, Promise<void>>();
  private readonly primerInFlight = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(
    private readonly graphiti: GraphitiMcpClient,
    private readonly cache: RedisCacheService,
    private readonly drain: BatchDrainService,
    private readonly drainRetryDelayMs = 1_000,
    private readonly drainRecoveryDelayMs =
      GraphitiAsyncService.DEFAULT_DRAIN_RECOVERY_DELAY_MS,
    options: GraphitiAsyncServiceOptions = {},
  ) {
    this.setTimerImpl = options.setTimer ??
      ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimerImpl = options.clearTimer ??
      ((timer) => clearTimeout(timer));
  }

  async flushPendingGroups(groupIds: Iterable<string>): Promise<void> {
    const pendingGroups = [
      ...new Set(
        [...groupIds].map((groupId) => groupId.trim()).filter(Boolean),
      ),
    ];
    if (pendingGroups.length === 0) return;

    const priorStopped = this.stopped;
    this.stopped = false;
    try {
      for (const groupId of pendingGroups) {
        this.scheduleDrain(groupId);
      }
      const inFlight = pendingGroups.map((groupId) =>
        this.drainInFlight.get(groupId)
      )
        .filter((run): run is Promise<void> => Boolean(run));
      await Promise.allSettled(inFlight);
    } finally {
      this.stopped = priorStopped;
    }
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    for (const timer of this.drainRetryTimers.values()) {
      this.clearTimerImpl(timer);
    }
    this.drainRetryTimers.clear();
    for (const recovery of this.drainRecoveryTimers.values()) {
      this.clearTimerImpl(recovery.timer);
    }
    this.drainRecoveryTimers.clear();

    const inFlight = [
      ...this.drainInFlight.values(),
      ...this.refreshInFlight.values(),
      ...this.primerInFlight.values(),
    ];
    this.drainInFlight.clear();
    this.refreshInFlight.clear();
    this.primerInFlight.clear();
    await Promise.allSettled(inFlight);
  }

  private armDrainRetry(
    groupId: string,
    delayMs = this.drainRetryDelayMs,
  ): void {
    if (this.stopped) return;
    if (this.drainRetryTimers.has(groupId)) return;
    const timer = this.setTimerImpl(() => {
      if (this.stopped) return;
      this.drainRetryTimers.delete(groupId);
      this.scheduleDrain(groupId);
    }, delayMs);
    this.drainRetryTimers.set(groupId, timer);
  }

  private armDrainRecovery(groupId: string, run: Promise<void>): void {
    if (this.stopped) return;
    const existing = this.drainRecoveryTimers.get(groupId);
    if (existing?.run === run) return;
    if (existing) this.clearTimerImpl(existing.timer);

    const timer = this.setTimerImpl(() => {
      if (this.stopped) return;
      const recovery = this.drainRecoveryTimers.get(groupId);
      if (!recovery || recovery.run !== run) return;
      this.drainRecoveryTimers.delete(groupId);
      if (this.drainInFlight.get(groupId) !== run) return;
      logger.warn(
        "Graphiti drain recovery timeout exceeded; leaving in-flight drain intact",
        { groupId, timeoutMs: this.drainRecoveryDelayMs },
      );
    }, this.drainRecoveryDelayMs);

    this.drainRecoveryTimers.set(groupId, { run, timer });
  }

  private clearDrainRecovery(groupId: string, run: Promise<void>): void {
    const recovery = this.drainRecoveryTimers.get(groupId);
    if (!recovery || recovery.run !== run) return;
    this.clearTimerImpl(recovery.timer);
    this.drainRecoveryTimers.delete(groupId);
  }

  schedulePrimer(groupId: string): void {
    if (this.stopped) return;
    if (this.primerInFlight.has(groupId)) return;
    const run = (async () => {
      const existing = await this.cache.get(groupId);
      if (existing) return;
      const episodes = await this.graphiti.getEpisodes({ groupId, lastN: 5 });
      if (this.stopped) return;
      if (episodes.length === 0) return;
      const entry: PersistentMemoryCacheEntry = {
        query: "primer",
        refreshedAt: Date.now(),
        nodes: [],
        nodeRefs: [],
        episodeSummaries: episodes.map((episode) =>
          `${episode.name}: ${episode.content}`.slice(0, 240)
        ),
      };
      await this.cache.set(groupId, entry);
    })().catch((err) => logger.warn("Graphiti primer failed", err)).finally(
      () => this.primerInFlight.delete(groupId),
    );
    this.primerInFlight.set(groupId, run);
  }

  scheduleCacheRefresh(groupId: string, query: string): void {
    if (this.stopped) return;
    const normalized = query.trim();
    if (!normalized) return;
    const key = groupId;
    if (this.refreshInFlight.has(key)) {
      void this.cache.rememberRefreshQuery(groupId, normalized).catch((err) =>
        logger.warn("Graphiti refresh query update failed", err)
      );
      return;
    }

    const run = (async () => {
      await this.cache.rememberRefreshQuery(groupId, normalized);
      if (this.stopped) return;
      const [facts, result] = await Promise.all([
        this.graphiti.searchMemoryFacts({
          query: normalized,
          groupIds: [groupId],
          maxFacts: 8,
        }),
        this.graphiti.searchNodesWithStatus({
          query: normalized,
          groupIds: [groupId],
          maxNodes: 12,
        }),
      ]);
      if (this.stopped) return;

      const [meta, current] = await Promise.all([
        this.cache.getMeta(groupId),
        this.cache.get(groupId),
      ]);
      const latestQuery = meta?.lastQuery ?? current?.query;
      if (
        latestQuery &&
        latestQuery.trim().toLowerCase() !== normalized.toLowerCase()
      ) {
        return;
      }
      if (this.stopped) return;

      const nodes = result.degraded ? [] : result.nodes;
      await this.cache.set(groupId, {
        query: normalized,
        refreshedAt: Date.now(),
        nodes,
        episodeSummaries: facts.map((fact) => {
          const source = fact.source_node?.name?.trim();
          const target = fact.target_node?.name?.trim();
          const relation = [source, target].filter(Boolean).join(" → ");
          return relation ? `${relation}: ${fact.fact}` : fact.fact;
        }),
        nodeRefs: nodes.map((node) => node.uuid),
      });
    })().catch((err) => logger.warn("Graphiti cache refresh failed", err))
      .finally(async () => {
        this.refreshInFlight.delete(key);
        try {
          if (this.stopped) return;
          const latestQuery = (await this.cache.getMeta(groupId))?.lastQuery;
          if (
            latestQuery &&
            latestQuery.trim().toLowerCase() !== normalized.toLowerCase()
          ) {
            this.scheduleCacheRefresh(groupId, latestQuery);
          }
        } catch (err) {
          logger.warn("Graphiti follow-up cache refresh failed", err);
        }
      });

    this.refreshInFlight.set(key, run);
  }

  scheduleDrain(groupId: string): void {
    if (this.stopped) return;
    const inFlight = this.drainInFlight.get(groupId);
    if (inFlight) {
      this.armDrainRecovery(groupId, inFlight);
      return;
    }
    const retryTimer = this.drainRetryTimers.get(groupId);
    if (retryTimer) {
      this.clearTimerImpl(retryTimer);
      this.drainRetryTimers.delete(groupId);
    }
    const run = (async () => {
      let shouldRefresh = false;
      while (true) {
        if (this.stopped) break;
        const result = await this.drain.drainGroup(groupId, this.graphiti);
        if (this.stopped) break;
        if (result.status === "success" || result.status === "dead-letter") {
          shouldRefresh = true;
          continue;
        }
        if (result.status === "backoff") {
          this.armDrainRetry(
            groupId,
            result.retryAfterMs ?? this.drainRetryDelayMs,
          );
        }
        if (result.status === "retry") {
          this.armDrainRetry(groupId);
        }
        break;
      }
      if (this.stopped) return;
      if (shouldRefresh) {
        const [current, meta] = await Promise.all([
          this.cache.get(groupId),
          this.cache.getMeta(groupId),
        ]);
        if (this.stopped) return;
        const refreshQuery = meta?.lastQuery || current?.query;
        if (refreshQuery) this.scheduleCacheRefresh(groupId, refreshQuery);
      }
    })().catch((err) => logger.warn("Graphiti drain failed", err)).finally(
      () => {
        this.clearDrainRecovery(groupId, run);
        if (this.drainInFlight.get(groupId) === run) {
          this.drainInFlight.delete(groupId);
        }
      },
    );
    this.drainInFlight.set(groupId, run);
    this.armDrainRecovery(groupId, run);
  }
}
