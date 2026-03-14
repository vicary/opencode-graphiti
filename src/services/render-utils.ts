export const escapeXml = (value: string): string =>
  value.replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const SESSION_MEMORY_BLOCK_PATTERN =
  /<session_memory\b[^>]*>[\s\S]*?<\/session_memory>/gi;
const LEGACY_MEMORY_BLOCK_PATTERN = /<memory\b[^>]*>[\s\S]*?<\/memory>/gi;
const PERSISTENT_MEMORY_BLOCK_PATTERN =
  /<persistent_memory\b[^>]*>[\s\S]*?<\/persistent_memory>/gi;
const TOOL_WRAPPER_DOCUMENT_PATTERN =
  /^\s*(?:<(?:path|content|type)\b[^>]*>[\s\S]*?<\/(?:path|content|type)>\s*)+$/i;
const TOOL_WRAPPER_BLOCK_PATTERN =
  /<(?:path|content|type)\b[^>]*>[\s\S]*?<\/(?:path|content|type)>/gi;
const TOOL_WRAPPER_LINE_PATTERN =
  /^\s*<\/?(?:path|content|type)\b[^>]*>\s*$/gim;
const TOOL_WRAPPER_PREFIX_PATTERN =
  /^\s*(?:<path>|<content>|<type>|<path\b[^>]*>|<content\b[^>]*>|<type\b[^>]*>|<\/path>|<\/content>|<\/type>|<path>.*<\/path>|<type>.*<\/type>|\d+:\s*<(?:path|content|type)\b[^>]*>)\s*$/gim;
const TOOL_TRANSCRIPT_PATTERN =
  /\b(?:tool(?:_use)?s?|orchestration|delegat(?:e|ed|ion)|subagent|wrapper|transcript|read output|read wrapper|session_memory|persistent_memory)\b/i;
const OPERATIONAL_CHATTER_PATTERN =
  /^(?:plan per target:|i(?:'m| am| will| can| should| need to)\b|now\b.*\b(?:checking|reading|inspecting|updating|running)|next\b.*\b(?:checking|reading|updating|running))/i;
const LOW_VALUE_MEMORY_PATTERN =
  /\b(?:assistant|meta chatter|planning chatter|phrasing suggestion|tool routing|orchestration|delegate|subagent|wrapper)\b/i;
const HIGH_VALUE_MEMORY_PATTERN =
  /\b(?:architecture|decision|constraint|prefer|preference|must|should|rule|policy|hot path|async|graphiti|redis|falkordb|session memory|persistent memory|milestone|file|src\/|plans\/|docs\/|fix|implement|update)\b/i;
const TRANSCRIPT_HEAVY_PATTERN =
  /```|(?:^|\n)\d+:\s|(?:^|\n)\$\s|\b(?:stdout|stderr|exit code|tool output|read output|file contents|transcript)\b/i;
const STRUCTURED_TRANSCRIPT_HEAVY_PATTERN =
  /```|(?:^|\n)\d+:\s|(?:^|\n)\$\s|\b(?:stdout|stderr|exit code|tool output|read output|file contents)\b/i;

export const stripInjectedMemoryBlocks = (value: string): string =>
  value.replace(SESSION_MEMORY_BLOCK_PATTERN, " ")
    .replace(LEGACY_MEMORY_BLOCK_PATTERN, " ")
    .replace(PERSISTENT_MEMORY_BLOCK_PATTERN, " ");

export const stripToolTranscriptWrappers = (value: string): string =>
  TOOL_WRAPPER_DOCUMENT_PATTERN.test(value)
    ? value.replace(TOOL_WRAPPER_BLOCK_PATTERN, " ")
      .replace(TOOL_WRAPPER_LINE_PATTERN, " ")
      .replace(TOOL_WRAPPER_PREFIX_PATTERN, " ")
    : value;

const normalizeSanitizedText = (value: string): string =>
  value.replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[\t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .trim();

export const sanitizeMemoryInput = (value: string): string =>
  normalizeSanitizedText(
    stripToolTranscriptWrappers(stripInjectedMemoryBlocks(value)),
  );

export const sanitizeMemoryInputPreservingMemoryBlocks = (
  value: string,
): string => normalizeSanitizedText(stripToolTranscriptWrappers(value));

export const normalizeMemoryText = (value: string): string =>
  sanitizeMemoryInput(value)
    .toLowerCase()
    .replace(/&(?:amp|lt|gt|quot|apos);/g, " ")
    .replace(/[^a-z0-9./_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const uniqueNormalizedValues = (
  values: string[],
  limit: number,
  excludedNormalized = new Set<string>(),
): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = sanitizeMemoryInput(value);
    const normalized = normalizeMemoryText(cleaned);
    if (
      !cleaned || !normalized || excludedNormalized.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }
    seen.add(normalized);
    result.push(cleaned);
    if (result.length >= limit) break;
  }
  return result;
};

export const looksLikeOperationalChatter = (value: string): boolean =>
  OPERATIONAL_CHATTER_PATTERN.test(sanitizeMemoryInput(value));

export const looksLikeToolTranscript = (value: string): boolean =>
  TOOL_WRAPPER_DOCUMENT_PATTERN.test(value) ||
  TOOL_TRANSCRIPT_PATTERN.test(value);

export const looksTranscriptHeavy = (value: string): boolean => {
  const sanitized = sanitizeMemoryInput(value);
  if (!sanitized) return false;
  return sanitized.length > 600 || sanitized.split("\n").length > 12 ||
    TRANSCRIPT_HEAVY_PATTERN.test(sanitized);
};

export const isHighValueMemoryText = (value: string): boolean => {
  const sanitized = sanitizeMemoryInput(value);
  if (!sanitized) return false;
  const looksHighValue = HIGH_VALUE_MEMORY_PATTERN.test(sanitized);
  if (!looksHighValue) return false;
  const hasStructuredTranscriptEvidence =
    TOOL_WRAPPER_DOCUMENT_PATTERN.test(value) || sanitized.length > 600 ||
    sanitized.split("\n").length > 12 ||
    STRUCTURED_TRANSCRIPT_HEAVY_PATTERN.test(sanitized);
  if (looksLikeToolTranscript(sanitized) && hasStructuredTranscriptEvidence) {
    return false;
  }
  if (LOW_VALUE_MEMORY_PATTERN.test(sanitized)) return false;
  return true;
};

const fitEscapedText = (value: string, maxEscapedLength: number): string => {
  const source = value.trim();
  if (!source || maxEscapedLength <= 0) return "";
  if (escapeXml(source).length <= maxEscapedLength) return source;

  let low = 0;
  let high = source.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (escapeXml(source.slice(0, mid)).length <= maxEscapedLength) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return source.slice(0, low).trimEnd();
};

export interface RenderXmlListSectionOptions {
  itemCharLimit?: number;
  remaining?: number;
}

export const renderXmlListSection = (
  tag: string,
  itemTag: string,
  values: string[],
  options: RenderXmlListSectionOptions = {},
): string => {
  const { itemCharLimit, remaining } = options;
  const open = `<${tag}>`;
  const close = `</${tag}>`;

  if (remaining !== undefined && open.length + close.length > remaining) {
    return "";
  }

  let body = "";
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;

    const limited = itemCharLimit
      ? normalized.slice(0, itemCharLimit)
      : normalized;
    const itemOpen = `<${itemTag}>`;
    const itemClose = `</${itemTag}>`;
    const content = remaining === undefined ? limited : fitEscapedText(
      limited,
      remaining - open.length - close.length - body.length - itemOpen.length -
        itemClose.length,
    );
    if (!content) break;

    body += `${itemOpen}${escapeXml(content)}</${itemTag}>`;
  }

  if (!body) return "";
  return `${open}${body}${close}`;
};

export interface RenderXmlSingleSectionOptions {
  valueCharLimit?: number;
  remaining?: number;
}

export const renderXmlSingleSection = (
  tag: string,
  itemTag: string,
  value: string | undefined,
  options: RenderXmlSingleSectionOptions = {},
): string => {
  if (!value) return "";

  const { valueCharLimit, remaining } = options;
  const normalized = value.trim();
  if (!normalized) return "";

  const limited = valueCharLimit
    ? normalized.slice(0, valueCharLimit)
    : normalized;
  const open = `<${tag}><${itemTag}>`;
  const close = `</${itemTag}></${tag}>`;
  const content = remaining === undefined
    ? limited
    : fitEscapedText(limited, remaining - open.length - close.length);
  if (!content) return "";

  const section = `${open}${escapeXml(content)}${close}`;
  return remaining === undefined || section.length <= remaining ? section : "";
};
