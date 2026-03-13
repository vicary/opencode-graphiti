import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "jsr:@std/assert@^1.0.0";
import { describe, it } from "jsr:@std/testing@^1.0.0/bdd";
import { GraphitiClient } from "./client.ts";
import {
  GraphitiOfflineError,
  GraphitiRequestTimeoutError,
  type GraphitiToolCaller,
} from "./connection-manager.ts";
import { logger } from "./logger.ts";

const originalLogger = { ...logger };
logger.info = () => {};
logger.warn = () => {};
logger.error = () => {};
logger.debug = () => {};

addEventListener("unload", () => {
  logger.info = originalLogger.info;
  logger.warn = originalLogger.warn;
  logger.error = originalLogger.error;
  logger.debug = originalLogger.debug;
});

class FakeToolCaller implements GraphitiToolCaller {
  started = false;
  stopped = false;
  readyResult = true;
  callToolImpl: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<unknown> = () => Promise.resolve(undefined);

  start(): void {
    this.started = true;
  }

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }

  ready(): Promise<boolean> {
    return Promise.resolve(this.readyResult);
  }

  callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.callToolImpl(name, args);
  }
}

describe("client", () => {
  describe("parseToolResult", () => {
    const client = new GraphitiClient(new FakeToolCaller());

    it("should return original result when no content array", () => {
      const result = { status: "ok" };
      const parsed = client.parseToolResult(result);
      assertEquals(parsed, result);
    });

    it("should return original result when content is empty array", () => {
      const result = { content: [] };
      const parsed = client.parseToolResult(result);
      assertEquals(parsed, result);
    });

    it("should parse JSON from text content", () => {
      const result = {
        content: [{
          type: "text",
          text: '{"facts": [{"uuid": "1", "fact": "test"}]}',
        }],
      };
      const parsed = client.parseToolResult(result);
      assertEquals(parsed, { facts: [{ uuid: "1", fact: "test" }] });
    });

    it("should return plain text when not valid JSON", () => {
      const result = {
        content: [{ type: "text", text: "Hello, world!" }],
      };
      const parsed = client.parseToolResult(result);
      assertStrictEquals(parsed, "Hello, world!");
    });

    it("should handle text field that is not a string", () => {
      const result = {
        content: [{ type: "text", text: 123 }],
      };
      const parsed = client.parseToolResult(result);
      assertStrictEquals(parsed, 123);
    });

    it("should handle text field that is undefined", () => {
      const result = {
        content: [{ type: "text" }],
      };
      const parsed = client.parseToolResult(result);
      assertEquals(parsed, result);
    });
  });

  describe("response parsing integration", () => {
    const client = new GraphitiClient(new FakeToolCaller());

    it("should parse wrapped arrays", () => {
      assertEquals(
        client.parseWrappedArray([{ uuid: "1" }], "facts"),
        [{ uuid: "1" }],
      );
      assertEquals(
        client.parseWrappedArray({ facts: [{ uuid: "2" }] }, "facts"),
        [{ uuid: "2" }],
      );
      assertEquals(client.parseWrappedArray({ status: "ok" }, "facts"), null);
    });
  });

  describe("read error handling", () => {
    it("returns empty array on timeout", async () => {
      const tools = new FakeToolCaller();
      tools.callToolImpl = () =>
        Promise.reject(new GraphitiRequestTimeoutError());
      const client = new GraphitiClient(tools);

      assertEquals(await client.searchFacts({ query: "test" }), []);
      assertEquals(await client.searchNodes({ query: "test" }), []);
      assertEquals(await client.getEpisodes({ groupId: "g" }), []);
    });

    it("returns empty array on offline", async () => {
      const tools = new FakeToolCaller();
      tools.callToolImpl = () =>
        Promise.reject(new GraphitiOfflineError("offline"));
      const client = new GraphitiClient(tools);

      assertEquals(await client.searchFacts({ query: "test" }), []);
      assertEquals(await client.searchNodes({ query: "test" }), []);
      assertEquals(await client.getEpisodes({ groupId: "g" }), []);
    });
  });

  describe("write error propagation", () => {
    it("rethrows offline errors from addEpisode", async () => {
      const tools = new FakeToolCaller();
      tools.callToolImpl = () =>
        Promise.reject(new GraphitiOfflineError("offline"));
      const client = new GraphitiClient(tools);

      await assertRejects(
        () =>
          client.addEpisode({
            name: "episode",
            episodeBody: "body",
          }),
        GraphitiOfflineError,
      );
    });
  });

  describe("manager passthroughs", () => {
    it("start and stop delegate to tool caller", async () => {
      const tools = new FakeToolCaller();
      const client = new GraphitiClient(tools);

      client.start();
      await client.stop();

      assertEquals(tools.started, true);
      assertEquals(tools.stopped, true);
    });

    it("connect starts and returns readiness", async () => {
      const tools = new FakeToolCaller();
      tools.readyResult = false;
      const client = new GraphitiClient(tools);

      assertEquals(await client.connect(), false);
      assertEquals(tools.started, true);
    });
  });
});
