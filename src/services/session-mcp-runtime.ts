import {
  tool,
  type ToolContext,
  type ToolDefinition,
} from "@opencode-ai/plugin";
import type { RedisClient } from "./redis-client.ts";
import {
  createSessionCorpusService,
  type SessionCorpusService,
} from "./session-corpus.ts";
import {
  SESSION_MCP_TOOL_NAMES,
  type SessionMcpRequestMap,
  sessionMcpRequestSchemas,
  type SessionMcpResponseMap,
  sessionMcpResponseSchemas,
  type SessionMcpToolName,
} from "./session-mcp-types.ts";

export const SESSION_MCP_RESPONSE_BUDGET_BYTES = 8 * 1024;

type PluginToolArgs = Parameters<typeof tool>[0]["args"];

const pluginSchema = tool.schema;

const pluginRootSessionIdArgs: PluginToolArgs = {
  root_session_id: pluginSchema.string().min(1),
};

const pluginSessionExecuteStepSchema = pluginSchema.object({
  command: pluginSchema.string().min(1),
  timeout_seconds: pluginSchema.number().int().positive().max(120).optional(),
});

const sessionMcpToolArgs: Record<SessionMcpToolName, PluginToolArgs> = {
  session_execute: {
    ...pluginRootSessionIdArgs,
    command: pluginSchema.string().min(1),
    timeout_seconds: pluginSchema.number().int().positive().max(120).optional(),
  },
  session_execute_file: {
    ...pluginRootSessionIdArgs,
    paths: pluginSchema.array(pluginSchema.string().min(1)).min(1),
  },
  session_batch_execute: {
    ...pluginRootSessionIdArgs,
    commands: pluginSchema.array(pluginSessionExecuteStepSchema).min(1),
  },
  session_index: {
    ...pluginRootSessionIdArgs,
    content: pluginSchema.string(),
  },
  session_search: {
    ...pluginRootSessionIdArgs,
    query: pluginSchema.string().min(1),
  },
  session_fetch_and_index: {
    ...pluginRootSessionIdArgs,
    url: pluginSchema.string().url(),
    timeout_seconds: pluginSchema.number().int().positive().max(120).optional(),
  },
  session_stats: {
    ...pluginRootSessionIdArgs,
  },
  session_doctor: {
    ...pluginRootSessionIdArgs,
  },
};

type SessionMcpHandler<TToolName extends SessionMcpToolName> = (
  request: SessionMcpRequestMap[TToolName],
  context: ToolContext,
) => Promise<SessionMcpResponseMap[TToolName]>;

type SessionMcpHandlerMap = {
  [K in SessionMcpToolName]: SessionMcpHandler<K>;
};

type SessionMcpRuntimeOptions = {
  handlers?: Partial<SessionMcpHandlerMap>;
  redisClient?: RedisClient;
  sessionTtlSeconds?: number;
  groupId?: string;
  createSessionCorpusService?: typeof createSessionCorpusService;
};

export type SessionMcpRuntime = {
  tools: Record<SessionMcpToolName, ToolDefinition>;
  dispose: () => Promise<void>;
  migrateRootSessionState: (
    sourceRootSessionId: string,
    targetRootSessionId: string,
  ) => Promise<void>;
};

const parseRequest = <TToolName extends SessionMcpToolName>(
  toolName: TToolName,
  rawRequest: unknown,
): SessionMcpRequestMap[TToolName] =>
  sessionMcpRequestSchemas[toolName].parse(
    rawRequest,
  ) as SessionMcpRequestMap[TToolName];

const parseResponse = <TToolName extends SessionMcpToolName>(
  toolName: TToolName,
  rawResponse: unknown,
): SessionMcpResponseMap[TToolName] =>
  sessionMcpResponseSchemas[toolName].parse(
    rawResponse,
  ) as SessionMcpResponseMap[TToolName];

const textEncoder = new TextEncoder();

const serialize = (value: unknown): string => JSON.stringify(value);

const extractInlineArtifactPayload = (
  artifactRef: string | undefined,
): string | null => {
  if (!artifactRef?.startsWith("inline://payload/")) return null;
  try {
    return decodeURIComponent(artifactRef.slice("inline://payload/".length));
  } catch {
    return null;
  }
};

const byteLength = (value: string): number =>
  textEncoder.encode(value).byteLength;

const isWithinBudget = (value: string): boolean =>
  byteLength(value) <= SESSION_MCP_RESPONSE_BUDGET_BYTES;

const makeCorpusRef = (
  groupId: string,
  rootSessionId: string,
  corpusId: string,
): string => `session:${groupId}:${rootSessionId}:corpus:${corpusId}:meta`;

export const createSessionMcpRuntime = (
  options: SessionMcpRuntimeOptions = {},
): SessionMcpRuntime => {
  const groupId = options.groupId ?? "local";
  const createCorpus = options.createSessionCorpusService ??
    createSessionCorpusService;
  const corpus: SessionCorpusService | null = options.redisClient
    ? createCorpus({
      redis: options.redisClient,
      ttlSeconds: options.sessionTtlSeconds ?? 60,
      groupId,
    })
    : null;
  let artifactCounter = 0;
  const artifactStore = new Map<string, string>();

  const writeArtifact = (
    toolName: SessionMcpToolName,
    body: string,
  ): Promise<string> => {
    const artifactRef = `local://${toolName}/${++artifactCounter}`;
    artifactStore.set(artifactRef, body);
    return Promise.resolve(artifactRef);
  };

  const defaultHandlers: SessionMcpHandlerMap = {
    session_execute: (request) =>
      Promise.resolve({
        status: "ok",
        summary:
          `Stub session_execute accepted command for ${request.root_session_id}.`,
        exit_code: 0,
        timed_out: false,
        truncated: false,
        bytes_captured: 0,
      }),
    session_execute_file: (request) =>
      Promise.resolve({
        status: "ok",
        summary:
          `Stub session_execute_file accepted ${request.paths.length} file(s).`,
        file_count: request.paths.length,
        truncated: false,
      }),
    session_batch_execute: async (request, context) => {
      const results: SessionMcpResponseMap["session_execute"][] = [];
      for (const command of request.commands) {
        results.push(
          await handlerMap.session_execute({
            root_session_id: request.root_session_id,
            command: command.command,
            timeout_seconds: command.timeout_seconds,
          }, context),
        );
      }
      return {
        status: "ok",
        summary:
          `Stub session_batch_execute completed ${results.length} command(s).`,
        results,
        truncated: false,
      };
    },
    session_index: async (request) => {
      if (!corpus) {
        return {
          status: "ok",
          corpus_ref: makeCorpusRef(
            groupId,
            request.root_session_id,
            "stub-index",
          ),
          chunk_count: 0,
          query_hints: [],
        };
      }
      const result = await corpus.index({
        rootSessionId: request.root_session_id,
        content: request.content,
      });
      return {
        status: result.status,
        corpus_ref: result.corpusRef,
        chunk_count: result.chunkCount,
        query_hints: result.queryHints,
      };
    },
    session_search: async (request) => {
      if (!corpus) {
        return {
          status: "ok",
          results: [],
          corpus_refs: [],
          truncated: false,
        };
      }
      const result = await corpus.search({
        rootSessionId: request.root_session_id,
        query: request.query,
      });
      return {
        status: result.status,
        results: result.results,
        corpus_refs: result.corpusRefs,
        truncated: result.truncated,
      };
    },
    session_fetch_and_index: async (request) => {
      if (!corpus) {
        return {
          status: "ok",
          corpus_ref: makeCorpusRef(
            groupId,
            request.root_session_id,
            "stub-fetch",
          ),
          summary: `Stub session_fetch_and_index accepted ${request.url}.`,
          query_hints: [],
          fetched_url: request.url,
          content_type: "text/plain",
          truncated: false,
        };
      }
      const result = await corpus.fetchAndIndex({
        rootSessionId: request.root_session_id,
        url: request.url,
        timeoutSeconds: request.timeout_seconds,
      });
      return {
        status: result.status,
        corpus_ref: result.corpusRef,
        summary: result.summary,
        query_hints: result.queryHints,
        fetched_url: result.fetchedUrl,
        content_type: result.contentType,
        truncated: result.truncated,
      };
    },
    session_stats: async (request) => {
      if (!corpus) {
        return {
          status: "ok",
          counters: {},
          corpus_count: 0,
          artifact_count: 0,
          bytes_saved_estimate: 0,
        };
      }
      const stats = await corpus.getStats(request.root_session_id);
      return {
        status: "ok",
        counters: stats.counters,
        corpus_count: stats.corpusCount,
        artifact_count: stats.artifactCount,
        bytes_saved_estimate: stats.bytesSavedEstimate,
      };
    },
    session_doctor: () =>
      Promise.resolve({
        status: "ok",
        checks: [{
          name: "session-mcp-runtime",
          status: "ok",
          detail: "Stub runtime handlers are registered in-process.",
        }],
        redis: {
          status: "not_checked",
          detail: "Redis health is not checked by the Task 1 stub runtime.",
        },
        graphiti_cache: {
          status: "not_checked",
          detail:
            "Graphiti cache health is not checked by the Task 1 stub runtime.",
        },
        runtime: {
          status: "ok",
          detail: "In-process session MCP runtime is active.",
        },
      }),
  };

  const handlerMap: SessionMcpHandlerMap = {
    ...defaultHandlers,
    ...options.handlers,
  };

  const persistInlineArtifactIfPresent = async <
    TToolName extends "session_execute" | "session_execute_file",
  >(
    toolName: TToolName,
    response: SessionMcpResponseMap[TToolName],
    rootSessionId: string,
  ): Promise<SessionMcpResponseMap[TToolName]> => {
    const payload = extractInlineArtifactPayload(response.artifact_ref);
    if (!payload) return response;

    const artifact = corpus
      ? await corpus.storeArtifact({
        rootSessionId,
        toolName,
        body: payload,
      }).catch(() => null)
      : null;
    const fallbackArtifactRef = await writeArtifact(toolName, payload);
    const artifactRef = artifact?.artifactRef ?? fallbackArtifactRef;

    if (toolName === "session_execute") {
      return {
        ...response,
        artifact_ref: artifactRef,
      } as SessionMcpResponseMap[TToolName];
    }

    return {
      ...response,
      artifact_ref: artifactRef,
      corpus_ref: (response as SessionMcpResponseMap["session_execute_file"])
        .corpus_ref ?? artifact?.corpusRef,
    } as SessionMcpResponseMap[TToolName];
  };

  const coerceOversizedResponse = async <TToolName extends SessionMcpToolName>(
    toolName: TToolName,
    response: SessionMcpResponseMap[TToolName],
    rootSessionId: string,
  ): Promise<SessionMcpResponseMap[TToolName]> => {
    const resolveArtifactBody = (
      payload: { summary: string; artifact_ref?: string },
    ) => extractInlineArtifactPayload(payload.artifact_ref) ?? payload.summary;
    const resolveArtifactRef = (
      originalRef: string | undefined,
      storedRef: string | undefined,
      fallbackRef: string,
    ) =>
      extractInlineArtifactPayload(originalRef)
        ? (storedRef ?? fallbackRef)
        : (originalRef ?? storedRef ?? fallbackRef);

    if (toolName === "session_execute") {
      const oversized = response as SessionMcpResponseMap["session_execute"];
      const artifactBody = resolveArtifactBody(oversized);
      const artifact = corpus
        ? await corpus.storeArtifact({
          rootSessionId,
          toolName,
          body: artifactBody,
        }).catch(() => null)
        : null;
      const fallbackArtifactRef = await writeArtifact(toolName, artifactBody);
      const artifactRef = resolveArtifactRef(
        oversized.artifact_ref,
        artifact?.artifactRef,
        fallbackArtifactRef,
      );
      return {
        ...oversized,
        artifact_ref: artifactRef,
        summary: `Oversized output moved to local artifact ${artifactRef}.`,
        truncated: true,
      } as SessionMcpResponseMap[TToolName];
    }

    if (toolName === "session_execute_file") {
      const oversized =
        response as SessionMcpResponseMap["session_execute_file"];
      const artifactBody = resolveArtifactBody(oversized);
      const artifact = corpus
        ? await corpus.storeArtifact({
          rootSessionId,
          toolName,
          body: artifactBody,
        }).catch(() => null)
        : null;
      const fallbackArtifactRef = await writeArtifact(toolName, artifactBody);
      const artifactRef = resolveArtifactRef(
        oversized.artifact_ref,
        artifact?.artifactRef,
        fallbackArtifactRef,
      );
      return {
        ...oversized,
        artifact_ref: artifactRef,
        corpus_ref: oversized.corpus_ref ?? artifact?.corpusRef,
        summary: `Oversized output moved to local artifact ${artifactRef}.`,
        truncated: true,
      } as SessionMcpResponseMap[TToolName];
    }

    if (toolName === "session_batch_execute") {
      const oversized =
        response as SessionMcpResponseMap["session_batch_execute"];
      const results = await Promise.all(
        oversized.results.map(async (result) => {
          const artifactBody = resolveArtifactBody(result);
          const artifact = corpus
            ? await corpus.storeArtifact({
              rootSessionId,
              toolName: "session_execute",
              body: artifactBody,
            }).catch(() => null)
            : null;
          const fallbackArtifactRef = await writeArtifact(
            "session_execute",
            artifactBody,
          );
          const artifactRef = resolveArtifactRef(
            result.artifact_ref,
            artifact?.artifactRef,
            fallbackArtifactRef,
          );
          return {
            ...result,
            artifact_ref: artifactRef,
            summary:
              `Oversized batch step output moved to local artifact ${artifactRef}.`,
            truncated: true,
          };
        }),
      );
      return {
        ...oversized,
        summary:
          `Batch output truncated to stay within ${SESSION_MCP_RESPONSE_BUDGET_BYTES} bytes.`,
        results,
        truncated: true,
      } as SessionMcpResponseMap[TToolName];
    }

    if (toolName === "session_search") {
      const oversized = response as SessionMcpResponseMap["session_search"];
      return {
        ...oversized,
        results: oversized.results.slice(0, 1).map((
          result: SessionMcpResponseMap["session_search"]["results"][number],
        ) => ({
          ...result,
          snippet: result.snippet.slice(0, 320),
        })),
        truncated: true,
      } as SessionMcpResponseMap[TToolName];
    }

    return response;
  };

  const executeTool = async <TToolName extends SessionMcpToolName>(
    toolName: TToolName,
    rawRequest: unknown,
    context: ToolContext,
  ): Promise<string> => {
    const request = parseRequest(toolName, rawRequest);
    let response = parseResponse(
      toolName,
      await (handlerMap[toolName] as (
        request: SessionMcpRequestMap[TToolName],
        context: ToolContext,
      ) => Promise<SessionMcpResponseMap[TToolName]>)(request, context),
    );

    if (toolName === "session_execute") {
      response = parseResponse(
        toolName,
        await persistInlineArtifactIfPresent(
          toolName,
          response as SessionMcpResponseMap["session_execute"],
          request.root_session_id,
        ),
      );
    }

    if (toolName === "session_execute_file") {
      response = parseResponse(
        toolName,
        await persistInlineArtifactIfPresent(
          toolName,
          response as SessionMcpResponseMap["session_execute_file"],
          request.root_session_id,
        ),
      );
    }

    let serialized = serialize(response);

    if (!isWithinBudget(serialized)) {
      response = parseResponse(
        toolName,
        await coerceOversizedResponse(
          toolName,
          response,
          request.root_session_id,
        ),
      );
      serialized = serialize(response);
    }

    if (!isWithinBudget(serialized)) {
      throw new Error(
        `${toolName} response exceeded ${SESSION_MCP_RESPONSE_BUDGET_BYTES} bytes`,
      );
    }

    return serialized;
  };

  const descriptions: Record<SessionMcpToolName, string> = {
    session_execute: "Execute a bounded session command.",
    session_execute_file: "Read local files through the session runtime.",
    session_batch_execute: "Execute bounded session commands sequentially.",
    session_index: "Index local content for the current root session.",
    session_search:
      "Search local indexed content for the current root session.",
    session_fetch_and_index:
      "Fetch content and index it for the current root session.",
    session_stats: "Return local session MCP stats.",
    session_doctor: "Return local session MCP health checks.",
  };

  const tools = Object.fromEntries(
    SESSION_MCP_TOOL_NAMES.map((toolName) => [
      toolName,
      tool({
        description: descriptions[toolName],
        args: sessionMcpToolArgs[toolName],
        execute: (args, context) => executeTool(toolName, args, context),
      }),
    ]),
  ) as unknown as Record<SessionMcpToolName, ToolDefinition>;

  let disposed = false;

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    artifactStore.clear();
    await corpus?.dispose?.();
  };

  const migrateRootSessionState = async (
    sourceRootSessionId: string,
    targetRootSessionId: string,
  ): Promise<void> => {
    await corpus?.migrateRootSessionState?.(
      sourceRootSessionId,
      targetRootSessionId,
    );
  };

  return {
    tools,
    dispose,
    migrateRootSessionState,
  };
};
