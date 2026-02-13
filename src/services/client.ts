import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import manifest from "../../deno.json" with { type: "json" };
import type {
  GraphitiEpisode,
  GraphitiFact,
  GraphitiFactsResponse,
  GraphitiNode,
  GraphitiNodesResponse,
} from "../types/index.ts";
import { logger } from "./logger.ts";

/**
 * Graphiti MCP client wrapper for connecting, querying,
 * and persisting episodes with basic reconnection handling.
 */
export class GraphitiClient {
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  private connected = false;
  private endpoint: string;

  /**
   * Create a Graphiti client bound to the given MCP endpoint URL.
   */
  constructor(endpoint: string) {
    this.endpoint = endpoint;
    this.client = new Client({
      name: manifest.name,
      version: manifest.version,
    });
    this.transport = new StreamableHTTPClientTransport(new URL(endpoint));
  }

  /** Create a fresh MCP Client and Transport pair. */
  private createClientAndTransport(): void {
    this.client = new Client({
      name: manifest.name,
      version: manifest.version,
    });
    this.transport = new StreamableHTTPClientTransport(
      new URL(this.endpoint),
    );
  }

  /**
   * Establish a connection to the Graphiti MCP server.
   * Creates a fresh Client/Transport if a previous attempt failed.
   */
  async connect(): Promise<boolean> {
    if (this.connected) return true;
    // If a previous connect() tainted the Client's internal state,
    // create fresh instances so the retry starts cleanly.
    this.createClientAndTransport();
    try {
      await this.client.connect(this.transport);
      this.connected = true;
      logger.info("Connected to Graphiti MCP server at", this.endpoint);
      return true;
    } catch (err) {
      logger.error("Failed to connect to Graphiti:", err);
      return false;
    }
  }

  /**
   * Close the underlying MCP client connection.
   */
  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.connected) {
      const ok = await this.connect();
      if (!ok) throw new Error("Not connected to Graphiti");
    }

    // Sanitize arguments: omit task_id (and others) if null or undefined
    const sanitizedArgs = Object.fromEntries(
      Object.entries(args).filter(([_, v]) => v !== null && v !== undefined),
    );

    try {
      const result = await this.client.callTool({
        name,
        arguments: sanitizedArgs,
      });
      return this.parseToolResult(result);
    } catch (err) {
      if (this.isSessionExpired(err)) {
        logger.warn("Graphiti session expired, reconnecting...");
        await this.reconnect();
        const result = await this.client.callTool({
          name,
          arguments: sanitizedArgs,
        });
        return this.parseToolResult(result);
      }
      throw err;
    }
  }

  private isSessionExpired(err: unknown): boolean {
    return !!(
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 404
    );
  }

  private async reconnect(): Promise<void> {
    this.connected = false;
    try {
      await this.client.close();
    } catch {
      // ignore close errors on stale client
    }
    this.createClientAndTransport();
    await this.client.connect(this.transport);
    this.connected = true;
    logger.info("Reconnected to Graphiti MCP server");
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
   * Add an episode to Graphiti memory.
   */
  async addEpisode(params: {
    name: string;
    episodeBody: string;
    groupId?: string;
    source?: "text" | "json" | "message";
    sourceDescription?: string;
  }): Promise<void> {
    await this.callTool("add_memory", {
      name: params.name,
      episode_body: params.episodeBody,
      group_id: params.groupId,
      source: params.source || "text",
      source_description: params.sourceDescription || "",
    });
    logger.debug("Added episode:", params.name);
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
      if (Array.isArray(result)) return result as GraphitiFact[];
      if (
        result &&
        typeof result === "object" &&
        Array.isArray((result as GraphitiFactsResponse).facts)
      ) {
        return (result as GraphitiFactsResponse).facts;
      }
      return [];
    } catch (err) {
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
      if (Array.isArray(result)) return result as GraphitiNode[];
      if (
        result &&
        typeof result === "object" &&
        Array.isArray((result as GraphitiNodesResponse).nodes)
      ) {
        return (result as GraphitiNodesResponse).nodes;
      }
      return [];
    } catch (err) {
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
      if (Array.isArray(result)) return result as GraphitiEpisode[];
      if (
        result &&
        typeof result === "object" &&
        Array.isArray((result as { episodes?: unknown }).episodes)
      ) {
        return (result as { episodes: GraphitiEpisode[] }).episodes;
      }
      return [];
    } catch (err) {
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
}
