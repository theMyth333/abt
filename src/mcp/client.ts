// src/mcp/client.ts
// MCP client manager — connects to one or more MCP servers, discovers their tools,
// and makes them callable through the same interface as built-in tools.
//
// Tools from MCP servers are namespaced as `mcp__<serverName>__<toolName>` so they
// never collide with built-in tool names.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpServerConfig } from "./types.ts";
import type { ToolDefinition } from "../ollama/types.ts";

const MCP_PREFIX = "mcp__";

interface ConnectedServer {
  name: string;
  client: Client;
  toolNames: Set<string>; // original (unprefixed) names
}

export class McpClientManager {
  private servers: ConnectedServer[] = [];
  private definitions: ToolDefinition[] = [];

  // Connect to all configured servers. Failures are logged and skipped — a broken
  // MCP server should not prevent the harness from starting.
  async connect(configs: McpServerConfig[]): Promise<void> {
    for (const cfg of configs) {
      try {
        await this.connectOne(cfg);
      } catch (err) {
        console.error(`[mcp] Failed to connect to "${cfg.name}": ${String(err)}`);
      }
    }
  }

  private async connectOne(cfg: McpServerConfig): Promise<void> {
    const client = new Client({ name: "harness", version: "0.1.0" });

    if (cfg.transport === "stdio") {
      if (!cfg.command) throw new Error(`stdio transport requires "command"`);
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: cfg.env,
      });
      await client.connect(transport);
    } else if (cfg.transport === "sse") {
      if (!cfg.url) throw new Error(`sse transport requires "url"`);
      const transport = new SSEClientTransport(new URL(cfg.url));
      await client.connect(transport);
    } else {
      throw new Error(`Unknown transport: ${(cfg as McpServerConfig).transport}`);
    }

    const { tools } = await client.listTools();
    const toolNames = new Set(tools.map((t) => t.name));

    this.servers.push({ name: cfg.name, client, toolNames });

    // Convert MCP tool schemas to harness ToolDefinition format and add to our list.
    for (const tool of tools) {
      const prefixed = `${MCP_PREFIX}${cfg.name}__${tool.name}`;
      this.definitions.push({
        type: "function",
        function: {
          name: prefixed,
          description: `[${cfg.name}] ${tool.description ?? tool.name}`,
          // MCP inputSchema is already a JSON Schema object; cast to our type.
          parameters: (tool.inputSchema as ToolDefinition["function"]["parameters"]) ?? {
            type: "object",
            properties: {},
          },
        },
      });
    }

    console.error(`[mcp] Connected to "${cfg.name}" (${tools.length} tool${tools.length === 1 ? "" : "s"})`);
  }

  // All tool definitions to merge into the Ollama tool list.
  getToolDefinitions(): ToolDefinition[] {
    return this.definitions;
  }

  // Summary string for the startup banner, e.g. "fs (3 tools), git (2 tools)".
  getSummary(): string {
    return this.servers
      .map((s) => `${s.name} (${s.toolNames.size} tool${s.toolNames.size === 1 ? "" : "s"})`)
      .join(", ");
  }

  // Call a prefixed MCP tool. Returns the result as a string.
  async callTool(prefixedName: string, args: Record<string, unknown>): Promise<string> {
    // Strip `mcp__<serverName>__` prefix
    const withoutPrefix = prefixedName.slice(MCP_PREFIX.length);
    const sepIdx = withoutPrefix.indexOf("__");
    if (sepIdx === -1) throw new Error(`Malformed MCP tool name: "${prefixedName}"`);

    const serverName = withoutPrefix.slice(0, sepIdx);
    const toolName = withoutPrefix.slice(sepIdx + 2);

    const server = this.servers.find((s) => s.name === serverName);
    if (!server) throw new Error(`No connected MCP server named "${serverName}"`);
    if (!server.toolNames.has(toolName)) {
      throw new Error(`Server "${serverName}" has no tool named "${toolName}"`);
    }

    const result = await server.client.callTool({ name: toolName, arguments: args });

    // Flatten ContentBlock[] → string
    const parts: string[] = [];
    for (const block of result.content as Array<{ type: string; text?: string }>) {
      if (block.type === "text" && block.text) {
        parts.push(block.text);
      } else {
        parts.push(`[${block.type} content]`);
      }
    }
    return parts.join("\n") || "(empty result)";
  }

  async close(): Promise<void> {
    for (const server of this.servers) {
      try {
        await server.client.close();
      } catch {
        // best-effort
      }
    }
    this.servers = [];
    this.definitions = [];
  }

  get connectedCount(): number {
    return this.servers.length;
  }
}
