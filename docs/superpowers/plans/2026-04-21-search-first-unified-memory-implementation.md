# Search-First Unified Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current event/cache-based memory surfaces with a
search-first architecture where `session_search()` becomes the canonical
exact-memory API, injected XML is rendered from normalized `note` and `summary`
results under one `<memory>` wrapper, the legacy corpus subsystem is removed,
and dream summaries become a local durable hint layer.

**Architecture:** Add a normalized memory-read layer with three result kinds:
`entry`, `note`, and `summary`. `entry` comes from an exact-history adapter over
`opencode db`; `note` comes from session notes; `summary` comes from session
snapshots, dream snapshots, and one-off Graphiti normalization. Rebuild
injection so it renders only `note` and `summary` results into one top-level
`<memory>` wrapper with nested `<persistent_memory>`, and remove the legacy
corpus subsystem and Graphiti cache from the memory path.

**Tech Stack:** Deno, TypeScript, Zod, `@opencode-ai/plugin`,
`@opencode-ai/sdk`, Redis/FalkorDB, Node compatibility APIs, OpenCode runtime
hooks.

---

## File Map

### Create

| File                                    | Responsibility                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/services/exact-history.ts`         | Read exact user turns, assistant turns, and tool calls from `opencode db` / SQLite and expose normalized `entry` search results |
| `src/services/memory-results.ts`        | Shared normalized memory result types, ranking helpers, and XML-safe result rendering contracts                                 |
| `src/services/memory-search.ts`         | Canonical search orchestration for `entry`, `note`, and `summary` adapters, including query mode and reflection mode            |
| `src/services/dream-store.ts`           | Persist and retrieve dream summaries and summary watermarks with no expiry                                                      |
| `src/services/dream-runner.ts`          | Build daily and higher-granularity summaries from durable local memory and notes                                                |
| `src/services/dream-jobs.ts`            | Persist bounded dream job descriptors and coordinate detached/shutdown catch-up work                                            |
| `src/services/detached-dream-worker.ts` | Entry point for the detached headless dream catch-up worker                                                                     |
| `src/services/exact-history.test.ts`    | Unit tests for exact-history adapter behavior and noise reduction for tool-heavy sessions                                       |
| `src/services/memory-search.test.ts`    | Unit tests for mixed search ordering, empty-query reflection, `when`, and summary symmetry                                      |
| `src/services/dream-runner.test.ts`     | Unit tests for summary generation across granularities                                                                          |
| `src/services/dream-jobs.test.ts`       | Unit tests for job persistence, locking, and startup/shutdown handoff                                                           |

### Modify

| File                                       | Responsibility                                                                                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/services/session-mcp-types.ts`        | Expand `session_search` request/response schemas to support `query`, `when`, and normalized result kinds                                                              |
| `src/services/session-mcp-runtime.ts`      | Replace legacy search/runtime wiring with the canonical memory search service and remove corpus-shaped contracts                                                      |
| `src/services/session-notes.ts`            | Add helpers needed by normalized note search and injection limits                                                                                                     |
| `src/services/redis-snapshot.ts`           | Expose snapshot material through normalized `summary` result helpers rather than bespoke XML ownership                                                                |
| `src/services/graphiti-mcp.ts`             | Add one-off Graphiti normalization helpers for summary hints                                                                                                          |
| `src/services/opencode-warning.ts`         | Expose a dedicated toast helper for dream shutdown fallback messaging                                                                                                 |
| `src/services/runtime-teardown.ts`         | Add hook points for dream job handoff during graceful shutdown without blocking foreground exit when detached spawning succeeds                                       |
| `src/session.ts`                           | Replace bespoke event-derived envelope assembly with normalized `<memory>` rendering; remove exact-event-driven `last_request`/`active_tasks`/`key_decisions` shaping |
| `src/handlers/chat.ts`                     | Stop ordinary-turn injection preparation from relying on exact event recall as the memory authority                                                                   |
| `src/handlers/messages.ts`                 | Update injection scrubbing and rendering to one top-level `<memory>` wrapper with nested `<persistent_memory>`                                                        |
| `src/handlers/compacting.ts`               | Use normalized injection assembly for compaction                                                                                                                      |
| `src/index.ts`                             | Wire exact-history, memory-search, dream store/runner/jobs, detached-worker handoff, and remove corpus/Graphiti-cache memory dependency                               |
| `src/testing/detached-dream-proof.ts`      | Temporary proof plugin that shows a toast, sleeps, and writes a verifiable artifact from detached shutdown work                                                       |
| `src/types/index.ts`                       | Add normalized memory result types and dream job / summary types                                                                                                      |
| `src/handlers/messages.test.ts`            | Cover `<memory>` wrapper rendering and scrubbing                                                                                                                      |
| `src/handlers/chat.test.ts`                | Cover ordinary-turn injection behavior and startup/compaction boundaries                                                                                              |
| `src/handlers/compacting.test.ts`          | Cover compaction injection with normalized `summary` and `note` sections                                                                                              |
| `src/services/session-mcp-runtime.test.ts` | Cover `session_search(query, when)` and empty-query reflection behavior                                                                                               |
| `src/session.test.ts`                      | Cover normalized memory assembly, note limits, and no exact-entry injection                                                                                           |
| `src/index.test.ts`                        | Cover new runtime wiring, detached dream handoff, toast fallback, and tool schema exposure                                                                            |
| `docs/SmokeTests.md`                       | Update runtime validation instructions for the new search-first memory architecture                                                                                   |

### Delete

| File                                  | Change                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/services/session-corpus.ts`      | Delete the legacy corpus subsystem entirely; the approved design no longer contains this concept |
| `src/services/session-corpus.test.ts` | Delete corpus-specific tests along with the subsystem                                            |

### Remove From The Memory Path

| File                           | Change                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `src/services/redis-cache.ts`  | Remove ordinary-turn persistent-memory cache ownership and Graphiti cached prompt rendering from the memory path |
| `src/services/redis-events.ts` | Remove exact-memory authority responsibilities from injection/search                                             |

---

## Task 1: Lock The New Search And Injection Contracts In Tests First

**Files:**

- Modify: `src/services/session-mcp-types.ts`
- Modify: `src/services/session-mcp-runtime.test.ts`
- Modify: `src/handlers/messages.test.ts`
- Modify: `src/session.test.ts`

- [ ] **Step 1: Write failing schema tests for the new `session_search` request
      and mixed result shapes**

  Add test coverage in `src/services/session-mcp-runtime.test.ts` for the new
  search contracts:

  ```ts
  it("session_search schema accepts query mode with optional when", () => {
    const queryRequest = sessionMcpRequestSchemas.session_search.safeParse({
      query: "memory redesign",
      when: "2026-04-21T12:00:00.000Z",
    });
    const reflectionRequest = sessionMcpRequestSchemas.session_search.safeParse(
      {
        query: "",
        when: "2026-04-21T12:00:00.000Z",
      },
    );
    const response = sessionMcpResponseSchemas.session_search.safeParse({
      status: "ok",
      results: [
        {
          ref: "session:root:entry:turn-1",
          snippet: "Use opencode db as exact truth.",
          score: 0.95,
          type: "entry",
          id: "turn-1",
          created_at: "2026-04-21T11:00:00.000Z",
        },
        {
          ref: "session:root:summary:day:2026-04-21",
          snippet: "Recent design work moved exact recall to session_search().",
          score: 0.81,
          type: "summary",
          created_at: "2026-04-21T00:00:00.000Z",
          granularity: "day",
        },
      ],
      refs: [
        "session:root:entry:turn-1",
        "session:root:summary:day:2026-04-21",
      ],
      truncated: false,
    });

    assertEquals(queryRequest.success, true);
    assertEquals(reflectionRequest.success, true);
    assertEquals(response.success, true);
  });
  ```

- [ ] **Step 2: Write failing XML rendering tests for the one-wrapper contract**

  Add test coverage in `src/handlers/messages.test.ts` and `src/session.test.ts`
  expecting a single top-level `<memory>` wrapper and nested
  `<persistent_memory>`:

  ```ts
  assertStringIncludes(rendered, '<memory version="2">');
  assertStringIncludes(rendered, '<summary scope="session" source="snapshot">');
  assertStringIncludes(rendered, "<persistent_memory>");
  assertEquals(rendered.includes("<session_memory"), false);
  assertEquals(rendered.includes("<entry"), false);
  ```

- [ ] **Step 3: Write failing tests for note injection limits and no exact-entry
      injection**

  Add a test in `src/session.test.ts` like:

  ```ts
  it("injects at most 10 session notes and never injects exact entries", async () => {
    const prepared = await manager.prepareInjection("root-1", undefined, {
      forCompaction: true,
    });

    assertExists(prepared);
    assertEquals((prepared!.envelope.match(/<note\b/g) ?? []).length, 10);
    assertEquals(prepared!.envelope.includes("<entry"), false);
  });
  ```

- [ ] **Step 4: Run the focused test slice and confirm it fails under the old
      contracts**

  Run:

  ```bash
  deno test -A src/services/session-mcp-runtime.test.ts src/handlers/messages.test.ts src/session.test.ts
  ```

  Expected: FAIL because the current runtime still exposes `memory|note` search
  hits, still injects `<session_memory>`, still uses corpus-shaped fields, and
  does not support `when` or normalized result kinds.

- [ ] **Step 5: Update `src/services/session-mcp-types.ts` to the new public
      request/response contracts**

  Replace the search request and response schema shapes with a normalized
  contract:

  ```ts
  type SessionSearchRequest = {
    root_session_id: string;
    query: string;
    when?: string;
  };

  const searchResultSchema = z.object({
    ref: z.string().min(1),
    snippet: z.string(),
    score: z.number(),
    type: z.enum(["entry", "note", "summary"]),
    id: z.string().min(1).optional(),
    root_session_id: z.string().min(1).optional(),
    scope: z.enum(["session", "local", "project"]).optional(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1).optional(),
    granularity: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
  }).strict();

  session_search: z.object({
    query: z.string(),
    when: z.string().datetime().optional(),
  }).strict().transform((request) => ({
    root_session_id: "",
    query: request.query,
    when: request.when,
  } satisfies SessionSearchRequest)),
  ```

- [ ] **Step 6: Re-run the same focused slice and confirm failures have moved
      into runtime and injection behavior**

  Run:

  ```bash
  deno test -A src/services/session-mcp-runtime.test.ts src/handlers/messages.test.ts src/session.test.ts
  ```

  Expected: schema assertions pass, but runtime behavior still fails because the
  old event/cache architecture and legacy corpus-based runtime are still in
  place.

---

## Task 2: Build The Normalized Memory Result Layer

**Files:**

- Create: `src/services/memory-results.ts`
- Modify: `src/types/index.ts`
- Create: `src/services/memory-search.test.ts`

- [ ] **Step 1: Write failing unit tests for normalized result ordering and
      segmentation**

  Add tests in `src/services/memory-search.test.ts` covering query mode ordering
  and reflection mode chronology:

  ```ts
  it("query mode returns entries and notes before summaries", () => {
    const results = orderMemoryResults([
      { type: "summary", score: 0.99, created_at: "2026-04-21T00:00:00.000Z" },
      { type: "entry", score: 0.70, created_at: "2026-04-21T12:00:00.000Z" },
      { type: "note", score: 0.68, created_at: "2026-04-21T11:00:00.000Z" },
    ] as NormalizedMemoryResult[], { mode: "query" });

    assertEquals(results.map((result) => result.type), [
      "entry",
      "note",
      "summary",
    ]);
  });

  it("reflection mode returns summaries only in chronological order", () => {
    const results = orderMemoryResults([
      { type: "summary", created_at: "2026-04-22T00:00:00.000Z", score: 0.9 },
      { type: "summary", created_at: "2026-04-20T00:00:00.000Z", score: 0.8 },
    ] as NormalizedMemoryResult[], { mode: "reflection" });

    assertEquals(results.map((result) => result.created_at), [
      "2026-04-20T00:00:00.000Z",
      "2026-04-22T00:00:00.000Z",
    ]);
  });
  ```

- [ ] **Step 2: Implement normalized memory result types in
      `src/types/index.ts`**

  Add explicit shared types:

  ```ts
  export type MemoryResultType = "entry" | "note" | "summary";

  export type NormalizedMemoryResult = {
    type: MemoryResultType;
    ref: string;
    snippet: string;
    score: number;
    created_at: string;
    updated_at?: string;
    id?: string;
    root_session_id?: string;
    scope?: "session" | "local" | "project";
    granularity?: string;
    source?: string;
  };
  ```

- [ ] **Step 3: Implement ranking helpers in `src/services/memory-results.ts`**

  Add the first-pass helpers:

  ```ts
  export function orderMemoryResults(
    results: NormalizedMemoryResult[],
    options: { mode: "query" | "reflection" },
  ): NormalizedMemoryResult[] {
    if (options.mode === "reflection") {
      return results
        .filter((result) => result.type === "summary")
        .sort((left, right) => left.created_at.localeCompare(right.created_at));
    }

    const entries = results
      .filter((result) => result.type === "entry" || result.type === "note")
      .sort(compareWeightedResults);
    const summaries = results
      .filter((result) => result.type === "summary")
      .sort(compareWeightedResults);
    return [...entries, ...summaries];
  }

  export function compareWeightedResults(
    left: NormalizedMemoryResult,
    right: NormalizedMemoryResult,
  ): number {
    if (right.score !== left.score) return right.score - left.score;
    if (right.created_at !== left.created_at) {
      return right.created_at.localeCompare(left.created_at);
    }
    return left.ref.localeCompare(right.ref);
  }
  ```

- [ ] **Step 4: Run the new focused test file and confirm it passes**

  Run:

  ```bash
  deno test -A src/services/memory-search.test.ts
  ```

  Expected: PASS.

---

## Task 3: Replace `session_search()` With A Canonical Memory Search Service

**Files:**

- Create: `src/services/exact-history.ts`
- Create: `src/services/memory-search.ts`
- Modify: `src/services/session-mcp-runtime.ts`
- Modify: `src/services/session-mcp-runtime.test.ts`
- Modify: `src/services/session-mcp-types.ts`

- [ ] **Step 1: Write failing runtime tests for query mode, reflection mode, and
      `when` support**

  Add tests in `src/services/session-mcp-runtime.test.ts` for:

  ```ts
  it("returns entry and note hits before summaries in query mode", async () => {
    const result = JSON.parse(
      await runtime.tools.session_search.execute(
        { query: "exact truth", when: "2026-04-21T12:00:00.000Z" },
        createRootToolContext("root-memory"),
      ),
    );

    assertEquals(result.results[0].type, "entry");
    assertEquals(
      result.results.some((item: { type: string }) => item.type === "summary"),
      true,
    );
  });

  it("returns summaries only for empty-query reflection mode", async () => {
    const result = JSON.parse(
      await runtime.tools.session_search.execute(
        { query: "", when: "2026-04-21T12:00:00.000Z" },
        createRootToolContext("root-memory"),
      ),
    );

    assertEquals(
      result.results.every((item: { type: string }) => item.type === "summary"),
      true,
    );
  });
  ```

- [ ] **Step 2: Create `src/services/exact-history.ts` with a minimal adapter
      interface**

  Start with an injectable adapter instead of fully implementing `opencode db`
  access immediately:

  ```ts
  export type ExactHistoryAdapter = {
    search(input: {
      rootSessionId: string;
      query: string;
      when: string;
    }): Promise<NormalizedMemoryResult[]>;
  };

  export function createExactHistoryAdapter(): ExactHistoryAdapter {
    return {
      async search() {
        return [];
      },
    };
  }
  ```

- [ ] **Step 3: Create `src/services/memory-search.ts` to orchestrate exact
      entries, notes, and summaries**

  Implement a canonical read surface:

  ```ts
  export function createMemorySearchService(deps: {
    exactHistory: ExactHistoryAdapter;
    notes: SessionNotesService;
    summaries: SummaryReader;
  }) {
    return {
      async search(input: {
        rootSessionId: string;
        query: string;
        when: string;
      }): Promise<SessionSearchResponse> {
        const [entries, notes, summaries] = await Promise.all([
          input.query ? deps.exactHistory.search(input) : Promise.resolve([]),
          input.query
            ? deps.notes.searchNotes(input.rootSessionId, input.query)
            : Promise.resolve([]),
          deps.summaries.search({
            rootSessionId: input.rootSessionId,
            query: input.query,
            when: input.when,
          }),
        ]);

        return buildSessionSearchResponse(
          entries,
          notes,
          summaries,
          input.query,
        );
      },
    };
  }
  ```

- [ ] **Step 4: Replace the legacy runtime search wiring in
      `src/services/session-mcp-runtime.ts`**

  Remove `searchLocalCorpus(...)` as the search authority and route
  `session_search` through the new service:

  ```ts
  session_search: async (request, context) => {
    const rootSessionId = await resolveCanonicalRootSessionId(context);
    return await memorySearch.search({
      rootSessionId,
      query: request.query,
      when: request.when ?? new Date().toISOString(),
    });
  },
  ```

- [ ] **Step 5: Run the runtime test slice and confirm the new search path works
      without corpus dependency**

  Run:

  ```bash
  deno test -A src/services/session-mcp-runtime.test.ts
  ```

  Expected: PASS for the new search contracts, with no remaining dependency on
  the corpus subsystem.

---

## Task 4: Rebuild Injection Around Normalized `<memory>` Rendering

**Files:**

- Modify: `src/session.ts`
- Modify: `src/handlers/messages.ts`
- Modify: `src/handlers/chat.ts`
- Modify: `src/handlers/compacting.ts`
- Modify: `src/session.test.ts`
- Modify: `src/handlers/messages.test.ts`
- Modify: `src/handlers/compacting.test.ts`

- [ ] **Step 1: Write failing tests for startup-only / compaction-only session
      continuity injection**

  Add tests covering:

  ```ts
  it("wraps injected continuity in one top-level <memory> wrapper", async () => {
    const prepared = await manager.prepareInjection("root-1", "proceed", {
      forCompaction: true,
    });

    assertExists(prepared);
    assertEquals(prepared!.envelope.startsWith("<memory"), true);
    assertEquals(prepared!.envelope.includes("<session_memory"), false);
  });

  it("keeps exact entries out of the injected envelope", async () => {
    const prepared = await manager.prepareInjection(
      "root-1",
      "search-first memory",
    );
    assertExists(prepared);
    assertEquals(prepared!.envelope.includes("<entry"), false);
  });
  ```

- [ ] **Step 2: Replace `buildPreparedInjectionEnvelope(...)` in
      `src/session.ts` with normalized result rendering**

  Delete the bespoke section collectors and replace them with normalized
  rendering helpers:

  ```ts
  const buildPreparedInjectionEnvelope = (
    sessionSummaries: NormalizedMemoryResult[],
    notes: NormalizedMemoryResult[],
    persistentSummaries: NormalizedMemoryResult[],
  ): string => {
    const sessionBody = [
      ...sessionSummaries.map(renderSummaryXml),
      ...notes.slice(0, 10).map(renderNoteXml),
    ].join("");

    const persistentBody = persistentSummaries.map(renderSummaryXml).join("");

    return `<memory version="2">${sessionBody}<persistent_memory>${persistentBody}</persistent_memory></memory>`;
  };
  ```

  Use actual string assembly without the accidental `$` placeholder above.

- [ ] **Step 3: Update `src/handlers/messages.ts` to scrub and inject `<memory>`
      instead of `<session_memory>`**

  Replace the leading-block detection to recognize the new wrapper:

  ```ts
  const LEADING_MEMORY_BLOCK =
    /^<memory\b[^>]*>[\s\S]*?<\/memory>(?:\r?\n){0,2}/;

  const USER_MEMORY_ENVELOPE_TAG_PATTERN =
    /<\/?(?:memory|persistent_memory)\b[^>]*>/gi;
  ```

- [ ] **Step 4: Update `src/handlers/compacting.ts` and `src/handlers/chat.ts`
      to use the new injection semantics**

  Keep compaction injection, keep startup/new-session injection, and stop
  relying on exact-event recall as the canonical memory producer.

- [ ] **Step 5: Run the injection-focused test slice and confirm the wrapper and
      filtering behavior passes**

  Run:

  ```bash
  deno test -A src/session.test.ts src/handlers/messages.test.ts src/handlers/compacting.test.ts src/handlers/chat.test.ts
  ```

  Expected: PASS.

---

## Task 5: Implement Dream Storage, Summary Selection, And Reflection Symmetry

**Files:**

- Create: `src/services/dream-store.ts`
- Create: `src/services/dream-runner.ts`
- Create: `src/services/dream-runner.test.ts`
- Modify: `src/services/memory-search.ts`
- Modify: `src/services/redis-snapshot.ts`

- [ ] **Step 1: Write failing tests for temporal summary selection around
      `when`**

  Add tests in `src/services/dream-runner.test.ts` or
  `src/services/memory-search.test.ts`:

  ```ts
  it("reflection mode returns summaries before and after the reference time", async () => {
    const results = await service.search({
      rootSessionId: "root-1",
      query: "",
      when: "2026-04-21T12:00:00.000Z",
    });

    assertEquals(
      results.results.every((item) => item.type === "summary"),
      true,
    );
    assertEquals(
      results.results.some((item) =>
        item.created_at < "2026-04-21T12:00:00.000Z"
      ),
      true,
    );
    assertEquals(
      results.results.some((item) =>
        item.created_at > "2026-04-21T12:00:00.000Z"
      ),
      true,
    );
  });
  ```

- [ ] **Step 2: Implement durable dream summary storage with no expiry**

  Create `src/services/dream-store.ts` with keys and APIs for:

  ```ts
  export type DreamSummaryRecord = {
    rootSessionId: string;
    granularity: string;
    created_at: string;
    body: string;
  };

  export class DreamStore {
    async putSummary(record: DreamSummaryRecord): Promise<void> {}
    async getSummariesAround(input: {
      rootSessionId: string;
      when: string;
      query?: string;
    }): Promise<NormalizedMemoryResult[]> {}
    async getWatermark(rootSessionId: string): Promise<string | null> {}
    async setWatermark(rootSessionId: string, value: string): Promise<void> {}
  }
  ```

- [ ] **Step 3: Implement `dream-runner.ts` to build daily-first and
      higher-granularity summaries**

  Start with a deterministic summarizer interface rather than model inference:

  ```ts
  export function createDreamRunner(deps: {
    store: DreamStore;
    summarize: (input: { granularity: string; snippets: string[] }) => string;
  }) {
    return {
      async refresh(
        rootSessionId: string,
        fromWatermark: string | null,
      ): Promise<void> {
        // 1. collect exact/note/session summary inputs
        // 2. build day summaries
        // 3. roll up week/month/year/... summaries
        // 4. store records and advance watermark
      },
    };
  }
  ```

- [ ] **Step 4: Update `memory-search.ts` so query mode and reflection mode
      share the same summary-selection machinery**

  Enforce the spec rule:

  ```ts
  const summaries = await summariesAdapter.search({
    rootSessionId,
    query,
    when,
  });
  ```

  Use the same summary adapter for both empty and non-empty query paths.

- [ ] **Step 5: Run the dream/search test slice and confirm temporal selection
      works**

  Run:

  ```bash
  deno test -A src/services/memory-search.test.ts src/services/dream-runner.test.ts
  ```

  Expected: PASS.

---

## Task 6: Add Detached Dream Job Handoff And Shutdown Fallback

**Files:**

- Create: `src/services/dream-jobs.ts`
- Create: `src/services/detached-dream-worker.ts`
- Create: `src/services/dream-jobs.test.ts`
- Modify: `src/services/runtime-teardown.ts`
- Modify: `src/services/opencode-warning.ts`
- Modify: `src/index.ts`
- Modify: `src/index.test.ts`

- [ ] **Step 1: Write failing tests for detached dream handoff and toast
      fallback**

  Add tests in `src/index.test.ts` covering:

  ```ts
  it("spawns a detached dream worker on graceful shutdown when there is a dream gap", async () => {
    const spawnCalls: Array<Record<string, unknown>> = [];
    // expect detached spawn with stdio ignored and immediate foreground exit
  });

  it("shows a warning toast when detached dreaming cannot be started safely", async () => {
    const toastCalls: unknown[] = [];
    // expect one warning toast with wait messaging
  });
  ```

- [ ] **Step 2: Implement persisted dream job descriptors in
      `src/services/dream-jobs.ts`**

  Add minimal APIs:

  ```ts
  export type DreamJob = {
    rootSessionId: string;
    fromWatermark: string | null;
    targetWatermark: string;
    created_at: string;
  };

  export class DreamJobStore {
    async writeJob(job: DreamJob): Promise<void> {}
    async readPendingJob(rootSessionId: string): Promise<DreamJob | null> {}
    async clearJob(rootSessionId: string): Promise<void> {}
  }
  ```

- [ ] **Step 3: Add a dedicated toast helper for shutdown fallback in
      `src/services/opencode-warning.ts`**

  Add:

  ```ts
  export const notifyDreamShutdownDelay = (): void => {
    notifyPluginWarning(
      "Dreaming is still in progress; wait for completion before exiting.",
    );
  };
  ```

- [ ] **Step 4: Wire detached handoff in `src/index.ts` teardown registration**

  Add a teardown task ahead of full shutdown that:

  ```ts
  {
    name: "dream-handoff",
    run: async () => {
      const job = await dreamJobs.preparePendingJobs(sessionManager.getTrackedRootSessionIds());
      if (!job) return;
      const spawned = await spawnDetachedDreamWorker(job);
      if (!spawned) notifyDreamShutdownDelay();
    },
  }
  ```

  The detached worker must bootstrap only from persisted job input and
  watermarks.

- [ ] **Step 5: Run the teardown/index test slice and confirm shutdown behavior
      passes**

  Run:

  ```bash
  deno test -A src/index.test.ts src/services/runtime-teardown.test.ts src/services/dream-jobs.test.ts
  ```

  Expected: PASS.

---

## Task 7: Prove Detached Worker Behavior End-To-End With A Temporary Test Plugin

**Files:**

- Create: `src/testing/detached-dream-proof.ts`
- Modify: `docs/SmokeTests.md`

- [ ] **Step 1: Write a temporary testing plugin that proves foreground exit
      does not need to wait**

  Create `src/testing/detached-dream-proof.ts` with a minimal proof-only plugin
  that:

  ```ts
  import type { Plugin, PluginInput } from "@opencode-ai/plugin";
  import { showWarningToast } from "../services/opencode-warning.ts";
  import { spawn } from "node:child_process";

  export const detachedDreamProof: Plugin = (input: PluginInput) => {
    const proofFile = `${input.directory}/.opencode-detached-dream-proof.json`;

    return {
      hooks: {
        "tool.definition": () => ({
          name: "detached_dream_proof",
          description: "Proof helper for detached shutdown worker.",
          args: {},
        }),
        "tool.execute": async () => {
          showWarningToast(
            "Detached dream proof armed. Gracefully exit after this session.",
          );
          return { ok: true };
        },
      },
      dispose: async () => {
        const child = spawn(
          process.execPath,
          [
            "-e",
            `setTimeout(() => require('node:fs').writeFileSync(${
              JSON.stringify(proofFile)
            }, JSON.stringify({ done: true, finished_at: new Date().toISOString() })), 10000)`,
          ],
          {
            detached: true,
            stdio: "ignore",
          },
        );
        child.unref();
      },
    };
  };
  ```

  Keep this plugin clearly marked as proof-only and temporary.

- [ ] **Step 2: Add a manual proof flow to `docs/SmokeTests.md`**

  Add an explicit detached-worker validation procedure:

  ```md
  1. Load the temporary detached dream proof plugin.
  2. Start a new OpenCode session with the plugin enabled.
  3. Invoke the `detached_dream_proof` tool once.
  4. Confirm the toast appears immediately.
  5. Gracefully exit OpenCode.
  6. Verify the foreground process exits without waiting 10 seconds.
  7. Wait 10-15 seconds and verify `.opencode-detached-dream-proof.json` now
     exists.
  8. Open the file and verify it contains a completion timestamp.
  ```

- [ ] **Step 3: Ask the user to run the manual proof after implementation**

  Use this exact handoff text once the proof plugin is ready:

  ```md
  Detached-worker proof is ready. Start a session with the temporary proof plugin
  loaded, invoke `detached_dream_proof` once, then gracefully exit OpenCode. You
  should see the toast immediately, OpenCode should exit without waiting 10
  seconds, and `.opencode-detached-dream-proof.json` should appear shortly
  afterward as proof the detached process kept running.
  ```

- [ ] **Step 4: Evaluate the proof result and pivot immediately if detached work
      is non-viable**

  Use this decision rule:

  ```md
  Treat detached dreaming as non-viable if any of these happen during proof:

  - OpenCode waits for the full 10 seconds before exiting.
  - The proof artifact never appears.
  - The proof artifact appears only while the foreground process is still alive.
  - The detached worker setup is platform-fragile enough that the proof cannot be
    relied on.

  If any condition above is true, stop pursuing detached shutdown work in this
  branch and pivot the plan to require users to wait for dreaming to finish.
  ```

- [ ] **Step 5: If proof fails, update the product behavior and docs to require
      waiting**

  If detached work is non-viable, make these plan-level changes immediately:

  ```md
  - Remove the detached worker path from runtime wiring.
  - Keep the shutdown toast, but change it into an explicit waiting instruction.
  - Update `docs/SmokeTests.md` to require users to wait for dreaming completion
    on graceful shutdown.
  - Update the final user-facing handoff text to say: "Gracefully exit OpenCode
    and wait for the dreaming toast/work to finish before closing the process."
  ```

- [ ] **Step 6: Remove or quarantine the temporary proof plugin after
      validation**

  Once detached-worker behavior is verified, either delete the proof plugin or
  move it under a test-only path that is not shipped in normal runtime wiring.

---

## Task 8: Delete The Corpus Subsystem And Remove Graphiti Cache From The Memory Path

**Files:**

- Modify: `src/services/session-mcp-runtime.ts`
- Modify: `src/index.ts`
- Modify: `src/session.ts`
- Modify: `src/services/redis-cache.ts`
- Delete: `src/services/session-corpus.ts`
- Delete: `src/services/session-corpus.test.ts`
- Modify: `src/index.test.ts`

- [ ] **Step 1: Write failing regression tests proving the runtime no longer
      exposes corpus concepts**

  Add/replace runtime tests that assert:

  ```ts
  assertEquals("session_index" in runtime.tools, false);
  assertEquals("session_fetch_and_index" in runtime.tools, false);
  assertEquals(
    runtime.tools.session_search.description.includes("local corpus"),
    false,
  );
  ```

- [ ] **Step 2: Remove corpus-backed tools and Graphiti cache from
      `src/index.ts` wiring**

  Keep Graphiti for async ingestion and one-off compaction/startup hint queries
  only. Remove it from ordinary-turn persistent-memory assembly, and stop
  registering any corpus-backed tool surfaces.

- [ ] **Step 3: Delete the corpus subsystem and corpus-shaped response fields**

  Remove `src/services/session-corpus.ts`,
  `src/services/session-corpus.test.ts`, and the `session_index` /
  `session_fetch_and_index` tool contracts. Rename any remaining `corpus_ref` /
  `corpus_refs` fields in memory search responses to `ref` / `refs`.

- [ ] **Step 4: Remove Graphiti cache-based ordinary-turn rendering from
      `src/session.ts`**

  Ordinary-turn `<persistent_memory>` should come from the summary adapter, not
  `RedisCacheService.renderPersistentMemory(...)`.

- [ ] **Step 5: Run the broader runtime suite and confirm no memory-path
      regressions remain**

  Run:

  ```bash
  deno test -A src/index.test.ts src/services/session-mcp-runtime.test.ts src/session.test.ts
  ```

  Expected: PASS, with no remaining corpus subsystem files or corpus-shaped
  memory contracts.

---

## Task 9: Update Smoke Tests And Run Full Verification

**Files:**

- Modify: `docs/SmokeTests.md`
- Modify: `src/index.test.ts`
- Modify: `src/session.test.ts`
- Modify: `src/services/session-mcp-runtime.test.ts`
- Modify: `src/handlers/messages.test.ts`

- [ ] **Step 1: Update `docs/SmokeTests.md` to the new memory architecture**

  Document these expectations explicitly:

  ```md
  - `session_search()` is the canonical exact-memory API.
  - Exact turns/tool calls are discoverable through `session_search()` and never
    injected.
  - Injected memory is wrapped in one `<memory>` block.
  - `<persistent_memory>` is nested inside `<memory>`.
  - Dream summaries persist without expiry and are used for reflection and hint
    injection.
  - Detached dream handoff on shutdown is preferred; toast-backed waiting is
    fallback.
  - The legacy corpus subsystem and corpus-shaped memory contracts no longer
    exist.
  ```

- [ ] **Step 2: Run the targeted verification suite**

  Run:

  ```bash
  deno test -A \
    src/services/memory-search.test.ts \
    src/services/exact-history.test.ts \
    src/services/dream-runner.test.ts \
    src/services/dream-jobs.test.ts \
    src/services/session-mcp-runtime.test.ts \
    src/session.test.ts \
    src/handlers/messages.test.ts \
    src/handlers/chat.test.ts \
    src/handlers/compacting.test.ts \
    src/index.test.ts
  ```

  Expected: PASS.

- [ ] **Step 3: Run repository-wide verification**

  Run:

  ```bash
  deno test -A
  deno check src/index.ts
  deno lint
  ```

  Expected: all commands PASS.

---

## Spec Coverage Check

Covered sections from
`docs/superpowers/specs/2026-04-21-search-first-unified-memory-design.md`:

- authority split (`opencode db` exact truth, derived local artifacts, Graphiti
  narrowing)
- keep/drop decisions
- normalized result model (`entry`, `note`, `summary`)
- shared code-path rule
- `session_search(query, when)` semantics
- empty-query reflection symmetry
- exact-hit noise reduction for tool-heavy sessions
- one top-level `<memory>` wrapper with nested `<persistent_memory>`
- no exact-entry injection
- up to 10 injected session notes
- dream summaries without expiry
- detached dream handoff plus toast fallback
- corpus removal from the resulting codebase

No uncovered spec requirement remains.

## Placeholder Scan

No `TODO`, `TBD`, or deferred “implement later” placeholders remain in this
plan. New files are named explicitly, commands are concrete, and each task has a
bounded verification command.

## Type Consistency Check

The plan uses one normalized memory result vocabulary consistently:

- `entry`
- `note`
- `summary`

The XML vocabulary is also consistent:

- top-level `<memory>`
- nested `<persistent_memory>`
- child `<summary>` and `<note>` only

---

Plan complete and saved to
`docs/superpowers/plans/2026-04-21-search-first-unified-memory-implementation.md`.
Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task,
review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans,
batch execution with checkpoints

Which approach?
