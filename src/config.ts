import { cosmiconfigSync } from "cosmiconfig";
import * as z from "zod/mini";
import type { GraphitiConfig } from "./types/index.ts";

const DEFAULT_CONFIG: GraphitiConfig = {
  endpoint: "http://localhost:8000/mcp",
  groupIdPrefix: "opencode",
  injectionInterval: 10,
};

const GraphitiConfigSchema = z.object({
  endpoint: z.string(),
  groupIdPrefix: z.string(),
  injectionInterval: z.number(),
});

/**
 * Load Graphiti configuration from JSONC files with defaults applied.
 */
export function loadConfig(): GraphitiConfig {
  const explorer = cosmiconfigSync("graphiti");
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
