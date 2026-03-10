import type { GraphitiFact, GraphitiNode } from "../types/index.ts";
import { truncateAtLineBoundary } from "../utils.ts";
import {
  formatFactLines,
  formatNodeLines,
  resolveProjectUserContext,
} from "./context.ts";
import { DAY_MS, PROJECT_MAX_FACTS } from "./constants.ts";
import { logger } from "./logger.ts";
const DECISION_KEYWORDS = [
  "decided",
  "must",
  "should",
  "prefer",
  "constraint",
  "require",
  "chose",
  "always",
  "never",
  "schema",
  "architecture",
  "agreed",
  "design",
  "selected",
];

// Precompile keyword regex once, outside the fact-classification loop.
const DECISION_KEYWORD_REGEX = new RegExp(
  DECISION_KEYWORDS.map((kw) => `\\b${kw}\\b`).join("|"),
  "i",
);

export const classifyFacts = (
  facts: GraphitiFact[],
  now: Date,
): {
  decisions: GraphitiFact[];
  active: GraphitiFact[];
  background: GraphitiFact[];
} => {
  const decisions: GraphitiFact[] = [];
  const active: GraphitiFact[] = [];
  const background: GraphitiFact[] = [];
  const cutoff = now.getTime() - 7 * DAY_MS;

  for (const fact of facts) {
    const text = fact.fact;
    // Task 7: use precompiled regex instead of building one per keyword per fact.
    if (DECISION_KEYWORD_REGEX.test(text)) {
      decisions.push(fact);
      continue;
    }
    const validAt = fact.valid_at ? Date.parse(fact.valid_at) : NaN;
    if (!Number.isNaN(validAt) && validAt >= cutoff) {
      active.push(fact);
      continue;
    }
    background.push(fact);
  }

  return { decisions, active, background };
};

export const takeFactsWithinBudget = (
  facts: GraphitiFact[],
  budget: number,
  formatOptions: { factStaleDays: number; now: Date },
): GraphitiFact[] => {
  if (budget <= 0 || facts.length === 0) return [];

  const classified = classifyFacts(facts, formatOptions.now);
  const prioritized = [
    ...classified.decisions,
    ...classified.active,
    ...classified.background,
  ];
  const lines = formatFactLines(prioritized, formatOptions);
  const selected: GraphitiFact[] = [];
  let remaining = budget;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const length = line.length + 1;
    if (remaining - length < 0) continue;
    selected.push(prioritized[i]);
    remaining -= length;
  }
  return selected;
};

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
  factStaleDays?: number;
}): Promise<string[]> {
  const { client, characterBudget, groupIds, contextStrings } = params;
  const now = new Date();
  const factStaleDays = params.factStaleDays ?? 30;

  try {
    const queryText = contextStrings.slice(0, 3).join(" ").slice(0, 500);
    if (!queryText.trim()) return [];

    const projectFactsPromise = client.searchFacts({
      query: queryText,
      groupIds: [groupIds.project],
      maxFacts: PROJECT_MAX_FACTS,
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

    const {
      projectContext,
      userContext,
      projectFacts,
      projectNodes,
      userFacts,
      userNodes,
    } = await resolveProjectUserContext({
      projectFacts: projectFactsPromise,
      projectNodes: projectNodesPromise,
      userFacts: userFactsPromise,
      userNodes: userNodesPromise,
    });

    if (
      projectFacts.length === 0 && projectNodes.length === 0 &&
      userFacts.length === 0 && userNodes.length === 0
    ) {
      return [];
    }

    const formatOptions = { factStaleDays, now };

    // Task 1: build section line-by-line; truncate at a line boundary to avoid
    // cutting mid-tag or mid-line while still respecting the per-section budget.
    const buildSection = (
      header: string,
      facts: GraphitiFact[],
      nodes: GraphitiNode[],
      budget: number,
    ): string => {
      const lines: string[] = [];
      lines.push(header);
      lines.push(
        "<instruction>Background context only; do not reference in titles, summaries, or opening responses unless directly relevant.</instruction>",
      );

      const classified = classifyFacts(facts, now);
      const decisionBudget = Math.floor(budget * 0.4);
      const activeBudget = Math.floor(budget * 0.35);
      const backgroundBudget = budget - decisionBudget - activeBudget;

      const selectedDecisions = takeFactsWithinBudget(
        classified.decisions,
        decisionBudget,
        formatOptions,
      );
      const selectedActive = takeFactsWithinBudget(
        classified.active,
        activeBudget,
        formatOptions,
      );
      const selectedBackground = takeFactsWithinBudget(
        classified.background,
        backgroundBudget,
        formatOptions,
      );

      if (selectedDecisions.length > 0) {
        lines.push("<decisions>");
        lines.push(...formatFactLines(selectedDecisions, formatOptions));
        lines.push("</decisions>");
      }
      if (selectedActive.length > 0) {
        lines.push("<active_context>");
        lines.push(...formatFactLines(selectedActive, formatOptions));
        lines.push("</active_context>");
      }
      if (selectedBackground.length > 0) {
        lines.push("<background>");
        lines.push(...formatFactLines(selectedBackground, formatOptions));
        lines.push("</background>");
      }
      if (nodes.length > 0) {
        lines.push("<nodes>");
        lines.push(...formatNodeLines(nodes));
        lines.push("</nodes>");
      }
      return truncateAtLineBoundary(lines.join("\n"), budget);
    };

    const headerLines = [
      "<summary>",
      "<decisions>",
      "- ",
      "</decisions>",
      "",
      "<active_context>",
      "- ",
      "</active_context>",
      "",
      "<background>",
      "- ",
      "</background>",
      "",
      "<persistent_memory>",
    ];
    const header = headerLines.join("\n");
    const base = `${header}\n`;
    const remainingBudget = Math.max(characterBudget - base.length, 0);
    const projectBudget = Math.floor(remainingBudget * 0.7);
    const userBudget = remainingBudget - projectBudget;
    const projectSection = buildSection(
      '<memory source="project">',
      projectContext.facts,
      projectContext.nodes,
      projectBudget,
    );
    const userSection = buildSection(
      '<memory source="user">',
      userContext.facts,
      userContext.nodes,
      userBudget,
    );

    const sections: string[] = [header];
    if (projectSection.trim()) {
      sections.push(projectSection);
      sections.push("</memory>");
    }
    if (userSection.trim()) {
      sections.push(userSection);
      sections.push("</memory>");
    }
    sections.push("</persistent_memory>");
    sections.push("</summary>");

    // Final overall truncation at a line boundary.
    const content = truncateAtLineBoundary(
      sections.join("\n"),
      characterBudget,
    );
    return [content];
  } catch (err) {
    logger.error("Failed to get compaction context:", err);
    return [];
  }
}
