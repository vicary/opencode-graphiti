import type { Hooks } from "@opencode-ai/plugin";
import { logger } from "../services/logger.ts";
import {
  escapeXml,
  sanitizeMemoryInput,
  sanitizeMemoryInputPreservingMemoryBlocks,
  stripInjectedMemoryBlocks,
} from "../services/render-utils.ts";
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

const LEADING_SESSION_MEMORY_BLOCK =
  /^<session_memory\b[^>]*>[\s\S]*?<\/session_memory>(?:\r?\n){0,2}/;
const LEADING_INJECTED_LEGACY_MEMORY_BLOCK_WITH_UUIDS =
  /^<memory\b(?=[^>]*\bdata-uuids=(["'])(?:[^"']*)\1)[^>]*>[\s\S]*?<\/memory>(?:\r?\n){0,2}/;
const LEADING_INJECTED_EMPTY_LEGACY_MEMORY_BLOCK =
  /^<memory\b(?![^>]*\bdata-uuids=)[^>]*>\s*<\/memory>(?:\r?\n){0,2}/;
const LEADING_PERSISTENT_MEMORY_BLOCK =
  /^<persistent_memory\b[^>]*>[\s\S]*?<\/persistent_memory>(?:\r?\n){0,2}/;
const SESSION_MEMORY_SOURCE_ATTR_PATTERN =
  /<session_memory\b[^>]*\bsource=(['"])[^'"]+\1/i;
const SESSION_MEMORY_GENERATED_SECTION_PATTERN =
  /<(?:session_snapshot|persistent_memory)\b/i;
const PERSISTENT_MEMORY_GENERATED_CONTENT_PATTERN = /<(?:node|fact|episode)\b/i;
const USER_MEMORY_ENVELOPE_TAG_PATTERN =
  /<\/?(?:session_memory|memory|persistent_memory)\b[^>]*>/gi;

const looksLikeInjectedSessionMemoryBlock = (
  block: string,
  allowAttrlessFollowup: boolean,
): boolean =>
  SESSION_MEMORY_SOURCE_ATTR_PATTERN.test(block) ||
  SESSION_MEMORY_GENERATED_SECTION_PATTERN.test(block) ||
  allowAttrlessFollowup;

const looksLikeInjectedPersistentMemoryBlock = (block: string): boolean =>
  PERSISTENT_MEMORY_GENERATED_CONTENT_PATTERN.test(block);

const scrubPromptMemoryText = (text: string): string => {
  let scrubbed = text;
  let scrubbedInjectedPrefix = false;

  while (true) {
    const leadingSessionMemory = scrubbed.match(LEADING_SESSION_MEMORY_BLOCK)
      ?.[0];
    if (
      leadingSessionMemory &&
      // Once we have confirmed an injected prefix, immediately following
      // attrless session_memory blocks are treated as stale reinjections too.
      looksLikeInjectedSessionMemoryBlock(
        leadingSessionMemory,
        scrubbedInjectedPrefix,
      )
    ) {
      scrubbed = scrubbed.slice(leadingSessionMemory.length);
      scrubbedInjectedPrefix = true;
      continue;
    }

    const next = scrubbed
      .replace(LEADING_INJECTED_LEGACY_MEMORY_BLOCK_WITH_UUIDS, "")
      .replace(LEADING_INJECTED_EMPTY_LEGACY_MEMORY_BLOCK, "");
    if (next !== scrubbed) {
      scrubbed = next;
      scrubbedInjectedPrefix = true;
      continue;
    }

    const leadingPersistentMemory = scrubbed.match(
      LEADING_PERSISTENT_MEMORY_BLOCK,
    )
      ?.[0];
    if (
      leadingPersistentMemory &&
      looksLikeInjectedPersistentMemoryBlock(leadingPersistentMemory)
    ) {
      scrubbed = scrubbed.slice(leadingPersistentMemory.length);
      scrubbedInjectedPrefix = true;
      continue;
    }

    return scrubbed;
  }
};

const neutralizeUserMemoryEnvelopeTags = (text: string): string =>
  text.replace(USER_MEMORY_ENVELOPE_TAG_PATTERN, (tag) => escapeXml(tag));

export function createMessagesHandler(
  deps: MessagesHandlerDeps,
): MessagesTransformHook {
  const { sessionManager } = deps;

  return async (
    input: MessagesTransformInput,
    output: MessagesTransformOutput,
  ) => {
    const lastUserEntry = output.messages
      .findLast((message) => message.info.role === "user");
    if (!lastUserEntry) return;

    const textPart = lastUserEntry.parts.find(isTextPart);
    if (!textPart) return;
    const latestUserText = textPart.text;

    const sourceSessionID = lastUserEntry.info.sessionID;

    try {
      const {
        state,
        resolved,
        canonicalSessionId,
      } = await sessionManager.resolveSessionState(sourceSessionID);
      if (!resolved || !canonicalSessionId) return;
      if (!state?.isMain) return;
      sessionManager.markResolvedSessionActive(
        sourceSessionID,
        canonicalSessionId,
      );

      const recallQuery = sanitizeMemoryInput(
        stripInjectedMemoryBlocks(
          getTransformMessage(input) ?? latestUserText,
        ),
      ) || undefined;
      const prepared = state.pendingInjection ??
        await sessionManager.prepareInjection(
          canonicalSessionId,
          recallQuery,
        );
      if (!prepared) return;

      const scrubbedUserText = scrubPromptMemoryText(latestUserText);
      const effectiveUserText = sanitizeMemoryInputPreservingMemoryBlocks(
        neutralizeUserMemoryEnvelopeTags(scrubbedUserText),
      );
      if (!effectiveUserText) {
        sessionManager.clearPendingInjection(state, prepared);
        return;
      }
      textPart.text = `${prepared.envelope}\n\n${effectiveUserText}`;
      logger.info("Injected canonical session_memory block", {
        sessionID: canonicalSessionId,
        sourceSessionID,
        rewroteExistingMemory: scrubbedUserText !== latestUserText,
      });
      sessionManager.clearPendingInjection(state, prepared);
    } catch (error) {
      logger.warn(
        "Unable to prepare local session memory for messages transform",
        {
          sessionID: sourceSessionID,
          error,
        },
      );
    }
  };
}
