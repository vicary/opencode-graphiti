import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logger } from "./logger.ts";
import type {
  GraphitiEpisode,
  GraphitiFact,
  GraphitiNode,
} from "../types/index.ts";

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
    const result = await this.client.callTool({ name, arguments: args });
    if (
      result.content && Array.isArray(result.content) &&
      result.content.length > 0
    ) {
      const textContent = result.content.find((content: { type?: string }) =>
        content.type === "text"
      );
      if (textContent && "text" in textContent) {
        try {
          return JSON.parse(textContent.text as string);
        } catch {
          return textContent.text;
        }
      }
    }
    return result;
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
      return (result as GraphitiFact[]) || [];
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
      return (result as GraphitiNode[]) || [];
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
