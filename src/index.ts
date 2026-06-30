// src/index.ts
// CLI entrypoint for the coding agent harness.
// Starts a simple REPL: read a line from stdin, run it through the agent loop, print the response.
// Press Ctrl+C or type "exit" / "quit" to stop.

import * as readline from "node:readline";
import { OllamaClient } from "./ollama/client.ts";
import { AgentLoop } from "./agent/loop.ts";
import { McpClientManager } from "./mcp/client.ts";
import type { McpServerConfig } from "./mcp/types.ts";

// ── Config from environment ──────────────────────────────────────────────────
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "gemma4:12b";
const HARNESS_NUM_CTX = parseInt(process.env.HARNESS_NUM_CTX ?? "32768", 10);
const HARNESS_MAX_ITER = parseInt(process.env.HARNESS_MAX_ITER ?? "15", 10);
const HARNESS_KEEP_LAST = parseInt(process.env.HARNESS_KEEP_LAST ?? "10", 10);

function parseMcpServers(): McpServerConfig[] {
  const raw = process.env.MCP_SERVERS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("MCP_SERVERS must be a JSON array");
    return parsed as McpServerConfig[];
  } catch (err) {
    console.error(`[mcp] Invalid MCP_SERVERS env var: ${String(err)}`);
    return [];
  }
}

// ── ANSI helpers (minimal — avoids pulling in a dependency) ──────────────────
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

async function main() {
  // ── Startup banner ─────────────────────────────────────────────────────────
  console.log(bold("\n  Coding Agent Harness"));
  console.log(dim("  ─────────────────────────────────────────────"));
  console.log(`  ${dim("host:")}    ${OLLAMA_HOST}`);
  console.log(`  ${dim("model:")}   ${OLLAMA_MODEL}`);
  console.log(`  ${dim("num_ctx:")} ${HARNESS_NUM_CTX.toLocaleString()} tokens`);
  console.log(`  ${dim("max_iter:")} ${HARNESS_MAX_ITER}`);
  console.log(`  ${dim("cwd:")}     ${process.cwd()}`);
  console.log(dim("  ─────────────────────────────────────────────\n"));

  // ── Verify Ollama is reachable and the model is pulled ────────────────────
  const client = new OllamaClient(OLLAMA_HOST, OLLAMA_MODEL, HARNESS_NUM_CTX);

  process.stdout.write(dim("  Checking Ollama connection... "));
  try {
    const info = await client.show();
    console.log(
      green("OK") +
        dim(` (${info.details.parameter_size}, ${info.details.quantization_level})`)
    );
  } catch (err) {
    console.log(red("FAILED"));
    console.error(`\n  ${red("Error:")} ${String(err)}`);
    console.error(
      dim(
        `\n  Make sure Ollama is running and the model is pulled:\n` +
          `    ollama serve\n` +
          `    ollama pull ${OLLAMA_MODEL}\n`
      )
    );
    process.exit(1);
  }

  // ── Initialize agent loop ─────────────────────────────────────────────────
  const mcpServers = parseMcpServers();
  const mcpManager = new McpClientManager();

  if (mcpServers.length > 0) {
    process.stdout.write(dim("  Connecting to MCP servers... "));
    await mcpManager.connect(mcpServers);
    if (mcpManager.connectedCount > 0) {
      console.log(green("OK") + dim(` (${mcpManager.getSummary()})`));
    } else {
      console.log(red("FAILED") + dim(" (all servers failed to connect)"));
    }
  }

  const agent = new AgentLoop({
    client,
    maxIterations: HARNESS_MAX_ITER,
    keepLast: HARNESS_KEEP_LAST,
    mcpManager: mcpManager.connectedCount > 0 ? mcpManager : undefined,
  });

  await agent.initialize();

  console.log(dim(`  Transcript: ${agent.getTranscriptPath()}`));
  console.log(dim("  Type your message and press Enter. Ctrl+C or 'exit' to quit.\n"));

  // ── REPL ──────────────────────────────────────────────────────────────────
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    // This disables readline's default Ctrl+C handling so we can do it ourselves
    terminal: true,
  });

  // Clean exit on Ctrl+C
  rl.on("SIGINT", async () => {
    console.log(dim("\n\n  Goodbye.\n"));
    await mcpManager.close();
    process.exit(0);
  });

  // Prompt-and-response loop using a recursive async function so each turn
  // can await the agent's (potentially long-running) response before prompting again.
  const promptUser = () => {
    rl.question(cyan("\nYou: "), async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        promptUser();
        return;
      }

      if (trimmed === "exit" || trimmed === "quit") {
        console.log(dim("\n  Goodbye.\n"));
        rl.close();
        await mcpManager.close();
        process.exit(0);
      }

      // Run the agent turn. The loop handles tool calls internally;
      // we only get the final answer back here.
      try {
        const response = await agent.turn(trimmed);
        console.log(`\n${bold("Agent:")} ${response}\n`);
      } catch (err) {
        console.error(`\n${red("Loop error:")} ${String(err)}\n`);
      }

      promptUser(); // recurse for next turn
    });
  };

  promptUser();
}

main().catch((err) => {
  console.error(red(`Fatal: ${String(err)}`));
  process.exit(1);
});
