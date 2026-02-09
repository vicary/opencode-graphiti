import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  GraphitiEpisode,
  GraphitiFact,
  GraphitiFactsResponse,
  GraphitiNode,
  GraphitiNodesResponse,
} from "../types/index.ts";
import { logger } from "./logger.ts";

export class GraphitiClient {
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  private connected = false;
  private endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
    this.client = new Client({ name: "opencode-graphiti", version: "0.1.0" });
    const url = new (globalThis as unknown as {
      URL: new (input: string) => { href: string } & URL;
    }).URL(endpoint);
    this.transport = new StreamableHTTPClientTransport(url);
  }

  async connect(): Promise<boolean> {
    if (this.connected) return true;
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
      await this.transport.close();
    } catch {
      // ignore transport close errors
    }
    this.transport = new StreamableHTTPClientTransport(
      new URL(this.endpoint),
    );
    await this.client.connect(this.transport);
    this.connected = true;
    logger.info("Reconnected to Graphiti MCP server");
  }

  // Public for testing
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

  async getEpisodes(params: {
    groupIds?: string[];
    maxEpisodes?: number;
  }): Promise<GraphitiEpisode[]> {
    try {
      const result = await this.callTool("get_episodes", {
        group_ids: params.groupIds,
        max_episodes: params.maxEpisodes || 10,
      });
      return (result as GraphitiEpisode[]) || [];
    } catch (err) {
      logger.error("getEpisodes error:", err);
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
}
