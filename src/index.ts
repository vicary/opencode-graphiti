import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { loadConfig } from "./config.ts";
import { createChatHandler } from "./handlers/chat.ts";
import { createCompactingHandler } from "./handlers/compacting.ts";
import { createEventHandler } from "./handlers/event.ts";
import { createMessagesHandler } from "./handlers/messages.ts";
import { createToolAfterHandler } from "./handlers/tool-after.ts";
import { createToolBeforeHandler } from "./handlers/tool-before.ts";
import { SessionManager } from "./session.ts";
import { BatchDrainService } from "./services/batch-drain.ts";
import { GraphitiConnectionManager } from "./services/connection-manager.ts";
import { GraphitiAsyncService } from "./services/graphiti-async.ts";
import { GraphitiMcpClient } from "./services/graphiti-mcp.ts";
import { redactEndpointUserInfo } from "./services/endpoint-redaction.ts";
import {
  notifyDreamShutdownDelay,
  notifyGraphitiAvailabilityIssue,
  setOpenCodeClient,
} from "./services/opencode-warning.ts";
import { RedisCacheService } from "./services/redis-cache.ts";
import { RedisClient } from "./services/redis-client.ts";
import { RedisEventsService } from "./services/redis-events.ts";
import { DreamStore } from "./services/dream-store.ts";
import { logger } from "./services/logger.ts";
import { SessionNotesService } from "./services/session-notes.ts";
import { RedisSnapshotService } from "./services/redis-snapshot.ts";
import { registerRuntimeTeardown } from "./services/runtime-teardown.ts";
import { createSessionExecutor } from "./services/session-executor.ts";
import {
  createSessionMcpRuntime,
  SESSION_SEARCH_STRENGTHENED_DESCRIPTION,
} from "./services/session-mcp-runtime.ts";
import { ToolGuidanceCache } from "./services/tool-guidance-cache.ts";
import { ToolRoutingOutcomeCache } from "./services/tool-routing-outcome-cache.ts";
import { makeGroupId, makeUserGroupId } from "./utils.ts";

type BiasState = "normal" | "new-session" | "post-compaction";

type ChatMessageHook = NonNullable<Hooks["chat.message"]>;
type ChatMessageInput = Parameters<ChatMessageHook>[0];
type ChatMessageOutput = Parameters<ChatMessageHook>[1];
type CompactingHook = NonNullable<Hooks["experimental.session.compacting"]>;
type CompactingInput = Parameters<CompactingHook>[0];
type CompactingOutput = Parameters<CompactingHook>[1];
type ToolDefinitionHook = NonNullable<Hooks["tool.definition"]>;
type ToolDefinitionInput = Parameters<ToolDefinitionHook>[0];
type ToolDefinitionOutput = Parameters<ToolDefinitionHook>[1];

type TrackedRootSessionManager = {
  getTrackedRootSessionIds?: () => string[];
  sessions?: Map<string, { isMain?: boolean }>;
};

const getTrackedRootSessionIds = (sessionManager: unknown): string[] => {
  const manager = sessionManager as TrackedRootSessionManager;
  const tracked = manager.getTrackedRootSessionIds;
  if (typeof tracked === "function") {
    return tracked.call(sessionManager);
  }
  if (!(manager.sessions instanceof Map)) return [];
  return [...manager.sessions.entries()]
    .filter(([, state]) => state?.isMain)
    .map(([sessionId]) => sessionId);
};

type GraphitiDependencies = {
  loadConfig: typeof loadConfig;
  setOpenCodeClient: typeof setOpenCodeClient;
  notifyDreamShutdownDelay: typeof notifyDreamShutdownDelay;
  warnOnGraphitiStartupUnavailable: (
    connected: boolean,
    endpoint: string,
  ) => void;
  warnOnRedisStartupUnavailable: (
    connected: boolean,
    endpoint: string,
  ) => void;
  GraphitiConnectionManager: typeof GraphitiConnectionManager;
  RedisClient: typeof RedisClient;
  registerRuntimeTeardown: typeof registerRuntimeTeardown;
  GraphitiMcpClient: typeof GraphitiMcpClient;
  RedisEventsService: typeof RedisEventsService;
  RedisSnapshotService: typeof RedisSnapshotService;
  RedisCacheService: typeof RedisCacheService;
  DreamStore: typeof DreamStore;
  SessionNotesService: typeof SessionNotesService;
  BatchDrainService: typeof BatchDrainService;
  GraphitiAsyncService: typeof GraphitiAsyncService;
  createSessionExecutor: typeof createSessionExecutor;
  createSessionMcpRuntime: typeof createSessionMcpRuntime;
  SessionManager: typeof SessionManager;
  createEventHandler: typeof createEventHandler;
  createChatHandler: typeof createChatHandler;
  createCompactingHandler: typeof createCompactingHandler;
  createMessagesHandler: typeof createMessagesHandler;
  createToolBeforeHandler: typeof createToolBeforeHandler;
  createToolAfterHandler: typeof createToolAfterHandler;
  ToolGuidanceCache: typeof ToolGuidanceCache;
  ToolRoutingOutcomeCache: typeof ToolRoutingOutcomeCache;
  makeGroupId: typeof makeGroupId;
  makeUserGroupId: typeof makeUserGroupId;
  now: () => string;
};

let activeRuntimeTeardown:
  | ReturnType<typeof registerRuntimeTeardown>
  | null = null;
let runtimeInitialization = Promise.resolve();

export const warnOnGraphitiStartupUnavailable = (
  connected: boolean,
  endpoint: string,
): void => {
  if (connected) return;
  const redactedEndpoint = redactEndpointUserInfo(endpoint);
  notifyGraphitiAvailabilityIssue(
    `Graphiti MCP unavailable at ${redactedEndpoint}; continuing without persistent memory.`,
    { endpoint: redactedEndpoint },
  );
};

export const warnOnRedisStartupUnavailable = (
  connected: boolean,
  endpoint: string,
): void => {
  if (connected) return;
  const redactedEndpoint = redactEndpointUserInfo(endpoint);
  notifyGraphitiAvailabilityIssue(
    `Redis unavailable at ${redactedEndpoint}; continuing with in-memory hot-tier fallback.`,
    { endpoint: redactedEndpoint },
  );
};

const defaultGraphitiDependencies: GraphitiDependencies = {
  loadConfig,
  setOpenCodeClient,
  notifyDreamShutdownDelay,
  warnOnGraphitiStartupUnavailable,
  warnOnRedisStartupUnavailable,
  GraphitiConnectionManager,
  RedisClient,
  registerRuntimeTeardown,
  GraphitiMcpClient,
  RedisEventsService,
  RedisSnapshotService,
  RedisCacheService,
  DreamStore,
  SessionNotesService,
  BatchDrainService,
  GraphitiAsyncService,
  createSessionExecutor,
  createSessionMcpRuntime,
  SessionManager,
  createEventHandler,
  createChatHandler,
  createCompactingHandler,
  createMessagesHandler,
  createToolBeforeHandler,
  createToolAfterHandler,
  ToolGuidanceCache,
  ToolRoutingOutcomeCache,
  makeGroupId,
  makeUserGroupId,
  now: () => new Date().toISOString(),
};

export const graphiti: Plugin = (
  input: PluginInput,
  dependencies: GraphitiDependencies = defaultGraphitiDependencies,
) => {
  const setup = runtimeInitialization.then(async () => {
    const previousTeardown = activeRuntimeTeardown;
    activeRuntimeTeardown = null;
    previousTeardown?.dispose();
    if (previousTeardown) {
      try {
        await previousTeardown.run();
      } catch (err) {
        logger.warn("Previous runtime teardown rejected", err);
      }
    }

    const config = dependencies.loadConfig(input.directory);
    dependencies.setOpenCodeClient(input.client);
    let graphitiStartupUnavailableReported = false;
    let redisStartupUnavailableReported = false;
    const reportStartupUnavailable = (service: "graphiti" | "redis") => {
      if (service === "graphiti") {
        if (graphitiStartupUnavailableReported) return;
        graphitiStartupUnavailableReported = true;
        dependencies.warnOnGraphitiStartupUnavailable(
          false,
          config.graphiti.endpoint,
        );
        return;
      }
      if (redisStartupUnavailableReported) return;
      redisStartupUnavailableReported = true;
      dependencies.warnOnRedisStartupUnavailable(false, config.redis.endpoint);
    };

    const startupCleanupTasks: Array<{
      name: string;
      run: () => void | Promise<void>;
    }> = [];
    let startupTeardown: ReturnType<typeof registerRuntimeTeardown> | null =
      null;

    try {
      const connectionManager = new dependencies.GraphitiConnectionManager({
        endpoint: config.graphiti.endpoint,
      });
      startupCleanupTasks.unshift({
        name: "graphiti",
        run: () => connectionManager.stop(),
      });
      connectionManager.start();
      void connectionManager.ready()
        .then((connected) => {
          if (!connected) {
            reportStartupUnavailable("graphiti");
          }
        })
        .catch(() => {
          reportStartupUnavailable("graphiti");
        });

      const redisClient = new dependencies.RedisClient({
        endpoint: config.redis.endpoint,
      });
      startupCleanupTasks.unshift({
        name: "redis",
        run: () => redisClient.close(),
      });
      void redisClient.connect()
        .catch(() => {
          reportStartupUnavailable("redis");
        });
      const graphitiClient = new dependencies.GraphitiMcpClient(
        connectionManager,
      );
      const redisEvents = new dependencies.RedisEventsService(redisClient, {
        sessionTtlSeconds: config.redis.sessionTtlSeconds,
      });
      const redisSnapshot = new dependencies.RedisSnapshotService(redisClient, {
        ttlSeconds: config.redis.sessionTtlSeconds * 2,
      });
      const redisCache = new dependencies.RedisCacheService(redisClient, {
        ttlSeconds: config.redis.cacheTtlSeconds,
        driftThreshold: config.graphiti.driftThreshold,
      });
      const dreamStore = new dependencies.DreamStore(redisClient);
      const defaultGroupId = dependencies.makeGroupId(
        config.graphiti.groupIdPrefix,
        input.directory,
      );
      const defaultUserGroupId = dependencies.makeUserGroupId(
        config.graphiti.groupIdPrefix,
        input.directory,
      );
      const notesService = new dependencies.SessionNotesService(redisClient, {
        groupId: defaultGroupId,
      });
      const batchDrain = new dependencies.BatchDrainService(
        redisClient,
        redisEvents,
        {
          batchSize: config.redis.batchSize,
          batchMaxBytes: config.redis.batchMaxBytes,
          drainRetryMax: config.redis.drainRetryMax,
        },
      );
      const graphitiAsync = new dependencies.GraphitiAsyncService(
        graphitiClient,
        redisCache,
        batchDrain,
      );
      startupCleanupTasks.unshift({
        name: "graphiti-async",
        run: () => graphitiAsync.dispose(),
      });
      const sessionExecutor = dependencies.createSessionExecutor();
      const sessionMcpRuntime = dependencies.createSessionMcpRuntime({
        redisClient,
        graphitiCache: redisCache,
        notesService,
        sessionTtlSeconds: config.redis.sessionTtlSeconds,
        groupId: defaultGroupId,
        sessionExecutor,
        createSessionExecutor: dependencies.createSessionExecutor,
      });
      startupCleanupTasks.unshift({
        name: "session-mcp-runtime",
        run: () => sessionMcpRuntime.dispose(),
      });

      const sessionManager = new dependencies.SessionManager(
        defaultGroupId,
        defaultUserGroupId,
        input.client,
        redisEvents,
        redisSnapshot,
        redisCache,
        {
          idleRetentionMs: config.redis.sessionTtlSeconds * 1000,
          notesService,
          runtimeStateMigrator: sessionMcpRuntime,
        },
      );
      sessionMcpRuntime.setSessionCanonicalizer(sessionManager);
      const toolGuidanceCache = new dependencies.ToolGuidanceCache();
      const toolRoutingOutcomes = new dependencies.ToolRoutingOutcomeCache();
      const sessionBiasState = new Map<string, BiasState>();
      const chatHandler = dependencies.createChatHandler({
        sessionManager,
        redisEvents,
        graphitiAsync,
        drainTriggerSize: config.redis.batchSize,
      });
      const compactingHandler = dependencies
        .createCompactingHandler({
          sessionManager,
        });

      startupTeardown = dependencies.registerRuntimeTeardown([
        {
          name: "dream-shutdown-warning",
          run: async () => {
            const targetWatermark = dependencies.now();
            for (
              const rootSessionId of getTrackedRootSessionIds(sessionManager)
            ) {
              const watermark = await dreamStore.getWatermark(rootSessionId);
              if (watermark === null || watermark < targetWatermark) {
                dependencies.notifyDreamShutdownDelay();
                return;
              }
            }
          },
        },
        {
          name: "graphiti-drain-flush",
          run: () =>
            graphitiAsync.flushPendingGroups(
              sessionManager.getTrackedGroupIds(),
            ),
        },
        {
          name: "graphiti-async",
          run: () => graphitiAsync.dispose(),
        },
        {
          name: "session-mcp-runtime",
          run: () => sessionMcpRuntime.dispose(),
        },
        {
          name: "graphiti",
          run: () => connectionManager.stop(),
        },
        {
          name: "redis",
          run: () => redisClient.close(),
        },
      ]);
      activeRuntimeTeardown = startupTeardown;

      return {
        event: dependencies.createEventHandler({
          sessionManager,
          redisEvents,
          redisCache,
          redisSnapshot,
          graphitiAsync,
          defaultGroupId,
          defaultUserGroupId,
          sdkClient: input.client,
          directory: input.directory,
        }),
        "chat.message": async (
          hookInput: ChatMessageInput,
          output: ChatMessageOutput,
        ) => {
          const canonicalSessionId = sessionManager.getCachedCanonicalSessionId(
            hookInput.sessionID,
          ) ??
            await sessionManager.resolveCanonicalSessionId(hookInput.sessionID);
          if (canonicalSessionId && !sessionBiasState.has(canonicalSessionId)) {
            const priorEvents = await redisEvents.getRecentSessionEvents(
              canonicalSessionId,
              1,
              false,
            );
            if (priorEvents.length === 0) {
              sessionBiasState.set(canonicalSessionId, "new-session");
            }
          }
          await chatHandler(hookInput, output);
        },
        "experimental.session.compacting": async (
          hookInput: CompactingInput,
          output: CompactingOutput,
        ) => {
          const canonicalSessionId = sessionManager.getCachedCanonicalSessionId(
            hookInput.sessionID,
          ) ??
            await sessionManager.resolveCanonicalSessionId(hookInput.sessionID);
          if (canonicalSessionId) {
            sessionBiasState.set(canonicalSessionId, "post-compaction");
          }
          await compactingHandler(hookInput, output);
        },
        "experimental.chat.messages.transform": dependencies
          .createMessagesHandler({
            sessionManager,
          }),
        tool: sessionMcpRuntime.tools,
        "tool.definition": (
          hookInput: ToolDefinitionInput,
          output: ToolDefinitionOutput,
        ) => {
          if (hookInput.toolID !== "session_search") return Promise.resolve();

          let anyBiased = false;
          for (const [sessionId, state] of sessionBiasState) {
            if (state === "normal") continue;
            anyBiased = true;
            sessionBiasState.delete(sessionId);
          }

          if (anyBiased) {
            output.description = SESSION_SEARCH_STRENGTHENED_DESCRIPTION;
          }
          return Promise.resolve();
        },
        "tool.execute.before": dependencies.createToolBeforeHandler({
          sessionCanonicalizer: sessionManager,
          guidanceThrottle: toolGuidanceCache,
          routingOutcomes: toolRoutingOutcomes,
        }),
        "tool.execute.after": dependencies.createToolAfterHandler({
          routingOutcomes: toolRoutingOutcomes,
        }),
      };
    } catch (err) {
      if (startupTeardown) {
        if (activeRuntimeTeardown === startupTeardown) {
          activeRuntimeTeardown = null;
        }
        startupTeardown.dispose();
        try {
          await startupTeardown.run();
        } catch (cleanupErr) {
          logger.warn("Runtime setup cleanup rejected", cleanupErr);
        }
      } else {
        for (const task of startupCleanupTasks) {
          try {
            await task.run();
          } catch (cleanupErr) {
            logger.warn("Runtime setup cleanup failed", {
              resource: task.name,
              err: cleanupErr,
            });
          }
        }
      }
      throw err;
    }
  });

  runtimeInitialization = setup.then(() => undefined, () => undefined);
  return setup;
};
