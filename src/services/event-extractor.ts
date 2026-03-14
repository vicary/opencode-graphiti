import type {
  EventCategory,
  SessionEvent,
  SessionEventSourceKind,
} from "../types/index.ts";

const MAX_SUMMARY = 200;
const MAX_BODY = 4096;

const priorityByCategory: Record<EventCategory, 0 | 1 | 2 | 3 | 4> = {
  decision: 0,
  preference: 0,
  "rule.load": 0,
  "task.create": 0,
  "task.update": 1,
  "task.complete": 1,
  "file.read": 1,
  "file.write": 1,
  "file.edit": 1,
  "file.search": 2,
  "cwd.change": 2,
  "env.change": 2,
  error: 2,
  "git.activity": 3,
  "subagent.start": 1,
  "subagent.finish": 3,
  "integration.call": 3,
  intent: 0,
  "data.import": 4,
  discovery: 4,
  message: 4,
  "session.meta": 3,
};

type EventRole = SessionEvent["role"];

type EventContext = {
  summary: string;
  body?: string;
  detail?: string;
  continuityText?: string;
  keywords?: string[];
  sourceKind?: SessionEventSourceKind;
  refs?: string[];
  metadata?: Record<string, unknown>;
};

type ExtractedEventInput = {
  eventType: string;
  properties?: Record<string, unknown>;
  sessionId?: string;
  messageText?: string;
  messageCount?: number;
  role?: EventRole;
};

type NormalizedEventInput = {
  eventType: string;
  props: Record<string, unknown>;
  sessionId?: string;
  text: string;
  refs: string[];
  role: EventRole;
  messageCount: number;
};

const textEncoder = new TextEncoder();
const eventRoles = new Set<EventRole>(["user", "assistant", "tool", "system"]);

const normalizeWhitespace = (text: string): string =>
  text.replace(/\s+/g, " ").trim();

const summarize = (text: string): string =>
  normalizeWhitespace(text).slice(0, MAX_SUMMARY);

const truncateBody = (text: string): string => text.slice(0, MAX_BODY);

const truncateDetail = (text: string): string => text.slice(0, 600);

const truncateContinuity = (text: string): string => text.slice(0, 800);

const makeId = (): string =>
  crypto.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const asEventRole = (value: unknown): EventRole | undefined => {
  const role = asString(value);
  return role && eventRoles.has(role as EventRole)
    ? role as EventRole
    : undefined;
};

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const toText = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const normalized = normalizeWhitespace(value);
    return normalized || undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const joined = value.map((item) => toText(item)).filter(Boolean).join(" ");
    return joined || undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (
    const key of [
      "text",
      "summary",
      "message",
      "content",
      "body",
      "description",
      "prompt",
      "query",
      "title",
      "name",
      "value",
      "reason",
      "goal",
      "status",
      "intent",
    ]
  ) {
    const result = toText(record[key]);
    if (result) return result;
  }
  return undefined;
};

const pickStrings = (
  values: Array<unknown>,
  limit = 8,
): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = toText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
};

const pickKeywords = (
  values: Array<unknown>,
  limit = 8,
): string[] => pickStrings(values, limit).map((value) => summarize(value));

const collectInlinePathRefs = (text: string): string[] => {
  const refs = new Set<string>();
  for (
    const match of text.matchAll(
      /(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+(?:\.[A-Za-z0-9]{1,8})?/g,
    )
  ) {
    const value = match[0]?.trim();
    if (value) refs.add(value);
  }
  return [...refs];
};

const collectPathRefs = (
  value: unknown,
  refs = new Set<string>(),
): string[] => {
  if (!value) return [...refs];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      trimmed &&
      (trimmed.includes("/") || trimmed.includes("\\") ||
        /\.[A-Za-z0-9]{1,8}$/.test(trimmed))
    ) {
      refs.add(trimmed);
    }
    return [...refs];
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathRefs(item, refs);
    return [...refs];
  }
  const record = asRecord(value);
  if (!record) return [...refs];
  for (const [key, item] of Object.entries(record)) {
    if (/(path|paths|file|files|ref|refs|cwd|directory)/i.test(key)) {
      collectPathRefs(item, refs);
    }
  }
  return [...refs];
};

const hasLowerKeyword = (
  haystack: string | undefined,
  ...needles: string[]
): boolean => {
  if (!haystack) return false;
  return needles.some((needle) => haystack.includes(needle));
};

const hasKeyword = (
  haystack: string | undefined,
  ...needles: string[]
): boolean => hasLowerKeyword(haystack?.toLowerCase(), ...needles);

const compactParts = (
  ...parts: Array<string | undefined>
): string | undefined => {
  const compact = parts
    .map((part) => part ? normalizeWhitespace(part) : "")
    .filter(Boolean)
    .join(" — ");
  return compact || undefined;
};

const collectMetadataKeywords = (props: Record<string, unknown>): string[] =>
  pickKeywords([
    props.tool,
    props.name,
    props.integration,
    props.status,
    props.result,
    props.reason,
    props.cwd,
  ]);

const compactToolMetadata = (
  props: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => {
  const metadata: Record<string, unknown> = {};
  for (
    const [key, value] of Object.entries({
      tool: props.tool,
      name: props.name,
      integration: props.integration,
      status: props.status,
      result: props.result,
      exitCode: props.exitCode,
      cwd: props.cwd,
      blocking: props.blocking,
      resolved: props.resolved,
      ...extra,
    })
  ) {
    if (
      typeof value === "string" || typeof value === "number" ||
      typeof value === "boolean"
    ) {
      metadata[key] = value;
    }
  }
  return metadata;
};

const buildContinuityText = (
  summary: string,
  detail?: string,
  refs?: string[],
  keywords?: string[],
): string | undefined => {
  const continuity = [
    summary,
    detail,
    refs?.join(" "),
    keywords?.join(" "),
  ]
    .map((value) => value ? normalizeWhitespace(value) : "")
    .filter(Boolean)
    .join(" ");
  return continuity ? truncateContinuity(continuity) : undefined;
};

const compactMessageBody = (text: string): string | undefined => {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return undefined;
  return truncateBody(normalized.slice(0, 480));
};

const buildToolActivityContext = (
  tool: string,
  text: string,
  refs: string[],
  props: Record<string, unknown>,
  options: {
    summaryPrefix?: string;
    sourceKind?: SessionEventSourceKind;
    preserveBody?: boolean;
    extraKeywords?: string[];
    extraMetadata?: Record<string, unknown>;
  } = {},
): EventContext => {
  const normalizedText = normalizeWhitespace(text);
  const refSummary = refs.slice(0, 3).join(", ");
  const statusSummary = compactParts(
    asString(props.status),
    asString(props.result),
    typeof props.exitCode === "number" ? `exit ${props.exitCode}` : undefined,
  );
  const summary = compactParts(
    options.summaryPrefix ?? tool,
    refSummary,
    statusSummary,
  ) ?? `${tool} activity`;
  const detail = compactParts(
    summarize(normalizedText),
    statusSummary,
    refs.length > 0 ? `refs ${refs.slice(0, 4).join(", ")}` : undefined,
  );
  const keywords = pickKeywords([
    tool,
    ...refs,
    ...collectMetadataKeywords(props),
    ...(options.extraKeywords ?? []),
  ]);
  return {
    summary,
    body: options.preserveBody ? compactMessageBody(normalizedText) : undefined,
    detail,
    continuityText: buildContinuityText(summary, detail, refs, keywords),
    keywords,
    sourceKind: options.sourceKind ?? "tool-activity",
    refs,
    metadata: compactToolMetadata(props, options.extraMetadata),
  };
};

const normalizeInput = (
  input: ExtractedEventInput,
): NormalizedEventInput => {
  const props = input.properties ?? {};
  const text = input.messageText ?? toText(props) ?? "";
  const refs = [
    ...new Set([...collectPathRefs(props), ...collectInlinePathRefs(text)]),
  ];

  return {
    eventType: input.eventType,
    props,
    sessionId: input.sessionId,
    text,
    refs,
    role: input.role ?? "system",
    messageCount: asNumber(input.messageCount) ?? 1,
  };
};

const createEvent = (
  category: EventCategory,
  role: EventRole,
  context: EventContext,
): SessionEvent => ({
  id: makeId(),
  ts: Date.now(),
  category,
  priority: priorityByCategory[category],
  role,
  summary: summarize(context.summary),
  body: context.body ? truncateBody(context.body) : undefined,
  detail: context.detail ? truncateDetail(context.detail) : undefined,
  continuityText: context.continuityText
    ? truncateContinuity(context.continuityText)
    : undefined,
  keywords: context.keywords?.filter(Boolean).slice(0, 8),
  sourceKind: context.sourceKind,
  refs: context.refs?.filter(Boolean),
  metadata: context.metadata,
});

export const createSessionEvent = (
  category: EventCategory,
  role: EventRole,
  context: EventContext,
): SessionEvent => createEvent(category, role, context);

export const extractUserMessageEvent = (
  text: string,
  messageCount: number,
): SessionEvent =>
  createEvent(messageCount <= 1 ? "intent" : "message", "user", {
    summary: text,
    body: compactMessageBody(text),
    detail: summarize(text),
    continuityText: buildContinuityText(text, summarize(text)),
    keywords: pickKeywords([text]),
    sourceKind: "user-request",
  });

export const extractAssistantMessageEvent = (text: string): SessionEvent =>
  createEvent("message", "assistant", {
    summary: summarize(text),
    detail: compactParts("Assistant response", summarize(text)),
    continuityText: buildContinuityText(summarize(text), summarize(text)),
    keywords: pickKeywords([text]),
    sourceKind: "assistant-response",
  });

export const extractSessionCreatedEvent = (sessionId?: string): SessionEvent =>
  createEvent("session.meta", "system", {
    summary: `Session created${sessionId ? `: ${sessionId}` : ""}`,
    detail: sessionId
      ? `Session ${sessionId} initialized`
      : "Session initialized",
    continuityText: sessionId
      ? `session created ${sessionId}`
      : "session created",
    keywords: pickKeywords([sessionId, "session", "created"]),
    sourceKind: "system-state",
    refs: sessionId ? [sessionId] : undefined,
    metadata: sessionId ? { sessionId } : undefined,
  });

export const extractCompactionEvent = (summary: string): SessionEvent =>
  createEvent("task.update", "system", {
    summary: `Session compacted: ${summary}`,
    detail: summarize(summary),
    continuityText: buildContinuityText(
      `Session compacted: ${summary}`,
      summary,
    ),
    keywords: pickKeywords([summary, "compacted"]),
    sourceKind: "system-state",
    metadata: { compacted: true },
  });

const inferTaskCategory = (text: string): EventCategory => {
  if (
    hasKeyword(
      text,
      "complete",
      "completed",
      "done",
      "finished",
      "resolved",
      "fixed",
    )
  ) {
    return "task.complete";
  }
  if (
    hasKeyword(text, "start", "create", "begin", "plan", "goal", "implement")
  ) {
    return "task.create";
  }
  return "task.update";
};

const extractFromHookPayload = (
  input: ExtractedEventInput,
): SessionEvent[] => {
  const normalized = normalizeInput(input);
  const { eventType, props, sessionId, text, refs, role, messageCount } =
    normalized;

  if (eventType === "session.created") {
    return [
      extractSessionCreatedEvent(
        sessionId ?? asString(asRecord(props.info)?.id),
      ),
    ];
  }

  if (eventType === "session.compacted" && text) {
    return [extractCompactionEvent(text)];
  }

  if (eventType === "message.updated" && role === "assistant" && text) {
    return [extractAssistantMessageEvent(text)];
  }

  if (eventType === "chat.message" && text) {
    return [extractUserMessageEvent(text, messageCount)];
  }

  const genericSummary = text || eventType;
  return [createEvent("session.meta", role, {
    summary: genericSummary,
    detail: summarize(text),
    continuityText: buildContinuityText(genericSummary, summarize(text), refs),
    keywords: pickKeywords([eventType, text, ...refs]),
    sourceKind: role === "tool"
      ? "tool-activity"
      : role === "assistant"
      ? "assistant-response"
      : role === "user"
      ? "user-request"
      : "system-state",
    refs,
    metadata: { eventType },
  })];
};

export const extractStructuredEvents = (
  input: ExtractedEventInput,
): SessionEvent[] => {
  const normalized = normalizeInput(input);
  const { eventType, props, text, refs, role, messageCount } = normalized;

  if (eventType === "chat.message") {
    const events = [extractUserMessageEvent(text, messageCount)];
    const lower = text.toLowerCase();
    if (hasLowerKeyword(lower, "prefer", "please", "always", "never")) {
      events.push(
        createEvent("preference", "user", {
          summary: text,
          detail: summarize(text),
          continuityText: buildContinuityText(text, summarize(text)),
          keywords: pickKeywords([text, "preference"]),
          sourceKind: "user-request",
        }),
      );
    }
    if (
      hasLowerKeyword(lower, "decide", "decision", "must", "should", "keep ")
    ) {
      events.push(
        createEvent("decision", "user", {
          summary: text,
          detail: summarize(text),
          continuityText: buildContinuityText(text, summarize(text)),
          keywords: pickKeywords([text, "decision"]),
          sourceKind: "user-request",
        }),
      );
    }
    if (
      hasLowerKeyword(
        lower,
        "import",
        "paste",
        "uploaded",
        "dataset",
        "csv",
        "json",
      )
    ) {
      events.push(
        createEvent("data.import", "user", {
          summary: text,
          detail: compactParts("Imported or referenced data", summarize(text)),
          continuityText: buildContinuityText(text, summarize(text), refs),
          keywords: pickKeywords([text, ...refs, "data"]),
          sourceKind: "user-request",
          refs,
        }),
      );
    }
    return events;
  }

  if (eventType === "message.updated") {
    const resolvedRole = input.role ?? asEventRole(asRecord(props.info)?.role);
    if (resolvedRole === "assistant" && text) {
      const events = [extractAssistantMessageEvent(text)];
      if (hasKeyword(text, "discovered", "found", "identified", "confirmed")) {
        events.push(
          createEvent("discovery", "assistant", {
            summary: text,
            detail: summarize(text),
            continuityText: buildContinuityText(text, summarize(text), refs),
            keywords: pickKeywords([text, ...refs, "discovery"]),
            sourceKind: "assistant-response",
            refs,
          }),
        );
      }
      if (hasKeyword(text, "error", "failed", "blocker", "cannot", "unable")) {
        events.push(createEvent("error", "assistant", {
          summary: text,
          detail: summarize(text),
          continuityText: buildContinuityText(text, summarize(text), refs),
          keywords: pickKeywords([text, ...refs, "error", "blocker"]),
          sourceKind: "assistant-response",
          refs,
          metadata: { resolved: false, eventType },
        }));
      }
      return events;
    }
  }

  if (eventType === "task.updated") {
    const task = asRecord(props.task) ?? props;
    const summary = toText(task) ?? "Task updated";
    return [createEvent(inferTaskCategory(summary), "system", {
      summary,
      detail: compactParts("Task update", summarize(summary)),
      continuityText: buildContinuityText(summary, summarize(summary), refs),
      keywords: pickKeywords([summary, task.id, task.path, ...refs]),
      sourceKind: "system-state",
      refs: pickStrings([task.id, task.path, ...refs]),
      metadata: compactToolMetadata(task),
    })];
  }

  if (eventType === "rules.loaded") {
    const summary =
      pickStrings([props.name, props.path, props.source, text]).join(" — ") ||
      "Rules loaded";
    return [createEvent("rule.load", "system", {
      summary,
      detail: compactParts("Rules loaded", text || summary),
      continuityText: buildContinuityText(summary, text || summary, refs),
      keywords: pickKeywords([summary, ...refs, "rules"]),
      sourceKind: "system-state",
      refs,
      metadata: compactToolMetadata(props),
    })];
  }

  if (eventType === "tool.called" || eventType === "tool.completed") {
    const tool = asString(props.tool) ?? asString(props.name) ??
      toText(asRecord(props.call)?.tool) ?? "tool";
    const summaryText = text || `${tool} activity`;
    const lowerTool = tool.toLowerCase();
    const lowerText = summaryText.toLowerCase();

    if (
      hasLowerKeyword(lowerTool, "read", "open") ||
      hasLowerKeyword(lowerText, "read file", "opened")
    ) {
      return [
        createEvent(
          "file.read",
          "tool",
          buildToolActivityContext(tool, summaryText, refs, props, {
            summaryPrefix: "Read",
            extraKeywords: ["file", "read"],
          }),
        ),
      ];
    }
    if (
      hasLowerKeyword(lowerTool, "write", "create") ||
      hasLowerKeyword(lowerText, "wrote", "created file")
    ) {
      return [
        createEvent(
          "file.write",
          "tool",
          buildToolActivityContext(tool, summaryText, refs, props, {
            summaryPrefix: "Wrote",
            extraKeywords: ["file", "write"],
          }),
        ),
      ];
    }
    if (
      hasLowerKeyword(lowerTool, "edit", "patch", "replace") ||
      hasLowerKeyword(lowerText, "updated file", "edited")
    ) {
      return [
        createEvent(
          "file.edit",
          "tool",
          buildToolActivityContext(tool, summaryText, refs, props, {
            summaryPrefix: "Edited",
            extraKeywords: ["file", "edit"],
          }),
        ),
      ];
    }
    if (
      hasLowerKeyword(lowerTool, "grep", "search", "glob") ||
      hasLowerKeyword(lowerText, "searched", "query")
    ) {
      return [
        createEvent(
          "file.search",
          "tool",
          buildToolActivityContext(tool, summaryText, refs, props, {
            summaryPrefix: "Searched",
            extraKeywords: ["search"],
          }),
        ),
      ];
    }
    if (
      hasLowerKeyword(lowerTool, "git") ||
      hasLowerKeyword(
        lowerText,
        "branch",
        "commit",
        "merge",
        "rebase",
        "push",
        "stash",
      )
    ) {
      return [
        createEvent(
          "git.activity",
          "tool",
          buildToolActivityContext(tool, summaryText, refs, props, {
            summaryPrefix: "Git",
            extraKeywords: ["git"],
            preserveBody: true,
          }),
        ),
      ];
    }
    if (
      hasLowerKeyword(lowerTool, "graphiti", "mcp", "redis", "http") ||
      asString(props.integration)
    ) {
      return [
        createEvent(
          "integration.call",
          "tool",
          buildToolActivityContext(tool, summaryText, refs, props, {
            summaryPrefix: "Integration",
            extraKeywords: ["integration"],
          }),
        ),
      ];
    }
    if (hasLowerKeyword(lowerText, "error", "failed", "exception", "unable")) {
      return [createEvent("error", "tool", {
        ...buildToolActivityContext(tool, summaryText, refs, props, {
          summaryPrefix: "Tool error",
          preserveBody: true,
          extraKeywords: ["error", "failed"],
          extraMetadata: { resolved: false },
        }),
      })];
    }
  }

  if (eventType === "environment.updated") {
    const summary = text || "Environment updated";
    const entries: SessionEvent[] = [];
    if (hasKeyword(summary, "cwd", "directory", "working directory")) {
      entries.push(
        createEvent("cwd.change", "system", {
          summary,
          detail: compactParts("Working directory updated", text),
          continuityText: buildContinuityText(summary, text, refs),
          keywords: pickKeywords([summary, ...refs, "cwd"]),
          sourceKind: "system-state",
          refs,
          metadata: compactToolMetadata(props),
        }),
      );
    }
    entries.push(
      createEvent("env.change", "system", {
        summary,
        detail: compactParts("Environment updated", text),
        continuityText: buildContinuityText(summary, text, refs),
        keywords: pickKeywords([summary, ...refs, "environment"]),
        sourceKind: "system-state",
        refs,
        metadata: compactToolMetadata(props),
      }),
    );
    return entries;
  }

  if (eventType === "subagent.started" || eventType === "subagent.finished") {
    return [
      createEvent(
        eventType === "subagent.started" ? "subagent.start" : "subagent.finish",
        "system",
        {
          summary: text || eventType,
          detail: compactParts(
            eventType === "subagent.started"
              ? "Subagent started"
              : "Subagent finished",
            text,
          ),
          continuityText: buildContinuityText(text || eventType, text, refs),
          keywords: pickKeywords([
            text,
            props.agentId,
            props.sessionId,
            ...refs,
          ]),
          sourceKind: "system-state",
          refs: pickStrings([props.agentId, props.sessionId, ...refs]),
          metadata: compactToolMetadata(props),
        },
      ),
    ];
  }

  if (eventType === "session.idle") {
    return [createEvent("session.meta", "system", {
      summary: text || "Session idle",
      detail: compactParts("Session idle", text),
      continuityText: buildContinuityText(text || "Session idle", text, refs),
      keywords: pickKeywords([text, eventType, ...refs]),
      sourceKind: "system-state",
      refs,
      metadata: { ...props, eventType },
    })];
  }

  if (text) {
    const lower = text.toLowerCase();
    if (hasLowerKeyword(lower, "error", "failed", "exception", "blocker")) {
      return [createEvent("error", role, {
        summary: text,
        detail: summarize(text),
        continuityText: buildContinuityText(text, summarize(text), refs),
        keywords: pickKeywords([text, ...refs, "error"]),
        sourceKind: role === "assistant"
          ? "assistant-response"
          : role === "user"
          ? "user-request"
          : role === "tool"
          ? "tool-activity"
          : "system-state",
        refs,
        metadata: { ...props, resolved: false, eventType },
      })];
    }
    if (hasLowerKeyword(lower, "discover", "found", "inspect", "observed")) {
      return [createEvent("discovery", role, {
        summary: text,
        detail: summarize(text),
        continuityText: buildContinuityText(text, summarize(text), refs),
        keywords: pickKeywords([text, ...refs, "discovery"]),
        sourceKind: role === "assistant"
          ? "assistant-response"
          : role === "user"
          ? "user-request"
          : role === "tool"
          ? "tool-activity"
          : "system-state",
        refs,
        metadata: { ...props, eventType },
      })];
    }
    return [createEvent("message", role, {
      summary: text,
      body: role === "user" ? compactMessageBody(text) : undefined,
      detail: summarize(text),
      continuityText: buildContinuityText(text, summarize(text), refs),
      keywords: pickKeywords([text, ...refs]),
      sourceKind: role === "assistant"
        ? "assistant-response"
        : role === "user"
        ? "user-request"
        : role === "tool"
        ? "tool-activity"
        : "system-state",
      refs,
      metadata: { ...props, eventType },
    })];
  }

  return extractFromHookPayload(input);
};

export const estimateEventSize = (event: SessionEvent): number =>
  textEncoder.encode(JSON.stringify(event)).length;
