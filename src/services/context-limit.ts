import type { OpencodeClient } from "@opencode-ai/sdk";
import { DEFAULT_CONTEXT_LIMIT } from "./constants.ts";
import { logger } from "./logger.ts";
import { extractSdkProviders } from "./sdk-normalize.ts";

const UNKNOWN_CONTEXT_LIMIT = -1;
const UNKNOWN_CONTEXT_LIMIT_TTL_MS = 60_000;

type ContextLimitCacheEntry =
  | number
  | {
    value: number;
    expiresAt?: number;
  };

const getContextLimitCacheKey = (
  providerID: string,
  modelID: string,
  directory?: string,
): string => {
  const normalizedDirectory = directory?.trim();
  return normalizedDirectory
    ? `${normalizedDirectory}\u0000${providerID}/${modelID}`
    : `${providerID}/${modelID}`;
};

export async function resolveContextLimit(
  providerID: string,
  modelID: string,
  client: OpencodeClient,
  directory: string | undefined,
  cache: Map<string, ContextLimitCacheEntry>,
  now: () => number = Date.now,
): Promise<number> {
  const normalizedDirectory = directory?.trim();
  const modelKey = getContextLimitCacheKey(
    providerID,
    modelID,
    normalizedDirectory,
  );
  const currentTime = now();
  const cached = cache.get(modelKey);
  if (cached !== undefined) {
    if (typeof cached === "number") {
      if (cached > 0) {
        return cached;
      }

      cache.delete(modelKey);
    } else {
      if (cached.expiresAt === undefined) {
        if (cached.value > 0) {
          return cached.value;
        }

        cache.delete(modelKey);
      } else if (cached.expiresAt > currentTime) {
        return cached.value > 0 ? cached.value : DEFAULT_CONTEXT_LIMIT;
      }

      cache.delete(modelKey);
    }
  }

  try {
    const response = await client.provider.list({
      query: normalizedDirectory ? { directory: normalizedDirectory } : {},
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
    cache.set(modelKey, {
      value: UNKNOWN_CONTEXT_LIMIT,
      expiresAt: currentTime + UNKNOWN_CONTEXT_LIMIT_TTL_MS,
    });
    return DEFAULT_CONTEXT_LIMIT;
  }

  cache.set(modelKey, {
    value: UNKNOWN_CONTEXT_LIMIT,
    expiresAt: currentTime + UNKNOWN_CONTEXT_LIMIT_TTL_MS,
  });
  return DEFAULT_CONTEXT_LIMIT;
}
