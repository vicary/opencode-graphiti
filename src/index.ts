import type { Plugin } from "@opencode-ai/plugin";
import type { Event, Part, UserMessage } from "@opencode-ai/sdk";
import { loadConfig } from "./config.ts";
import { GraphitiClient } from "./services/client.ts";
import { formatMemoryContext } from "./services/context.ts";
import {
  detectMemoryTrigger,
  extractMemoryContent,
} from "./services/triggers.ts";
import {
  getCompactionContext,
  handleCompaction,
} from "./services/compaction.ts";
import { logger } from "./services/logger.ts";
import type { SessionState } from "./types/index.ts";

function makeGroupId(prefix: string, directory: string): string {
  const parts = directory.split("/").filter(Boolean);
  const projectName = parts[parts.length - 1] || "default";
  return `${prefix}:${projectName}`;
}

export const graphiti: Plugin = async (input) => {
  const config = loadConfig();
  const client = new GraphitiClient(config.endpoint);
  const sessions = new Map<string, SessionState>();

  const connected = await client.connect();
  if (!connected) {
    logger.warn("Could not connect to Graphiti MCP server at", config.endpoint);
    logger.warn(
      "Memory features will be unavailable until connection is established",
    );
  }

  const defaultGroupId = makeGroupId(config.groupIdPrefix, input.directory);
  logger.info("Plugin initialized. Group ID:", defaultGroupId);

  return {
    event: async ({ event }: { event: Event }) => {
      if (event.type === "session.created") {
        const sessionId = event.properties.info.id;
        sessions.set(sessionId, {
          groupId: defaultGroupId,
          injectedMemories: false,
          messageCount: 0,
        });
        logger.debug("Session created:", sessionId);
      }

      if (event.type === "session.compacted") {
        const sessionId = event.properties.sessionID;
        const summary =
          ((event.properties as Record<string, unknown>).summary as string) ||
          "";
        const state = sessions.get(sessionId);
        if (state && summary) {
          await handleCompaction({
            client,
            config,
            groupId: state.groupId,
            summary,
            sessionId,
          });
        }
      }

      if (event.type === "session.idle") {
        logger.debug("Session idle", event.properties.sessionID);
      }
    },

    "chat.message": async (
      _input,
      output: { message: UserMessage; parts: Part[] },
    ) => {
      const sessionId = _input.sessionID;
      let state = sessions.get(sessionId);
      if (!state) {
        state = {
          groupId: defaultGroupId,
          injectedMemories: false,
          messageCount: 0,
        };
        sessions.set(sessionId, state);
      }

      state.messageCount++;

      const userText = output.parts
        .filter(
          (part): part is Part & { type: "text"; text: string } =>
            part.type === "text" && !part.synthetic,
        )
        .map((part) => part.text)
        .join(" ");

      if (!userText) return;

      if (!state.injectedMemories && config.injectOnFirstMessage) {
        state.injectedMemories = true;

        try {
          const [facts, nodes] = await Promise.all([
            client.searchFacts({
              query: userText,
              groupIds: [state.groupId],
              maxFacts: config.maxFacts,
            }),
            client.searchNodes({
              query: userText,
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

      if (config.enableTriggerDetection) {
        const trigger = detectMemoryTrigger(userText);
        if (trigger.triggered && trigger.content) {
          const content = extractMemoryContent(trigger.content);
          try {
            await client.addEpisode({
              name: `User memory: ${content.slice(0, 50)}`,
              episodeBody: content,
              groupId: state.groupId,
              source: "text",
              sourceDescription:
                "User-triggered memory save from OpenCode session",
            });
            logger.info("Saved user-triggered memory");
          } catch (err) {
            logger.error("Failed to save triggered memory:", err);
          }
        }
      }
    },

    "experimental.session.compacting": async (_input, output) => {
      const sessionId = _input.sessionID;
      const state = sessions.get(sessionId);
      const groupId = state?.groupId || defaultGroupId;

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
