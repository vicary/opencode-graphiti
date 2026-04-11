import type { RedisClient } from "./redis-client.ts";
import type { RedisKeySnapshot } from "./redis-client.ts";

type StoredNote = {
  text: string;
  created_at: string;
  updated_at: string;
};

export type SessionNote = StoredNote & {
  note_id: string;
};

export type SessionNoteSearchHit = {
  note_id: string;
  snippet: string;
  score: number;
};

export type WriteNoteResult =
  | { action: "created"; note_id: string }
  | { action: "replaced"; note_id: string }
  | { action: "deleted"; note_id: string }
  | { action: "replaced"; note_id: string; cleared_count: number }
  | { action: "replaced"; cleared_count: number };

export const sessionNotesKey = (rootSessionId: string): string =>
  `session:${rootSessionId}:notes`;

type SessionNotesServiceOptions = {
  sessionTtlSeconds: number;
  now?: () => Date;
  createNoteId?: () => string;
};

const TOKEN_PATTERN = /[a-z0-9]{2,}/g;
const SNIPPET_LIMIT = 160;

const normalizeText = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const tokenize = (value: string): string[] =>
  normalizeText(value).toLowerCase().match(TOKEN_PATTERN) ?? [];

const clampScore = (value: number): number =>
  Math.max(0, Math.min(1, Number(value.toFixed(6))));

const parseStoredNote = (value: string): StoredNote | null => {
  try {
    const parsed = JSON.parse(value) as Partial<StoredNote>;
    if (
      typeof parsed.text !== "string" ||
      typeof parsed.created_at !== "string" ||
      typeof parsed.updated_at !== "string"
    ) {
      return null;
    }
    return {
      text: parsed.text,
      created_at: parsed.created_at,
      updated_at: parsed.updated_at,
    };
  } catch {
    return null;
  }
};

const compareNotes = (left: SessionNote, right: SessionNote): number => {
  if (left.created_at !== right.created_at) {
    return left.created_at.localeCompare(right.created_at);
  }
  return left.note_id.localeCompare(right.note_id);
};

const compareSearchHits = (
  left: SessionNoteSearchHit & { created_at: string; updated_at: string },
  right: SessionNoteSearchHit & { created_at: string; updated_at: string },
): number => {
  if (right.score !== left.score) return right.score - left.score;
  if (right.updated_at !== left.updated_at) {
    return right.updated_at.localeCompare(left.updated_at);
  }
  if (right.created_at !== left.created_at) {
    return right.created_at.localeCompare(left.created_at);
  }
  return left.note_id.localeCompare(right.note_id);
};

const buildSnippet = (text: string, query: string): string => {
  const normalizedText = normalizeText(text);
  if (normalizedText.length <= SNIPPET_LIMIT) return normalizedText;

  const lowerText = normalizedText.toLowerCase();
  const lowerQuery = normalizeText(query).toLowerCase();
  const queryIndex = lowerQuery ? lowerText.indexOf(lowerQuery) : -1;
  const tokenIndex = tokenize(query)
    .map((token) => lowerText.indexOf(token))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? -1;
  const anchor = queryIndex >= 0 ? queryIndex : Math.max(tokenIndex, 0);
  const start = Math.max(anchor - 40, 0);
  return normalizedText.slice(start, start + SNIPPET_LIMIT).trim();
};

const scoreNote = (text: string, query: string): number => {
  const normalizedText = normalizeText(text).toLowerCase();
  const normalizedQuery = normalizeText(query).toLowerCase();
  if (!normalizedQuery) return 0;
  if (normalizedText === normalizedQuery) return 1;

  const queryTokens = [...new Set(tokenize(normalizedQuery))];
  if (queryTokens.length === 0) {
    if (!normalizedText.includes(normalizedQuery)) return 0;
    return clampScore(
      Math.min(0.99, 0.8 + normalizedQuery.length / normalizedText.length / 5),
    );
  }

  const matchedTokens = queryTokens.filter((token) =>
    normalizedText.includes(token)
  );
  if (matchedTokens.length === 0) return 0;

  const coverage = matchedTokens.length / queryTokens.length;
  const contiguousBonus = normalizedText.includes(normalizedQuery) ? 0.2 : 0;
  const lengthRatio = Math.min(
    normalizedQuery.length / Math.max(normalizedText.length, 1),
    1,
  );
  return clampScore(
    Math.min(
      0.99,
      0.15 + coverage * 0.55 + contiguousBonus + lengthRatio * 0.1,
    ),
  );
};

export class SessionNotesService {
  private readonly now: () => Date;
  private readonly createNoteId: () => string;

  constructor(
    private readonly redis: RedisClient,
    private readonly options: SessionNotesServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.createNoteId = options.createNoteId ?? (() => crypto.randomUUID());
  }

  private async loadNotes(
    rootSessionId: string,
  ): Promise<Map<string, StoredNote>> {
    const raw = await this.redis.getHashAll(sessionNotesKey(rootSessionId));
    return new Map(
      Object.entries(raw).flatMap(([noteId, value]) => {
        const parsed = parseStoredNote(value);
        return parsed ? [[noteId, parsed] as const] : [];
      }),
    );
  }

  private async writeNotesHash(
    rootSessionId: string,
    notes: ReadonlyMap<string, StoredNote>,
  ): Promise<void> {
    const key = sessionNotesKey(rootSessionId);
    if (notes.size === 0) {
      await this.redis.deleteKey(key);
      return;
    }

    await this.redis.deleteKey(key);
    await this.redis.setHashFields(
      key,
      Object.fromEntries(
        [...notes.entries()].map((
          [noteId, note],
        ) => [noteId, JSON.stringify(note)]),
      ),
      this.options.sessionTtlSeconds,
    );
  }

  private async writeSingleNote(
    rootSessionId: string,
    noteId: string,
    note: StoredNote,
  ): Promise<void> {
    await this.redis.setHashFields(
      sessionNotesKey(rootSessionId),
      { [noteId]: JSON.stringify(note) },
      this.options.sessionTtlSeconds,
    );
  }

  async writeNote(
    rootSessionId: string,
    text: string,
    options?: { replace?: string },
  ): Promise<WriteNoteResult> {
    const replace = options?.replace;
    const notes = await this.loadNotes(rootSessionId);
    const timestamp = this.now().toISOString();

    if (replace === "*") {
      const clearedCount = notes.size;
      if (text === "") {
        await this.redis.deleteKey(sessionNotesKey(rootSessionId));
        return { action: "replaced", cleared_count: clearedCount };
      }

      const noteId = this.createNoteId();
      await this.writeNotesHash(
        rootSessionId,
        new Map([[noteId, {
          text,
          created_at: timestamp,
          updated_at: timestamp,
        }]]),
      );
      return {
        action: "replaced",
        note_id: noteId,
        cleared_count: clearedCount,
      };
    }

    if (replace) {
      if (text === "") {
        notes.delete(replace);
        // Field removal is not exposed by RedisClient yet, so deleting a single
        // note still requires rewriting the remaining hash contents.
        await this.writeNotesHash(rootSessionId, notes);
        return { action: "deleted", note_id: replace };
      }

      const current = notes.get(replace);
      const note = {
        text,
        created_at: current?.created_at ?? timestamp,
        updated_at: timestamp,
      };
      await this.writeSingleNote(rootSessionId, replace, note);
      return { action: "replaced", note_id: replace };
    }

    const noteId = this.createNoteId();
    const note = {
      text,
      created_at: timestamp,
      updated_at: timestamp,
    };
    await this.writeSingleNote(rootSessionId, noteId, note);
    return { action: "created", note_id: noteId };
  }

  async readNotes(
    rootSessionId: string,
    noteId?: string,
  ): Promise<{ notes: SessionNote[] }> {
    const key = sessionNotesKey(rootSessionId);
    const notes = [...(await this.loadNotes(rootSessionId)).entries()]
      .map(([id, note]) => ({ note_id: id, ...note }))
      .sort(compareNotes);

    if (notes.length > 0) {
      await this.redis.touch(key, this.options.sessionTtlSeconds);
    }

    if (!noteId) return { notes };
    return { notes: notes.filter((note) => note.note_id === noteId) };
  }

  async searchNotes(
    rootSessionId: string,
    query: string,
  ): Promise<SessionNoteSearchHit[]> {
    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery) return [];

    const notes = await this.readNotes(rootSessionId);
    return notes.notes
      .map((note) => ({
        note_id: note.note_id,
        snippet: buildSnippet(note.text, normalizedQuery),
        score: scoreNote(note.text, normalizedQuery),
        created_at: note.created_at,
        updated_at: note.updated_at,
      }))
      .filter((note) => note.score > 0)
      .sort(compareSearchHits)
      .map(({ created_at: _createdAt, updated_at: _updatedAt, ...hit }) => hit);
  }

  async migrateRootSessionState(
    sourceRootSessionId: string,
    targetRootSessionId: string,
  ): Promise<void> {
    if (sourceRootSessionId === targetRootSessionId) return;

    const sourceKey = sessionNotesKey(sourceRootSessionId);
    const targetKey = sessionNotesKey(targetRootSessionId);
    const sourceSnapshot = await this.redis.snapshot(sourceKey);
    if (sourceSnapshot.kind === "missing") return;

    const targetSnapshot = await this.redis.snapshot(targetKey);
    const mergedSnapshot = mergeNoteSnapshots(targetSnapshot, sourceSnapshot);
    await this.redis.restoreSnapshot(targetKey, mergedSnapshot);
    await this.redis.deleteKey(sourceKey);
  }
}

const mergeNoteSnapshots = (
  target: RedisKeySnapshot,
  source: RedisKeySnapshot,
): RedisKeySnapshot => {
  if (source.kind === "missing") return target;
  if (source.kind !== "hash") {
    throw new Error("Expected hash snapshot for source session notes");
  }
  if (target.kind !== "missing" && target.kind !== "hash") {
    throw new Error("Expected hash snapshot for target session notes");
  }

  return {
    kind: "hash",
    values: {
      ...(target.kind === "hash" ? target.values : {}),
      ...source.values,
    },
    ttlSeconds: Math.max(
      target.kind === "hash" ? target.ttlSeconds ?? 0 : 0,
      source.ttlSeconds ?? 0,
    ) || undefined,
  };
};
