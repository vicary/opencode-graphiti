import type { Hooks } from "@opencode-ai/plugin";
import { extractVisibleUuids } from "../services/context.ts";
import { logger } from "../services/logger.ts";
import type { SessionManager } from "../session.ts";

type MessagesTransformHook = NonNullable<
  Hooks["experimental.chat.messages.transform"]
>;
type MessagesTransformInput = Parameters<MessagesTransformHook>[0];
type MessagesTransformOutput = Parameters<MessagesTransformHook>[1];

export interface MessagesHandlerDeps {
  sessionManager: SessionManager;
}

export function createMessagesHandler(deps: MessagesHandlerDeps) {
  const { sessionManager } = deps;

  // deno-lint-ignore require-await
  return async (
    _input: MessagesTransformInput,
    output: MessagesTransformOutput,
  ) => {
    const lastUserEntry = [...output.messages]
      .reverse()
      .find((message) => message.info.role === "user");
    if (!lastUserEntry) return;

    const sessionID = lastUserEntry.info.sessionID;
    const state = sessionManager.getState(sessionID);
    if (!state?.isMain) {
      logger.debug("Skipping memory injection; not main session", {
        sessionID,
      });
      return;
    }

    const allVisibleUuids: string[] = [];
    for (const entry of output.messages) {
      for (const part of entry.parts) {
        if (part.type === "text" && "text" in part) {
          const uuids = extractVisibleUuids((part as { text: string }).text);
          if (uuids.length > 0) {
            logger.debug("Found <memory> block UUIDs", {
              sessionID,
              uuids,
              messageID: entry.info.id,
            });
          }
          allVisibleUuids.push(...uuids);
        }
      }
    }
    state.visibleFactUuids = [...new Set(allVisibleUuids)];
    logger.debug("Updated visibleFactUuids from message scan", {
      sessionID,
      visibleCount: state.visibleFactUuids.length,
    });

    if (!state.cachedMemoryContext) {
      logger.debug("Skipping memory injection; no cached context", {
        sessionID,
      });
      return;
    }

    const textPart = lastUserEntry.parts.find(
      (part): part is typeof part & { type: "text"; text: string } =>
        part.type === "text" && "text" in part,
    );
    if (!textPart) {
      logger.debug("Skipping memory injection; no text part", {
        sessionID,
      });
      return;
    }

    if (textPart.text.includes("<memory")) {
      logger.debug("Skipping memory injection; already injected", {
        sessionID,
      });
      state.cachedMemoryContext = undefined;
      state.cachedFactUuids = undefined;
      return;
    }

    const uuids = state.cachedFactUuids ?? [];
    const uuidAttr = uuids.length > 0 ? ` data-uuids="${uuids.join(",")}"` : "";
    const memoryBlock =
      `<memory${uuidAttr}>\n${state.cachedMemoryContext}\n</memory>`;

    textPart.text = `${memoryBlock}\n\n${textPart.text}`;

    logger.info("Injected memory context into last user message", {
      sessionID,
      factCount: uuids.length,
      blockLength: memoryBlock.length,
      preview: state.cachedMemoryContext.slice(0, 100),
    });

    state.cachedMemoryContext = undefined;
    state.cachedFactUuids = undefined;
  };
}
