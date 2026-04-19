import type { RedisClient } from "./redis-client.ts";
import type { RedisKeySnapshot } from "./redis-client.ts";

type StoredNote = {
  text: string;
  created_at: string;
  updated_at: string;
};

type StoredProjectNote = StoredNote & {
  root_session_id: string;
};

export type SessionNote = StoredNote & {
  id: string;
};

export type SessionNoteSearchHit = {
  id: string;
  root_session_id: string;
  scope: "local" | "project";
  snippet: string;
  score: number;
};

export type WriteNoteResult =
  | { action: "created"; id: string }
  | { action: "replaced"; id: string }
  | { action: "deleted"; id: string }
  | { action: "replaced"; id: string; cleared_count: number }
  | { action: "replaced"; cleared_count: number };

export const sessionNotesKey = (rootSessionId: string): string =>
  `session:${rootSessionId}:notes`;

const projectNotesKey = (groupId: string): string => `session:notes:${groupId}`;

type SessionNotesServiceOptions = {
  groupId: string;
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

const parseStoredProjectNote = (value: string): StoredProjectNote | null => {
  try {
    const parsed = JSON.parse(value) as Partial<StoredProjectNote> & {
      rootSessionId?: string;
    };
    if (
      typeof parsed.text !== "string" ||
      typeof parsed.created_at !== "string" ||
      typeof parsed.updated_at !== "string"
    ) {
      return null;
    }

    const rootSessionId = typeof parsed.root_session_id === "string"
      ? parsed.root_session_id
      : typeof parsed.rootSessionId === "string"
      ? parsed.rootSessionId
      : null;
    if (!rootSessionId) return null;

    return {
      text: parsed.text,
      created_at: parsed.created_at,
      updated_at: parsed.updated_at,
      root_session_id: rootSessionId,
    };
  } catch {
    return null;
  }
};

const compareNotes = (left: SessionNote, right: SessionNote): number => {
  if (left.created_at !== right.created_at) {
    return left.created_at.localeCompare(right.created_at);
  }
  return left.id.localeCompare(right.id);
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
  return left.id.localeCompare(right.id);
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
  private readonly groupId: string;

  constructor(
    private readonly redis: RedisClient,
    private readonly options: SessionNotesServiceOptions,
  ) {
    this.groupId = options.groupId;
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

  private async loadProjectNotes(): Promise<Map<string, StoredProjectNote>> {
    const raw = await this.redis.getHashAll(projectNotesKey(this.groupId));
    return new Map(
      Object.entries(raw).flatMap(([noteId, value]) => {
        const parsed = parseStoredProjectNote(value);
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

  private async writeProjectNotesHash(
    notes: ReadonlyMap<string, StoredProjectNote>,
  ): Promise<void> {
    const key = projectNotesKey(this.groupId);
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
    );
  }

  private async writeSingleProjectNote(
    noteId: string,
    note: StoredProjectNote,
  ): Promise<void> {
    await this.redis.setHashFields(projectNotesKey(this.groupId), {
      [noteId]: JSON.stringify(note),
    });
  }

  private createUniqueNoteId(
    projectNotes: ReadonlyMap<string, StoredProjectNote>,
  ): string {
    while (true) {
      const noteId = this.createNoteId();
      if (!projectNotes.has(noteId)) return noteId;
    }
  }

  private async deleteOwnedNote(
    rootSessionId: string,
    noteId: string,
    sessionNotes: Map<string, StoredNote>,
    projectNotes: Map<string, StoredProjectNote>,
  ): Promise<void> {
    sessionNotes.delete(noteId);
    projectNotes.delete(noteId);
    await this.writeNotesHash(rootSessionId, sessionNotes);
    await this.writeProjectNotesHash(projectNotes);
  }

  async writeNote(
    rootSessionId: string,
    text: string,
    options?: { replace?: string },
  ): Promise<WriteNoteResult> {
    const replace = options?.replace;
    const notes = await this.loadNotes(rootSessionId);
    const projectNotes = await this.loadProjectNotes();

    if (replace === "*") {
      const clearedCount = notes.size;
      const remainingProjectNotes = new Map(projectNotes);
      for (const noteId of notes.keys()) {
        const projectNote = remainingProjectNotes.get(noteId);
        if (projectNote?.root_session_id === rootSessionId) {
          remainingProjectNotes.delete(noteId);
        }
      }

      if (text === "") {
        await this.redis.deleteKey(sessionNotesKey(rootSessionId));
        await this.writeProjectNotesHash(remainingProjectNotes);
        return { action: "replaced", cleared_count: clearedCount };
      }

      const timestamp = this.now().toISOString();
      const noteId = this.createUniqueNoteId(remainingProjectNotes);
      const note = {
        text,
        created_at: timestamp,
        updated_at: timestamp,
      };
      await this.writeNotesHash(
        rootSessionId,
        new Map([[noteId, note]]),
      );
      remainingProjectNotes.set(noteId, {
        ...note,
        root_session_id: rootSessionId,
      });
      await this.writeProjectNotesHash(remainingProjectNotes);
      return {
        action: "replaced",
        id: noteId,
        cleared_count: clearedCount,
      };
    }

    if (replace) {
      const projectNote = projectNotes.get(replace);
      if (projectNote && projectNote.root_session_id !== rootSessionId) {
        throw new Error(`Note ${replace} is owned by another session`);
      }

      if (text === "") {
        if (!projectNote) {
          notes.delete(replace);
          await this.writeNotesHash(rootSessionId, notes);
          return { action: "deleted", id: replace };
        }

        await this.deleteOwnedNote(rootSessionId, replace, notes, projectNotes);
        return { action: "deleted", id: replace };
      }

      const timestamp = this.now().toISOString();
      const current = notes.get(replace) ?? projectNote;
      const note = {
        text,
        created_at: current?.created_at ?? timestamp,
        updated_at: timestamp,
      };
      await this.writeSingleNote(rootSessionId, replace, note);
      await this.writeSingleProjectNote(replace, {
        ...note,
        root_session_id: rootSessionId,
      });
      return { action: "replaced", id: replace };
    }

    const timestamp = this.now().toISOString();
    const noteId = this.createUniqueNoteId(projectNotes);
    const note = {
      text,
      created_at: timestamp,
      updated_at: timestamp,
    };
    await this.writeSingleNote(rootSessionId, noteId, note);
    await this.writeSingleProjectNote(noteId, {
      ...note,
      root_session_id: rootSessionId,
    });
    return { action: "created", id: noteId };
  }

  async readNotes(
    rootSessionId: string,
    noteId?: string,
  ): Promise<{ notes: SessionNote[] }> {
    const key = sessionNotesKey(rootSessionId);
    const notes = [...(await this.loadNotes(rootSessionId)).entries()]
      .map(([id, note]) => ({ id, ...note }))
      .sort(compareNotes);

    if (notes.length > 0) {
      await this.redis.touch(key, this.options.sessionTtlSeconds);
    }

    if (!noteId) return { notes };
    return { notes: notes.filter((note) => note.id === noteId) };
  }

  async readNote(noteId: string): Promise<{ note: SessionNote | null }> {
    const note = (await this.loadProjectNotes()).get(noteId);
    if (!note) return { note: null };
    return {
      note: {
        id: noteId,
        text: note.text,
        created_at: note.created_at,
        updated_at: note.updated_at,
      },
    };
  }

  async searchNotes(
    rootSessionId: string,
    query: string,
  ): Promise<SessionNoteSearchHit[]> {
    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery) return [];

    const localNotes = (await this.readNotes(rootSessionId)).notes;
    const projectNotes = [...(await this.loadProjectNotes()).entries()]
      .filter(([, note]) => note.root_session_id !== rootSessionId)
      .map(([id, note]) => ({
        id,
        root_session_id: note.root_session_id,
        scope: "project" as const,
        snippet: buildSnippet(note.text, normalizedQuery),
        score: clampScore(scoreNote(note.text, normalizedQuery) * 0.85),
        created_at: note.created_at,
        updated_at: note.updated_at,
      }));

    return [
      ...localNotes.map((note) => ({
        id: note.id,
        root_session_id: rootSessionId,
        scope: "local" as const,
        snippet: buildSnippet(note.text, normalizedQuery),
        score: scoreNote(note.text, normalizedQuery),
        created_at: note.created_at,
        updated_at: note.updated_at,
      })),
      ...projectNotes,
    ]
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

    const projectNotes = await this.loadProjectNotes();
    let changed = false;
    for (const [noteId, note] of projectNotes.entries()) {
      if (note.root_session_id !== sourceRootSessionId) continue;
      projectNotes.set(noteId, {
        ...note,
        root_session_id: targetRootSessionId,
      });
      changed = true;
    }
    if (changed) {
      await this.writeProjectNotesHash(projectNotes);
    }
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
