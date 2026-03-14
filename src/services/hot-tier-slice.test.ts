import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { createChatHandler } from "../handlers/chat.ts";
import { createCompactingHandler } from "../handlers/compacting.ts";
import { createMessagesHandler } from "../handlers/messages.ts";
import { SessionManager } from "../session.ts";
import { BatchDrainService } from "./batch-drain.ts";
import { RedisCacheService } from "./redis-cache.ts";
import { RedisClient } from "./redis-client.ts";
import { RedisEventsService } from "./redis-events.ts";
import { RedisSnapshotService } from "./redis-snapshot.ts";

describe("hot-tier vertical slice", () => {
  it("records local state, prepares injection, transforms messages, and serves compaction context without live MCP", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 300,
    });
    const redisSnapshot = new RedisSnapshotService(redis, { ttlSeconds: 600 });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });
    await redisCache.set("group-1", {
      query: "Continue the overhaul",
      refreshedAt: Date.now(),
      facts: [{ uuid: "fact-1", fact: "Graphiti remains async" }],
      nodes: [{ uuid: "node-1", name: "ContextOverhaul" }],
      factUuids: ["fact-1"],
      nodeRefs: ["node-1"],
    });

    const manager = new SessionManager(
      "group-1",
      "user-1",
      { session: { get: () => ({ parentID: null }) } } as never,
      redisEvents,
      redisSnapshot,
      redisCache,
    );
    manager.setParentId("session-1", null);
    manager.setState(
      "session-1",
      manager.createDefaultState("group-1", "user-1"),
    );

    const graphitiAsync = {
      scheduleCacheRefresh() {},
      scheduleDrain() {},
    };

    const chat = createChatHandler({
      sessionManager: manager,
      redisEvents,
      graphitiAsync: graphitiAsync as never,
      drainTriggerSize: 99,
    });
    const transform = createMessagesHandler({ sessionManager: manager });
    const compacting = createCompactingHandler({ sessionManager: manager });

    await chat(
      { sessionID: "session-1" } as never,
      {
        parts: [{
          type: "text",
          text: "Please keep Graphiti off the hot path",
        }],
      } as never,
    );

    const transformOutput = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{
          type: "text",
          text: "Please keep Graphiti off the hot path",
        }],
      }],
    };
    await transform(
      { message: "Please keep Graphiti off the hot path" } as never,
      transformOutput as never,
    );

    assertStringIncludes(
      transformOutput.messages[0].parts[0].text,
      "<session_memory",
    );
    assertStringIncludes(
      transformOutput.messages[0].parts[0].text,
      "<persistent_memory",
    );

    const events = await redisEvents.getRecentSessionEvents(
      "session-1",
      10,
      true,
    );
    const snapshot = await redisSnapshot.rebuildAndSave("session-1", events);
    assertStringIncludes(snapshot, "<decisions>");

    const compactOutput = { context: [] as string[] };
    await compacting(
      { sessionID: "session-1" } as never,
      compactOutput as never,
    );
    assertEquals(compactOutput.context.length, 1);
    assertStringIncludes(compactOutput.context[0], "<session_memory");
  });

  it("recalls older relevant Redis events into injection while still scheduling async refresh", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 300,
    });
    const redisSnapshot = new RedisSnapshotService(redis, { ttlSeconds: 600 });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    const manager = new SessionManager(
      "group-1",
      "user-1",
      { session: { get: () => ({ parentID: null }) } } as never,
      redisEvents,
      redisSnapshot,
      redisCache,
    );
    manager.setParentId("session-1", null);
    manager.setState(
      "session-1",
      manager.createDefaultState("group-1", "user-1"),
    );

    await redisEvents.recordEvent("session-1", "group-1", {
      id: "older-decision",
      ts: Date.now() - 60_000,
      category: "decision",
      priority: 0,
      role: "user",
      summary: "Use deterministic merge behavior for recall",
      continuityText:
        "Use deterministic merge behavior for recall when injecting session memory",
    });

    for (let index = 0; index < 25; index += 1) {
      await redisEvents.recordEvent("session-1", "group-1", {
        id: `recent-${index}`,
        ts: Date.now() - 1_000 + index,
        category: "message",
        priority: 4,
        role: "assistant",
        summary: `Recent unrelated event ${index}`,
        continuityText: `Recent unrelated event ${index}`,
      });
    }

    const refreshCalls: Array<{ groupId: string; query: string }> = [];
    const graphitiAsync = {
      scheduleCacheRefresh(groupId: string, query: string) {
        refreshCalls.push({ groupId, query });
      },
      scheduleDrain() {},
    };

    const chat = createChatHandler({
      sessionManager: manager,
      redisEvents,
      graphitiAsync: graphitiAsync as never,
      drainTriggerSize: 999,
    });
    const transform = createMessagesHandler({ sessionManager: manager });

    await chat(
      { sessionID: "session-1" } as never,
      {
        parts: [{
          type: "text",
          text: "Can you revisit deterministic merge behavior for recall?",
        }],
      } as never,
    );

    const transformOutput = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{
          type: "text",
          text: "Can you revisit deterministic merge behavior for recall?",
        }],
      }],
    };
    await transform(
      {
        message: "Can you revisit deterministic merge behavior for recall?",
      } as never,
      transformOutput as never,
    );

    assertStringIncludes(
      transformOutput.messages[0].parts[0].text,
      "Use deterministic merge behavior for recall",
    );
    assertEquals(refreshCalls, [{
      groupId: "group-1",
      query: "Can you revisit deterministic merge behavior for recall?",
    }]);
  });

  it("recalls continuity-rich events without relying on transcript bodies", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 300,
    });

    await redisEvents.recordEvent("session-1", "group-1", {
      id: "decision-1",
      ts: Date.now(),
      category: "decision",
      priority: 0,
      role: "user",
      summary: "Use continuity-first injection",
      continuityText:
        "Use continuity-first injection for hot-tier recall and session memory selection",
    });

    const recalled = await redisEvents.recallSessionEvents(
      "session-1",
      "continuity-first injection",
    );

    assertEquals(recalled.length, 1);
    assertEquals(recalled[0].id, "decision-1");
    assertEquals(recalled[0].body, undefined);
  });

  it("drains structured semantic payloads to Graphiti asynchronously", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 300,
    });
    const drain = new BatchDrainService(redis, redisEvents, {
      batchSize: 8,
      batchMaxBytes: 8_192,
      drainRetryMax: 2,
    });

    await redisEvents.recordEvent("session-1", "group-1", {
      id: "event-1",
      ts: Date.now(),
      category: "file.edit",
      priority: 1,
      role: "tool",
      summary: "Edited src/session.ts",
      detail: "Updated session injection selection",
      continuityText:
        "Edited src/session.ts to prefer continuity fields during session-memory injection",
      refs: ["src/session.ts"],
      keywords: ["session", "continuity", "injection"],
    });

    const calls: Array<{ name: string; episodeBody: string }> = [];
    const result = await drain.drainGroup("group-1", {
      addMemory(input: { name: string; episodeBody: string }) {
        calls.push(input);
        return Promise.resolve();
      },
    } as never);

    assertEquals(result.status, "success");
    assertEquals(calls.length, 1);
    assertStringIncludes(calls[0].name, "file.edit:event-1");
    assertStringIncludes(
      calls[0].episodeBody,
      "Summary: Edited src/session.ts",
    );
    assertStringIncludes(
      calls[0].episodeBody,
      "Continuity: Edited src/session.ts to prefer continuity fields during session-memory injection",
    );
    assertEquals(calls[0].episodeBody.includes("Body:"), false);
  });

  it("updates only the refresh query field without clobbering cache metadata", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    await redis.setHashFields("memory-cache:group-1:meta", {
      lastQuery: "previous query",
      lastRefresh: 123,
      factUuids: "fact-1,fact-2",
    }, 300);

    await redisCache.rememberRefreshQuery("group-1", "next query");

    assertEquals(await redis.getHashAll("memory-cache:group-1:meta"), {
      lastQuery: "next query",
      lastRefresh: "123",
      factUuids: "fact-1,fact-2",
    });
  });

  it("classifies drift deterministically at the configured threshold boundary", () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    const aligned = redisCache.classifyRefresh({
      query: "alpha beta",
      refreshedAt: Date.now(),
      facts: [],
      nodes: [],
      factUuids: [],
      nodeRefs: [],
    }, "alpha beta gamma delta");
    const drifted = redisCache.classifyRefresh({
      query: "alpha beta",
      refreshedAt: Date.now(),
      facts: [],
      nodes: [],
      factUuids: [],
      nodeRefs: [],
    }, "alpha delta epsilon");

    assertEquals(aligned.classification, "aligned");
    assertEquals(aligned.shouldRefresh, false);
    assertEquals(aligned.similarity, 0.5);
    assertEquals(drifted.classification, "drifted");
    assertEquals(drifted.shouldRefresh, true);
  });

  it("detects primer-only and stale cache states while preserving injection", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 300,
    });
    const redisSnapshot = new RedisSnapshotService(redis, { ttlSeconds: 600 });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });
    const manager = new SessionManager(
      "group-1",
      "user-1",
      { session: { get: () => ({ parentID: null }) } } as never,
      redisEvents,
      redisSnapshot,
      redisCache,
    );
    manager.setParentId("session-1", null);
    manager.setState(
      "session-1",
      manager.createDefaultState("group-1", "user-1"),
    );

    await redisCache.set("group-1", {
      query: "primer",
      refreshedAt: Date.now(),
      facts: [],
      nodes: [],
      factUuids: [],
      nodeRefs: [],
      episodeSummaries: ["Primer episode"],
    });
    const primerPrepared = await manager.prepareInjection(
      "session-1",
      "real query",
    );
    assertEquals(primerPrepared?.refreshDecision.classification, "primer-only");
    assertStringIncludes(primerPrepared?.envelope ?? "", "<session_memory");

    await redisCache.set("group-1", {
      query: "older query",
      refreshedAt: Date.now() - 301_000,
      facts: [{ uuid: "fact-1", fact: "Stale fact" }],
      nodes: [],
      factUuids: ["fact-1"],
      nodeRefs: [],
    });
    const stalePrepared = await manager.prepareInjection(
      "session-1",
      "older query",
    );
    assertEquals(stalePrepared?.refreshDecision.classification, "stale");
    assertStringIncludes(stalePrepared?.envelope ?? "", "Stale fact");
  });

  it("reuses same-group persistent memory across sessions while isolating other groups", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 300,
    });
    const redisSnapshot = new RedisSnapshotService(redis, { ttlSeconds: 600 });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    await redisCache.set("group-1", {
      query: "architecture token",
      refreshedAt: Date.now(),
      facts: [{
        uuid: "fact-1",
        fact:
          "Exact token ALPHA-RECALL-42 identifies the architecture decision",
      }],
      nodes: [],
      factUuids: ["fact-1"],
      nodeRefs: [],
    });

    const sameGroupManager = new SessionManager(
      "group-1",
      "user-1",
      { session: { get: () => ({ parentID: null }) } } as never,
      redisEvents,
      redisSnapshot,
      redisCache,
    );
    sameGroupManager.setParentId("session-b", null);
    sameGroupManager.setState(
      "session-b",
      sameGroupManager.createDefaultState("group-1", "user-1"),
    );

    const otherGroupManager = new SessionManager(
      "group-2",
      "user-2",
      { session: { get: () => ({ parentID: null }) } } as never,
      redisEvents,
      redisSnapshot,
      redisCache,
    );
    otherGroupManager.setParentId("session-c", null);
    otherGroupManager.setState(
      "session-c",
      otherGroupManager.createDefaultState("group-2", "user-2"),
    );

    const sameGroupPrepared = await sameGroupManager.prepareInjection(
      "session-b",
      "architecture token",
    );
    const otherGroupPrepared = await otherGroupManager.prepareInjection(
      "session-c",
      "architecture token",
    );

    assertStringIncludes(sameGroupPrepared?.envelope ?? "", "ALPHA-RECALL-42");
    assertEquals(
      (otherGroupPrepared?.envelope ?? "").includes("ALPHA-RECALL-42"),
      false,
    );
    assertEquals(otherGroupPrepared?.factUuids ?? [], []);
  });

  it("injects stale cached memory immediately while scheduling async refresh", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const redisEvents = new RedisEventsService(redis, {
      sessionTtlSeconds: 300,
    });
    const redisSnapshot = new RedisSnapshotService(redis, { ttlSeconds: 600 });
    const redisCache = new RedisCacheService(redis, {
      ttlSeconds: 300,
      driftThreshold: 0.5,
    });

    await redisCache.set("group-1", {
      query: "old recall topic",
      refreshedAt: Date.now() - 301_000,
      facts: [{ uuid: "fact-1", fact: "Stale but still useful recall fact" }],
      nodes: [],
      factUuids: ["fact-1"],
      nodeRefs: [],
    });

    const manager = new SessionManager(
      "group-1",
      "user-1",
      { session: { get: () => ({ parentID: null }) } } as never,
      redisEvents,
      redisSnapshot,
      redisCache,
    );
    manager.setParentId("session-1", null);
    manager.setState(
      "session-1",
      manager.createDefaultState("group-1", "user-1"),
    );

    const refreshCalls: Array<{ groupId: string; query: string }> = [];
    const graphitiAsync = {
      scheduleCacheRefresh(groupId: string, query: string) {
        refreshCalls.push({ groupId, query });
      },
      scheduleDrain() {},
    };

    const chat = createChatHandler({
      sessionManager: manager,
      redisEvents,
      graphitiAsync: graphitiAsync as never,
      drainTriggerSize: 999,
    });
    const transform = createMessagesHandler({ sessionManager: manager });

    await chat(
      { sessionID: "session-1" } as never,
      {
        parts: [{
          type: "text",
          text: "new recall topic",
        }],
      } as never,
    );

    const transformOutput = {
      messages: [{
        info: { role: "user", sessionID: "session-1" },
        parts: [{
          type: "text",
          text: "new recall topic",
        }],
      }],
    };
    await transform(
      { message: "new recall topic" } as never,
      transformOutput as never,
    );

    assertEquals(refreshCalls, [{
      groupId: "group-1",
      query: "new recall topic",
    }]);
    assertStringIncludes(
      transformOutput.messages[0].parts[0].text,
      "Stale but still useful recall fact",
    );
  });
});
