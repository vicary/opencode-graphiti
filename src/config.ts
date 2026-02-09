import { cosmiconfigSync } from "cosmiconfig";
import * as z from "zod/mini";
import type { GraphitiConfig } from "./types/index.ts";

const DEFAULT_CONFIG: GraphitiConfig = {
  endpoint: "http://localhost:8000/mcp",
  groupIdPrefix: "opencode",
  maxFacts: 10,
  maxNodes: 5,
  maxEpisodes: 5,
  injectOnFirstMessage: true,
  enableCompactionSave: true,
  compactionThreshold: 0.8,
  minTokensForCompaction: 50000,
  compactionCooldownMs: 30000,
  autoResumeAfterCompaction: true,
};

const GraphitiConfigSchema = z.object({
  endpoint: z.string(),
  groupIdPrefix: z.string(),
  maxFacts: z.number(),
  maxNodes: z.number(),
  maxEpisodes: z.number(),
  injectOnFirstMessage: z.boolean(),
  enableCompactionSave: z.boolean(),
  compactionThreshold: z.optional(z.number()),
  minTokensForCompaction: z.optional(z.number()),
  compactionCooldownMs: z.optional(z.number()),
  autoResumeAfterCompaction: z.optional(z.boolean()),
});

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
