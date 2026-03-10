import { cosmiconfigSync } from "cosmiconfig";
import os from "node:os";
import * as z from "zod/mini";
import type { GraphitiConfig } from "./types/index.ts";

const DEFAULT_CONFIG: GraphitiConfig = {
  endpoint: "http://localhost:8000/mcp",
  groupIdPrefix: "opencode",
  driftThreshold: 0.5,
  factStaleDays: 30,
};

const GraphitiConfigSchema = z.object({
  endpoint: z.string(),
  groupIdPrefix: z.string(),
  driftThreshold: z.number(),
  factStaleDays: z.number(),
});

/**
 * Load Graphiti configuration from JSONC files with defaults applied.
 *
 * When `directory` is provided, the search starts from that directory (no
 * upward traversal past it) so that a project-local `.graphitirc` or
 * `package.json#graphiti` key takes precedence over any global/home config.
 * If no config is found in the project directory the search falls back to a
 * global search (home directory and OS-level config locations).
 */
export function loadConfig(directory?: string): GraphitiConfig {
  const result = cosmiconfigSync("graphiti", {
    stopDir: os.homedir(),
    mergeSearchPlaces: true,
    cache: false,
  }).search(directory) ??
    cosmiconfigSync("graphiti", {
      searchPlaces: [`${os.homedir()}/.graphitirc`],
    }).search();

  const merged = {
    ...DEFAULT_CONFIG,
    ...result?.config,
  };
  const parsed = GraphitiConfigSchema.safeParse(merged);
  if (parsed.success) {
    return parsed.data;
  }

  return DEFAULT_CONFIG;
}
