import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import {
  createSessionMcpRuntime,
  SESSION_MCP_RESPONSE_BUDGET_BYTES,
} from "./session-mcp-runtime.ts";
import {
  SESSION_MCP_TOOL_NAMES,
  sessionMcpRequestSchemas,
  sessionMcpResponseSchemas,
  type SessionMcpToolName,
} from "./session-mcp-types.ts";
import { RedisClient } from "./redis-client.ts";

const textEncoder = new TextEncoder();

const toolContext = {
  sessionID: "session-123",
  messageID: "message-123",
  agent: "agent-123",
  directory: "/workspace/project",
  worktree: "/workspace/project",
  abort: AbortSignal.timeout(1_000),
  metadata: () => {},
  ask: async () => {},
};

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

describe("session-mcp-runtime", () => {
  it("registers exactly the 8 session tools", () => {
    const runtime = createSessionMcpRuntime();

    try {
      assertEquals(Object.keys(runtime.tools), [...SESSION_MCP_TOOL_NAMES]);
    } finally {
      void runtime.dispose();
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

  it("executes session_batch_execute sequentially in request order", async () => {
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
        parsed.results.map((item: { summary: string }) => item.summary),
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

  it("stores oversized session_batch_execute output behind bounded artifact refs instead of overflowing the response budget", async () => {
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
      assertExists(parsed.results[0].artifact_ref);
      assertExists(parsed.results[1].artifact_ref);
      assertEquals(
        parsed.results[0].artifact_ref.startsWith("local://session_execute/"),
        true,
      );
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
