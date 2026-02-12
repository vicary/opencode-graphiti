import type { GraphitiFact, GraphitiNode } from "../types/index.ts";

export const formatFactLines = (facts: GraphitiFact[]): string[] =>
  facts.map((fact) => {
    const entities: string[] = [];
    if (fact.source_node?.name) entities.push(fact.source_node.name);
    if (fact.target_node?.name) entities.push(fact.target_node.name);
    const entityStr = entities.length > 0 ? ` [${entities.join(" -> ")}]` : "";
    return `<fact>${fact.fact}${entityStr}</fact>`;
  });

export const formatNodeLines = (nodes: GraphitiNode[]): string[] =>
  nodes.map((node) => {
    const labels = node.labels?.length ? ` (${node.labels.join(", ")})` : "";
    const summary = node.summary ? `: ${node.summary}` : "";
    return `<node>${node.name}${labels}${summary}</node>`;
  });

/**
 * Format Graphiti facts and nodes into a user-facing context block.
 */
export function formatMemoryContext(
  facts: GraphitiFact[],
  nodes: GraphitiNode[],
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
    sections.push(...formatFactLines(facts));
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
