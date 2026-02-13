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

/**
 * Load Graphiti configuration from JSONC files with defaults applied.
 */
export function loadConfig(): GraphitiConfig {
  const explorer = cosmiconfigSync("graphiti", { searchStrategy: "global" });
  const result = explorer.search();
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
