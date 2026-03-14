import type { PersistentMemoryCacheEntry } from "../types/index.ts";
import type { BatchDrainService } from "./batch-drain.ts";
import type { GraphitiMcpClient } from "./graphiti-mcp.ts";
import type { RedisCacheService } from "./redis-cache.ts";
import { logger } from "./logger.ts";

export class GraphitiAsyncService {
  private readonly drainInFlight = new Map<string, Promise<void>>();
  private readonly refreshInFlight = new Map<string, Promise<void>>();
  private readonly primerInFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly graphiti: GraphitiMcpClient,
    private readonly cache: RedisCacheService,
    private readonly drain: BatchDrainService,
  ) {}

  schedulePrimer(groupId: string): void {
    if (this.primerInFlight.has(groupId)) return;
    const run = (async () => {
      const existing = await this.cache.get(groupId);
      if (existing) return;
      const episodes = await this.graphiti.getEpisodes({ groupId, lastN: 5 });
      if (episodes.length === 0) return;
      const entry: PersistentMemoryCacheEntry = {
        query: "primer",
        refreshedAt: Date.now(),
        facts: [],
        nodes: [],
        factUuids: [],
        nodeRefs: [],
        episodeSummaries: episodes.map((episode) =>
          `${episode.name}: ${episode.content}`.slice(0, 240)
        ),
      };
      await this.cache.set(groupId, entry);
    })().catch((err) => logger.debug("Graphiti primer failed", err)).finally(
      () => this.primerInFlight.delete(groupId),
    );
    this.primerInFlight.set(groupId, run);
  }

  scheduleCacheRefresh(groupId: string, query: string): void {
    const normalized = query.trim();
    if (!normalized) return;
    const key = `${groupId}:${normalized.toLowerCase()}`;
    if (this.refreshInFlight.has(key)) return;

    const run = (async () => {
      await this.cache.rememberRefreshQuery(groupId, normalized);
      const [facts, nodes] = await Promise.all([
        this.graphiti.searchMemoryFacts({
          query: normalized,
          groupIds: [groupId],
          maxFacts: 20,
        }),
        this.graphiti.searchNodes({
          query: normalized,
          groupIds: [groupId],
          maxNodes: 12,
        }),
      ]);
      await this.cache.set(groupId, {
        query: normalized,
        refreshedAt: Date.now(),
        facts,
        nodes,
        factUuids: facts.map((fact) => fact.uuid),
        nodeRefs: nodes.map((node) => node.uuid),
      });
    })().catch((err) => logger.debug("Graphiti cache refresh failed", err))
      .finally(() => this.refreshInFlight.delete(key));

    this.refreshInFlight.set(key, run);
  }

  scheduleDrain(groupId: string): void {
    if (this.drainInFlight.has(groupId)) return;
    const run = (async () => {
      const result = await this.drain.drainGroup(groupId, this.graphiti);
      if (result.status === "success" || result.status === "dead-letter") {
        const [current, meta] = await Promise.all([
          this.cache.get(groupId),
          this.cache.getMeta(groupId),
        ]);
        const refreshQuery = current?.query || meta?.lastQuery;
        if (refreshQuery) this.scheduleCacheRefresh(groupId, refreshQuery);
      }
    })().catch((err) => logger.debug("Graphiti drain failed", err)).finally(
      () => this.drainInFlight.delete(groupId),
    );
    this.drainInFlight.set(groupId, run);
  }
}
