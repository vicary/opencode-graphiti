import {
  getSessionEventPrimaryText,
  type SessionEvent,
} from "../types/index.ts";
import {
  escapeXml,
  renderXmlListSection,
  renderXmlSingleSection,
  uniqueValues,
} from "./render-utils.ts";
import type { RedisClient } from "./redis-client.ts";
import { sessionSnapshotKey } from "./redis-events.ts";

const SNAPSHOT_BUDGET = 3_000;
const BLOCKER_PATTERN = /\b(blocker|blocked|blocking)\b/i;

const selectRecent = (
  events: SessionEvent[],
  predicate: (event: SessionEvent) => boolean,
  map: (event: SessionEvent) => string | string[] | undefined,
  limit: number,
): string[] =>
  uniqueValues(
    events.flatMap((event) => {
      if (!predicate(event)) return [];
      const value = map(event);
      if (!value) return [];
      return Array.isArray(value) ? value : [value];
    }).reverse(),
    limit,
  );

export const buildSessionSnapshotXml = (
  sessionId: string,
  events: SessionEvent[],
): string => {
  const decisions = selectRecent(
    events,
    (event) => ["decision", "preference"].includes(event.category),
    (event) => getSessionEventPrimaryText(event),
    5,
  );
  const constraints = selectRecent(
    events,
    (event) => event.category === "rule.load",
    (event) => getSessionEventPrimaryText(event),
    5,
  );
  const latestUserRequest = getSessionEventPrimaryText(
    events.findLast((event) => event.role === "user") ?? {
      id: "",
      ts: 0,
      category: "message",
      priority: 4,
      role: "user",
      summary: "",
    },
  ) || undefined;
  const activeTask =
    events.findLast((event) =>
      ["task.create", "task.update", "intent"].includes(event.category)
    )?.summary ?? latestUserRequest;
  const activeFiles = selectRecent(
    events,
    (event) => event.category.startsWith("file."),
    (event) => event.refs ?? [],
    6,
  );
  const recentEdits = selectRecent(
    events,
    (event) =>
      event.category === "file.write" || event.category === "file.edit",
    (event) => getSessionEventPrimaryText(event),
    5,
  );
  const subagentsOpen = selectRecent(
    events,
    (event) => event.category === "subagent.start",
    (event) => getSessionEventPrimaryText(event),
    4,
  );
  const unresolvedErrors = events.filter((event) =>
    event.category === "error" && event.metadata?.resolved !== true
  );
  const errors = uniqueValues(
    unresolvedErrors.map((event) => getSessionEventPrimaryText(event))
      .reverse(),
    4,
  );
  const blockers = uniqueValues(
    unresolvedErrors.flatMap((event) => {
      const blockerText = event.detail?.trim() ||
        event.continuityText?.trim() ||
        event.body?.trim();
      if (!blockerText || blockerText === event.summary) return [];
      if (
        event.metadata?.blocking === true ||
        BLOCKER_PATTERN.test(blockerText) ||
        BLOCKER_PATTERN.test(event.summary)
      ) {
        return [blockerText];
      }
      return [];
    }).reverse(),
    3,
  );
  const environment = selectRecent(
    events,
    (event) =>
      event.category === "cwd.change" || event.category === "env.change",
    (event) => getSessionEventPrimaryText(event),
    4,
  );
  const gitState = selectRecent(
    events,
    (event) => event.category === "git.activity",
    (event) => getSessionEventPrimaryText(event),
    4,
  );
  const subagentsDone = selectRecent(
    events,
    (event) => event.category === "subagent.finish",
    (event) => getSessionEventPrimaryText(event),
    4,
  );
  const openQuestions = selectRecent(
    events,
    (event) => event.category === "task.update",
    (event) => getSessionEventPrimaryText(event),
    4,
  );
  const discoveries = selectRecent(
    events,
    (event) => event.category === "discovery",
    (event) => getSessionEventPrimaryText(event),
    4,
  );
  const references = selectRecent(
    events,
    (event) => event.category === "data.import",
    (event) => getSessionEventPrimaryText(event),
    4,
  );
  const residualMessages = selectRecent(
    events,
    (event) => event.category === "message",
    (event) => getSessionEventPrimaryText(event),
    3,
  );

  const open = `<snapshot session="${
    escapeXml(sessionId)
  }" ts="${Date.now()}" version="2">`;
  const close = `</snapshot>`;
  let xml = open;
  let remaining = SNAPSHOT_BUDGET - open.length - close.length;

  const sectionBuilders = [
    () =>
      renderXmlListSection("decisions", "d", decisions, {
        itemCharLimit: 240,
        remaining,
      }),
    () =>
      renderXmlListSection("constraints", "c", constraints, {
        itemCharLimit: 240,
        remaining,
      }),
    () =>
      renderXmlSingleSection("active_task", "goal", activeTask, {
        valueCharLimit: 320,
        remaining,
      }),
    () =>
      renderXmlListSection("active_files", "f", activeFiles, {
        itemCharLimit: 240,
        remaining,
      }),
    () =>
      renderXmlListSection("recent_edits", "e", recentEdits, {
        itemCharLimit: 220,
        remaining,
      }),
    () =>
      renderXmlListSection("subagents_open", "s", subagentsOpen, {
        itemCharLimit: 220,
        remaining,
      }),
    () =>
      renderXmlListSection("errors", "e", errors, {
        itemCharLimit: 240,
        remaining,
      }),
    () =>
      renderXmlListSection("blockers", "b", blockers, {
        itemCharLimit: 220,
        remaining,
      }),
    () =>
      renderXmlListSection("environment", "e", environment, {
        itemCharLimit: 240,
        remaining,
      }),
    () =>
      renderXmlListSection("git_state", "g", gitState, {
        itemCharLimit: 220,
        remaining,
      }),
    () =>
      renderXmlListSection("subagents_done", "s", subagentsDone, {
        itemCharLimit: 220,
        remaining,
      }),
    () =>
      renderXmlListSection("open_questions", "q", openQuestions, {
        itemCharLimit: 220,
        remaining,
      }),
    () =>
      renderXmlListSection("discoveries", "d", discoveries, {
        itemCharLimit: 240,
        remaining,
      }),
    () =>
      renderXmlListSection("references", "r", references, {
        itemCharLimit: 220,
        remaining,
      }),
    () =>
      renderXmlListSection("residual_messages", "m", residualMessages, {
        itemCharLimit: 180,
        remaining,
      }),
  ];

  for (const buildSection of sectionBuilders) {
    const section = buildSection();
    if (!section) continue;
    if (section.length > remaining) break;
    xml += section;
    remaining -= section.length;
  }

  return `${xml}${close}`;
};

export interface RedisSnapshotServiceOptions {
  ttlSeconds: number;
}

export class RedisSnapshotService {
  constructor(
    private readonly redis: RedisClient,
    private readonly options: RedisSnapshotServiceOptions,
  ) {}

  async getSnapshot(sessionId: string): Promise<string | null> {
    return await this.redis.getString(sessionSnapshotKey(sessionId));
  }

  async saveSnapshot(sessionId: string, snapshot: string): Promise<void> {
    await this.redis.setString(
      sessionSnapshotKey(sessionId),
      snapshot,
      this.options.ttlSeconds,
    );
  }

  async touchSnapshot(sessionId: string): Promise<void> {
    await this.redis.touch(
      sessionSnapshotKey(sessionId),
      this.options.ttlSeconds,
    );
  }

  async rebuildAndSave(
    sessionId: string,
    events: SessionEvent[],
  ): Promise<string> {
    const snapshot = buildSessionSnapshotXml(sessionId, events);
    await this.saveSnapshot(sessionId, snapshot);
    return snapshot;
  }
}
