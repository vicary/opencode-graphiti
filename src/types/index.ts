/** FalkorDB/Redis hot-tier configuration. */
export interface FalkorDbConfig {
  redisEndpoint: string;
  batchSize: number;
  batchMaxBytes: number;
  sessionTtlSeconds: number;
  cacheTtlSeconds: number;
  drainRetryMax: number;
}

/** Graphiti async-tier configuration. */
export interface GraphitiServiceConfig {
  endpoint: string;
  groupIdPrefix: string;
  driftThreshold: number;
  factStaleDays: number;
}

/** Plugin configuration for hot-tier + Graphiti async integration. */
export interface GraphitiConfig {
  falkordb: FalkorDbConfig;
  graphiti: GraphitiServiceConfig;

  // Legacy top-level keys retained for compatibility.
  endpoint?: string;
  groupIdPrefix?: string;
  driftThreshold?: number;
  factStaleDays?: number;
  redisEndpoint?: string;
  batchSize?: number;
  batchMaxBytes?: number;
  sessionTtlSeconds?: number;
  cacheTtlSeconds?: number;
  drainRetryMax?: number;
}

/** A fact retrieved from the Graphiti knowledge graph. */
export interface GraphitiFact {
  uuid: string;
  fact: string;
  valid_at?: string;
  invalid_at?: string;
  source_node?: { name: string; uuid: string };
  target_node?: { name: string; uuid: string };
}

/** A node retrieved from the Graphiti knowledge graph. */
export interface GraphitiNode {
  uuid: string;
  name: string;
  summary?: string;
  labels?: string[];
}

/** A recent episode retrieved from Graphiti memory. */
export interface GraphitiEpisode {
  uuid: string;
  name: string;
  content: string;
  source?: string;
  sourceDescription?: string;
  created_at?: string;
  labels?: string[];
}

export type EventCategory =
  | "task.create"
  | "task.update"
  | "task.complete"
  | "decision"
  | "preference"
  | "rule.load"
  | "file.read"
  | "file.write"
  | "file.edit"
  | "file.search"
  | "cwd.change"
  | "env.change"
  | "git.activity"
  | "error"
  | "subagent.start"
  | "subagent.finish"
  | "integration.call"
  | "intent"
  | "data.import"
  | "discovery"
  | "message"
  | "session.meta";

export type SessionEventSourceKind =
  | "user-request"
  | "assistant-response"
  | "tool-activity"
  | "system-state";

export interface SessionEvent {
  id: string;
  ts: number;
  category: EventCategory;
  priority: 0 | 1 | 2 | 3 | 4;
  role: "user" | "assistant" | "tool" | "system";
  summary: string;
  body?: string;
  detail?: string;
  continuityText?: string;
  keywords?: string[];
  sourceKind?: SessionEventSourceKind;
  refs?: string[];
  metadata?: Record<string, unknown>;
}

const compactEventText = (values: Array<string | undefined>): string =>
  [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])]
    .join(" ")
    .trim();

const metadataRecallText = (metadata?: Record<string, unknown>): string => {
  if (!metadata) return "";
  const values: string[] = [];
  for (
    const [key, value] of Object.entries(metadata).filter(([, value]) =>
      typeof value === "string" || typeof value === "number" ||
      typeof value === "boolean"
    )
  ) {
    if (/^(eventType|tool|integration|cwd|status|result|reason)$/i.test(key)) {
      values.push(String(value));
    }
  }
  return values.join(" ");
};

export const getSessionEventPrimaryText = (
  event: SessionEvent,
  fallback?: string,
): string =>
  event.continuityText?.trim() || event.detail?.trim() ||
  event.summary.trim() ||
  event.body?.trim() || fallback || "";

export const getSessionEventRecallText = (event: SessionEvent): string =>
  compactEventText([
    event.summary,
    event.continuityText,
    event.detail,
    event.refs?.join(" "),
    event.keywords?.join(" "),
    metadataRecallText(event.metadata),
    event.category,
    event.sourceKind,
  ]);

export interface PersistentMemoryCacheEntry {
  query: string;
  refreshedAt: number;
  facts: GraphitiFact[];
  nodes: GraphitiNode[];
  episodeSummaries?: string[];
  factUuids: string[];
  nodeRefs: string[];
}

export interface PersistentMemoryCacheMeta {
  lastQuery?: string;
  lastRefresh?: number;
  factUuids: string[];
}

export type CacheRefreshClassification =
  | "miss"
  | "stale"
  | "primer-only"
  | "aligned"
  | "drifted";

export interface CacheRefreshDecision {
  classification: CacheRefreshClassification;
  shouldRefresh: boolean;
  similarity: number;
  threshold: number;
  cachedQuery: string | null;
}

export interface DrainQueueEntry {
  sessionId: string;
  groupId: string;
  event: SessionEvent;
}

export interface ClaimedDrainBatch {
  claimToken: string;
  claimKey: string;
  lockTtlSeconds: number;
  entries: DrainQueueEntry[];
}

export interface PreparedSessionMemory {
  envelope: string;
  factUuids: string[];
  nodeRefs: string[];
  refreshDecision: CacheRefreshDecision;
}
