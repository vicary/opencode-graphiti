import type { Part, SessionMessagesResponses } from "@opencode-ai/sdk";
import type { GraphitiEpisode } from "../types/index.ts";

/**
 * Narrow type for a single SDK message entry as returned by
 * `session.messages()`.
 */
export type SdkMessage = {
  info: { role?: string; id?: string };
  parts: Part[];
};

/**
 * Normalize an SDK response that may be wrapped in `{ data: … }` or returned
 * directly.  Returns the inner value cast to `T`, or `undefined` when the
 * response is absent.
 *
 * This replaces the repeated `"data" in response ? (response as
 * { data?: … }).data : response` pattern found in session.ts and
 * context-limit.ts.
 */
export function unwrapSdkResponse<T>(response: unknown): T | undefined {
  if (response == null) return undefined;
  if (typeof response === "object" && "data" in (response as object)) {
    return (response as { data?: T }).data;
  }
  return response as T;
}

/**
 * Extract the messages array from a raw `session.messages()` response.
 * Returns an empty array when the response is missing or malformed.
 */
export function extractSdkMessages(
  response: unknown,
): SdkMessage[] {
  const payload = unwrapSdkResponse<SessionMessagesResponses[200]>(response);
  return Array.isArray(payload) ? (payload as SdkMessage[]) : [];
}

/**
 * Extract the provider list from a raw `provider.list()` response.
 * Returns an empty array when the response is missing or malformed.
 */
export type SdkProvider = {
  id?: string;
  models?: SdkModel[];
};

export type SdkModel = {
  id?: string;
  limit?: { context?: number };
};

export function extractSdkProviders(response: unknown): SdkProvider[] {
  // provider.list() may return `{ providers: [...] }` directly (no data wrap).
  if (response != null && typeof response === "object") {
    const obj = response as Record<string, unknown>;
    if (Array.isArray(obj["providers"])) {
      return obj["providers"] as SdkProvider[];
    }
    if ("data" in obj) {
      const data = obj["data"];
      if (data != null && typeof data === "object") {
        const dataObj = data as Record<string, unknown>;
        if (Array.isArray(dataObj["providers"])) {
          return dataObj["providers"] as SdkProvider[];
        }
      }
      if (Array.isArray(data)) return data as SdkProvider[];
    }
  }
  return [];
}

/**
 * Normalize a raw Graphiti episode object so that `sourceDescription` is
 * always the canonical field regardless of whether the payload used
 * camelCase (`sourceDescription`) or snake_case (`source_description`).
 *
 * Call this at the API boundary (e.g. inside `GraphitiClient.getEpisodes`)
 * so all downstream consumers only need to read `episode.sourceDescription`.
 */
export function normalizeEpisode(
  raw: GraphitiEpisode & {
    source_description?: string;
  },
): GraphitiEpisode {
  const { source_description, ...rest } = raw;
  return {
    ...rest,
    sourceDescription: rest.sourceDescription ?? source_description,
  };
}
