import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
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
  it("appends and reads notes while refreshing the session TTL", async () => {
    const redis = createRedis();
    const service = new SessionNotesService(redis, {
      sessionTtlSeconds: 60,
      createNoteId: createSequence(["note-1", "note-2"]),
      now: createClock(
        "2026-04-11T10:00:00.000Z",
        "2026-04-11T10:00:01.000Z",
      ),
    });

    const first = await service.writeNote("root-1", "## First note");
    const second = await service.writeNote("root-1", "## Second note");

    assertEquals(first, { action: "created", note_id: "note-1" });
    assertEquals(second, { action: "created", note_id: "note-2" });

    const key = sessionNotesKey("root-1");
    const writtenSnapshot = await redis.snapshot(key);
    assertEquals(writtenSnapshot.kind, "hash");
    if (writtenSnapshot.kind === "hash") {
      assertEquals(writtenSnapshot.ttlSeconds, 60);
      assertEquals(Object.keys(writtenSnapshot.values).sort(), [
        "note-1",
        "note-2",
      ]);
    }

    await redis.touch(key, 5);
    const touchedSnapshot = await redis.snapshot(key);
    assertEquals(touchedSnapshot.kind, "hash");
    if (touchedSnapshot.kind === "hash") {
      assertEquals(touchedSnapshot.ttlSeconds, 5);
    }

    assertEquals(await service.readNotes("root-2"), { notes: [] });
    assertEquals(await service.readNotes("root-1", "missing"), { notes: [] });

    const all = await service.readNotes("root-1");
    assertEquals(all, {
      notes: [
        {
          note_id: "note-1",
          text: "## First note",
          created_at: "2026-04-11T10:00:00.000Z",
          updated_at: "2026-04-11T10:00:00.000Z",
        },
        {
          note_id: "note-2",
          text: "## Second note",
          created_at: "2026-04-11T10:00:01.000Z",
          updated_at: "2026-04-11T10:00:01.000Z",
        },
      ],
    });
    assertEquals(await service.readNotes("root-1", "note-2"), {
      notes: [all.notes[1]],
    });

    const refreshedSnapshot = await redis.snapshot(key);
    assertEquals(refreshedSnapshot.kind, "hash");
    if (refreshedSnapshot.kind === "hash") {
      assertEquals(refreshedSnapshot.ttlSeconds, 60);
    }
  });

  it("supports replace and clear semantics within a single root session", async () => {
    const redis = createRedis();
    const service = new SessionNotesService(redis, {
      sessionTtlSeconds: 120,
      createNoteId: createSequence(["note-1", "note-2", "note-3", "note-4"]),
      now: createClock(
        "2026-04-11T11:00:00.000Z",
        "2026-04-11T11:00:01.000Z",
        "2026-04-11T11:00:02.000Z",
        "2026-04-11T11:00:03.000Z",
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
    assertEquals(replacedOne, { action: "replaced", note_id: "note-1" });
    assertEquals(await service.readNotes("root-a", "note-1"), {
      notes: [{
        note_id: "note-1",
        text: "alpha updated",
        created_at: "2026-04-11T11:00:00.000Z",
        updated_at: "2026-04-11T11:00:03.000Z",
      }],
    });

    const replacedAll = await service.writeNote("root-a", "replacement", {
      replace: "*",
    });
    assertEquals(replacedAll, {
      action: "replaced",
      note_id: "note-4",
      cleared_count: 2,
    });
    assertEquals(await service.readNotes("root-a"), {
      notes: [{
        note_id: "note-4",
        text: "replacement",
        created_at: "2026-04-11T11:00:04.000Z",
        updated_at: "2026-04-11T11:00:04.000Z",
      }],
    });
    assertEquals(await service.readNotes("root-b"), {
      notes: [{
        note_id: "note-3",
        text: "other session",
        created_at: "2026-04-11T11:00:02.000Z",
        updated_at: "2026-04-11T11:00:02.000Z",
      }],
    });

    const deletedOne = await service.writeNote("root-b", "", {
      replace: "note-3",
    });
    assertEquals(deletedOne, { action: "deleted", note_id: "note-3" });
    assertEquals(await service.readNotes("root-b"), { notes: [] });

    const createdByReplace = await service.writeNote("root-b", "created late", {
      replace: "missing-note",
    });
    assertEquals(createdByReplace, {
      action: "replaced",
      note_id: "missing-note",
    });
    assertEquals(await service.readNotes("root-b"), {
      notes: [{
        note_id: "missing-note",
        text: "created late",
        created_at: "2026-04-11T11:00:06.000Z",
        updated_at: "2026-04-11T11:00:06.000Z",
      }],
    });

    const cleared = await service.writeNote("root-a", "", { replace: "*" });
    assertEquals(cleared, { action: "replaced", cleared_count: 1 });
    assertEquals(await service.readNotes("root-a"), { notes: [] });
  });

  it("returns deterministic normalized note search results with snippets", async () => {
    const redis = createRedis();
    const service = new SessionNotesService(redis, {
      sessionTtlSeconds: 90,
      createNoteId: createSequence(["note-1", "note-2", "note-3"]),
      now: createClock(
        "2026-04-11T12:00:00.000Z",
        "2026-04-11T12:00:01.000Z",
        "2026-04-11T12:00:02.000Z",
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
    await service.writeNote("root-other", "## Foreign note\nredis ttl refresh");

    const exact = await service.searchNotes(
      "root-search",
      "## Redis TTL refresh\nEnsure session ttl refresh happens on note reads.",
    );
    assertEquals(exact[0], {
      note_id: "note-1",
      snippet:
        "## Redis TTL refresh Ensure session ttl refresh happens on note reads.",
      score: 1,
    });

    const firstPass = await service.searchNotes(
      "root-search",
      "redis ttl refresh",
    );
    const secondPass = await service.searchNotes(
      "root-search",
      "redis ttl refresh",
    );

    assertEquals(firstPass, secondPass);
    assertEquals(firstPass.length, 1);
    assertEquals(firstPass[0]?.note_id, "note-1");
    assert(firstPass[0]!.score > 0);
    assert(firstPass[0]!.score <= 1);
    assertEquals(
      firstPass[0]?.snippet.includes("session ttl refresh"),
      true,
    );

    const multi = await service.searchNotes(
      "root-search",
      "deterministic normalized",
    );
    assertEquals(multi, [{
      note_id: "note-2",
      snippet:
        "## Search scoring Token overlap should stay deterministic and normalized.",
      score: multi[0]!.score,
    }]);
    assert(multi[0]!.score > 0);
    assert(multi[0]!.score < 1);

    assertEquals(await service.searchNotes("root-search", "foreign"), []);
    assertEquals(await service.searchNotes("root-search", "   "), []);
  });

  it("anchors and truncates snippets around late matches in long notes", async () => {
    const redis = createRedis();
    const service = new SessionNotesService(redis, {
      sessionTtlSeconds: 90,
      createNoteId: createSequence(["note-1"]),
      now: createClock("2026-04-11T13:00:00.000Z"),
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
      sessionTtlSeconds: 45,
      createNoteId: createSequence(["note-1"]),
      now: createClock("2026-04-11T14:00:00.000Z"),
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
        note_id: "valid_note",
        text: "valid searchable note",
        created_at: "2026-04-11T14:00:00.000Z",
        updated_at: "2026-04-11T14:00:00.000Z",
      }],
    });
    const [hit] = await service.searchNotes("root-malformed", "searchable");
    assert(hit);
    assertEquals(hit.note_id, "valid_note");
    assertEquals(hit.snippet, "valid searchable note");
    assert(hit.score > 0);
    assert(hit.score < 1);
  });
});
