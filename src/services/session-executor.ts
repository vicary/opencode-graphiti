import path from "node:path";
import type {
  SessionMcpRequestMap,
  SessionMcpResponseMap,
} from "./session-mcp-types.ts";

export const SESSION_EXECUTOR_RESPONSE_BUDGET_BYTES = 8 * 1024;
export const SESSION_EXECUTOR_DEFAULT_COMMAND_TIMEOUT_SECONDS = 30;
export const SESSION_EXECUTOR_MAX_COMMAND_TIMEOUT_SECONDS = 120;
export const SESSION_EXECUTOR_MAX_NORMALIZED_INDEXED_BODY_BYTES = 512 * 1024;
export const SESSION_EXECUTOR_OUT_OF_WORKSPACE_MESSAGE =
  "Path is outside the active workspace.";

type SessionExecuteResponse = SessionMcpResponseMap["session_execute"];
type SessionExecuteFileResponse = SessionMcpResponseMap["session_execute_file"];
type SessionBatchExecuteResponse =
  SessionMcpResponseMap["session_batch_execute"];
type SessionExecuteRequest = SessionMcpRequestMap["session_execute"];
type SessionExecuteFileRequest = SessionMcpRequestMap["session_execute_file"];
type SessionBatchExecuteRequest = SessionMcpRequestMap["session_batch_execute"];

export type SessionExecutorContext = {
  worktree?: string;
  directory?: string;
};

type CommandExecutionResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type StoredArtifact = {
  artifactRef: string;
  corpusRef?: string;
};

type SessionBatchCommandResult = {
  kind: "command";
  result: SessionExecuteResponse;
};

type SessionBatchCommandResponse = {
  status: SessionBatchExecuteResponse["status"];
  summary: string;
  results: SessionBatchCommandResult[];
  truncated: boolean;
};

type SessionExecutorOptions = {
  responseBudgetBytes?: number;
  defaultCommandTimeoutSeconds?: number;
  maxCommandTimeoutSeconds?: number;
  maxNormalizedIndexedBodyBytes?: number;
  runCommand?: (input: {
    command: string;
    cwd: string;
    timeoutSeconds: number;
    signal: AbortSignal;
  }) => Promise<CommandExecutionResult>;
  readFile?: (path: string) => Promise<string>;
  storeArtifact?: (input: {
    rootSessionId: string;
    toolName: "session_execute" | "session_execute_file";
    body: string;
    maxNormalizedIndexedBodyBytes: number;
  }) => Promise<StoredArtifact>;
};

export type SessionExecutor = {
  executeCommand: (
    request: SessionExecuteRequest,
    context: SessionExecutorContext,
  ) => Promise<SessionExecuteResponse>;
  executeFile: (
    request: SessionExecuteFileRequest,
    context: SessionExecutorContext,
  ) => Promise<SessionExecuteFileResponse>;
  executeBatch: (
    request: SessionBatchExecuteRequest,
    context: SessionExecutorContext,
    executeStep?: (
      request: SessionExecuteRequest,
      context: SessionExecutorContext,
    ) => Promise<SessionExecuteResponse>,
  ) => Promise<SessionBatchExecuteResponse>;
  readLocalFile?: (
    inputPath: string,
    context: SessionExecutorContext,
  ) => Promise<string>;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const byteLength = (value: string): number =>
  textEncoder.encode(value).byteLength;

const serialize = (value: unknown): string => JSON.stringify(value);

const clampTimeoutSeconds = (
  timeoutSeconds: number | undefined,
  defaults: {
    defaultCommandTimeoutSeconds: number;
    maxCommandTimeoutSeconds: number;
  },
): number =>
  Math.min(
    timeoutSeconds ?? defaults.defaultCommandTimeoutSeconds,
    defaults.maxCommandTimeoutSeconds,
  );

const defaultRunCommand: NonNullable<SessionExecutorOptions["runCommand"]> =
  async ({ command, cwd, signal }) => {
    const shell = Deno.build.os === "windows"
      ? { executable: "cmd", args: ["/d", "/s", "/c", command] }
      : { executable: "/bin/sh", args: ["-lc", command] };
    const output = await new Deno.Command(shell.executable, {
      args: shell.args,
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal,
    }).output();

    return {
      exitCode: output.code,
      stdout: textDecoder.decode(output.stdout),
      stderr: textDecoder.decode(output.stderr),
    };
  };

const defaultReadFile: NonNullable<SessionExecutorOptions["readFile"]> = (
  filePath,
) => Deno.readTextFile(filePath);

const defaultStoreArtifact: NonNullable<
  SessionExecutorOptions["storeArtifact"]
> = ({ body }) =>
  Promise.resolve({
    artifactRef: `inline://payload/${encodeURIComponent(body)}`,
  });

const resolveCwd = (context: SessionExecutorContext): string =>
  context.worktree ?? context.directory ?? Deno.cwd();

const isWithinRoot = (rootPath: string, targetPath: string): boolean => {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const resolveWorkspaceRoot = (context: SessionExecutorContext): string =>
  path.resolve(resolveCwd(context));

const resolveFilePath = (
  context: SessionExecutorContext,
  inputPath: string,
): string => {
  const workspaceRoot = resolveWorkspaceRoot(context);
  const baseDirectory = path.resolve(context.directory ?? workspaceRoot);
  const candidatePath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(baseDirectory, inputPath);

  if (!isWithinRoot(workspaceRoot, candidatePath)) {
    throw new Error(SESSION_EXECUTOR_OUT_OF_WORKSPACE_MESSAGE);
  }

  return candidatePath;
};

const summarizeCommandBody = (stdout: string, stderr: string): string => {
  const body = stdout || stderr;
  return body.trim() || "Command completed with no output.";
};

const summarizeFileBody = (paths: string[], contents: string[]): string =>
  paths.map((filePath, index) => `==> ${filePath} <==\n${contents[index]}`)
    .join("\n\n").trim();

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";

const truncateToBudget = (value: string, budgetBytes: number): string => {
  if (byteLength(value) <= budgetBytes) return value;
  let result = value;
  while (result.length > 1 && byteLength(result) > budgetBytes) {
    result = result.slice(0, Math.max(Math.floor(result.length * 0.8), 1));
  }
  return result;
};

const createBoundedCommandArtifactResponse = async (
  response: SessionExecuteResponse,
  request: SessionExecuteRequest,
  options: Required<
    Pick<
      SessionExecutorOptions,
      "responseBudgetBytes" | "maxNormalizedIndexedBodyBytes" | "storeArtifact"
    >
  >,
): Promise<SessionExecuteResponse> => {
  const artifact = await options.storeArtifact({
    rootSessionId: request.root_session_id,
    toolName: "session_execute",
    body: response.summary,
    maxNormalizedIndexedBodyBytes: options.maxNormalizedIndexedBodyBytes,
  });
  return {
    ...response,
    artifact_ref: artifact.artifactRef,
    summary: truncateToBudget(
      `Oversized output moved to local artifact ${artifact.artifactRef}.`,
      Math.floor(options.responseBudgetBytes / 2),
    ),
    truncated: true,
  };
};

const createBoundedFileArtifactResponse = async (
  response: SessionExecuteFileResponse,
  request: SessionExecuteFileRequest,
  options: Required<
    Pick<
      SessionExecutorOptions,
      "responseBudgetBytes" | "maxNormalizedIndexedBodyBytes" | "storeArtifact"
    >
  >,
): Promise<SessionExecuteFileResponse> => {
  const artifact = await options.storeArtifact({
    rootSessionId: request.root_session_id,
    toolName: "session_execute_file",
    body: response.summary,
    maxNormalizedIndexedBodyBytes: options.maxNormalizedIndexedBodyBytes,
  });
  return {
    ...response,
    artifact_ref: artifact.artifactRef,
    corpus_ref: artifact.corpusRef,
    summary: truncateToBudget(
      `Oversized output moved to local artifact ${artifact.artifactRef}.`,
      Math.floor(options.responseBudgetBytes / 2),
    ),
    truncated: true,
  };
};

const ensureCommandResponseWithinBudget = async (
  response: SessionExecuteResponse,
  request: SessionExecuteRequest,
  options: Required<
    Pick<
      SessionExecutorOptions,
      "responseBudgetBytes" | "maxNormalizedIndexedBodyBytes" | "storeArtifact"
    >
  >,
): Promise<SessionExecuteResponse> => {
  if (byteLength(serialize(response)) <= options.responseBudgetBytes) {
    return response;
  }

  const artifactResponse = await createBoundedCommandArtifactResponse(
    response,
    request,
    options,
  );
  if (byteLength(serialize(artifactResponse)) <= options.responseBudgetBytes) {
    return artifactResponse;
  }

  return {
    ...artifactResponse,
    summary: truncateToBudget(
      artifactResponse.summary,
      Math.floor(options.responseBudgetBytes / 4),
    ),
  };
};

const ensureFileResponseWithinBudget = async (
  response: SessionExecuteFileResponse,
  request: SessionExecuteFileRequest,
  options: Required<
    Pick<
      SessionExecutorOptions,
      "responseBudgetBytes" | "maxNormalizedIndexedBodyBytes" | "storeArtifact"
    >
  >,
): Promise<SessionExecuteFileResponse> => {
  if (byteLength(serialize(response)) <= options.responseBudgetBytes) {
    return response;
  }

  const artifactResponse = await createBoundedFileArtifactResponse(
    response,
    request,
    options,
  );
  if (byteLength(serialize(artifactResponse)) <= options.responseBudgetBytes) {
    return artifactResponse;
  }

  return {
    ...artifactResponse,
    summary: truncateToBudget(
      artifactResponse.summary,
      Math.floor(options.responseBudgetBytes / 4),
    ),
  };
};

const createBoundedBatchStepResponse = async (
  response: SessionBatchCommandResult,
  rootSessionId: string,
  options: Required<
    Pick<
      SessionExecutorOptions,
      "responseBudgetBytes" | "maxNormalizedIndexedBodyBytes" | "storeArtifact"
    >
  >,
): Promise<SessionBatchCommandResult> => {
  const artifactRef = response.result.artifact_ref ??
    (await options.storeArtifact({
      rootSessionId,
      toolName: "session_execute",
      body: response.result.summary,
      maxNormalizedIndexedBodyBytes: options.maxNormalizedIndexedBodyBytes,
    })).artifactRef;
  const compacted: SessionBatchCommandResult = {
    ...response,
    result: {
      ...response.result,
      artifact_ref: artifactRef,
      summary: truncateToBudget(
        `Oversized batch step output moved to local artifact ${artifactRef}.`,
        Math.floor(options.responseBudgetBytes / 4),
      ),
      truncated: true,
    },
  };

  if (byteLength(serialize(compacted)) <= options.responseBudgetBytes) {
    return compacted;
  }

  return {
    ...compacted,
    result: {
      ...compacted.result,
      summary: truncateToBudget(compacted.result.summary, 128),
    },
  };
};

const ensureBatchResponseWithinBudget = async (
  response: SessionBatchCommandResponse,
  request: SessionBatchExecuteRequest,
  options: Required<
    Pick<
      SessionExecutorOptions,
      "responseBudgetBytes" | "maxNormalizedIndexedBodyBytes" | "storeArtifact"
    >
  >,
): Promise<SessionBatchCommandResponse> => {
  if (byteLength(serialize(response)) <= options.responseBudgetBytes) {
    return response;
  }

  const results = [...response.results];
  const oversizedResultIndexes = results
    .map((result, index) => ({
      index,
      bytes: byteLength(serialize(result)),
      summaryBytes: byteLength(result.result.summary),
    }))
    .sort((left, right) =>
      right.bytes - left.bytes || right.summaryBytes - left.summaryBytes
    );

  let compacted: SessionBatchCommandResponse = {
    ...response,
    summary:
      `Batch output truncated to stay within ${options.responseBudgetBytes} bytes.`,
    results,
    truncated: true,
  };

  for (const candidate of oversizedResultIndexes) {
    results[candidate.index] = await createBoundedBatchStepResponse(
      results[candidate.index],
      request.root_session_id,
      options,
    );
    compacted = {
      ...compacted,
      results: [...results],
    };
  }

  if (byteLength(serialize(compacted)) <= options.responseBudgetBytes) {
    return compacted;
  }

  return {
    ...compacted,
    summary: truncateToBudget(compacted.summary, 128),
  };
};

export const createSessionExecutor = (
  options: SessionExecutorOptions = {},
): SessionExecutor => {
  const responseBudgetBytes = options.responseBudgetBytes ??
    SESSION_EXECUTOR_RESPONSE_BUDGET_BYTES;
  const defaultCommandTimeoutSeconds = options.defaultCommandTimeoutSeconds ??
    SESSION_EXECUTOR_DEFAULT_COMMAND_TIMEOUT_SECONDS;
  const maxCommandTimeoutSeconds = options.maxCommandTimeoutSeconds ??
    SESSION_EXECUTOR_MAX_COMMAND_TIMEOUT_SECONDS;
  const maxNormalizedIndexedBodyBytes = options.maxNormalizedIndexedBodyBytes ??
    SESSION_EXECUTOR_MAX_NORMALIZED_INDEXED_BODY_BYTES;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const readFile = options.readFile ?? defaultReadFile;
  const storeArtifact = options.storeArtifact ?? defaultStoreArtifact;
  const readLocalFile = (
    inputPath: string,
    context: SessionExecutorContext,
  ) => readFile(resolveFilePath(context, inputPath));

  const ensureCommand = (
    response: SessionExecuteResponse,
    request: SessionExecuteRequest,
  ) =>
    ensureCommandResponseWithinBudget(response, request, {
      responseBudgetBytes,
      maxNormalizedIndexedBodyBytes,
      storeArtifact,
    });

  const ensureFile = (
    response: SessionExecuteFileResponse,
    request: SessionExecuteFileRequest,
  ) =>
    ensureFileResponseWithinBudget(response, request, {
      responseBudgetBytes,
      maxNormalizedIndexedBodyBytes,
      storeArtifact,
    });

  return {
    readLocalFile,

    async executeCommand(request, context) {
      const timeoutSeconds = clampTimeoutSeconds(request.timeout_seconds, {
        defaultCommandTimeoutSeconds,
        maxCommandTimeoutSeconds,
      });
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        timeoutSeconds * 1000,
      );

      try {
        const result = await runCommand({
          command: request.command,
          cwd: resolveCwd(context),
          timeoutSeconds,
          signal: controller.signal,
        });
        const summary = summarizeCommandBody(result.stdout, result.stderr);
        return await ensureCommand({
          status: result.exitCode === 0 ? "ok" : "error",
          summary,
          exit_code: result.exitCode,
          timed_out: false,
          truncated: false,
          bytes_captured: byteLength(result.stdout) + byteLength(result.stderr),
        }, request);
      } catch (error) {
        if (isAbortError(error)) {
          return await ensureCommand({
            status: "error",
            summary: `Command timed out after ${timeoutSeconds} second(s).`,
            exit_code: -1,
            timed_out: true,
            truncated: false,
            bytes_captured: 0,
          }, request);
        }

        return await ensureCommand({
          status: "error",
          summary: error instanceof Error ? error.message : String(error),
          exit_code: -1,
          timed_out: false,
          truncated: false,
          bytes_captured: 0,
        }, request);
      } finally {
        clearTimeout(timeout);
      }
    },

    async executeFile(request, context) {
      try {
        const contents = await Promise.all(
          request.paths.map((inputPath) => readLocalFile(inputPath, context)),
        );
        return await ensureFile({
          status: "ok",
          summary: summarizeFileBody(request.paths, contents),
          file_count: request.paths.length,
          truncated: false,
        }, request);
      } catch (error) {
        return await ensureFile({
          status: "error",
          summary: error instanceof Error ? error.message : String(error),
          file_count: 0,
          truncated: false,
        }, request);
      }
    },

    async executeBatch(request, context, executeStep) {
      if (request.commands.length === 0) {
        throw new Error("session_batch_execute requires at least one command");
      }

      const stepExecutor = executeStep ??
        ((stepRequest, stepContext) =>
          this.executeCommand(stepRequest, stepContext));
      const results: SessionBatchCommandResult[] = [];

      for (const command of request.commands) {
        const result = await stepExecutor({
          root_session_id: request.root_session_id,
          command: command.command,
          timeout_seconds: command.timeout_seconds,
        }, context);
        results.push(
          { kind: "command", result },
        );
      }

      const batchResponse: SessionBatchCommandResponse = {
        status: results.every((result) => result.result.status === "ok")
          ? "ok"
          : "error",
        summary: `Completed ${results.length} command(s).`,
        results,
        truncated: false,
      };

      return await ensureBatchResponseWithinBudget(batchResponse, {
        root_session_id: request.root_session_id,
        commands: request.commands,
      }, {
        responseBudgetBytes,
        maxNormalizedIndexedBodyBytes,
        storeArtifact,
      }) as SessionBatchExecuteResponse;
    },
  };
};
