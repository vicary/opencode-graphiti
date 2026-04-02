import type { RedisClient, RedisKeySnapshot } from "./redis-client.ts";
import { createAbortError } from "../utils.ts";

const MAX_INDEXED_BODY_BYTES = 512 * 1024;
const SEARCH_RESULT_LIMIT = 5;
const SEARCH_CANDIDATE_LIMIT = 200;
const SEARCH_POSTINGS_FETCH_LIMIT = 1000;
const SEARCH_SNIPPET_LIMIT = 320;
const TEXT_CHUNK_SIZE = 1200;
const TEXT_CHUNK_OVERLAP = 200;
const RRF_K = 60;
const SEARCH_SCAN_LIMIT = 10_000;
const VOCAB_TOKEN = "__vocab__";
const STEM_TOKEN_PREFIX = "__stem__:";

type SessionCorpusOptions = {
  redis: RedisClient;
  ttlSeconds: number;
  groupId: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

type IndexInput = {
  rootSessionId: string;
  content: string;
  contentType?: string;
  title?: string;
  source?: string;
  label?: string;
  sourceUrl?: string;
  artifactId?: string;
};

type SearchInput = {
  rootSessionId: string;
  query: string;
};

type FetchAndIndexInput = {
  rootSessionId: string;
  url: string;
  timeoutSeconds?: number;
};

type StoreArtifactInput = {
  rootSessionId: string;
  toolName: string;
  body: string;
};

type SearchResult = {
  corpus_ref: string;
  snippet: string;
  score: number;
};

type CorpusMeta = {
  title: string;
  contentType: string;
  createdAt: number;
  source?: string;
  label?: string;
  sourceUrl?: string;
  truncated: boolean;
  artifactId?: string;
};

type ChunkRecord = {
  id: string;
  corpusId: string;
  title: string;
  text: string;
  terms: string[];
  stems: string[];
  trigrams: string[];
  termFreqs: Record<string, number>;
  stemFreqs: Record<string, number>;
  stemPositions: Record<string, number[]>;
  length: number;
  createdAt: number;
};

type ChunkSource = {
  title: string;
  text: string;
};

type TokenWithPosition = {
  token: string;
  position: number;
};

const encoder = new TextEncoder();

const normalizeWhitespace = (value: string): string =>
  value.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();

const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)];

const pluralStemExceptions: Record<string, string> = {
  indices: "index",
  index: "index",
};

const stemToken = (token: string): string => {
  const lower = token.toLowerCase();
  if (pluralStemExceptions[lower]) return pluralStemExceptions[lower];
  if (lower.length <= 3) return lower;

  const isConsonant = (value: string, index: number): boolean => {
    const char = value[index];
    if (!char) return false;
    if ("aeiou".includes(char)) return false;
    if (char === "y") {
      return index === 0 ? true : !isConsonant(value, index - 1);
    }
    return true;
  };

  const measure = (value: string): number => {
    let count = 0;
    let inVowelRun = false;
    for (let index = 0; index < value.length; index += 1) {
      const vowel = !isConsonant(value, index);
      if (vowel) {
        inVowelRun = true;
      } else if (inVowelRun) {
        count += 1;
        inVowelRun = false;
      }
    }
    return count;
  };

  const containsVowel = (value: string): boolean =>
    [...value].some((_char, index) => !isConsonant(value, index));

  const endsWithDoubleConsonant = (value: string): boolean =>
    value.length >= 2 &&
    value[value.length - 1] === value[value.length - 2] &&
    isConsonant(value, value.length - 1);

  const cvc = (value: string): boolean => {
    if (value.length < 3) return false;
    const a = value.length - 3;
    const b = value.length - 2;
    const c = value.length - 1;
    return isConsonant(value, a) && !isConsonant(value, b) &&
      isConsonant(value, c) && !"wxy".includes(value[c]);
  };

  const replaceSuffix = (
    value: string,
    suffix: string,
    replacement: string,
    predicate: (stem: string) => boolean = () => true,
  ): string | null => {
    if (!value.endsWith(suffix)) return null;
    const stem = value.slice(0, -suffix.length);
    if (!predicate(stem)) return null;
    return `${stem}${replacement}`;
  };

  let stem = lower;

  if (stem.endsWith("sses")) stem = stem.slice(0, -2);
  else if (stem.endsWith("ies")) stem = stem.slice(0, -2);
  else if (stem.endsWith("ss")) {
    // Keep.
  } else if (stem.endsWith("s")) stem = stem.slice(0, -1);

  const step1b =
    replaceSuffix(stem, "eed", "ee", (base) => measure(base) > 0) ??
      replaceSuffix(stem, "eedly", "ee", (base) => measure(base) > 0);
  if (step1b) {
    stem = step1b;
  } else {
    const removed = replaceSuffix(stem, "ingly", "", containsVowel) ??
      replaceSuffix(stem, "edly", "", containsVowel) ??
      replaceSuffix(stem, "ing", "", containsVowel) ??
      replaceSuffix(stem, "ed", "", containsVowel);
    if (removed) {
      stem = removed;
      if (/(at|bl|iz)$/.test(stem)) stem = `${stem}e`;
      else if (endsWithDoubleConsonant(stem) && !/[lsz]$/.test(stem)) {
        stem = stem.slice(0, -1);
      } else if (measure(stem) === 1 && cvc(stem)) {
        stem = `${stem}e`;
      }
    }
  }

  if (stem.endsWith("y") && containsVowel(stem.slice(0, -1))) {
    stem = `${stem.slice(0, -1)}i`;
  }

  const step2Rules: Array<[string, string]> = [
    ["ational", "ate"],
    ["tional", "tion"],
    ["enci", "ence"],
    ["anci", "ance"],
    ["izer", "ize"],
    ["abli", "able"],
    ["alli", "al"],
    ["entli", "ent"],
    ["eli", "e"],
    ["ousli", "ous"],
    ["ization", "ize"],
    ["ation", "ate"],
    ["ator", "ate"],
    ["alism", "al"],
    ["iveness", "ive"],
    ["fulness", "ful"],
    ["ousness", "ous"],
    ["aliti", "al"],
    ["iviti", "ive"],
    ["biliti", "ble"],
    ["logi", "log"],
  ];
  for (const [suffix, replacement] of step2Rules) {
    const replaced = replaceSuffix(
      stem,
      suffix,
      replacement,
      (base) => measure(base) > 0,
    );
    if (replaced) {
      stem = replaced;
      break;
    }
  }

  const step3Rules: Array<[string, string]> = [
    ["icate", "ic"],
    ["ative", ""],
    ["alize", "al"],
    ["iciti", "ic"],
    ["ical", "ic"],
    ["ful", ""],
    ["ness", ""],
  ];
  for (const [suffix, replacement] of step3Rules) {
    const replaced = replaceSuffix(
      stem,
      suffix,
      replacement,
      (base) => measure(base) > 0,
    );
    if (replaced) {
      stem = replaced;
      break;
    }
  }

  const step4Suffixes = [
    "ement",
    "ance",
    "ence",
    "able",
    "ible",
    "ment",
    "ant",
    "ent",
    "ism",
    "ate",
    "iti",
    "ous",
    "ive",
    "ize",
    "al",
    "er",
    "ic",
    "ou",
  ];
  for (const suffix of step4Suffixes) {
    const replaced = replaceSuffix(
      stem,
      suffix,
      "",
      (base) => measure(base) > 1,
    );
    if (replaced) {
      stem = replaced;
      break;
    }
  }
  const ionReplaced = replaceSuffix(
    stem,
    "ion",
    "",
    (base) => measure(base) > 1 && /[st]$/.test(base),
  );
  if (ionReplaced) stem = ionReplaced;

  const withoutTrailingE = replaceSuffix(
    stem,
    "e",
    "",
    (base) => measure(base) > 1 || (measure(base) === 1 && !cvc(base)),
  );
  if (withoutTrailingE) stem = withoutTrailingE;
  if (
    measure(stem) > 1 && endsWithDoubleConsonant(stem) && stem.endsWith("l")
  ) {
    stem = stem.slice(0, -1);
  }

  return stem || lower;
};

const tokenizeWithPositions = (value: string): TokenWithPosition[] => {
  const matches = value.toLowerCase().matchAll(/[a-z0-9]+/g);
  let position = 0;
  const tokens: TokenWithPosition[] = [];
  for (const match of matches) {
    const token = match[0];
    if (token.length < 2) continue;
    tokens.push({ token, position: position++ });
  }
  return tokens;
};

const tokenize = (value: string): string[] =>
  tokenizeWithPositions(value).map(({ token }) => token);

const frequencyMap = (values: string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
};

const buildStemPositions = (
  values: TokenWithPosition[],
): Record<string, number[]> => {
  const positions: Record<string, number[]> = {};
  for (const value of values) {
    const stem = stemToken(value.token);
    positions[stem] ??= [];
    positions[stem].push(value.position);
  }
  return positions;
};

const makeTrigrams = (value: string): string[] => {
  const normalized = normalizeWhitespace(value).toLowerCase();
  if (normalized.length < 3) return normalized ? [normalized] : [];
  const trigrams = new Set<string>();
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    trigrams.add(normalized.slice(index, index + 3));
  }
  return [...trigrams];
};

const htmlToMarkdown = (html: string): string => {
  const codePlaceholders = new Map<string, string>();
  let codeCounter = 0;
  let working = html
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n");

  working = working.replace(
    /<pre[^>]*>\s*(?:<code([^>]*)>)?([\s\S]*?)(?:<\/code>)?\s*<\/pre>/gi,
    (_match, codeAttrs, codeBody) => {
      const language = /language-([a-z0-9_-]+)/i.exec(codeAttrs ?? "")?.[1] ??
        "";
      const body = decodeHtmlEntities(
        String(codeBody).replace(/<[^>]+>/g, ""),
      ).trimEnd();
      const placeholder = `CODEBLOCKPLACEHOLDER${++codeCounter}`;
      codePlaceholders.set(
        placeholder,
        `\n\n\`\`\`${language}\n${body}\n\`\`\`\n\n`,
      );
      return `\n\n${placeholder}\n\n`;
    },
  );

  working = working.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_m, level, text) => {
      const heading = decodeHtmlEntities(String(text).replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ").trim();
      return `\n\n${"#".repeat(Number(level))} ${heading}\n\n`;
    },
  );

  working = working.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_m, listBody) => {
    const items = [...String(listBody).matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
      .map(([, item], index) =>
        `${index + 1}. ${
          decodeHtmlEntities(String(item).replace(/<[^>]+>/g, " ")).replace(
            /\s+/g,
            " ",
          ).trim()
        }`
      )
      .filter(Boolean);
    return `\n\n${items.join("\n")}\n\n`;
  });

  working = working.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_m, listBody) => {
    const items = [...String(listBody).matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
      .map(([, item]) =>
        `- ${
          decodeHtmlEntities(String(item).replace(/<[^>]+>/g, " ")).replace(
            /\s+/g,
            " ",
          ).trim()
        }`
      )
      .filter(Boolean);
    return `\n\n${items.join("\n")}\n\n`;
  });

  working = working
    .replace(/<(article|section|div|p)[^>]*>/gi, "\n\n")
    .replace(/<\/(article|section|div|p)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  working = decodeHtmlEntities(working)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  for (const [placeholder, codeBlock] of codePlaceholders) {
    working = working.replaceAll(placeholder, codeBlock.trim());
  }

  return working.replace(/```([a-z0-9_-]*)\n\n+/gi, "```$1\n");
};

const inferContentType = (content: string, contentType?: string): string => {
  const normalized = (contentType ?? "").toLowerCase();
  if (normalized.includes("html")) return "text/html";
  if (normalized.includes("markdown")) return "text/markdown";
  if (normalized.includes("json")) return "application/json";
  const trimmed = content.trim();
  if (trimmed.startsWith("<") && trimmed.includes(">")) return "text/html";
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return "application/json";
  }
  if (/^#{1,6}\s+/m.test(content)) return "text/markdown";
  return "text/plain";
};

const normalizeContent = (
  content: string,
  contentType?: string,
): { body: string; contentType: string; title: string; truncated: boolean } => {
  const resolvedContentType = inferContentType(content, contentType);
  let normalized = content;

  if (resolvedContentType === "text/html") {
    normalized = htmlToMarkdown(content);
  } else if (resolvedContentType === "application/json") {
    try {
      normalized = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      normalized = content;
    }
  }

  let truncated = false;
  while (encoder.encode(normalized).byteLength > MAX_INDEXED_BODY_BYTES) {
    normalized = normalized.slice(
      0,
      Math.max(Math.floor(normalized.length * 0.8), 1),
    );
    truncated = true;
  }

  const titleLine = normalized
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "Untitled corpus";
  const title = titleLine.replace(/^#{1,6}\s+/, "").trim();

  return {
    body: normalized.trim(),
    contentType: resolvedContentType,
    title,
    truncated,
  };
};

const splitTextChunk = (text: string): string[] => {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= TEXT_CHUNK_SIZE) return [trimmed];

  const paragraphs = trimmed.split(/\n{2,}/).map((paragraph) =>
    paragraph.trim()
  ).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = "";
  };

  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
      continue;
    }
    if (`${current}\n\n${paragraph}`.length <= TEXT_CHUNK_SIZE) {
      current = `${current}\n\n${paragraph}`;
      continue;
    }
    pushCurrent();
    if (paragraph.length <= TEXT_CHUNK_SIZE) {
      current = paragraph;
      continue;
    }

    let offset = 0;
    while (offset < paragraph.length) {
      const end = Math.min(offset + TEXT_CHUNK_SIZE, paragraph.length);
      chunks.push(paragraph.slice(offset, end).trim());
      if (end >= paragraph.length) break;
      offset += TEXT_CHUNK_SIZE - TEXT_CHUNK_OVERLAP;
    }
  }

  pushCurrent();
  return chunks;
};

const chunkMarkdown = (text: string, fallbackTitle: string): ChunkSource[] => {
  const lines = text.split("\n");
  const chunks: ChunkSource[] = [];
  let currentTitle = fallbackTitle;
  let textBuffer: string[] = [];
  let codeBuffer: string[] = [];
  let inCodeBlock = false;

  const flushText = () => {
    const joined = textBuffer.join("\n").trim();
    textBuffer = [];
    for (const piece of splitTextChunk(joined)) {
      chunks.push({ title: currentTitle, text: piece });
    }
  };

  const flushCode = () => {
    const joined = codeBuffer.join("\n").trim();
    codeBuffer = [];
    if (joined) chunks.push({ title: currentTitle, text: `${joined}\n` });
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inCodeBlock && /^#{1,6}\s+/.test(trimmed)) {
      flushText();
      currentTitle = trimmed.replace(/^#{1,6}\s+/, "").trim() || fallbackTitle;
      continue;
    }

    if (trimmed.startsWith("```")) {
      if (inCodeBlock) {
        codeBuffer.push(line);
        flushCode();
        inCodeBlock = false;
      } else {
        flushText();
        inCodeBlock = true;
        codeBuffer.push(line);
      }
      continue;
    }

    if (inCodeBlock) codeBuffer.push(line);
    else textBuffer.push(line);
  }

  if (inCodeBlock) flushCode();
  flushText();
  return chunks.filter((chunk) => chunk.text.trim().length > 0);
};

const extractSnippet = (
  text: string,
  anchors: {
    tokens: string[];
    stems: string[];
    trigrams: string[];
  },
): string => {
  const normalized = text.trim();
  if (normalized.length <= SEARCH_SNIPPET_LIMIT) return normalized;
  const lower = normalized.toLowerCase();
  const tokenMatches = anchors.tokens
    .map((term) => lower.indexOf(term.toLowerCase()))
    .filter((index) => index >= 0);

  const stemMatches = anchors.stems.flatMap((stem) => {
    const matches = lower.matchAll(/[a-z0-9]+/g);
    const indexes: number[] = [];
    for (const match of matches) {
      const token = match[0];
      if (stemToken(token) === stem) indexes.push(match.index ?? -1);
    }
    return indexes.filter((index) => index >= 0);
  });

  const trigramMatches = anchors.trigrams
    .map((trigram) => lower.indexOf(trigram.toLowerCase()))
    .filter((index) => index >= 0);

  const firstMatch = [...tokenMatches, ...stemMatches, ...trigramMatches]
    .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(firstMatch - 80, 0);
  return normalized.slice(start, start + SEARCH_SNIPPET_LIMIT).trim();
};

const levenshtein = (left: string, right: string): number => {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 0; i < left.length; i += 1) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j += 1) {
      const cost = left[i] === right[j] ? 0 : 1;
      current[j + 1] = Math.min(
        current[j] + 1,
        previous[j + 1] + 1,
        previous[j] + cost,
      );
    }
    previous = current;
  }
  return previous[right.length];
};

const bm25Score = (
  tf: number,
  df: number,
  docLength: number,
  avgDocLength: number,
  docCount: number,
): number => {
  if (tf <= 0 || df <= 0 || docCount <= 0) return 0;
  const k1 = 1.2;
  const b = 0.75;
  const idf = Math.log(1 + ((docCount - df + 0.5) / (df + 0.5)));
  const numerator = tf * (k1 + 1);
  const denominator = tf +
    k1 * (1 - b + b * (docLength / Math.max(avgDocLength, 1)));
  return idf * (numerator / denominator);
};

const proximityBoost = (
  queryStems: string[],
  positions: Record<string, number[]>,
): number => {
  const uniqueStems = unique(queryStems).filter((stem) =>
    (positions[stem]?.length ?? 0) > 0
  );
  if (uniqueStems.length <= 1) return 0;

  let minWindow = Number.POSITIVE_INFINITY;
  const firstStem = uniqueStems[0];
  for (const start of positions[firstStem] ?? []) {
    let min = start;
    let max = start;
    let complete = true;
    for (const stem of uniqueStems.slice(1)) {
      const candidates = positions[stem] ?? [];
      if (candidates.length === 0) {
        complete = false;
        break;
      }
      const nearest = candidates.reduce(
        (best, value) =>
          Math.abs(value - start) < Math.abs(best - start) ? value : best,
        candidates[0],
      );
      min = Math.min(min, nearest);
      max = Math.max(max, nearest);
    }
    if (complete) minWindow = Math.min(minWindow, max - min);
  }

  return Number.isFinite(minWindow) ? 12 / (minWindow + 1) : 0;
};

const partialStringOriented = (
  query: string,
  tokens: string[],
  vocabulary: ReadonlySet<string>,
): boolean => {
  if (/[^a-z0-9\s]/i.test(query)) return true;
  if (!query.includes(" ")) {
    return tokens.some((token) => !vocabulary.has(token) && token.length <= 5);
  }
  return tokens.some((token) => !vocabulary.has(token) && token.length <= 4);
};

const artifactRefFor = (toolName: string, artifactId: string): string =>
  `local://${toolName}/${artifactId}`;

export type SessionCorpusService = ReturnType<
  typeof createSessionCorpusService
>;

export const createSessionCorpusService = (options: SessionCorpusOptions) => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());

  const sessionPrefix = (rootSessionId: string) =>
    `session:${options.groupId}:${rootSessionId}`;
  const statsKey = (rootSessionId: string) =>
    `${sessionPrefix(rootSessionId)}:stats`;
  const corporaKey = (rootSessionId: string) =>
    `${sessionPrefix(rootSessionId)}:corpora`;
  const corpusMetaKey = (rootSessionId: string, corpusId: string) =>
    `${sessionPrefix(rootSessionId)}:corpus:${corpusId}:meta`;
  const corpusChunksKey = (rootSessionId: string, corpusId: string) =>
    `${sessionPrefix(rootSessionId)}:corpus:${corpusId}:chunks`;
  const corpusCounterKey = (rootSessionId: string) =>
    `${sessionPrefix(rootSessionId)}:corpus-counter`;
  const chunkKey = (rootSessionId: string, chunkId: string) =>
    `${sessionPrefix(rootSessionId)}:chunk:${chunkId}`;
  const termKey = (rootSessionId: string, token: string) =>
    `${sessionPrefix(rootSessionId)}:term:${token}`;
  const stemPostingKey = (rootSessionId: string, stem: string) =>
    termKey(rootSessionId, `${STEM_TOKEN_PREFIX}${stem}`);
  const vocabKey = (rootSessionId: string) =>
    termKey(rootSessionId, VOCAB_TOKEN);
  const trigramKey = (rootSessionId: string, trigram: string) =>
    `${sessionPrefix(rootSessionId)}:tri:${trigram}`;
  const artifactMetaKey = (rootSessionId: string, artifactId: string) =>
    `${sessionPrefix(rootSessionId)}:artifact:${artifactId}:meta`;
  const artifactBodyKey = (rootSessionId: string, artifactId: string) =>
    `${sessionPrefix(rootSessionId)}:artifact:${artifactId}:body`;
  const corpusRefFor = (rootSessionId: string, corpusId: string) =>
    corpusMetaKey(rootSessionId, corpusId);
  const identityKey = (
    rootSessionId: string,
    source: string,
    label: string,
  ) =>
    `${sessionPrefix(rootSessionId)}:identity:${encodeURIComponent(source)}:${
      encodeURIComponent(label)
    }`;

  const updateStats = async (
    rootSessionId: string,
    deltas: Record<string, number>,
  ): Promise<Record<string, string>> => {
    return await options.redis.incrementHashFields(
      statsKey(rootSessionId),
      deltas,
      options.ttlSeconds,
    );
  };

  const maxTtl = (...values: Array<number | undefined>): number | undefined => {
    let ttl: number | undefined;
    for (const value of values) {
      if (value === undefined) continue;
      ttl = ttl === undefined ? value : Math.max(ttl, value);
    }
    return ttl;
  };

  const isNumericString = (value: string | undefined): boolean =>
    value !== undefined && /^-?\d+(?:\.\d+)?$/.test(value);

  const mergeHashValues = (
    existing: Record<string, string>,
    incoming: Record<string, string>,
    mode: "replace" | "sum-numeric",
  ): Record<string, string> => {
    const merged = { ...existing };
    for (const [field, value] of Object.entries(incoming)) {
      if (
        mode === "sum-numeric" && isNumericString(merged[field]) &&
        isNumericString(value)
      ) {
        merged[field] = String(Number(merged[field]) + Number(value));
        continue;
      }
      merged[field] = value;
    }
    return merged;
  };

  const requireSnapshotKind = <TKind extends RedisKeySnapshot["kind"]>(
    key: string,
    snapshot: RedisKeySnapshot | undefined,
    kind: TKind,
  ): Extract<RedisKeySnapshot, { kind: TKind }> => {
    if (!snapshot || snapshot.kind !== kind) {
      throw new Error(`Expected ${kind} snapshot for ${key}`);
    }
    return snapshot as Extract<RedisKeySnapshot, { kind: TKind }>;
  };

  const mapCorpusRef = (
    corpusRef: string | undefined,
    sourceRootSessionId: string,
    targetRootSessionId: string,
    corpusIdMap: ReadonlyMap<string, string>,
  ): string | undefined => {
    if (!corpusRef) return corpusRef;
    const sourcePrefix = `${sessionPrefix(sourceRootSessionId)}:corpus:`;
    if (!corpusRef.startsWith(sourcePrefix)) return corpusRef;
    const sourceCorpusParts = corpusRef.split(":");
    const sourceCorpusId = sourceCorpusParts[sourceCorpusParts.length - 2] ??
      "";
    const targetCorpusId = corpusIdMap.get(sourceCorpusId);
    return targetCorpusId
      ? corpusRefFor(targetRootSessionId, targetCorpusId)
      : corpusRef;
  };

  const reserveCorpusId = async (rootSessionId: string): Promise<string> => {
    const index = await options.redis.appendToList(
      corpusCounterKey(rootSessionId),
      "__reserved__",
      options.ttlSeconds,
    );
    return `corpus-${index}`;
  };

  const reserveChunkId = async (
    rootSessionId: string,
    corpusId: string,
  ): Promise<{ chunkId: string; chunkIndex: number }> => {
    const listKey = corpusChunksKey(rootSessionId, corpusId);
    const index = await options.redis.appendToList(
      listKey,
      "__pending__",
    );
    const chunkId = `chunk-${corpusId}-${index}`;
    await options.redis.setListItem(listKey, index - 1, chunkId);
    await options.redis.touch(listKey, options.ttlSeconds).catch(() =>
      undefined
    );
    return { chunkId, chunkIndex: index - 1 };
  };

  const reserveArtifactId = (): string => `artifact-${crypto.randomUUID()}`;

  const touchIfPresent = async (key: string) => {
    await options.redis.touch(key, options.ttlSeconds).catch(() => undefined);
  };

  const refreshCorpusFamily = async (
    rootSessionId: string,
    corpusId: string,
  ) => {
    await touchIfPresent(corporaKey(rootSessionId));
    await touchIfPresent(statsKey(rootSessionId));
    await touchIfPresent(corpusMetaKey(rootSessionId, corpusId));
    await touchIfPresent(corpusChunksKey(rootSessionId, corpusId));
    await touchIfPresent(vocabKey(rootSessionId));

    const chunkIds = await options.redis.getListRange(
      corpusChunksKey(rootSessionId, corpusId),
      0,
      SEARCH_SCAN_LIMIT,
    );
    for (const chunkId of chunkIds) {
      const chunk = await options.redis.getHashAll(
        chunkKey(rootSessionId, chunkId),
      );
      if (Object.keys(chunk).length === 0) continue;
      await touchIfPresent(chunkKey(rootSessionId, chunkId));
      for (const token of JSON.parse(chunk.terms ?? "[]") as string[]) {
        await touchIfPresent(termKey(rootSessionId, token));
      }
      for (const stem of JSON.parse(chunk.stems ?? "[]") as string[]) {
        await touchIfPresent(stemPostingKey(rootSessionId, stem));
      }
      for (const trigram of JSON.parse(chunk.trigrams ?? "[]") as string[]) {
        await touchIfPresent(trigramKey(rootSessionId, trigram));
      }
    }

    const meta = await options.redis.getHashAll(
      corpusMetaKey(rootSessionId, corpusId),
    );
    if (meta.artifact_id) {
      await touchIfPresent(artifactMetaKey(rootSessionId, meta.artifact_id));
      await touchIfPresent(artifactBodyKey(rootSessionId, meta.artifact_id));
    }
  };

  const chunkContent = (
    text: string,
    contentType: string,
    fallbackTitle: string,
  ): ChunkSource[] => {
    if (contentType === "text/markdown" || contentType === "text/html") {
      return chunkMarkdown(text, fallbackTitle);
    }
    return splitTextChunk(text).map((piece) => ({
      title: fallbackTitle,
      text: piece,
    }));
  };

  const writeCorpus = async (
    input: IndexInput,
    sourceType: string,
  ): Promise<{
    corpusRef: string;
    chunkCount: number;
    queryHints: string[];
    truncated: boolean;
    contentType: string;
  }> => {
    const normalized = normalizeContent(input.content, input.contentType);
    const createdAt = now();
    const meta: CorpusMeta = {
      title: input.title ?? normalized.title,
      contentType: normalized.contentType,
      createdAt,
      source: input.source,
      label: input.label,
      sourceUrl: input.sourceUrl,
      truncated: normalized.truncated,
      artifactId: input.artifactId,
    };
    const chunks = chunkContent(
      normalized.body,
      normalized.contentType,
      meta.title,
    );
    const corpusId = await reserveCorpusId(input.rootSessionId);
    await options.redis.appendToList(
      corporaKey(input.rootSessionId),
      corpusId,
      options.ttlSeconds,
    );
    await options.redis.setHashFields(
      corpusMetaKey(input.rootSessionId, corpusId),
      {
        title: meta.title,
        content_type: meta.contentType,
        source_type: sourceType,
        source: meta.source,
        label: meta.label,
        source_url: meta.sourceUrl,
        created_at: meta.createdAt,
        truncated: meta.truncated ? "1" : "0",
        artifact_id: meta.artifactId,
        chunk_count: chunks.length,
        root_session_id: input.rootSessionId,
        group_id: options.groupId,
      },
      options.ttlSeconds,
    );

    const vocabUpdates: Record<string, string> = {};
    for (const chunk of chunks) {
      const { chunkId, chunkIndex } = await reserveChunkId(
        input.rootSessionId,
        corpusId,
      );
      const combined = `${chunk.title}\n${chunk.text}`;
      const termPositions = tokenizeWithPositions(combined);
      const terms = termPositions.map(({ token }) => token);
      const stems = terms.map((token) => stemToken(token));
      const record: ChunkRecord = {
        id: chunkId,
        corpusId,
        title: chunk.title,
        text: chunk.text,
        terms: unique(terms),
        stems: unique(stems),
        trigrams: makeTrigrams(combined),
        termFreqs: frequencyMap(terms),
        stemFreqs: frequencyMap(stems),
        stemPositions: buildStemPositions(termPositions),
        length: Math.max(terms.length, 1),
        createdAt,
      };

      await options.redis.setHashFields(
        chunkKey(input.rootSessionId, chunkId),
        {
          corpus_id: corpusId,
          chunk_index: chunkIndex,
          title: record.title,
          text: record.text,
          terms: JSON.stringify(record.terms),
          stems: JSON.stringify(record.stems),
          trigrams: JSON.stringify(record.trigrams),
          term_freqs: JSON.stringify(record.termFreqs),
          stem_freqs: JSON.stringify(record.stemFreqs),
          stem_positions: JSON.stringify(record.stemPositions),
          length: record.length,
          created_at: record.createdAt,
        },
        options.ttlSeconds,
      );

      for (const term of record.terms) vocabUpdates[term] = stemToken(term);
      for (const term of record.terms) {
        await options.redis.appendToList(
          termKey(input.rootSessionId, term),
          chunkId,
          options.ttlSeconds,
        );
      }
      for (const stem of record.stems) {
        await options.redis.appendToList(
          stemPostingKey(input.rootSessionId, stem),
          chunkId,
          options.ttlSeconds,
        );
      }
      for (const trigram of record.trigrams) {
        await options.redis.appendToList(
          trigramKey(input.rootSessionId, trigram),
          chunkId,
          options.ttlSeconds,
        );
      }
    }

    if (Object.keys(vocabUpdates).length > 0) {
      await options.redis.setHashFields(
        vocabKey(input.rootSessionId),
        vocabUpdates,
        options.ttlSeconds,
      );
    }

    await updateStats(input.rootSessionId, {
      corpus_count: 1,
      chunk_count: chunks.length,
      bytes_indexed_total: encoder.encode(normalized.body).byteLength,
    });

    await refreshCorpusFamily(input.rootSessionId, corpusId);
    return {
      corpusRef: corpusRefFor(input.rootSessionId, corpusId),
      chunkCount: chunks.length,
      queryHints: unique(tokenize(meta.title)).slice(0, 5),
      truncated: meta.truncated,
      contentType: meta.contentType,
    };
  };

  const deleteListEntriesMatching = async (
    key: string,
    predicate: (value: string) => boolean,
  ): Promise<void> => {
    const snapshot = await options.redis.snapshot(key);
    if (snapshot.kind !== "list") return;
    const values = snapshot.values.filter((value) => !predicate(value));
    if (values.length === 0) {
      await options.redis.deleteKey(key);
      return;
    }
    await options.redis.restoreSnapshot(key, {
      kind: "list",
      values,
      ttlSeconds: snapshot.ttlSeconds,
    });
  };

  const deleteHashFields = async (
    key: string,
    fields: Iterable<string>,
  ): Promise<void> => {
    const snapshot = await options.redis.snapshot(key);
    if (snapshot.kind !== "hash") return;
    const nextValues = { ...snapshot.values };
    for (const field of fields) delete nextValues[field];
    const nextSnapshot: RedisKeySnapshot = Object.keys(nextValues).length === 0
      ? { kind: "missing" }
      : {
        kind: "hash",
        values: nextValues,
        ttlSeconds: snapshot.ttlSeconds,
      };
    await options.redis.restoreSnapshot(key, nextSnapshot);
  };

  const deleteCorpus = async (
    rootSessionId: string,
    corpusId: string,
  ): Promise<void> => {
    const metaKey = corpusMetaKey(rootSessionId, corpusId);
    const chunksKey = corpusChunksKey(rootSessionId, corpusId);
    const chunkIds = await options.redis.getListRange(
      chunksKey,
      0,
      SEARCH_SCAN_LIMIT,
    );
    const chunkIdSet = new Set(chunkIds);
    const termSet = new Set<string>();
    const stemSet = new Set<string>();
    const trigramSet = new Set<string>();

    for (const chunkId of chunkIds) {
      const chunk = await loadChunk(rootSessionId, chunkId);
      if (!chunk) continue;
      for (const term of chunk.terms) termSet.add(term);
      for (const stem of chunk.stems) stemSet.add(stem);
      for (const trigram of chunk.trigrams) trigramSet.add(trigram);
      await options.redis.deleteKey(chunkKey(rootSessionId, chunkId));
    }

    for (const term of termSet) {
      await deleteListEntriesMatching(
        termKey(rootSessionId, term),
        (value) => chunkIdSet.has(value),
      );
    }
    for (const stem of stemSet) {
      await deleteListEntriesMatching(
        stemPostingKey(rootSessionId, stem),
        (value) => chunkIdSet.has(value),
      );
    }
    for (const trigram of trigramSet) {
      await deleteListEntriesMatching(
        trigramKey(rootSessionId, trigram),
        (value) => chunkIdSet.has(value),
      );
    }

    const removableTerms: string[] = [];
    for (const term of termSet) {
      const remaining = await options.redis.getListRange(
        termKey(rootSessionId, term),
        0,
        0,
      );
      if (remaining.length === 0) removableTerms.push(term);
    }
    if (removableTerms.length > 0) {
      await deleteHashFields(vocabKey(rootSessionId), removableTerms);
    }

    await deleteListEntriesMatching(
      corporaKey(rootSessionId),
      (value) => value === corpusId,
    );
    await options.redis.deleteKey(chunksKey);
    await options.redis.deleteKey(metaKey);
    await updateStats(rootSessionId, {
      corpus_count: -1,
      chunk_count: -chunkIds.length,
    });
  };

  const loadChunk = async (
    rootSessionId: string,
    chunkId: string,
  ): Promise<ChunkRecord | null> => {
    const chunk = await options.redis.getHashAll(
      chunkKey(rootSessionId, chunkId),
    );
    if (Object.keys(chunk).length === 0) return null;
    return {
      id: chunkId,
      corpusId: chunk.corpus_id ?? "",
      title: chunk.title ?? "",
      text: chunk.text ?? "",
      terms: JSON.parse(chunk.terms ?? "[]"),
      stems: JSON.parse(chunk.stems ?? "[]"),
      trigrams: JSON.parse(chunk.trigrams ?? "[]"),
      termFreqs: JSON.parse(chunk.term_freqs ?? "{}"),
      stemFreqs: JSON.parse(chunk.stem_freqs ?? "{}"),
      stemPositions: JSON.parse(chunk.stem_positions ?? "{}"),
      length: Number(chunk.length ?? 1),
      createdAt: Number(chunk.created_at ?? 0),
    };
  };

  let disposed = false;

  const dispose = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    disposed = true;
    return Promise.resolve();
  };

  const migrateRootSessionState = async (
    sourceRootSessionId: string,
    targetRootSessionId: string,
  ): Promise<void> => {
    if (sourceRootSessionId === targetRootSessionId) return;

    const sourcePrefix = sessionPrefix(sourceRootSessionId);
    const targetPrefix = sessionPrefix(targetRootSessionId);
    const sourceKeys = await options.redis.keysByPrefix(`${sourcePrefix}:`);
    if (sourceKeys.length === 0) return;

    const sourceSnapshots = new Map<string, RedisKeySnapshot>(
      await Promise.all(sourceKeys.map(async (key) => {
        const snapshot = await options.redis.snapshot(key);
        return [key, snapshot] as const;
      })),
    );
    const workingTargetSnapshots = new Map<string, RedisKeySnapshot>();
    const handledSourceKeys = new Set<string>();

    const getWorkingTargetSnapshot = async (
      key: string,
    ): Promise<RedisKeySnapshot> => {
      const existing = workingTargetSnapshots.get(key);
      if (existing) return existing;
      const snapshot = await options.redis.snapshot(key);
      workingTargetSnapshots.set(key, snapshot);
      return snapshot;
    };

    const setWorkingTargetSnapshot = (
      key: string,
      snapshot: RedisKeySnapshot,
    ): void => {
      workingTargetSnapshots.set(key, snapshot);
    };

    const targetCorporaKey = corporaKey(targetRootSessionId);
    const sourceCorporaKey = corporaKey(sourceRootSessionId);
    const sourceCorporaSnapshot = sourceSnapshots.get(sourceCorporaKey);
    const sourceCorpusIds = sourceCorporaSnapshot?.kind === "list"
      ? sourceCorporaSnapshot.values
      : [];
    if (sourceCorporaSnapshot) handledSourceKeys.add(sourceCorporaKey);

    const targetCorporaSnapshot = await getWorkingTargetSnapshot(
      targetCorporaKey,
    );
    if (
      targetCorporaSnapshot.kind !== "missing" &&
      targetCorporaSnapshot.kind !== "list"
    ) {
      throw new Error(`Expected list snapshot for ${targetCorporaKey}`);
    }
    const targetCorpusIds = targetCorporaSnapshot.kind === "list"
      ? targetCorporaSnapshot.values
      : [];
    const corpusIdMap = new Map<string, string>();
    sourceCorpusIds.forEach((corpusId, index) => {
      corpusIdMap.set(corpusId, `corpus-${targetCorpusIds.length + index + 1}`);
    });
    setWorkingTargetSnapshot(targetCorporaKey, {
      kind: "list",
      values: [
        ...targetCorpusIds,
        ...sourceCorpusIds.map((corpusId) =>
          corpusIdMap.get(corpusId) ?? corpusId
        ),
      ],
      ttlSeconds: maxTtl(
        targetCorporaSnapshot.kind === "list"
          ? targetCorporaSnapshot.ttlSeconds
          : undefined,
        sourceCorporaSnapshot?.kind === "list"
          ? sourceCorporaSnapshot.ttlSeconds
          : undefined,
      ),
    });

    const chunkIdMap = new Map<string, string>();
    for (const sourceCorpusId of sourceCorpusIds) {
      const targetCorpusId = corpusIdMap.get(sourceCorpusId);
      if (!targetCorpusId) continue;

      const sourceCorpusMetaKey = corpusMetaKey(
        sourceRootSessionId,
        sourceCorpusId,
      );
      const sourceCorpusMetaSnapshot = requireSnapshotKind(
        sourceCorpusMetaKey,
        sourceSnapshots.get(sourceCorpusMetaKey),
        "hash",
      );
      handledSourceKeys.add(sourceCorpusMetaKey);
      setWorkingTargetSnapshot(
        corpusMetaKey(targetRootSessionId, targetCorpusId),
        {
          kind: "hash",
          values: {
            ...sourceCorpusMetaSnapshot.values,
            root_session_id: targetRootSessionId,
            group_id: options.groupId,
          },
          ttlSeconds: sourceCorpusMetaSnapshot.ttlSeconds,
        },
      );

      const sourceChunkListKey = corpusChunksKey(
        sourceRootSessionId,
        sourceCorpusId,
      );
      const sourceChunkListSnapshot = requireSnapshotKind(
        sourceChunkListKey,
        sourceSnapshots.get(sourceChunkListKey),
        "list",
      );
      handledSourceKeys.add(sourceChunkListKey);
      const mappedChunkIds = sourceChunkListSnapshot.values.map((
        _chunkId,
        index,
      ) => `chunk-${targetCorpusId}-${index + 1}`);
      sourceChunkListSnapshot.values.forEach((chunkId, index) => {
        chunkIdMap.set(chunkId, mappedChunkIds[index]);
      });
      setWorkingTargetSnapshot(
        corpusChunksKey(targetRootSessionId, targetCorpusId),
        {
          kind: "list",
          values: mappedChunkIds,
          ttlSeconds: sourceChunkListSnapshot.ttlSeconds,
        },
      );

      for (
        const [index, sourceChunkId] of sourceChunkListSnapshot.values.entries()
      ) {
        const sourceChunkKey = chunkKey(sourceRootSessionId, sourceChunkId);
        const sourceChunkSnapshot = requireSnapshotKind(
          sourceChunkKey,
          sourceSnapshots.get(sourceChunkKey),
          "hash",
        );
        handledSourceKeys.add(sourceChunkKey);
        setWorkingTargetSnapshot(
          chunkKey(targetRootSessionId, mappedChunkIds[index]),
          {
            kind: "hash",
            values: {
              ...sourceChunkSnapshot.values,
              corpus_id: targetCorpusId,
              chunk_index: String(index),
            },
            ttlSeconds: sourceChunkSnapshot.ttlSeconds,
          },
        );
      }
    }

    const sourceStatsKey = statsKey(sourceRootSessionId);
    const sourceStatsSnapshot = sourceSnapshots.get(sourceStatsKey);
    if (sourceStatsSnapshot) {
      const sourceStats = requireSnapshotKind(
        sourceStatsKey,
        sourceStatsSnapshot,
        "hash",
      );
      handledSourceKeys.add(sourceStatsKey);
      const targetStatsKey = statsKey(targetRootSessionId);
      const targetStatsSnapshot = await getWorkingTargetSnapshot(
        targetStatsKey,
      );
      const targetStats = targetStatsSnapshot.kind === "hash"
        ? targetStatsSnapshot.values
        : targetStatsSnapshot.kind === "missing"
        ? {}
        : (() => {
          throw new Error(`Expected hash snapshot for ${targetStatsKey}`);
        })();
      setWorkingTargetSnapshot(targetStatsKey, {
        kind: "hash",
        values: mergeHashValues(targetStats, sourceStats.values, "sum-numeric"),
        ttlSeconds: maxTtl(
          targetStatsSnapshot.kind === "hash"
            ? targetStatsSnapshot.ttlSeconds
            : undefined,
          sourceStats.ttlSeconds,
        ),
      });
    }

    for (const sourceKey of sourceKeys) {
      if (handledSourceKeys.has(sourceKey)) continue;
      const sourceSnapshot = sourceSnapshots.get(sourceKey);
      if (!sourceSnapshot || sourceSnapshot.kind === "missing") continue;

      if (sourceKey === vocabKey(sourceRootSessionId)) {
        const sourceVocab = requireSnapshotKind(
          sourceKey,
          sourceSnapshot,
          "hash",
        );
        const targetKey = vocabKey(targetRootSessionId);
        const targetSnapshot = await getWorkingTargetSnapshot(targetKey);
        const targetValues = targetSnapshot.kind === "hash"
          ? targetSnapshot.values
          : targetSnapshot.kind === "missing"
          ? {}
          : (() => {
            throw new Error(`Expected hash snapshot for ${targetKey}`);
          })();
        setWorkingTargetSnapshot(targetKey, {
          kind: "hash",
          values: mergeHashValues(targetValues, sourceVocab.values, "replace"),
          ttlSeconds: maxTtl(
            targetSnapshot.kind === "hash"
              ? targetSnapshot.ttlSeconds
              : undefined,
            sourceVocab.ttlSeconds,
          ),
        });
        handledSourceKeys.add(sourceKey);
        continue;
      }

      if (sourceKey === corpusCounterKey(sourceRootSessionId)) {
        const sourceCounter = requireSnapshotKind(
          sourceKey,
          sourceSnapshot,
          "list",
        );
        const targetKey = corpusCounterKey(targetRootSessionId);
        const targetSnapshot = await getWorkingTargetSnapshot(targetKey);
        const targetValues = targetSnapshot.kind === "list"
          ? targetSnapshot.values
          : targetSnapshot.kind === "missing"
          ? []
          : (() => {
            throw new Error(`Expected list snapshot for ${targetKey}`);
          })();
        setWorkingTargetSnapshot(targetKey, {
          kind: "list",
          values: [...targetValues, ...sourceCounter.values],
          ttlSeconds: maxTtl(
            targetSnapshot.kind === "list"
              ? targetSnapshot.ttlSeconds
              : undefined,
            sourceCounter.ttlSeconds,
          ),
        });
        handledSourceKeys.add(sourceKey);
        continue;
      }

      if (sourceKey.startsWith(`${sourcePrefix}:identity:`)) {
        const sourceIdentity = requireSnapshotKind(
          sourceKey,
          sourceSnapshot,
          "string",
        );
        const targetKey = `${targetPrefix}${
          sourceKey.slice(sourcePrefix.length)
        }`;
        const targetCorpusId = corpusIdMap.get(sourceIdentity.value) ??
          sourceIdentity.value;
        setWorkingTargetSnapshot(targetKey, {
          kind: "string",
          value: targetCorpusId,
          ttlSeconds: sourceIdentity.ttlSeconds,
        });
        handledSourceKeys.add(sourceKey);
        continue;
      }

      if (
        sourceKey.startsWith(`${sourcePrefix}:term:`) ||
        sourceKey.startsWith(`${sourcePrefix}:tri:`)
      ) {
        const sourcePosting = requireSnapshotKind(
          sourceKey,
          sourceSnapshot,
          "list",
        );
        const targetKey = `${targetPrefix}${
          sourceKey.slice(sourcePrefix.length)
        }`;
        const targetSnapshot = await getWorkingTargetSnapshot(targetKey);
        const targetValues = targetSnapshot.kind === "list"
          ? targetSnapshot.values
          : targetSnapshot.kind === "missing"
          ? []
          : (() => {
            throw new Error(`Expected list snapshot for ${targetKey}`);
          })();
        setWorkingTargetSnapshot(targetKey, {
          kind: "list",
          values: [
            ...targetValues,
            ...sourcePosting.values.map((chunkId) =>
              chunkIdMap.get(chunkId) ?? chunkId
            ),
          ],
          ttlSeconds: maxTtl(
            targetSnapshot.kind === "list"
              ? targetSnapshot.ttlSeconds
              : undefined,
            sourcePosting.ttlSeconds,
          ),
        });
        handledSourceKeys.add(sourceKey);
        continue;
      }

      if (sourceKey.startsWith(`${sourcePrefix}:artifact:`)) {
        const targetKey = `${targetPrefix}${
          sourceKey.slice(sourcePrefix.length)
        }`;
        const targetSnapshot = await getWorkingTargetSnapshot(targetKey);
        if (targetSnapshot.kind !== "missing") {
          throw new Error(
            `Refusing to overwrite existing artifact key ${targetKey}`,
          );
        }
        if (sourceKey.endsWith(":meta")) {
          const sourceMeta = requireSnapshotKind(
            sourceKey,
            sourceSnapshot,
            "hash",
          );
          setWorkingTargetSnapshot(targetKey, {
            kind: "hash",
            values: {
              ...sourceMeta.values,
              corpus_ref: mapCorpusRef(
                sourceMeta.values.corpus_ref,
                sourceRootSessionId,
                targetRootSessionId,
                corpusIdMap,
              ) ?? sourceMeta.values.corpus_ref ?? "",
            },
            ttlSeconds: sourceMeta.ttlSeconds,
          });
        } else if (sourceKey.endsWith(":body")) {
          const sourceBody = requireSnapshotKind(
            sourceKey,
            sourceSnapshot,
            "string",
          );
          setWorkingTargetSnapshot(targetKey, sourceBody);
        } else {
          throw new Error(`Unhandled artifact key ${sourceKey}`);
        }
        handledSourceKeys.add(sourceKey);
        continue;
      }

      throw new Error(`Unhandled session corpus key family ${sourceKey}`);
    }

    const unhandledSourceKeys = sourceKeys.filter((key) =>
      !handledSourceKeys.has(key)
    );
    if (unhandledSourceKeys.length > 0) {
      throw new Error(
        `Unhandled session corpus key family ${unhandledSourceKeys.join(", ")}`,
      );
    }

    await options.redis.applyMigrationUnit({
      writes: [...workingTargetSnapshots.entries()].map(([key, snapshot]) => ({
        key,
        snapshot,
      })),
      deleteKeys: sourceKeys,
    });
  };

  return {
    async index(input: IndexInput) {
      if (input.source && input.label) {
        const currentCorpusId = await options.redis.getString(
          identityKey(input.rootSessionId, input.source, input.label),
        );
        if (currentCorpusId) {
          await deleteCorpus(input.rootSessionId, currentCorpusId);
        }
      }

      const result = await writeCorpus(input, "index");
      if (input.source && input.label) {
        const corpusRefParts = result.corpusRef.split(":");
        const corpusId = corpusRefParts[corpusRefParts.length - 2] ?? "";
        await options.redis.setString(
          identityKey(input.rootSessionId, input.source, input.label),
          corpusId,
          options.ttlSeconds,
        );
      }
      return { status: "ok" as const, ...result };
    },

    async fetchAndIndex(input: FetchAndIndexInput) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(createAbortError("Fetch timed out")),
        (input.timeoutSeconds ?? 15) * 1000,
      );
      try {
        const response = await fetchImpl(input.url, {
          signal: controller.signal,
        });
        const contentType =
          response.headers.get("content-type")?.split(";")[0] ?? "text/plain";
        if (!response.ok) {
          return {
            status: "error" as const,
            corpusRef: corpusRefFor(
              input.rootSessionId,
              `error-http-${response.status}`,
            ),
            summary:
              `Fetch failed for ${input.url} with HTTP ${response.status}.`,
            queryHints: [],
            fetchedUrl: input.url,
            contentType,
            truncated: false,
          };
        }
        const content = await response.text();
        const indexed = await writeCorpus(
          {
            rootSessionId: input.rootSessionId,
            content,
            contentType,
            sourceUrl: input.url,
          },
          "fetch",
        );
        return {
          status: "ok" as const,
          corpusRef: indexed.corpusRef,
          summary: `Fetched and indexed ${input.url}`,
          queryHints: indexed.queryHints,
          fetchedUrl: input.url,
          contentType: indexed.contentType,
          truncated: indexed.truncated,
        };
      } finally {
        clearTimeout(timeout);
      }
    },

    async storeArtifact(input: StoreArtifactInput) {
      const artifactId = reserveArtifactId();
      const artifactRef = artifactRefFor(input.toolName, artifactId);

      await options.redis.setString(
        artifactBodyKey(input.rootSessionId, artifactId),
        input.body,
        options.ttlSeconds,
      );

      const corpus = await writeCorpus(
        {
          rootSessionId: input.rootSessionId,
          content: input.body,
          contentType: "text/plain",
          title: `${input.toolName} artifact`,
          artifactId,
        },
        "artifact",
      );

      await options.redis.setHashFields(
        artifactMetaKey(input.rootSessionId, artifactId),
        {
          tool_name: input.toolName,
          artifact_ref: artifactRef,
          corpus_ref: corpus.corpusRef,
          bytes: encoder.encode(input.body).byteLength,
          created_at: now(),
        },
        options.ttlSeconds,
      );

      await updateStats(input.rootSessionId, {
        artifact_count: 1,
        bytes_saved_estimate: encoder.encode(input.body).byteLength,
      });

      await refreshCorpusFamily(
        input.rootSessionId,
        (() => {
          const corpusRefParts = corpus.corpusRef.split(":");
          return corpusRefParts[corpusRefParts.length - 2] ?? "";
        })(),
      );

      return {
        status: "ok" as const,
        artifactRef,
        corpusRef: corpus.corpusRef,
        summary: normalizeWhitespace(input.body).slice(0, SEARCH_SNIPPET_LIMIT),
      };
    },

    async search(input: SearchInput): Promise<{
      status: "ok";
      results: SearchResult[];
      corpusRefs: string[];
      truncated: boolean;
    }> {
      const queryTokens = unique(tokenize(input.query));
      const vocabulary = await options.redis.getHashAll(
        vocabKey(input.rootSessionId),
      );
      const vocabularyTerms = new Set(Object.keys(vocabulary));

      const correctedTokens = await Promise.all(
        queryTokens.map(async (token) => {
          const exact = await options.redis.getListRange(
            termKey(input.rootSessionId, token),
            0,
            0,
          );
          const stem = await options.redis.getListRange(
            stemPostingKey(input.rootSessionId, stemToken(token)),
            0,
            0,
          );
          if (
            exact.length > 0 || stem.length > 0 || vocabularyTerms.has(token)
          ) {
            return token;
          }

          let best = token;
          let bestDistance = Number.POSITIVE_INFINITY;
          for (const candidate of vocabularyTerms) {
            const distance = levenshtein(token, candidate);
            if (distance < bestDistance) {
              best = candidate;
              bestDistance = distance;
            }
          }
          return bestDistance <= Math.max(1, Math.floor(token.length / 3))
            ? best
            : token;
        }),
      );

      const queryStems = correctedTokens.map((token) => stemToken(token));
      const queryTrigrams = makeTrigrams(correctedTokens.join(" "));

      const exactCandidateIds = new Set<string>();
      const stemCandidateIds = new Set<string>();

      const tokenHitCounts = new Map<string, number>();
      const stemHitCounts = new Map<string, number>();

      for (const token of correctedTokens) {
        const chunkIds = await options.redis.getListRange(
          termKey(input.rootSessionId, token),
          0,
          SEARCH_POSTINGS_FETCH_LIMIT - 1,
        );
        tokenHitCounts.set(token, chunkIds.length);
        for (const chunkId of chunkIds) exactCandidateIds.add(chunkId);
      }
      for (const stem of queryStems) {
        const chunkIds = await options.redis.getListRange(
          stemPostingKey(input.rootSessionId, stem),
          0,
          SEARCH_POSTINGS_FETCH_LIMIT - 1,
        );
        stemHitCounts.set(stem, chunkIds.length);
        for (const chunkId of chunkIds) stemCandidateIds.add(chunkId);
      }

      const sparseRecall = correctedTokens.some((token, index) => {
        const stem = queryStems[index];
        return (tokenHitCounts.get(token) ?? 0) === 0 &&
          (stemHitCounts.get(stem) ?? 0) === 0;
      }) || unique([...exactCandidateIds, ...stemCandidateIds]).length === 0;
      const useTrigrams = queryTrigrams.length > 0 &&
        (sparseRecall ||
          partialStringOriented(input.query, queryTokens, vocabularyTerms));

      const trigramCandidateIds = new Set<string>();
      if (useTrigrams) {
        for (const trigram of queryTrigrams) {
          const chunkIds = await options.redis.getListRange(
            trigramKey(input.rootSessionId, trigram),
            0,
            SEARCH_POSTINGS_FETCH_LIMIT - 1,
          );
          for (const chunkId of chunkIds) trigramCandidateIds.add(chunkId);
        }
      }

      const candidateIds = unique([
        ...exactCandidateIds,
        ...stemCandidateIds,
        ...trigramCandidateIds,
      ]);
      const candidateRecords = (await Promise.all(
        candidateIds.map((chunkId) => loadChunk(input.rootSessionId, chunkId)),
      )).filter((value): value is ChunkRecord => value !== null);
      const docCount = Math.max(candidateRecords.length, 1);
      const avgDocLength =
        candidateRecords.reduce((sum, record) => sum + record.length, 0) /
        docCount;
      const termDocFreqs = Object.fromEntries(
        await Promise.all(correctedTokens.map(async (token) => [
          token,
          await options.redis.getListLength(
            termKey(input.rootSessionId, token),
          ),
        ])),
      ) as Record<string, number>;
      const stemDocFreqs = Object.fromEntries(
        await Promise.all(queryStems.map(async (stem) => [
          stem,
          await options.redis.getListLength(
            stemPostingKey(input.rootSessionId, stem),
          ),
        ])),
      ) as Record<string, number>;

      const exactRanking = [...candidateRecords]
        .map((record) => ({
          chunkId: record.id,
          score: correctedTokens.reduce((sum, token) => {
            const titleTokens = tokenize(record.title);
            const titleFreqs = frequencyMap(titleTokens);
            return sum + bm25Score(
              (record.termFreqs[token] ?? 0) + ((titleFreqs[token] ?? 0) * 2),
              termDocFreqs[token] ?? 0,
              record.length,
              avgDocLength,
              docCount,
            );
          }, 0),
        }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score);

      const stemRanking = [...candidateRecords]
        .map((record) => ({
          chunkId: record.id,
          score: queryStems.reduce((sum, stem) => {
            const titleTokens = tokenize(record.title);
            const titleStems = titleTokens.map((token) => stemToken(token));
            const titleStemFreqs = frequencyMap(titleStems);
            return sum + (bm25Score(
              (record.stemFreqs[stem] ?? 0) + (titleStemFreqs[stem] ?? 0),
              stemDocFreqs[stem] ?? 0,
              record.length,
              avgDocLength,
              docCount,
            ) * 0.6);
          }, 0),
        }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score);

      const trigramRanking = useTrigrams
        ? [...candidateRecords]
          .map((record) => ({
            chunkId: record.id,
            score: queryTrigrams.length === 0
              ? 0
              : queryTrigrams.filter((trigram) =>
                record.trigrams.includes(trigram)
              )
                .length / queryTrigrams.length,
          }))
          .filter((item) => item.score > 0)
          .sort((left, right) => right.score - left.score)
        : [];

      const preliminaryScores = new Map<string, number>();
      for (const ranking of [exactRanking, stemRanking, trigramRanking]) {
        for (const item of ranking) {
          preliminaryScores.set(
            item.chunkId,
            (preliminaryScores.get(item.chunkId) ?? 0) + item.score,
          );
        }
      }
      const boundedCandidateIds = [...preliminaryScores.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, SEARCH_CANDIDATE_LIMIT)
        .map(([chunkId]) => chunkId);
      const candidateIdSet = new Set(boundedCandidateIds);
      const boundedCandidateRecords = candidateRecords.filter((record) =>
        candidateIdSet.has(record.id)
      );

      const rankMaps = [exactRanking, stemRanking, trigramRanking].map((
        ranking,
      ) => new Map(ranking.map((item, index) => [item.chunkId, index + 1])));

      const scored = boundedCandidateRecords.map((record) => {
        const titleTokens = tokenize(record.title);
        const titleFreqs = frequencyMap(titleTokens);
        const titleStems = titleTokens.map((token) => stemToken(token));
        const titleStemFreqs = frequencyMap(titleStems);

        let lexical = 0;
        for (const token of correctedTokens) {
          lexical += bm25Score(
            (record.termFreqs[token] ?? 0) + ((titleFreqs[token] ?? 0) * 2),
            termDocFreqs[token] ?? 0,
            record.length,
            avgDocLength,
            docCount,
          );
        }
        for (const stem of queryStems) {
          lexical += bm25Score(
            (record.stemFreqs[stem] ?? 0) + (titleStemFreqs[stem] ?? 0),
            stemDocFreqs[stem] ?? 0,
            record.length,
            avgDocLength,
            docCount,
          ) * 0.6;
        }

        let rrf = 0;
        for (const rankMap of rankMaps) {
          const rank = rankMap.get(record.id);
          if (rank) rrf += 1 / (RRF_K + rank);
        }

        const trigramScore = useTrigrams
          ? queryTrigrams.filter((trigram) => record.trigrams.includes(trigram))
            .length / Math.max(queryTrigrams.length, 1) * 0.25
          : 0;
        const proximity = proximityBoost(queryStems, record.stemPositions);
        const recencyBoost = Math.min(
          0.1,
          Math.max(0, (record.createdAt - (now() - 86_400_000)) / 86_400_000) *
            0.1,
        );
        const shorterChunkBoost = Math.max(
          0,
          0.08 - Math.min(record.length, 1_600) / 20_000,
        );

        const score = lexical + rrf + trigramScore + proximity + recencyBoost +
          shorterChunkBoost;
        return {
          corpusId: record.corpusId,
          corpus_ref: corpusRefFor(input.rootSessionId, record.corpusId),
          snippet: extractSnippet(
            `${record.title}\n${record.text}`,
            {
              tokens: correctedTokens,
              stems: queryStems,
              trigrams: useTrigrams ? queryTrigrams : [],
            },
          ),
          score,
        };
      }).filter((item) => item.score > 0);

      scored.sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        if (left.corpus_ref !== right.corpus_ref) {
          return left.corpus_ref.localeCompare(right.corpus_ref);
        }
        return left.snippet.localeCompare(right.snippet);
      });

      const results = scored.slice(0, SEARCH_RESULT_LIMIT).map((
        { corpusId: _corpusId, ...result },
      ) => result);
      const corpusRefs = unique(results.map((result) => result.corpus_ref));
      const matchedCorpusIds = unique(scored.map((result) => result.corpusId));
      for (const corpusId of matchedCorpusIds) {
        if (corpusId) await refreshCorpusFamily(input.rootSessionId, corpusId);
      }

      return {
        status: "ok",
        results,
        corpusRefs,
        truncated: scored.length > SEARCH_RESULT_LIMIT,
      };
    },

    async getStats(rootSessionId: string) {
      const counters = await options.redis.getHashAll(statsKey(rootSessionId));
      return {
        counters: Object.fromEntries(
          Object.entries(counters).map(([key, value]) => [key, Number(value)]),
        ),
        corpusCount: Number(counters.corpus_count ?? 0),
        artifactCount: Number(counters.artifact_count ?? 0),
        bytesSavedEstimate: Number(counters.bytes_saved_estimate ?? 0),
      };
    },

    async recordStats(
      rootSessionId: string,
      deltas: Record<string, number>,
    ) {
      await updateStats(rootSessionId, deltas);
    },

    migrateRootSessionState,
    dispose,
  };
};
