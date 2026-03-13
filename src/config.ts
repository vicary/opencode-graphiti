import os from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { GraphitiConfig } from "./types/index.ts";

const DEFAULT_CONFIG: GraphitiConfig = {
  endpoint: "http://localhost:8000/mcp",
  groupIdPrefix: "opencode",
  driftThreshold: 0.5,
  factStaleDays: 30,
};

type PartialGraphitiConfig = Partial<GraphitiConfig>;

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

const normalizeConfig = (value: unknown): PartialGraphitiConfig => {
  if (!isRecord(value)) return {};

  const config: PartialGraphitiConfig = {};

  if (typeof value.endpoint === "string") config.endpoint = value.endpoint;
  if (typeof value.groupIdPrefix === "string") {
    config.groupIdPrefix = value.groupIdPrefix;
  }
  if (typeof value.driftThreshold === "number") {
    config.driftThreshold = value.driftThreshold;
  }
  if (typeof value.factStaleDays === "number") {
    config.factStaleDays = value.factStaleDays;
  }

  return config;
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

const getSearchStartDir = (directory?: string): string | undefined => {
  try {
    return directory === undefined ? undefined : directory;
  } catch {
    return undefined;
  }
};

const searchConfig = (
  adapter: ConfigExplorerAdapter,
  directory?: string,
): ConfigSearchOutcome => {
  try {
    const loaded = adapter.search(getSearchStartDir(directory));
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

/**
 * Load Graphiti configuration via cosmiconfig discovery, with a legacy fallback
 * to `~/.config/opencode/.graphitirc` only when discovery succeeds and returns
 * no result.
 */
export function loadConfig(directory?: string): GraphitiConfig {
  const adapter = getConfigExplorerAdapter();
  if (!adapter) return { ...DEFAULT_CONFIG };

  const searched = searchConfig(adapter, directory);
  if (!searched.ok) return { ...DEFAULT_CONFIG };

  const loaded = searched.config ?? loadLegacyConfig(adapter);

  return {
    ...DEFAULT_CONFIG,
    ...(loaded ?? {}),
  };
}
