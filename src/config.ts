import os from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { GraphitiConfig } from "./types/index.ts";

const DEFAULT_CONFIG: GraphitiConfig = {
  falkordb: {
    redisEndpoint: "redis://localhost:6379",
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
    factStaleDays: 30,
  },
  endpoint: "http://localhost:8000/mcp",
  groupIdPrefix: "opencode",
  driftThreshold: 0.5,
  factStaleDays: 30,
  redisEndpoint: "redis://localhost:6379",
  batchSize: 20,
  batchMaxBytes: 51_200,
  sessionTtlSeconds: 86_400,
  cacheTtlSeconds: 600,
  drainRetryMax: 3,
};

type PartialGraphitiConfig = {
  falkordb?: Partial<GraphitiConfig["falkordb"]>;
  graphiti?: Partial<GraphitiConfig["graphiti"]>;
  endpoint?: string;
  groupIdPrefix?: string;
  driftThreshold?: number;
  factStaleDays?: number;
  redisEndpoint?: string;
  batchSize?: number;
  batchMaxBytes?: number;
  sessionTtlSeconds?: number;
  cacheTtlSeconds?: number;
  drainRetryMax?: number;
};

type ConfigLoadResult = { config: unknown } | null;

type ConfigSearchOutcome =
  | { ok: true; config: PartialGraphitiConfig | null }
  | { ok: false };

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

const readNumber = (
  value: Record<string, unknown>,
  key: string,
): number | undefined =>
  typeof value[key] === "number" ? value[key] as number : undefined;

const normalizeConfig = (value: unknown): PartialGraphitiConfig => {
  if (!isRecord(value)) return {};

  const compact = <T extends Record<string, unknown>>(input: T): Partial<T> =>
    Object.fromEntries(
      Object.entries(input).filter(([_, entry]) => entry !== undefined),
    ) as Partial<T>;

  const config: PartialGraphitiConfig = {
    endpoint: readString(value, "endpoint"),
    groupIdPrefix: readString(value, "groupIdPrefix"),
    driftThreshold: readNumber(value, "driftThreshold"),
    factStaleDays: readNumber(value, "factStaleDays"),
    redisEndpoint: readString(value, "redisEndpoint"),
    batchSize: readNumber(value, "batchSize"),
    batchMaxBytes: readNumber(value, "batchMaxBytes"),
    sessionTtlSeconds: readNumber(value, "sessionTtlSeconds"),
    cacheTtlSeconds: readNumber(value, "cacheTtlSeconds"),
    drainRetryMax: readNumber(value, "drainRetryMax"),
  };

  if (isRecord(value.falkordb)) {
    config.falkordb = compact({
      redisEndpoint: readString(value.falkordb, "redisEndpoint"),
      batchSize: readNumber(value.falkordb, "batchSize"),
      batchMaxBytes: readNumber(value.falkordb, "batchMaxBytes"),
      sessionTtlSeconds: readNumber(value.falkordb, "sessionTtlSeconds"),
      cacheTtlSeconds: readNumber(value.falkordb, "cacheTtlSeconds"),
      drainRetryMax: readNumber(value.falkordb, "drainRetryMax"),
    });
  }

  if (isRecord(value.graphiti)) {
    config.graphiti = compact({
      endpoint: readString(value.graphiti, "endpoint"),
      groupIdPrefix: readString(value.graphiti, "groupIdPrefix"),
      driftThreshold: readNumber(value.graphiti, "driftThreshold"),
      factStaleDays: readNumber(value.graphiti, "factStaleDays"),
    });
  }

  return config;
};

const isPositiveInteger = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isPositiveNumber = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const isUnitInterval = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 &&
  value <= 1;

const resolveNumber = (
  ...candidates: Array<number | undefined>
): number | undefined => candidates.find((value) => value !== undefined);

const resolveConfig = (value: PartialGraphitiConfig | null): GraphitiConfig => {
  const raw = value ?? {};

  const resolvedRedisEndpoint = raw.falkordb?.redisEndpoint ??
    raw.redisEndpoint ??
    DEFAULT_CONFIG.falkordb.redisEndpoint;
  const resolvedBatchSize = resolveNumber(
    raw.falkordb?.batchSize,
    raw.batchSize,
  );
  const resolvedBatchMaxBytes = resolveNumber(
    raw.falkordb?.batchMaxBytes,
    raw.batchMaxBytes,
  );
  const resolvedSessionTtlSeconds = resolveNumber(
    raw.falkordb?.sessionTtlSeconds,
    raw.sessionTtlSeconds,
  );
  const resolvedCacheTtlSeconds = resolveNumber(
    raw.falkordb?.cacheTtlSeconds,
    raw.cacheTtlSeconds,
  );
  const resolvedDrainRetryMax = resolveNumber(
    raw.falkordb?.drainRetryMax,
    raw.drainRetryMax,
  );
  const resolvedGraphitiEndpoint = raw.graphiti?.endpoint ?? raw.endpoint ??
    DEFAULT_CONFIG.graphiti.endpoint;
  const resolvedGroupIdPrefix = raw.graphiti?.groupIdPrefix ??
    raw.groupIdPrefix ??
    DEFAULT_CONFIG.graphiti.groupIdPrefix;
  const resolvedDriftThreshold = resolveNumber(
    raw.graphiti?.driftThreshold,
    raw.driftThreshold,
  );
  const resolvedFactStaleDays = resolveNumber(
    raw.graphiti?.factStaleDays,
    raw.factStaleDays,
  );

  const falkordb = {
    redisEndpoint: resolvedRedisEndpoint,
    batchSize: isPositiveInteger(resolvedBatchSize)
      ? resolvedBatchSize
      : DEFAULT_CONFIG.falkordb.batchSize,
    batchMaxBytes: isPositiveInteger(resolvedBatchMaxBytes)
      ? resolvedBatchMaxBytes
      : DEFAULT_CONFIG.falkordb.batchMaxBytes,
    sessionTtlSeconds: isPositiveInteger(resolvedSessionTtlSeconds)
      ? resolvedSessionTtlSeconds
      : DEFAULT_CONFIG.falkordb.sessionTtlSeconds,
    cacheTtlSeconds: isPositiveInteger(resolvedCacheTtlSeconds)
      ? resolvedCacheTtlSeconds
      : DEFAULT_CONFIG.falkordb.cacheTtlSeconds,
    drainRetryMax: isPositiveInteger(resolvedDrainRetryMax)
      ? resolvedDrainRetryMax
      : DEFAULT_CONFIG.falkordb.drainRetryMax,
  };

  const graphiti = {
    endpoint: resolvedGraphitiEndpoint,
    groupIdPrefix: resolvedGroupIdPrefix,
    driftThreshold: isUnitInterval(resolvedDriftThreshold)
      ? resolvedDriftThreshold
      : DEFAULT_CONFIG.graphiti.driftThreshold,
    factStaleDays: isPositiveNumber(resolvedFactStaleDays)
      ? resolvedFactStaleDays
      : DEFAULT_CONFIG.graphiti.factStaleDays,
  };

  return {
    ...raw,
    falkordb,
    graphiti,
    endpoint: graphiti.endpoint,
    groupIdPrefix: graphiti.groupIdPrefix,
    driftThreshold: graphiti.driftThreshold,
    factStaleDays: graphiti.factStaleDays,
    redisEndpoint: falkordb.redisEndpoint,
    batchSize: falkordb.batchSize,
    batchMaxBytes: falkordb.batchMaxBytes,
    sessionTtlSeconds: falkordb.sessionTtlSeconds,
    cacheTtlSeconds: falkordb.cacheTtlSeconds,
    drainRetryMax: falkordb.drainRetryMax,
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

const getConfigExplorerAdapter = (): ConfigExplorerAdapter | null => {
  try {
    return configExplorerFactory();
  } catch {
    return null;
  }
};

const loadConfigFile = (
  adapter: ConfigExplorerAdapter | null,
  filePath: string,
): PartialGraphitiConfig | null => {
  try {
    const loaded = adapter?.load(filePath);
    return loaded ? normalizeConfig(loaded.config) : null;
  } catch {
    return null;
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
): ConfigSearchOutcome => {
  try {
    const loaded = adapter.search(directory);
    return {
      ok: true,
      config: loaded ? normalizeConfig(loaded.config) : null,
    };
  } catch {
    return { ok: false };
  }
};

const loadLegacyConfig = (
  adapter: ConfigExplorerAdapter,
): PartialGraphitiConfig | null => {
  const homeDir = getHomeDir();
  if (!homeDir) return null;

  return loadConfigFile(
    adapter,
    join(homeDir, ".config", "opencode", ".graphitirc"),
  );
};

export function loadConfig(directory?: string): GraphitiConfig {
  const adapter = getConfigExplorerAdapter();
  if (!adapter) return structuredClone(DEFAULT_CONFIG);

  const searched = searchConfig(adapter, directory);
  if (!searched.ok) return structuredClone(DEFAULT_CONFIG);

  const loaded = searched.config ?? loadLegacyConfig(adapter);
  return resolveConfig(loaded);
}
