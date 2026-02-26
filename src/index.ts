import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { loadConfig } from "./config.ts";
import { createChatHandler } from "./handlers/chat.ts";
import { createCompactingHandler } from "./handlers/compacting.ts";
import { createEventHandler } from "./handlers/event.ts";
import { createMessagesHandler } from "./handlers/messages.ts";
import { GraphitiClient } from "./services/client.ts";
import { logger } from "./services/logger.ts";
import { SessionManager } from "./session.ts";
import { makeGroupId, makeUserGroupId } from "./utils.ts";

/**
 * OpenCode plugin entry point for Graphiti memory integration.
 */
export const graphiti: Plugin = async (input: PluginInput) => {
  const config = loadConfig();
  const client = new GraphitiClient(config.endpoint);
  const sdkClient = input.client;

  const connected = await client.connect();
  if (!connected) {
    logger.warn("Could not connect to Graphiti MCP server at", config.endpoint);
    logger.warn(
      "Memory features will be unavailable until connection is established",
    );
  }

  const defaultGroupId = makeGroupId(
    config.groupIdPrefix,
    input.directory,
  );
  const defaultUserGroupId = makeUserGroupId(
    config.groupIdPrefix,
    input.directory,
  );
  logger.info("Plugin initialized. Group ID:", defaultGroupId);

  const sessionManager = new SessionManager(
    defaultGroupId,
    defaultUserGroupId,
    sdkClient,
    client,
  );

  return {
    event: createEventHandler({
      sessionManager,
      client,
      defaultGroupId,
      sdkClient,
      directory: input.directory,
      groupIdPrefix: config.groupIdPrefix,
    }),
    "chat.message": createChatHandler({
      sessionManager,
      driftThreshold: config.driftThreshold,
      factStaleDays: config.factStaleDays,
      client,
    }),
    "experimental.session.compacting": createCompactingHandler({
      sessionManager,
      client,
      defaultGroupId,
      factStaleDays: config.factStaleDays,
    }),
    "experimental.chat.messages.transform": createMessagesHandler({
      sessionManager,
    }),
  };
};
