import { logger } from "./logger.ts";

const TRIGGER_PATTERNS = [
  /\b(?:remember|memorize)\s+(?:that|this)/i,
  /\b(?:save|store|keep|note)\s+(?:this|that)\s+(?:in\s+)?(?:memory|mind)/i,
  /\bkeep\s+in\s+mind\b/i,
  /\bdon'?t\s+forget\b/i,
  /\bnote\s+(?:that|this)\b/i,
  /\bfor\s+(?:future|later)\s+reference\b/i,
];

export interface TriggerResult {
  triggered: boolean;
  content?: string;
}

export function detectMemoryTrigger(message: string): TriggerResult {
  for (const pattern of TRIGGER_PATTERNS) {
    if (pattern.test(message)) {
      logger.debug("Memory trigger detected in message");
      return { triggered: true, content: message };
    }
  }
  return { triggered: false };
}

export function extractMemoryContent(message: string): string {
  let content = message;
  for (const pattern of TRIGGER_PATTERNS) {
    content = content.replace(pattern, "").trim();
  }
  content = content.replace(/^[,.:;-]\s*/, "");
  return content || message;
}
