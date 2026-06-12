import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { RedisClient } from "./redis-client.ts";
import { createSessionCorpusService } from "./session-corpus.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const textEncoder = new TextEncoder();

describe("session-corpus", () => {
  it("fetches local HTTP content, normalizes it, and indexes it", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const fetchCalls: string[] = [];
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-fetch",
      fetchImpl: (input) => {
        fetchCalls.push(String(input));
        return Promise.resolve(
          new Response(
            "# Redis Session TTLs\n\nSession TTL protects local corpus state.",
            {
              headers: { "content-type": "text/markdown; charset=utf-8" },
            },
          ),
        );
      },
    });

    const indexed = await corpus.fetchAndIndex({
      rootSessionId: "root-fetch",
      url: "http://127.0.0.1/local-doc",
      timeoutSeconds: 5,
    });
    const search = await corpus.search({
      rootSessionId: "root-fetch",
      query: "session ttl",
    });

    assertEquals(fetchCalls, ["http://127.0.0.1/local-doc"]);
    assertEquals(indexed.status, "ok");
    assertEquals(indexed.contentType, "text/plain");
    assertEquals(indexed.excerpt.length > 0, true);
    assertStringIncludes(indexed.excerpt, "Session TTL");
    assertEquals(indexed.corpusRef, search.results[0]?.corpus_ref);
    assert(search.results[0]?.snippet.includes("Session TTL"));
  });

  it("reopens an exact fetched corpus_ref directly and falls back for malformed refs", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-fetch-ref",
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            "# Redis Session TTLs\n\nSession TTL protects local corpus state.",
            {
              headers: { "content-type": "text/markdown; charset=utf-8" },
            },
          ),
        ),
    });

    const fetched = await corpus.fetchAndIndex({
      rootSessionId: "root-fetch-ref",
      url: "http://127.0.0.1/local-doc",
      timeoutSeconds: 5,
    });
    await corpus.index({
      rootSessionId: "root-fetch-ref",
      content: "# TTL Operations\n\nSession TTL debugging checklist.",
    });

    const exact = await corpus.search({
      rootSessionId: "root-fetch-ref",
      query: fetched.corpusRef,
    });
    const malformed = await corpus.search({
      rootSessionId: "root-fetch-ref",
      query: `${fetched.corpusRef}-partial session ttl`,
    });

    assertEquals(exact.corpusRefs, [fetched.corpusRef]);
    assertEquals(exact.results.length, 1);
    assertStringIncludes(exact.results[0].snippet, "Session TTL");
    assertEquals(exact.results[0].type, "entry");
    assertEquals(exact.results[0].root_session_id, "root-fetch-ref");
    assertEquals(exact.results[0].scope, "local");
    assertEquals(typeof exact.results[0].created_at, "string");
    assertEquals(exact.results[0].updated_at, exact.results[0].created_at);
    assertEquals(exact.results[0].source, "fetch");
    assertEquals(malformed.results.length > 0, true);
    assertEquals(malformed.corpusRefs.includes(fetched.corpusRef), true);
  });

  it("applies the fetch timeout to indexing work end to end", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const originalAppendToList = redis.appendToList.bind(redis);
    redis.appendToList = async (...args) => {
      await wait(25);
      return await originalAppendToList(...args);
    };
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-fetch-timeout",
      fetchImpl: () =>
        Promise.resolve(
          new Response("# Timeout Test\n\nThis response returns immediately.", {
            headers: { "content-type": "text/markdown; charset=utf-8" },
          }),
        ),
    });

    await assertRejects(
      () =>
        corpus.fetchAndIndex({
          rootSessionId: "root-fetch-timeout",
          url: "http://127.0.0.1/timeout-doc",
          timeoutSeconds: 0.01,
        }),
      Error,
      "Fetch timed out",
    );
  });

  it("collapses whitespace before truncation for fetched content", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-fetch-collapse",
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            `alpha${" ".repeat(600_000)}omega`,
            {
              headers: { "content-type": "text/plain; charset=utf-8" },
            },
          ),
        ),
    });

    const fetched = await corpus.fetchAndIndex({
      rootSessionId: "root-fetch-collapse",
      url: "http://127.0.0.1/collapse-doc",
      timeoutSeconds: 5,
    });

    assertEquals(fetched.status, "ok");
    assertEquals(fetched.truncated, false);
    assertEquals(fetched.excerpt, "alpha omega");
  });

  it("ranks the session ttl document first in the small-corpus baseline", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-rank",
    });

    const docA = await corpus.index({
      rootSessionId: "root-rank",
      content:
        "# Redis Session TTLs\n\nSession TTL refresh keeps the local session corpus alive.",
    });
    await corpus.index({
      rootSessionId: "root-rank",
      content:
        "# Graphiti Async Drain\n\nDrain retries happen asynchronously after compaction.",
    });
    await corpus.index({
      rootSessionId: "root-rank",
      content:
        "# Child Session Canonicalization\n\nChild sessions resolve to a canonical root session.",
    });

    const search = await corpus.search({
      rootSessionId: "root-rank",
      query: "session ttl",
    });

    assertEquals(search.status, "ok");
    assertEquals(search.results[0]?.corpus_ref, docA.corpusRef);
  });

  it("returns structured empty results after TTL expiry instead of throwing", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 0.001,
      groupId: "group-expiry",
    });

    await corpus.index({
      rootSessionId: "root-expiry",
      content: "# Redis Session TTLs\n\nTTL expires quickly.",
    });
    await wait(20);

    const search = await corpus.search({
      rootSessionId: "root-expiry",
      query: "ttl",
    });

    assertEquals(search.status, "ok");
    assertEquals(search.results, []);
    assertEquals(search.corpusRefs, []);
  });

  it("stores oversized artifact text with a bounded summary and makes it searchable", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-artifact",
    });

    const artifact = await corpus.storeArtifact({
      rootSessionId: "root-artifact",
      toolName: "session_execute",
      body: "SESSION TTL REPORT\n" +
        "session ttl keeps search warm\n".repeat(500),
    });
    const search = await corpus.search({
      rootSessionId: "root-artifact",
      query: "session ttl",
    });

    assertMatch(artifact.artifactRef, /^local:\/\/session_execute\//);
    assert(artifact.summary.length <= 320);
    assertEquals(search.results[0]?.corpus_ref, artifact.corpusRef);
  });

  it("namespaces corpus keys with groupId and root_session_id", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-alpha",
    });

    const indexed = await corpus.index({
      rootSessionId: "root-scoped",
      content: "# Scoped Corpus\n\nRedis-backed local corpus.",
    });

    assertEquals(
      indexed.corpusRef,
      "session:group-alpha:root-scoped:corpus:corpus-1:meta",
    );
    const meta = await redis.getHashAll(indexed.corpusRef);
    assertEquals(meta.root_session_id, "root-scoped");
  });

  it("does not persist extra stem or vocab key families outside the locked namespace", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-namespace",
    });

    await corpus.index({
      rootSessionId: "root-namespace",
      content: "# Index Maintenance\n\nIndex updates keep retrieval healthy.",
    });

    const vocab = await redis.getHashAll(
      "session:group-namespace:root-namespace:vocab",
    );
    const stemHits = await redis.getListRange(
      "session:group-namespace:root-namespace:stem:index",
      0,
      10,
    );

    assertEquals(vocab, {});
    assertEquals(stemHits, []);
  });

  it("continues corpus ids across runtime reinitialization with the same redis state", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const first = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-ids",
    });

    const firstIndexed = await first.index({
      rootSessionId: "root-ids",
      content: "# First\n\nSession TTL baseline.",
    });

    const second = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-ids",
    });
    const secondIndexed = await second.index({
      rootSessionId: "root-ids",
      content: "# Second\n\nGraphiti async drain notes.",
    });

    assertEquals(
      firstIndexed.corpusRef,
      "session:group-ids:root-ids:corpus:corpus-1:meta",
    );
    assertEquals(
      secondIndexed.corpusRef,
      "session:group-ids:root-ids:corpus:corpus-2:meta",
    );
    assertEquals(
      await redis.getListRange("session:group-ids:root-ids:corpora", 0, 10),
      ["corpus-1", "corpus-2"],
    );
  });

  it("keeps concurrent corpus writes from reusing the same corpus id", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    let waitingResolvers: Array<() => void> = [];
    let blockedWrites = 0;
    const originalSetHashFields = redis.setHashFields.bind(redis);
    redis.setHashFields = async (key, values, ttlSeconds) => {
      if (
        key === "session:group-race:root-race:stats" &&
        values.next_corpus_id !== undefined
      ) {
        blockedWrites += 1;
        await new Promise<void>((resolve) => {
          waitingResolvers.push(resolve);
          if (blockedWrites === 2) {
            for (const resume of waitingResolvers) resume();
            waitingResolvers = [];
          }
        });
      }
      return await originalSetHashFields(key, values, ttlSeconds);
    };

    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-race",
    });

    const [first, second] = await Promise.all([
      corpus.index({
        rootSessionId: "root-race",
        content: "# First\n\nFirst concurrent write.",
      }),
      corpus.index({
        rootSessionId: "root-race",
        content: "# Second\n\nSecond concurrent write.",
      }),
    ]);

    assertEquals(first.corpusRef === second.corpusRef, false);
    assertEquals(
      await redis.getListRange("session:group-race:root-race:corpora", 0, 10),
      ["corpus-1", "corpus-2"],
    );
  });

  it("stores each chunk id exactly once in the corpus chunk list", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-chunk-list",
    });

    const indexed = await corpus.index({
      rootSessionId: "root-chunk-list",
      content: [
        "# Alpha",
        "",
        "First paragraph.",
        "",
        "Second paragraph.",
      ].join("\n"),
    });

    const corpusId = indexed.corpusRef.split(":").at(-2) ?? "";
    const chunkIds = await redis.getListRange(
      `session:group-chunk-list:root-chunk-list:corpus:${corpusId}:chunks`,
      0,
      20,
    );

    assertEquals(chunkIds.length, indexed.chunkCount);
    assertEquals(new Set(chunkIds).size, chunkIds.length);
  });

  it("normalizes HTML into markdown-visible headings, lists, and fenced code", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-html",
    });

    await corpus.index({
      rootSessionId: "root-html",
      contentType: "text/html",
      content: [
        "<article>",
        "<h1>Install Guide</h1>",
        "<p>Use the local Redis runtime.</p>",
        "<ul><li>Install Redis</li><li>Verify TTL refresh</li></ul>",
        "<pre><code>redis-cli PING\nTTL session:key</code></pre>",
        "</article>",
      ].join(""),
    });

    const listSearch = await corpus.search({
      rootSessionId: "root-html",
      query: "verify ttl refresh",
    });
    const codeSearch = await corpus.search({
      rootSessionId: "root-html",
      query: "redis-cli ping",
    });

    assertStringIncludes(
      listSearch.results[0]?.snippet ?? "",
      "- Verify TTL refresh",
    );
    assertStringIncludes(codeSearch.results[0]?.snippet ?? "", "```");
    assertStringIncludes(
      codeSearch.results[0]?.snippet ?? "",
      "redis-cli PING",
    );
  });

  it("keeps fenced code blocks atomic under the nearest heading during chunking", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-code",
    });

    const indexed = await corpus.index({
      rootSessionId: "root-code",
      content: [
        "# Setup",
        "",
        "Prelude text ".repeat(120),
        "",
        "## Runtime",
        "",
        "```ts",
        "const runtime = createSessionMcpRuntime({ redisClient });",
        'await runtime.tools.session_search.execute({ query: "ttl" }, ctx);',
        "```",
        "",
        "Trailing text ".repeat(120),
      ].join("\n"),
    });

    const corpusId = indexed.corpusRef.split(":").at(-2) ?? "";
    const chunkIds = await redis.getListRange(
      `session:group-code:root-code:corpus:${corpusId}:chunks`,
      0,
      20,
    );
    const codeChunk = await Promise.any(
      chunkIds.map((chunkId) =>
        redis.getHashAll(`session:group-code:root-code:chunk:${chunkId}`).then(
          (chunk) => {
            if ((chunk.text ?? "").includes("createSessionMcpRuntime")) {
              return chunk;
            }
            throw new Error("not code chunk");
          },
        )
      ),
    );

    assertEquals(codeChunk.title, "Runtime");
    assertStringIncludes(codeChunk.text ?? "", "```ts");
    assertStringIncludes(codeChunk.text ?? "", "```\n");
  });

  it("finds inflected queries through stemming", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-stem",
    });

    const indexed = await corpus.index({
      rootSessionId: "root-stem",
      content:
        "# Index Maintenance\n\nThis corpus tracks index updates and index health.",
    });

    const search = await corpus.search({
      rootSessionId: "root-stem",
      query: "indices update",
    });

    assertEquals(search.results[0]?.corpus_ref, indexed.corpusRef);
  });

  it("matches porter-equivalent word families beyond simple plural stripping", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-porter",
    });

    const indexed = await corpus.index({
      rootSessionId: "root-porter",
      content:
        "# Organization Notes\n\nOrganization planning stays searchable across sessions.",
    });

    const search = await corpus.search({
      rootSessionId: "root-porter",
      query: "organize planning",
    });

    assertEquals(search.results[0]?.corpus_ref, indexed.corpusRef);
  });

  it("anchors snippets near stemmed matches instead of always falling back to the document start", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-snippet",
    });

    const indexed = await corpus.index({
      rootSessionId: "root-snippet",
      content: "# Long Index Notes\n\n" +
        "preamble words ".repeat(80) +
        "\n\nIndex maintenance happens near the end of this corpus.",
    });

    const search = await corpus.search({
      rootSessionId: "root-snippet",
      query: "indices",
    });

    assertEquals(search.results[0]?.corpus_ref, indexed.corpusRef);
    assertStringIncludes(
      search.results[0]?.snippet ?? "",
      "Index maintenance happens near the end",
    );
  });

  it("uses BM25-style ranking so repeated and title-weighted terms outrank weak matches", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-bm25",
    });

    const strong = await corpus.index({
      rootSessionId: "root-bm25",
      content:
        "# Session TTL Guide\n\nSession TTL session TTL refresh session TTL keeps search warm.",
    });
    await corpus.index({
      rootSessionId: "root-bm25",
      content: "# Session Notes\n\nTTL appears once.",
    });

    const search = await corpus.search({
      rootSessionId: "root-bm25",
      query: "session ttl",
    });

    assertEquals(search.results[0]?.corpus_ref, strong.corpusRef);
  });

  it("applies the 200-candidate cap after ranking, so later stronger postings can still surface", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-cap-order",
    });

    for (let index = 1; index <= 205; index += 1) {
      await corpus.index({
        rootSessionId: "root-cap-order",
        content: index === 205
          ? "# Session Session Session\n\nSession session session session dominates this chunk."
          : `# Weak ${index}\n\nSession appears once in weak chunk ${index}.`,
      });
    }

    const search = await corpus.search({
      rootSessionId: "root-cap-order",
      query: "session",
    });

    assertStringIncludes(
      search.results[0]?.snippet ?? "",
      "dominates this chunk",
    );
  });

  it("keeps RRF- and proximity-relevant chunks eligible until the final 200-candidate cap", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-cap-rrf",
    });

    for (let index = 1; index <= 204; index += 1) {
      await corpus.index({
        rootSessionId: "root-cap-rrf",
        content: `# Weak ${index}\n\nRedis ${
          "padding ".repeat(20)
        } TTL appears separately in weak chunk ${index}.`,
      });
    }
    const strong = await corpus.index({
      rootSessionId: "root-cap-rrf",
      content:
        "# Redis TTL Refresh\n\nRedis TTL refresh happens together in this late strong chunk.",
    });

    const search = await corpus.search({
      rootSessionId: "root-cap-rrf",
      query: "redis ttl refresh",
    });

    assertEquals(search.results[0]?.corpus_ref, strong.corpusRef);
    assertStringIncludes(search.results[0]?.snippet ?? "", "late strong chunk");
  });

  it("returns a structured error when fetch responds with non-ok status", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-fetch-error",
      fetchImpl: () =>
        Promise.resolve(
          new Response("missing", {
            status: 404,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        ),
    });

    const result = await corpus.fetchAndIndex({
      rootSessionId: "root-fetch-error",
      url: "https://example.com/missing",
      timeoutSeconds: 5,
    });

    assertEquals(result.status, "error");
    assertMatch(
      result.corpusRef,
      /^session:group-fetch-error:root-fetch-error:corpus:[^:]+:meta$/,
    );
    assertStringIncludes(result.summary, "HTTP 404");
    assertEquals(result.excerpt, "");
    assertEquals(result.queryHints, []);
    assertEquals(result.fetchedUrl, "https://example.com/missing");
    assertEquals(result.contentType, "text/html");
    assertEquals(result.truncated, false);
  });

  it("uses trigram expansion only when exact or stem recall is sparse", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-trigram",
    });

    const exact = await corpus.index({
      rootSessionId: "root-trigram",
      content: "# Session TTL\n\nSession TTL preserves local corpus context.",
    });
    const partial = await corpus.index({
      rootSessionId: "root-trigram",
      content:
        "# Sessile Tiling\n\nA distractor with overlapping trigrams only.",
    });

    const exactRecall = await corpus.search({
      rootSessionId: "root-trigram",
      query: "session ttl",
    });
    const partialRecall = await corpus.search({
      rootSessionId: "root-trigram",
      query: "sess tt",
    });

    assertEquals(exactRecall.corpusRefs, [exact.corpusRef]);
    assertEquals(partialRecall.corpusRefs.includes(partial.corpusRef), true);
  });

  it("corrects fuzzy misspellings before retrieval", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-fuzzy",
    });

    const indexed = await corpus.index({
      rootSessionId: "root-fuzzy",
      content: "# Session TTL\n\nSession TTL keeps the corpus searchable.",
    });

    const search = await corpus.search({
      rootSessionId: "root-fuzzy",
      query: "sesion tll",
    });

    assertEquals(search.results[0]?.corpus_ref, indexed.corpusRef);
  });

  it("reranks multi-term matches by proximity", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-proximity",
    });

    const close = await corpus.index({
      rootSessionId: "root-proximity",
      content:
        "# Redis Session TTL\n\nRedis session TTL refresh happens together in this paragraph.",
    });
    await corpus.index({
      rootSessionId: "root-proximity",
      content: "# Redis Drift\n\nRedis signals drift.\n\n" +
        "padding words ".repeat(80) + "\nTTL appears much later.",
    });

    const search = await corpus.search({
      rootSessionId: "root-proximity",
      query: "redis ttl",
    });

    assertEquals(search.results[0]?.corpus_ref, close.corpusRef);
  });

  it("stores one canonical full artifact body without duplicating it in chunk payloads", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-artifact-storage",
    });

    const body = "SESSION TTL REPORT\n" +
      "session ttl keeps retrieval warm\n".repeat(200);
    const artifact = await corpus.storeArtifact({
      rootSessionId: "root-artifact-storage",
      toolName: "session_execute",
      body,
    });

    const artifactId = artifact.artifactRef.split("/").at(-1) ?? "";
    const corpusId = artifact.corpusRef.split(":").at(-2) ?? "";
    const chunkIds = await redis.getListRange(
      `session:group-artifact-storage:root-artifact-storage:corpus:${corpusId}:chunks`,
      0,
      20,
    );
    const bodySnapshot = await redis.getString(
      `session:group-artifact-storage:root-artifact-storage:artifact:${artifactId}:body`,
    );
    const chunkPayloads = await Promise.all(
      chunkIds.map((chunkId) =>
        redis.getHashAll(
          `session:group-artifact-storage:root-artifact-storage:chunk:${chunkId}`,
        )
      ),
    );

    assertEquals(bodySnapshot, body);
    assertEquals(
      chunkPayloads.some((chunk) => (chunk.text ?? "") === body),
      false,
    );
  });

  it("refreshes every affected corpus family on a successful search, not just the top results", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 0.1,
      groupId: "group-refresh",
    });

    for (let index = 1; index <= 5; index += 1) {
      await corpus.index({
        rootSessionId: "root-refresh",
        content:
          `# Strong ${index}\n\nSession TTL session TTL refresh session TTL doc ${index}.`,
      });
    }
    const weak = await corpus.index({
      rootSessionId: "root-refresh",
      content:
        "# Weak Match\n\nSession TTL appears once. Unique survivor marker remains searchable.",
    });

    await wait(50);
    const broad = await corpus.search({
      rootSessionId: "root-refresh",
      query: "session ttl",
    });
    assertEquals(broad.results.length, 5);
    await wait(80);

    const survivor = await corpus.search({
      rootSessionId: "root-refresh",
      query: "survivor marker",
    });

    assertEquals(survivor.results[0]?.corpus_ref, weak.corpusRef);
  });

  it("keeps search on postings instead of scanning the full corpora list", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const originalGetListRange = redis.getListRange.bind(redis);
    let searchMode = false;
    redis.getListRange = async (key, start, stop) => {
      if (
        searchMode && key === "session:group-postings:root-postings:corpora"
      ) {
        throw new Error("search scanned corpora list");
      }
      return await originalGetListRange(key, start, stop);
    };

    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-postings",
    });

    await corpus.index({
      rootSessionId: "root-postings",
      content: "# Session TTL\n\nSession TTL keeps search local.",
    });
    searchMode = true;

    const search = await corpus.search({
      rootSessionId: "root-postings",
      query: "session ttl",
    });

    assertEquals(search.results.length > 0, true);
  });

  it("migrates provisional-root corpus, posting, artifact, and stats keys onto the canonical root with TTLs", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 120,
      groupId: "group-migrate",
    });

    await corpus.index({
      rootSessionId: "parent-root",
      content: [
        "# Parent Corpus",
        "",
        "Canonical parent content remains searchable.",
      ].join("\n"),
    });
    const migrated = await corpus.storeArtifact({
      rootSessionId: "child-root",
      toolName: "session_execute",
      body: "temporary root artifact body with redis ttl migration markers",
    });
    const sourceMetaBefore = await redis.snapshot(migrated.corpusRef);
    const sourceStatsBefore = await redis.snapshot(
      "session:group-migrate:child-root:stats",
    );
    const originalDeleteKey = redis.deleteKey.bind(redis);

    redis.restoreSnapshot = () => {
      return Promise.reject(new Error("legacy restoreSnapshot path used"));
    };
    redis.deleteKey = () => {
      return Promise.reject(new Error("legacy deleteKey path used"));
    };

    await corpus.migrateRootSessionState("child-root", "parent-root");

    const migratedAliasKey =
      `session:group-migrate:parent-root:corpus-ref-alias:${
        encodeURIComponent(migrated.corpusRef)
      }`;
    await originalDeleteKey(migratedAliasKey);

    const parentSearch = await corpus.search({
      rootSessionId: "parent-root",
      query: "migration markers canonical parent",
    });
    const refreshedAlias = await redis.getString(migratedAliasKey);
    const parentStats = await corpus.getStats("parent-root");
    const childSearch = await corpus.search({
      rootSessionId: "child-root",
      query: "migration markers",
    });
    const migratedExact = await corpus.search({
      rootSessionId: "parent-root",
      query: migrated.corpusRef,
    });
    const sourceMetaAfter = await redis.snapshot(migrated.corpusRef);
    const parentCorpora = await redis.getListRange(
      "session:group-migrate:parent-root:corpora",
      0,
      10,
    );

    assertEquals(parentSearch.results.length > 0, true);
    assertEquals(
      refreshedAlias,
      "session:group-migrate:parent-root:corpus:corpus-2:meta",
    );
    assertEquals(parentStats.artifactCount, 1);
    assertEquals(parentStats.corpusCount, 2);
    assertEquals(childSearch.results, []);
    assertEquals(migratedExact.results.length, 1);
    assertStringIncludes(
      migratedExact.results[0]?.snippet ?? "",
      "migration markers",
    );
    assertEquals(
      migratedExact.results[0]?.corpus_ref,
      "session:group-migrate:parent-root:corpus:corpus-2:meta",
    );
    assertEquals(migratedExact.corpusRefs, [
      "session:group-migrate:parent-root:corpus:corpus-2:meta",
    ]);
    assertEquals(sourceMetaAfter.kind, "missing");
    assertEquals(parentCorpora, ["corpus-1", "corpus-2"]);
    assertEquals(sourceMetaBefore.kind === "hash", true);
    assertEquals(sourceStatsBefore.kind === "hash", true);
    if (sourceMetaBefore.kind === "hash") {
      const migratedMeta = await redis.snapshot(
        "session:group-migrate:parent-root:corpus:corpus-2:meta",
      );
      assertEquals(migratedMeta.kind, "hash");
      if (migratedMeta.kind === "hash") {
        assertEquals(
          Math.abs(
            (migratedMeta.ttlSeconds ?? 0) - (sourceMetaBefore.ttlSeconds ?? 0),
          ) <= 1,
          true,
        );
      }
    }
  });

  it("tracks root-session-local corpus and artifact byte counters without duplicating full artifact bodies", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 120,
      groupId: "group-stats",
    });

    await corpus.index({
      rootSessionId: "root-stats",
      content: "# Corpus One\n\nfirst local corpus body",
    });
    const artifact = await corpus.storeArtifact({
      rootSessionId: "root-stats",
      toolName: "session_execute",
      body: "artifact payload body\n" + "payload marker\n".repeat(40),
    });

    const stats = await corpus.getStats("root-stats");
    const artifactId = artifact.artifactRef.split("/").at(-1) ?? "";
    const bodyKeys = await redis.keysByPrefix(
      "session:group-stats:root-stats:artifact:",
    );

    assertEquals(stats.corpusCount, 2);
    assertEquals(stats.artifactCount, 1);
    assertEquals(stats.counters.corpus_count, 2);
    assertEquals(stats.counters.artifact_count, 1);
    assertEquals((stats.counters.bytes_indexed_total ?? 0) > 0, true);
    assertEquals((stats.counters.bytes_saved_estimate ?? 0) > 0, true);
    assertEquals(
      stats.counters.bytes_saved_estimate,
      textEncoder.encode(
        "artifact payload body\n" + "payload marker\n".repeat(40),
      )
        .byteLength,
    );
    assertEquals(
      bodyKeys.filter((key) => key.endsWith(":body")).length,
      1,
    );
    assertEquals(
      bodyKeys.some((key) =>
        key === `session:group-stats:root-stats:artifact:${artifactId}:body`
      ),
      true,
    );
  });

  it("replaces prior content for the same source and label", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-replacement",
    });

    const first = await corpus.index({
      rootSessionId: "root-replacement",
      content: "old alpha body",
      source: "build-log",
      label: "latest",
    });
    const second = await corpus.index({
      rootSessionId: "root-replacement",
      content: "new beta body",
      source: "build-log",
      label: "latest",
    });

    const oldSearch = await corpus.search({
      rootSessionId: "root-replacement",
      query: "alpha",
    });
    const newSearch = await corpus.search({
      rootSessionId: "root-replacement",
      query: "beta",
    });

    assertEquals(oldSearch.results.length, 0);
    assertEquals(newSearch.results.length > 0, true);
    assertEquals(newSearch.results[0]?.corpus_ref, second.corpusRef);
    assertEquals(first.corpusRef === second.corpusRef, false);
  });

  it("removes prior postings and corpus metadata when replacing the same source and label", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 60,
      groupId: "group-replacement-cleanup",
    });

    const first = await corpus.index({
      rootSessionId: "root-replacement-cleanup",
      content: "old alpha body",
      source: "build-log",
      label: "latest",
    });
    const second = await corpus.index({
      rootSessionId: "root-replacement-cleanup",
      content: "new beta body",
      source: "build-log",
      label: "latest",
    });

    const firstCorpusId = first.corpusRef.split(":").at(-2) ?? "";
    const secondCorpusId = second.corpusRef.split(":").at(-2) ?? "";
    const firstMeta = await redis.snapshot(first.corpusRef);
    const secondMeta = await redis.snapshot(second.corpusRef);
    const firstChunks = await redis.snapshot(
      `session:group-replacement-cleanup:root-replacement-cleanup:corpus:${firstCorpusId}:chunks`,
    );
    const secondChunks = await redis.snapshot(
      `session:group-replacement-cleanup:root-replacement-cleanup:corpus:${secondCorpusId}:chunks`,
    );
    const alphaPostings = await redis.getListRange(
      "session:group-replacement-cleanup:root-replacement-cleanup:term:alpha",
      0,
      10,
    );
    const betaPostings = await redis.getListRange(
      "session:group-replacement-cleanup:root-replacement-cleanup:term:beta",
      0,
      10,
    );

    assertEquals(firstMeta.kind, "missing");
    assertEquals(firstChunks.kind, "missing");
    assertEquals(secondMeta.kind, "hash");
    assertEquals(secondChunks.kind, "list");
    assertEquals(alphaPostings, []);
    assertEquals(betaPostings.length > 0, true);
  });

  it("composes concurrent stats deltas without losing increments", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 120,
      groupId: "group-atomic-stats",
    });
    const trackedKey = "session:group-atomic-stats:root-atomic:stats";
    const originalGetHashAll = redis.getHashAll.bind(redis);
    let blockStatsReads = true;
    let blockedReads = 0;
    let waitingResolvers: Array<() => void> = [];

    redis.getHashAll = async (key) => {
      if (blockStatsReads && key === trackedKey) {
        blockedReads += 1;
        await new Promise<void>((resolve) => {
          waitingResolvers.push(resolve);
          if (blockedReads === 2) {
            for (const resume of waitingResolvers) resume();
            waitingResolvers = [];
          }
        });
      }
      return await originalGetHashAll(key);
    };

    await Promise.all([
      corpus.recordStats("root-atomic", {
        artifact_count: 1,
        bytes_saved_estimate: 10,
      }),
      corpus.recordStats("root-atomic", {
        artifact_count: 2,
        bytes_saved_estimate: 5,
      }),
    ]);
    blockStatsReads = false;

    const stats = await corpus.getStats("root-atomic");

    assertEquals(stats.counters.artifact_count, 3);
    assertEquals(stats.counters.bytes_saved_estimate, 15);
  });

  it("does not migrate sibling root keys that only share the same prefix", async () => {
    const redis = new RedisClient({ endpoint: "redis://unused" });
    const corpus = createSessionCorpusService({
      redis,
      ttlSeconds: 120,
      groupId: "group-migrate-prefix",
    });

    await corpus.index({
      rootSessionId: "child-root",
      content: "# Child Root\n\nOnly this root should migrate.",
    });
    const sibling = await corpus.index({
      rootSessionId: "child-root-2",
      content: "# Child Root 2\n\nSibling root must stay untouched.",
    });

    await corpus.migrateRootSessionState("child-root", "parent-root");

    const parentSearch = await corpus.search({
      rootSessionId: "parent-root",
      query: "only this root should migrate",
    });
    const siblingSearch = await corpus.search({
      rootSessionId: "child-root-2",
      query: "sibling root untouched",
    });
    const siblingMeta = await redis.snapshot(sibling.corpusRef);

    assertEquals(parentSearch.results.length > 0, true);
    assertEquals(siblingSearch.results.length > 0, true);
    assertEquals(siblingMeta.kind, "hash");
  });
});
