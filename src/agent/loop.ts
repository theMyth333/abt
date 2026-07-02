// src/agent/loop.ts
// The core agent loop — the "brain" of the harness.
//
// Control flow:
//   user message
//     → trim context
//     → call Ollama
//     → if tool_calls: execute tools, append results, loop back
//     → if no tool_calls: return final answer to user
//
// This loop is what makes the system "agentic" rather than single-shot:
// the model can call tools repeatedly until it has enough information
// to produce a final answer, without returning to the user in between.

import { OllamaClient } from "../ollama/client.ts";
import type { ChatMessage, ToolCall, ToolDefinition } from "../ollama/types.ts";
import { toolRegistry, toolDefinitions } from "../tools/index.ts";
import { fit } from "./contextManager.ts";
import { buildSystemPrompt } from "./systemPrompt.ts";
import { SessionTranscript } from "../storage/session.ts";
import { getMemorySummary, ensureMemoryFile } from "../storage/memory.ts";
import { getSkillsSummary, ensureSkillsFile } from "../storage/skills.ts";
import type { McpClientManager } from "../mcp/client.ts";

export interface AgentConfig {
  client: OllamaClient;
  maxIterations?: number;
  keepLast?: number;
  // When set, called with each streamed content chunk during the final answer.
  // If omitted, the loop falls back to non-streaming.
  onChunk?: (chunk: string) => void;
  // When set, called with each streamed thinking chunk (thinking models only).
  onThinkingChunk?: (chunk: string) => void;
  mcpManager?: McpClientManager;
}

export class AgentLoop {
  private readonly client: OllamaClient;
  private readonly maxIterations: number;
  private readonly keepLast: number;
  private readonly onChunk?: (chunk: string) => void;
  private readonly onThinkingChunk?: (chunk: string) => void;
  private readonly mcpManager?: McpClientManager;

  // messages is the live in-memory conversation history.
  // It starts with the system message and grows with each turn.
  private messages: ChatMessage[] = [];
  private transcript: SessionTranscript;

  constructor(config: AgentConfig) {
    this.client = config.client;
    this.maxIterations = config.maxIterations ?? 15;
    this.keepLast = config.keepLast ?? 10;
    this.onChunk = config.onChunk;
    this.onThinkingChunk = config.onThinkingChunk;
    this.mcpManager = config.mcpManager;
    this.transcript = new SessionTranscript();
  }

  // Initialize the loop: create memory.md if absent, load its contents,
  // and set up the system message. Call this once before the first turn.
  async initialize(): Promise<void> {
    await ensureMemoryFile();
    await ensureSkillsFile();
    const memorySummary = await getMemorySummary();
    const skillsSummary = await getSkillsSummary();

    const systemContent = buildSystemPrompt({
      cwd: process.cwd(),
      memorySummary,
      skillsSummary,
      model: this.client.getModel(),
    });

    this.messages = [{ role: "system", content: systemContent }];
  }

  // Process a single user turn. Returns the final assistant text response.
  async turn(userInput: string): Promise<string> {
    // Append the user message to history and transcript
    const userMsg: ChatMessage = { role: "user", content: userInput };
    this.messages.push(userMsg);
    await this.transcript.writeUser(userInput);

    let iterations = 0;

    // ── Agentic loop ────────────────────────────────────────────────────────
    // We loop back here after every batch of tool calls. The loop only exits
    // when the model produces a message with no tool_calls (the final answer)
    // or when we hit the iteration limit.
    while (iterations < this.maxIterations) {
      iterations++;

      // Trim context to fit within the model's context window before sending.
      const fittedMessages = fit(this.messages, this.client.getNumCtx(), {
        keepLast: this.keepLast,
      });

      // Build the full tool list: built-ins + any MCP tools
      const allTools: ToolDefinition[] = [
        ...toolDefinitions,
        ...(this.mcpManager?.getToolDefinitions() ?? []),
      ];

      // Call Ollama. On the final-answer turn (when onChunk is set) we stream so
      // the caller can print tokens as they arrive. Tool-call turns always use
      // non-streaming because we need the complete tool_calls array up front.
      let response;
      try {
        response = await this.client.chat({
          messages: fittedMessages,
          tools: allTools,
        });
      } catch (err) {
        const errMsg = `Failed to call Ollama: ${String(err)}`;
        console.error(`[loop] ${errMsg}`);
        return errMsg;
      }

      const assistantMsg = response.message;

      // ── Tool calls branch ──────────────────────────────────────────────────
      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
        // Append the assistant's tool-call message to history.
        // This message MUST come before the tool results — Ollama requires the
        // assistant turn that initiated a call to appear before its response.
        this.messages.push({
          role: "assistant",
          content: assistantMsg.content ?? "",
          tool_calls: assistantMsg.tool_calls,
        });

        // Execute each tool call and collect results
        for (const call of assistantMsg.tool_calls) {
          const result = await this.executeToolCall(call);

          // Append the tool result as a `tool` role message.
          // The `tool` role is how Ollama knows this content is a tool response,
          // not user input — the role tells the model where the data came from.
          const toolMsg: ChatMessage = {
            role: "tool",
            content: result.content,
            name: call.function.name,
            // tool_call_id links this result back to the specific call that produced it.
            // Ollama uses this to match multi-tool responses correctly.
            tool_call_id: call.id ?? call.function.name,
          };
          this.messages.push(toolMsg);

          // Write to transcript
          if (result.isError) {
            await this.transcript.writeToolError(call, result.content);
          } else {
            await this.transcript.writeToolCall(call, result.content);
          }
        }

        // Loop back — the model will now see the tool results and decide
        // whether to call more tools or produce a final answer.
        continue;
      }

      // ── Final answer branch ────────────────────────────────────────────────
      // No tool calls means this is the model's final response to the user.
      // If onChunk is set, re-run as a streaming call so the caller can print
      // tokens live. The non-streaming response we already have is discarded
      // only in this branch — it was needed above to detect tool_calls first.
      let finalContent: string;

      if (this.onChunk) {
        finalContent = "";
        try {
          for await (const chunk of this.client.chatStream({
            messages: fittedMessages,
            tools: allTools,
          })) {
            if (chunk.message.thinking && this.onThinkingChunk) {
              this.onThinkingChunk(chunk.message.thinking);
            }
            if (chunk.message.content) {
              finalContent += chunk.message.content;
              this.onChunk(chunk.message.content);
            }
          }
        } catch (err) {
          const errMsg = `Failed to stream from Ollama: ${String(err)}`;
          console.error(`[loop] ${errMsg}`);
          return errMsg;
        }
      } else {
        finalContent = assistantMsg.content ?? "(no response)";
      }

      this.messages.push({ role: "assistant", content: finalContent });
      await this.transcript.writeAssistant(finalContent);

      if (iterations > 1) {
        // Let the user know how many tool-call rounds it took
        console.error(`[loop] Completed in ${iterations - 1} tool-call iteration(s).`);
      }

      return finalContent;
    }

    // ── Iteration limit hit ────────────────────────────────────────────────
    // This is a safety valve against infinite tool-call loops. The model might
    // get stuck calling the same tool repeatedly if it's not converging.
    const limitMsg =
      `[Agent stopped: reached the ${this.maxIterations}-iteration limit without producing ` +
      `a final answer. This usually means the model is stuck in a tool-call loop. ` +
      `Try rephrasing your request or check the session transcript for details.]`;

    this.messages.push({ role: "assistant", content: limitMsg });
    await this.transcript.writeAssistant(limitMsg);
    return limitMsg;
  }

  // Execute a single tool call: look up the handler, run it, return a result.
  // Errors are caught and returned as error strings so the model can self-correct —
  // we never let tool errors crash the loop.
  private async executeToolCall(
    call: ToolCall
  ): Promise<{ content: string; isError: boolean }> {
    const toolName = call.function.name;

    console.error(`[tool] Calling ${toolName}(${JSON.stringify(call.function.arguments)})`);

    // Route MCP tools to the manager
    if (toolName.startsWith("mcp__")) {
      if (!this.mcpManager) {
        return { content: `No MCP manager available to handle tool "${toolName}"`, isError: true };
      }
      try {
        const result = await this.mcpManager.callTool(toolName, call.function.arguments);
        return { content: result, isError: false };
      } catch (err) {
        const errMsg = `MCP tool "${toolName}" threw an error: ${String(err)}`;
        console.error(`[tool] ${errMsg}`);
        return { content: errMsg, isError: true };
      }
    }

    const registered = toolRegistry[toolName];

    if (!registered) {
      const errMsg = `Unknown tool: "${toolName}". Available tools: ${Object.keys(toolRegistry).join(", ")}`;
      console.error(`[tool] ${errMsg}`);
      return { content: errMsg, isError: true };
    }

    try {
      const result = await registered.handler(call.function.arguments);
      return { content: result, isError: false };
    } catch (err) {
      const errMsg = `Tool "${toolName}" threw an error: ${String(err)}`;
      console.error(`[tool] ${errMsg}`);
      return { content: errMsg, isError: true };
    }
  }

  getTranscriptPath(): string {
    return this.transcript.getPath();
  }
}
