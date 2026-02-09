/** Plugin configuration for Graphiti memory integration. */
export interface GraphitiConfig {
  /** URL of the Graphiti MCP server endpoint. */
  endpoint: string;
  /** Prefix for group IDs to namespace project memories. */
  groupIdPrefix: string;
  /** Number of user messages between reinjections (0 disables). */
  injectionInterval: number;
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

/** Response payload containing Graphiti facts. */
export interface GraphitiFactsResponse {
  /** List of facts from Graphiti. */
  facts: GraphitiFact[];
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

/** Response payload containing Graphiti nodes. */
export interface GraphitiNodesResponse {
  /** List of nodes from Graphiti. */
  nodes: GraphitiNode[];
}

/** An episode retrieved from Graphiti memory. */
export interface GraphitiEpisode {
  /** Unique identifier for the episode. */
  uuid: string;
  /** Episode title or name. */
  name: string;
  /** Episode content body. */
  content: string;
  /** Optional episode source type. */
  source?: string;
  /** Optional episode creation timestamp. */
  created_at?: string;
  /** Optional labels associated with the episode. */
  labels?: string[];
}
