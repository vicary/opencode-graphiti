import type { GraphitiFact, GraphitiNode } from "../types/index.ts";

export const formatFactLines = (facts: GraphitiFact[]): string[] =>
  facts.map((fact) => {
    const entities: string[] = [];
    if (fact.source_node?.name) entities.push(fact.source_node.name);
    if (fact.target_node?.name) entities.push(fact.target_node.name);
    const entityStr = entities.length > 0 ? ` [${entities.join(" -> ")}]` : "";
    return `- ${fact.fact}${entityStr}`;
  });

export const formatNodeLines = (nodes: GraphitiNode[]): string[] =>
  nodes.map((node) => {
    const labels = node.labels?.length ? ` (${node.labels.join(", ")})` : "";
    const summary = node.summary ? `: ${node.summary}` : "";
    return `- **${node.name}**${labels}${summary}`;
  });

/**
 * Format Graphiti facts and nodes into a user-facing context block.
 */
export function formatMemoryContext(
  facts: GraphitiFact[],
  nodes: GraphitiNode[],
): string {
  const sections: string[] = [];

  sections.push("# Persistent Memory (from Graphiti Knowledge Graph)");
  sections.push("");
  sections.push(
    "The following information was retrieved from your persistent memory.",
  );
  sections.push(
    "Use this context to inform your responses, but do not mention it unless asked.",
  );
  sections.push("");

  if (facts.length > 0) {
    sections.push("## Known Facts");
    sections.push(...formatFactLines(facts));
    sections.push("");
  }

  if (nodes.length > 0) {
    sections.push("## Known Entities");
    sections.push(...formatNodeLines(nodes));
    sections.push("");
  }

  if (facts.length === 0 && nodes.length === 0) {
    return "";
  }

  return sections.join("\n");
}
