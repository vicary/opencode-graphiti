import type { NormalizedMemoryResult } from "../types/index.ts";
import { orderMemoryResults } from "./memory-results.ts";
import type { ExactHistoryAdapter } from "./exact-history.ts";
import type { SessionMcpResponseMap } from "./session-mcp-types.ts";
import type { SessionNotesService } from "./session-notes.ts";

export type SummarySearchAdapter = {
  search(input: {
    rootSessionId: string;
    query: string;
    when: string;
  }): Promise<NormalizedMemoryResult[]>;
};

export type MemorySearchService = {
  search(input: {
    rootSessionId: string;
    query: string;
    when: string;
  }): Promise<SessionMcpResponseMap["session_search"]>;
};

type MemorySearchServiceOptions = {
  exactHistoryAdapter: ExactHistoryAdapter;
  notesService: Pick<SessionNotesService, "searchNotes">;
  summarySearchAdapter: SummarySearchAdapter;
  groupId: string;
  resultLimit?: number;
};

export const createSummarySearchAdapter = (): SummarySearchAdapter => ({
  search: () => Promise.resolve([]),
});

const uniqueRefs = (results: NormalizedMemoryResult[]): string[] => [
  ...new Set(results.map((result) => result.ref)),
];

export const createMemorySearchService = (
  options: MemorySearchServiceOptions,
): MemorySearchService => {
  const resultLimit = options.resultLimit ?? Number.POSITIVE_INFINITY;

  return {
    async search(input) {
      const summaries = await options.summarySearchAdapter.search(input);

      if (input.query === "") {
        const ordered = orderMemoryResults(summaries, { mode: "reflection" });
        const results = ordered.slice(0, resultLimit);

        return {
          status: "ok",
          results,
          refs: uniqueRefs(results),
          truncated: ordered.length > results.length,
        };
      }

      const [entries, notes] = await Promise.all([
        options.exactHistoryAdapter.search(input),
        options.notesService.searchNotes(input.rootSessionId, input.query),
      ]);

      const normalizedNotes: NormalizedMemoryResult[] = notes.map((note) => ({
        type: "note",
        ref:
          `session:${options.groupId}:${note.root_session_id}:note:${note.id}`,
        snippet: note.snippet,
        score: note.score,
        id: note.id,
        root_session_id: note.root_session_id,
        scope: note.scope,
        created_at: note.created_at,
        updated_at: note.updated_at,
        source: "session-notes",
      }));

      const ordered = orderMemoryResults([
        ...entries,
        ...normalizedNotes,
        ...summaries,
      ], { mode: "query" });
      const results = ordered.slice(0, resultLimit);

      return {
        status: "ok",
        results,
        refs: uniqueRefs(results),
        truncated: ordered.length > results.length,
      };
    },
  };
};
