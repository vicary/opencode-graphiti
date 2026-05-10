import type { NormalizedMemoryResult } from "../types/index.ts";
import type { RedisClient } from "./redis-client.ts";

export type DreamSummaryRecord = {
  rootSessionId: string;
  granularity: string;
  created_at: string;
  body: string;
};

type StoredDreamSummaryRecord = {
  granularity: string;
  created_at: string;
  body: string;
};

const dreamSummariesKey = (rootSessionId: string): string =>
  `session:${rootSessionId}:dream:summaries`;

const dreamSummaryField = (record: {
  granularity: string;
  created_at: string;
}): string => `${record.granularity}:${record.created_at}`;

const dreamWatermarkKey = (rootSessionId: string): string =>
  `session:${rootSessionId}:dream:watermark`;

const normalizeText = (value: string): string =>
  value.trim().replace(/\s+/g, " ");

const tokenize = (value: string): string[] =>
  normalizeText(value).toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];

const parseStoredRecord = (value: string): StoredDreamSummaryRecord | null => {
  try {
    const parsed = JSON.parse(value) as Partial<StoredDreamSummaryRecord>;
    if (
      typeof parsed.granularity !== "string" ||
      typeof parsed.created_at !== "string" ||
      typeof parsed.body !== "string"
    ) {
      return null;
    }

    return {
      granularity: parsed.granularity,
      created_at: parsed.created_at,
      body: parsed.body,
    };
  } catch {
    return null;
  }
};

const scoreSummary = (
  record: StoredDreamSummaryRecord,
  query?: string,
): number => {
  const normalizedQuery = normalizeText(query ?? "").toLowerCase();
  if (!normalizedQuery) return 1;

  const body = normalizeText(record.body).toLowerCase();
  if (body === normalizedQuery) return 1;
  if (body.includes(normalizedQuery)) return 0.95;

  const queryTokens = [...new Set(tokenize(normalizedQuery))];
  if (queryTokens.length === 0) return 0;
  const matched = queryTokens.filter((token) => body.includes(token));
  if (matched.length === 0) return 0;
  return Number((matched.length / queryTokens.length).toFixed(6));
};

export class DreamStore {
  constructor(private readonly redis: RedisClient) {}

  async putSummary(record: DreamSummaryRecord): Promise<void> {
    await this.redis.setHashFields(dreamSummariesKey(record.rootSessionId), {
      [dreamSummaryField(record)]: JSON.stringify(
        {
          granularity: record.granularity,
          created_at: record.created_at,
          body: record.body,
        } satisfies StoredDreamSummaryRecord,
      ),
    });
  }

  async getSummariesAround(input: {
    rootSessionId: string;
    when: string;
    query?: string;
  }): Promise<NormalizedMemoryResult[]> {
    const summaries = Object.values(
      await this.redis.getHashAll(dreamSummariesKey(input.rootSessionId)),
    )
      .map(parseStoredRecord)
      .filter((record): record is StoredDreamSummaryRecord => record !== null)
      .map((record) => ({
        record,
        score: scoreSummary(record, input.query),
      }))
      .filter(({ score }) => score > 0)
      .sort((left, right) =>
        left.record.created_at.localeCompare(right.record.created_at)
      );

    const before = summaries.filter(({ record }) =>
      record.created_at < input.when
    );
    const exact = summaries.filter(({ record }) =>
      record.created_at === input.when
    );
    const after = summaries.filter(({ record }) =>
      record.created_at > input.when
    );

    const selected = [
      ...before.slice(-1),
      ...exact,
      ...after.slice(0, 1),
    ];

    return selected.map(({ record, score }) => ({
      type: "summary",
      ref:
        `session:${input.rootSessionId}:summary:dream:${record.granularity}:${record.created_at}`,
      snippet: record.body,
      score,
      id: `${record.granularity}:${record.created_at}`,
      root_session_id: input.rootSessionId,
      scope: "session",
      granularity: record.granularity,
      created_at: record.created_at,
      source: "dream",
    } satisfies NormalizedMemoryResult));
  }

  async getWatermark(rootSessionId: string): Promise<string | null> {
    return await this.redis.getString(dreamWatermarkKey(rootSessionId));
  }

  async setWatermark(rootSessionId: string, value: string): Promise<void> {
    await this.redis.setString(dreamWatermarkKey(rootSessionId), value);
  }
}
