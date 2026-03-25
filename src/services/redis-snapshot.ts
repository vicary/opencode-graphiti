import {
  getSessionEventPrimaryText,
  type SessionEvent,
} from "../types/index.ts";
import type { RedisClient } from "./redis-client.ts";
import { sessionSnapshotKey } from "./redis-events.ts";
import {
  escapeXml,
  normalizeMemoryText,
  renderXmlListSection,
  renderXmlSingleSection,
  sanitizeMemoryInput,
  uniqueNormalizedValues,
} from "./render-utils.ts";

const SNAPSHOT_BUDGET = 3_000;
const BLOCKER_PATTERN = /\b(blocker|blocked|blocking)\b/i;

const selectRecent = (
  events: SessionEvent[],
  predicate: (event: SessionEvent) => boolean,
  map: (event: SessionEvent) => string | string[] | undefined,
  limit: number,
  excludedNormalized = new Set<string>(),
): string[] =>
  uniqueNormalizedValues(
    events.flatMap((event) => {
      if (!predicate(event)) return [];
      const value = map(event);
      if (!value) return [];
      return Array.isArray(value) ? value : [value];
    }).reverse(),
    limit,
    excludedNormalized,
  );

export const buildSessionSnapshotXml = (
  sessionId: string,
  events: SessionEvent[],
): string => {
  const decisions = selectRecent(
    events,
    (event) => ["decision", "preference"].includes(event.category),
    (event) => sanitizeMemoryInput(getSessionEventPrimaryText(event)),
    5,
  );
  const occupiedNormalized = new Set<string>(
    decisions.map((value) => normalizeMemoryText(value)).filter(Boolean),
  );
  const constraints = selectRecent(
    events,
    (event) => event.category === "rule.load",
    (event) => sanitizeMemoryInput(getSessionEventPrimaryText(event)),
    5,
    occupiedNormalized,
  );
  for (const value of constraints) {
    occupiedNormalized.add(normalizeMemoryText(value));
  }
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
  const sanitizedLatestUserRequest = latestUserRequest
    ? sanitizeMemoryInput(latestUserRequest)
    : undefined;
  const normalizedLatestUserRequest = sanitizedLatestUserRequest
    ? normalizeMemoryText(sanitizedLatestUserRequest)
    : "";
  if (normalizedLatestUserRequest) {
    occupiedNormalized.add(normalizedLatestUserRequest);
  }
  const activeTask = events.findLast((event) =>
    ["task.create", "task.update", "task.complete"].includes(event.category)
  )?.summary;
  const sanitizedActiveTask = sanitizeMemoryInput(activeTask ?? "");
  const activeTaskValue = sanitizedActiveTask &&
      normalizeMemoryText(sanitizedActiveTask) !== normalizedLatestUserRequest
    ? sanitizedActiveTask
    : undefined;
  if (activeTaskValue) {
    occupiedNormalized.add(normalizeMemoryText(activeTaskValue));
  }
  const activeFiles = selectRecent(
    events,
    (event) => event.category.startsWith("file."),
    (event) => event.refs ?? [],
    6,
    occupiedNormalized,
  );
  for (const value of activeFiles) {
    occupiedNormalized.add(normalizeMemoryText(value));
  }
  const recentEdits = selectRecent(
    events,
    (event) =>
      event.category === "file.write" || event.category === "file.edit",
    (event) => sanitizeMemoryInput(getSessionEventPrimaryText(event)),
    5,
    occupiedNormalized,
  );
  for (const value of recentEdits) {
    occupiedNormalized.add(normalizeMemoryText(value));
  }
  const subagentsOpen = selectRecent(
    events,
    (event) => event.category === "subagent.start",
    (event) => sanitizeMemoryInput(getSessionEventPrimaryText(event)),
    4,
    occupiedNormalized,
  );
  for (const value of subagentsOpen) {
    occupiedNormalized.add(normalizeMemoryText(value));
  }
  const unresolvedErrors = events.filter((event) =>
    event.category === "error" && event.metadata?.resolved !== true &&
    event.role !== "assistant"
  );
  const errors = uniqueNormalizedValues(
    unresolvedErrors.map((event) =>
      sanitizeMemoryInput(getSessionEventPrimaryText(event))
    )
      .reverse(),
    4,
    occupiedNormalized,
  );
  for (const value of errors) {
    occupiedNormalized.add(normalizeMemoryText(value));
  }
  const blockers = uniqueNormalizedValues(
    unresolvedErrors.flatMap((event) => {
      const blockerText = sanitizeMemoryInput(
        event.detail?.trim() ||
          event.continuityText?.trim() ||
          event.body?.trim() || "",
      );
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
    occupiedNormalized,
  );
  for (const value of blockers) {
    occupiedNormalized.add(normalizeMemoryText(value));
  }
  const environment = selectRecent(
    events,
    (event) =>
      event.category === "cwd.change" || event.category === "env.change",
    (event) => sanitizeMemoryInput(getSessionEventPrimaryText(event)),
    4,
    occupiedNormalized,
  );
  for (const value of environment) {
    occupiedNormalized.add(normalizeMemoryText(value));
  }
  const gitState = selectRecent(
    events,
    (event) => event.category === "git.activity",
    (event) => sanitizeMemoryInput(getSessionEventPrimaryText(event)),
    4,
    occupiedNormalized,
  );
  for (const value of gitState) {
    occupiedNormalized.add(normalizeMemoryText(value));
  }
  const subagentsDone = selectRecent(
    events,
    (event) => event.category === "subagent.finish",
    (event) => sanitizeMemoryInput(getSessionEventPrimaryText(event)),
    4,
    occupiedNormalized,
  );
  for (const value of subagentsDone) {
    occupiedNormalized.add(normalizeMemoryText(value));
  }

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
      renderXmlSingleSection("active_task", "goal", activeTaskValue, {
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
