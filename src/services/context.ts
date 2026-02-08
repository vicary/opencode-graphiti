import type { GraphitiFact, GraphitiNode } from "../types/index.ts";

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
    for (const fact of facts) {
      const entities: string[] = [];
      if (fact.source_node?.name) entities.push(fact.source_node.name);
      if (fact.target_node?.name) entities.push(fact.target_node.name);
      const entityStr = entities.length > 0
        ? ` [${entities.join(" -> ")}]`
        : "";
      sections.push(`- ${fact.fact}${entityStr}`);
    }
    sections.push("");
  }

  if (nodes.length > 0) {
    sections.push("## Known Entities");
    for (const node of nodes) {
      const labels = node.labels?.length ? ` (${node.labels.join(", ")})` : "";
      const summary = node.summary ? `: ${node.summary}` : "";
      sections.push(`- **${node.name}**${labels}${summary}`);
    }
    sections.push("");
  }

  if (facts.length === 0 && nodes.length === 0) {
    return "";
  }

  return sections.join("\n");
}
