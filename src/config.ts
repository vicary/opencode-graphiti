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
 * Lookup order:
 *  1. `directory` (if provided): standard cosmiconfig search starting from that
 *     directory (no upward traversal past it) — project-local `.graphitirc`,
 *     `package.json#graphiti`, etc.
 *  2. Standard global/home cosmiconfig locations discovered by walking upward
 *     from CWD to the home directory (e.g. `~/.graphitirc`).
 *  3. Legacy fallback: `~/.config/opencode/.graphitirc` — the path used by
 *     earlier versions of the plugin.
 */
export function loadConfig(directory?: string): GraphitiConfig {
  const explorer = cosmiconfigSync("graphiti", {
    stopDir: os.homedir(),
    mergeSearchPlaces: true,
    cache: false,
  });

  // Step 1 & 2: project-local search (with directory arg) or CWD upward walk.
  const result = explorer.search(directory) ??
    (() => {
      // Step 3: legacy fallback — load the fixed path explicitly so that
      // cosmiconfig's search-place joining does not mangle absolute paths.
      const legacyPath = `${os.homedir()}/.config/opencode/.graphitirc`;
      try {
        return cosmiconfigSync("graphiti", { cache: false }).load(legacyPath);
      } catch {
        return null;
      }
    })();

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
