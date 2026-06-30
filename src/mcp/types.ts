export interface McpServerConfig {
  name: string;
  transport: "stdio" | "sse";
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // sse
  url?: string;
}
