import type { NormalizedMemoryResult } from "../types/index.ts";

export type ExactHistoryAdapter = {
  search(input: {
    rootSessionId: string;
    query: string;
    when: string;
  }): Promise<NormalizedMemoryResult[]>;
};

export const createExactHistoryAdapter = (): ExactHistoryAdapter => ({
  search: () => Promise.resolve([]),
});
