import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Event, Part } from "@opencode-ai/sdk";
import { loadConfig } from "./config.ts";
import { GraphitiClient } from "./services/client.ts";
import {
  type CompactionDependencies,
  createPreemptiveCompactionHandler,
  getCompactionContext,
  handleCompaction,
} from "./services/compaction.ts";
import { formatMemoryContext } from "./services/context.ts";
import { logger } from "./services/logger.ts";

type SessionState = {
  groupId: string;
  injectedMemories: boolean;
  messageCount: number;
  pendingMessages: string[];
  isMain: boolean;
};

export const makeGroupId = (prefix: string, directory?: string): string => {
  const parts = directory?.split("/").filter(Boolean) ?? [];
  const projectName = parts[parts.length - 1] || "default";
  const rawGroupId = `${prefix}_${projectName}`;
  return rawGroupId.replace(/[^A-Za-z0-9_-]/g, "_");
};

const isTextPart = (value: unknown): value is Part & {
  type: "text";
  text: string;
} => {
  if (!value || typeof value !== "object") return false;
  const part = value as Part & { text?: unknown; synthetic?: boolean };
  return part.type === "text" && typeof part.text === "string" &&
    !part.synthetic;
};

const extractTextFromParts = (parts: Part[]): string =>
  parts.filter(isTextPart).map((part) => part.text).join(" ").trim();

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

  const defaultGroupId = makeGroupId(config.groupIdPrefix, input.directory);
  logger.info("Plugin initialized. Group ID:", defaultGroupId);

  const sessions = new Map<string, SessionState>();
  const parentIdCache = new Map<string, string | null>();
  const pendingAssistantMessages = new Map<
    string,
    { sessionId: string; text: string }
  >();
  const bufferedAssistantMessageIds = new Set<string>();

  const resolveParentId = async (
    sessionId: string,
  ): Promise<string | null | undefined> => {
    if (parentIdCache.has(sessionId)) {
      return parentIdCache.get(sessionId) ?? null;
    }
    try {
      const response = await (sdkClient.session.get as unknown as (
        args: { path: { id: string } },
      ) => Promise<unknown>)({
        path: { id: sessionId },
      });
      const sessionInfo = typeof response === "object" && response !== null &&
          "data" in response
        ? (response as { data?: { parentID?: string } }).data
        : (response as { parentID?: string });
      if (!sessionInfo) return undefined;
      const parentId = sessionInfo.parentID ?? null;
      parentIdCache.set(sessionId, parentId);
      return parentId;
    } catch (err) {
      logger.debug("Failed to resolve session parentID", { sessionId, err });
      return undefined;
    }
  };

  const resolveSessionState = async (
    sessionId: string,
  ): Promise<{ state: SessionState | null; resolved: boolean }> => {
    const parentId = await resolveParentId(sessionId);
    if (parentId === undefined) return { state: null, resolved: false };
    if (parentId) {
      sessions.delete(sessionId);
      return { state: null, resolved: true };
    }

    let state = sessions.get(sessionId);
    if (!state) {
      state = {
        groupId: defaultGroupId,
        injectedMemories: false,
        messageCount: 0,
        pendingMessages: [],
        isMain: true,
      };
      sessions.set(sessionId, state);
    }
    return { state, resolved: true };
  };

  const isSubagentSession = async (sessionId: string): Promise<boolean> => {
    const parentId = await resolveParentId(sessionId);
    return !!parentId;
  };

  const fetchLatestAssistantMessage = async (
    sessionId: string,
  ): Promise<{ id?: string; text: string } | null> => {
    try {
      const response = await (sdkClient.session.messages as unknown as (
        args: { sessionID: string; limit?: number },
      ) => Promise<unknown>)({
        sessionID: sessionId,
        limit: 20,
      });
      const payload = response && typeof response === "object" &&
          "data" in response
        ? (response as { data?: unknown }).data
        : response;
      const messages = Array.isArray(payload)
        ? (payload as Array<
          { info: { role?: string; id?: string }; parts: Part[] }
        >)
        : [];
      if (messages.length === 0) return null;
      const lastAssistant = [...messages]
        .reverse()
        .find((message) => message.info?.role === "assistant");
      if (!lastAssistant) return null;
      const text = extractTextFromParts(lastAssistant.parts);
      if (!text) return null;
      return { id: lastAssistant.info?.id, text };
    } catch (err) {
      logger.debug("Failed to list session messages for fallback", {
        sessionId,
        err,
      });
      return null;
    }
  };

  const finalizeAssistantMessage = (
    state: SessionState,
    sessionId: string,
    messageId: string,
    source: string,
  ) => {
    const key = `${sessionId}:${messageId}`;
    if (bufferedAssistantMessageIds.has(key)) return;

    const buffered = pendingAssistantMessages.get(key);
    pendingAssistantMessages.delete(key);
    bufferedAssistantMessageIds.add(key);

    const messageText = buffered?.text?.trim() ?? "";
    const messagePreview = messageText.slice(0, 120);
    logger.info("Assistant message completed", {
      hook: source,
      sessionId,
      messageID: messageId,
      source,
      messageLength: messageText.length,
      preview: messagePreview,
    });

    if (!messageText) {
      logger.debug("Assistant message completed without buffered text", {
        hook: source,
        sessionId,
        messageID: messageId,
        source,
      });
      return;
    }

    state.pendingMessages.push(`Assistant: ${messageText}`);
    logger.info("Buffered assistant reply", {
      hook: source,
      sessionId,
      messageID: messageId,
      source,
      messageLength: messageText.length,
      preview: messagePreview,
    });
  };

  const flushPendingMessages = async (
    sessionId: string,
    sourceDescription: string,
    minBytes: number,
  ) => {
    const state = sessions.get(sessionId);
    if (!state || state.pendingMessages.length === 0) return;

    const lastMessage = state.pendingMessages.at(-1);
    if (lastMessage) {
      const separatorIndex = lastMessage.indexOf(":");
      const role = separatorIndex === -1
        ? lastMessage.trim().toLowerCase()
        : lastMessage.slice(0, separatorIndex).trim().toLowerCase();
      if (role === "user") {
        const fallback = await fetchLatestAssistantMessage(sessionId);
        if (fallback?.text) {
          const fallbackKey = fallback.id
            ? `${sessionId}:${fallback.id}`
            : undefined;
          const alreadyBuffered = fallbackKey
            ? bufferedAssistantMessageIds.has(fallbackKey)
            : state.pendingMessages.some((message) =>
              message.startsWith("Assistant:") &&
              message.includes(fallback.text)
            );
          if (!alreadyBuffered) {
            state.pendingMessages.push(`Assistant: ${fallback.text}`);
            if (fallbackKey) {
              bufferedAssistantMessageIds.add(fallbackKey);
            }
            logger.info("Fallback assistant fetch used", {
              sessionId,
              messageID: fallback.id,
              messageLength: fallback.text.length,
            });
          }
        }
      }
    }

    const combined = state.pendingMessages.join("\n\n");
    if (combined.length < minBytes) return;

    const messagesToFlush = [...state.pendingMessages];
    state.pendingMessages = [];
    const messageLines = messagesToFlush.map((message) => {
      const separatorIndex = message.indexOf(":");
      const role = separatorIndex === -1
        ? "Unknown"
        : message.slice(0, separatorIndex).trim();
      const text = separatorIndex === -1
        ? message
        : message.slice(separatorIndex + 1).trim();
      return `${role}: ${text}`;
    });

    try {
      const name = combined.slice(0, 80).replace(/\n/g, " ");
      logger.info(`Flushing ${messagesToFlush.length} buffered message(s).`);
      logger.info(
        `Buffered message contents:\n${messageLines.join("\n")}`,
        { sessionId },
      );
      await client.addEpisode({
        name: `Buffered messages: ${name}`,
        episodeBody: combined,
        groupId: state.groupId,
        source: "text",
        sourceDescription,
      });
      logger.info("Flushed buffered messages to Graphiti");
    } catch (err) {
      logger.error(`Failed to flush messages for ${sessionId}:`, err);
      const currentState = sessions.get(sessionId);
      if (currentState) {
        currentState.pendingMessages = [
          ...messagesToFlush,
          ...currentState.pendingMessages,
        ];
      }
    }
  };

  const preemptiveCompaction = createPreemptiveCompactionHandler(
    {
      compactionThreshold: config.compactionThreshold,
      minTokensForCompaction: config.minTokensForCompaction,
      compactionCooldownMs: config.compactionCooldownMs,
      autoResumeAfterCompaction: config.autoResumeAfterCompaction,
    },
    {
      sdkClient: sdkClient as CompactionDependencies["sdkClient"],
      directory: input.directory,
    },
  );

  return {
    event: async ({ event }: { event: Event }) => {
      try {
        if (event.type === "session.created") {
          const info = event.properties.info;
          const sessionId = info.id;
          const parentId = info.parentID ?? null;
          const isMain = !parentId;
          parentIdCache.set(sessionId, parentId);

          logger.info("Session created:", {
            sessionId,
            isMain,
            parentID: info.parentID,
          });

          if (isMain) {
            sessions.set(sessionId, {
              groupId: defaultGroupId,
              injectedMemories: false,
              messageCount: 0,
              pendingMessages: [],
              isMain,
            });
          } else {
            logger.debug("Ignoring subagent session:", sessionId);
          }
          return;
        }

        if (event.type === "session.compacted") {
          const sessionId = event.properties.sessionID;
          const { state, resolved } = await resolveSessionState(sessionId);
          if (!resolved) {
            logger.debug("Unable to resolve session compaction:", sessionId);
            return;
          }
          if (!state?.isMain) {
            logger.debug("Ignoring non-main compaction:", sessionId);
            return;
          }

          const summary =
            ((event.properties as Record<string, unknown>).summary as string) ||
            "";

          await flushPendingMessages(
            sessionId,
            "Buffered messages flushed before compaction",
            0,
          );

          if (summary) {
            await handleCompaction({
              client,
              config,
              groupId: state.groupId,
              summary,
              sessionId,
            });
          }
          return;
        }

        if (event.type === "session.idle") {
          const sessionId = event.properties.sessionID;
          const { state, resolved } = await resolveSessionState(sessionId);
          if (!resolved) {
            logger.debug("Unable to resolve idle session:", sessionId);
            return;
          }
          if (!state?.isMain) {
            logger.debug("Ignoring non-main idle session:", sessionId);
            return;
          }

          await flushPendingMessages(
            sessionId,
            "Buffered messages from OpenCode session",
            50,
          );
          return;
        }

        if (event.type === "message.updated") {
          const info = event.properties.info;
          const sessionId = info.sessionID;
          logger.info("Message event fired", {
            hook: "message.updated",
            eventType: "message.updated",
            sessionId,
            role: info.role,
            messageID: info.id,
          });
          const { state, resolved } = await resolveSessionState(sessionId);
          if (!resolved) {
            logger.debug("Unable to resolve session for message update:", {
              sessionId,
              messageID: info.id,
              role: info.role,
            });
            return;
          }
          if (!state?.isMain) {
            logger.debug("Ignoring non-main message update:", sessionId);
            return;
          }
          if (info.role !== "assistant") {
            pendingAssistantMessages.delete(`${sessionId}:${info.id}`);
            return;
          }

          const key = `${sessionId}:${info.id}`;
          const time = info.time as { created: number; completed?: number };
          if (!time?.completed) return;
          if (bufferedAssistantMessageIds.has(key)) return;

          finalizeAssistantMessage(
            state,
            sessionId,
            info.id,
            "message.updated",
          );

          if (info.tokens && info.providerID && info.modelID) {
            preemptiveCompaction
              .checkAndTriggerCompaction(
                sessionId,
                info.tokens as {
                  input: number;
                  output: number;
                  reasoning: number;
                  cache: { read: number; write: number };
                },
                info.providerID as string,
                info.modelID as string,
              )
              .catch((err: unknown) =>
                logger.error("Preemptive compaction check failed", err)
              );
          }
          return;
        }

        if (event.type === "message.part.updated") {
          const part = event.properties.part;
          if (part.type !== "text" || part.synthetic) return;

          const sessionId = part.sessionID;
          const messageId = part.messageID;
          const key = `${sessionId}:${messageId}`;
          pendingAssistantMessages.set(key, {
            sessionId,
            text: part.text,
          });
        }
      } catch (err) {
        logger.error("Event handler error", { type: event.type, err });
      }
    },
    "chat.message": async (
      { sessionID }: { sessionID: string },
      output: {
        allow_buffering?: boolean;
        parts: Part[];
        message: { sessionID: string; id: string };
      },
    ) => {
      if (await isSubagentSession(sessionID)) {
        logger.debug("Ignoring subagent chat message:", sessionID);
        return;
      }
      const { state, resolved } = await resolveSessionState(sessionID);
      if (!resolved) {
        (output as { allow_buffering?: boolean }).allow_buffering = true;
        logger.debug("Unable to resolve session for message:", { sessionID });
        return;
      }

      if (!state?.isMain) {
        logger.debug("Ignoring subagent chat message:", sessionID);
        return;
      }

      state.messageCount++;
      const messageText = extractTextFromParts(output.parts);
      if (!messageText) return;

      state.pendingMessages.push(`User: ${messageText}`);
      logger.info("Buffered user message", {
        hook: "chat.message",
        sessionID,
        messageLength: messageText.length,
      });

      if (!state.injectedMemories && config.injectOnFirstMessage) {
        state.injectedMemories = true;
        try {
          const [facts, nodes] = await Promise.all([
            client.searchFacts({
              query: messageText,
              groupIds: [state.groupId],
              maxFacts: config.maxFacts,
            }),
            client.searchNodes({
              query: messageText,
              groupIds: [state.groupId],
              maxNodes: config.maxNodes,
            }),
          ]);

          const memoryContext = formatMemoryContext(facts, nodes);
          if (memoryContext) {
            output.parts.unshift({
              type: "text",
              text: memoryContext,
              id: `graphiti-memory-${Date.now()}`,
              sessionID: output.message.sessionID,
              messageID: output.message.id,
              synthetic: true,
            } as Part);
            logger.info(
              `Injected ${facts.length} facts and ${nodes.length} nodes`,
            );
          }
        } catch (err) {
          logger.error("Failed to inject memories:", err);
        }
      }
    },
    "experimental.session.compacting": async (
      { sessionID }: { sessionID: string },
      output: { context: string[] },
    ) => {
      const state = sessions.get(sessionID);
      if (!state?.isMain) {
        logger.debug("Ignoring non-main compaction context:", sessionID);
        return;
      }

      const groupId = state.groupId || defaultGroupId;
      const additionalContext = await getCompactionContext({
        client,
        config,
        groupId,
        contextStrings: output.context,
      });

      if (additionalContext.length > 0) {
        output.context.push(...additionalContext);
        logger.info("Injected persistent knowledge into compaction context");
      }
    },
  };
};
