import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "jsr:@std/assert@^1.0.0";
import { afterEach, describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import {
  graphiti,
  warnOnGraphitiStartupUnavailable,
  warnOnRedisStartupUnavailable,
} from "./index.ts";
import { logger } from "./services/logger.ts";
import { registerRuntimeTeardown } from "./services/runtime-teardown.ts";
import {
  SESSION_SEARCH_BASELINE_DESCRIPTION,
  SESSION_SEARCH_STRENGTHENED_DESCRIPTION,
} from "./services/session-mcp-runtime.ts";
import { createSessionMcpRuntime } from "./services/session-mcp-runtime.ts";
import {
  notifyDreamShutdownDelay,
  setOpenCodeClient,
  setWarningTaskScheduler,
} from "./services/opencode-warning.ts";
import type { DreamJob } from "./services/dream-jobs.ts";
import { makeGroupId, makeUserGroupId } from "./utils.ts";

const invokeGraphiti = graphiti as unknown as (
  input: { client: unknown; directory: string },
  dependencies: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

function createEntrypointHarness(connected: boolean) {
  return createEntrypointHarnessWithOptions({ connected });
}

function createEntrypointHarnessWithOptions(options: {
  connected?: boolean;
  readyError?: Error;
  redisConnectError?: Error;
  priorEventsBySessionId?: Record<string, unknown[]>;
  dreamWatermarksBySessionId?: Record<string, string | null>;
  trackedRootSessionIds?: string[];
  spawnDetachedDreamWorkerResult?: boolean;
  nowValues?: string[];
  teardownRun?: () => Promise<void>;
  teardownDispose?: () => void;
  createSessionMcpRuntimeError?: Error;
  createEventHandlerError?: Error;
  teardownRunError?: Error;
}) {
  const connected = options.connected ?? true;
  const config = {
    graphiti: {
      endpoint: "http://graphiti.test/mcp",
      driftThreshold: 42,
      groupIdPrefix: "prefix",
    },
    redis: {
      endpoint: "redis://redis.test:6379",
      sessionTtlSeconds: 60,
      cacheTtlSeconds: 90,
      batchSize: 7,
      batchMaxBytes: 2048,
      drainRetryMax: 5,
    },
  };
  const input = {
    client: { id: "client" },
    directory: "/workspace/project",
  };
  const hooks = {
    event: { kind: "event" },
    chat: (input: unknown, output: unknown) => {
      records.chatHookCalls.push({ input, output });
    },
    compacting: (input: unknown, output: unknown) => {
      records.compactingHookCalls.push({ input, output });
    },
    messages: { kind: "messages" },
    tool: {
      session_execute: { kind: "session_execute" },
    },
    toolBefore: { kind: "tool-before" },
    toolAfter: { kind: "tool-after" },
  };
  const records = {
    loadConfigCalls: [] as string[],
    setOpenCodeClientCalls: [] as unknown[],
    graphitiWarnCalls: [] as Array<{ connected: boolean; endpoint: string }>,
    redisWarnCalls: [] as Array<{ connected: boolean; endpoint: string }>,
    connectionManagerOptions: [] as Array<{ endpoint: string }>,
    connectionManagerInstances: [] as unknown[],
    connectionStartCalls: 0,
    connectionReadyCalls: 0,
    connectionStopCalls: 0,
    redisClientOptions: [] as Array<{ endpoint: string }>,
    redisClientInstances: [] as unknown[],
    redisConnectCalls: 0,
    redisCloseCalls: 0,
    graphitiAsyncDisposeCalls: 0,
    graphitiAsyncFlushCalls: [] as string[][],
    dreamStoreArgs: [] as unknown[],
    dreamStoreInstances: [] as unknown[],
    dreamStoreGetWatermarkCalls: [] as string[],
    spawnDetachedDreamWorkerCalls: [] as Array<{
      directory: string;
      job: DreamJob;
    }>,
    notifyDreamShutdownDelayCalls: 0,
    nowCalls: 0,
    createSessionExecutorCalls: [] as Array<
      Record<string, unknown> | undefined
    >,
    sessionExecutorInstances: [] as unknown[],
    sessionMcpRuntimeArgs: [] as Array<Record<string, unknown> | undefined>,
    sessionMcpRuntimeDisposeCalls: 0,
    sessionMcpRuntimeInstances: [] as unknown[],
    sessionMcpRuntimeCanonicalizerCalls: [] as unknown[],
    teardownTaskRuns: [] as string[],
    teardownRegistrations: [] as Array<
      {
        tasks: Array<{ name: string; run: () => unknown }>;
        registration: { run: () => Promise<void>; dispose: () => void };
      }
    >,
    graphitiMcpArgs: [] as unknown[],
    graphitiMcpInstances: [] as unknown[],
    redisEventsArgs: [] as Array<[unknown, { sessionTtlSeconds: number }]>,
    redisEventsInstances: [] as unknown[],
    redisEventsRecentCalls: [] as Array<{
      sessionId: string;
      limit: number;
      chronological: boolean;
    }>,
    redisSnapshotArgs: [] as Array<[unknown, { ttlSeconds: number }]>,
    redisSnapshotInstances: [] as unknown[],
    redisCacheArgs: [] as Array<[
      unknown,
      { ttlSeconds: number; driftThreshold: number },
    ]>,
    redisCacheInstances: [] as unknown[],
    sessionNotesArgs: [] as Array<[
      unknown,
      { groupId: string },
    ]>,
    sessionNotesInstances: [] as unknown[],
    batchDrainArgs: [] as Array<[
      unknown,
      unknown,
      { batchSize: number; batchMaxBytes: number; drainRetryMax: number },
    ]>,
    batchDrainInstances: [] as unknown[],
    graphitiAsyncArgs: [] as Array<[unknown, unknown, unknown]>,
    graphitiAsyncInstances: [] as unknown[],
    makeGroupIdCalls: [] as Array<[string | undefined, string]>,
    makeUserGroupIdCalls: [] as Array<[string | undefined, string]>,
    sessionManagerArgs: [] as Array<[
      string,
      string,
      unknown,
      unknown,
      unknown,
      unknown,
      {
        idleRetentionMs: number;
        runtimeStateMigrator: unknown;
        notesService?: unknown;
      },
    ]>,
    sessionManagerInstances: [] as unknown[],
    createEventHandlerArgs: [] as Array<Record<string, unknown>>,
    createChatHandlerArgs: [] as Array<Record<string, unknown>>,
    createCompactingHandlerArgs: [] as Array<Record<string, unknown>>,
    createMessagesHandlerArgs: [] as Array<Record<string, unknown>>,
    createToolBeforeHandlerArgs: [] as Array<Record<string, unknown>>,
    createToolAfterHandlerArgs: [] as Array<Record<string, unknown>>,
    chatHookCalls: [] as Array<{ input: unknown; output: unknown }>,
    compactingHookCalls: [] as Array<{ input: unknown; output: unknown }>,
    toolGuidanceCacheInstances: [] as unknown[],
    toolRoutingOutcomeCacheInstances: [] as unknown[],
    teardownDisposeCalls: 0,
  };

  class MockGraphitiConnectionManager {
    constructor(options: { endpoint: string }) {
      records.connectionManagerOptions.push(options);
      records.connectionManagerInstances.push(this);
    }

    start() {
      records.connectionStartCalls += 1;
    }

    ready() {
      records.connectionReadyCalls += 1;
      if (options.readyError) {
        return Promise.reject(options.readyError);
      }
      return Promise.resolve(connected);
    }

    stop() {
      records.connectionStopCalls += 1;
      records.teardownTaskRuns.push("graphiti");
    }
  }

  class MockRedisClient {
    constructor(options: { endpoint: string }) {
      records.redisClientOptions.push(options);
      records.redisClientInstances.push(this);
    }

    connect() {
      records.redisConnectCalls += 1;
      if (options.redisConnectError) {
        return Promise.reject(options.redisConnectError);
      }
      return Promise.resolve();
    }

    close() {
      records.redisCloseCalls += 1;
      records.teardownTaskRuns.push("redis");
      return Promise.resolve();
    }
  }

  class MockGraphitiMcpClient {
    constructor(connectionManager: unknown) {
      records.graphitiMcpArgs.push(connectionManager);
      records.graphitiMcpInstances.push(this);
    }
  }

  class MockRedisEventsService {
    constructor(redisClient: unknown, options: { sessionTtlSeconds: number }) {
      records.redisEventsArgs.push([redisClient, options]);
      records.redisEventsInstances.push(this);
    }

    getRecentSessionEvents(
      sessionId: string,
      limit = 40,
      chronological = true,
    ) {
      records.redisEventsRecentCalls.push({ sessionId, limit, chronological });
      return Promise.resolve(options.priorEventsBySessionId?.[sessionId] ?? []);
    }
  }

  class MockRedisSnapshotService {
    constructor(redisClient: unknown, options: { ttlSeconds: number }) {
      records.redisSnapshotArgs.push([redisClient, options]);
      records.redisSnapshotInstances.push(this);
    }
  }

  class MockRedisCacheService {
    constructor(
      redisClient: unknown,
      options: { ttlSeconds: number; driftThreshold: number },
    ) {
      records.redisCacheArgs.push([redisClient, options]);
      records.redisCacheInstances.push(this);
    }
  }

  class MockSessionNotesService {
    constructor(
      redisClient: unknown,
      options: { groupId: string },
    ) {
      records.sessionNotesArgs.push([redisClient, options]);
      records.sessionNotesInstances.push(this);
    }
  }

  class MockBatchDrainService {
    constructor(
      redisClient: unknown,
      redisEvents: unknown,
      options: {
        batchSize: number;
        batchMaxBytes: number;
        drainRetryMax: number;
      },
    ) {
      records.batchDrainArgs.push([redisClient, redisEvents, options]);
      records.batchDrainInstances.push(this);
    }
  }

  class MockDreamStore {
    constructor(redisClient: unknown) {
      records.dreamStoreArgs.push(redisClient);
      records.dreamStoreInstances.push(this);
    }

    getWatermark(rootSessionId: string) {
      records.dreamStoreGetWatermarkCalls.push(rootSessionId);
      return Promise.resolve(
        options.dreamWatermarksBySessionId?.[rootSessionId] ?? null,
      );
    }
  }

  class MockGraphitiAsyncService {
    constructor(
      graphitiClient: unknown,
      redisCache: unknown,
      batchDrain: unknown,
    ) {
      records.graphitiAsyncArgs.push([graphitiClient, redisCache, batchDrain]);
      records.graphitiAsyncInstances.push(this);
    }

    dispose() {
      records.graphitiAsyncDisposeCalls += 1;
      records.teardownTaskRuns.push("graphiti-async");
      return Promise.resolve();
    }

    flushPendingGroups(groupIds: Iterable<string>) {
      records.graphitiAsyncFlushCalls.push([...groupIds]);
      records.teardownTaskRuns.push("graphiti-drain-flush");
      return Promise.resolve();
    }
  }

  class MockSessionManager {
    getCachedCanonicalSessionId(sessionId: string) {
      return sessionId;
    }

    resolveCanonicalSessionId(sessionId: string) {
      return Promise.resolve(sessionId);
    }

    getTrackedGroupIds() {
      return ["group-id"];
    }

    getTrackedRootSessionIds() {
      return options.trackedRootSessionIds ?? ["root-session"];
    }

    constructor(
      defaultGroupId: string,
      defaultUserGroupId: string,
      client: unknown,
      redisEvents: unknown,
      redisSnapshot: unknown,
      redisCache: unknown,
      options: { idleRetentionMs: number; runtimeStateMigrator: unknown },
    ) {
      records.sessionManagerArgs.push([
        defaultGroupId,
        defaultUserGroupId,
        client,
        redisEvents,
        redisSnapshot,
        redisCache,
        options,
      ]);
      records.sessionManagerInstances.push(this);
    }
  }

  class MockToolGuidanceCache {
    constructor() {
      records.toolGuidanceCacheInstances.push(this);
    }
  }

  class MockToolRoutingOutcomeCache {
    constructor() {
      records.toolRoutingOutcomeCacheInstances.push(this);
    }
  }

  class MockSessionMcpRuntime {
    tools = hooks.tool;

    constructor(args?: Record<string, unknown>) {
      records.sessionMcpRuntimeArgs.push(args);
      records.sessionMcpRuntimeInstances.push(this);
    }

    dispose() {
      records.sessionMcpRuntimeDisposeCalls += 1;
      records.teardownTaskRuns.push("session-mcp-runtime");
      return Promise.resolve();
    }

    setSessionCanonicalizer(sessionCanonicalizer: unknown) {
      records.sessionMcpRuntimeCanonicalizerCalls.push(sessionCanonicalizer);
    }
  }

  class MockSessionExecutor {
    constructor(args?: Record<string, unknown>) {
      records.createSessionExecutorCalls.push(args);
      records.sessionExecutorInstances.push(this);
    }
  }

  const dependencies = {
    loadConfig: (directory: string) => {
      records.loadConfigCalls.push(directory);
      return config;
    },
    setOpenCodeClient: (client: unknown) => {
      records.setOpenCodeClientCalls.push(client);
    },
    warnOnGraphitiStartupUnavailable: (ready: boolean, endpoint: string) => {
      records.graphitiWarnCalls.push({ connected: ready, endpoint });
    },
    warnOnRedisStartupUnavailable: (ready: boolean, endpoint: string) => {
      records.redisWarnCalls.push({ connected: ready, endpoint });
    },
    GraphitiConnectionManager: MockGraphitiConnectionManager,
    RedisClient: MockRedisClient,
    registerRuntimeTeardown: (
      tasks: Array<{ name: string; run: () => unknown }>,
    ) => {
      const registration = {
        run: options.teardownRun ??
          (async () => {
            if (options.teardownRunError) {
              throw options.teardownRunError;
            }
            for (const task of tasks) {
              await task.run();
            }
          }),
        dispose: options.teardownDispose ?? (() => {
          records.teardownDisposeCalls += 1;
        }),
      };
      records.teardownRegistrations.push({ tasks, registration });
      return registration;
    },
    GraphitiMcpClient: MockGraphitiMcpClient,
    RedisEventsService: MockRedisEventsService,
    RedisSnapshotService: MockRedisSnapshotService,
    RedisCacheService: MockRedisCacheService,
    SessionNotesService: MockSessionNotesService,
    BatchDrainService: MockBatchDrainService,
    DreamStore: MockDreamStore,
    GraphitiAsyncService: MockGraphitiAsyncService,
    spawnDetachedDreamWorker: (input: {
      directory: string;
      job: DreamJob;
    }) => {
      records.spawnDetachedDreamWorkerCalls.push(input);
      return Promise.resolve(options.spawnDetachedDreamWorkerResult ?? true);
    },
    notifyDreamShutdownDelay: () => {
      records.notifyDreamShutdownDelayCalls += 1;
    },
    now: () => {
      const value = options.nowValues?.shift() ?? "2026-04-21T12:00:00.000Z";
      records.nowCalls += 1;
      return value;
    },
    createSessionExecutor: (args?: Record<string, unknown>) =>
      new MockSessionExecutor(args),
    createSessionMcpRuntime: (args?: Record<string, unknown>) =>
      (() => {
        if (options.createSessionMcpRuntimeError) {
          throw options.createSessionMcpRuntimeError;
        }
        return new MockSessionMcpRuntime(args);
      })(),
    SessionManager: MockSessionManager,
    createEventHandler: (args: Record<string, unknown>) => {
      if (options.createEventHandlerError) {
        throw options.createEventHandlerError;
      }
      records.createEventHandlerArgs.push(args);
      return hooks.event;
    },
    createChatHandler: (args: Record<string, unknown>) => {
      records.createChatHandlerArgs.push(args);
      return hooks.chat;
    },
    createCompactingHandler: (args: Record<string, unknown>) => {
      records.createCompactingHandlerArgs.push(args);
      return hooks.compacting;
    },
    createMessagesHandler: (args: Record<string, unknown>) => {
      records.createMessagesHandlerArgs.push(args);
      return hooks.messages;
    },
    createToolBeforeHandler: (args: Record<string, unknown>) => {
      records.createToolBeforeHandlerArgs.push(args);
      return hooks.toolBefore;
    },
    createToolAfterHandler: (args: Record<string, unknown>) => {
      records.createToolAfterHandlerArgs.push(args);
      return hooks.toolAfter;
    },
    ToolGuidanceCache: MockToolGuidanceCache,
    ToolRoutingOutcomeCache: MockToolRoutingOutcomeCache,
    makeGroupId: (prefix: string | undefined, directory: string) => {
      records.makeGroupIdCalls.push([prefix, directory]);
      return "group-id";
    },
    makeUserGroupId: (prefix: string | undefined, directory: string) => {
      records.makeUserGroupIdCalls.push([prefix, directory]);
      return "user-group-id";
    },
  };

  return { config, input, hooks, records, dependencies };
}

describe("index", () => {
  afterEach(() => {
    setOpenCodeClient(undefined);
    setWarningTaskScheduler(undefined);
  });

  describe("makeGroupId", () => {
    it("should omit undefined prefix text when prefix is missing", () => {
      const groupId = makeGroupId(undefined, "/home/user/my-project");
      assertEquals(groupId, "MyProject__main");
    });

    it("should create group ID from simple directory path", () => {
      const groupId = makeGroupId("opencode", "/home/user/my-project");
      assertEquals(groupId, "opencode_MyProject__main");
    });

    it("should use last directory component as project name", () => {
      const groupId = makeGroupId("test", "/var/www/html/app");
      assertEquals(groupId, "test_App__main");
    });

    it("should handle single directory name", () => {
      const groupId = makeGroupId("prefix", "project");
      assertEquals(groupId, "prefix_Project__main");
    });

    it("should return default when directory is empty", () => {
      const groupId = makeGroupId("prefix", "");
      assertEquals(groupId, "prefix_Default__main");
    });

    it("should return default when directory is just slashes", () => {
      const groupId = makeGroupId("prefix", "///");
      assertEquals(groupId, "prefix_Default__main");
    });

    it("should sanitize special characters to underscores", () => {
      const groupId = makeGroupId("opencode", "/home/user/my-project@2.0");
      assertEquals(groupId, "opencode_MyProject20__main");
    });

    it("should sanitize multiple special characters", () => {
      const groupId = makeGroupId("test", "/projects/my project (v1.0)");
      assertEquals(groupId, "test_MyProjectV10__main");
    });

    it("should normalize hyphens and underscores into PascalCase", () => {
      const groupId = makeGroupId("prefix", "/dir/my_project-name");
      assertEquals(groupId, "prefix_MyProjectName__main");
    });

    it("should handle directory with dots", () => {
      const groupId = makeGroupId("test", "/projects/app.example.com");
      assertEquals(groupId, "test_AppExampleCom__main");
    });

    it("should handle directory with spaces", () => {
      const groupId = makeGroupId("test", "/home/my projects/app name");
      assertEquals(groupId, "test_AppName__main");
    });

    it("should handle directory ending with slash", () => {
      const groupId = makeGroupId("test", "/home/user/project/");
      assertEquals(groupId, "test_Project__main");
    });

    it("should handle complex path with multiple special chars", () => {
      const groupId = makeGroupId(
        "opencode",
        "/Users/name/Projects/my-app@v2.0 (beta)",
      );
      assertEquals(groupId, "opencode_MyAppV20Beta__main");
    });

    it("should use different prefixes correctly", () => {
      const groupId1 = makeGroupId("prod", "/apps/myapp");
      const groupId2 = makeGroupId("dev", "/apps/myapp");
      assertEquals(groupId1, "prod_Myapp__main");
      assertEquals(groupId2, "dev_Myapp__main");
    });

    it("should keep unicode-only basenames non-default", () => {
      const groupId = makeGroupId("test", "/projects/مشروع");
      assertEquals(groupId, "test_مشروع__main");
    });

    it("should handle very long directory names", () => {
      const longName = "a".repeat(200);
      const groupId = makeGroupId("test", `/projects/${longName}`);
      assertEquals(groupId, `test_${"A"}${"a".repeat(199)}__main`);
    });

    it("should be deterministic", () => {
      const path = "/home/user/project";
      const groupId1 = makeGroupId("prefix", path);
      const groupId2 = makeGroupId("prefix", path);
      assertEquals(groupId1, groupId2);
    });
  });

  describe("makeUserGroupId", () => {
    it("should omit undefined prefix text when prefix is missing", () => {
      const groupId = makeUserGroupId(undefined, "/home/user/my-project");
      assertEquals(groupId.startsWith("undefined"), false);
      assertEquals(groupId.startsWith("MyProject__user_"), true);
    });

    it("should preserve unicode-only project basenames", () => {
      const groupId = makeUserGroupId("prefix", "/projects/東京");
      assertEquals(groupId.startsWith("prefix_東京__user_"), true);
    });
  });

  describe("warnOnGraphitiStartupUnavailable", () => {
    it("shows a native warning toast and structured log when Graphiti is unavailable", () => {
      const appLogCalls: unknown[] = [];
      const toastCalls: unknown[] = [];
      const scheduledTasks: Array<() => void> = [];
      setWarningTaskScheduler((callback) => {
        scheduledTasks.push(callback);
      });
      setOpenCodeClient({
        app: {
          log: (input: unknown) => {
            appLogCalls.push(input);
          },
        },
        tui: {
          showToast: (input: unknown) => {
            toastCalls.push(input);
          },
        },
      });

      warnOnGraphitiStartupUnavailable(false, "http://graphiti.test/mcp");

      assertEquals(appLogCalls.length, 0);
      assertEquals(toastCalls.length, 0);
      assertEquals(scheduledTasks.length, 2);
      for (const task of scheduledTasks) task();

      assertEquals(appLogCalls.length, 1);
      assertEquals(appLogCalls, [{
        body: {
          service: "graphiti",
          level: "warn",
          message:
            "Graphiti MCP unavailable at http://graphiti.test/mcp; continuing without persistent memory.",
          extra: {
            endpoint: "http://graphiti.test/mcp",
          },
        },
      }]);
      assertEquals(toastCalls, [{
        body: {
          message:
            "Graphiti MCP unavailable at http://graphiti.test/mcp; continuing without persistent memory.",
          variant: "warning",
        },
      }]);
    });

    it("redacts URL credentials from Graphiti startup warnings", () => {
      const appLogCalls: unknown[] = [];
      const toastCalls: unknown[] = [];
      const scheduledTasks: Array<() => void> = [];
      setWarningTaskScheduler((callback) => {
        scheduledTasks.push(callback);
      });
      setOpenCodeClient({
        app: {
          log: (input: unknown) => {
            appLogCalls.push(input);
          },
        },
        tui: {
          showToast: (input: unknown) => {
            toastCalls.push(input);
          },
        },
      });

      warnOnGraphitiStartupUnavailable(
        false,
        "http://user:secret@graphiti.test/mcp",
      );

      for (const task of scheduledTasks) task();

      assertEquals(appLogCalls, [{
        body: {
          service: "graphiti",
          level: "warn",
          message:
            "Graphiti MCP unavailable at http://graphiti.test/mcp; continuing without persistent memory.",
          extra: {
            endpoint: "http://graphiti.test/mcp",
          },
        },
      }]);
      assertEquals(toastCalls, [{
        body: {
          message:
            "Graphiti MCP unavailable at http://graphiti.test/mcp; continuing without persistent memory.",
          variant: "warning",
        },
      }]);
    });

    it("redacts malformed Graphiti endpoint credentials in startup warnings", () => {
      const appLogCalls: unknown[] = [];
      const toastCalls: unknown[] = [];
      const scheduledTasks: Array<() => void> = [];
      setWarningTaskScheduler((callback) => {
        scheduledTasks.push(callback);
      });
      setOpenCodeClient({
        app: {
          log: (input: unknown) => {
            appLogCalls.push(input);
          },
        },
        tui: {
          showToast: (input: unknown) => {
            toastCalls.push(input);
          },
        },
      });

      warnOnGraphitiStartupUnavailable(
        false,
        "http://user:secret@graphiti.test:bad",
      );

      for (const task of scheduledTasks) task();

      assertEquals(appLogCalls, [{
        body: {
          service: "graphiti",
          level: "warn",
          message:
            "Graphiti MCP unavailable at http://graphiti.test:bad; continuing without persistent memory.",
          extra: {
            endpoint: "http://graphiti.test:bad",
          },
        },
      }]);
      assertEquals(toastCalls, [{
        body: {
          message:
            "Graphiti MCP unavailable at http://graphiti.test:bad; continuing without persistent memory.",
          variant: "warning",
        },
      }]);
    });

    it("does nothing when Graphiti is connected", () => {
      const appLogCalls: unknown[] = [];
      const toastCalls: unknown[] = [];
      setOpenCodeClient({
        app: {
          log: (input: unknown) => {
            appLogCalls.push(input);
          },
        },
        tui: {
          showToast: (input: unknown) => {
            toastCalls.push(input);
          },
        },
      });

      warnOnGraphitiStartupUnavailable(true, "http://graphiti.test/mcp");

      assertEquals(appLogCalls.length, 0);
      assertEquals(toastCalls.length, 0);
    });
  });

  describe("warnOnRedisStartupUnavailable", () => {
    it("shows a native warning toast and structured log when Redis is unavailable", () => {
      const appLogCalls: unknown[] = [];
      const toastCalls: unknown[] = [];
      const scheduledTasks: Array<() => void> = [];
      setWarningTaskScheduler((callback) => {
        scheduledTasks.push(callback);
      });
      setOpenCodeClient({
        app: {
          log: (input: unknown) => {
            appLogCalls.push(input);
          },
        },
        tui: {
          showToast: (input: unknown) => {
            toastCalls.push(input);
          },
        },
      });

      warnOnRedisStartupUnavailable(true, "redis://redis.test:6379");

      assertEquals(appLogCalls.length, 0);
      assertEquals(toastCalls.length, 0);
      assertEquals(scheduledTasks.length, 0);

      warnOnRedisStartupUnavailable(false, "redis://redis.test:6379");

      assertEquals(appLogCalls.length, 0);
      assertEquals(toastCalls.length, 0);
      assertEquals(scheduledTasks.length, 2);
      for (const task of scheduledTasks) task();

      assertEquals(appLogCalls.length, 1);
      assertEquals(appLogCalls, [{
        body: {
          service: "graphiti",
          level: "warn",
          message:
            "Redis unavailable at redis://redis.test:6379; continuing with in-memory hot-tier fallback.",
          extra: {
            endpoint: "redis://redis.test:6379",
          },
        },
      }]);
      assertEquals(toastCalls, [{
        body: {
          message:
            "Redis unavailable at redis://redis.test:6379; continuing with in-memory hot-tier fallback.",
          variant: "warning",
        },
      }]);
    });

    it("redacts URL credentials from Redis startup warnings", () => {
      const appLogCalls: unknown[] = [];
      const toastCalls: unknown[] = [];
      const scheduledTasks: Array<() => void> = [];
      setWarningTaskScheduler((callback) => {
        scheduledTasks.push(callback);
      });
      setOpenCodeClient({
        app: {
          log: (input: unknown) => {
            appLogCalls.push(input);
          },
        },
        tui: {
          showToast: (input: unknown) => {
            toastCalls.push(input);
          },
        },
      });

      warnOnRedisStartupUnavailable(
        false,
        "redis://user:secret@redis.test:6379",
      );

      for (const task of scheduledTasks) task();

      assertEquals(appLogCalls, [{
        body: {
          service: "graphiti",
          level: "warn",
          message:
            "Redis unavailable at redis://redis.test:6379; continuing with in-memory hot-tier fallback.",
          extra: {
            endpoint: "redis://redis.test:6379",
          },
        },
      }]);
      assertEquals(toastCalls, [{
        body: {
          message:
            "Redis unavailable at redis://redis.test:6379; continuing with in-memory hot-tier fallback.",
          variant: "warning",
        },
      }]);
    });

    it("redacts malformed Redis endpoint credentials in startup warnings", () => {
      const appLogCalls: unknown[] = [];
      const toastCalls: unknown[] = [];
      const scheduledTasks: Array<() => void> = [];
      setWarningTaskScheduler((callback) => {
        scheduledTasks.push(callback);
      });
      setOpenCodeClient({
        app: {
          log: (input: unknown) => {
            appLogCalls.push(input);
          },
        },
        tui: {
          showToast: (input: unknown) => {
            toastCalls.push(input);
          },
        },
      });

      warnOnRedisStartupUnavailable(
        false,
        "redis://user:secret@redis.test:bad",
      );

      for (const task of scheduledTasks) task();

      assertEquals(appLogCalls, [{
        body: {
          service: "graphiti",
          level: "warn",
          message:
            "Redis unavailable at redis://redis.test:bad; continuing with in-memory hot-tier fallback.",
          extra: {
            endpoint: "redis://redis.test:bad",
          },
        },
      }]);
      assertEquals(toastCalls, [{
        body: {
          message:
            "Redis unavailable at redis://redis.test:bad; continuing with in-memory hot-tier fallback.",
          variant: "warning",
        },
      }]);
    });
  });

  describe("notifyDreamShutdownDelay", () => {
    it("shows a dedicated warning toast for dream shutdown delay", () => {
      const appLogCalls: unknown[] = [];
      const toastCalls: unknown[] = [];
      const scheduledTasks: Array<() => void> = [];
      setWarningTaskScheduler((callback) => {
        scheduledTasks.push(callback);
      });
      setOpenCodeClient({
        app: {
          log: (input: unknown) => {
            appLogCalls.push(input);
          },
        },
        tui: {
          showToast: (input: unknown) => {
            toastCalls.push(input);
          },
        },
      });

      notifyDreamShutdownDelay();

      assertEquals(scheduledTasks.length, 2);
      for (const task of scheduledTasks) task();

      assertEquals(appLogCalls, [{
        body: {
          service: "graphiti",
          level: "warn",
          message:
            "Dreaming is still in progress; keep OpenCode open and wait for dreaming to complete before exiting.",
        },
      }]);
      assertEquals(toastCalls, [{
        body: {
          message:
            "Dreaming is still in progress; keep OpenCode open and wait for dreaming to complete before exiting.",
          variant: "warning",
        },
      }]);
    });
  });

  describe("graphiti entrypoint", () => {
    it("exposes public note/search tool args without root_session_id", () => {
      const runtime = createSessionMcpRuntime();

      try {
        assertStringIncludes(
          runtime.tools.session_notes_write.description,
          "delete on missing id is a no-op success returning deleted",
        );
        assertStringIncludes(
          runtime.tools.session_notes_write.description,
          "any same-project session may delete a note by id",
        );
        assertStringIncludes(
          runtime.tools.session_notes_read.description,
          "returns `{ note: null }`",
        );
        assertStringIncludes(
          runtime.tools.session_search.description,
          '`id`, `root_session_id`, `scope: "local" | "project"`, `created_at`, and',
        );
        assertStringIncludes(
          runtime.tools.session_fetch_and_index.description,
          "session_search({ query: corpus_ref })",
        );
        assertStringIncludes(
          runtime.tools.session_fetch_and_index.description,
          "exact `corpus_ref`",
        );
        assertStringIncludes(
          runtime.tools.session_search.description,
          "session_search({ query: corpus_ref })",
        );
        assertStringIncludes(
          runtime.tools.session_search.description,
          "exact `corpus_ref` previously returned by `session_fetch_and_index`",
        );
        assertStringIncludes(
          runtime.tools.session_execute.description,
          "Do not pass `root_session_id`; the runtime resolves the current canonical",
        );
        assertStringIncludes(
          runtime.tools.session_notes_write.description,
          "Do not pass `root_session_id`; the runtime resolves the current canonical",
        );
        assertEquals(Object.keys(runtime.tools.session_notes_write.args), [
          "text",
          "replace",
        ]);
        assertEquals(Object.keys(runtime.tools.session_notes_read.args), [
          "id",
        ]);
        assertEquals(Object.keys(runtime.tools.session_search.args), [
          "query",
          "when",
        ]);
      } finally {
        void runtime.dispose();
      }
    });

    it("exports graphiti as the plugin entrypoint", () => {
      assertEquals(typeof graphiti, "function");
    });

    it("wires startup dependencies and returns handler hooks", async () => {
      const { config, input, hooks, records, dependencies } =
        createEntrypointHarness(true);

      const plugin = await invokeGraphiti(input, dependencies);
      await Promise.resolve();

      assertEquals(records.loadConfigCalls, [input.directory]);
      assertEquals(records.setOpenCodeClientCalls, [input.client]);
      assertEquals(records.connectionManagerOptions, [{
        endpoint: config.graphiti.endpoint,
      }]);
      assertEquals(records.connectionStartCalls, 1);
      assertEquals(records.connectionReadyCalls, 1);
      assertEquals(records.graphitiWarnCalls, []);
      assertEquals(records.redisWarnCalls, []);

      assertEquals(records.redisClientOptions, [{
        endpoint: config.redis.endpoint,
      }]);
      assertEquals(records.redisConnectCalls, 1);
      assertEquals(records.teardownRegistrations.length, 1);
      assertEquals(
        records.teardownRegistrations[0].tasks.map((task) => task.name),
        [
          "dream-shutdown-warning",
          "graphiti-drain-flush",
          "graphiti-async",
          "session-mcp-runtime",
          "graphiti",
          "redis",
        ],
      );

      records.teardownRegistrations[0].tasks[0].run();
      records.teardownRegistrations[0].tasks[1].run();
      records.teardownRegistrations[0].tasks[2].run();
      records.teardownRegistrations[0].tasks[3].run();
      records.teardownRegistrations[0].tasks[4].run();
      records.teardownRegistrations[0].tasks[5].run();
      assertEquals(records.graphitiAsyncFlushCalls, [["group-id"]]);
      assertEquals(records.graphitiAsyncDisposeCalls, 1);
      assertEquals(records.sessionMcpRuntimeDisposeCalls, 1);
      assertEquals(records.connectionStopCalls, 1);
      assertEquals(records.redisCloseCalls, 1);
      assertEquals(records.sessionMcpRuntimeArgs, [{
        redisClient: records.redisClientInstances[0],
        graphitiCache: records.redisCacheInstances[0],
        notesService: records.sessionNotesInstances[0],
        sessionTtlSeconds: config.redis.sessionTtlSeconds,
        groupId: "group-id",
        sessionExecutor: records.sessionExecutorInstances[0],
        createSessionExecutor: dependencies.createSessionExecutor,
      }]);

      assertStrictEquals(
        records.graphitiMcpArgs[0],
        records.connectionManagerInstances[0],
      );
      assertStrictEquals(
        records.redisEventsArgs[0][0],
        records.redisClientInstances[0],
      );
      assertEquals(records.redisEventsArgs[0][1], {
        sessionTtlSeconds: config.redis.sessionTtlSeconds,
      });
      assertStrictEquals(
        records.redisSnapshotArgs[0][0],
        records.redisClientInstances[0],
      );
      assertEquals(records.redisSnapshotArgs[0][1], {
        ttlSeconds: config.redis.sessionTtlSeconds * 2,
      });
      assertStrictEquals(
        records.redisCacheArgs[0][0],
        records.redisClientInstances[0],
      );
      assertEquals(records.redisCacheArgs[0][1], {
        ttlSeconds: config.redis.cacheTtlSeconds,
        driftThreshold: config.graphiti.driftThreshold,
      });
      assertStrictEquals(
        records.sessionNotesArgs[0][0],
        records.redisClientInstances[0],
      );
      assertEquals(records.sessionNotesArgs[0][1], {
        groupId: "group-id",
      });
      assertStrictEquals(
        records.batchDrainArgs[0][0],
        records.redisClientInstances[0],
      );
      assertStrictEquals(
        records.batchDrainArgs[0][1],
        records.redisEventsInstances[0],
      );
      assertEquals(records.batchDrainArgs[0][2], {
        batchSize: config.redis.batchSize,
        batchMaxBytes: config.redis.batchMaxBytes,
        drainRetryMax: config.redis.drainRetryMax,
      });
      assertStrictEquals(
        records.graphitiAsyncArgs[0][0],
        records.graphitiMcpInstances[0],
      );
      assertStrictEquals(
        records.graphitiAsyncArgs[0][1],
        records.redisCacheInstances[0],
      );
      assertStrictEquals(
        records.graphitiAsyncArgs[0][2],
        records.batchDrainInstances[0],
      );
      assertEquals(records.makeGroupIdCalls, [[
        config.graphiti.groupIdPrefix,
        input.directory,
      ]]);
      assertEquals(records.makeUserGroupIdCalls, [[
        config.graphiti.groupIdPrefix,
        input.directory,
      ]]);
      assertEquals(records.sessionManagerArgs[0][0], "group-id");
      assertEquals(records.sessionManagerArgs[0][1], "user-group-id");
      assertStrictEquals(records.sessionManagerArgs[0][2], input.client);
      assertStrictEquals(
        records.sessionManagerArgs[0][3],
        records.redisEventsInstances[0],
      );
      assertStrictEquals(
        records.sessionManagerArgs[0][4],
        records.redisSnapshotInstances[0],
      );
      assertStrictEquals(
        records.sessionManagerArgs[0][5],
        records.redisCacheInstances[0],
      );
      assertEquals(records.sessionManagerArgs[0][6], {
        idleRetentionMs: config.redis.sessionTtlSeconds * 1000,
        runtimeStateMigrator: records.sessionMcpRuntimeInstances[0],
        notesService: records.sessionNotesInstances[0],
      });
      assertStrictEquals(
        records.sessionMcpRuntimeCanonicalizerCalls[0],
        records.sessionManagerInstances[0],
      );

      assertEquals(records.createEventHandlerArgs.length, 1);
      assertStrictEquals(
        records.createEventHandlerArgs[0].sessionManager,
        records.sessionManagerInstances[0],
      );
      assertStrictEquals(
        records.createEventHandlerArgs[0].redisEvents,
        records.redisEventsInstances[0],
      );
      assertStrictEquals(
        records.createEventHandlerArgs[0].redisCache,
        records.redisCacheInstances[0],
      );
      assertStrictEquals(
        records.createEventHandlerArgs[0].redisSnapshot,
        records.redisSnapshotInstances[0],
      );
      assertStrictEquals(
        records.createEventHandlerArgs[0].graphitiAsync,
        records.graphitiAsyncInstances[0],
      );
      assertEquals(
        records.createEventHandlerArgs[0].defaultGroupId,
        "group-id",
      );
      assertEquals(
        records.createEventHandlerArgs[0].defaultUserGroupId,
        "user-group-id",
      );
      assertStrictEquals(
        records.createEventHandlerArgs[0].sdkClient,
        input.client,
      );
      assertEquals(
        records.createEventHandlerArgs[0].directory,
        input.directory,
      );
      assertEquals(records.createChatHandlerArgs.length, 1);
      assertStrictEquals(
        records.createChatHandlerArgs[0].sessionManager,
        records.sessionManagerInstances[0],
      );
      assertStrictEquals(
        records.createChatHandlerArgs[0].redisEvents,
        records.redisEventsInstances[0],
      );
      assertStrictEquals(
        records.createChatHandlerArgs[0].graphitiAsync,
        records.graphitiAsyncInstances[0],
      );
      assertEquals(
        records.createChatHandlerArgs[0].drainTriggerSize,
        config.redis.batchSize,
      );
      assertEquals(records.createCompactingHandlerArgs.length, 1);
      assertStrictEquals(
        records.createCompactingHandlerArgs[0].sessionManager,
        records.sessionManagerInstances[0],
      );
      assertEquals(records.createMessagesHandlerArgs.length, 1);
      assertStrictEquals(
        records.createMessagesHandlerArgs[0].sessionManager,
        records.sessionManagerInstances[0],
      );
      assertEquals(records.toolGuidanceCacheInstances.length, 1);
      assertEquals(records.toolRoutingOutcomeCacheInstances.length, 1);
      assertEquals(records.createToolBeforeHandlerArgs.length, 1);
      assertStrictEquals(
        records.createToolBeforeHandlerArgs[0].sessionCanonicalizer,
        records.sessionManagerInstances[0],
      );
      assertStrictEquals(
        records.createToolBeforeHandlerArgs[0].guidanceThrottle,
        records.toolGuidanceCacheInstances[0],
      );
      assertStrictEquals(
        records.createToolBeforeHandlerArgs[0].routingOutcomes,
        records.toolRoutingOutcomeCacheInstances[0],
      );
      assertEquals(records.createToolAfterHandlerArgs.length, 1);
      assertStrictEquals(
        records.createToolAfterHandlerArgs[0].routingOutcomes,
        records.toolRoutingOutcomeCacheInstances[0],
      );

      assertStrictEquals(plugin.event, hooks.event);
      assertEquals(typeof plugin["chat.message"], "function");
      assertEquals(
        typeof plugin["experimental.session.compacting"],
        "function",
      );
      assertStrictEquals(
        plugin["experimental.chat.messages.transform"],
        hooks.messages,
      );
      assertStrictEquals(plugin.tool, hooks.tool);
      assertStrictEquals(plugin["tool.execute.before"], hooks.toolBefore);
      assertStrictEquals(plugin["tool.execute.after"], hooks.toolAfter);
      assertEquals(typeof plugin["tool.definition"], "function");
    });

    it("warns on degraded startup without blocking plugin initialization", async () => {
      const { config, input, hooks, records, dependencies } =
        createEntrypointHarness(false);

      const plugin = await invokeGraphiti(input, dependencies);
      await Promise.resolve();

      assertEquals(records.graphitiWarnCalls, [{
        connected: false,
        endpoint: config.graphiti.endpoint,
      }]);
      assertEquals(records.redisWarnCalls, []);
      assertEquals(records.connectionStartCalls, 1);
      assertEquals(records.redisConnectCalls, 1);
      assertStrictEquals(plugin.event, hooks.event);
      assertEquals(typeof plugin["chat.message"], "function");
    });

    it("degrades cleanly when Graphiti readiness rejects", async () => {
      const { config, input, hooks, records, dependencies } =
        createEntrypointHarnessWithOptions({
          readyError: new Error("graphiti startup failed"),
        });

      const plugin = await invokeGraphiti(input, dependencies);
      await Promise.resolve();
      await Promise.resolve();

      assertEquals(records.connectionStartCalls, 1);
      assertEquals(records.connectionReadyCalls, 1);
      assertEquals(records.redisConnectCalls, 1);
      assertEquals(records.graphitiWarnCalls, [{
        connected: false,
        endpoint: config.graphiti.endpoint,
      }]);
      assertEquals(records.redisWarnCalls, []);
      assertStrictEquals(plugin.event, hooks.event);
      assertEquals(typeof plugin["chat.message"], "function");
    });

    it("degrades cleanly when Redis startup rejects", async () => {
      const { config, input, hooks, records, dependencies } =
        createEntrypointHarnessWithOptions({
          redisConnectError: new Error("redis startup failed"),
        });

      const plugin = await invokeGraphiti(input, dependencies);
      await Promise.resolve();
      await Promise.resolve();

      assertEquals(records.connectionStartCalls, 1);
      assertEquals(records.connectionReadyCalls, 1);
      assertEquals(records.redisConnectCalls, 1);
      assertEquals(records.graphitiWarnCalls, []);
      assertEquals(records.redisWarnCalls, [{
        connected: false,
        endpoint: config.redis.endpoint,
      }]);
      assertStrictEquals(plugin.event, hooks.event);
      assertEquals(typeof plugin["chat.message"], "function");
    });

    it("strengthens session_search once for new-session bias and leaves other tools unchanged", async () => {
      const { input, records, dependencies } = createEntrypointHarness(true);

      const plugin = await invokeGraphiti(input, dependencies) as Record<
        string,
        unknown
      >;
      const chatHook = plugin["chat.message"] as (
        input: { sessionID: string },
        output: { parts: unknown[] },
      ) => Promise<void>;
      const toolDefinitionHook = plugin["tool.definition"] as (
        input: { toolID: string },
        output: { description: string; parameters: unknown },
      ) => Promise<void>;

      await chatHook(
        { sessionID: "session-a" },
        { parts: [] },
      );

      assertEquals(records.chatHookCalls.length, 1);

      const nonSearchOutput = {
        description:
          "Execute a bounded session command for the current canonical root session. Do not pass `root_session_id`; the runtime resolves the current canonical root session automatically.",
        parameters: { type: "object" },
      };
      await toolDefinitionHook(
        { toolID: "session_execute" },
        nonSearchOutput,
      );
      assertEquals(
        nonSearchOutput.description,
        "Execute a bounded session command for the current canonical root session. Do not pass `root_session_id`; the runtime resolves the current canonical root session automatically.",
      );

      const strengthenedOutput = {
        description: SESSION_SEARCH_BASELINE_DESCRIPTION,
        parameters: { type: "object" },
      };
      await toolDefinitionHook(
        { toolID: "session_search" },
        strengthenedOutput,
      );
      assertEquals(
        strengthenedOutput.description,
        SESSION_SEARCH_STRENGTHENED_DESCRIPTION,
      );

      const baselineOutput = {
        description: SESSION_SEARCH_BASELINE_DESCRIPTION,
        parameters: { type: "object" },
      };
      await toolDefinitionHook(
        { toolID: "session_search" },
        baselineOutput,
      );
      assertEquals(
        baselineOutput.description,
        SESSION_SEARCH_BASELINE_DESCRIPTION,
      );
    });

    it("does not set new-session bias when prior session events already exist", async () => {
      const { input, records, dependencies } =
        createEntrypointHarnessWithOptions({
          connected: true,
          priorEventsBySessionId: {
            "session-a": [{ id: "evt-1" }],
          },
        });

      const plugin = await invokeGraphiti(input, dependencies) as Record<
        string,
        unknown
      >;
      const chatHook = plugin["chat.message"] as (
        input: { sessionID: string },
        output: { parts: unknown[] },
      ) => Promise<void>;
      const toolDefinitionHook = plugin["tool.definition"] as (
        input: { toolID: string },
        output: { description: string; parameters: unknown },
      ) => Promise<void>;

      await chatHook(
        { sessionID: "session-a" },
        { parts: [] },
      );

      assertEquals(records.redisEventsRecentCalls, [{
        sessionId: "session-a",
        limit: 1,
        chronological: false,
      }]);

      const output = {
        description: SESSION_SEARCH_BASELINE_DESCRIPTION,
        parameters: { type: "object" },
      };
      await toolDefinitionHook(
        { toolID: "session_search" },
        output,
      );

      assertEquals(output.description, SESSION_SEARCH_BASELINE_DESCRIPTION);
    });

    it("sets post-compaction bias and consumes multiple biased sessions together", async () => {
      const { input, records, dependencies } = createEntrypointHarness(true);

      const plugin = await invokeGraphiti(input, dependencies) as Record<
        string,
        unknown
      >;
      const chatHook = plugin["chat.message"] as (
        input: { sessionID: string },
        output: { parts: unknown[] },
      ) => Promise<void>;
      const compactingHook = plugin["experimental.session.compacting"] as (
        input: { sessionID: string },
        output: { context: string[] },
      ) => Promise<void>;
      const toolDefinitionHook = plugin["tool.definition"] as (
        input: { toolID: string },
        output: { description: string; parameters: unknown },
      ) => Promise<void>;

      await chatHook({ sessionID: "session-a" }, { parts: [] });
      await compactingHook({ sessionID: "session-b" }, { context: [] });

      assertEquals(records.chatHookCalls.length, 1);
      assertEquals(records.compactingHookCalls.length, 1);

      const firstOutput = {
        description: SESSION_SEARCH_BASELINE_DESCRIPTION,
        parameters: { type: "object" },
      };
      await toolDefinitionHook(
        { toolID: "session_search" },
        firstOutput,
      );
      assertEquals(
        firstOutput.description,
        SESSION_SEARCH_STRENGTHENED_DESCRIPTION,
      );

      const secondOutput = {
        description: SESSION_SEARCH_BASELINE_DESCRIPTION,
        parameters: { type: "object" },
      };
      await toolDefinitionHook(
        { toolID: "session_search" },
        secondOutput,
      );
      assertEquals(
        secondOutput.description,
        SESSION_SEARCH_BASELINE_DESCRIPTION,
      );
    });

    it("passes live redis client, ttl, and groupId into session MCP runtime", async () => {
      const { config, input, records, dependencies } = createEntrypointHarness(
        true,
      );

      await invokeGraphiti(input, dependencies);

      assertEquals(records.sessionMcpRuntimeArgs, [{
        redisClient: records.redisClientInstances[0],
        graphitiCache: records.redisCacheInstances[0],
        notesService: records.sessionNotesInstances[0],
        sessionTtlSeconds: config.redis.sessionTtlSeconds,
        groupId: "group-id",
        sessionExecutor: records.sessionExecutorInstances[0],
        createSessionExecutor: dependencies.createSessionExecutor,
      }]);
    });

    it("passes the session MCP runtime as the root-state migrator", async () => {
      const { input, records, dependencies } = createEntrypointHarness(true);

      await invokeGraphiti(input, dependencies);

      assertStrictEquals(
        records.sessionManagerArgs[0][6].runtimeStateMigrator,
        records.sessionMcpRuntimeInstances[0],
      );
    });

    it("creates one shared notes service and passes it to runtime and session manager", async () => {
      const { input, records, dependencies } = createEntrypointHarness(true);

      await invokeGraphiti(input, dependencies);

      assertEquals(records.sessionNotesInstances.length, 1);
      const runtimeArgs = records.sessionMcpRuntimeArgs[0] ?? {};
      assertStrictEquals(
        runtimeArgs.notesService,
        records.sessionNotesInstances[0],
      );
      assertStrictEquals(
        records.sessionManagerArgs[0][6].notesService,
        records.sessionNotesInstances[0],
      );
    });

    it("wires the session manager into the runtime root validator explicitly after construction", async () => {
      const { input, records, dependencies } = createEntrypointHarness(true);

      await invokeGraphiti(input, dependencies);

      assertEquals(records.sessionMcpRuntimeCanonicalizerCalls.length, 1);
      assertStrictEquals(
        records.sessionMcpRuntimeCanonicalizerCalls[0],
        records.sessionManagerInstances[0],
      );
    });

    it("does not leave runtime in stub corpus mode when redis is available", async () => {
      const { input, records, dependencies } = createEntrypointHarness(true);

      await invokeGraphiti(input, dependencies);

      const args = records.sessionMcpRuntimeArgs[0] ?? {};
      assertStrictEquals(args.redisClient, records.redisClientInstances[0]);
      assertStrictEquals(args.notesService, records.sessionNotesInstances[0]);
      assertEquals(args.sessionTtlSeconds, 60);
      assertEquals(args.groupId, "group-id");
    });

    it("reports degraded startup separately for Graphiti and Redis when both startup promises reject", async () => {
      const { input, records, dependencies } =
        createEntrypointHarnessWithOptions({
          readyError: new Error("graphiti startup failed"),
          redisConnectError: new Error("redis startup failed"),
        });

      await invokeGraphiti(input, dependencies);
      await Promise.resolve();
      await Promise.resolve();

      assertEquals(records.graphitiWarnCalls, [{
        connected: false,
        endpoint: "http://graphiti.test/mcp",
      }]);
      assertEquals(records.redisWarnCalls, [{
        connected: false,
        endpoint: "redis://redis.test:6379",
      }]);
    });

    it("waits for previous runtime teardown before starting a new runtime", async () => {
      let releasePreviousTeardown!: () => void;
      const previousTeardown = new Promise<void>((resolve) => {
        releasePreviousTeardown = resolve;
      });
      const firstHarness = createEntrypointHarnessWithOptions({
        teardownRun: () => previousTeardown,
      });

      await invokeGraphiti(firstHarness.input, firstHarness.dependencies);

      const secondHarness = createEntrypointHarness(true);
      const secondPluginPromise = invokeGraphiti(
        secondHarness.input,
        secondHarness.dependencies,
      );
      await Promise.resolve();

      assertEquals(
        secondHarness.records.loadConfigCalls,
        [],
      );
      assertEquals(
        firstHarness.records.teardownRegistrations.length,
        1,
      );

      releasePreviousTeardown();
      await secondPluginPromise;

      assertEquals(
        secondHarness.records.loadConfigCalls,
        [secondHarness.input.directory],
      );
      assertEquals(secondHarness.records.connectionStartCalls, 1);
    });

    it("continues startup when previous runtime teardown rejects", async () => {
      const originalWarn = logger.warn;
      const warnCalls: unknown[][] = [];
      logger.warn = (...args: unknown[]) => {
        warnCalls.push(args);
      };

      try {
        const firstHarness = createEntrypointHarnessWithOptions({
          teardownRun: () =>
            Promise.reject(new Error("previous teardown failed")),
        });
        await invokeGraphiti(firstHarness.input, firstHarness.dependencies);

        const secondHarness = createEntrypointHarness(true);
        const plugin = await invokeGraphiti(
          secondHarness.input,
          secondHarness.dependencies,
        );
        await Promise.resolve();

        assertEquals(secondHarness.records.loadConfigCalls, [
          secondHarness.input.directory,
        ]);
        assertEquals(secondHarness.records.connectionStartCalls, 1);
        assertEquals(warnCalls.length, 1);
        assertEquals(warnCalls[0][0], "Previous runtime teardown rejected");
        assertEquals(
          (warnCalls[0][1] as Error).message,
          "previous teardown failed",
        );
        assertStrictEquals(plugin.event, secondHarness.hooks.event);
      } finally {
        logger.warn = originalWarn;
      }
    });

    it("tears down async work before graphiti and redis during re-initialization", async () => {
      const firstHarness = createEntrypointHarness(true);
      await invokeGraphiti(firstHarness.input, firstHarness.dependencies);

      const secondHarness = createEntrypointHarness(true);
      await invokeGraphiti(secondHarness.input, secondHarness.dependencies);

      assertEquals(firstHarness.records.teardownTaskRuns, [
        "graphiti-drain-flush",
        "graphiti-async",
        "session-mcp-runtime",
        "graphiti",
        "redis",
      ]);
      assertEquals(firstHarness.records.graphitiAsyncDisposeCalls, 1);
      assertEquals(firstHarness.records.sessionMcpRuntimeDisposeCalls, 1);
      assertEquals(firstHarness.records.connectionStopCalls, 1);
      assertEquals(firstHarness.records.redisCloseCalls, 1);
    });

    it("best-effort cleans up partial resources when setup fails before teardown registration", async () => {
      const { input, records, dependencies } =
        createEntrypointHarnessWithOptions({
          createSessionMcpRuntimeError: new Error("runtime setup failed"),
        });

      await assertRejects(
        () => invokeGraphiti(input, dependencies),
        Error,
        "runtime setup failed",
      );

      assertEquals(records.teardownRegistrations.length, 0);
      assertEquals(records.graphitiAsyncDisposeCalls, 1);
      assertEquals(records.connectionStopCalls, 1);
      assertEquals(records.redisCloseCalls, 1);
      assertEquals(records.sessionMcpRuntimeDisposeCalls, 0);
    });

    it("runs registered teardown when setup fails after teardown registration", async () => {
      const { input, records, dependencies } =
        createEntrypointHarnessWithOptions({
          createEventHandlerError: new Error("event handler setup failed"),
        });

      await assertRejects(
        () => invokeGraphiti(input, dependencies),
        Error,
        "event handler setup failed",
      );

      assertEquals(records.teardownRegistrations.length, 1);
      assertEquals(records.teardownDisposeCalls, 1);
      assertEquals(records.teardownTaskRuns, [
        "graphiti-drain-flush",
        "graphiti-async",
        "session-mcp-runtime",
        "graphiti",
        "redis",
      ]);
    });

    it("gracefully shuts down on first SIGINT in a node-style host runtime", async () => {
      const { input, records, dependencies } = createEntrypointHarness(true);
      const signalHandlers = new Map<"SIGINT" | "SIGTERM", () => void>();
      const processEventHandlers = new Map<"beforeExit" | "exit", () => void>();
      const exitCalls: number[] = [];
      let exitReject!: (reason?: unknown) => void;
      const exitPromise = new Promise<never>((_, reject) => {
        exitReject = reject;
      });

      const runtime = {
        process: {
          on(event: string, handler: () => void) {
            if (event === "SIGINT" || event === "SIGTERM") {
              signalHandlers.set(event, handler);
              return;
            }
            if (event === "beforeExit" || event === "exit") {
              processEventHandlers.set(event, handler);
            }
          },
          off(event: string, _handler: () => void) {
            if (event === "SIGINT" || event === "SIGTERM") {
              signalHandlers.delete(event);
              return;
            }
            if (event === "beforeExit" || event === "exit") {
              processEventHandlers.delete(event);
            }
          },
          exit(code?: number) {
            exitCalls.push(code ?? 0);
            exitReject(new Error(`exit:${code ?? 0}`));
            return undefined as never;
          },
          exitCode: undefined,
        },
      };

      await invokeGraphiti(input, {
        ...dependencies,
        registerRuntimeTeardown: (
          tasks: Array<{
            name: string;
            run: () => void | Promise<void>;
          }>,
        ) => registerRuntimeTeardown(tasks, runtime),
      });

      await assertRejects(
        async () => {
          signalHandlers.get("SIGINT")?.();
          await exitPromise;
        },
        Error,
        "exit:130",
      );

      assertEquals(records.teardownTaskRuns, [
        "graphiti-drain-flush",
        "graphiti-async",
        "session-mcp-runtime",
        "graphiti",
        "redis",
      ]);
      assertEquals(exitCalls, [130]);
      assertEquals(signalHandlers.size, 0);
      assertEquals(processEventHandlers.size, 0);
    });

    it("does not attempt detached spawn on graceful shutdown when there is a dream gap", async () => {
      const { input, records, dependencies } =
        createEntrypointHarnessWithOptions({
          connected: true,
          trackedRootSessionIds: ["root-a"],
          dreamWatermarksBySessionId: {
            "root-a": null,
          },
          nowValues: ["2026-04-21T15:30:00.000Z"],
        });

      await invokeGraphiti(input, dependencies);

      const teardownTask = records.teardownRegistrations[0].tasks.find((task) =>
        task.name === "dream-shutdown-warning"
      );
      await teardownTask?.run();

      assertEquals(records.dreamStoreGetWatermarkCalls, ["root-a"]);
      assertEquals(records.spawnDetachedDreamWorkerCalls, []);
      assertEquals(records.notifyDreamShutdownDelayCalls, 1);
    });

    it("does not show the shutdown waiting instruction when there is no dream gap", async () => {
      const { input, records, dependencies } =
        createEntrypointHarnessWithOptions({
          connected: true,
          trackedRootSessionIds: ["root-a"],
          dreamWatermarksBySessionId: {
            "root-a": "2026-04-21T15:30:00.000Z",
          },
          nowValues: ["2026-04-21T15:30:00.000Z"],
        });

      await invokeGraphiti(input, dependencies);

      const teardownTask = records.teardownRegistrations[0].tasks.find((task) =>
        task.name === "dream-shutdown-warning"
      );
      await teardownTask?.run();

      assertEquals(records.spawnDetachedDreamWorkerCalls, []);
      assertEquals(records.notifyDreamShutdownDelayCalls, 0);
    });
  });
});
