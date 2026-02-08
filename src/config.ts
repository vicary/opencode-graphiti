import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { GraphitiConfig } from "./types/index.ts";

const DEFAULT_CONFIG: GraphitiConfig = {
  endpoint: "http://mac-studio:8000/mcp",
  groupIdPrefix: "opencode",
  maxFacts: 10,
  maxNodes: 5,
  maxEpisodes: 5,
  injectOnFirstMessage: true,
  enableTriggerDetection: true,
  enableCompactionSave: true,
};

function parseJsonc(text: string): unknown {
  const stripped = text.replace(/\/\/.*$/gm, "").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  return JSON.parse(stripped);
}

export function loadConfig(): GraphitiConfig {
  const configPath = join(homedir(), ".config", "opencode", "graphiti.jsonc");
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseJsonc(raw) as Partial<GraphitiConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return DEFAULT_CONFIG;
  }
}
