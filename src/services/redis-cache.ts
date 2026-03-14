import type {
  CacheRefreshDecision,
  GraphitiFact,
  GraphitiNode,
  PersistentMemoryCacheEntry,
  PersistentMemoryCacheMeta,
} from "../types/index.ts";
import { escapeXml } from "./render-utils.ts";
import type { RedisClient } from "./redis-client.ts";
import { memoryCacheKey, memoryCacheMetaKey } from "./redis-events.ts";

const formatFact = (fact: GraphitiFact): string => {
  const refs = [fact.source_node?.name, fact.target_node?.name]
    .filter(Boolean)
    .join(" → ");
  return refs ? `${fact.fact} (${refs})` : fact.fact;
};

const formatNode = (node: GraphitiNode): string =>
  node.summary ? `${node.name}: ${node.summary}` : node.name;

export interface RedisCacheServiceOptions {
  ttlSeconds: number;
  driftThreshold: number;
}

const TOKEN_PATTERN = /[a-z0-9._/-]{2,}/g;
const FACT_RENDER_LIMIT = 220;
const NODE_RENDER_LIMIT = 180;
const EPISODE_RENDER_LIMIT = 180;
const PERSISTENT_MEMORY_BODY_BUDGET = 1_800;

const normalizeQuery = (query: string): string => query.trim().toLowerCase();

const tokenizeQuery = (query: string): Set<string> => {
  const normalized = normalizeQuery(query);
  return new Set(normalized.match(TOKEN_PATTERN) ?? []);
};

const jaccardSimilarity = (left: string, right: string): number => {
  const leftTokens = tokenizeQuery(left);
  const rightTokens = tokenizeQuery(right);

  if (leftTokens.size === 0 && rightTokens.size === 0) return 1;
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
};

export class RedisCacheService {
  constructor(
    private readonly redis: RedisClient,
    private readonly options: RedisCacheServiceOptions,
  ) {}

  async get(groupId: string): Promise<PersistentMemoryCacheEntry | null> {
    const raw = await this.redis.getString(memoryCacheKey(groupId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PersistentMemoryCacheEntry;
    } catch {
      return null;
    }
  }

  async getMeta(groupId: string): Promise<PersistentMemoryCacheMeta | null> {
    const raw = await this.redis.getHashAll(memoryCacheMetaKey(groupId));
    if (Object.keys(raw).length === 0) return null;

    return {
      lastQuery: raw.lastQuery?.trim() || undefined,
      lastRefresh: raw.lastRefresh && Number.isFinite(Number(raw.lastRefresh))
        ? Number(raw.lastRefresh)
        : undefined,
      factUuids: raw.factUuids
        ? raw.factUuids.split(",").map((value) => value.trim()).filter(Boolean)
        : [],
    };
  }

  async rememberRefreshQuery(groupId: string, query: string): Promise<void> {
    const normalized = query.trim();
    if (!normalized) return;

    await this.redis.setHashFields(
      memoryCacheMetaKey(groupId),
      { lastQuery: normalized },
      this.options.ttlSeconds,
    );
  }

  async touchEntry(groupId: string): Promise<void> {
    await this.redis.touch(memoryCacheKey(groupId), this.options.ttlSeconds);
  }

  async touchMeta(groupId: string): Promise<void> {
    await this.redis.touch(
      memoryCacheMetaKey(groupId),
      this.options.ttlSeconds,
    );
  }

  async touch(groupId: string): Promise<void> {
    await Promise.all([
      this.touchEntry(groupId),
      this.touchMeta(groupId),
    ]);
  }

  async set(
    groupId: string,
    entry: PersistentMemoryCacheEntry,
  ): Promise<void> {
    await this.redis.setString(
      memoryCacheKey(groupId),
      JSON.stringify(entry),
      this.options.ttlSeconds,
    );
    await this.redis.setHashFields(
      memoryCacheMetaKey(groupId),
      {
        lastQuery: entry.query,
        lastRefresh: entry.refreshedAt,
        factUuids: entry.factUuids.join(","),
      },
      this.options.ttlSeconds,
    );
  }

  isStale(entry: PersistentMemoryCacheEntry): boolean {
    return Date.now() - entry.refreshedAt > this.options.ttlSeconds * 1000;
  }

  classifyRefresh(
    entry: PersistentMemoryCacheEntry | null,
    query: string,
  ): CacheRefreshDecision {
    if (!entry) {
      return {
        classification: "miss",
        shouldRefresh: true,
        similarity: 0,
        threshold: this.options.driftThreshold,
        cachedQuery: null,
      };
    }

    if (this.isStale(entry)) {
      return {
        classification: "stale",
        shouldRefresh: true,
        similarity: 0,
        threshold: this.options.driftThreshold,
        cachedQuery: entry.query,
      };
    }

    const normalizedQuery = normalizeQuery(query);
    const normalizedCachedQuery = normalizeQuery(entry.query);
    const hasPrimerEpisodes = (entry.episodeSummaries?.length ?? 0) > 0;
    const hasFactsOrNodes = entry.facts.length > 0 || entry.nodes.length > 0;
    if (
      normalizedCachedQuery === "primer" &&
      normalizedQuery &&
      hasPrimerEpisodes &&
      !hasFactsOrNodes
    ) {
      return {
        classification: "primer-only",
        shouldRefresh: true,
        similarity: 0,
        threshold: this.options.driftThreshold,
        cachedQuery: entry.query,
      };
    }

    const similarity = jaccardSimilarity(entry.query, query);
    const aligned = similarity >= this.options.driftThreshold;
    return {
      classification: aligned ? "aligned" : "drifted",
      shouldRefresh: !aligned,
      similarity,
      threshold: this.options.driftThreshold,
      cachedQuery: entry.query,
    };
  }

  shouldRefresh(
    entry: PersistentMemoryCacheEntry | null,
    query: string,
  ): boolean {
    return this.classifyRefresh(entry, query).shouldRefresh;
  }

  renderPersistentMemory(
    entry: PersistentMemoryCacheEntry | null,
    visibleFactUuids: string[] = [],
  ): { body: string; factUuids: string[]; nodeRefs: string[] } {
    if (!entry) return { body: "", factUuids: [], nodeRefs: [] };
    const visible = new Set(visibleFactUuids);
    const facts = entry.facts.filter((fact) => !visible.has(fact.uuid));

    const sections: string[] = [];
    const factUuids: string[] = [];
    const nodeRefs: string[] = [];
    let remaining = PERSISTENT_MEMORY_BODY_BUDGET;
    for (const fact of facts.slice(0, 8)) {
      const section = `<fact>${
        escapeXml(
          formatFact(fact).slice(0, FACT_RENDER_LIMIT),
        )
      }</fact>`;
      if (section.length > remaining) break;
      sections.push(section);
      factUuids.push(fact.uuid);
      remaining -= section.length;
    }
    for (const node of entry.nodes.slice(0, 6)) {
      const section = `<node>${
        escapeXml(
          formatNode(node).slice(0, NODE_RENDER_LIMIT),
        )
      }</node>`;
      if (section.length > remaining) break;
      sections.push(section);
      nodeRefs.push(node.uuid);
      remaining -= section.length;
    }
    for (const episode of entry.episodeSummaries?.slice(0, 4) ?? []) {
      const section = `<episode>${
        escapeXml(
          episode.slice(0, EPISODE_RENDER_LIMIT),
        )
      }</episode>`;
      if (section.length > remaining) break;
      sections.push(section);
      remaining -= section.length;
    }

    return { body: sections.join(""), factUuids, nodeRefs };
  }
}
