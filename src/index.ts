import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { loadConfig } from "./config.ts";
import { createChatHandler } from "./handlers/chat.ts";
import { createCompactingHandler } from "./handlers/compacting.ts";
import { createEventHandler } from "./handlers/event.ts";
import { createMessagesHandler } from "./handlers/messages.ts";
import { SessionManager } from "./session.ts";
import { BatchDrainService } from "./services/batch-drain.ts";
import { GraphitiConnectionManager } from "./services/connection-manager.ts";
import { GraphitiAsyncService } from "./services/graphiti-async.ts";
import { GraphitiMcpClient } from "./services/graphiti-mcp.ts";
import {
  notifyGraphitiAvailabilityIssue,
  setOpenCodeClient,
} from "./services/opencode-warning.ts";
import { RedisCacheService } from "./services/redis-cache.ts";
import { RedisClient } from "./services/redis-client.ts";
import { RedisEventsService } from "./services/redis-events.ts";
import { logger } from "./services/logger.ts";
import { RedisSnapshotService } from "./services/redis-snapshot.ts";
import { registerRuntimeTeardown } from "./services/runtime-teardown.ts";
import { makeGroupId, makeUserGroupId } from "./utils.ts";

type GraphitiDependencies = {
  loadConfig: typeof loadConfig;
  setOpenCodeClient: typeof setOpenCodeClient;
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
  BatchDrainService: typeof BatchDrainService;
  GraphitiAsyncService: typeof GraphitiAsyncService;
  SessionManager: typeof SessionManager;
  createEventHandler: typeof createEventHandler;
  createChatHandler: typeof createChatHandler;
  createCompactingHandler: typeof createCompactingHandler;
  createMessagesHandler: typeof createMessagesHandler;
  makeGroupId: typeof makeGroupId;
  makeUserGroupId: typeof makeUserGroupId;
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
  notifyGraphitiAvailabilityIssue(
    `Graphiti MCP unavailable at ${endpoint}; continuing without persistent memory.`,
    { endpoint },
  );
};

export const warnOnRedisStartupUnavailable = (
  connected: boolean,
  endpoint: string,
): void => {
  if (connected) return;
  notifyGraphitiAvailabilityIssue(
    `Redis unavailable at ${endpoint}; continuing without persistent memory.`,
    { endpoint },
  );
};

const defaultGraphitiDependencies: GraphitiDependencies = {
  loadConfig,
  setOpenCodeClient,
  warnOnGraphitiStartupUnavailable,
  warnOnRedisStartupUnavailable,
  GraphitiConnectionManager,
  RedisClient,
  registerRuntimeTeardown,
  GraphitiMcpClient,
  RedisEventsService,
  RedisSnapshotService,
  RedisCacheService,
  BatchDrainService,
  GraphitiAsyncService,
  SessionManager,
  createEventHandler,
  createChatHandler,
  createCompactingHandler,
  createMessagesHandler,
  makeGroupId,
  makeUserGroupId,
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
    let startupUnavailableReported = false;
    const reportStartupUnavailable = (service: "graphiti" | "redis") => {
      if (startupUnavailableReported) return;
      startupUnavailableReported = true;
      if (service === "graphiti") {
        dependencies.warnOnGraphitiStartupUnavailable(
          false,
          config.graphiti.endpoint,
        );
        return;
      }
      dependencies.warnOnRedisStartupUnavailable(false, config.redis.endpoint);
    };

    const connectionManager = new dependencies.GraphitiConnectionManager({
      endpoint: config.graphiti.endpoint,
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

    const defaultGroupId = dependencies.makeGroupId(
      config.graphiti.groupIdPrefix,
      input.directory,
    );
    const defaultUserGroupId = dependencies.makeUserGroupId(
      config.graphiti.groupIdPrefix,
      input.directory,
    );

    const sessionManager = new dependencies.SessionManager(
      defaultGroupId,
      defaultUserGroupId,
      input.client,
      redisEvents,
      redisSnapshot,
      redisCache,
      {
        idleRetentionMs: config.redis.sessionTtlSeconds * 1000,
      },
    );

    activeRuntimeTeardown = dependencies.registerRuntimeTeardown([
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
        name: "graphiti",
        run: () => connectionManager.stop(),
      },
      {
        name: "redis",
        run: () => redisClient.close(),
      },
    ]);

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
      "chat.message": dependencies.createChatHandler({
        sessionManager,
        redisEvents,
        graphitiAsync,
        drainTriggerSize: config.redis.batchSize,
      }),
      "experimental.session.compacting": dependencies
        .createCompactingHandler({
          sessionManager,
        }),
      "experimental.chat.messages.transform": dependencies
        .createMessagesHandler({
          sessionManager,
        }),
    };
  });

  runtimeInitialization = setup.then(() => undefined, () => undefined);
  return setup;
};
