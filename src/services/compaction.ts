import type { GraphitiConfig } from "../types/index.ts";
import { logger } from "./logger.ts";

export interface CompactionDependencies {
  sdkClient: {
    session: {
      summarize: (options: {
        path: { id: string };
        body?: { providerID: string; modelID: string };
        query?: { directory?: string };
      }) => Promise<unknown>;
      promptAsync: (options: {
        path: { id: string };
        body?: { parts: Array<{ type: "text"; text: string }> };
        query?: { directory?: string };
      }) => Promise<unknown>;
    };
    tui: {
      showToast: (options?: {
        body?: {
          title?: string;
          message: string;
          variant: "info" | "success" | "warning" | "error";
          duration?: number;
        };
        query?: { directory?: string };
      }) => Promise<unknown>;
    };
    provider: {
      list: (options?: { directory?: string }) => Promise<unknown>;
    };
  };
  directory: string;
}

interface CompactionState {
  lastCompactionTime: Map<string, number>;
  compactionInProgress: Set<string>;
  contextLimitCache: Map<string, number>;
}

const DEFAULT_CONTEXT_LIMIT = 200_000;
const RESUME_DELAY_MS = 500;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const buildModelKey = (providerID: string, modelID: string) =>
  `${providerID}/${modelID}`;

const resolveContextLimit = async (
  providerID: string,
  modelID: string,
  deps: CompactionDependencies,
  state: CompactionState,
): Promise<number> => {
  const modelKey = buildModelKey(providerID, modelID);
  const cached = state.contextLimitCache.get(modelKey);
  if (cached) return cached;

  try {
    const providers = await deps.sdkClient.provider.list({
      directory: deps.directory,
    });
    const list = (providers as { providers?: unknown[] }).providers ?? [];
    for (const provider of list) {
      const providerInfo = provider as { id?: string; models?: unknown[] };
      if (providerInfo.id !== providerID) continue;
      const models = providerInfo.models ?? [];
      for (const model of models) {
        const modelInfo = model as {
          id?: string;
          limit?: { context?: number };
        };
        if (modelInfo.id !== modelID) continue;
        const contextLimit = modelInfo.limit?.context;
        if (typeof contextLimit === "number" && contextLimit > 0) {
          state.contextLimitCache.set(modelKey, contextLimit);
          return contextLimit;
        }
      }
    }
  } catch (err) {
    logger.warn("Failed to fetch provider context limit", err);
  }

  state.contextLimitCache.set(modelKey, DEFAULT_CONTEXT_LIMIT);
  return DEFAULT_CONTEXT_LIMIT;
};

export function createPreemptiveCompactionHandler(
  config: Pick<
    GraphitiConfig,
    | "compactionThreshold"
    | "minTokensForCompaction"
    | "compactionCooldownMs"
    | "autoResumeAfterCompaction"
  >,
  deps: CompactionDependencies,
): {
  checkAndTriggerCompaction(
    sessionId: string,
    tokens: {
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    },
    providerID: string,
    modelID: string,
  ): Promise<void>;
} {
  const state: CompactionState = {
    lastCompactionTime: new Map(),
    compactionInProgress: new Set(),
    contextLimitCache: new Map(),
  };

  const checkAndTriggerCompaction = async (
    sessionId: string,
    tokens: {
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    },
    providerID: string,
    modelID: string,
  ): Promise<void> => {
    const totalTokens = tokens.input + tokens.cache.read + tokens.output +
      tokens.reasoning;
    if (totalTokens < (config.minTokensForCompaction ?? 0)) return;
    if (state.compactionInProgress.has(sessionId)) return;

    const lastCompaction = state.lastCompactionTime.get(sessionId) ?? 0;
    if (Date.now() - lastCompaction < (config.compactionCooldownMs ?? 0)) {
      return;
    }

    const contextLimit = await resolveContextLimit(
      providerID,
      modelID,
      deps,
      state,
    );
    const usageRatio = totalTokens / contextLimit;
    if (usageRatio < (config.compactionThreshold ?? 1)) return;

    state.compactionInProgress.add(sessionId);
    try {
      await deps.sdkClient.tui.showToast({
        body: {
          title: "Graphiti",
          message: "Compacting session to preserve context...",
          variant: "info",
          duration: 3000,
        },
        query: { directory: deps.directory },
      });

      await deps.sdkClient.session.summarize({
        path: { id: sessionId },
        body: { providerID, modelID },
        query: { directory: deps.directory },
      });
      state.lastCompactionTime.set(sessionId, Date.now());

      if (config.autoResumeAfterCompaction) {
        await delay(RESUME_DELAY_MS);
        await deps.sdkClient.session.promptAsync({
          path: { id: sessionId },
          body: { parts: [{ type: "text", text: "Continue" }] },
          query: { directory: deps.directory },
        });
      }

      logger.info("Preemptive compaction triggered", {
        sessionId,
        providerID,
        modelID,
        usageRatio,
        totalTokens,
        contextLimit,
      });
    } catch (err) {
      logger.error("Preemptive compaction failed", err);
    } finally {
      state.compactionInProgress.delete(sessionId);
    }
  };

  return { checkAndTriggerCompaction };
}

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
  client: {
    searchFacts: (args: {
      query: string;
      groupIds?: string[];
      maxFacts?: number;
    }) => Promise<Array<{ fact: string }>>;
  };
  config: GraphitiConfig;
  groupId: string;
  contextStrings: string[];
}): Promise<string[]> {
  const { client, config, groupId, contextStrings } = params;

  try {
    const queryText = contextStrings.slice(0, 3).join(" ").slice(0, 500);
    if (!queryText.trim()) return [];

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
