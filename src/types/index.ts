/** Plugin configuration for Graphiti memory integration. */
export interface GraphitiConfig {
  /** URL of the Graphiti MCP server endpoint. */
  endpoint: string;
  /** Prefix for group IDs to namespace project memories. */
  groupIdPrefix: string;
  /** Jaccard similarity threshold below which reinjection occurs. */
  driftThreshold: number;
  /** Number of days after which facts are considered stale. */
  factStaleDays: number;
}

/** A fact retrieved from the Graphiti knowledge graph. */
export interface GraphitiFact {
  /** Unique identifier for the fact. */
  uuid: string;
  /** Human-readable fact content. */
  fact: string;
  /** Timestamp when the fact becomes valid. */
  valid_at?: string;
  /** Timestamp when the fact becomes invalid. */
  invalid_at?: string;
  /** Source entity for the fact edge. */
  source_node?: { name: string; uuid: string };
  /** Target entity for the fact edge. */
  target_node?: { name: string; uuid: string };
}

/** A node retrieved from the Graphiti knowledge graph. */
export interface GraphitiNode {
  /** Unique identifier for the node. */
  uuid: string;
  /** Display name of the node. */
  name: string;
  /** Optional summary describing the node. */
  summary?: string;
  /** Optional labels associated with the node. */
  labels?: string[];
}

/**
 * An episode retrieved from Graphiti memory.
 *
 * `sourceDescription` is the canonical field.  Raw payloads may carry either
 * `sourceDescription` (camelCase) or `source_description` (snake_case); the
 * boundary helper `normalizeEpisode()` in `src/services/sdk-normalize.ts`
 * collapses both into `sourceDescription` so downstream consumers only need to
 * check one field.
 */
export interface GraphitiEpisode {
  /** Unique identifier for the episode. */
  uuid: string;
  /** Episode title or name. */
  name: string;
  /** Episode content body. */
  content: string;
  /** Optional episode source type. */
  source?: string;
  /**
   * Canonical source description (normalized from either camelCase or
   * snake_case payload).  Always populated by `normalizeEpisode()`.
   */
  sourceDescription?: string;
  /** Optional episode creation timestamp. */
  created_at?: string;
  /** Optional labels associated with the episode. */
  labels?: string[];
}
