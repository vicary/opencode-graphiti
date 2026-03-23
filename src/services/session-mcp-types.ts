import { z } from "zod";
import type {
  SessionMcpCheckStatus,
  SessionMcpStatus,
} from "../types/index.ts";

export const SESSION_MCP_TOOL_NAMES = [
  "session_execute",
  "session_execute_file",
  "session_batch_execute",
  "session_index",
  "session_search",
  "session_fetch_and_index",
  "session_stats",
  "session_doctor",
] as const;

export type SessionMcpToolName = (typeof SESSION_MCP_TOOL_NAMES)[number];

export const sessionMcpStatusSchema = z.enum(
  [
    "ok",
    "error",
  ] satisfies SessionMcpStatus[],
);

export const sessionMcpCheckStatusSchema = z.enum(
  [
    "ok",
    "degraded",
    "unavailable",
    "not_checked",
  ] satisfies SessionMcpCheckStatus[],
);

const rootSessionIdShape = {
  root_session_id: z.string().min(1),
};

const sessionExecuteStepSchema = z.object({
  command: z.string().min(1),
  timeout_seconds: z.number().int().positive().max(120).optional(),
}).strict();

export const sessionBatchCommandStepSchema = z.object({
  kind: z.literal("command"),
  command: z.string().min(1),
  timeout_seconds: z.number().int().positive().max(120).optional(),
}).strict();

export const sessionBatchSearchStepSchema = z.object({
  kind: z.literal("search"),
  query: z.string().min(1),
}).strict();

export const sessionBatchStepSchema = z.discriminatedUnion("kind", [
  sessionBatchCommandStepSchema,
  sessionBatchSearchStepSchema,
]);

type SessionExecuteStep = z.infer<typeof sessionExecuteStepSchema>;
type SessionBatchStep = z.infer<typeof sessionBatchStepSchema>;

type SessionBatchExecuteRequest = {
  root_session_id: string;
  commands: SessionExecuteStep[];
  steps?: SessionBatchStep[];
};

type SessionIndexRequest = {
  root_session_id: string;
  content: string;
  path?: string;
  source?: string;
  label?: string;
};

const searchResultSchema = z.object({
  corpus_ref: z.string().min(1),
  snippet: z.string(),
  score: z.number(),
}).strict();

const doctorCheckSchema = z.object({
  name: z.string().min(1),
  status: sessionMcpCheckStatusSchema,
  detail: z.string().min(1),
}).strict();

const doctorSubsystemSchema = z.object({
  status: sessionMcpCheckStatusSchema,
  detail: z.string().min(1),
}).strict();

const sessionBatchExecuteLegacyRequestSchema = z.object({
  ...rootSessionIdShape,
  commands: z.array(sessionExecuteStepSchema).min(1),
}).strict();

const sessionBatchExecuteMixedRequestSchema = z.object({
  ...rootSessionIdShape,
  steps: z.array(sessionBatchStepSchema).min(1),
}).strict();

const sessionBatchExecuteRequestSchema = z.union([
  sessionBatchExecuteLegacyRequestSchema,
  sessionBatchExecuteMixedRequestSchema,
]).transform((request) => {
  if ("steps" in request) {
    return {
      root_session_id: request.root_session_id,
      steps: request.steps,
      commands: request.steps.flatMap((step) =>
        step.kind === "command"
          ? [{ command: step.command, timeout_seconds: step.timeout_seconds }]
          : []
      ),
    };
  }

  return {
    root_session_id: request.root_session_id,
    commands: request.commands,
    steps: request.commands.map((command) => ({
      kind: "command" as const,
      ...command,
    })),
  };
});

const sessionIndexRequestSchema = z.object({
  ...rootSessionIdShape,
  content: z.string().optional(),
  path: z.string().optional(),
  source: z.string().optional(),
  label: z.string().optional(),
}).strict().refine(
  (request) =>
    typeof request.content === "string" || typeof request.path === "string",
  {
    message: "content or path is required",
  },
).transform((request) => ({
  root_session_id: request.root_session_id,
  content: request.content ?? "",
  path: request.path,
  source: request.source,
  label: request.label,
} satisfies SessionIndexRequest));

export const sessionMcpRequestSchemas = {
  session_execute: z.object({
    ...rootSessionIdShape,
    command: z.string().min(1),
    timeout_seconds: z.number().int().positive().max(120).optional(),
  }).strict(),
  session_execute_file: z.object({
    ...rootSessionIdShape,
    paths: z.array(z.string().min(1)).min(1),
  }).strict(),
  session_batch_execute: sessionBatchExecuteRequestSchema,
  session_index: sessionIndexRequestSchema,
  session_search: z.object({
    ...rootSessionIdShape,
    query: z.string().min(1),
  }).strict(),
  session_fetch_and_index: z.object({
    ...rootSessionIdShape,
    url: z.string().url(),
    timeout_seconds: z.number().int().positive().max(120).optional(),
  }).strict(),
  session_stats: z.object({
    ...rootSessionIdShape,
  }).strict(),
  session_doctor: z.object({
    ...rootSessionIdShape,
  }).strict(),
};

export const sessionExecuteResponseSchema = z.object({
  status: sessionMcpStatusSchema,
  summary: z.string(),
  artifact_ref: z.string().min(1).optional(),
  exit_code: z.number().int(),
  timed_out: z.boolean(),
  truncated: z.boolean(),
  bytes_captured: z.number().int().nonnegative(),
}).strict();

export const sessionSearchResponseSchema = z.object({
  status: sessionMcpStatusSchema,
  results: z.array(searchResultSchema),
  corpus_refs: z.array(z.string()),
  truncated: z.boolean(),
}).strict();

export const sessionBatchStepResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command"),
    result: sessionExecuteResponseSchema,
  }).strict().transform((step) => ({
    ...step,
    ...step.result,
  })),
  z.object({
    kind: z.literal("search"),
    result: sessionSearchResponseSchema,
  }).strict().transform((step) => ({
    ...step,
    status: step.result.status,
    summary: `Search returned ${step.result.results.length} result(s).`,
    exit_code: -1,
    timed_out: false,
    truncated: step.result.truncated,
    bytes_captured: 0,
    artifact_ref: undefined as string | undefined,
  })),
]);

export const sessionMcpResponseSchemas = {
  session_execute: sessionExecuteResponseSchema,
  session_batch_execute: z.object({
    status: sessionMcpStatusSchema,
    summary: z.string(),
    results: z.array(sessionBatchStepResultSchema),
    truncated: z.boolean(),
  }).strict(),
  session_execute_file: z.object({
    status: sessionMcpStatusSchema,
    summary: z.string(),
    artifact_ref: z.string().min(1).optional(),
    corpus_ref: z.string().min(1).optional(),
    file_count: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }).strict(),
  session_index: z.object({
    status: sessionMcpStatusSchema,
    corpus_ref: z.string().min(1),
    chunk_count: z.number().int().nonnegative(),
    query_hints: z.array(z.string()),
  }).strict(),
  session_search: sessionSearchResponseSchema,
  session_fetch_and_index: z.object({
    status: sessionMcpStatusSchema,
    corpus_ref: z.string().min(1),
    summary: z.string(),
    query_hints: z.array(z.string()),
    fetched_url: z.string().min(1),
    content_type: z.string().min(1),
    truncated: z.boolean(),
  }).strict(),
  session_stats: z.object({
    status: sessionMcpStatusSchema,
    counters: z.record(z.string(), z.number()),
    corpus_count: z.number().int().nonnegative(),
    artifact_count: z.number().int().nonnegative(),
    bytes_saved_estimate: z.number().int().nonnegative(),
  }).strict(),
  session_doctor: z.object({
    status: sessionMcpStatusSchema,
    checks: z.array(doctorCheckSchema),
    redis: doctorSubsystemSchema,
    graphiti_cache: doctorSubsystemSchema,
    runtime: doctorSubsystemSchema,
  }).strict(),
};

type SessionMcpInferredRequestMap = {
  [K in SessionMcpToolName]: ReturnType<
    (typeof sessionMcpRequestSchemas)[K]["parse"]
  >;
};

export type SessionMcpRequestMap =
  & {
    [
      K in Exclude<
        SessionMcpToolName,
        "session_batch_execute" | "session_index"
      >
    ]: SessionMcpInferredRequestMap[K];
  }
  & {
    session_batch_execute: SessionBatchExecuteRequest;
    session_index: SessionIndexRequest;
  };

type SessionExecuteResponse = z.infer<typeof sessionExecuteResponseSchema>;
type SessionSearchResponse = z.infer<typeof sessionSearchResponseSchema>;
type SessionBatchStepResult = z.infer<typeof sessionBatchStepResultSchema>;

type SessionBatchExecuteResponse = {
  status: SessionMcpStatus;
  summary: string;
  results: Array<SessionExecuteResponse | SessionBatchStepResult>;
  truncated: boolean;
};

type SessionMcpInferredResponseMap = {
  [K in SessionMcpToolName]: ReturnType<
    (typeof sessionMcpResponseSchemas)[K]["parse"]
  >;
};

export type SessionMcpResponseMap =
  & {
    [K in Exclude<SessionMcpToolName, "session_batch_execute">]:
      SessionMcpInferredResponseMap[K];
  }
  & {
    session_batch_execute: SessionBatchExecuteResponse;
  };
