import {
  GraphitiConnectionManager,
  GraphitiOfflineError,
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
import { notifyGraphitiAvailabilityIssue } from "./opencode-warning.ts";
import { normalizeEpisode } from "./sdk-normalize.ts";

export type GraphitiNodeSearchResult = {
  nodes: GraphitiNode[];
  degraded: boolean;
};

export class GraphitiMcpClient {
  private readonly toolCaller: GraphitiToolCaller;

  constructor(endpointOrManager: string | GraphitiToolCaller) {
    this.toolCaller = typeof endpointOrManager === "string"
      ? new GraphitiConnectionManager({ endpoint: endpointOrManager })
      : endpointOrManager;
  }

  start(): void {
    this.toolCaller.start();
  }

  async stop(): Promise<void> {
    await this.toolCaller.stop();
  }

  async connect(): Promise<boolean> {
    try {
      this.toolCaller.start();
    } catch (err) {
      if (isGraphitiOfflineError(err)) {
        throw new GraphitiOfflineError(
          err.state,
          err.message ||
            "Graphiti client has been stopped and cannot be restarted",
        );
      }
      throw err;
    }
    return await this.toolCaller.ready();
  }

  async ready(timeoutMs?: number): Promise<boolean> {
    return await this.toolCaller.ready(timeoutMs);
  }

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

  async addMemory(params: {
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
        source: params.source ?? "text",
        source_description: params.sourceDescription ?? "",
      });
    } catch (err) {
      if (
        isGraphitiOfflineError(err) ||
        isGraphitiTimeoutError(err) ||
        err instanceof GraphitiTransportError ||
        err instanceof GraphitiSessionExpiredError
      ) {
        notifyGraphitiAvailabilityIssue(
          "Graphiti unavailable; memory was not saved.",
          {
            operation: "addMemory",
            err,
          },
        );
      }
      throw err;
    }
  }

  async addEpisode(params: {
    name: string;
    episodeBody: string;
    groupId?: string;
    source?: "text" | "json" | "message";
    sourceDescription?: string;
  }): Promise<void> {
    await this.addMemory(params);
  }

  async searchMemoryFacts(params: {
    query: string;
    groupIds?: string[];
    maxFacts?: number;
  }): Promise<GraphitiFact[]> {
    try {
      const result = await this.callTool("search_memory_facts", {
        query: params.query,
        group_ids: params.groupIds,
        max_facts: params.maxFacts ?? 10,
      });
      return this.parseWrappedArray<GraphitiFact>(result, "facts") ?? [];
    } catch (err) {
      if (
        isGraphitiTimeoutError(err) ||
        isGraphitiOfflineError(err) ||
        err instanceof GraphitiTransportError ||
        err instanceof GraphitiSessionExpiredError
      ) {
        notifyGraphitiAvailabilityIssue(
          "Graphiti unavailable; continuing without memory facts.",
          {
            operation: "searchMemoryFacts",
            err,
          },
        );
        return [];
      }
      logger.error("searchMemoryFacts error", err);
      return [];
    }
  }

  async searchFacts(params: {
    query: string;
    groupIds?: string[];
    maxFacts?: number;
  }): Promise<GraphitiFact[]> {
    return await this.searchMemoryFacts(params);
  }

  async searchNodes(params: {
    query: string;
    groupIds?: string[];
    maxNodes?: number;
  }): Promise<GraphitiNode[]> {
    const result = await this.searchNodesWithStatus(params);
    return result.nodes;
  }

  async searchNodesWithStatus(params: {
    query: string;
    groupIds?: string[];
    maxNodes?: number;
  }): Promise<GraphitiNodeSearchResult> {
    try {
      const result = await this.callTool("search_nodes", {
        query: params.query,
        group_ids: params.groupIds,
        max_nodes: params.maxNodes ?? 10,
      });
      return {
        nodes: this.parseWrappedArray<GraphitiNode>(result, "nodes") ?? [],
        degraded: false,
      };
    } catch (err) {
      if (
        isGraphitiTimeoutError(err) ||
        isGraphitiOfflineError(err) ||
        err instanceof GraphitiTransportError ||
        err instanceof GraphitiSessionExpiredError
      ) {
        notifyGraphitiAvailabilityIssue(
          "Graphiti unavailable; continuing without memory nodes.",
          {
            operation: "searchNodesWithStatus",
            err,
          },
        );
        return { nodes: [], degraded: true };
      }
      logger.error("searchNodes error", err);
      return { nodes: [], degraded: true };
    }
  }

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
      if (
        isGraphitiTimeoutError(err) ||
        isGraphitiOfflineError(err) ||
        err instanceof GraphitiTransportError ||
        err instanceof GraphitiSessionExpiredError
      ) {
        notifyGraphitiAvailabilityIssue(
          "Graphiti unavailable; continuing without episode history.",
          {
            operation: "getEpisodes",
            err,
          },
        );
        return [];
      }
      logger.error("getEpisodes error", err);
      return [];
    }
  }

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
