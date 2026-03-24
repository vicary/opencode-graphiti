import os from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { redactEndpointUserInfo } from "./services/endpoint-redaction.ts";
import { logger } from "./services/logger.ts";
import type { GraphitiConfig, RawGraphitiConfig } from "./types/index.ts";

const DEFAULT_CONFIG = {
  redis: {
    endpoint: "redis://localhost:6379",
    batchSize: 20,
    batchMaxBytes: 51_200,
    sessionTtlSeconds: 86_400,
    cacheTtlSeconds: 600,
    drainRetryMax: 3,
  },
  graphiti: {
    endpoint: "http://localhost:8000/mcp",
    groupIdPrefix: "opencode",
    driftThreshold: 0.5,
  },
} satisfies Pick<GraphitiConfig, "redis" | "graphiti">;

type ConfigLoadResult = { config: unknown } | null;

type ConfigLoadErrorCode =
  | "config-discovery-init"
  | "config-discovery-search"
  | "config-file-load"
  | "config-invalid";

export class ConfigLoadError extends Error {
  readonly code: ConfigLoadErrorCode;

  constructor(
    message: string,
    options: { cause?: unknown; code: ConfigLoadErrorCode },
  ) {
    super(message);
    this.name = "ConfigLoadError";
    this.code = options.code;
    if (options.cause !== undefined) {
      // dnt's Node-side type check still narrows Error to the legacy
      // single-argument constructor here, so preserve standard cause semantics
      // manually while keeping the generated build green.
      Object.defineProperty(this, "cause", {
        value: options.cause,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
  }
}

export interface ConfigExplorerAdapter {
  search(from?: string): ConfigLoadResult;
  load(filePath: string): ConfigLoadResult;
}

type ConfigExplorerFactory = () => ConfigExplorerAdapter;

const require = createRequire(import.meta.url);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const readString = (
  value: Record<string, unknown>,
  key: string,
): string | undefined =>
  typeof value[key] === "string" ? value[key] as string : undefined;

const readTrimmedString = (
  value: Record<string, unknown>,
  key: string,
): string | undefined => {
  const entry = readString(value, key);
  return entry?.trim() || undefined;
};

const readNumber = (
  value: Record<string, unknown>,
  key: string,
): number | undefined =>
  typeof value[key] === "number" ? value[key] as number : undefined;

const normalizeConfig = (value: unknown): RawGraphitiConfig => {
  if (!isRecord(value)) return {};

  const compact = <T extends Record<string, unknown>>(input: T): Partial<T> =>
    Object.fromEntries(
      Object.entries(input).filter(([_, entry]) => entry !== undefined),
    ) as Partial<T>;

  const config: RawGraphitiConfig = {
    endpoint: readTrimmedString(value, "endpoint"),
    groupIdPrefix: readTrimmedString(value, "groupIdPrefix"),
    driftThreshold: readNumber(value, "driftThreshold"),
  };

  if (isRecord(value.redis)) {
    config.redis = compact({
      endpoint: readTrimmedString(value.redis, "endpoint"),
      batchSize: readNumber(value.redis, "batchSize"),
      batchMaxBytes: readNumber(value.redis, "batchMaxBytes"),
      sessionTtlSeconds: readNumber(value.redis, "sessionTtlSeconds"),
      cacheTtlSeconds: readNumber(value.redis, "cacheTtlSeconds"),
      drainRetryMax: readNumber(value.redis, "drainRetryMax"),
    });
  }

  if (isRecord(value.graphiti)) {
    config.graphiti = compact({
      endpoint: readTrimmedString(value.graphiti, "endpoint"),
      groupIdPrefix: readTrimmedString(value.graphiti, "groupIdPrefix"),
      driftThreshold: readNumber(value.graphiti, "driftThreshold"),
    });
  }

  return config;
};

const isPositiveInteger = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isUnitInterval = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 &&
  value <= 1;

const parseUrlString = (value: string | undefined): URL | null => {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const assertExplicitUrl = (
  value: string | undefined,
  fieldName: string,
  allowedSchemes?: string[],
): void => {
  if (value === undefined) return;
  const url = parseUrlString(value);
  if (!url) {
    throw new ConfigLoadError(
      `Invalid config value for ${fieldName}: expected a valid URL, received ${
        JSON.stringify(redactEndpointUserInfo(value))
      }`,
      { code: "config-invalid" },
    );
  }
  if (
    !allowedSchemes ||
    allowedSchemes.includes(url.protocol.slice(0, -1))
  ) {
    return;
  }
  throw new ConfigLoadError(
    `Invalid config value for ${fieldName}: expected URL scheme ${
      allowedSchemes.map((scheme) => JSON.stringify(scheme)).join(" or ")
    }, received ${JSON.stringify(redactEndpointUserInfo(value))}`,
    { code: "config-invalid" },
  );
};

const validateExplicitConfig = (value: RawGraphitiConfig | null): void => {
  if (!value) return;
  assertExplicitUrl(value.endpoint, "endpoint", ["http", "https"]);
  assertExplicitUrl(value.graphiti?.endpoint, "graphiti.endpoint", [
    "http",
    "https",
  ]);
  assertExplicitUrl(value.redis?.endpoint, "redis.endpoint", [
    "redis",
    "rediss",
  ]);
};

const resolveNumber = (
  ...candidates: Array<number | undefined>
): number | undefined => candidates.find((value) => value !== undefined);

const resolveConfig = (value: RawGraphitiConfig | null): GraphitiConfig => {
  const raw = value ?? {};

  const resolvedRedisEndpoint = raw.redis?.endpoint ??
    DEFAULT_CONFIG.redis.endpoint;
  const resolvedBatchSize = resolveNumber(raw.redis?.batchSize);
  const resolvedBatchMaxBytes = resolveNumber(raw.redis?.batchMaxBytes);
  const resolvedSessionTtlSeconds = resolveNumber(raw.redis?.sessionTtlSeconds);
  const resolvedCacheTtlSeconds = resolveNumber(raw.redis?.cacheTtlSeconds);
  const resolvedDrainRetryMax = resolveNumber(raw.redis?.drainRetryMax);
  const requestedGraphitiEndpoint = raw.graphiti?.endpoint ?? raw.endpoint;
  const resolvedGraphitiEndpoint = requestedGraphitiEndpoint ??
    DEFAULT_CONFIG.graphiti.endpoint;
  const resolvedGroupIdPrefix = raw.graphiti?.groupIdPrefix ??
    raw.groupIdPrefix ??
    DEFAULT_CONFIG.graphiti.groupIdPrefix;
  const resolvedDriftThreshold = resolveNumber(
    raw.graphiti?.driftThreshold,
    raw.driftThreshold,
  );
  const redis = {
    endpoint: resolvedRedisEndpoint,
    batchSize: isPositiveInteger(resolvedBatchSize)
      ? resolvedBatchSize
      : DEFAULT_CONFIG.redis.batchSize,
    batchMaxBytes: isPositiveInteger(resolvedBatchMaxBytes)
      ? resolvedBatchMaxBytes
      : DEFAULT_CONFIG.redis.batchMaxBytes,
    sessionTtlSeconds: isPositiveInteger(resolvedSessionTtlSeconds)
      ? resolvedSessionTtlSeconds
      : DEFAULT_CONFIG.redis.sessionTtlSeconds,
    cacheTtlSeconds: isPositiveInteger(resolvedCacheTtlSeconds)
      ? resolvedCacheTtlSeconds
      : DEFAULT_CONFIG.redis.cacheTtlSeconds,
    drainRetryMax: isPositiveInteger(resolvedDrainRetryMax)
      ? resolvedDrainRetryMax
      : DEFAULT_CONFIG.redis.drainRetryMax,
  };

  const graphiti = {
    endpoint: resolvedGraphitiEndpoint,
    groupIdPrefix: resolvedGroupIdPrefix,
    driftThreshold: isUnitInterval(resolvedDriftThreshold)
      ? resolvedDriftThreshold
      : DEFAULT_CONFIG.graphiti.driftThreshold,
  };

  return {
    redis,
    graphiti,
    endpoint: graphiti.endpoint,
    groupIdPrefix: graphiti.groupIdPrefix,
    driftThreshold: graphiti.driftThreshold,
  };
};

const createCosmiconfigAdapter = (): ConfigExplorerAdapter => {
  const { cosmiconfigSync } = require("cosmiconfig") as {
    cosmiconfigSync: (
      moduleName: string,
      options?: { searchStrategy?: string },
    ) => ConfigExplorerAdapter;
  };

  const explorer = cosmiconfigSync("graphiti", { searchStrategy: "global" });

  return {
    search(from) {
      return explorer.search(from);
    },
    load(filePath) {
      return explorer.load(filePath);
    },
  };
};

let configExplorerFactory: ConfigExplorerFactory = createCosmiconfigAdapter;

export const setConfigExplorerAdapterForTesting = (
  factory: ConfigExplorerFactory,
): void => {
  configExplorerFactory = factory;
};

export const resetConfigExplorerAdapterForTesting = (): void => {
  configExplorerFactory = createCosmiconfigAdapter;
};

const getConfigExplorerAdapter = (): ConfigExplorerAdapter => {
  try {
    return configExplorerFactory();
  } catch (err) {
    throw new ConfigLoadError(
      "Unable to initialize Graphiti config discovery",
      { cause: err, code: "config-discovery-init" },
    );
  }
};

const loadConfigFile = (
  adapter: ConfigExplorerAdapter | null,
  filePath: string,
): RawGraphitiConfig | null => {
  try {
    const loaded = adapter?.load(filePath);
    const normalized = loaded ? normalizeConfig(loaded.config) : null;
    validateExplicitConfig(normalized);
    return normalized;
  } catch (err) {
    if (err instanceof ConfigLoadError) throw err;
    throw new ConfigLoadError(
      `Unable to load Graphiti config file: ${filePath}`,
      { cause: err, code: "config-file-load" },
    );
  }
};

const getHomeDir = (): string | undefined => {
  try {
    return os.homedir();
  } catch {
    return undefined;
  }
};

const searchConfig = (
  adapter: ConfigExplorerAdapter,
  directory?: string,
): RawGraphitiConfig | null => {
  try {
    const loaded = adapter.search(directory);
    const normalized = loaded ? normalizeConfig(loaded.config) : null;
    validateExplicitConfig(normalized);
    return normalized;
  } catch (err) {
    if (err instanceof ConfigLoadError) throw err;
    throw new ConfigLoadError("Unable to discover Graphiti config", {
      cause: err,
      code: "config-discovery-search",
    });
  }
};

const loadLegacyConfig = (
  adapter: ConfigExplorerAdapter,
): RawGraphitiConfig | null => {
  const homeDir = getHomeDir();
  if (!homeDir) return null;

  return loadConfigFile(
    adapter,
    join(homeDir, ".config", "opencode", ".graphitirc"),
  );
};

const isRecoverableConfigLoadFailure = (error: unknown): boolean =>
  error instanceof ConfigLoadError &&
  (error.code === "config-discovery-init" ||
    error.code === "config-discovery-search" ||
    error.code === "config-file-load");

export function loadConfig(directory?: string): GraphitiConfig {
  try {
    const adapter = getConfigExplorerAdapter();
    const loaded = searchConfig(adapter, directory);
    const resolved = loaded ?? loadLegacyConfig(adapter);
    validateExplicitConfig(resolved);
    return resolveConfig(resolved);
  } catch (error) {
    if (
      !(error instanceof ConfigLoadError) ||
      !isRecoverableConfigLoadFailure(error)
    ) {
      throw error;
    }
    logger.warn(error.message, error);
    return resolveConfig(null);
  }
}
