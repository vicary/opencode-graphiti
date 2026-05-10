import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";

import { orderMemoryResults } from "./memory-results.ts";
import { createMemorySearchService } from "./memory-search.ts";
import type { NormalizedMemoryResult } from "../types/index.ts";

const createResult = (
  overrides: Partial<NormalizedMemoryResult>,
): NormalizedMemoryResult => ({
  type: "entry",
  ref: "memory:default",
  snippet: "default snippet",
  score: 0.5,
  created_at: "2026-04-21T00:00:00.000Z",
  id: "memory-default",
  root_session_id: "root-1",
  scope: "session",
  granularity: "turn",
  source: "test",
  ...overrides,
});

describe("memory result ordering", () => {
  it("orders query-mode results with entries and notes before summaries", () => {
    const results: NormalizedMemoryResult[] = [
      createResult({
        type: "summary",
        ref: "memory:summary:top",
        score: 1,
        created_at: "2026-04-21T12:00:00.000Z",
        id: "summary-top",
        granularity: "day",
        source: "snapshot",
      }),
      createResult({
        type: "entry",
        ref: "memory:entry:newest",
        score: 0.9,
        created_at: "2026-04-21T11:00:00.000Z",
        id: "entry-newest",
        granularity: "turn",
        source: "opencode-db",
      }),
      createResult({
        type: "note",
        ref: "memory:note:zulu",
        score: 0.9,
        created_at: "2026-04-21T10:00:00.000Z",
        id: "note-zulu",
        scope: "local",
        granularity: "note",
        source: "session-notes",
      }),
      createResult({
        type: "entry",
        ref: "memory:entry:alpha",
        score: 0.9,
        created_at: "2026-04-21T10:00:00.000Z",
        id: "entry-alpha",
        granularity: "turn",
        source: "opencode-db",
      }),
      createResult({
        type: "summary",
        ref: "memory:summary:older",
        score: 0.8,
        created_at: "2026-04-20T12:00:00.000Z",
        id: "summary-older",
        granularity: "day",
        source: "snapshot",
      }),
    ];

    assertEquals(
      orderMemoryResults(results, { mode: "query" }).map((result) =>
        result.ref
      ),
      [
        "memory:entry:newest",
        "memory:entry:alpha",
        "memory:note:zulu",
        "memory:summary:top",
        "memory:summary:older",
      ],
    );
  });

  it("orders reflection-mode summaries in chronological order", () => {
    const results: NormalizedMemoryResult[] = [
      createResult({
        type: "summary",
        ref: "memory:summary:latest",
        created_at: "2026-04-21T12:00:00.000Z",
        id: "summary-latest",
        granularity: "day",
        source: "snapshot",
      }),
      createResult({
        type: "entry",
        ref: "memory:entry:ignored",
        created_at: "2026-04-21T11:30:00.000Z",
        id: "entry-ignored",
        granularity: "turn",
        source: "opencode-db",
      }),
      createResult({
        type: "summary",
        ref: "memory:summary:earliest",
        created_at: "2026-04-19T08:00:00.000Z",
        id: "summary-earliest",
        granularity: "day",
        source: "snapshot",
      }),
      createResult({
        type: "note",
        ref: "memory:note:ignored",
        created_at: "2026-04-20T09:00:00.000Z",
        id: "note-ignored",
        scope: "project",
        granularity: "note",
        source: "session-notes",
      }),
      createResult({
        type: "summary",
        ref: "memory:summary:middle",
        created_at: "2026-04-20T08:00:00.000Z",
        id: "summary-middle",
        granularity: "day",
        source: "snapshot",
      }),
    ];

    assertEquals(
      orderMemoryResults(results, { mode: "reflection" }).map((result) =>
        result.ref
      ),
      [
        "memory:summary:earliest",
        "memory:summary:middle",
        "memory:summary:latest",
      ],
    );
  });
});

describe("createMemorySearchService", () => {
  it("reflection mode returns summaries before and after the reference time", async () => {
    let exactCalls = 0;
    let noteCalls = 0;
    let summaryCalls = 0;

    const service = createMemorySearchService({
      exactHistoryAdapter: {
        search() {
          exactCalls += 1;
          return Promise.resolve([
            createResult({
              type: "entry",
              ref: "memory:entry:ignored",
              created_at: "2026-04-21T11:30:00.000Z",
              source: "opencode-db",
            }),
          ]);
        },
      },
      notesService: {
        searchNotes() {
          noteCalls += 1;
          return Promise.resolve([
            {
              id: "note-ignored",
              root_session_id: "root-1",
              scope: "local" as const,
              snippet: "ignored note",
              score: 0.7,
              created_at: "2026-04-21T00:00:00.000Z",
              updated_at: "2026-04-21T00:00:00.000Z",
            },
          ]);
        },
      },
      summarySearchAdapter: {
        search() {
          summaryCalls += 1;
          return Promise.resolve([
            createResult({
              type: "summary",
              ref: "memory:summary:before",
              created_at: "2026-04-20T12:00:00.000Z",
              id: "summary-before",
              granularity: "day",
              source: "dream",
            }),
            createResult({
              type: "summary",
              ref: "memory:summary:after",
              created_at: "2026-04-22T12:00:00.000Z",
              id: "summary-after",
              granularity: "day",
              source: "dream",
            }),
          ]);
        },
      },
      groupId: "group-1",
    });

    const response = await service.search({
      rootSessionId: "root-1",
      query: "",
      when: "2026-04-21T12:00:00.000Z",
    });

    assertEquals(
      response.results.every((item) => item.type === "summary"),
      true,
    );
    assertEquals(
      response.results.some((item) =>
        item.created_at < "2026-04-21T12:00:00.000Z"
      ),
      true,
    );
    assertEquals(
      response.results.some((item) =>
        item.created_at > "2026-04-21T12:00:00.000Z"
      ),
      true,
    );
    assertEquals(response.results.map((item) => item.ref), [
      "memory:summary:before",
      "memory:summary:after",
    ]);
    assertEquals(exactCalls, 0);
    assertEquals(noteCalls, 0);
    assertEquals(summaryCalls, 1);
  });

  it("query mode keeps exact hits ahead of shared summary hits", async () => {
    const service = createMemorySearchService({
      exactHistoryAdapter: {
        search() {
          return Promise.resolve([
            createResult({
              type: "entry",
              ref: "memory:entry:match",
              score: 0.95,
              created_at: "2026-04-21T11:00:00.000Z",
              source: "opencode-db",
            }),
          ]);
        },
      },
      notesService: {
        searchNotes() {
          return Promise.resolve([
            {
              id: "note-match",
              root_session_id: "root-1",
              scope: "local" as const,
              snippet: "matching note",
              score: 0.9,
              created_at: "2026-04-21T00:00:00.000Z",
              updated_at: "2026-04-21T00:00:00.000Z",
            },
          ]);
        },
      },
      summarySearchAdapter: {
        search() {
          return Promise.resolve([
            createResult({
              type: "summary",
              ref: "memory:summary:match",
              score: 0.8,
              created_at: "2026-04-21T12:00:00.000Z",
              id: "summary-match",
              granularity: "day",
              source: "dream",
            }),
          ]);
        },
      },
      groupId: "group-1",
    });

    const response = await service.search({
      rootSessionId: "root-1",
      query: "matching",
      when: "2026-04-21T12:00:00.000Z",
    });

    assertEquals(response.results.map((item) => item.type), [
      "entry",
      "note",
      "summary",
    ]);
  });
});
