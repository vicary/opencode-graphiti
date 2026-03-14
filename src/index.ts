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
import { RedisSnapshotService } from "./services/redis-snapshot.ts";
import { registerRuntimeTeardown } from "./services/runtime-teardown.ts";
import { makeGroupId, makeUserGroupId } from "./utils.ts";

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

export const graphiti: Plugin = (input: PluginInput) => {
  const config = loadConfig(input.directory);
  setOpenCodeClient(input.client);

  const connectionManager = new GraphitiConnectionManager({
    endpoint: config.graphiti.endpoint,
  });
  connectionManager.start();
  void connectionManager.ready().then((connected) => {
    warnOnGraphitiStartupUnavailable(connected, config.graphiti.endpoint);
  });

  const redisClient = new RedisClient({
    endpoint: config.falkordb.redisEndpoint,
  });
  void redisClient.connect();
  registerRuntimeTeardown([
    {
      name: "redis",
      run: () => redisClient.close(),
    },
    {
      name: "graphiti",
      run: () => connectionManager.stop(),
    },
  ]);

  const graphitiClient = new GraphitiMcpClient(connectionManager);
  const redisEvents = new RedisEventsService(redisClient, {
    sessionTtlSeconds: config.falkordb.sessionTtlSeconds,
  });
  const redisSnapshot = new RedisSnapshotService(redisClient, {
    ttlSeconds: config.falkordb.sessionTtlSeconds * 2,
  });
  const redisCache = new RedisCacheService(redisClient, {
    ttlSeconds: config.falkordb.cacheTtlSeconds,
    driftThreshold: config.graphiti.driftThreshold,
  });
  const batchDrain = new BatchDrainService(redisClient, redisEvents, {
    batchSize: config.falkordb.batchSize,
    batchMaxBytes: config.falkordb.batchMaxBytes,
    drainRetryMax: config.falkordb.drainRetryMax,
  });
  const graphitiAsync = new GraphitiAsyncService(
    graphitiClient,
    redisCache,
    batchDrain,
  );

  const defaultGroupId = makeGroupId(
    config.graphiti.groupIdPrefix,
    input.directory,
  );
  const defaultUserGroupId = makeUserGroupId(
    config.graphiti.groupIdPrefix,
    input.directory,
  );

  const sessionManager = new SessionManager(
    defaultGroupId,
    defaultUserGroupId,
    input.client,
    redisEvents,
    redisSnapshot,
    redisCache,
    {
      idleRetentionMs: config.falkordb.sessionTtlSeconds * 1000,
    },
  );

  return Promise.resolve({
    event: createEventHandler({
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
    "chat.message": createChatHandler({
      sessionManager,
      redisEvents,
      graphitiAsync,
      drainTriggerSize: config.falkordb.batchSize,
    }),
    "experimental.session.compacting": createCompactingHandler({
      sessionManager,
    }),
    "experimental.chat.messages.transform": createMessagesHandler({
      sessionManager,
    }),
  });
};
