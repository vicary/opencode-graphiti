import type { Hooks } from "@opencode-ai/plugin";
import { logger } from "../services/logger.ts";
import type { SessionManager } from "../session.ts";
import { isTextPart } from "../utils.ts";

type MessagesTransformHook = NonNullable<
  Hooks["experimental.chat.messages.transform"]
>;
type MessagesTransformInput = Parameters<MessagesTransformHook>[0];
type MessagesTransformOutput = Parameters<MessagesTransformHook>[1];

export interface MessagesHandlerDeps {
  sessionManager: SessionManager;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const getTransformMessage = (input: unknown): string | undefined => {
  const message = asRecord(input)?.message;
  return typeof message === "string" ? message : undefined;
};

const getLatestUserText = (
  output: MessagesTransformOutput,
): string | undefined => {
  const lastUserEntry = output.messages
    .findLast((message) => message.info.role === "user");
  const textPart = lastUserEntry?.parts.find(isTextPart);
  return textPart?.text;
};

const extractVisibleUuids = (text: string): string[] => {
  const uuids: string[] = [];
  for (
    const regex of [
      /<memory[^>]*\bdata-uuids="([^"]*)"[^>]*>/g,
      /<persistent_memory[^>]*\bfact_uuids="([^"]*)"[^>]*>/g,
    ]
  ) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match[1]) uuids.push(...match[1].split(",").filter(Boolean));
    }
  }
  return uuids;
};

export function createMessagesHandler(deps: MessagesHandlerDeps) {
  const { sessionManager } = deps;

  return async (
    input: MessagesTransformInput,
    output: MessagesTransformOutput,
  ) => {
    const lastUserEntry = output.messages
      .findLast((message) => message.info.role === "user");
    if (!lastUserEntry) return;

    const sessionID = lastUserEntry.info.sessionID;
    const state = sessionManager.getState(sessionID);
    if (!state?.isMain) return;

    const allVisibleUuids: string[] = [];
    for (const entry of output.messages) {
      for (const part of entry.parts) {
        if (isTextPart(part)) {
          allVisibleUuids.push(...extractVisibleUuids(part.text));
        }
      }
    }
    state.visibleFactUuids = [...new Set(allVisibleUuids)];

    const recallQuery = getTransformMessage(input) ?? getLatestUserText(output);
    const prepared = state.pendingInjection ??
      await sessionManager.prepareInjection(
        sessionID,
        recallQuery,
        state.visibleFactUuids,
      );
    if (!prepared) return;

    const textPart = lastUserEntry.parts.find(isTextPart);
    if (!textPart) return;
    if (textPart.text.includes("<session_memory")) {
      if (state.pendingInjection === prepared) {
        state.pendingInjection = undefined;
      }
      return;
    }

    textPart.text = `${prepared.envelope}\n\n${textPart.text}`;
    logger.info("Injected canonical session_memory block", {
      sessionID,
      factCount: prepared.factUuids.length,
    });
    if (state.pendingInjection === prepared) {
      state.pendingInjection = undefined;
    }
  };
}
