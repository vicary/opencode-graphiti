import { logger } from "./logger.ts";

const DEFAULT_CONTEXT_LIMIT = 200_000;

export interface ProviderListClient {
  provider: {
    list: (options?: { directory?: string }) => Promise<unknown>;
  };
}

const contextLimitCache = new Map<string, number>();

export async function resolveContextLimit(
  providerID: string,
  modelID: string,
  client: ProviderListClient,
  directory: string,
): Promise<number> {
  const modelKey = `${providerID}/${modelID}`;
  const cached = contextLimitCache.get(modelKey);
  if (cached) return cached;

  try {
    const providers = await client.provider.list({ directory });
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
          contextLimitCache.set(modelKey, contextLimit);
          return contextLimit;
        }
      }
    }
  } catch (err) {
    logger.warn("Failed to fetch provider context limit", err);
  }

  contextLimitCache.set(modelKey, DEFAULT_CONTEXT_LIMIT);
  return DEFAULT_CONTEXT_LIMIT;
}

/**
 * Calculate the character budget for memory injection
 * (10% of context limit * 4 chars/token).
 */
export function calculateInjectionBudget(contextLimit: number): number {
  return Math.floor(contextLimit * 0.1 * 4);
}
