import type { RedisClient } from "./redis-client.ts";
import type { RedisKeySnapshot } from "./redis-client.ts";

type StoredNote = {
  text: string;
  created_at: string;
  updated_at: string;
};

type StoredProjectNote = StoredNote & {
  root_session_id: string;
  last_read_at?: string | null;
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
  created_at: string;
  updated_at: string;
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
      last_read_at: typeof parsed.last_read_at === "string"
        ? parsed.last_read_at
        : null,
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

// Freshness scoring constants.
// writeFreshness half-life: ~30 days → lambda = ln(2) / (30 * 86400)
const WRITE_LAMBDA = Math.LN2 / (30 * 86400);
// readFreshness boost amplitude and half-life: ~7 days
const READ_ALPHA = 0.3;
const READ_LAMBDA = Math.LN2 / (7 * 86400);
// Scores within this tolerance are treated as equal so that locality acts as
// a deterministic tie-break rather than noise in floating-point arithmetic.
const SCORE_EPSILON = 1e-9;

const computeWriteFreshness = (updatedAt: string, nowMs: number): number => {
  const parsed = Date.parse(updatedAt);
  // Malformed timestamp → treat note as fully stale.
  if (isNaN(parsed)) return 0;
  const ageSeconds = Math.max(0, (nowMs - parsed) / 1000);
  return Math.exp(-WRITE_LAMBDA * ageSeconds);
};

const computeReadFreshness = (
  lastReadAt: string | null | undefined,
  nowMs: number,
): number => {
  // No read stamp → neutral multiplier (no boost, no penalty).
  if (!lastReadAt) return 1;
  const parsed = Date.parse(lastReadAt);
  // Malformed read timestamp → treat as never read (neutral).
  if (isNaN(parsed)) return 1;
  const ageSeconds = Math.max(0, (nowMs - parsed) / 1000);
  return Math.min(
    1 + READ_ALPHA,
    1 + READ_ALPHA * Math.exp(-READ_LAMBDA * ageSeconds),
  );
};

const compareSearchHits = (
  left: SessionNoteSearchHit,
  right: SessionNoteSearchHit,
): number => {
  // Higher score wins; treat scores within SCORE_EPSILON as equal so that
  // locality acts as a deterministic tie-break rather than floating-point noise.
  if (Math.abs(right.score - left.score) > SCORE_EPSILON) {
    return right.score - left.score;
  }
  // Tie-break: prefer local scope.
  const leftLocal = left.scope === "local" ? 0 : 1;
  const rightLocal = right.scope === "local" ? 0 : 1;
  if (leftLocal !== rightLocal) return leftLocal - rightLocal;
  // Tie-break: newer updated_at.
  if (right.updated_at !== left.updated_at) {
    return right.updated_at.localeCompare(left.updated_at);
  }
  // Stable fallback.
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

      // Empty text = delete. Allow cross-session deletes within the same project.
      if (text === "") {
        if (!projectNote) {
          const deleted = notes.delete(replace);
          if (deleted) {
            await this.writeNotesHash(rootSessionId, notes);
          }
          return { action: "deleted", id: replace };
        }

        // Delete from the owning session's local store.
        const ownerSessionId = projectNote.root_session_id;
        const ownerNotes = ownerSessionId === rootSessionId
          ? notes
          : await this.loadNotes(ownerSessionId);
        await this.deleteOwnedNote(
          ownerSessionId,
          replace,
          ownerNotes,
          projectNotes,
        );
        return { action: "deleted", id: replace };
      }

      // Non-empty replace: ownership check still applies.
      if (projectNote && projectNote.root_session_id !== rootSessionId) {
        throw new Error(`Note ${replace} is owned by another session`);
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
    const notes = [...(await this.loadNotes(rootSessionId)).entries()]
      .map(([id, note]) => ({ id, ...note }))
      .sort(compareNotes);

    if (!noteId) return { notes };
    return { notes: notes.filter((note) => note.id === noteId) };
  }

  async readNote(noteId: string): Promise<{ note: SessionNote | null }> {
    const projectNotes = await this.loadProjectNotes();
    const note = projectNotes.get(noteId);
    if (!note) return { note: null };

    // Stamp last_read_at in the project store without modifying other fields.
    await this.writeSingleProjectNote(noteId, {
      ...note,
      last_read_at: this.now().toISOString(),
    });

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

    const nowMs = this.now().getTime();

    const localNotes = (await this.readNotes(rootSessionId)).notes;
    const allProjectNotes = await this.loadProjectNotes();
    const projectNoteEntries = [...allProjectNotes.entries()]
      .filter(([, note]) => note.root_session_id !== rootSessionId);

    const localHits: SessionNoteSearchHit[] = localNotes.map((note) => {
      const relevance = scoreNote(note.text, normalizedQuery);
      const writeFreshness = computeWriteFreshness(note.updated_at, nowMs);
      // Consult project store for last_read_at even for local notes.
      const projectNote = allProjectNotes.get(note.id);
      const readFreshness = computeReadFreshness(
        projectNote?.last_read_at,
        nowMs,
      );
      // Multiplicative model: relevance gates the score while write/read
      // freshness modulate it (write decays with age; read boosts recently
      // revisited notes up to 1 + READ_ALPHA).
      return {
        id: note.id,
        root_session_id: rootSessionId,
        scope: "local" as const,
        snippet: buildSnippet(note.text, normalizedQuery),
        score: clampScore(relevance * writeFreshness * readFreshness),
        created_at: note.created_at,
        updated_at: note.updated_at,
      };
    });

    const projectHits: SessionNoteSearchHit[] = projectNoteEntries.map(
      ([id, note]) => {
        const relevance = scoreNote(note.text, normalizedQuery);
        const writeFreshness = computeWriteFreshness(note.updated_at, nowMs);
        const readFreshness = computeReadFreshness(note.last_read_at, nowMs);
        return {
          id,
          root_session_id: note.root_session_id,
          scope: "project" as const,
          snippet: buildSnippet(note.text, normalizedQuery),
          score: clampScore(relevance * writeFreshness * readFreshness),
          created_at: note.created_at,
          updated_at: note.updated_at,
        };
      },
    );

    return [...localHits, ...projectHits]
      .filter((note) => note.score > 0)
      .sort(compareSearchHits);
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

  // Notes hashes are durable — no TTL is ever applied.
  return {
    kind: "hash",
    values: {
      ...(target.kind === "hash" ? target.values : {}),
      ...source.values,
    },
  };
};
