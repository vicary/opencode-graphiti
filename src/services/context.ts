import type { GraphitiFact, GraphitiNode } from "../types/index.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export const parseDate = (value?: string): Date | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed);
};

export const isFactInvalid = (fact: GraphitiFact, now: Date): boolean => {
  const invalidAt = parseDate(fact.invalid_at);
  if (invalidAt && invalidAt.getTime() < now.getTime()) return true;

  const validAt = parseDate(fact.valid_at);
  if (validAt && validAt.getTime() > now.getTime()) return true;

  return false;
};

export const annotateStaleFact = (
  fact: GraphitiFact,
  now: Date,
  factStaleDays: number,
): GraphitiFact => {
  const validAt = parseDate(fact.valid_at);
  if (!validAt) return fact;
  const ageDays = Math.floor((now.getTime() - validAt.getTime()) / DAY_MS);
  if (ageDays < 0) return fact;
  if (ageDays < factStaleDays) return fact;
  return {
    ...fact,
    fact: `[stale: ${ageDays} days ago] ${fact.fact}`,
  };
};

export const sortFactsByRecency = (facts: GraphitiFact[]): GraphitiFact[] => {
  const indexed = facts.map((fact, index) => ({
    fact,
    index,
    time: parseDate(fact.valid_at)?.getTime() ?? -Infinity,
  }));
  indexed.sort((a, b) => {
    if (a.time !== b.time) return b.time - a.time;
    return a.index - b.index;
  });
  return indexed.map((entry) => entry.fact);
};

export const filterAndAnnotateFacts = (
  facts: GraphitiFact[],
  options?: {
    factStaleDays?: number;
    now?: Date;
  },
): GraphitiFact[] => {
  const now = options?.now ?? new Date();
  const factStaleDays = options?.factStaleDays ?? 30;
  const filtered = facts.filter((fact) => !isFactInvalid(fact, now));
  const sorted = sortFactsByRecency(filtered);
  return sorted.map((fact) => annotateStaleFact(fact, now, factStaleDays));
};

export const formatFactLine = (fact: GraphitiFact): string => {
  const entities: string[] = [];
  if (fact.source_node?.name) entities.push(fact.source_node.name);
  if (fact.target_node?.name) entities.push(fact.target_node.name);
  const entityStr = entities.length > 0 ? ` [${entities.join(" -> ")}]` : "";
  return `<fact>${fact.fact}${entityStr}</fact>`;
};

export const formatFactLines = (
  facts: GraphitiFact[],
  options?: {
    factStaleDays?: number;
    now?: Date;
  },
): string[] => {
  const annotated = filterAndAnnotateFacts(facts, options);
  return annotated.map((fact) => formatFactLine(fact));
};

export const formatNodeLines = (nodes: GraphitiNode[]): string[] =>
  nodes.map((node) => {
    const labels = node.labels?.length ? ` (${node.labels.join(", ")})` : "";
    const summary = node.summary ? `: ${node.summary}` : "";
    return `<node>${node.name}${labels}${summary}</node>`;
  });

export const deduplicateFactsByUuid = (
  facts: GraphitiFact[],
): GraphitiFact[] => {
  const seen = new Set<string>();
  const deduped: GraphitiFact[] = [];
  for (const fact of facts) {
    if (seen.has(fact.uuid)) continue;
    seen.add(fact.uuid);
    deduped.push(fact);
  }
  return deduped;
};

export const deduplicateNodesByUuid = (
  nodes: GraphitiNode[],
): GraphitiNode[] => {
  const seen = new Set<string>();
  const deduped: GraphitiNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.uuid)) continue;
    seen.add(node.uuid);
    deduped.push(node);
  }
  return deduped;
};

export const removeNodesReferencedByFacts = (
  facts: GraphitiFact[],
  nodes: GraphitiNode[],
): GraphitiNode[] => {
  const factNodeUuids = new Set<string>();
  for (const fact of facts) {
    if (fact.source_node?.uuid) factNodeUuids.add(fact.source_node.uuid);
    if (fact.target_node?.uuid) factNodeUuids.add(fact.target_node.uuid);
  }
  return nodes.filter((node) => !factNodeUuids.has(node.uuid));
};

export const deduplicateContext = (params: {
  facts: GraphitiFact[];
  nodes: GraphitiNode[];
}): { facts: GraphitiFact[]; nodes: GraphitiNode[] } => {
  const dedupedFacts = deduplicateFactsByUuid(params.facts);
  const dedupedNodes = deduplicateNodesByUuid(params.nodes);
  const filteredNodes = removeNodesReferencedByFacts(
    dedupedFacts,
    dedupedNodes,
  );
  return { facts: dedupedFacts, nodes: filteredNodes };
};

/**
 * Format Graphiti facts and nodes into a user-facing context block.
 */
export function formatMemoryContext(
  facts: GraphitiFact[],
  nodes: GraphitiNode[],
  options?: {
    factStaleDays?: number;
    now?: Date;
  },
): string {
  if (facts.length === 0 && nodes.length === 0) {
    return "";
  }

  const sections: string[] = [];
  sections.push("<memory>");
  sections.push(
    "<instruction>Background context only; do not reference in titles, summaries, or opening responses unless directly relevant.</instruction>",
  );

  if (facts.length > 0) {
    sections.push("<facts>");
    sections.push(...formatFactLines(facts, options));
    sections.push("</facts>");
  }

  if (nodes.length > 0) {
    sections.push("<nodes>");
    sections.push(...formatNodeLines(nodes));
    sections.push("</nodes>");
  }

  sections.push("</memory>");

  return sections.join("\n");
}
