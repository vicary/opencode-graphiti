import type { NormalizedMemoryResult } from "../types/index.ts";

export const compareWeightedResults = (
  left: NormalizedMemoryResult,
  right: NormalizedMemoryResult,
): number => {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  if (right.created_at !== left.created_at) {
    return right.created_at.localeCompare(left.created_at);
  }
  return left.ref.localeCompare(right.ref);
};

export const orderMemoryResults = (
  results: NormalizedMemoryResult[],
  options: { mode: "query" | "reflection" },
): NormalizedMemoryResult[] => {
  if (options.mode === "reflection") {
    return results
      .filter((result) => result.type === "summary")
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  const primary = results
    .filter((result) => result.type === "entry" || result.type === "note")
    .sort(compareWeightedResults);
  const summaries = results
    .filter((result) => result.type === "summary")
    .sort(compareWeightedResults);

  return [...primary, ...summaries];
};
