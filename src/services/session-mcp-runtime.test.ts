import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import {
  createSessionMcpRuntime,
  SESSION_MCP_RESPONSE_BUDGET_BYTES,
  SESSION_NOTES_READ_DESCRIPTION,
  SESSION_NOTES_WRITE_DESCRIPTION,
  SESSION_SEARCH_BASELINE_DESCRIPTION,
  SESSION_SEARCH_STRENGTHENED_DESCRIPTION,
} from "./session-mcp-runtime.ts";
import type { SessionExecutor } from "./session-executor.ts";
import {
  SESSION_MCP_TOOL_NAMES,
  sessionMcpRequestSchemas,
  sessionMcpResponseSchemas,
  type SessionMcpToolName,
} from "./session-mcp-types.ts";
import { RedisClient } from "./redis-client.ts";
import { SessionManager } from "../session.ts";
import type { RedisEvent } from "./test-helpers.ts";

const createSearchResult = (overrides: Record<string, unknown>) => ({
  ref: "session:root:summary:default",
  snippet: "default snippet",
  score: 0.5,
  type: "summary",
  created_at: "2026-04-21T00:00:00.000Z",
  ...overrides,
});

class DoctorRedisRuntime {
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly listeners = new Map<
    RedisEvent,
    Set<(...args: unknown[]) => void>
  >();

  connect(): Promise<void> {
    this.emit("ready");
    return Promise.resolve();
  }

  ping(): Promise<"PONG"> {
    return Promise.resolve("PONG");
  }

  quit(): Promise<"OK"> {
    return Promise.resolve("OK");
  }

  lpush(): Promise<number> {
    return Promise.resolve(0);
  }

  rpush(): Promise<number> {
    return Promise.resolve(0);
  }

  lmove(): Promise<string | null> {
    return Promise.resolve(null);
  }

  lrange(): Promise<string[]> {
    return Promise.resolve([]);
  }

  llen(): Promise<number> {
    return Promise.resolve(0);
  }

  ltrim(): Promise<void> {
    return Promise.resolve();
  }

  lindex(): Promise<string | null> {
    return Promise.resolve(null);
  }

  lset(): Promise<void> {
    return Promise.resolve();
  }

  get(): Promise<string | null> {
    return Promise.resolve(null);
  }

  set(): Promise<"OK"> {
    return Promise.resolve("OK");
  }

  expire(): Promise<number> {
    return Promise.resolve(1);
  }

  del(): Promise<number> {
    return Promise.resolve(0);
  }

  hset(key: string, values: Record<string, string>): Promise<number> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    let added = 0;
    for (const [field, value] of Object.entries(values)) {
      if (!hash.has(field)) added += 1;
      hash.set(field, value);
    }
    this.hashes.set(key, hash);
    return Promise.resolve(added);
  }

  hgetall(key: string): Promise<Record<string, string>> {
    return Promise.resolve(
      Object.fromEntries((this.hashes.get(key) ?? new Map()).entries()),
    );
  }

  hincrby(key: string, field: string, increment: number): Promise<number> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    const next = Number(hash.get(field) ?? 0) + increment;
    hash.set(field, String(next));
    this.hashes.set(key, hash);
    return Promise.resolve(next);
  }

  hincrbyfloat(
    key: string,
    field: string,
    increment: number,
  ): Promise<string> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    const next = Number(hash.get(field) ?? 0) + increment;
    hash.set(field, String(next));
    this.hashes.set(key, hash);
    return Promise.resolve(String(next));
  }

  on(event: RedisEvent, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: RedisEvent, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  private emit(event: RedisEvent, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

const textEncoder = new TextEncoder();

const createOversizedSessionNoteText = (): string => {
  const timestamp = "2026-04-11T10:00:00.000Z";
  const emptyPayloadBytes = textEncoder.encode(JSON.stringify({
    note: {
      id: crypto.randomUUID(),
      text: "",
      created_at: timestamp,
      updated_at: timestamp,
    },
  })).byteLength;
  return "x".repeat(
    SESSION_MCP_RESPONSE_BUDGET_BYTES - emptyPayloadBytes + 1,
  );
};

const toolContext = {
  sessionID: "session-123",
  messageID: "message-123",
  agent: "agent-123",
  directory: "/workspace/project",
  worktree: "/workspace/project",
  abort: AbortSignal.timeout(1_000),
  metadata: () => {},
  ask: async (_input: {
    permission: string;
    patterns: string[];
    always: string[];
    metadata: Record<string, unknown>;
  }) => {},
};

const createToolContext = (overrides: Partial<typeof toolContext> = {}) => ({
  ...toolContext,
  ...overrides,
});

const createRootToolContext = (
  rootSessionId: string,
  overrides: Partial<typeof toolContext> = {},
) =>
  createToolContext({
    sessionID: rootSessionId,
    ...overrides,
  });

const validRequests: Record<SessionMcpToolName, Record<string, unknown>> = {
  session_execute: {
    command: "pwd",
  },
  session_execute_file: {
    paths: ["README.md"],
  },
  session_batch_execute: {
    commands: [{ command: "first" }, { command: "second" }],
  },
  session_index: {
    content: "hello world",
  },
  session_search: {
    query: "hello",
  },
  session_fetch_and_index: {
    url: "https://example.com",
  },
  session_stats: {},
  session_doctor: {},
  session_notes_write: {
    text: "remember this",
  },
  session_notes_read: {
    id: "note-1",
  },
};

it("rejects caller-supplied root_session_id for every public session request schema", () => {
  for (const toolName of SESSION_MCP_TOOL_NAMES) {
    const valid = sessionMcpRequestSchemas[toolName].safeParse(
      validRequests[toolName],
    );
    const rejected = sessionMcpRequestSchemas[toolName].safeParse({
      ...validRequests[toolName],
      root_session_id: "root-123",
    });

    assertEquals(
      valid.success,
      true,
      `${toolName} should accept rootless input`,
    );
    assertEquals(
      rejected.success,
      false,
      `${toolName} should reject caller-supplied root_session_id`,
    );
  }
});

it("note schema compatibility accepts approved note request and response contracts", () => {
  const writeRequest = sessionMcpRequestSchemas.session_notes_write.safeParse({
    text: "remember this",
    replace: "note-1",
  });
  const rejectedWriteRequest = sessionMcpRequestSchemas.session_notes_write
    .safeParse({
      root_session_id: "root-123",
      text: "remember this",
    });
  const deleteResponse = sessionMcpResponseSchemas.session_notes_write
    .safeParse({
      action: "deleted",
      id: "note-1",
    });
  const clearedResponse = sessionMcpResponseSchemas.session_notes_write
    .safeParse({
      action: "replaced",
      cleared_count: 2,
    });
  const readRequest = sessionMcpRequestSchemas.session_notes_read.safeParse({
    id: "note-1",
  });
  const missingReadRequest = sessionMcpRequestSchemas.session_notes_read
    .safeParse({});
  const rejectedReadRequest = sessionMcpRequestSchemas.session_notes_read
    .safeParse({
      root_session_id: "root-123",
      id: "note-1",
    });
  const readResponse = sessionMcpResponseSchemas.session_notes_read.safeParse({
    note: {
      id: "note-1",
      text: "remember this",
      created_at: "2026-04-11T10:00:00.000Z",
      updated_at: "2026-04-11T10:00:00.000Z",
    },
  });
  const missingReadResponse = sessionMcpResponseSchemas.session_notes_read
    .safeParse({ note: null });

  assertEquals(writeRequest.success, true);
  assertEquals(rejectedWriteRequest.success, false);
  assertEquals(deleteResponse.success, true);
  assertEquals(clearedResponse.success, true);
  assertEquals(readRequest.success, true);
  assertEquals(missingReadRequest.success, false);
  assertEquals(rejectedReadRequest.success, false);
  assertEquals(readResponse.success, true);
  assertEquals(missingReadResponse.success, true);
});

it("session_search schema accepts query mode with optional when", () => {
  const queryRequest = sessionMcpRequestSchemas.session_search.safeParse({
    query: "memory redesign",
    when: "2026-04-21T12:00:00.000Z",
  });
  const reflectionRequest = sessionMcpRequestSchemas.session_search.safeParse({
    query: "",
    when: "2026-04-21T12:00:00.000Z",
  });
  const rejectedRequest = sessionMcpRequestSchemas.session_search.safeParse({
    root_session_id: "root-123",
    query: "memory redesign",
  });
  const accepted = sessionMcpResponseSchemas.session_search.safeParse({
    status: "ok",
    results: [
      {
        ref: "session:root:entry:turn-1",
        snippet: "Use opencode db as exact truth.",
        score: 0.95,
        type: "entry",
        id: "turn-1",
        created_at: "2026-04-21T11:00:00.000Z",
        updated_at: "2026-04-21T11:05:00.000Z",
        root_session_id: "root-123",
        scope: "session",
        source: "opencode-db",
      },
      {
        ref: "session:root:note:note-1",
        snippet: "Remember to keep summary injection lightweight.",
        score: 0.87,
        type: "note",
        id: "note-1",
        created_at: "2026-04-21T10:00:00.000Z",
        updated_at: "2026-04-21T10:10:00.000Z",
        root_session_id: "root-123",
        scope: "local",
        source: "session-notes",
      },
      {
        ref: "session:root:summary:day:2026-04-21",
        snippet: "Recent design work moved exact recall to session_search().",
        score: 0.81,
        type: "summary",
        created_at: "2026-04-21T00:00:00.000Z",
        granularity: "day",
        source: "snapshot",
        scope: "session",
      },
    ],
    refs: [
      "session:root:entry:turn-1",
      "session:root:note:note-1",
      "session:root:summary:day:2026-04-21",
    ],
    truncated: false,
  });
  const rejected = sessionMcpResponseSchemas.session_search.safeParse({
    status: "ok",
    results: [{
      ref: "session:root:entry:turn-1",
      snippet: "Use opencode db as exact truth.",
      score: 0.95,
      type: "entry",
      created_at: "2026-04-21T11:00:00.000Z",
      corpus_ref: "session:root:corpus:1",
    }],
    refs: ["session:root:entry:turn-1"],
    truncated: false,
  });

  assertEquals(queryRequest.success, true);
  assertEquals(reflectionRequest.success, true);
  assertEquals(rejectedRequest.success, false);
  assertEquals(accepted.success, true);
  assertEquals(rejected.success, false);
});

it("mixed|batch schema compatibility", () => {
  const request = sessionMcpRequestSchemas.session_batch_execute.safeParse({
    steps: [
      { kind: "command", command: "pwd" },
      { kind: "search", query: "session continuity" },
    ],
  });
  const response = sessionMcpResponseSchemas.session_batch_execute.safeParse({
    status: "ok",
    summary: "Completed 2 step(s).",
    results: [
      {
        kind: "command",
        result: {
          status: "ok",
          summary: "pwd",
          exit_code: 0,
          timed_out: false,
          truncated: false,
          bytes_captured: 3,
        },
      },
      {
        kind: "search",
        result: {
          status: "ok",
          results: [
            {
              ref: "session:root:summary:day:2026-04-21",
              snippet: "session continuity",
              score: 0.9,
              type: "summary",
              created_at: "2026-04-21T00:00:00.000Z",
              granularity: "day",
              source: "snapshot",
              scope: "session",
            },
          ],
          refs: ["session:root:summary:day:2026-04-21"],
          truncated: false,
        },
      },
    ],
    truncated: false,
  });

  assertEquals(request.success, true);
  if (request.success) {
    assertEquals(request.data.commands.length, 1);
    assertEquals(request.data.commands[0]?.command, "pwd");
    assertEquals(request.data.steps, [
      { kind: "command", command: "pwd" },
      { kind: "search", query: "session continuity" },
    ]);
  }

  assertEquals(response.success, true);
});

it("index schema compatibility accepts critical request fields", () => {
  const inlineRequest = sessionMcpRequestSchemas.session_index.safeParse({
    content: "hello world",
  });
  const pathRequest = sessionMcpRequestSchemas.session_index.safeParse({
    path: "docs/notes.md",
  });
  const metadataRequest = sessionMcpRequestSchemas.session_index.safeParse({
    content: "hello world",
    source: "local-file",
    label: "notes",
  });

  assertEquals(inlineRequest.success, true);
  assertEquals(pathRequest.success, true);
  assertEquals(metadataRequest.success, true);
  if (metadataRequest.success) {
    assertEquals(metadataRequest.data.source, "local-file");
    assertEquals(metadataRequest.data.label, "notes");
  }
});

it("index schema compatibility rejects requests without content or path", () => {
  const request = sessionMcpRequestSchemas.session_index.safeParse({
    source: "local-file",
    label: "notes",
  });

  assertEquals(request.success, false);
});

describe("session-mcp-runtime", () => {
  it("returns entry and note hits before summary hits in query mode", async () => {
    const runtime = createSessionMcpRuntime({
      groupId: "group-memory-search-query",
      notesService: {
        searchNotes: () =>
          Promise.resolve([{
            id: "note-1",
            root_session_id: "root-memory-search",
            scope: "local",
            snippet: "Pinned note hit",
            score: 0.89,
            created_at: "2026-04-21T00:00:00.000Z",
            updated_at: "2026-04-21T00:00:00.000Z",
          }]),
      },
      exactHistoryAdapter: {
        search: () =>
          Promise.resolve([
            createSearchResult({
              ref: "session:root:entry:turn-1",
              snippet: "Exact entry hit",
              score: 0.92,
              type: "entry",
              id: "turn-1",
              root_session_id: "root-memory-search",
              scope: "session",
              source: "opencode-db",
              updated_at: "2026-04-21T11:05:00.000Z",
              created_at: "2026-04-21T11:00:00.000Z",
            }),
          ]),
      },
      summarySearchAdapter: {
        search: () =>
          Promise.resolve([
            createSearchResult({
              ref: "session:root:summary:day:2026-04-21",
              snippet: "Recent summary hit",
              score: 0.99,
              type: "summary",
              scope: "session",
              source: "snapshot",
              granularity: "day",
            }),
          ]),
      },
    } as never);

    try {
      const parsed = JSON.parse(
        await runtime.tools.session_search.execute(
          { query: "memory redesign" },
          createRootToolContext("root-memory-search"),
        ),
      );

      assertEquals(parsed.status, "ok");
      assertEquals(
        parsed.results.map((result: { type: string }) => result.type),
        [
          "entry",
          "note",
          "summary",
        ],
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("returns summaries only for reflection mode", async () => {
    const runtime = createSessionMcpRuntime({
      groupId: "group-memory-search-reflection",
      notesService: {
        searchNotes: () =>
          Promise.resolve([{
            id: "note-ignored",
            root_session_id: "root-memory-search",
            scope: "local",
            snippet: "Ignored note hit",
            score: 1,
            created_at: "2026-04-21T00:00:00.000Z",
            updated_at: "2026-04-21T00:00:00.000Z",
          }]),
      },
      exactHistoryAdapter: {
        search: () =>
          Promise.resolve([
            createSearchResult({
              ref: "session:root:entry:turn-2",
              snippet: "Ignored entry hit",
              score: 1,
              type: "entry",
              id: "turn-2",
              root_session_id: "root-memory-search",
              scope: "session",
              source: "opencode-db",
              created_at: "2026-04-21T11:00:00.000Z",
            }),
          ]),
      },
      summarySearchAdapter: {
        search: () =>
          Promise.resolve([
            createSearchResult({
              ref: "session:root:summary:day:2026-04-20",
              snippet: "Older summary",
              score: 0.2,
              type: "summary",
              scope: "session",
              source: "snapshot",
              granularity: "day",
              created_at: "2026-04-20T00:00:00.000Z",
            }),
            createSearchResult({
              ref: "session:root:summary:day:2026-04-21",
              snippet: "Newer summary",
              score: 0.9,
              type: "summary",
              scope: "session",
              source: "snapshot",
              granularity: "day",
              created_at: "2026-04-21T00:00:00.000Z",
            }),
          ]),
      },
    } as never);

    try {
      const parsed = JSON.parse(
        await runtime.tools.session_search.execute(
          { query: "" },
          createRootToolContext("root-memory-search"),
        ),
      );

      assertEquals(parsed.status, "ok");
      assertEquals(
        parsed.results.map((result: { type: string }) => result.type),
        [
          "summary",
          "summary",
        ],
      );
      assertEquals(
        parsed.results.map((result: { ref: string }) => result.ref),
        [
          "session:root:summary:day:2026-04-20",
          "session:root:summary:day:2026-04-21",
        ],
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("passes when through the canonical runtime search path", async () => {
    const calls: Array<{ rootSessionId: string; query: string; when: string }> =
      [];
    const manager = new SessionManager(
      "group-memory-search-when",
      "user-memory-search-when",
      {
        session: {
          get() {
            throw new Error("unexpected session lookup");
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    manager.setParentId("root-session", null);
    manager.setParentId("child-session", "root-session");

    const runtime = createSessionMcpRuntime({
      sessionCanonicalizer: manager,
      notesService: {
        searchNotes: () => Promise.resolve([]),
      },
      exactHistoryAdapter: {
        search: (input: {
          rootSessionId: string;
          query: string;
          when: string;
        }) => {
          calls.push(input);
          return Promise.resolve([]);
        },
      },
      summarySearchAdapter: {
        search: (input: {
          rootSessionId: string;
          query: string;
          when: string;
        }) => {
          calls.push(input);
          return Promise.resolve([]);
        },
      },
    } as never);

    try {
      await runtime.tools.session_search.execute(
        {
          query: "carry context forward",
          when: "2026-04-21T12:00:00.000Z",
        },
        {
          ...toolContext,
          sessionID: "child-session",
        },
      );

      assertEquals(calls, [
        {
          rootSessionId: "root-session",
          query: "carry context forward",
          when: "2026-04-21T12:00:00.000Z",
        },
        {
          rootSessionId: "root-session",
          query: "carry context forward",
          when: "2026-04-21T12:00:00.000Z",
        },
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  it("registers exactly the session tools in the declared order", () => {
    const runtime = createSessionMcpRuntime();

    try {
      assertEquals(Object.keys(runtime.tools), [...SESSION_MCP_TOOL_NAMES]);
    } finally {
      void runtime.dispose();
    }
  });

  it("registers note tools with the shipped descriptions and expected args", () => {
    const runtime = createSessionMcpRuntime();

    try {
      assertExists(runtime.tools.session_notes_write);
      assertExists(runtime.tools.session_notes_read);
      assertStringIncludes(
        SESSION_NOTES_WRITE_DESCRIPTION,
        "replace id + non-empty text is upsert",
      );
      assertStringIncludes(
        SESSION_NOTES_WRITE_DESCRIPTION,
        'replace "*" + non-empty text replaces all notes',
      );
      assertStringIncludes(
        SESSION_NOTES_WRITE_DESCRIPTION,
        'replace "*" + empty text clears all notes',
      );
      assertStringIncludes(
        SESSION_NOTES_READ_DESCRIPTION,
        "returns that single note as",
      );
      assertStringIncludes(
        SESSION_NOTES_READ_DESCRIPTION,
        "returns `{ note: null }`",
      );
      assertStringIncludes(
        SESSION_SEARCH_BASELINE_DESCRIPTION,
        '`id`, `root_session_id`, `scope: "local" | "project"`, `created_at`, and',
      );
      assertStringIncludes(
        runtime.tools.session_fetch_and_index.description,
        "session_search({ query: corpus_ref })",
      );
      assertStringIncludes(
        runtime.tools.session_fetch_and_index.description,
        "exact `corpus_ref`",
      );
      assertStringIncludes(
        runtime.tools.session_search.description,
        "session_search({ query: corpus_ref })",
      );
      assertStringIncludes(
        runtime.tools.session_search.description,
        "exact `corpus_ref` previously returned by `session_fetch_and_index`",
      );
      assertEquals(
        runtime.tools.session_notes_write.description,
        SESSION_NOTES_WRITE_DESCRIPTION,
      );
      assertEquals(
        runtime.tools.session_notes_read.description,
        SESSION_NOTES_READ_DESCRIPTION,
      );
      assertEquals(
        runtime.tools.session_search.description,
        SESSION_SEARCH_BASELINE_DESCRIPTION,
      );
      for (
        const description of [
          runtime.tools.session_execute.description,
          runtime.tools.session_execute_file.description,
          runtime.tools.session_batch_execute.description,
          runtime.tools.session_index.description,
          runtime.tools.session_search.description,
          runtime.tools.session_fetch_and_index.description,
          runtime.tools.session_stats.description,
          runtime.tools.session_doctor.description,
          runtime.tools.session_notes_write.description,
          runtime.tools.session_notes_read.description,
        ]
      ) {
        assertStringIncludes(
          description,
          "Do not pass `root_session_id`; the runtime resolves the current canonical",
        );
        assertStringIncludes(
          description,
          "root session automatically.",
        );
      }
      assertEquals(Object.keys(runtime.tools.session_notes_write.args), [
        "text",
        "replace",
      ]);
      assertEquals(Object.keys(runtime.tools.session_notes_read.args), [
        "id",
      ]);
      assertEquals(Object.keys(runtime.tools.session_search.args), [
        "query",
        "when",
      ]);
    } finally {
      void runtime.dispose();
    }
  });

  it("pins the cross-tool continuity protocol language in shipped descriptions", () => {
    const search = SESSION_SEARCH_BASELINE_DESCRIPTION.toLowerCase();
    const strengthened = SESSION_SEARCH_STRENGTHENED_DESCRIPTION.toLowerCase();
    const read = SESSION_NOTES_READ_DESCRIPTION.toLowerCase();
    const write = SESSION_NOTES_WRITE_DESCRIPTION.toLowerCase();

    // session_search should bias agents toward search-first recall, especially
    // at the start of a new session or after compaction, and should explicitly
    // chain to session_notes_read for note hits.
    assertStringIncludes(search, "first");
    assertStringIncludes(search, "after compaction");
    assertStringIncludes(search, "session_notes_read");
    assertStringIncludes(search, "session_notes_write");
    assertStringIncludes(search, "session_search({ query: corpus_ref })");
    assertStringIncludes(
      search,
      "exact `corpus_ref` previously returned by `session_fetch_and_index`",
    );

    // The strengthened overlay (used on new sessions and post-compaction turns)
    // must keep the strong recommendation and still chain to session_notes_read.
    assertStringIncludes(strengthened, "new session");
    assertStringIncludes(strengthened, "post-compaction");
    assertStringIncludes(strengthened, "strongly recommended");
    assertStringIncludes(strengthened, "session_search");
    assertStringIncludes(strengthened, "session_notes_read");

    // session_notes_read should reinforce that it is the second step after
    // session_search and that new-session/post-compaction are recall moments.
    // It must also tell agents that progress updates use non-empty text so
    // they don't accidentally delete via empty-text replace.
    assertStringIncludes(read, "session_search");
    assertStringIncludes(read, "after compaction");
    assertStringIncludes(read, "non-empty");
    // Pin the empty-text deletion footgun warning on the read description so
    // future edits cannot silently drop it. Use small lowercase-normalized
    // fragments rather than exact sentence/casing.
    assertStringIncludes(read, "empty `text`");
    assertStringIncludes(read, "delete");
    assertStringIncludes(read, "fully");
    assertStringIncludes(read, "complete");

    // session_notes_write should still encode the lifecycle protocol, but now
    // also bias agents to use notes as searchable handoff state before
    // delegating or pausing non-trivial work.
    for (
      const phrase of [
        // Step 1: search before creating, then create checklist.
        "session_search",
        "session_notes_read",
        "handoff note",
        "delegating non-trivial work",
        "searchable",
        // Step 2: upsert with id.
        "replace: <id>",
        "non-empty",
        // Step 3: stop mid-task / approaching context limit.
        "mid-task",
        "before reporting back",
        "75%",
        // Step 4: clear only when fully complete; clearing == delete.
        "fully",
        "complete",
        "empty `text`",
        "trivial",
        "evergreen",
        "learnings",
        "stale facts",
        "prior sessions",
        "same-project",
        "verification state",
      ]
    ) {
      assertStringIncludes(write, phrase.toLowerCase());
    }
  });

  it("executes the full note action contract through the runtime", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
    } as never);

    try {
      const created = JSON.parse(
        await runtime.tools.session_notes_write.execute(
          {
            text: "first note",
          },
          toolContext,
        ),
      );
      assertEquals(created.action, "created");
      assertExists(created.id);

      const readCreated = JSON.parse(
        await runtime.tools.session_notes_read.execute(
          {
            id: created.id,
          },
          toolContext,
        ),
      );
      assertEquals(readCreated.note.text, "first note");
      assertEquals(
        sessionMcpResponseSchemas.session_notes_read.safeParse(readCreated)
          .success,
        true,
      );

      const replaced = JSON.parse(
        await runtime.tools.session_notes_write.execute(
          {
            text: "updated note",
            replace: created.id,
          },
          toolContext,
        ),
      );
      assertEquals(replaced, {
        action: "replaced",
        id: created.id,
      });
      assertEquals(
        sessionMcpResponseSchemas.session_notes_write.safeParse(replaced)
          .success,
        true,
      );

      const createdSecond = JSON.parse(
        await runtime.tools.session_notes_write.execute(
          {
            text: "second note",
          },
          toolContext,
        ),
      );
      assertEquals(createdSecond.action, "created");
      assertExists(createdSecond.id);

      const replacedAll = JSON.parse(
        await runtime.tools.session_notes_write.execute(
          {
            text: "replacement note",
            replace: "*",
          },
          toolContext,
        ),
      );
      assertEquals(replacedAll.action, "replaced");
      assertExists(replacedAll.id);
      assertEquals(replacedAll.cleared_count, 2);
      assertEquals(
        sessionMcpResponseSchemas.session_notes_write.safeParse(replacedAll)
          .success,
        true,
      );

      const readSingle = JSON.parse(
        await runtime.tools.session_notes_read.execute(
          {
            id: replacedAll.id,
          },
          toolContext,
        ),
      );
      assertEquals(readSingle.note.text, "replacement note");

      const deleted = JSON.parse(
        await runtime.tools.session_notes_write.execute(
          {
            text: "",
            replace: replacedAll.id,
          },
          toolContext,
        ),
      );
      assertEquals(deleted, {
        action: "deleted",
        id: replacedAll.id,
      });
      assertEquals(
        sessionMcpResponseSchemas.session_notes_write.safeParse(deleted)
          .success,
        true,
      );

      const cleared = JSON.parse(
        await runtime.tools.session_notes_write.execute(
          {
            text: "",
            replace: "*",
          },
          toolContext,
        ),
      );
      assertEquals(cleared, {
        action: "replaced",
        cleared_count: 0,
      });
      assertEquals(
        sessionMcpResponseSchemas.session_notes_write.safeParse(cleared)
          .success,
        true,
      );

      const readDeleted = JSON.parse(
        await runtime.tools.session_notes_read.execute(
          {
            id: replacedAll.id,
          },
          toolContext,
        ),
      );
      assertEquals(readDeleted, { note: null });
      assertEquals(
        sessionMcpResponseSchemas.session_notes_read.safeParse(readDeleted)
          .success,
        true,
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects oversized note writes before storage and suggests splitting notes", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
    } as never);
    const oversizedText = createOversizedSessionNoteText();

    try {
      await assertRejects(
        () =>
          runtime.tools.session_notes_write.execute(
            {
              text: oversizedText,
            },
            toolContext,
          ),
        Error,
        "multiple cross-referencing session notes",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("applies the shared response budget guard to session_notes_read", async () => {
    const oversizedText = "x".repeat(SESSION_MCP_RESPONSE_BUDGET_BYTES + 1_024);
    const runtime = createSessionMcpRuntime({
      notesService: {
        readNote: () =>
          Promise.resolve({
            note: {
              id: "note-oversized",
              text: oversizedText,
              created_at: "2026-04-11T10:00:00.000Z",
              updated_at: "2026-04-11T10:00:00.000Z",
            },
          }),
      } as never,
    } as never);

    try {
      await assertRejects(
        () =>
          runtime.tools.session_notes_read.execute(
            { id: "note-oversized" },
            toolContext,
          ),
        Error,
        `session_notes_read response exceeded ${SESSION_MCP_RESPONSE_BUDGET_BYTES} bytes`,
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("resolves rootless search and note writes from the canonical tool context session", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const manager = new SessionManager(
      "group-runtime-rootless",
      "user-runtime-rootless",
      {
        session: {
          get() {
            throw new Error("unexpected session lookup");
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    manager.setParentId("root-session", null);
    manager.setParentId("child-session", "root-session");
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      sessionCanonicalizer: manager,
      groupId: "group-runtime-rootless",
    } as never);

    try {
      await runtime.tools.session_index.execute(
        {
          content: "canonical root search corpus",
        },
        createRootToolContext("root-session"),
      );

      const created = JSON.parse(
        await runtime.tools.session_notes_write.execute(
          {
            text: "canonical root pinned note",
          },
          {
            ...toolContext,
            sessionID: "child-session",
          },
        ),
      );
      const search = JSON.parse(
        await runtime.tools.session_search.execute(
          {
            query: "canonical root pinned note",
          },
          {
            ...toolContext,
            sessionID: "child-session",
          },
        ),
      );

      assertEquals(created.action, "created");
      assertExists(created.id);
      assertEquals(search.status, "ok");
      assertEquals(
        search.results.some((result: { id?: string }) =>
          result.id === created.id
        ),
        true,
      );
      assertEquals(
        search.results.some((result: { root_session_id?: string }) =>
          result.root_session_id === "root-session"
        ),
        true,
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("reads a note directly by id across same-project sessions", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-runtime-direct-read",
    } as never);

    try {
      const created = JSON.parse(
        await runtime.tools.session_notes_write.execute(
          {
            text: "same project note body",
          },
          {
            ...toolContext,
            sessionID: "session-a",
          },
        ),
      );
      const read = JSON.parse(
        await runtime.tools.session_notes_read.execute(
          {
            id: created.id,
          },
          {
            ...toolContext,
            sessionID: "session-b",
          },
        ),
      );

      assertEquals(read, {
        note: {
          id: created.id,
          text: "same project note body",
          created_at: read.note.created_at,
          updated_at: read.note.updated_at,
        },
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("ranks local note hits ahead of project note hits for the same query", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-runtime-note-ranking",
    } as never);

    try {
      const project = JSON.parse(
        await runtime.tools.session_notes_write.execute(
          {
            text: "redis ttl ranking note exact phrase",
          },
          {
            ...toolContext,
            sessionID: "project-session",
          },
        ),
      );
      const local = JSON.parse(
        await runtime.tools.session_notes_write.execute(
          {
            text: "redis ttl ranking note exact phrase",
          },
          {
            ...toolContext,
            sessionID: "local-session",
          },
        ),
      );
      const search = JSON.parse(
        await runtime.tools.session_search.execute(
          {
            query: "redis ttl ranking note exact phrase",
          },
          {
            ...toolContext,
            sessionID: "local-session",
          },
        ),
      );
      const noteHits = search.results.filter((result: { type?: string }) =>
        result.type === "note"
      );

      assertEquals(noteHits.length >= 2, true);
      assertEquals(noteHits[0].id, local.id);
      assertEquals(noteHits[0].scope, "local");
      assertEquals(noteHits[0].root_session_id, "local-session");
      assertEquals(noteHits[1].id, project.id);
      assertEquals(noteHits[1].scope, "project");
      assertEquals(noteHits[1].root_session_id, "project-session");
      assertEquals(noteHits[0].score >= noteHits[1].score, true);
    } finally {
      await runtime.dispose();
    }
  });

  it("merges note and memory hits in session_search with typed results sorted by score", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-note-search",
    } as never);

    try {
      await runtime.tools.session_index.execute(
        {
          content:
            "Redis TTL memory entry mentions the active bug and prior mitigation.",
        },
        createRootToolContext("root-note-search"),
      );
      const created = JSON.parse(
        await runtime.tools.session_notes_write.execute(
          {
            text: "Redis TTL bug active bug mitigation note for follow-up.",
          },
          createRootToolContext("root-note-search"),
        ),
      );

      const serialized = await runtime.tools.session_search.execute(
        {
          query: "Redis TTL bug active bug mitigation note for follow-up.",
        },
        createRootToolContext("root-note-search"),
      );
      const parsed = JSON.parse(serialized);
      const noteHit = parsed.results.find((result: { type?: string }) =>
        result.type === "note"
      );
      const summaryHit = parsed.results.find((result: { type?: string }) =>
        result.type === "summary"
      );

      assertEquals(
        sessionMcpResponseSchemas.session_search.safeParse(parsed).success,
        true,
      );
      assertExists(noteHit);
      assertExists(summaryHit);
      assertEquals(noteHit.id, created.id);
      assertEquals(noteHit.root_session_id, "root-note-search");
      assertEquals(noteHit.scope, "local");
      assertStringIncludes(noteHit.ref, created.id);
      assertStringIncludes(
        noteHit.snippet,
        "Redis TTL bug active bug mitigation",
      );
      assertStringIncludes(
        runtime.tools.session_search.description,
        "session_notes_read",
      );
      assertEquals(summaryHit.type, "summary");
      assertEquals(
        parsed.results.findIndex((result: { type?: string }) =>
          result.type === "note"
        ) < parsed.results.findIndex((result: { type?: string }) =>
          result.type === "summary"
        ),
        true,
      );
      assertEquals(
        parsed.results.some((result: { type?: string }) =>
          result.type === "note"
        ),
        true,
      );
      assertEquals(
        parsed.results.some((result: { type?: string }) =>
          result.type === "summary"
        ),
        true,
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("returns only the exact corpus hit for exact corpus_ref session_search queries", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-exact-corpus-search",
    } as never);

    try {
      const indexed = JSON.parse(
        await runtime.tools.session_index.execute(
          {
            content:
              "Redis TTL memory entry mentions the active bug and prior mitigation.",
          },
          createRootToolContext("root-exact-corpus-search"),
        ),
      );
      await runtime.tools.session_notes_write.execute(
        {
          text: "Redis TTL bug active bug mitigation note for follow-up.",
        },
        createRootToolContext("root-exact-corpus-search"),
      );

      const parsed = JSON.parse(
        await runtime.tools.session_search.execute(
          {
            query: indexed.corpus_ref,
          },
          createRootToolContext("root-exact-corpus-search"),
        ),
      );

      assertEquals(parsed.status, "ok");
      assertEquals(parsed.results.length, 1);
      assertEquals(parsed.results[0]?.type, "entry");
      assertEquals(parsed.results[0]?.ref, indexed.corpus_ref);
      assertEquals(
        parsed.results[0]?.root_session_id,
        "root-exact-corpus-search",
      );
      assertEquals(parsed.results[0]?.scope, "local");
      assertEquals(
        parsed.results.some((result: { type?: string }) =>
          result.type === "note"
        ),
        false,
      );
      assertEquals(parsed.refs, [indexed.corpus_ref]);
    } finally {
      await runtime.dispose();
    }
  });

  it("returns an empty result when an exact corpus_ref query misses", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-exact-corpus-miss",
    } as never);

    try {
      await runtime.tools.session_index.execute(
        {
          content:
            "Redis TTL memory entry mentions the active bug and prior mitigation.",
        },
        createRootToolContext("root-exact-corpus-miss"),
      );
      await runtime.tools.session_notes_write.execute(
        {
          text: "Redis TTL bug active bug mitigation note for follow-up.",
        },
        createRootToolContext("root-exact-corpus-miss"),
      );

      const parsed = JSON.parse(
        await runtime.tools.session_search.execute(
          {
            query:
              "session:group-exact-corpus-miss:root-exact-corpus-miss:corpus:missing:meta",
          },
          createRootToolContext("root-exact-corpus-miss"),
        ),
      );

      assertEquals(parsed.status, "ok");
      assertEquals(parsed.results, []);
      assertEquals(parsed.refs, []);
      assertEquals(parsed.truncated, false);
    } finally {
      await runtime.dispose();
    }
  });

  it("returns an empty result for exact corpus_ref queries when no corpus service is configured", async () => {
    const runtime = createSessionMcpRuntime({
      groupId: "group-corpusless-exact-corpus-miss",
      notesService: {
        searchNotes: () =>
          Promise.resolve([{
            id: "note-1",
            root_session_id: "root-corpusless-exact-corpus-miss",
            scope: "local",
            snippet: "Unrelated note hit that should be ignored.",
            score: 0.99,
            created_at: "2026-04-21T00:00:00.000Z",
            updated_at: "2026-04-21T00:00:00.000Z",
          }]),
      },
      exactHistoryAdapter: {
        search: () =>
          Promise.resolve([
            createSearchResult({
              ref: "session:root-corpusless-exact-corpus-miss:entry:turn-1",
              snippet: "Unrelated history hit that should be ignored.",
              score: 0.98,
              type: "entry",
              id: "turn-1",
              root_session_id: "root-corpusless-exact-corpus-miss",
              scope: "session",
              source: "opencode-db",
              created_at: "2026-04-21T11:00:00.000Z",
            }),
          ]),
      },
      summarySearchAdapter: {
        search: () =>
          Promise.resolve([
            createSearchResult({
              ref:
                "session:root-corpusless-exact-corpus-miss:summary:day:2026-04-21",
              snippet: "Unrelated summary hit that should be ignored.",
              score: 0.97,
              type: "summary",
              scope: "session",
              source: "snapshot",
              granularity: "day",
              created_at: "2026-04-21T00:00:00.000Z",
            }),
          ]),
      },
    } as never);

    try {
      const parsed = JSON.parse(
        await runtime.tools.session_search.execute(
          {
            query:
              "session:group-corpusless-exact-corpus-miss:root-corpusless-exact-corpus-miss:corpus:missing:meta",
          },
          createRootToolContext("root-corpusless-exact-corpus-miss"),
        ),
      );

      assertEquals(parsed.status, "ok");
      assertEquals(parsed.results, []);
      assertEquals(parsed.refs, []);
      assertEquals(parsed.truncated, false);
    } finally {
      await runtime.dispose();
    }
  });

  it("note hits from session_search include created_at and updated_at strings", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-note-timestamps",
    } as never);

    try {
      await runtime.tools.session_notes_write.execute(
        { text: "timestamp freshness contract note for search" },
        createRootToolContext("root-note-timestamps"),
      );

      const serialized = await runtime.tools.session_search.execute(
        { query: "timestamp freshness contract" },
        createRootToolContext("root-note-timestamps"),
      );
      const parsed = JSON.parse(serialized);
      const noteHit = parsed.results.find(
        (result: { type?: string }) => result.type === "note",
      );

      assertExists(noteHit);
      assertEquals(typeof noteHit.created_at, "string");
      assertEquals(typeof noteHit.updated_at, "string");
      assert(noteHit.created_at.length > 0);
      assert(noteHit.updated_at.length > 0);
    } finally {
      await runtime.dispose();
    }
  });

  it("returns only memory hits when no notes match or exist", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
    } as never);

    try {
      await runtime.tools.session_index.execute(
        {
          content: "Local memory result without pinned note entries.",
        },
        createRootToolContext("root-no-notes"),
      );

      const parsed = JSON.parse(
        await runtime.tools.session_search.execute(
          {
            query: "Local memory result",
          },
          createRootToolContext("root-no-notes"),
        ),
      );

      assertEquals(parsed.status, "ok");
      assertEquals(parsed.results.length > 0, true);
      assertEquals(
        parsed.results.every((result: { type?: string }) =>
          result.type !== "note"
        ),
        true,
      );
      assertEquals(
        parsed.results.every((result: { id?: string }) =>
          result.id === undefined
        ),
        true,
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("delegates execution tools to the injected shared executor when configured", async () => {
    const calls: Array<{ tool: string; payload: unknown }> = [];
    type ExecutorRequestMap = {
      executeCommand: Parameters<SessionExecutor["executeCommand"]>[0];
      executeFile: Parameters<SessionExecutor["executeFile"]>[0];
    };
    const executor: SessionExecutor = {
      executeCommand(request: ExecutorRequestMap["executeCommand"]) {
        calls.push({ tool: "session_execute", payload: request });
        return Promise.resolve({
          status: "ok",
          summary: "executor command",
          exit_code: 0,
          timed_out: false,
          truncated: false,
          bytes_captured: 16,
        });
      },
      executeFile(request: ExecutorRequestMap["executeFile"]) {
        calls.push({ tool: "session_execute_file", payload: request });
        return Promise.resolve({
          status: "ok",
          summary: "executor file",
          file_count: 1,
          truncated: false,
        });
      },
      executeBatch() {
        return Promise.resolve({
          status: "ok",
          summary: "executor batch",
          results: [],
          truncated: false,
        });
      },
    };
    const runtime = createSessionMcpRuntime({
      sessionExecutor: executor,
    } as never);

    try {
      const command = JSON.parse(
        await runtime.tools.session_execute.execute(
          validRequests.session_execute,
          toolContext,
        ),
      );
      const file = JSON.parse(
        await runtime.tools.session_execute_file.execute(
          validRequests.session_execute_file,
          toolContext,
        ),
      );
      const batch = JSON.parse(
        await runtime.tools.session_batch_execute.execute(
          validRequests.session_batch_execute,
          toolContext,
        ),
      );

      assertEquals(calls.map((call) => call.tool), [
        "session_execute",
        "session_execute_file",
        "session_execute",
        "session_execute",
      ]);
      assertEquals(command.summary, "executor command");
      assertEquals(file.summary, "executor file");
      assertEquals(batch.summary, "Completed 2 step(s).");
      assertEquals(batch.results.map((item: { kind: string }) => item.kind), [
        "command",
        "command",
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps root_session_id private for all public session request schemas", () => {
    for (const toolName of SESSION_MCP_TOOL_NAMES) {
      const parsed = sessionMcpRequestSchemas[toolName].safeParse(
        validRequests[toolName],
      );

      assertEquals(parsed.success, true, toolName);
    }
  });

  it("accepts mixed batch step requests via steps and normalizes them internally", () => {
    const parsed = sessionMcpRequestSchemas.session_batch_execute.safeParse({
      steps: [
        { kind: "command", command: "pwd" },
        { kind: "search", query: "session continuity" },
      ],
    });

    assertEquals(parsed.success, true);
    if (!parsed.success) return;

    assertEquals(parsed.data.commands, [{
      command: "pwd",
      timeout_seconds: undefined,
    }]);
    assertEquals(parsed.data.steps, [
      { kind: "command", command: "pwd" },
      { kind: "search", query: "session continuity" },
    ]);
  });

  it("accepts legacy batch commands input and normalizes it to mixed steps", () => {
    const parsed = sessionMcpRequestSchemas.session_batch_execute.safeParse({
      commands: [
        { command: "first" },
        { command: "second", timeout_seconds: 5 },
      ],
    });

    assertEquals(parsed.success, true);
    if (!parsed.success) return;

    assertEquals(parsed.data.commands, [
      { command: "first" },
      { command: "second", timeout_seconds: 5 },
    ]);
    assertEquals(parsed.data.steps, [
      { kind: "command", command: "first" },
      { kind: "command", command: "second", timeout_seconds: 5 },
    ]);
  });

  it("rejects empty batch requests", () => {
    const emptySteps = sessionMcpRequestSchemas.session_batch_execute.safeParse(
      {
        steps: [],
      },
    );
    const emptyCommands = sessionMcpRequestSchemas.session_batch_execute
      .safeParse({
        commands: [],
      });

    assertEquals(emptySteps.success, false);
    assertEquals(emptyCommands.success, false);
  });

  it("rejects unknown mixed batch step kinds", () => {
    const parsed = sessionMcpRequestSchemas.session_batch_execute.safeParse({
      steps: [
        { kind: "command", command: "pwd" },
        { kind: "unknown", query: "session continuity" },
      ],
    });

    assertEquals(parsed.success, false);
  });

  it("validates mixed batch response results as a discriminated union", () => {
    const parsed = sessionMcpResponseSchemas.session_batch_execute.safeParse({
      status: "ok",
      summary: "Completed 2 step(s).",
      results: [
        {
          kind: "command",
          result: {
            status: "ok",
            summary: "pwd",
            exit_code: 0,
            timed_out: false,
            truncated: false,
            bytes_captured: 3,
          },
        },
        {
          kind: "search",
          result: {
            status: "ok",
            results: [
              {
                ref: "session:root:summary:day:2026-04-21",
                snippet: "session continuity",
                score: 0.9,
                type: "summary",
                created_at: "2026-04-21T00:00:00.000Z",
                granularity: "day",
              },
            ],
            refs: ["session:root:summary:day:2026-04-21"],
            truncated: false,
          },
        },
      ],
      truncated: false,
    });

    assertEquals(parsed.success, true);
    if (!parsed.success) return;

    assertEquals(parsed.data.results[0]?.kind, "command");
    assertEquals(parsed.data.results[1]?.kind, "search");
  });

  it("returns minimal valid stub responses for all registered tools", async () => {
    const runtime = createSessionMcpRuntime();

    try {
      for (const toolName of SESSION_MCP_TOOL_NAMES) {
        const serialized = await runtime.tools[toolName].execute(
          validRequests[toolName],
          toolContext,
        );
        const parsed = JSON.parse(serialized);

        assertEquals(
          sessionMcpResponseSchemas[toolName].safeParse(parsed).success,
          true,
          toolName,
        );
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects caller-supplied root_session_id before handler execution", async () => {
    const manager = new SessionManager(
      "group-runtime-mismatch",
      "user-runtime-mismatch",
      {
        session: {
          get() {
            throw new Error("unexpected session lookup");
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    manager.setParentId("root-session", null);
    manager.setParentId("child-session", "root-session");

    let handlerCalls = 0;
    const runtime = createSessionMcpRuntime({
      sessionCanonicalizer: manager,
      handlers: {
        session_execute: () => {
          handlerCalls += 1;
          return Promise.resolve({
            status: "ok",
            summary: "should not execute",
            exit_code: 0,
            timed_out: false,
            truncated: false,
            bytes_captured: 0,
          });
        },
      },
    } as never);

    try {
      await assertRejects(
        () =>
          runtime.tools.session_execute.execute(
            {
              root_session_id: "wrong-root",
              command: "pwd",
            },
            {
              ...toolContext,
              sessionID: "child-session",
            },
          ),
        Error,
        "root_session_id",
      );
      assertEquals(handlerCalls, 0);
    } finally {
      await runtime.dispose();
    }
  });

  it("allows canonical child requests only when the injected root matches lineage", async () => {
    const manager = new SessionManager(
      "group-runtime-lineage",
      "user-runtime-lineage",
      {
        session: {
          get() {
            throw new Error("unexpected session lookup");
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    manager.setParentId("root-session", null);
    manager.setParentId("child-session", "root-session");

    const runtime = createSessionMcpRuntime({
      sessionCanonicalizer: manager,
    } as never);

    try {
      const serialized = await runtime.tools.session_search.execute(
        {
          query: "indexed",
        },
        {
          ...toolContext,
          sessionID: "child-session",
        },
      );
      const parsed = JSON.parse(serialized);

      assertEquals(parsed.status, "ok");
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps provisional temporary-root requests valid until migration resolves them", async () => {
    let childLookupCount = 0;
    const manager = new SessionManager(
      "group-runtime-provisional",
      "user-runtime-provisional",
      {
        session: {
          get({ path }: { path: { id: string } }) {
            if (path.id === "child-session") {
              childLookupCount += 1;
              if (childLookupCount === 1) {
                const error = Object.assign(new Error("Session not found"), {
                  status: 404,
                });
                throw error;
              }
              return { data: { parentID: "parent-session" } };
            }
            if (path.id === "parent-session") {
              return { data: { parentID: null } };
            }
            throw new Error(`Unexpected session lookup: ${path.id}`);
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const runtime = createSessionMcpRuntime({
      sessionCanonicalizer: manager,
    } as never);

    try {
      const provisionalSerialized = await runtime.tools.session_stats.execute(
        {},
        {
          ...toolContext,
          sessionID: "child-session",
        },
      );
      const provisional = JSON.parse(provisionalSerialized);
      assertEquals(provisional.status, "ok");

      const canonicalSerialized = await runtime.tools.session_stats.execute(
        {},
        {
          ...toolContext,
          sessionID: "child-session",
        },
      );
      const canonical = JSON.parse(canonicalSerialized);
      assertEquals(canonical.status, "ok");

      await assertRejects(
        () =>
          runtime.tools.session_stats.execute(
            { root_session_id: "child-session" },
            {
              ...toolContext,
              sessionID: "child-session",
            },
          ),
        Error,
        "root_session_id",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("does not consume leaked global runtime validators when none are scoped to the runtime", async () => {
    const manager = new SessionManager(
      "group-runtime-isolation",
      "user-runtime-isolation",
      {
        session: {
          get() {
            throw new Error("unexpected session lookup");
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    manager.setParentId("root-session", null);
    manager.setParentId("child-session", "root-session");

    const runtime = createSessionMcpRuntime();

    try {
      const serialized = await runtime.tools.session_stats.execute(
        {},
        toolContext,
      );
      const parsed = JSON.parse(serialized);

      assertEquals(parsed.status, "ok");
    } finally {
      await runtime.dispose();
    }
  });

  it("enforces root validation only after an explicit canonicalizer is wired", async () => {
    const manager = new SessionManager(
      "group-runtime-explicit",
      "user-runtime-explicit",
      {
        session: {
          get() {
            throw new Error("unexpected session lookup");
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    manager.setParentId("root-session", null);
    manager.setParentId("child-session", "root-session");

    const runtime = createSessionMcpRuntime();

    try {
      const uncheckedSerialized = await runtime.tools.session_stats.execute(
        {},
        {
          ...toolContext,
          sessionID: "child-session",
        },
      );
      assertEquals(JSON.parse(uncheckedSerialized).status, "ok");

      runtime.setSessionCanonicalizer(manager);

      await assertRejects(
        () =>
          runtime.tools.session_stats.execute(
            { root_session_id: "wrong-root" },
            {
              ...toolContext,
              sessionID: "child-session",
            },
          ),
        Error,
        "root_session_id",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("reports live redis health in session_doctor when a redis client is provided", async () => {
    const degradedRedis = new RedisClient({ endpoint: "redis://unused" });
    const degradedRuntime = createSessionMcpRuntime({
      redisClient: degradedRedis,
      sessionTtlSeconds: 60,
    });
    const connectedRedis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () => new DoctorRedisRuntime(),
    });
    const connectedRuntime = createSessionMcpRuntime({
      redisClient: connectedRedis,
      sessionTtlSeconds: 60,
    });

    try {
      const degradedSerialized = await degradedRuntime.tools.session_doctor
        .execute(
          validRequests.session_doctor,
          toolContext,
        );
      const degraded = JSON.parse(degradedSerialized);

      assertEquals(degraded.runtime.status, "ok");
      assertEquals(degraded.redis.status, "degraded");

      await connectedRedis.connect();

      const connectedSerialized = await connectedRuntime.tools.session_doctor
        .execute(
          validRequests.session_doctor,
          toolContext,
        );
      const connected = JSON.parse(connectedSerialized);

      assertEquals(connected.runtime.status, "ok");
      assertEquals(connected.redis.status, "ok");
      assertEquals(connected.graphiti_cache.status, "not_checked");
    } finally {
      await degradedRuntime.dispose();
      await degradedRedis.close();
      await connectedRuntime.dispose();
      await connectedRedis.close();
    }
  });

  it("reports local graphiti cache health in session_doctor", async () => {
    const disconnectedRedis = new RedisClient({ endpoint: "redis://unused" });
    const connectedRedis = new RedisClient({
      endpoint: "redis://unused",
      runtimeFactory: () => new DoctorRedisRuntime(),
    });

    const noCacheRuntime = createSessionMcpRuntime();
    const degradedCacheRuntime = createSessionMcpRuntime({
      redisClient: disconnectedRedis,
      sessionTtlSeconds: 60,
      graphitiCache: {},
    });
    const connectedCacheRuntime = createSessionMcpRuntime({
      redisClient: connectedRedis,
      sessionTtlSeconds: 60,
      graphitiCache: {},
    });

    try {
      const noCache = JSON.parse(
        await noCacheRuntime.tools.session_doctor.execute(
          validRequests.session_doctor,
          toolContext,
        ),
      );
      assertEquals(noCache.graphiti_cache.status, "not_checked");

      const degradedCache = JSON.parse(
        await degradedCacheRuntime.tools.session_doctor.execute(
          validRequests.session_doctor,
          toolContext,
        ),
      );
      assertEquals(degradedCache.graphiti_cache.status, "degraded");

      await connectedRedis.connect();

      const connectedCache = JSON.parse(
        await connectedCacheRuntime.tools.session_doctor.execute(
          validRequests.session_doctor,
          toolContext,
        ),
      );
      assertEquals(connectedCache.graphiti_cache.status, "ok");
    } finally {
      await noCacheRuntime.dispose();
      await degradedCacheRuntime.dispose();
      await connectedCacheRuntime.dispose();
      await disconnectedRedis.close();
      await connectedRedis.close();
    }
  });

  it("returns schema-valid bounded doctor output after local stats wiring is active", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-doctor-bounded",
      handlers: {
        session_execute: () =>
          Promise.resolve({
            status: "ok",
            summary: "z".repeat(SESSION_MCP_RESPONSE_BUDGET_BYTES + 2_048),
            exit_code: 0,
            timed_out: false,
            truncated: false,
            bytes_captured: SESSION_MCP_RESPONSE_BUDGET_BYTES + 2_048,
          }),
      },
    } as never);

    try {
      await runtime.tools.session_execute.execute(
        validRequests.session_execute,
        toolContext,
      );
      const serialized = await runtime.tools.session_doctor.execute(
        validRequests.session_doctor,
        toolContext,
      );
      const parsed = JSON.parse(serialized);

      assertEquals(
        sessionMcpResponseSchemas.session_doctor.safeParse(parsed).success,
        true,
      );
      assert(
        textEncoder.encode(serialized).byteLength <=
          SESSION_MCP_RESPONSE_BUDGET_BYTES,
      );
      assertEquals(parsed.status, "ok");
      assertEquals(parsed.runtime.status, "ok");
    } finally {
      await runtime.dispose();
    }
  });

  it("reads live local counters through session_stats for every session_* call family", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response("runtime fetched body", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      );
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-live-stats",
    } as never);

    try {
      const rootContext = createRootToolContext("root-123");
      await runtime.tools.session_execute.execute(
        validRequests.session_execute,
        rootContext,
      );
      await runtime.tools.session_execute_file.execute(
        validRequests.session_execute_file,
        rootContext,
      ).catch(() => undefined);
      await runtime.tools.session_batch_execute.execute(
        validRequests.session_batch_execute,
        rootContext,
      );
      await runtime.tools.session_index.execute(
        validRequests.session_index,
        rootContext,
      );
      await runtime.tools.session_search.execute(
        validRequests.session_search,
        rootContext,
      );
      await runtime.tools.session_fetch_and_index.execute(
        validRequests.session_fetch_and_index,
        rootContext,
      );
      const statsSerialized = await runtime.tools.session_stats.execute(
        validRequests.session_stats,
        rootContext,
      );
      const stats = JSON.parse(statsSerialized);

      assertEquals(stats.status, "ok");
      assertEquals(stats.counters.session_execute_calls_total >= 1, true);
      assertEquals(stats.counters.session_execute_file_calls_total >= 1, true);
      assertEquals(stats.counters.session_batch_execute_calls_total >= 1, true);
      assertEquals(stats.counters.session_index_calls_total >= 1, true);
      assertEquals(stats.counters.session_search_calls_total >= 1, true);
      assertEquals(
        stats.counters.session_fetch_and_index_calls_total >= 1,
        true,
      );
      assertEquals(stats.counters.session_stats_calls_total >= 1, true);
      assertEquals(stats.counters.bytes_returned_total > 0, true);
      assertEquals(stats.counters.bytes_indexed_total > 0, true);
      assertEquals(stats.counters.bytes_saved_estimate > 0, true);
      assertEquals(stats.artifact_count >= 1, true);
      assertEquals(stats.corpus_count >= 2, true);
    } finally {
      globalThis.fetch = originalFetch;
      await runtime.dispose();
    }
  });

  it("does not duplicate full artifact bodies when an inline payload already provides the canonical stored body", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const hiddenPayload = "FULL CANONICAL PAYLOAD\n" +
      "canonical marker\n".repeat(200);
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-no-dup-artifacts",
      handlers: {
        session_execute: () =>
          Promise.resolve({
            status: "ok",
            summary: "Visible bounded summary only.",
            artifact_ref: `inline://payload/${
              encodeURIComponent(hiddenPayload)
            }`,
            exit_code: 0,
            timed_out: false,
            truncated: false,
            bytes_captured: hiddenPayload.length,
          }),
      },
    } as never);

    try {
      const executeSerialized = await runtime.tools.session_execute.execute(
        validRequests.session_execute,
        createRootToolContext("root-123"),
      );
      const execute = JSON.parse(executeSerialized);
      const artifactKeys = await redis.keysByPrefix(
        "session:group-no-dup-artifacts:root-123:artifact:",
      );
      const artifactBodies = artifactKeys.filter((key) =>
        key.endsWith(":body")
      );

      assertExists(execute.artifact_ref);
      assertEquals(artifactBodies.length, 1);
    } finally {
      await runtime.dispose();
    }
  });

  it("records corpus-backed artifact stats when the executor already returned a non-inline artifact_ref", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const hiddenPayload = "PRE-STORED EXECUTOR PAYLOAD\n" +
      "pre-stored marker\n".repeat(160);
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-prestored-artifact",
      handlers: {
        session_execute: () =>
          Promise.resolve({
            status: "ok",
            summary: hiddenPayload,
            artifact_ref: "local://session_execute/pre-existing",
            exit_code: 0,
            timed_out: false,
            truncated: false,
            bytes_captured: hiddenPayload.length,
          }),
      },
    } as never);

    try {
      const executeSerialized = await runtime.tools.session_execute.execute(
        validRequests.session_execute,
        createRootToolContext("root-123"),
      );
      const execute = JSON.parse(executeSerialized);
      const statsSerialized = await runtime.tools.session_stats.execute(
        validRequests.session_stats,
        createRootToolContext("root-123"),
      );
      const stats = JSON.parse(statsSerialized);
      const artifactKeys = await redis.keysByPrefix(
        "session:group-prestored-artifact:root-123:artifact:",
      );
      const artifactBodies = artifactKeys.filter((key) =>
        key.endsWith(":body")
      );

      assertEquals(execute.artifact_ref.length > 0, true);
      assertEquals(stats.counters.bytes_saved_estimate > 0, true);
      assertEquals(stats.artifact_count >= 1, true);
      assertEquals(artifactBodies.length, 1);
    } finally {
      await runtime.dispose();
    }
  });

  it("caps serialized responses to the exact 32 KB budget", async () => {
    const runtime = createSessionMcpRuntime();

    try {
      for (const toolName of SESSION_MCP_TOOL_NAMES) {
        const serialized = await runtime.tools[toolName].execute(
          validRequests[toolName],
          toolContext,
        );

        assert(
          textEncoder.encode(serialized).byteLength <=
            SESSION_MCP_RESPONSE_BUDGET_BYTES,
          `${toolName} exceeded response budget`,
        );
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("falls back to a local artifact reference when inline output crosses 32 KB", async () => {
    const runtime = createSessionMcpRuntime({
      handlers: {
        session_execute: () =>
          Promise.resolve({
            status: "ok",
            summary: "x".repeat(SESSION_MCP_RESPONSE_BUDGET_BYTES + 1_024),
            exit_code: 0,
            timed_out: false,
            truncated: false,
            bytes_captured: SESSION_MCP_RESPONSE_BUDGET_BYTES + 1_024,
          }),
      },
    });

    try {
      const serialized = await runtime.tools.session_execute.execute(
        validRequests.session_execute,
        createRootToolContext("root-123"),
      );
      const parsed = JSON.parse(serialized);

      assert(
        textEncoder.encode(serialized).byteLength <=
          SESSION_MCP_RESPONSE_BUDGET_BYTES,
      );
      assertExists(parsed.artifact_ref);
      assertEquals(
        parsed.artifact_ref.startsWith("local://session_execute/"),
        true,
      );
      assert(parsed.summary.length < SESSION_MCP_RESPONSE_BUDGET_BYTES);
    } finally {
      await runtime.dispose();
    }
  });

  it("executes sequential command groups in request order", async () => {
    const executionOrder: string[] = [];
    const runtime = createSessionMcpRuntime({
      handlers: {
        session_execute: (request: { command: string }) => {
          executionOrder.push(request.command);
          return Promise.resolve({
            status: "ok",
            summary: `executed ${request.command}`,
            exit_code: executionOrder.length - 1,
            timed_out: false,
            truncated: false,
            bytes_captured: request.command.length,
          });
        },
      },
    });

    try {
      const serialized = await runtime.tools.session_batch_execute.execute(
        {
          commands: [
            { command: "first" },
            { command: "second" },
            { command: "third" },
          ],
        },
        createRootToolContext("root-123"),
      );
      const parsed = JSON.parse(serialized);

      assertEquals(executionOrder, ["first", "second", "third"]);
      assertEquals(
        parsed.results.map((item: { result: { summary: string } }) =>
          item.result.summary
        ),
        [
          "executed first",
          "executed second",
          "executed third",
        ],
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("indexes local content and serves session_search from the local corpus", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
    } as never);

    try {
      await runtime.tools.session_index.execute(
        {
          content:
            "# Redis Session TTLs\n\nSession TTL refreshes the local session corpus.",
        },
        createRootToolContext("root-123"),
      );
      const serialized = await runtime.tools.session_search.execute(
        {
          query: "session ttl",
        },
        createRootToolContext("root-123"),
      );
      const parsed = JSON.parse(serialized);

      assertEquals(parsed.status, "ok");
      assertEquals(parsed.results.length > 0, true);
      assertEquals(parsed.results[0].snippet.includes("Session TTL"), true);
    } finally {
      await runtime.dispose();
    }
  });

  it("stores oversized session_execute output in the local corpus so it becomes searchable", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      handlers: {
        session_execute: () =>
          Promise.resolve({
            status: "ok",
            summary: "SESSION TTL REPORT\n" +
              "session ttl keeps local corpus search warm\n".repeat(900),
            exit_code: 0,
            timed_out: false,
            truncated: false,
            bytes_captured: SESSION_MCP_RESPONSE_BUDGET_BYTES + 8_192,
          }),
      },
    } as never);

    try {
      const executeSerialized = await runtime.tools.session_execute.execute(
        validRequests.session_execute,
        createRootToolContext("root-123"),
      );
      const searchSerialized = await runtime.tools.session_search.execute(
        {
          query: "session ttl",
        },
        createRootToolContext("root-123"),
      );
      const executed = JSON.parse(executeSerialized);
      const search = JSON.parse(searchSerialized);

      assertExists(executed.artifact_ref);
      assertEquals(search.results.length > 0, true);
      assertEquals(search.results[0].snippet.includes("session ttl"), true);
    } finally {
      await runtime.dispose();
    }
  });

  it("stores the full hidden payload for oversized session_execute overflow, not only the visible summary", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const hiddenPayload = "FULL SESSION PAYLOAD\n" +
      "full payload marker\n".repeat(400);
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-full-artifact",
      handlers: {
        session_execute: () =>
          Promise.resolve({
            status: "ok",
            summary: "Visible bounded summary only.",
            artifact_ref: `inline://payload/${
              encodeURIComponent(hiddenPayload)
            }`,
            exit_code: 0,
            timed_out: false,
            truncated: false,
            bytes_captured: SESSION_MCP_RESPONSE_BUDGET_BYTES + 4_096,
          }),
      },
    } as never);

    try {
      const serialized = await runtime.tools.session_execute.execute(
        validRequests.session_execute,
        createRootToolContext("root-123"),
      );
      const parsed = JSON.parse(serialized);
      const artifactId = String(parsed.artifact_ref).split("/").at(-1) ?? "";
      const storedBody = await redis.getString(
        `session:group-full-artifact:root-123:artifact:${artifactId}:body`,
      );

      assertEquals(parsed.summary, "Visible bounded summary only.");
      assertEquals(storedBody, hiddenPayload);
    } finally {
      await runtime.dispose();
    }
  });

  it("persists hidden large session_execute output even when the visible response is already bounded", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const hiddenPayload = "HIDDEN LARGE PAYLOAD\n" +
      "searchable hidden marker\n".repeat(300);
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-hidden-artifact",
      handlers: {
        session_execute: () =>
          Promise.resolve({
            status: "ok",
            summary: "Visible summary stays within budget.",
            artifact_ref: `inline://payload/${
              encodeURIComponent(hiddenPayload)
            }`,
            exit_code: 0,
            timed_out: false,
            truncated: false,
            bytes_captured: hiddenPayload.length,
          }),
      },
    } as never);

    try {
      const executeSerialized = await runtime.tools.session_execute.execute(
        validRequests.session_execute,
        createRootToolContext("root-123"),
      );
      const execute = JSON.parse(executeSerialized);
      const searchSerialized = await runtime.tools.session_search.execute(
        {
          query: "searchable hidden marker",
        },
        createRootToolContext("root-123"),
      );
      const search = JSON.parse(searchSerialized);

      assertEquals(execute.summary, "Visible summary stays within budget.");
      assertExists(execute.artifact_ref);
      assertEquals(search.results.length > 0, true);
      assertStringIncludes(
        search.results[0].snippet,
        "searchable hidden marker",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("uses the production-style redis runtime path for session_index and session_search", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 90,
      groupId: "group-runtime",
    } as never);

    try {
      const indexedSerialized = await runtime.tools.session_index.execute(
        {
          content:
            "# Runtime Search\n\nSession TTL remains available through the live corpus.",
        },
        createRootToolContext("root-runtime"),
      );
      const searchSerialized = await runtime.tools.session_search.execute(
        {
          query: "session ttl",
        },
        createRootToolContext("root-runtime"),
      );

      const indexed = JSON.parse(indexedSerialized);
      const search = JSON.parse(searchSerialized);

      assertEquals(
        indexed.corpus_ref,
        "session:group-runtime:root-runtime:corpus:corpus-1:meta",
      );
      assertEquals(search.refs, [indexed.corpus_ref]);
      assertEquals(search.results.length > 0, true);
    } finally {
      await runtime.dispose();
    }
  });

  it("indexes a local file via path-based indexing and makes it searchable", async () => {
    const worktreeDir = Deno.cwd();
    const localFile = `${worktreeDir}/src/services/session-mcp-runtime.ts`;
    const askCalls: Array<{
      permission: string;
      patterns: string[];
      always: string[];
      metadata: Record<string, unknown>;
    }> = [];
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-path-index",
      readSessionIndexFile: () =>
        Promise.resolve(
          "Index local content for the current root session.",
        ),
    } as never);

    try {
      await runtime.tools.session_index.execute(
        {
          path: localFile,
        },
        createToolContext({
          sessionID: "root-path-index",
          worktree: worktreeDir,
          directory: worktreeDir,
          ask: (input) => {
            askCalls.push(input);
            return Promise.resolve();
          },
        }),
      );

      const searchSerialized = await runtime.tools.session_search.execute(
        {
          query: "Index local content for the current root session",
        },
        createToolContext({
          sessionID: "root-path-index",
          worktree: worktreeDir,
          directory: worktreeDir,
        }),
      );
      const search = JSON.parse(searchSerialized);

      assertEquals(search.status, "ok");
      assertEquals(search.results.length > 0, true);
      assertStringIncludes(
        search.results[0].snippet,
        "Index local content",
      );
      assertEquals(askCalls, [{
        permission: "read",
        patterns: [localFile],
        always: ["*"],
        metadata: {},
      }]);
    } finally {
      await runtime.dispose();
    }
  });

  it("indexes an external file after requesting external_directory and read permissions", async () => {
    const worktreeDir = Deno.cwd();
    const externalFile =
      "/Users/vicary/Documents/Projects/vicary/opencode/AGENTS.md";
    const externalParentDir =
      "/Users/vicary/Documents/Projects/vicary/opencode";
    const askCalls: Array<{
      permission: string;
      patterns: string[];
      always: string[];
      metadata: Record<string, unknown>;
    }> = [];
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-path-index-external",
      readSessionIndexFile: () =>
        Promise.resolve("Graphiti is never on the hot path."),
    } as never);

    try {
      await runtime.tools.session_index.execute(
        {
          path: externalFile,
        },
        createToolContext({
          sessionID: "root-path-index-external",
          worktree: worktreeDir,
          directory: worktreeDir,
          ask: (input) => {
            askCalls.push(input);
            return Promise.resolve();
          },
        }),
      );

      const searchSerialized = await runtime.tools.session_search.execute(
        {
          query: "Graphiti is never on the hot path",
        },
        createToolContext({
          sessionID: "root-path-index-external",
          worktree: worktreeDir,
          directory: worktreeDir,
        }),
      );
      const search = JSON.parse(searchSerialized);

      assertEquals(search.status, "ok");
      assertEquals(search.results.length > 0, true);
      assertStringIncludes(
        search.results[0].snippet,
        "Graphiti is never on the hot path",
      );
      assertEquals(askCalls.length, 2);
      assertEquals(askCalls[0], {
        permission: "external_directory",
        patterns: [`${externalParentDir}/*`],
        always: [`${externalParentDir}/*`],
        metadata: {
          filepath: externalFile,
          parentDir: externalParentDir,
        },
      });
      assertEquals(askCalls[1], {
        permission: "read",
        patterns: [externalFile],
        always: ["*"],
        metadata: {},
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("returns a stable bounded error when session_index cannot read the requested path", async () => {
    const runtime = createSessionMcpRuntime({
      readSessionIndexFile: () =>
        Promise.reject(new Error("EACCES: secret detail")),
    } as never);

    try {
      const error = await assertRejects(
        () =>
          runtime.tools.session_index.execute(
            {
              path: "README.md",
            },
            createRootToolContext("root-path-error"),
          ),
      ) as Error & { code?: string; bounded?: boolean };

      assertEquals(
        error.message,
        "session_index could not read the requested path.",
      );
      assertEquals(error.code, "session_index_path_unreadable");
      assertEquals(error.bounded, true);
    } finally {
      await runtime.dispose();
    }
  });

  it("replaces prior indexed content when session_index repeats the same source and label", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-runtime-replacement",
    } as never);

    try {
      await runtime.tools.session_index.execute(
        {
          content: "old alpha body",
          source: "build-log",
          label: "latest",
        },
        createRootToolContext("root-runtime-replacement"),
      );
      await runtime.tools.session_index.execute(
        {
          content: "new beta body",
          source: "build-log",
          label: "latest",
        },
        createRootToolContext("root-runtime-replacement"),
      );

      const oldSearch = JSON.parse(
        await runtime.tools.session_search.execute(
          {
            query: "alpha",
          },
          createRootToolContext("root-runtime-replacement"),
        ),
      );
      const newSearch = JSON.parse(
        await runtime.tools.session_search.execute(
          {
            query: "beta",
          },
          createRootToolContext("root-runtime-replacement"),
        ),
      );

      assertEquals(oldSearch.results.length, 0);
      assertEquals(newSearch.results.length > 0, true);
      assertStringIncludes(newSearch.results[0].snippet, "beta");
    } finally {
      await runtime.dispose();
    }
  });

  it("stores oversized sequential command output behind bounded artifact refs instead of overflowing the response budget", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-batch",
      handlers: {
        session_execute: (request: { command: string }) =>
          Promise.resolve({
            status: "ok",
            summary: `${request.command}: ` + "x".repeat(18_000),
            exit_code: 0,
            timed_out: false,
            truncated: false,
            bytes_captured: 18_010,
          }),
      },
    } as never);

    try {
      const serialized = await runtime.tools.session_batch_execute.execute(
        {
          commands: [
            { command: "first" },
            { command: "second" },
          ],
        },
        createRootToolContext("root-batch"),
      );
      const parsed = JSON.parse(serialized);

      assert(
        textEncoder.encode(serialized).byteLength <=
          SESSION_MCP_RESPONSE_BUDGET_BYTES,
      );
      assertEquals(parsed.truncated, true);
      assertEquals(parsed.results.length, 2);
      assertEquals(parsed.results[0].kind, "command");
      assertEquals(parsed.results[1].kind, "command");
      assertExists(parsed.results[0].result.artifact_ref);
      assertExists(parsed.results[1].result.artifact_ref);
      assertEquals(
        parsed.results[0].result.artifact_ref.startsWith(
          "local://session_execute/",
        ),
        true,
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("executes mixed batch steps in order and preserves typed per-step results", async () => {
    const executionOrder: string[] = [];
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      handlers: {
        session_execute: (request: { command: string }) => {
          executionOrder.push(`command:${request.command}`);
          return Promise.resolve({
            status: "ok",
            summary: `executed ${request.command}`,
            exit_code: 0,
            timed_out: false,
            truncated: false,
            bytes_captured: request.command.length,
          });
        },
      },
    } as never);

    try {
      await runtime.tools.session_index.execute(
        {
          content: "session continuity is preserved in the local corpus",
        },
        createRootToolContext("root-mixed-order"),
      );

      const serialized = await runtime.tools.session_batch_execute.execute(
        {
          steps: [
            { kind: "command", command: "first" },
            { kind: "search", query: "session continuity" },
            { kind: "command", command: "third" },
          ],
        },
        createRootToolContext("root-mixed-order"),
      );
      const parsed = JSON.parse(serialized);

      assertEquals(executionOrder, ["command:first", "command:third"]);
      assertEquals(parsed.summary, "Completed 3 step(s).");
      assertEquals(parsed.results.map((item: { kind: string }) => item.kind), [
        "command",
        "search",
        "command",
      ]);
      assertEquals(parsed.results[0].result.summary, "executed first");
      assertEquals(parsed.results[1].result.results.length > 0, true);
      assertStringIncludes(
        parsed.results[1].result.results[0].snippet,
        "session continuity",
      );
      assertEquals(parsed.results[2].result.summary, "executed third");
    } finally {
      await runtime.dispose();
    }
  });

  it("uses the local corpus for a mixed batch search step", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
    } as never);

    try {
      await runtime.tools.session_index.execute(
        {
          content: "local corpus search should find this indexed sentence",
        },
        createRootToolContext("root-search-step"),
      );

      const serialized = await runtime.tools.session_batch_execute.execute(
        {
          steps: [{ kind: "search", query: "indexed sentence" }],
        },
        createRootToolContext("root-search-step"),
      );
      const parsed = JSON.parse(serialized);

      assertEquals(parsed.results[0].kind, "search");
      assertEquals(parsed.results[0].result.status, "ok");
      assertEquals(parsed.results[0].result.results.length > 0, true);
      assertStringIncludes(
        parsed.results[0].result.results[0].snippet,
        "indexed sentence",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps oversized mixed batch command steps safely spilled to artifacts", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      handlers: {
        session_execute: (request: { command: string }) =>
          Promise.resolve({
            status: "ok",
            summary: `${request.command}: ` + "x".repeat(18_000),
            exit_code: 0,
            timed_out: false,
            truncated: false,
            bytes_captured: 18_010,
          }),
      },
    } as never);

    try {
      await runtime.tools.session_index.execute(
        {
          content: "spill search term remains locally searchable",
        },
        createRootToolContext("root-mixed-spill"),
      );

      const serialized = await runtime.tools.session_batch_execute.execute(
        {
          steps: [
            { kind: "command", command: "first" },
            { kind: "search", query: "spill search term" },
            { kind: "command", command: "second" },
          ],
        },
        createRootToolContext("root-mixed-spill"),
      );
      const parsed = JSON.parse(serialized);

      assert(
        textEncoder.encode(serialized).byteLength <=
          SESSION_MCP_RESPONSE_BUDGET_BYTES,
      );
      assertEquals(parsed.truncated, true);
      assertEquals(parsed.results[0].kind, "command");
      assertEquals(parsed.results[1].kind, "search");
      assertEquals(parsed.results[2].kind, "command");
      assertExists(parsed.results[0].result.artifact_ref);
      assertExists(parsed.results[2].result.artifact_ref);
      assertEquals(
        parsed.results[0].result.artifact_ref.startsWith(
          "local://session_execute/",
        ),
        true,
      );
      assertEquals(parsed.results[1].result.results.length > 0, true);
    } finally {
      await runtime.dispose();
    }
  });

  it("uses group-scoped stub refs when redis-backed corpus storage is unavailable", async () => {
    const runtime = createSessionMcpRuntime({
      groupId: "group-stub",
    });

    try {
      const indexedSerialized = await runtime.tools.session_index.execute(
        {
          content: "stub body",
        },
        createRootToolContext("root-stub"),
      );
      const fetchSerialized = await runtime.tools.session_fetch_and_index
        .execute(
          {
            url: "https://example.com",
          },
          createRootToolContext("root-stub"),
        );

      const indexed = JSON.parse(indexedSerialized);
      const fetched = JSON.parse(fetchSerialized);

      assertEquals(
        indexed.corpus_ref,
        "session:group-stub:root-stub:corpus:stub-index:meta",
      );
      assertEquals(
        fetched.corpus_ref,
        "session:group-stub:root-stub:corpus:stub-fetch:meta",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("serializes a schema-valid error response for non-ok fetches", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response("missing", {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      );

    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-runtime-fetch-error",
    } as never);

    try {
      const serialized = await runtime.tools.session_fetch_and_index.execute(
        {
          url: "https://example.com/missing",
        },
        createRootToolContext("root-runtime-fetch-error"),
      );
      const parsed = JSON.parse(serialized);

      assertEquals(
        sessionMcpResponseSchemas.session_fetch_and_index.safeParse(parsed)
          .success,
        true,
      );
      assertEquals(parsed.status, "error");
      assertEquals(parsed.corpus_ref.length > 0, true);
      assertStringIncludes(parsed.summary, "HTTP 404");
      assertEquals(parsed.excerpt, "");
      assertEquals(parsed.query_hints, []);
      assertEquals(parsed.fetched_url, "https://example.com/missing");
      assertEquals(parsed.content_type, "text/plain");
      assertEquals(parsed.truncated, false);
    } finally {
      globalThis.fetch = originalFetch;
      await runtime.dispose();
    }
  });

  it("serializes a non-empty excerpt for successful fetches", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          "# Redis Session TTLs\n\nSession TTL protects local corpus state.",
          {
            headers: { "content-type": "text/markdown; charset=utf-8" },
          },
        ),
      );

    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-runtime-fetch-success",
    } as never);

    try {
      const serialized = await runtime.tools.session_fetch_and_index.execute(
        {
          url: "https://example.com/doc",
        },
        createRootToolContext("root-runtime-fetch-success"),
      );
      const parsed = JSON.parse(serialized);

      assertEquals(parsed.status, "ok");
      assertEquals(parsed.excerpt.length > 0, true);
      assertStringIncludes(parsed.excerpt, "Session TTL");
    } finally {
      globalThis.fetch = originalFetch;
      await runtime.dispose();
    }
  });

  it("reopens fetched content via exact corpus_ref and falls back for malformed refs", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          "# Redis Session TTLs\n\nSession TTL protects local corpus state.",
          {
            headers: { "content-type": "text/markdown; charset=utf-8" },
          },
        ),
      );

    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-runtime-fetch-ref",
    } as never);

    try {
      const fetchSerialized = await runtime.tools.session_fetch_and_index
        .execute(
          {
            url: "https://example.com/doc",
          },
          createRootToolContext("root-runtime-fetch-ref"),
        );
      await runtime.tools.session_index.execute(
        {
          content: "# TTL Operations\n\nSession TTL debugging checklist.",
        },
        createRootToolContext("root-runtime-fetch-ref"),
      );
      const fetched = JSON.parse(fetchSerialized);

      const exactSerialized = await runtime.tools.session_search.execute(
        { query: fetched.corpus_ref },
        createRootToolContext("root-runtime-fetch-ref"),
      );
      const malformedSerialized = await runtime.tools.session_search.execute(
        { query: `${fetched.corpus_ref}-partial session ttl` },
        createRootToolContext("root-runtime-fetch-ref"),
      );
      const exact = JSON.parse(exactSerialized);
      const malformed = JSON.parse(malformedSerialized);

      assertEquals(exact.refs, [fetched.corpus_ref]);
      assertEquals(exact.results.length, 1);
      assertStringIncludes(exact.results[0].snippet, fetched.excerpt);
      assertEquals(exact.results[0].type, "entry");
      assertEquals(exact.results[0].ref, fetched.corpus_ref);
      assertEquals(exact.results[0].root_session_id, "root-runtime-fetch-ref");
      assertEquals(exact.results[0].scope, "local");
      assert(exact.results[0].created_at !== "1970-01-01T00:00:00.000Z");
      assertEquals(exact.results[0].updated_at, exact.results[0].created_at);
      assertEquals(exact.results[0].source, "fetch");
      assertEquals(malformed.results.length > 0, true);
      assertEquals(malformed.refs.includes(fetched.corpus_ref), true);
    } finally {
      globalThis.fetch = originalFetch;
      await runtime.dispose();
    }
  });

  it("returns full collapsed plain text for exact fetched corpus_ref recall", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          `<article><p>${"alpha  \n\n beta\t".repeat(80)}omega</p></article>`,
          {
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
      );

    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-runtime-fetch-full",
    } as never);

    try {
      const fetchSerialized = await runtime.tools.session_fetch_and_index
        .execute(
          {
            url: "https://example.com/full-doc",
          },
          createRootToolContext("root-runtime-fetch-full"),
        );
      const fetched = JSON.parse(fetchSerialized);
      const exactSerialized = await runtime.tools.session_search.execute(
        { query: fetched.corpus_ref },
        createRootToolContext("root-runtime-fetch-full"),
      );
      const exact = JSON.parse(exactSerialized);

      assertEquals(/\s{2,}/.test(fetched.excerpt), false);
      assertEquals(/\s{2,}/.test(exact.results[0].snippet), false);
      assertStringIncludes(exact.results[0].snippet, "omega");
      assertEquals(
        exact.results[0].snippet.length > fetched.excerpt.length,
        true,
      );
    } finally {
      globalThis.fetch = originalFetch;
      await runtime.dispose();
    }
  });

  it("reopens migrated fetched content via a pre-migration exact corpus_ref", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          "# Redis Session TTLs\n\nSession TTL protects local corpus state.",
          {
            headers: { "content-type": "text/markdown; charset=utf-8" },
          },
        ),
      );

    const runtime = createSessionMcpRuntime({
      redisClient: redis,
      sessionTtlSeconds: 60,
      groupId: "group-runtime-migrated-fetch-ref",
    } as never);

    try {
      await runtime.tools.session_index.execute(
        {
          content:
            "# Parent Corpus\n\nCanonical parent content remains searchable.",
        },
        createRootToolContext("parent-root"),
      );
      const fetchSerialized = await runtime.tools.session_fetch_and_index
        .execute(
          {
            url: "https://example.com/doc",
          },
          createRootToolContext("child-root"),
        );
      const fetched = JSON.parse(fetchSerialized);

      await runtime.migrateRootSessionState("child-root", "parent-root");

      const exactSerialized = await runtime.tools.session_search.execute(
        { query: fetched.corpus_ref },
        createRootToolContext("parent-root"),
      );
      const exact = JSON.parse(exactSerialized);

      assertEquals(exact.results.length, 1);
      assertStringIncludes(exact.results[0].snippet, fetched.excerpt);
      assertEquals(
        exact.results[0].ref,
        "session:group-runtime-migrated-fetch-ref:parent-root:corpus:corpus-2:meta",
      );
      assertEquals(exact.refs, [
        "session:group-runtime-migrated-fetch-ref:parent-root:corpus:corpus-2:meta",
      ]);
      assertEquals(exact.results[0].root_session_id, "parent-root");
    } finally {
      globalThis.fetch = originalFetch;
      await runtime.dispose();
    }
  });

  it("disposes redis-backed corpus resources exactly once during runtime teardown", async () => {
    let disposeCalls = 0;
    const runtime = createSessionMcpRuntime({
      redisClient: new RedisClient({ endpoint: "redis://unused" }),
      sessionTtlSeconds: 60,
      createSessionCorpusService: () => ({
        index: () =>
          Promise.resolve({
            status: "ok",
            corpusRef: "ref",
            chunkCount: 0,
            queryHints: [],
          }),
        search: () =>
          Promise.resolve({
            status: "ok",
            results: [],
            corpusRefs: [],
            truncated: false,
          }),
        fetchAndIndex: () =>
          Promise.resolve({
            status: "ok",
            corpusRef: "ref",
            summary: "ok",
            excerpt: "ok",
            queryHints: [],
            fetchedUrl: "url",
            contentType: "text/plain",
            truncated: false,
          }),
        getStats: () =>
          Promise.resolve({
            counters: {},
            corpusCount: 0,
            artifactCount: 0,
            bytesSavedEstimate: 0,
          }),
        storeArtifact: () =>
          Promise.resolve({
            status: "ok",
            artifactRef: "local://session_execute/1",
            corpusRef: "ref",
            summary: "ok",
          }),
        migrateRootSessionState: () => Promise.resolve(),
        dispose: () => {
          disposeCalls += 1;
          return Promise.resolve();
        },
      }),
    } as never);

    await runtime.dispose();
    await runtime.dispose();

    assertEquals(disposeCalls, 1);
  });

  it("migrates notes alongside corpus state when canonical roots change", async () => {
    const migratedCorpusRoots: Array<[string, string]> = [];
    const migratedNoteRoots: Array<[string, string]> = [];

    const runtime = createSessionMcpRuntime({
      redisClient: new RedisClient({ endpoint: "redis://unused" }),
      sessionTtlSeconds: 60,
      createSessionCorpusService: () => ({
        index: () =>
          Promise.resolve({
            status: "ok",
            corpusRef: "ref",
            chunkCount: 0,
            queryHints: [],
          }),
        search: () =>
          Promise.resolve({
            status: "ok",
            results: [],
            corpusRefs: [],
            truncated: false,
          }),
        fetchAndIndex: () =>
          Promise.resolve({
            status: "ok",
            corpusRef: "ref",
            summary: "ok",
            excerpt: "ok",
            queryHints: [],
            fetchedUrl: "url",
            contentType: "text/plain",
            truncated: false,
          }),
        getStats: () =>
          Promise.resolve({
            counters: {},
            corpusCount: 0,
            artifactCount: 0,
            bytesSavedEstimate: 0,
          }),
        storeArtifact: () =>
          Promise.resolve({
            status: "ok",
            artifactRef: "local://session_execute/1",
            corpusRef: "ref",
            summary: "ok",
          }),
        migrateRootSessionState: (
          sourceRootSessionId: string,
          targetRootSessionId: string,
        ) => {
          migratedCorpusRoots.push([sourceRootSessionId, targetRootSessionId]);
          return Promise.resolve();
        },
        dispose: () => Promise.resolve(),
      }),
      notesService: {
        migrateRootSessionState: (
          sourceRootSessionId: string,
          targetRootSessionId: string,
        ) => {
          migratedNoteRoots.push([sourceRootSessionId, targetRootSessionId]);
          return Promise.resolve();
        },
      } as never,
    } as never);

    await runtime.migrateRootSessionState("temp-root", "canonical-root");

    assertEquals(migratedCorpusRoots, [["temp-root", "canonical-root"]]);
    assertEquals(migratedNoteRoots, [["temp-root", "canonical-root"]]);
  });
});
