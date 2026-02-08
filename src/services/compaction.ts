import type { GraphitiClient } from "./client.ts";
import type { GraphitiConfig } from "../types/index.ts";
import { logger } from "./logger.ts";

export async function handleCompaction(params: {
  client: GraphitiClient;
  config: GraphitiConfig;
  groupId: string;
  summary: string;
  sessionId: string;
}): Promise<void> {
  const { client, config, groupId, summary, sessionId } = params;

  if (!config.enableCompactionSave || !summary) return;

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

export async function getCompactionContext(params: {
  client: GraphitiClient;
  config: GraphitiConfig;
  groupId: string;
  contextStrings: string[];
}): Promise<string[]> {
  const { client, config, groupId, contextStrings } = params;

  try {
    const queryText = contextStrings.slice(0, 3).join(" ").slice(0, 500);
    if (!queryText) return [];

    const facts = await client.searchFacts({
      query: queryText,
      groupIds: [groupId],
      maxFacts: config.maxFacts,
    });

    if (facts.length === 0) return [];

    const lines = [
      "## Persistent Knowledge (preserve these facts during compaction):",
      ...facts.map((fact) => `- ${fact.fact}`),
    ];

    return [lines.join("\n")];
  } catch (err) {
    logger.error("Failed to get compaction context:", err);
    return [];
  }
}
