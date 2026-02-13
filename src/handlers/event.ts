import type { Hooks } from "@opencode-ai/plugin";
import type { GraphitiClient } from "../services/client.ts";
import { handleCompaction } from "../services/compaction.ts";
import type { ProviderListClient } from "../services/context-limit.ts";
import { resolveContextLimit } from "../services/context-limit.ts";
import { logger } from "../services/logger.ts";
import type { SessionManager } from "../session.ts";
import { isTextPart, makeUserGroupId } from "../utils.ts";

type EventHook = NonNullable<Hooks["event"]>;
type EventInput = Parameters<EventHook>[0];

/** Dependencies for the event handler. */
export interface EventHandlerDeps {
  sessionManager: SessionManager;
  client: GraphitiClient;
  defaultGroupId: string;
  sdkClient: ProviderListClient;
  directory: string;
  groupIdPrefix: string;
}

/** Creates the `event` hook handler. */
export function createEventHandler(deps: EventHandlerDeps) {
  const {
    sessionManager,
    client,
    defaultGroupId,
    sdkClient,
    directory,
    groupIdPrefix,
  } = deps;
  const defaultUserGroupId = makeUserGroupId(groupIdPrefix);

  const buildSessionSnapshot = (
    sessionId: string,
    messages: string[],
  ): string => {
    const recentMessages = messages.slice(-12);
    const recentAssistant = [...recentMessages]
      .reverse()
      .find((message) => message.startsWith("Assistant:"))
      ?.replace(/^Assistant:\s*/, "")
      .trim();
    const recentUser = [...recentMessages]
      .reverse()
      .find((message) => message.startsWith("User:"))
      ?.replace(/^User:\s*/, "")
      .trim();
    const questionRegex = /[^\n\r?]{3,200}\?/g;
    const questions = recentMessages
      .flatMap((message) => {
        const text = message.replace(/^(User|Assistant):\s*/, "");
        return text.match(questionRegex) ?? [];
      })
      .map((question) => question.trim());

    const uniqueQuestions = Array.from(new Set(questions)).slice(0, 6);
    const lines: string[] = [];
    lines.push(`Session ${sessionId} working snapshot`);
    if (recentUser) lines.push(`Recent user focus: ${recentUser}`);
    if (recentAssistant) {
      lines.push(`Recent assistant focus: ${recentAssistant}`);
    }
    if (uniqueQuestions.length > 0) {
      lines.push("Open questions:");
      for (const question of uniqueQuestions) {
        lines.push(`- ${question}`);
      }
    }
    return lines.join("\n");
  };

  return async ({ event }: EventInput) => {
    try {
      if (event.type === "session.created") {
        const info = event.properties.info;
        const sessionId = info.id;
        const parentId = info.parentID ?? null;
        const isMain = !parentId;
        sessionManager.setParentId(sessionId, parentId);

        logger.info("Session created:", {
          sessionId,
          isMain,
          parentID: info.parentID,
        });

        if (isMain) {
          sessionManager.setState(sessionId, {
            groupId: defaultGroupId,
            userGroupId: defaultUserGroupId,
            injectedMemories: false,
            lastInjectionFactUuids: new Set(),
            messageCount: 0,
            pendingMessages: [],
            contextLimit: 200_000,
            isMain,
          });
        } else {
          logger.debug("Ignoring subagent session:", sessionId);
        }
        return;
      }

      if (event.type === "session.compacted") {
        const sessionId = event.properties.sessionID;
        const { state, resolved } = await sessionManager.resolveSessionState(
          sessionId,
        );
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

        await sessionManager.flushPendingMessages(
          sessionId,
          "Buffered messages flushed before compaction",
          0,
        );

        if (summary) {
          await handleCompaction({
            client,
            groupId: state.groupId,
            summary,
            sessionId,
          });
        }
        return;
      }

      if (event.type === "session.idle") {
        const sessionId = event.properties.sessionID;
        const { state, resolved } = await sessionManager.resolveSessionState(
          sessionId,
        );
        if (!resolved) {
          logger.debug("Unable to resolve idle session:", sessionId);
          return;
        }
        if (!state?.isMain) {
          logger.debug("Ignoring non-main idle session:", sessionId);
          return;
        }

        try {
          const snapshotContent = buildSessionSnapshot(
            sessionId,
            state.pendingMessages,
          );
          if (snapshotContent.trim()) {
            await client.addEpisode({
              name: `Snapshot: ${sessionId}`,
              episodeBody: snapshotContent,
              groupId: state.groupId,
              source: "text",
              sourceDescription: "session-snapshot",
            });
            logger.info("Saved session snapshot", { sessionId });
          }
        } catch (err) {
          logger.error("Failed to save session snapshot", { sessionId, err });
        }

        await sessionManager.flushPendingMessages(
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
        const { state, resolved } = await sessionManager.resolveSessionState(
          sessionId,
        );
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
          sessionManager.deletePendingAssistant(sessionId, info.id);
          return;
        }

        const time = info.time as { created: number; completed?: number };
        if (!time?.completed) return;
        if (sessionManager.isAssistantBuffered(sessionId, info.id)) return;

        sessionManager.finalizeAssistantMessage(
          state,
          sessionId,
          info.id,
          "message.updated",
        );

        if (info.tokens && info.providerID && info.modelID) {
          resolveContextLimit(
            info.providerID as string,
            info.modelID as string,
            sdkClient,
            directory,
          )
            .then((limit) => {
              state.contextLimit = limit;
            })
            .catch((err) =>
              logger.debug("Failed to resolve context limit", err)
            );
        }
        return;
      }

      if (event.type === "message.part.updated") {
        const part = event.properties.part;
        if (!isTextPart(part)) return;

        const sessionId = part.sessionID;
        const messageId = part.messageID;
        sessionManager.bufferAssistantPart(sessionId, messageId, part.text);
      }
    } catch (err) {
      logger.error("Event handler error", { type: event.type, err });
    }
  };
}
