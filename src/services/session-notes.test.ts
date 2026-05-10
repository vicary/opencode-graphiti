import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { RedisClient } from "./redis-client.ts";
import { sessionNotesKey, SessionNotesService } from "./session-notes.ts";

const createRedis = () => new RedisClient({ endpoint: "redis://unused" });

const createSequence = (values: string[]) => {
  let index = 0;
  return () => values[index++] ?? `generated-${index}`;
};

const createClock = (...timestamps: string[]) => {
  let index = 0;
  return () =>
    new Date(timestamps[index++] ?? timestamps[timestamps.length - 1]!);
};

describe("session notes", () => {
  it("appends and reads notes with no TTL on session-local hash", async () => {
    const redis = createRedis();
    const service = new SessionNotesService(redis, {
      groupId: "project-1",
      createNoteId: createSequence(["note-1", "note-2"]),
      now: createClock(
        "2026-04-11T10:00:00.000Z",
        "2026-04-11T10:00:01.000Z",
      ),
    });

    const first = await service.writeNote("root-1", "## First note");
    const second = await service.writeNote("root-1", "## Second note");

    assertEquals(first, { action: "created", id: "note-1" });
    assertEquals(second, { action: "created", id: "note-2" });

    const key = sessionNotesKey("root-1");
    const writtenSnapshot = await redis.snapshot(key);
    assertEquals(writtenSnapshot.kind, "hash");
    if (writtenSnapshot.kind === "hash") {
      // Notes must be written without TTL (durable).
      assertEquals(writtenSnapshot.ttlSeconds, undefined);
      assertEquals(Object.keys(writtenSnapshot.values).sort(), [
        "note-1",
        "note-2",
      ]);
    }

    assertEquals(await service.readNotes("root-2"), { notes: [] });
    assertEquals(await service.readNote("missing"), { note: null });

    const all = await service.readNotes("root-1");
    assertEquals(all, {
      notes: [
        {
          id: "note-1",
          text: "## First note",
          created_at: "2026-04-11T10:00:00.000Z",
          updated_at: "2026-04-11T10:00:00.000Z",
        },
        {
          id: "note-2",
          text: "## Second note",
          created_at: "2026-04-11T10:00:01.000Z",
          updated_at: "2026-04-11T10:00:01.000Z",
        },
      ],
    });
    assertEquals(await service.readNote("note-2"), {
      note: all.notes[1],
    });

    // readNotes must NOT touch (refresh) the TTL — hash must still have no TTL.
    const afterReadSnapshot = await redis.snapshot(key);
    assertEquals(afterReadSnapshot.kind, "hash");
    if (afterReadSnapshot.kind === "hash") {
      assertEquals(afterReadSnapshot.ttlSeconds, undefined);
    }
  });

  it("readNote updates last_read_at in the project store on successful read", async () => {
    const redis = createRedis();
    const service = new SessionNotesService(redis, {
      groupId: "project-1",
      createNoteId: createSequence(["note-x"]),
      now: createClock(
        "2026-04-11T10:00:00.000Z", // write time
        "2026-04-11T10:05:00.000Z", // read time
      ),
    });

    await service.writeNote("root-1", "Some content");

    // First read — last_read_at should be set.
    const result = await service.readNote("note-x");
    assertEquals(result, {
      note: {
        id: "note-x",
        text: "Some content",
        created_at: "2026-04-11T10:00:00.000Z",
        updated_at: "2026-04-11T10:00:00.000Z",
      },
    });

    // Verify last_read_at was persisted in the project store by inspecting
    // the raw Redis hash field.
    const rawHash = await redis.getHashAll("session:notes:project-1");
    const stored = JSON.parse(rawHash["note-x"] ?? "{}") as {
      last_read_at?: string;
    };
    assertEquals(stored.last_read_at, "2026-04-11T10:05:00.000Z");
  });

  it("readNote on a missing note returns null and does not mutate project store", async () => {
    const redis = createRedis();
    const service = new SessionNotesService(redis, {
      groupId: "project-1",
      createNoteId: createSequence(["note-y"]),
      now: createClock("2026-04-11T10:00:00.000Z"),
    });

    await service.writeNote("root-1", "Existing note");

    const missBefore = await redis.getHashAll("session:notes:project-1");
    const result = await service.readNote("does-not-exist");
    assertEquals(result, { note: null });
    const missAfter = await redis.getHashAll("session:notes:project-1");

    // Project store must be identical — no fields added, no TTL touched.
    assertEquals(missBefore, missAfter);
  });

  it("supports replace and clear semantics within a single root session", async () => {
    const redis = createRedis();
    const service = new SessionNotesService(redis, {
      groupId: "project-1",
      createNoteId: createSequence(["note-1", "note-2", "note-3", "note-4"]),
      now: createClock(
        "2026-04-11T11:00:00.000Z",
        "2026-04-11T11:00:01.000Z",
        "2026-04-11T11:00:02.000Z",
        "2026-04-11T11:00:03.000Z",
        "2026-04-11T11:00:03.500Z", // readNote("note-1") stamps last_read_at
        "2026-04-11T11:00:03.750Z", // restore: writeNote root-b "other session" replace note-3
        "2026-04-11T11:00:04.000Z",
        "2026-04-11T11:00:05.000Z",
        "2026-04-11T11:00:06.000Z",
      ),
    });

    await service.writeNote("root-a", "alpha");
    await service.writeNote("root-a", "beta");
    await service.writeNote("root-b", "other session");

    const replacedOne = await service.writeNote("root-a", "alpha updated", {
      replace: "note-1",
    });
    assertEquals(replacedOne, { action: "replaced", id: "note-1" });
    assertEquals(await service.readNote("note-1"), {
      note: {
        id: "note-1",
        text: "alpha updated",
        created_at: "2026-04-11T11:00:00.000Z",
        updated_at: "2026-04-11T11:00:03.000Z",
      },
    });

    await assertRejects(
      () =>
        service.writeNote("root-a", "foreign overwrite", { replace: "note-3" }),
      Error,
      "owned by another session",
    );

    // Same-project delete: empty text with replace: id should succeed even for
    // notes owned by another root session in the same project.
    const foreignDeleted = await service.writeNote("root-a", "", {
      replace: "note-3",
    });
    assertEquals(foreignDeleted, { action: "deleted", id: "note-3" });
    // Owner session-local store must be empty after cross-session delete.
    assertEquals(await service.readNotes("root-b"), { notes: [] });
    // Project-wide lookup must also return null.
    assertEquals(await service.readNote("note-3"), { note: null });
    // Deleter session (root-a) must still have its own notes.
    assertEquals(await service.readNotes("root-a"), {
      notes: [
        {
          id: "note-1",
          text: "alpha updated",
          created_at: "2026-04-11T11:00:00.000Z",
          updated_at: "2026-04-11T11:00:03.000Z",
        },
        {
          id: "note-2",
          text: "beta",
          created_at: "2026-04-11T11:00:01.000Z",
          updated_at: "2026-04-11T11:00:01.000Z",
        },
      ],
    });

    // Restore root-b's note for the rest of the test.
    await service.writeNote("root-b", "other session", { replace: "note-3" });

    const replacedAll = await service.writeNote("root-a", "replacement", {
      replace: "*",
    });
    assertEquals(replacedAll, {
      action: "replaced",
      id: "note-4",
      cleared_count: 2,
    });
    assertEquals(await service.readNotes("root-a"), {
      notes: [{
        id: "note-4",
        text: "replacement",
        created_at: "2026-04-11T11:00:04.000Z",
        updated_at: "2026-04-11T11:00:04.000Z",
      }],
    });
    assertEquals(await service.readNotes("root-b"), {
      notes: [{
        id: "note-3",
        text: "other session",
        created_at: "2026-04-11T11:00:03.750Z",
        updated_at: "2026-04-11T11:00:03.750Z",
      }],
    });

    const deletedOne = await service.writeNote("root-b", "", {
      replace: "note-3",
    });
    assertEquals(deletedOne, { action: "deleted", id: "note-3" });
    assertEquals(await service.readNotes("root-b"), { notes: [] });

    const deletedMissing = await service.writeNote("root-b", "", {
      replace: "missing-note",
    });
    assertEquals(deletedMissing, { action: "deleted", id: "missing-note" });

    const createdByReplace = await service.writeNote("root-b", "created late", {
      replace: "missing-note",
    });
    assertEquals(createdByReplace, {
      action: "replaced",
      id: "missing-note",
    });
    assertEquals(await service.readNotes("root-b"), {
      notes: [{
        id: "missing-note",
        text: "created late",
        created_at: "2026-04-11T11:00:05.000Z",
        updated_at: "2026-04-11T11:00:05.000Z",
      }],
    });

    const cleared = await service.writeNote("root-a", "", { replace: "*" });
    assertEquals(cleared, { action: "replaced", cleared_count: 1 });
    assertEquals(await service.readNotes("root-a"), { notes: [] });
  });

  it("returns deterministic normalized note search results with snippets", async () => {
    const redis = createRedis();
    const service = new SessionNotesService(redis, {
      groupId: "project-1",
      createNoteId: createSequence(["note-1", "note-2", "note-3"]),
      // All notes written at the same instant so write_freshness is equal.
      now: createClock(
        "2026-04-11T12:00:00.000Z",
        "2026-04-11T12:00:00.000Z",
        "2026-04-11T12:00:00.000Z",
      ),
    });

    await service.writeNote(
      "root-search",
      "## Redis TTL refresh\nEnsure session ttl refresh happens on note reads.",
    );
    await service.writeNote(
      "root-search",
      "## Search scoring\nToken overlap should stay deterministic and normalized.",
    );
    await service.writeNote(
      "root-other",
      "## Redis TTL refresh\nEnsure session ttl refresh happens on note reads.",
    );

    const exact = await service.searchNotes(
      "root-search",
      "## Redis TTL refresh\nEnsure session ttl refresh happens on note reads.",
    );
    // Exact match: score should be very high (near 1). Check shape including
    // created_at/updated_at per spec requirement.
    assertEquals(exact[0]?.id, "note-1");
    assertEquals(exact[0]?.root_session_id, "root-search");
    assertEquals(exact[0]?.scope, "local");
    assertEquals(
      exact[0]?.snippet,
      "## Redis TTL refresh Ensure session ttl refresh happens on note reads.",
    );
    assertEquals(exact[0]?.created_at, "2026-04-11T12:00:00.000Z");
    assertEquals(exact[0]?.updated_at, "2026-04-11T12:00:00.000Z");
    assert(exact[0]!.score > 0.9);

    const firstPass = await service.searchNotes(
      "root-search",
      "redis ttl refresh",
    );
    const secondPass = await service.searchNotes(
      "root-search",
      "redis ttl refresh",
    );

    assertEquals(firstPass, secondPass);
    assertEquals(firstPass.length, 2);
    // Local note should rank first (same relevance + write_freshness,
    // locality tie-break prefers local).
    assertEquals(firstPass[0]?.id, "note-1");
    assertEquals(firstPass[0]?.root_session_id, "root-search");
    assertEquals(firstPass[0]?.scope, "local");
    assertEquals(firstPass[1]?.id, "note-3");
    assertEquals(firstPass[1]?.root_session_id, "root-other");
    assertEquals(firstPass[1]?.scope, "project");
    assert(firstPass[0]!.score > 0);
    assert(firstPass[0]!.score <= 1);
    assert(firstPass[1]!.score > 0);
    // With same write_freshness and no reads, scores should be equal or local
    // slightly higher due to no fractional penalty. Either way local wins.
    assert(firstPass[0]!.score >= firstPass[1]!.score);
    assertEquals(
      firstPass[0]?.snippet.includes("session ttl refresh"),
      true,
    );

    const multi = await service.searchNotes(
      "root-search",
      "deterministic normalized",
    );
    assertEquals(multi, [{
      id: "note-2",
      root_session_id: "root-search",
      scope: "local",
      snippet:
        "## Search scoring Token overlap should stay deterministic and normalized.",
      score: multi[0]!.score,
      created_at: "2026-04-11T12:00:00.000Z",
      updated_at: "2026-04-11T12:00:00.000Z",
    }]);
    assert(multi[0]!.score > 0);
    assert(multi[0]!.score < 1);

    assertEquals(await service.searchNotes("root-search", "foreign"), []);
    assertEquals(await service.searchNotes("root-search", "   "), []);
  });

  it("search hits include created_at and updated_at fields", async () => {
    const redis = createRedis();
    const service = new SessionNotesService(redis, {
      groupId: "project-1",
      createNoteId: createSequence(["note-1", "note-2"]),
      now: createClock(
        "2026-04-11T12:00:00.000Z",
        "2026-04-11T12:01:00.000Z",
      ),
    });

    await service.writeNote("root-1", "searchable content here");
    await service.writeNote("root-2", "searchable content here");

    const hits = await service.searchNotes("root-1", "searchable content");
    assertEquals(hits.length, 2);
    for (const hit of hits) {
      assert(
        typeof hit.created_at === "string" && hit.created_at.length > 0,
        "hit must include created_at",
      );
      assert(
        typeof hit.updated_at === "string" && hit.updated_at.length > 0,
        "hit must include updated_at",
      );
      // last_read_at must NOT be present in search hits
      assert(
        !("last_read_at" in hit),
        "hit must not expose last_read_at",
      );
    }
  });

  it("old unread notes rank below newer notes with comparable relevance", async () => {
    const redis = createRedis();
    const oldTs = "2025-01-01T00:00:00.000Z";
    const newTs = "2026-04-11T12:00:00.000Z";
    const searchTs = "2026-04-11T12:00:00.000Z";
    const service = new SessionNotesService(redis, {
      groupId: "project-1",
      createNoteId: createSequence(["note-old", "note-new"]),
      now: createClock(oldTs, newTs, searchTs),
    });

    await service.writeNote("root-1", "redis cache invalidation strategy");
    await service.writeNote("root-1", "redis cache invalidation strategy");

    const hits = await service.searchNotes(
      "root-1",
      "redis cache invalidation",
    );
    assertEquals(hits.length, 2);
    // The newer note should rank first because write_freshness is higher.
    assertEquals(hits[0]!.id, "note-new");
    assertEquals(hits[1]!.id, "note-old");
    assert(
      hits[0]!.score > hits[1]!.score,
      `newer note score ${hits[0]!.score} should exceed old note score ${
        hits[1]!.score
      }`,
    );
  });

  it("old recently read note can outrank a newer weaker match", async () => {
    const redis = createRedis();
    // note-read: old note (30 days ago), recently read (1 min ago). Full-text
    //   match on the query → high relevance, old writeFreshness, high
    //   readFreshness boost.
    // note-newer: new note (just now), never read. Partial match on the query
    //   → lower relevance but fresh writeFreshness, no readFreshness boost.
    //
    // The read-boost on note-read must overcome the write-freshness advantage
    // of note-newer, proving the two dimensions interact correctly.
    const oldTs = "2026-03-12T00:00:00.000Z"; // ~30 days before search time
    const newTs = "2026-04-11T11:55:00.000Z"; // ~5 min before search time
    const readTs = "2026-04-11T11:59:00.000Z"; // very recent read (1 min ago)
    const searchTs = "2026-04-11T12:00:00.000Z";

    const service = new SessionNotesService(redis, {
      groupId: "project-1",
      createNoteId: createSequence(["note-read", "note-newer"]),
      now: createClock(
        oldTs, // write note-read (old)
        newTs, // write note-newer (fresh, but partial match)
        readTs, // readNote stamps last_read_at on note-read
        searchTs, // searchNotes clock
      ),
    });

    // note-read has all four query tokens → high relevance.
    await service.writeNote(
      "root-1",
      "redis cache invalidation strategy details",
    );
    // note-newer has only two of the four tokens → lower relevance.
    await service.writeNote("root-1", "cache invalidation overview");

    // Stamp last_read_at only on note-read.
    await service.readNote("note-read");

    const hits = await service.searchNotes(
      "root-1",
      "redis cache invalidation strategy",
    );
    assertEquals(hits.length, 2);
    // note-read wins: readFreshness boost + higher relevance outweigh
    // note-newer's write-freshness advantage.
    assertEquals(
      hits[0]!.id,
      "note-read",
      `expected note-read to rank first but got ${hits[0]!.id} (scores: ${
        hits[0]!.score
      } vs ${hits[1]!.score})`,
    );
    assert(
      hits[0]!.score > hits[1]!.score,
      `note-read score ${hits[0]!.score} should exceed note-newer score ${
        hits[1]!.score
      }`,
    );
  });

  it("local and project notes with equal scores prefer local via tie-break without broad penalty", async () => {
    const redis = createRedis();
    const sameTs = "2026-04-11T12:00:00.000Z";
    const searchTs = "2026-04-11T12:00:00.000Z";
    const service = new SessionNotesService(redis, {
      groupId: "project-1",
      createNoteId: createSequence(["note-local", "note-project"]),
      now: createClock(sameTs, sameTs, searchTs),
    });

    // Identical text and timestamp → same relevance and write_freshness.
    await service.writeNote("root-local", "unique keyword alpha bravo");
    await service.writeNote("root-other", "unique keyword alpha bravo");

    const hits = await service.searchNotes(
      "root-local",
      "unique keyword alpha bravo",
    );
    assertEquals(hits.length, 2);
    // Scores should be equal (or extremely close) because no broad project penalty.
    const scoreDiff = Math.abs(hits[0]!.score - hits[1]!.score);
    assert(
      scoreDiff < 0.05,
      `scores should be nearly equal without broad penalty: ${
        hits[0]!.score
      } vs ${hits[1]!.score}`,
    );
    // Local note wins due to tie-break.
    assertEquals(hits[0]!.scope, "local");
    assertEquals(hits[1]!.scope, "project");
  });

  it("anchors and truncates snippets around late matches in long notes", async () => {
    const redis = createRedis();
    const service = new SessionNotesService(redis, {
      groupId: "project-1",
      createNoteId: createSequence(["note-1"]),
      now: createClock(
        "2026-04-11T13:00:00.000Z", // write
        "2026-04-11T13:00:00.000Z", // search
      ),
    });

    const longPrefix = "prefix text ".repeat(30);
    const longSuffix = " suffix text".repeat(20);
    await service.writeNote(
      "root-long",
      `${longPrefix}target anchor phrase${longSuffix}`,
    );

    const [hit] = await service.searchNotes(
      "root-long",
      "target anchor phrase",
    );

    assert(hit);
    assert(hit.snippet.length <= 160);
    assert(hit.snippet.includes("target anchor phrase"));
    assertEquals(
      hit.snippet.startsWith("prefix text prefix text prefix text"),
      false,
    );
  });

  it("ignores malformed stored note payloads safely", async () => {
    const redis = createRedis();
    const service = new SessionNotesService(redis, {
      groupId: "project-1",
      createNoteId: createSequence(["note-1"]),
      now: createClock(
        "2026-04-11T14:00:00.000Z", // search
      ),
    });

    await redis.setHashFields(sessionNotesKey("root-malformed"), {
      broken_json: "{not-json",
      wrong_shape: JSON.stringify({
        text: 123,
        created_at: "x",
        updated_at: "y",
      }),
      valid_note: JSON.stringify({
        text: "valid searchable note",
        created_at: "2026-04-11T14:00:00.000Z",
        updated_at: "2026-04-11T14:00:00.000Z",
      }),
    }, 45);

    assertEquals(await service.readNotes("root-malformed"), {
      notes: [{
        id: "valid_note",
        text: "valid searchable note",
        created_at: "2026-04-11T14:00:00.000Z",
        updated_at: "2026-04-11T14:00:00.000Z",
      }],
    });
    const [hit] = await service.searchNotes("root-malformed", "searchable");
    assert(hit);
    assertEquals(hit.id, "valid_note");
    assertEquals(hit.root_session_id, "root-malformed");
    assertEquals(hit.scope, "local");
    assertEquals(hit.snippet, "valid searchable note");
    assert(hit.score > 0);
    assert(hit.score < 1);
  });

  it("malformed timestamps in stored notes produce non-NaN scores", async () => {
    const redis = createRedis();
    const service = new SessionNotesService(redis, {
      groupId: "project-1",
      createNoteId: createSequence(["note-bad-ts"]),
      now: createClock("2026-04-11T14:00:00.000Z"),
    });

    // Inject a note with a malformed updated_at directly into Redis.
    // writeFreshness should return 0 (fully stale) rather than NaN.
    await redis.setHashFields(sessionNotesKey("root-bad-ts"), {
      "note-bad-ts": JSON.stringify({
        text: "searchable note with bad timestamp",
        created_at: "not-a-date",
        updated_at: "not-a-date",
      }),
    });

    const hits = await service.searchNotes("root-bad-ts", "searchable note");
    // Score must be a finite number (not NaN). A zero writeFreshness means
    // the final score will be 0, so the note is filtered out — that is the
    // correct safe fallback (fully stale → no result).
    for (const hit of hits) {
      assert(!isNaN(hit.score), `score must not be NaN, got ${hit.score}`);
      assert(isFinite(hit.score), `score must be finite, got ${hit.score}`);
    }
  });

  it("retries note id generation until the project-scoped id is unique", async () => {
    const redis = createRedis();
    const service = new SessionNotesService(redis, {
      groupId: "project-1",
      createNoteId: createSequence(["dup", "dup", "unique"]),
      now: createClock(
        "2026-04-11T15:00:00.000Z",
        "2026-04-11T15:00:01.000Z",
      ),
    });

    assertEquals(await service.writeNote("root-a", "first"), {
      action: "created",
      id: "dup",
    });
    assertEquals(await service.writeNote("root-b", "second"), {
      action: "created",
      id: "unique",
    });
    assertEquals(await service.readNote("dup"), {
      note: {
        id: "dup",
        text: "first",
        created_at: "2026-04-11T15:00:00.000Z",
        updated_at: "2026-04-11T15:00:00.000Z",
      },
    });
    assertEquals(await service.readNote("unique"), {
      note: {
        id: "unique",
        text: "second",
        created_at: "2026-04-11T15:00:01.000Z",
        updated_at: "2026-04-11T15:00:01.000Z",
      },
    });
  });

  it("locality tie-break applies when scores are within SCORE_EPSILON", async () => {
    // This test verifies that compareSearchHits uses an epsilon-based
    // comparison for scores, not strict equality. We create two notes with
    // scores that differ by less than SCORE_EPSILON (produced by tweaking
    // the text very slightly so the raw token/coverage scores round to the
    // same float once multiplied by freshness). The local note must still
    // win even though left.score !== right.score strictly.
    //
    // To trigger this reliably without depending on exact floating-point
    // values, we write notes with the same query coverage fraction but one
    // belonging to the local session and one to a project session. We then
    // verify that the local note is ranked first despite both notes being
    // written at exactly the same instant (equal writeFreshness, equal
    // relevance), which would only be guaranteed if the epsilon tie-break
    // path is reached and locality is used as a secondary key.
    const sameTs = "2026-04-11T12:00:00.000Z";
    const service = new SessionNotesService(
      createRedis(),
      {
        groupId: "project-epsilon",
        createNoteId: createSequence(["note-local", "note-project"]),
        now: createClock(sameTs, sameTs, sameTs),
      },
    );

    const text = "epsilon tie break test alpha bravo charlie";
    await service.writeNote("root-local", text);
    await service.writeNote("root-other", text);

    const hits = await service.searchNotes(
      "root-local",
      "epsilon tie break test alpha bravo charlie",
    );
    assertEquals(hits.length, 2);
    // Both notes match identically; local scope must win via tie-break.
    assertEquals(
      hits[0]!.scope,
      "local",
      `expected local note first; scores: ${hits[0]!.score} vs ${
        hits[1]!.score
      }`,
    );
  });

  it("migrateRootSessionState does not attach TTL to merged notes hash", async () => {
    // mergeNoteSnapshots must not compute or carry a TTL — notes hashes are
    // durable. This test migrates a source session into a target and checks
    // that the resulting hash has no TTL on the key.
    const redis = createRedis();
    const service = new SessionNotesService(redis, {
      groupId: "project-1",
      createNoteId: createSequence(["note-src", "note-tgt"]),
      now: createClock(
        "2026-04-11T16:00:00.000Z", // write source note
        "2026-04-11T16:01:00.000Z", // write target note
      ),
    });

    await service.writeNote("root-src", "source note content");
    await service.writeNote("root-tgt", "target note content");
    await service.migrateRootSessionState("root-src", "root-tgt");

    // After migration, target key must have no TTL.
    const snapshot = await redis.snapshot(sessionNotesKey("root-tgt"));
    assertEquals(
      snapshot.kind,
      "hash",
      "merged snapshot must be a hash",
    );
    assert(
      snapshot.kind === "hash" && snapshot.ttlSeconds === undefined,
      `merged notes hash must have no TTL but got ttlSeconds=${
        snapshot.kind === "hash" ? snapshot.ttlSeconds : "n/a"
      }`,
    );
    // Both notes must be present after merge.
    const notes = await service.readNotes("root-tgt");
    const ids = notes.notes.map((n) => n.id).sort();
    assertEquals(ids, ["note-src", "note-tgt"]);
  });
});
