import type {
  CacheRefreshDecision,
  GraphitiNode,
  PersistentMemoryCacheEntry,
  PersistentMemoryCacheMeta,
} from "../types/index.ts";
import type { RedisClient } from "./redis-client.ts";
import { memoryCacheKey, memoryCacheMetaKey } from "./redis-events.ts";
import {
  escapeXml,
  isHighValueMemoryText,
  looksLikeOperationalChatter,
  looksLikeToolTranscript,
  looksTranscriptHeavy,
  sanitizeMemoryInput,
  stripInjectedMemoryBlocks,
} from "./render-utils.ts";

const formatNode = (node: GraphitiNode): string =>
  sanitizeMemoryInput(
    node.summary ? `${node.name}: ${node.summary}` : node.name,
  );

const normalizeRenderedPersistentText = (value: string): string =>
  value.toLowerCase()
    .replace(/&(?:amp|lt|gt|quot|apos);/g, " ")
    .replace(/[^a-z0-9./_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export interface RedisCacheServiceOptions {
  ttlSeconds: number;
  driftThreshold: number;
}

const TOKEN_PATTERN = /[a-z0-9._/-]{2,}/g;
const NODE_RENDER_LIMIT = 180;
const EPISODE_RENDER_LIMIT = 180;
export const PERSISTENT_MEMORY_BODY_BUDGET = 1_800;

const isLowValuePersistentText = (value: string): boolean => {
  const sanitized = sanitizeMemoryInput(value);
  if (!sanitized) return true;
  if (looksLikeToolTranscript(sanitized)) return true;
  if (looksLikeOperationalChatter(sanitized)) return true;
  if (looksTranscriptHeavy(sanitized)) return true;
  return !isHighValueMemoryText(sanitized);
};

const distinctByNormalized = <T>(
  values: T[],
  getNormalizedText: (value: T) => string,
): T[] => {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const normalized = getNormalizedText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value);
  }
  return result;
};

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
  const union = leftTokens.size + rightTokens.size - intersection;
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

    const hasLastRefresh = Object.hasOwn(raw, "lastRefresh");
    const parsedLastRefresh = hasLastRefresh ? Number(raw.lastRefresh) : NaN;

    return {
      lastQuery: raw.lastQuery?.trim() || undefined,
      lastRefresh: Number.isFinite(parsedLastRefresh)
        ? parsedLastRefresh
        : undefined,
    };
  }

  async rememberRefreshQuery(groupId: string, query: string): Promise<void> {
    const normalized = sanitizeMemoryInput(stripInjectedMemoryBlocks(query));
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
    const sanitizedEntry: PersistentMemoryCacheEntry = {
      query: sanitizeMemoryInput(stripInjectedMemoryBlocks(entry.query)),
      refreshedAt: entry.refreshedAt,
      nodes: entry.nodes.map((node) => ({
        ...node,
        name: sanitizeMemoryInput(stripInjectedMemoryBlocks(node.name)),
        summary: node.summary
          ? sanitizeMemoryInput(stripInjectedMemoryBlocks(node.summary))
          : undefined,
      })).filter((node) => node.name),
      episodeSummaries: entry.episodeSummaries?.map((episode) =>
        sanitizeMemoryInput(stripInjectedMemoryBlocks(episode))
      ).filter(Boolean),
      nodeRefs: [...entry.nodeRefs],
    };
    await this.redis.setString(
      memoryCacheKey(groupId),
      JSON.stringify(sanitizedEntry),
      this.options.ttlSeconds,
    );
    await this.redis.setHashFields(
      memoryCacheMetaKey(groupId),
      {
        lastQuery: sanitizedEntry.query,
        lastRefresh: sanitizedEntry.refreshedAt,
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
    const hasNodes = entry.nodes.length > 0;
    if (
      normalizedCachedQuery === "primer" &&
      normalizedQuery &&
      hasPrimerEpisodes &&
      !hasNodes
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
    budget = PERSISTENT_MEMORY_BODY_BUDGET,
  ): { body: string; nodeRefs: string[] } {
    if (!entry) return { body: "", nodeRefs: [] };

    const renderedNodes = distinctByNormalized(
      entry.nodes.flatMap((node) => {
        const rendered = formatNode(node);
        const normalized = normalizeRenderedPersistentText(rendered);
        if (!normalized || isLowValuePersistentText(rendered)) return [];
        return [{ uuid: node.uuid, rendered, normalized }];
      }),
      (node) => node.normalized,
    );
    const renderedEpisodes = distinctByNormalized(
      (entry.episodeSummaries ?? []).flatMap((episode) => {
        const rendered = sanitizeMemoryInput(episode);
        const normalized = normalizeRenderedPersistentText(rendered);
        if (!normalized || isLowValuePersistentText(rendered)) return [];
        return [{ rendered, normalized }];
      }),
      (episode) => episode.normalized,
    );

    const sections: string[] = [];
    const nodeRefs: string[] = [];
    let remaining = Math.max(0, budget);
    for (const node of renderedNodes.slice(0, 3)) {
      const renderedNode = node.rendered.slice(0, NODE_RENDER_LIMIT);
      if (!renderedNode) continue;
      const section = `<node>${
        escapeXml(
          renderedNode,
        )
      }</node>`;
      if (section.length > remaining) break;
      sections.push(section);
      nodeRefs.push(node.uuid);
      remaining -= section.length;
    }
    for (const episode of renderedEpisodes.slice(0, 2)) {
      const sanitizedEpisode = episode.rendered.slice(
        0,
        EPISODE_RENDER_LIMIT,
      );
      if (!sanitizedEpisode) continue;
      const section = `<episode>${
        escapeXml(
          sanitizedEpisode,
        )
      }</episode>`;
      if (section.length > remaining) break;
      sections.push(section);
      remaining -= section.length;
    }

    return { body: sections.join(""), nodeRefs };
  }
}
