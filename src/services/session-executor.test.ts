import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import {
  createSessionExecutor,
  SESSION_EXECUTOR_RESPONSE_BUDGET_BYTES,
} from "./session-executor.ts";
import { sessionMcpResponseSchemas } from "./session-mcp-types.ts";

const textEncoder = new TextEncoder();
type ExecutorOptions = NonNullable<Parameters<typeof createSessionExecutor>[0]>;
type RunCommandInput = NonNullable<ExecutorOptions["runCommand"]> extends (
  input: infer T,
) => Promise<unknown> ? T
  : never;
type StoreArtifactInput = NonNullable<ExecutorOptions["storeArtifact"]> extends
  (
    input: infer T,
  ) => Promise<unknown> ? T
  : never;

describe("session-executor", () => {
  it("enforces command timeouts within the bounded executor", async () => {
    const executor = createSessionExecutor({
      defaultCommandTimeoutSeconds: 1,
      maxCommandTimeoutSeconds: 1,
      runCommand: ({ signal }: RunCommandInput) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        }),
      readFile: () => Promise.reject(new Error("unexpected file read")),
      storeArtifact: () =>
        Promise.resolve({ artifactRef: "local://session_execute/1" }),
    });

    const startedAt = Date.now();
    const response = await executor.executeCommand(
      {
        root_session_id: "root-timeout",
        command: "sleep forever",
        timeout_seconds: 120,
      },
      { worktree: "/workspace/project", directory: "/workspace/project" },
    );

    assert(Date.now() - startedAt < 1_500);
    assertEquals(response.status, "error");
    assertEquals(response.timed_out, true);
    assertEquals(response.exit_code, -1);
    assertEquals(response.truncated, false);
    assertStringIncludes(response.summary.toLowerCase(), "timed out");
    assertEquals(
      sessionMcpResponseSchemas.session_execute.safeParse(response).success,
      true,
    );
  });

  it("reads local files directly from the executor worktree", async () => {
    const readPaths: string[] = [];
    const executor = createSessionExecutor({
      runCommand: () => Promise.reject(new Error("unexpected command")),
      readFile: (path: string) => {
        readPaths.push(path);
        return Promise.resolve("session executor file body");
      },
      storeArtifact: () =>
        Promise.resolve({ artifactRef: "local://session_execute_file/1" }),
    });

    const response = await executor.executeFile(
      {
        root_session_id: "root-file",
        paths: ["notes/today.md"],
      },
      { worktree: "/workspace/project", directory: "/workspace/project" },
    );

    assertEquals(readPaths, ["/workspace/project/notes/today.md"]);
    assertEquals(response.status, "ok");
    assertEquals(response.file_count, 1);
    assertEquals(response.truncated, false);
    assertStringIncludes(response.summary, "session executor file body");
    assertEquals(
      sessionMcpResponseSchemas.session_execute_file.safeParse(response)
        .success,
      true,
    );
  });

  it("executes session batches sequentially through the shared command executor", async () => {
    const executionOrder: string[] = [];
    const executor = createSessionExecutor({
      runCommand: ({ command }: RunCommandInput) => {
        executionOrder.push(command);
        return Promise.resolve({
          exitCode: 0,
          stdout: `${command}-out`,
          stderr: "",
        });
      },
      readFile: () => Promise.reject(new Error("unexpected file read")),
      storeArtifact: () =>
        Promise.resolve({ artifactRef: "local://session_execute/1" }),
    });

    const response = await executor.executeBatch(
      {
        root_session_id: "root-batch",
        commands: [{ command: "first" }, { command: "second" }],
      },
      { worktree: "/workspace/project", directory: "/workspace/project" },
    );

    assertEquals(executionOrder, ["first", "second"]);
    assertEquals(response.status, "ok");
    assertEquals(response.truncated, false);
    const parsed = sessionMcpResponseSchemas.session_batch_execute.safeParse(
      response,
    );
    assertEquals(parsed.success, true);
    if (!parsed.success) return;
    assertEquals(
      parsed.data.results.map((result) =>
        result.kind === "command"
          ? result.result.summary
          : "unexpected-search-result"
      ),
      ["first-out", "second-out"],
    );
  });

  it("stores oversized command output behind a bounded artifact reference", async () => {
    const storedBodies: string[] = [];
    const executor = createSessionExecutor({
      runCommand: () =>
        Promise.resolve({
          exitCode: 0,
          stdout: "x".repeat(SESSION_EXECUTOR_RESPONSE_BUDGET_BYTES + 2_048),
          stderr: "",
        }),
      readFile: () => Promise.reject(new Error("unexpected file read")),
      storeArtifact: ({ body }: StoreArtifactInput) => {
        storedBodies.push(body);
        return Promise.resolve({
          artifactRef: "local://session_execute/overflow-1",
        });
      },
    });

    const response = await executor.executeCommand(
      {
        root_session_id: "root-command-overflow",
        command: "big-output",
      },
      { worktree: "/workspace/project", directory: "/workspace/project" },
    );

    assertEquals(response.truncated, true);
    assertEquals(response.artifact_ref, "local://session_execute/overflow-1");
    assertEquals(storedBodies.length, 1);
    assert(storedBodies[0].length > SESSION_EXECUTOR_RESPONSE_BUDGET_BYTES);
    assert(
      textEncoder.encode(JSON.stringify(response)).byteLength <=
        SESSION_EXECUTOR_RESPONSE_BUDGET_BYTES,
    );
  });

  it("stores oversized file output behind artifact and corpus references", async () => {
    const storedBodies: string[] = [];
    const executor = createSessionExecutor({
      runCommand: () => Promise.reject(new Error("unexpected command")),
      readFile: () =>
        Promise.resolve(
          "y".repeat(SESSION_EXECUTOR_RESPONSE_BUDGET_BYTES + 2_048),
        ),
      storeArtifact: ({ body }: StoreArtifactInput) => {
        storedBodies.push(body);
        return Promise.resolve({
          artifactRef: "local://session_execute_file/overflow-1",
          corpusRef: "session:group:root-file-overflow:corpus:corpus-1:meta",
        });
      },
    });

    const response = await executor.executeFile(
      {
        root_session_id: "root-file-overflow",
        paths: ["notes/huge.md"],
      },
      { worktree: "/workspace/project", directory: "/workspace/project" },
    );

    assertEquals(response.truncated, true);
    assertEquals(
      response.artifact_ref,
      "local://session_execute_file/overflow-1",
    );
    assertEquals(
      response.corpus_ref,
      "session:group:root-file-overflow:corpus:corpus-1:meta",
    );
    assertEquals(storedBodies.length, 1);
    assert(
      textEncoder.encode(JSON.stringify(response)).byteLength <=
        SESSION_EXECUTOR_RESPONSE_BUDGET_BYTES,
    );
  });

  it("passes bounded accounting metadata to artifact storage for oversized command and file responses", async () => {
    const artifactInputs: StoreArtifactInput[] = [];
    const executor = createSessionExecutor({
      runCommand: () =>
        Promise.resolve({
          exitCode: 0,
          stdout: "x".repeat(SESSION_EXECUTOR_RESPONSE_BUDGET_BYTES + 1_024),
          stderr: "",
        }),
      readFile: () =>
        Promise.resolve(
          "y".repeat(SESSION_EXECUTOR_RESPONSE_BUDGET_BYTES + 1_024),
        ),
      storeArtifact: (input: StoreArtifactInput) => {
        artifactInputs.push(input);
        return Promise.resolve({
          artifactRef: `local://${input.toolName}/${artifactInputs.length}`,
          corpusRef:
            `session:group:${input.rootSessionId}:corpus:corpus-${artifactInputs.length}:meta`,
        });
      },
    });

    await executor.executeCommand(
      {
        root_session_id: "root-accounting",
        command: "huge-command",
      },
      { worktree: "/workspace/project", directory: "/workspace/project" },
    );
    await executor.executeFile(
      {
        root_session_id: "root-accounting",
        paths: ["notes/huge.md"],
      },
      { worktree: "/workspace/project", directory: "/workspace/project" },
    );

    assertEquals(artifactInputs.length, 2);
    assertEquals(artifactInputs[0].rootSessionId, "root-accounting");
    assertEquals(artifactInputs[0].toolName, "session_execute");
    assertEquals(
      artifactInputs[0].maxNormalizedIndexedBodyBytes >
        SESSION_EXECUTOR_RESPONSE_BUDGET_BYTES,
      true,
    );
    assertEquals(artifactInputs[1].toolName, "session_execute_file");
    assertEquals(
      artifactInputs.every((input) => input.body.length > 0),
      true,
    );
  });

  it("returns bounded schema-valid failures for command and file errors", async () => {
    const executor = createSessionExecutor({
      runCommand: () =>
        Promise.resolve({
          exitCode: 17,
          stdout: "",
          stderr: "command failed loudly",
        }),
      readFile: () => Promise.reject(new Error("file missing")),
      storeArtifact: () =>
        Promise.resolve({ artifactRef: "local://session_execute/unused" }),
    });

    const commandFailure = await executor.executeCommand(
      {
        root_session_id: "root-command-failure",
        command: "explode",
      },
      { worktree: "/workspace/project", directory: "/workspace/project" },
    );
    const fileFailure = await executor.executeFile(
      {
        root_session_id: "root-file-failure",
        paths: ["missing.txt"],
      },
      { worktree: "/workspace/project", directory: "/workspace/project" },
    );

    assertEquals(commandFailure.status, "error");
    assertEquals(commandFailure.exit_code, 17);
    assertEquals(commandFailure.timed_out, false);
    assertStringIncludes(commandFailure.summary, "command failed loudly");
    assertEquals(fileFailure.status, "error");
    assertEquals(fileFailure.file_count, 0);
    assertEquals(fileFailure.truncated, false);
    assertStringIncludes(fileFailure.summary, "file missing");
    assertEquals(
      sessionMcpResponseSchemas.session_execute.safeParse(commandFailure)
        .success,
      true,
    );
    assertEquals(
      sessionMcpResponseSchemas.session_execute_file.safeParse(fileFailure)
        .success,
      true,
    );
  });

  it("rejects invalid empty batch requests", async () => {
    const executor = createSessionExecutor({
      runCommand: () =>
        Promise.resolve({ exitCode: 0, stdout: "ok", stderr: "" }),
      readFile: () => Promise.resolve("ok"),
      storeArtifact: () =>
        Promise.resolve({ artifactRef: "local://session_execute/1" }),
    });

    await assertRejects(
      () =>
        executor.executeBatch(
          {
            root_session_id: "root-empty-batch",
            commands: [],
          },
          {
            worktree: "/workspace/project",
            directory: "/workspace/project",
          },
        ),
      Error,
      "at least one command",
    );
  });
});
