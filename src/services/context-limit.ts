import type { OpencodeClient } from "@opencode-ai/sdk";
import { DEFAULT_CONTEXT_LIMIT } from "./constants.ts";
import { logger } from "./logger.ts";
import { extractSdkProviders } from "./sdk-normalize.ts";

export async function resolveContextLimit(
  providerID: string,
  modelID: string,
  client: OpencodeClient,
  directory: string,
  cache: Map<string, number>,
): Promise<number> {
  const modelKey = `${providerID}/${modelID}`;
  const cached = cache.get(modelKey);
  if (cached) return cached;

  try {
    const response = await client.provider.list({
      query: { directory },
    });
    const list = extractSdkProviders(response);
    for (const provider of list) {
      if (provider.id !== providerID) continue;
      const models = provider.models ?? [];
      for (const model of models) {
        if (model.id !== modelID) continue;
        const contextLimit = model.limit?.context;
        if (typeof contextLimit === "number" && contextLimit > 0) {
          cache.set(modelKey, contextLimit);
          return contextLimit;
        }
      }
    }
  } catch (err) {
    logger.warn("Failed to fetch provider context limit", err);
  }

  cache.set(modelKey, DEFAULT_CONTEXT_LIMIT);
  return DEFAULT_CONTEXT_LIMIT;
}

/**
 * Calculate the character budget for memory injection
 * (5% of context limit * 4 chars/token).
 */
export function calculateInjectionBudget(contextLimit: number): number {
  return Math.floor(contextLimit * 0.05 * 4);
}
