import type { DreamStore } from "./dream-store.ts";

export type DreamRunnerInput = {
  created_at: string;
  snippet: string;
};

export type DreamSummarizer = (input: {
  granularity: string;
  snippets: string[];
}) => string;

const dayBucket = (timestamp: string): string =>
  `${timestamp.slice(0, 10)}T00:00:00.000Z`;

export const createDreamRunner = (deps: {
  store: DreamStore;
  summarize: DreamSummarizer;
}) => ({
  async refresh(
    rootSessionId: string,
    fromWatermark: string | null,
    inputs: DreamRunnerInput[] = [],
  ): Promise<void> {
    const filtered = inputs
      .filter((input) =>
        fromWatermark === null || input.created_at > fromWatermark
      )
      .sort((left, right) => left.created_at.localeCompare(right.created_at));

    if (filtered.length === 0) return;

    const grouped = new Map<string, string[]>();
    for (const input of filtered) {
      const bucket = dayBucket(input.created_at);
      grouped.set(bucket, [...(grouped.get(bucket) ?? []), input.snippet]);
    }

    for (const [created_at, snippets] of grouped.entries()) {
      await deps.store.putSummary({
        rootSessionId,
        granularity: "day",
        created_at,
        body: deps.summarize({ granularity: "day", snippets }),
      });
    }

    await deps.store.setWatermark(
      rootSessionId,
      filtered[filtered.length - 1].created_at,
    );
  },
});
