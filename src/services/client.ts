import {
  GraphitiConnectionManager,
  GraphitiSessionExpiredError,
  type GraphitiToolCaller,
  GraphitiTransportError,
  isGraphitiOfflineError,
  isGraphitiTimeoutError,
} from "./connection-manager.ts";
import type {
  GraphitiEpisode,
  GraphitiFact,
  GraphitiNode,
} from "../types/index.ts";
import { logger } from "./logger.ts";
import { normalizeEpisode } from "./sdk-normalize.ts";

/**
 * Graphiti domain adapter over the connection manager.
 */
export class GraphitiClient {
  private readonly toolCaller: GraphitiToolCaller;

  constructor(endpointOrManager: string | GraphitiToolCaller) {
    if (typeof endpointOrManager === "string") {
      this.toolCaller = new GraphitiConnectionManager({
        endpoint: endpointOrManager,
      });
    } else {
      this.toolCaller = endpointOrManager;
    }
  }

  start(): void {
    this.toolCaller.start();
  }

  async stop(): Promise<void> {
    await this.toolCaller.stop();
  }

  async connect(): Promise<boolean> {
    this.toolCaller.start();
    return await this.toolCaller.ready();
  }

  async ready(timeoutMs?: number): Promise<boolean> {
    return await this.toolCaller.ready(timeoutMs);
  }

  /**
   * Parse MCP tool results into JSON when possible.
   * Public for testing.
   */
  parseToolResult(result: unknown): unknown {
    const typedResult = result as {
      content?: Array<{ type?: string; text?: unknown }>;
    };
    const content = typedResult.content;
    if (!Array.isArray(content) || content.length === 0) return result;

    const text = content.find((item) => item?.type === "text")?.text;
    if (text === undefined) return result;

    if (typeof text !== "string") {
      try {
        return JSON.parse(String(text));
      } catch {
        return text;
      }
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /**
   * Extract an array from a tool result that may be a bare array or a
   * wrapped-array response object (`{ [key]: T[] }`).
   * Returns the array when found, otherwise `null`.
   * Public for testing.
   */
  parseWrappedArray<T>(result: unknown, wrappedKey: string): T[] | null {
    if (Array.isArray(result)) return result as T[];
    if (
      result &&
      typeof result === "object" &&
      Array.isArray((result as Record<string, unknown>)[wrappedKey])
    ) {
      return (result as Record<string, unknown>)[wrappedKey] as T[];
    }
    return null;
  }

  /**
   * Add an episode to Graphiti memory.
   */
  async addEpisode(params: {
    name: string;
    episodeBody: string;
    groupId?: string;
    source?: "text" | "json" | "message";
    sourceDescription?: string;
  }): Promise<void> {
    try {
      await this.callTool("add_memory", {
        name: params.name,
        episode_body: params.episodeBody,
        group_id: params.groupId,
        source: params.source || "text",
        source_description: params.sourceDescription || "",
      });
      logger.debug("Added episode:", params.name);
    } catch (err) {
      if (
        isGraphitiOfflineError(err) ||
        isGraphitiTimeoutError(err) ||
        err instanceof GraphitiTransportError ||
        err instanceof GraphitiSessionExpiredError
      ) {
        logger.warn(
          "addEpisode failed due to Graphiti availability issue",
          err,
        );
      }
      throw err;
    }
  }

  /**
   * Search Graphiti facts matching the provided query.
   */
  async searchFacts(params: {
    query: string;
    groupIds?: string[];
    maxFacts?: number;
  }): Promise<GraphitiFact[]> {
    try {
      const result = await this.callTool("search_memory_facts", {
        query: params.query,
        group_ids: params.groupIds,
        max_facts: params.maxFacts || 10,
      });
      return this.parseWrappedArray<GraphitiFact>(result, "facts") ?? [];
    } catch (err) {
      if (isGraphitiTimeoutError(err)) {
        logger.warn("searchFacts request timed out; returning no facts");
        return [];
      }
      if (isGraphitiOfflineError(err)) {
        logger.warn("searchFacts unavailable; returning no facts");
        return [];
      }
      if (
        err instanceof GraphitiTransportError ||
        err instanceof GraphitiSessionExpiredError
      ) {
        logger.warn(
          "searchFacts unavailable during reconnect; returning no facts",
        );
        return [];
      }
      logger.error("searchFacts error:", err);
      return [];
    }
  }

  /**
   * Search Graphiti nodes matching the provided query.
   */
  async searchNodes(params: {
    query: string;
    groupIds?: string[];
    maxNodes?: number;
  }): Promise<GraphitiNode[]> {
    try {
      const result = await this.callTool("search_nodes", {
        query: params.query,
        group_ids: params.groupIds,
        max_nodes: params.maxNodes || 10,
      });
      return this.parseWrappedArray<GraphitiNode>(result, "nodes") ?? [];
    } catch (err) {
      if (isGraphitiTimeoutError(err)) {
        logger.warn("searchNodes request timed out; returning no nodes");
        return [];
      }
      if (isGraphitiOfflineError(err)) {
        logger.warn("searchNodes unavailable; returning no nodes");
        return [];
      }
      if (
        err instanceof GraphitiTransportError ||
        err instanceof GraphitiSessionExpiredError
      ) {
        logger.warn(
          "searchNodes unavailable during reconnect; returning no nodes",
        );
        return [];
      }
      logger.error("searchNodes error:", err);
      return [];
    }
  }

  /**
   * Retrieve recent episodes for a group.
   */
  async getEpisodes(params: {
    groupId?: string;
    lastN?: number;
  }): Promise<GraphitiEpisode[]> {
    try {
      const result = await this.callTool("get_episodes", {
        group_id: params.groupId,
        last_n: params.lastN,
      });
      const raw = this.parseWrappedArray<GraphitiEpisode>(result, "episodes") ??
        [];
      return raw.map(normalizeEpisode);
    } catch (err) {
      if (isGraphitiTimeoutError(err)) {
        logger.warn("getEpisodes request timed out; returning no episodes");
        return [];
      }
      if (isGraphitiOfflineError(err)) {
        logger.warn("getEpisodes unavailable; returning no episodes");
        return [];
      }
      if (
        err instanceof GraphitiTransportError ||
        err instanceof GraphitiSessionExpiredError
      ) {
        logger.warn(
          "getEpisodes unavailable during reconnect; returning no episodes",
        );
        return [];
      }
      logger.error("getEpisodes error:", err);
      return [];
    }
  }

  /**
   * Check whether the Graphiti MCP server is reachable.
   */
  async getStatus(): Promise<boolean> {
    try {
      await this.callTool("get_status", {});
      return true;
    } catch {
      return false;
    }
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const result = await this.toolCaller.callTool(name, args);
    return this.parseToolResult(result);
  }
}
