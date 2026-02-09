import type { GraphitiFact, GraphitiNode } from "../types/index.ts";
import { formatFactLines, formatNodeLines } from "./context.ts";
import { logger } from "./logger.ts";

/**
 * Persist a compaction summary episode when enabled.
 */
export async function handleCompaction(params: {
  client: {
    addEpisode: (args: {
      name: string;
      episodeBody: string;
      groupId?: string;
      source?: "text" | "json" | "message";
      sourceDescription?: string;
    }) => Promise<void>;
  };
  groupId: string;
  summary: string;
  sessionId: string;
}): Promise<void> {
  const { client, groupId, summary, sessionId } = params;

  if (!summary) return;

  try {
    await client.addEpisode({
      name: `Session compaction: ${sessionId}`,
      episodeBody: summary,
      groupId,
      source: "text",
      sourceDescription: "OpenCode session compaction summary",
    });
    logger.info("Saved compaction summary to Graphiti for session", sessionId);
  } catch (err) {
    logger.error("Failed to save compaction summary:", err);
  }
}

/**
 * Retrieve persistent fact context to include during compaction.
 */
export async function getCompactionContext(params: {
  client: {
    searchFacts: (args: {
      query: string;
      groupIds?: string[];
      maxFacts?: number;
    }) => Promise<GraphitiFact[]>;
    searchNodes: (args: {
      query: string;
      groupIds?: string[];
      maxNodes?: number;
    }) => Promise<GraphitiNode[]>;
  };
  characterBudget: number;
  groupIds: {
    project: string;
    user?: string;
  };
  contextStrings: string[];
}): Promise<string[]> {
  const { client, characterBudget, groupIds, contextStrings } = params;

  try {
    const queryText = contextStrings.slice(0, 3).join(" ").slice(0, 500);
    if (!queryText.trim()) return [];

    const projectFactsPromise = client.searchFacts({
      query: queryText,
      groupIds: [groupIds.project],
      maxFacts: 50,
    });
    const projectNodesPromise = client.searchNodes({
      query: queryText,
      groupIds: [groupIds.project],
      maxNodes: 30,
    });
    const userGroupId = groupIds.user;
    const userFactsPromise = userGroupId
      ? client.searchFacts({
        query: queryText,
        groupIds: [userGroupId],
        maxFacts: 20,
      })
      : Promise.resolve([] as GraphitiFact[]);
    const userNodesPromise = userGroupId
      ? client.searchNodes({
        query: queryText,
        groupIds: [userGroupId],
        maxNodes: 10,
      })
      : Promise.resolve([] as GraphitiNode[]);

    const [projectFacts, projectNodes, userFacts, userNodes] = await Promise
      .all([
        projectFactsPromise,
        projectNodesPromise,
        userFactsPromise,
        userNodesPromise,
      ]);

    if (
      projectFacts.length === 0 && projectNodes.length === 0 &&
      userFacts.length === 0 && userNodes.length === 0
    ) {
      return [];
    }

    const buildSection = (
      header: string,
      facts: GraphitiFact[],
      nodes: GraphitiNode[],
    ): string => {
      const lines: string[] = [];
      lines.push(header);
      if (facts.length > 0) {
        lines.push("### Facts");
        lines.push(...formatFactLines(facts));
      }
      if (nodes.length > 0) {
        lines.push("### Nodes");
        lines.push(...formatNodeLines(nodes));
      }
      return lines.join("\n");
    };

    const projectSection = buildSection(
      "## Persistent Knowledge (Project)",
      projectFacts,
      projectNodes,
    );
    const userSection = buildSection(
      "## Persistent Knowledge (User)",
      userFacts,
      userNodes,
    );

    const headerLines = [
      "## Current Goal",
      "- ",
      "",
      "## Work Completed",
      "- ",
      "",
      "## Remaining Tasks",
      "- ",
      "",
      "## Constraints & Decisions",
      "- ",
      "",
      "## Persistent Knowledge",
    ];
    const header = headerLines.join("\n");
    const base = `${header}\n`;
    const remainingBudget = Math.max(characterBudget - base.length, 0);
    const projectBudget = Math.floor(remainingBudget * 0.7);
    const userBudget = remainingBudget - projectBudget;
    const truncatedProject = projectSection.slice(0, projectBudget);
    const truncatedUser = userSection.slice(0, userBudget);

    const sections: string[] = [header];
    if (truncatedProject.trim()) sections.push(truncatedProject);
    if (truncatedUser.trim()) sections.push(truncatedUser);

    const content = sections.join("\n").slice(0, characterBudget);
    return [content];
  } catch (err) {
    logger.error("Failed to get compaction context:", err);
    return [];
  }
}
