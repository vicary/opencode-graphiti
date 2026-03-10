import { cosmiconfigSync } from "cosmiconfig";
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

function searchConfig(searchStrategy: "none" | "global", directory?: string) {
  const explorer = cosmiconfigSync("graphiti", {
    searchStrategy,
    cache: false,
  });

  return directory ? explorer.search(directory) : explorer.search();
}

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
  const result = directory
    ? searchConfig("none", directory) ?? searchConfig("global")
    : searchConfig("global");

  const candidate = result?.config ?? {};
  const merged = {
    ...DEFAULT_CONFIG,
    ...candidate,
  };
  const parsed = GraphitiConfigSchema.safeParse(merged);
  if (parsed.success) {
    return parsed.data;
  }

  return DEFAULT_CONFIG;
}
