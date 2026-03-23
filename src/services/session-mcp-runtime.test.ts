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

type RedisEvent = "close" | "end" | "error" | "ready";

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

const validRequests: Record<SessionMcpToolName, Record<string, unknown>> = {
  session_execute: {
    root_session_id: "root-123",
    command: "pwd",
  },
  session_execute_file: {
    root_session_id: "root-123",
    paths: ["README.md"],
  },
  session_batch_execute: {
    root_session_id: "root-123",
    commands: [{ command: "first" }, { command: "second" }],
  },
  session_index: {
    root_session_id: "root-123",
    content: "hello world",
  },
  session_search: {
    root_session_id: "root-123",
    query: "hello",
  },
  session_fetch_and_index: {
    root_session_id: "root-123",
    url: "https://example.com",
  },
  session_stats: {
    root_session_id: "root-123",
  },
  session_doctor: {
    root_session_id: "root-123",
  },
};

Deno.test("mixed|batch schema compatibility", () => {
  const request = sessionMcpRequestSchemas.session_batch_execute.safeParse({
    root_session_id: "root-123",
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
              corpus_ref: "session:root:corpus:1",
              snippet: "session continuity",
              score: 0.9,
            },
          ],
          corpus_refs: ["session:root:corpus:1"],
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

Deno.test("index schema compatibility accepts critical request fields", () => {
  const inlineRequest = sessionMcpRequestSchemas.session_index.safeParse({
    root_session_id: "root-123",
    content: "hello world",
  });
  const pathRequest = sessionMcpRequestSchemas.session_index.safeParse({
    root_session_id: "root-123",
    path: "docs/notes.md",
  });
  const metadataRequest = sessionMcpRequestSchemas.session_index.safeParse({
    root_session_id: "root-123",
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

Deno.test("index schema compatibility rejects requests without content or path", () => {
  const request = sessionMcpRequestSchemas.session_index.safeParse({
    root_session_id: "root-123",
    source: "local-file",
    label: "notes",
  });

  assertEquals(request.success, false);
});

describe("session-mcp-runtime", () => {
  it("registers exactly the 8 session tools", () => {
    const runtime = createSessionMcpRuntime();

    try {
      assertEquals(Object.keys(runtime.tools), [...SESSION_MCP_TOOL_NAMES]);
    } finally {
      void runtime.dispose();
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

  it("rejects requests without root_session_id for every tool schema", () => {
    for (const toolName of SESSION_MCP_TOOL_NAMES) {
      const request = { ...validRequests[toolName] };
      delete request.root_session_id;

      const parsed = sessionMcpRequestSchemas[toolName].safeParse(request);
      assertEquals(parsed.success, false, toolName);
    }
  });

  it("accepts mixed batch step requests via steps and normalizes them internally", () => {
    const parsed = sessionMcpRequestSchemas.session_batch_execute.safeParse({
      root_session_id: "root-123",
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
      root_session_id: "root-123",
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
        root_session_id: "root-123",
        steps: [],
      },
    );
    const emptyCommands = sessionMcpRequestSchemas.session_batch_execute
      .safeParse({
        root_session_id: "root-123",
        commands: [],
      });

    assertEquals(emptySteps.success, false);
    assertEquals(emptyCommands.success, false);
  });

  it("rejects unknown mixed batch step kinds", () => {
    const parsed = sessionMcpRequestSchemas.session_batch_execute.safeParse({
      root_session_id: "root-123",
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
                corpus_ref: "session:root:corpus:1",
                snippet: "session continuity",
                score: 0.9,
              },
            ],
            corpus_refs: ["session:root:corpus:1"],
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

  it("rejects schema-valid caller/root mismatches before handler execution", async () => {
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
        "root_session_id mismatch",
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
          root_session_id: "root-session",
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
        {
          root_session_id: "child-session",
        },
        {
          ...toolContext,
          sessionID: "child-session",
        },
      );
      const provisional = JSON.parse(provisionalSerialized);
      assertEquals(provisional.status, "ok");

      const canonicalSerialized = await runtime.tools.session_stats.execute(
        {
          root_session_id: "parent-session",
        },
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
            {
              root_session_id: "child-session",
            },
            {
              ...toolContext,
              sessionID: "child-session",
            },
          ),
        Error,
        "root_session_id mismatch",
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
        {
          root_session_id: "session-123",
        },
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
        {
          root_session_id: "wrong-root",
        },
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
            {
              root_session_id: "wrong-root",
            },
            {
              ...toolContext,
              sessionID: "child-session",
            },
          ),
        Error,
        "root_session_id mismatch",
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
      await runtime.tools.session_execute.execute(
        validRequests.session_execute,
        toolContext,
      );
      await runtime.tools.session_execute_file.execute(
        validRequests.session_execute_file,
        toolContext,
      ).catch(() => undefined);
      await runtime.tools.session_batch_execute.execute(
        validRequests.session_batch_execute,
        toolContext,
      );
      await runtime.tools.session_index.execute(
        validRequests.session_index,
        toolContext,
      );
      await runtime.tools.session_search.execute(
        validRequests.session_search,
        toolContext,
      );
      await runtime.tools.session_fetch_and_index.execute(
        validRequests.session_fetch_and_index,
        toolContext,
      );
      const statsSerialized = await runtime.tools.session_stats.execute(
        validRequests.session_stats,
        toolContext,
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
        toolContext,
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
        toolContext,
      );
      const execute = JSON.parse(executeSerialized);
      const statsSerialized = await runtime.tools.session_stats.execute(
        validRequests.session_stats,
        toolContext,
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

  it("caps serialized responses to the exact 8 KB budget", async () => {
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

  it("falls back to a local artifact reference when inline output crosses 8 KB", async () => {
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
        toolContext,
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
          root_session_id: "root-123",
          commands: [
            { command: "first" },
            { command: "second" },
            { command: "third" },
          ],
        },
        toolContext,
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
          root_session_id: "root-123",
          content:
            "# Redis Session TTLs\n\nSession TTL refreshes the local session corpus.",
        },
        toolContext,
      );
      const serialized = await runtime.tools.session_search.execute(
        {
          root_session_id: "root-123",
          query: "session ttl",
        },
        toolContext,
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
              "session ttl keeps local corpus search warm\n".repeat(400),
            exit_code: 0,
            timed_out: false,
            truncated: false,
            bytes_captured: SESSION_MCP_RESPONSE_BUDGET_BYTES + 4_096,
          }),
      },
    } as never);

    try {
      const executeSerialized = await runtime.tools.session_execute.execute(
        validRequests.session_execute,
        toolContext,
      );
      const searchSerialized = await runtime.tools.session_search.execute(
        {
          root_session_id: "root-123",
          query: "session ttl",
        },
        toolContext,
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
        toolContext,
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
        toolContext,
      );
      const execute = JSON.parse(executeSerialized);
      const searchSerialized = await runtime.tools.session_search.execute(
        {
          root_session_id: "root-123",
          query: "searchable hidden marker",
        },
        toolContext,
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
          root_session_id: "root-runtime",
          content:
            "# Runtime Search\n\nSession TTL remains available through the live corpus.",
        },
        toolContext,
      );
      const searchSerialized = await runtime.tools.session_search.execute(
        {
          root_session_id: "root-runtime",
          query: "session ttl",
        },
        toolContext,
      );

      const indexed = JSON.parse(indexedSerialized);
      const search = JSON.parse(searchSerialized);

      assertEquals(
        indexed.corpus_ref,
        "session:group-runtime:root-runtime:corpus:corpus-1:meta",
      );
      assertEquals(search.corpus_refs, [indexed.corpus_ref]);
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
          root_session_id: "root-path-index",
          path: localFile,
        },
        createToolContext({
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
          root_session_id: "root-path-index",
          query: "Index local content for the current root session",
        },
        createToolContext({
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
          root_session_id: "root-path-index-external",
          path: externalFile,
        },
        createToolContext({
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
          root_session_id: "root-path-index-external",
          query: "Graphiti is never on the hot path",
        },
        createToolContext({
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
          root_session_id: "root-runtime-replacement",
          content: "old alpha body",
          source: "build-log",
          label: "latest",
        },
        toolContext,
      );
      await runtime.tools.session_index.execute(
        {
          root_session_id: "root-runtime-replacement",
          content: "new beta body",
          source: "build-log",
          label: "latest",
        },
        toolContext,
      );

      const oldSearch = JSON.parse(
        await runtime.tools.session_search.execute(
          {
            root_session_id: "root-runtime-replacement",
            query: "alpha",
          },
          toolContext,
        ),
      );
      const newSearch = JSON.parse(
        await runtime.tools.session_search.execute(
          {
            root_session_id: "root-runtime-replacement",
            query: "beta",
          },
          toolContext,
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
            summary: `${request.command}: ` + "x".repeat(6_000),
            exit_code: 0,
            timed_out: false,
            truncated: false,
            bytes_captured: 6_010,
          }),
      },
    } as never);

    try {
      const serialized = await runtime.tools.session_batch_execute.execute(
        {
          root_session_id: "root-batch",
          commands: [
            { command: "first" },
            { command: "second" },
          ],
        },
        toolContext,
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
          root_session_id: "root-mixed-order",
          content: "session continuity is preserved in the local corpus",
        },
        toolContext,
      );

      const serialized = await runtime.tools.session_batch_execute.execute(
        {
          root_session_id: "root-mixed-order",
          steps: [
            { kind: "command", command: "first" },
            { kind: "search", query: "session continuity" },
            { kind: "command", command: "third" },
          ],
        },
        toolContext,
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
          root_session_id: "root-search-step",
          content: "local corpus search should find this indexed sentence",
        },
        toolContext,
      );

      const serialized = await runtime.tools.session_batch_execute.execute(
        {
          root_session_id: "root-search-step",
          steps: [{ kind: "search", query: "indexed sentence" }],
        },
        toolContext,
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
            summary: `${request.command}: ` + "x".repeat(7_000),
            exit_code: 0,
            timed_out: false,
            truncated: false,
            bytes_captured: 7_010,
          }),
      },
    } as never);

    try {
      await runtime.tools.session_index.execute(
        {
          root_session_id: "root-mixed-spill",
          content: "spill search term remains locally searchable",
        },
        toolContext,
      );

      const serialized = await runtime.tools.session_batch_execute.execute(
        {
          root_session_id: "root-mixed-spill",
          steps: [
            { kind: "command", command: "first" },
            { kind: "search", query: "spill search term" },
            { kind: "command", command: "second" },
          ],
        },
        toolContext,
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
          root_session_id: "root-stub",
          content: "stub body",
        },
        toolContext,
      );
      const fetchSerialized = await runtime.tools.session_fetch_and_index
        .execute(
          {
            root_session_id: "root-stub",
            url: "https://example.com",
          },
          toolContext,
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
          root_session_id: "root-runtime-fetch-error",
          url: "https://example.com/missing",
        },
        toolContext,
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
      assertEquals(parsed.query_hints, []);
      assertEquals(parsed.fetched_url, "https://example.com/missing");
      assertEquals(parsed.content_type, "text/plain");
      assertEquals(parsed.truncated, false);
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
});
