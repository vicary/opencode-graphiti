import type {
  OpencodeClient,
  Part,
  SessionMessagesResponses,
} from "@opencode-ai/sdk";
import type { GraphitiClient } from "./services/client.ts";
import { logger } from "./services/logger.ts";
import { extractTextFromParts } from "./utils.ts";

/**
 * Per-session state tracked by the plugin.
 */
export type SessionState = {
  /** Graphiti group ID for this session. */
  groupId: string;
  /** Graphiti group ID for user-scoped memories. */
  userGroupId: string;
  /** Whether memories have been injected into this session yet. */
  injectedMemories: boolean;
  /** Fact UUIDs included in the last memory injection. */
  lastInjectionFactUuids: Set<string>;
  /** Cached formatted memory context for system prompt injection. */
  cachedMemoryContext?: string;
  /** Count of messages observed in this session. */
  messageCount: number;
  /** Buffered message strings awaiting flush. */
  pendingMessages: string[];
  /** Context window limit in tokens. */
  contextLimit: number;
  /** True when this session is the primary (non-subagent) session. */
  isMain: boolean;
};

/**
 * Tracks per-session state, parent resolution, message buffering,
 * and flushing pending messages to Graphiti.
 */
export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private parentIdCache = new Map<string, string | null>();
  private pendingAssistantMessages = new Map<
    string,
    { sessionId: string; text: string }
  >();
  private bufferedAssistantMessageIds = new Set<string>();

  constructor(
    private readonly defaultGroupId: string,
    private readonly defaultUserGroupId: string,
    private readonly sdkClient: OpencodeClient,
    private readonly graphitiClient: GraphitiClient,
  ) {}

  /** Get the current session state, if present. */
  getState(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /** Persist session state for the given session ID. */
  setState(sessionId: string, state: SessionState): void {
    this.sessions.set(sessionId, state);
  }

  /** Cache a resolved parent ID for a session. */
  setParentId(sessionId: string, parentId: string | null): void {
    this.parentIdCache.set(sessionId, parentId);
  }

  /** Resolve and cache the parent ID for a session. */
  async resolveParentId(
    sessionId: string,
  ): Promise<string | null | undefined> {
    if (this.parentIdCache.has(sessionId)) {
      return this.parentIdCache.get(sessionId) ?? null;
    }
    try {
      const response = await this.sdkClient.session.get({
        path: { id: sessionId },
      });
      const sessionInfo = typeof response === "object" && response !== null &&
          "data" in response
        ? (response as { data?: { parentID?: string } }).data
        : (response as { parentID?: string });
      if (!sessionInfo) return undefined;
      const parentId = sessionInfo.parentID ?? null;
      this.parentIdCache.set(sessionId, parentId);
      return parentId;
    } catch (err) {
      logger.debug("Failed to resolve session parentID", { sessionId, err });
      return undefined;
    }
  }

  /** Resolve the session state, initializing if needed. */
  async resolveSessionState(
    sessionId: string,
  ): Promise<{ state: SessionState | null; resolved: boolean }> {
    const parentId = await this.resolveParentId(sessionId);
    if (parentId === undefined) return { state: null, resolved: false };
    if (parentId) {
      this.sessions.delete(sessionId);
      return { state: null, resolved: true };
    }

    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        groupId: this.defaultGroupId,
        userGroupId: this.defaultUserGroupId,
        injectedMemories: false,
        lastInjectionFactUuids: new Set(),
        cachedMemoryContext: undefined,
        messageCount: 0,
        pendingMessages: [],
        contextLimit: 200_000,
        isMain: true,
      };
      this.sessions.set(sessionId, state);
    }
    return { state, resolved: true };
  }

  /** Determine whether a session is a subagent session. */
  async isSubagentSession(sessionId: string): Promise<boolean> {
    const parentId = await this.resolveParentId(sessionId);
    return !!parentId;
  }

  /** Buffer partial assistant text for a streaming message. */
  bufferAssistantPart(
    sessionId: string,
    messageId: string,
    text: string,
  ): void {
    const key = `${sessionId}:${messageId}`;
    this.pendingAssistantMessages.set(key, { sessionId, text });
  }

  /** Check if an assistant message has already been finalized. */
  isAssistantBuffered(sessionId: string, messageId: string): boolean {
    const key = `${sessionId}:${messageId}`;
    return this.bufferedAssistantMessageIds.has(key);
  }

  /**
   * Finalize a buffered assistant message and append it to pending messages.
   */
  finalizeAssistantMessage(
    state: SessionState,
    sessionId: string,
    messageId: string,
    source: string,
  ): void {
    const key = `${sessionId}:${messageId}`;
    if (this.bufferedAssistantMessageIds.has(key)) return;

    const buffered = this.pendingAssistantMessages.get(key);
    this.pendingAssistantMessages.delete(key);
    this.bufferedAssistantMessageIds.add(key);

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
  }

  /** Flush pending buffered messages to Graphiti when size thresholds permit. */
  async flushPendingMessages(
    sessionId: string,
    sourceDescription: string,
    minBytes: number,
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.pendingMessages.length === 0) return;

    const lastMessage = state.pendingMessages.at(-1);
    if (lastMessage) {
      const separatorIndex = lastMessage.indexOf(":");
      const role = separatorIndex === -1
        ? lastMessage.trim().toLowerCase()
        : lastMessage.slice(0, separatorIndex).trim().toLowerCase();
      if (role === "user") {
        const fallback = await this.fetchLatestAssistantMessage(sessionId);
        if (fallback?.text) {
          const fallbackKey = fallback.id
            ? `${sessionId}:${fallback.id}`
            : undefined;
          const alreadyBuffered = fallbackKey
            ? this.bufferedAssistantMessageIds.has(fallbackKey)
            : state.pendingMessages.some((message) =>
              message.startsWith("Assistant:") &&
              message.includes(fallback.text)
            );
          if (!alreadyBuffered) {
            state.pendingMessages.push(`Assistant: ${fallback.text}`);
            if (fallbackKey) {
              this.bufferedAssistantMessageIds.add(fallbackKey);
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
      await this.graphitiClient.addEpisode({
        name: `Buffered messages: ${name}`,
        episodeBody: combined,
        groupId: state.groupId,
        source: "text",
        sourceDescription,
      });
      logger.info("Flushed buffered messages to Graphiti");
    } catch (err) {
      logger.error(`Failed to flush messages for ${sessionId}:`, err);
      const currentState = this.sessions.get(sessionId);
      if (currentState) {
        currentState.pendingMessages = [
          ...messagesToFlush,
          ...currentState.pendingMessages,
        ];
      }
    }
  }

  /** Remove a pending assistant message by key. */
  deletePendingAssistant(sessionId: string, messageId: string): void {
    const key = `${sessionId}:${messageId}`;
    this.pendingAssistantMessages.delete(key);
  }

  /** Clear cached data for a session. */
  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.parentIdCache.delete(sessionId);
    for (const key of this.pendingAssistantMessages.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.pendingAssistantMessages.delete(key);
      }
    }
    for (const key of this.bufferedAssistantMessageIds) {
      if (key.startsWith(`${sessionId}:`)) {
        this.bufferedAssistantMessageIds.delete(key);
      }
    }
  }

  private async fetchLatestAssistantMessage(
    sessionId: string,
  ): Promise<{ id?: string; text: string } | null> {
    try {
      const response = await this.sdkClient.session.messages({
        path: { id: sessionId },
        query: { limit: 20 },
      });
      const payload = response && typeof response === "object" &&
          "data" in response
        ? (response as { data?: unknown }).data
        : (response as SessionMessagesResponses[200] | undefined);
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
  }
}
