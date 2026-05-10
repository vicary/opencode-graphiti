import {
  tool,
  type ToolContext,
  type ToolDefinition,
} from "@opencode-ai/plugin";
import { RedisClient } from "./redis-client.ts";
import type { RedisCacheService } from "./redis-cache.ts";
import {
  createSessionCorpusService,
  type SessionCorpusService,
} from "./session-corpus.ts";
import {
  createSessionExecutor,
  SESSION_EXECUTOR_DEFAULT_COMMAND_TIMEOUT_SECONDS,
  SESSION_EXECUTOR_MAX_COMMAND_TIMEOUT_SECONDS,
  SESSION_EXECUTOR_MAX_NORMALIZED_INDEXED_BODY_BYTES,
  type SessionExecutor,
} from "./session-executor.ts";
import {
  createExactHistoryAdapter,
  type ExactHistoryAdapter,
} from "./exact-history.ts";
import {
  createMemorySearchService,
  createSummarySearchAdapter,
  type SummarySearchAdapter,
} from "./memory-search.ts";
import {
  SESSION_MCP_TOOL_NAMES,
  type SessionMcpRequestMap,
  sessionMcpRequestSchemas,
  type SessionMcpResponseMap,
  sessionMcpResponseSchemas,
  type SessionMcpToolName,
} from "./session-mcp-types.ts";
import { SessionNotesService } from "./session-notes.ts";
import type { RuntimeRootSessionValidator } from "../session.ts";
import type { NormalizedMemoryResult } from "../types/index.ts";
import { readFile as readFileNode } from "node:fs/promises";
import path from "node:path";

export const SESSION_MCP_RESPONSE_BUDGET_BYTES = 8 * 1024;
const SESSION_SEARCH_RESULT_LIMIT = 5;
const SEARCH_RESULT_CREATED_AT_FALLBACK = "1970-01-01T00:00:00.000Z";

export const SESSION_NOTES_WRITE_DESCRIPTION = [
  "Pin working context as a session note so it survives topic switches, long tool",
  "loops, and compaction. Use this BEFORE drifting away from important context:",
  "",
  "- Before switching to a different topic or task",
  "- After a user correction changes your assumptions",
  "- When a small task stalls and work shifts elsewhere",
  "- During long tool-calling sequences where key state lives only in your context",
  "- Before compaction is likely (many messages into a session)",
  "",
  "Do NOT use this for ephemeral state that will be irrelevant within a few turns",
  "(e.g., intermediate variable values, transient build errors you are about to",
  "fix, or scratchpad reasoning). Notes are for context you need to survive",
  "across topic switches or compaction — not for every observation.",
  "",
  "Accepts `text` (markdown body) and optional `replace`:",
  "",
  "- replace id + non-empty text is upsert",
  "- replace id + empty text is delete",
  "- delete on missing id is a no-op success returning deleted",
  "- any same-project session may delete a note by id; cross-project deletion is rejected",
  "- non-empty writes (create/upsert) reject ownership conflicts",
  '- replace "*" + non-empty text replaces all notes and returns `{ action: "replaced", id, cleared_count }`',
  '- replace "*" + empty text clears all notes and returns `{ action: "replaced", cleared_count }`',
  '- omit `replace` to create a new note and return `{ action: "created", id }`',
  "",
  "Always rely on the returned `action` instead of inferring the outcome from the",
  "inputs alone.",
  "",
  "Prefer concise markdown with headings, bullets, and short code snippets:",
  "",
  "    ## Current Task: Fix Redis TTL bug",
  "    - **File:** `src/services/redis-client.ts`",
  "    - **Root cause:** TTL not refreshed on read",
  "    - **Next step:** Add EXPIRE call after GET in `refreshEntry()`",
  "    - **User correction:** Use seconds not milliseconds for TTL",
].join("\n");

export const SESSION_NOTES_READ_DESCRIPTION = [
  "Reopen exact pinned note text instead of reconstructing it from memory. Use this",
  "when you resume an interrupted topic, need the exact wording of a pinned user",
  "instruction, or want to verify what you previously noted before acting on it.",
  "",
  "If `id` is provided, returns that single note as",
  "`{ note: { id, text, created_at, updated_at } }`; when the id does not exist,",
  "returns `{ note: null }`.",
  "",
  "Always prefer reading a pinned note over reciting its contents from recall —",
  "notes are the source of truth for intentionally preserved context.",
].join("\n");

export const SESSION_SEARCH_BASELINE_DESCRIPTION = [
  "Search local indexed content for the current root session. This is the default",
  "recall path — use it FIRST when you need prior context, especially:",
  "",
  "- At the start of a new session or after compaction",
  "- When resuming a topic you worked on earlier",
  "- Before re-solving a problem that may already have a solution in session history",
  "- To check whether pinned session notes already contain the context you need",
  "",
  'Results may include indexed memory content (type: "memory") and, when pinned',
  'session notes exist, matching notes (type: "note"). Note results include',
  '`id`, `root_session_id`, `scope: "local" | "project"`, `created_at`, and',
  "`updated_at` — use `session_notes_read` with the note `id` to reopen the full",
  "note text. Not every query will return note results; notes only appear when they",
  "match the search query and the session has pinned notes.",
  "",
  "Prefer session_search over reconstructing context from scratch. If search",
  "returns relevant note hits, read the note before duplicating its contents.",
].join("\n");

export const SESSION_SEARCH_STRENGTHENED_DESCRIPTION =
  SESSION_SEARCH_BASELINE_DESCRIPTION +
  "\n\n" +
  [
    "⚠️ This is a new session or a post-compaction turn. Prior context may have been",
    "summarized or is not yet in your working memory. STRONGLY RECOMMENDED: run a",
    "session_search query before starting work to recover earlier decisions, pinned",
    "notes, and task state. This avoids re-solving problems or contradicting earlier",
    "decisions that survived compaction.",
  ].join("\n");

type PluginToolArgs = Parameters<typeof tool>[0]["args"];

const pluginSchema = tool.schema;

const pluginRootSessionIdArgs: PluginToolArgs = {
  root_session_id: pluginSchema.string().min(1),
};

const pluginSessionExecuteStepSchema = pluginSchema.object({
  command: pluginSchema.string().min(1),
  timeout_seconds: pluginSchema.number().int().positive().max(120).optional(),
});

const pluginSessionBatchStepSchema = pluginSchema.object({
  kind: pluginSchema.string().min(1),
  command: pluginSchema.string().min(1).optional(),
  query: pluginSchema.string().min(1).optional(),
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
    commands: pluginSchema.array(pluginSessionExecuteStepSchema).min(1)
      .optional(),
    steps: pluginSchema.array(pluginSessionBatchStepSchema).min(1).optional(),
  },
  session_index: {
    ...pluginRootSessionIdArgs,
    content: pluginSchema.string().optional(),
    path: pluginSchema.string().min(1).optional(),
    source: pluginSchema.string().min(1).optional(),
    label: pluginSchema.string().min(1).optional(),
  },
  session_search: {
    query: pluginSchema.string(),
    when: pluginSchema.string().datetime().optional(),
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
  session_notes_write: {
    text: pluginSchema.string(),
    replace: pluginSchema.string().min(1).optional(),
  },
  session_notes_read: {
    id: pluginSchema.string().min(1).optional(),
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
  graphitiCache?: RedisCacheService | object;
  notesService?: SessionNotesService;
  sessionTtlSeconds?: number;
  groupId?: string;
  createSessionCorpusService?: typeof createSessionCorpusService;
  createSessionExecutor?: typeof createSessionExecutor;
  sessionExecutor?: SessionExecutor;
  exactHistoryAdapter?: ExactHistoryAdapter;
  summarySearchAdapter?: SummarySearchAdapter;
  sessionCanonicalizer?: RuntimeRootSessionValidator;
  readSessionIndexFile?: (filePath: string) => Promise<string>;
};

type SessionExecuteResponse = SessionMcpResponseMap["session_execute"];
type SessionSearchResponse = SessionMcpResponseMap["session_search"];
type SessionBatchExecuteRequest = SessionMcpRequestMap["session_batch_execute"];
type SessionBatchExecuteStep = NonNullable<
  SessionBatchExecuteRequest["steps"]
>[number];
type SessionBatchStepResultItem =
  | { kind: "command"; result: SessionExecuteResponse }
  | { kind: "search"; result: SessionSearchResponse };
type SessionBatchExecuteResponse = {
  status: "ok" | "error";
  summary: string;
  results: SessionBatchStepResultItem[];
  truncated: boolean;
};

export type SessionMcpRuntime = {
  tools: Record<SessionMcpToolName, ToolDefinition>;
  dispose: () => Promise<void>;
  setSessionCanonicalizer: (
    sessionCanonicalizer: RuntimeRootSessionValidator | undefined,
  ) => void;
  migrateRootSessionState: (
    sourceRootSessionId: string,
    targetRootSessionId: string,
  ) => Promise<void>;
};

const getRedisDoctorStatus = (
  redisClient: RedisClient | undefined,
): { status: "ok" | "degraded" | "not_checked"; detail: string } => {
  if (!redisClient) {
    return {
      status: "not_checked",
      detail: "Redis client is not configured for this runtime.",
    };
  }

  if (redisClient.isConnected()) {
    return {
      status: "ok",
      detail: "Redis hot tier is connected.",
    };
  }

  return {
    status: "degraded",
    detail: "Redis hot tier is unavailable; using in-memory fallback.",
  };
};

const getGraphitiCacheDoctorStatus = (
  graphitiCache: SessionMcpRuntimeOptions["graphitiCache"],
  redisClient: RedisClient | undefined,
): { status: "ok" | "degraded" | "not_checked"; detail: string } => {
  if (!graphitiCache) {
    return {
      status: "not_checked",
      detail: "Graphiti cache service is not configured for this runtime.",
    };
  }

  if (redisClient?.isConnected()) {
    return {
      status: "ok",
      detail: "Graphiti cache is backed by the connected Redis hot tier.",
    };
  }

  return {
    status: "degraded",
    detail:
      "Graphiti cache is configured but Redis is unavailable; cache access is degraded.",
  };
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

const validateResponsePreservingBatchShape = <
  TToolName extends SessionMcpToolName,
>(
  toolName: TToolName,
  rawResponse: unknown,
): SessionMcpResponseMap[TToolName] => {
  if (toolName !== "session_batch_execute") {
    return parseResponse(toolName, rawResponse);
  }

  sessionMcpResponseSchemas.session_batch_execute.parse(rawResponse);
  return rawResponse as SessionMcpResponseMap[TToolName];
};

const validateRuntimeRootSessionContract = async <
  TToolName extends SessionMcpToolName,
>(
  _toolName: TToolName,
  request: SessionMcpRequestMap[TToolName],
  context: ToolContext,
  validator: RuntimeRootSessionValidator | undefined,
): Promise<void> => {
  const sessionId = context.sessionID;
  if (!sessionId) return;
  await validator?.validateRuntimeRootSessionId(
    sessionId,
    request.root_session_id,
  );
};

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

const readTextFile = (filePath: string): Promise<string> =>
  readFileNode(filePath, "utf8");

const createBoundedSessionIndexError = (
  code: "session_index_path_unreadable",
  message: string,
): Error & { code: string; bounded: true } =>
  Object.assign(new Error(message), { code, bounded: true as const });

const isWithinBudget = (value: string): boolean =>
  byteLength(value) <= SESSION_MCP_RESPONSE_BUDGET_BYTES;

const resolveSessionIndexPath = (
  requestPath: string,
  context: ToolContext,
): string => {
  const workspaceRoot = path.resolve(context.worktree ?? context.directory);
  const baseDirectory = path.resolve(context.directory ?? workspaceRoot);
  return path.isAbsolute(requestPath)
    ? path.resolve(requestPath)
    : path.resolve(baseDirectory, requestPath);
};

const isWithinWorkspace = (
  workspaceRoot: string,
  targetPath: string,
): boolean => {
  const relative = path.relative(workspaceRoot, targetPath);
  return relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const requestSessionIndexPermissions = async (
  resolvedPath: string,
  context: ToolContext,
): Promise<void> => {
  const workspaceRoot = path.resolve(context.worktree ?? context.directory);
  if (!isWithinWorkspace(workspaceRoot, resolvedPath)) {
    const parentDir = path.dirname(resolvedPath);
    const glob = path.join(parentDir, "*").replaceAll("\\", "/");
    await context.ask({
      permission: "external_directory",
      patterns: [glob],
      always: [glob],
      metadata: {
        filepath: resolvedPath,
        parentDir,
      },
    });
  }

  await context.ask({
    permission: "read",
    patterns: [resolvedPath],
    always: ["*"],
    metadata: {},
  });
};

const readSessionIndexBody = async (
  request: SessionMcpRequestMap["session_index"],
  context: ToolContext,
  readSessionIndexFile: (filePath: string) => Promise<string>,
): Promise<string> => {
  if (!request.path) return request.content;

  const resolvedPath = resolveSessionIndexPath(request.path, context);

  try {
    await requestSessionIndexPermissions(resolvedPath, context);
    return await readSessionIndexFile(resolvedPath);
  } catch {
    throw createBoundedSessionIndexError(
      "session_index_path_unreadable",
      "session_index could not read the requested path.",
    );
  }
};

const makeCorpusRef = (
  groupId: string,
  rootSessionId: string,
  corpusId: string,
): string => `session:${groupId}:${rootSessionId}:corpus:${corpusId}:meta`;

const statsCounterKeyForTool = (toolName: SessionMcpToolName): string =>
  `${toolName}_calls_total`;

const normalizeCorpusSearchResult = (
  result: {
    corpus_ref?: string;
    ref?: string;
    snippet: string;
    score: number;
    type?: string;
    id?: string;
    root_session_id?: string;
    scope?: "session" | "local" | "project";
    created_at?: string;
    updated_at?: string;
    granularity?: string;
    source?: string;
  },
): NormalizedMemoryResult => ({
  ref: result.ref ?? result.corpus_ref ?? "",
  snippet: result.snippet,
  score: result.score,
  type: result.type === "entry" || result.type === "note" ||
      result.type === "summary"
    ? result.type
    : "summary",
  id: result.id,
  root_session_id: result.root_session_id,
  scope: result.scope,
  created_at: result.created_at ?? SEARCH_RESULT_CREATED_AT_FALLBACK,
  updated_at: result.updated_at,
  granularity: result.granularity,
  source: result.source,
});

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
  const corpusBackedArtifactRefs = new Set<string>();
  let sessionCanonicalizer = options.sessionCanonicalizer;
  const createExecutor = options.createSessionExecutor ?? createSessionExecutor;
  const readSessionIndexFile = options.readSessionIndexFile ?? readTextFile;
  const notes = options.notesService ?? new SessionNotesService(
    options.redisClient ?? new RedisClient({ endpoint: "redis://unused" }),
    { groupId },
  );
  const summarySearchAdapter = options.summarySearchAdapter ??
    (corpus
      ? {
        search: async ({ rootSessionId, query }) => {
          const result = await corpus.search({ rootSessionId, query });
          return result.results.map(normalizeCorpusSearchResult);
        },
      }
      : createSummarySearchAdapter());
  const memorySearch = createMemorySearchService({
    exactHistoryAdapter: options.exactHistoryAdapter ??
      createExactHistoryAdapter(),
    notesService: notes,
    summarySearchAdapter,
    groupId,
    resultLimit: SESSION_SEARCH_RESULT_LIMIT,
  });

  const resolveCanonicalRootSessionId = async (
    context: ToolContext,
    fallbackRootSessionId?: string,
  ): Promise<string> => {
    const sessionId = context.sessionID;
    if (!sessionId) return fallbackRootSessionId ?? "";
    return await sessionCanonicalizer?.resolveCanonicalSessionId(sessionId) ??
      (fallbackRootSessionId || sessionId);
  };

  const writeArtifact = (
    toolName: SessionMcpToolName,
    body: string,
  ): Promise<string> => {
    const artifactRef = `local://${toolName}/${++artifactCounter}`;
    artifactStore.set(artifactRef, body);
    return Promise.resolve(artifactRef);
  };

  const recordToolCall = async (
    rootSessionId: string,
    toolName: SessionMcpToolName,
  ): Promise<void> => {
    await corpus?.recordStats?.(rootSessionId, {
      [statsCounterKeyForTool(toolName)]: 1,
    });
  };

  const recordReturnedBytes = async (
    rootSessionId: string,
    serialized: string,
  ): Promise<void> => {
    await corpus?.recordStats?.(rootSessionId, {
      bytes_returned_total: byteLength(serialized),
    });
  };

  const rememberCorpusArtifactRef = (artifactRef: string | undefined): void => {
    if (artifactRef) corpusBackedArtifactRefs.add(artifactRef);
  };

  const persistCanonicalLocalArtifactIfNeeded = async <
    TToolName extends "session_execute" | "session_execute_file",
  >(
    toolName: TToolName,
    response: SessionMcpResponseMap[TToolName],
    rootSessionId: string,
  ): Promise<void> => {
    if (!corpus) return;
    if (
      toolName === "session_execute_file" &&
      (response as SessionMcpResponseMap["session_execute_file"]).corpus_ref
    ) {
      return;
    }
    if (
      response.artifact_ref &&
      corpusBackedArtifactRefs.has(response.artifact_ref)
    ) {
      return;
    }
    if (!response.summary.trim()) return;
    const artifact = await corpus.storeArtifact({
      rootSessionId,
      toolName,
      body: response.summary,
    }).catch(() => undefined);
    rememberCorpusArtifactRef(artifact?.artifactRef);
  };

  const sessionExecutor = options.sessionExecutor ?? createExecutor({
    responseBudgetBytes: SESSION_MCP_RESPONSE_BUDGET_BYTES,
    defaultCommandTimeoutSeconds:
      SESSION_EXECUTOR_DEFAULT_COMMAND_TIMEOUT_SECONDS,
    maxCommandTimeoutSeconds: SESSION_EXECUTOR_MAX_COMMAND_TIMEOUT_SECONDS,
    maxNormalizedIndexedBodyBytes:
      SESSION_EXECUTOR_MAX_NORMALIZED_INDEXED_BODY_BYTES,
    storeArtifact: async ({ rootSessionId, toolName, body }) => {
      const artifact = corpus
        ? await corpus.storeArtifact({
          rootSessionId,
          toolName,
          body,
        }).catch(() => null)
        : null;
      rememberCorpusArtifactRef(artifact?.artifactRef);
      const fallbackArtifactRef = await writeArtifact(toolName, body);
      return {
        artifactRef: artifact?.artifactRef ?? fallbackArtifactRef,
        corpusRef: artifact?.corpusRef,
      };
    },
  });

  const searchMemory = async (
    rootSessionId: string,
    query: string,
    when: string,
  ): Promise<SessionSearchResponse> => {
    return await memorySearch.search({
      rootSessionId,
      query,
      when,
    });
  };

  const defaultHandlers: SessionMcpHandlerMap = {
    session_execute: (request, context) =>
      sessionExecutor.executeCommand(request, {
        worktree: context.worktree,
        directory: context.directory,
      }),
    session_execute_file: (request, context) =>
      sessionExecutor.executeFile(request, {
        worktree: context.worktree,
        directory: context.directory,
      }),
    session_batch_execute: async (request, context) => {
      const steps = request.steps ?? request.commands.map((command) => ({
        kind: "command" as const,
        ...command,
      }));
      if (steps.length === 0) {
        throw new Error("session_batch_execute requires at least one step");
      }

      const results: SessionBatchStepResultItem[] = [];
      for (const step of steps) {
        if (step.kind === "command") {
          const result = await handlerMap.session_execute(
            {
              root_session_id: request.root_session_id,
              command: step.command,
              timeout_seconds: step.timeout_seconds,
            },
            context,
          );
          results.push({ kind: "command", result });
          continue;
        }

        const result = await searchMemory(
          request.root_session_id,
          step.query,
          new Date().toISOString(),
        );
        results.push({ kind: "search", result });
      }

      return {
        status: results.every((result) => result.result.status === "ok")
          ? "ok"
          : "error",
        summary: `Completed ${results.length} step(s).`,
        results,
        truncated: false,
      } as SessionMcpResponseMap["session_batch_execute"];
    },
    session_index: async (request, context) => {
      const content = await readSessionIndexBody(
        request,
        context,
        readSessionIndexFile,
      );
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
        content,
        source: request.source,
        label: request.label,
      });
      return {
        status: result.status,
        corpus_ref: result.corpusRef,
        chunk_count: result.chunkCount,
        query_hints: result.queryHints,
      };
    },
    session_search: async (request, context) => {
      const rootSessionId = await resolveCanonicalRootSessionId(context);
      return await searchMemory(
        rootSessionId,
        request.query,
        request.when ?? new Date().toISOString(),
      );
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
    session_doctor: async (request) => {
      const redis = getRedisDoctorStatus(options.redisClient);
      const graphitiCache = getGraphitiCacheDoctorStatus(
        options.graphitiCache,
        options.redisClient,
      );
      const stats = await corpus?.getStats(request.root_session_id);
      return {
        status: "ok",
        checks: [
          {
            name: "session-mcp-runtime",
            status: "ok",
            detail: "In-process session MCP runtime handlers are registered.",
          },
          ...(stats
            ? [{
              name: "session-mcp-local-stats",
              status: "ok" as const,
              detail:
                `Local stats available for ${request.root_session_id} (corpora=${stats.corpusCount}, artifacts=${stats.artifactCount}).`,
            }]
            : []),
        ],
        redis,
        graphiti_cache: graphitiCache,
        runtime: {
          status: "ok",
          detail: "In-process session MCP runtime is active.",
        },
      };
    },
    session_notes_write: async (request, context) => {
      const rootSessionId = await resolveCanonicalRootSessionId(context);
      return await notes.writeNote(rootSessionId, request.text, {
        replace: request.replace,
      });
    },
    session_notes_read: async (request) => {
      return await notes.readNote(request.id);
    },
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
    rememberCorpusArtifactRef(artifact?.artifactRef);
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
      rememberCorpusArtifactRef(artifact?.artifactRef);
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
      rememberCorpusArtifactRef(artifact?.artifactRef);
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
      const oversized = response as unknown as SessionBatchExecuteResponse;
      const results: SessionBatchStepResultItem[] = [];

      for (const result of oversized.results) {
        if (result.kind === "command") {
          const artifactBody = resolveArtifactBody(result.result);
          const artifact = corpus
            ? await corpus.storeArtifact({
              rootSessionId,
              toolName: "session_execute",
              body: artifactBody,
            }).catch(() => null)
            : null;
          rememberCorpusArtifactRef(artifact?.artifactRef);
          const fallbackArtifactRef = await writeArtifact(
            "session_execute",
            artifactBody,
          );
          const artifactRef = resolveArtifactRef(
            result.result.artifact_ref,
            artifact?.artifactRef,
            fallbackArtifactRef,
          );
          results.push({
            kind: "command",
            result: {
              ...result.result,
              artifact_ref: artifactRef,
              summary:
                `Oversized batch step output moved to local artifact ${artifactRef}.`,
              truncated: true,
            },
          });
          continue;
        }

        results.push({
          kind: "search",
          result: {
            ...result.result,
            results: result.result.results.slice(0, 1).map((item) => ({
              ...item,
              snippet: item.snippet.slice(0, 320),
            })),
            truncated: true,
          },
        });
      }

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
    const effectiveRootSessionId = toolName === "session_search" ||
        toolName === "session_notes_write" ||
        toolName === "session_notes_read"
      ? await resolveCanonicalRootSessionId(context)
      : request.root_session_id;
    await validateRuntimeRootSessionContract(
      toolName,
      {
        ...request,
        root_session_id: effectiveRootSessionId,
      } as SessionMcpRequestMap[TToolName],
      context,
      sessionCanonicalizer,
    );
    await recordToolCall(effectiveRootSessionId, toolName);
    let response = validateResponsePreservingBatchShape(
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
          effectiveRootSessionId,
        ),
      );
    }

    if (toolName === "session_execute_file") {
      response = parseResponse(
        toolName,
        await persistInlineArtifactIfPresent(
          toolName,
          response as SessionMcpResponseMap["session_execute_file"],
          effectiveRootSessionId,
        ),
      );
    }

    let serialized = serialize(response);

    if (!isWithinBudget(serialized)) {
      response = validateResponsePreservingBatchShape(
        toolName,
        await coerceOversizedResponse(
          toolName,
          response,
          effectiveRootSessionId,
        ),
      );
      serialized = serialize(response);
    }

    if (!isWithinBudget(serialized)) {
      throw new Error(
        `${toolName} response exceeded ${SESSION_MCP_RESPONSE_BUDGET_BYTES} bytes`,
      );
    }

    if (toolName === "session_execute") {
      await persistCanonicalLocalArtifactIfNeeded(
        toolName,
        response as SessionMcpResponseMap["session_execute"],
        effectiveRootSessionId,
      );
    }

    if (toolName === "session_execute_file") {
      await persistCanonicalLocalArtifactIfNeeded(
        toolName,
        response as SessionMcpResponseMap["session_execute_file"],
        effectiveRootSessionId,
      );
    }

    await recordReturnedBytes(effectiveRootSessionId, serialized);

    return serialized;
  };

  const descriptions: Record<SessionMcpToolName, string> = {
    session_execute: "Execute a bounded session command.",
    session_execute_file: "Read local files through the session runtime.",
    session_batch_execute: "Execute bounded session commands sequentially.",
    session_index: "Index local content for the current root session.",
    session_search: SESSION_SEARCH_BASELINE_DESCRIPTION,
    session_fetch_and_index:
      "Fetch content and index it for the current root session.",
    session_stats: "Return local session MCP stats.",
    session_doctor: "Return local session MCP health checks.",
    session_notes_write: SESSION_NOTES_WRITE_DESCRIPTION,
    session_notes_read: SESSION_NOTES_READ_DESCRIPTION,
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

  const setSessionCanonicalizer = (
    nextSessionCanonicalizer: RuntimeRootSessionValidator | undefined,
  ): void => {
    sessionCanonicalizer = nextSessionCanonicalizer;
  };

  const migrateRootSessionState = async (
    sourceRootSessionId: string,
    targetRootSessionId: string,
  ): Promise<void> => {
    await corpus?.migrateRootSessionState?.(
      sourceRootSessionId,
      targetRootSessionId,
    );
    await notes.migrateRootSessionState?.(
      sourceRootSessionId,
      targetRootSessionId,
    );
  };

  return {
    tools,
    dispose,
    setSessionCanonicalizer,
    migrateRootSessionState,
  };
};
