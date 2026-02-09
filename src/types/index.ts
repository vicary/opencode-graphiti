export interface GraphitiConfig {
  endpoint: string;
  groupIdPrefix: string;
  maxFacts: number;
  maxNodes: number;
  maxEpisodes: number;
  injectOnFirstMessage: boolean;
  enableCompactionSave: boolean;
  // Preemptive compaction
  compactionThreshold?: number;
  minTokensForCompaction?: number;
  compactionCooldownMs?: number;
  autoResumeAfterCompaction?: boolean;
}

export interface GraphitiFact {
  uuid: string;
  fact: string;
  valid_at?: string;
  invalid_at?: string;
  source_node?: { name: string; uuid: string };
  target_node?: { name: string; uuid: string };
}

export interface GraphitiFactsResponse {
  facts: GraphitiFact[];
}

export interface GraphitiNode {
  uuid: string;
  name: string;
  summary?: string;
  labels?: string[];
}

export interface GraphitiNodesResponse {
  nodes: GraphitiNode[];
}

export interface GraphitiEpisode {
  uuid: string;
  name: string;
  content: string;
  source?: string;
  created_at?: string;
  labels?: string[];
}
