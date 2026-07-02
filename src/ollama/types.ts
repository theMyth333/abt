// src/ollama/types.ts
// Type definitions for Ollama's /api/chat endpoint — request shape, response shape,
// and the tool/tool_call structures that drive agentic tool use.

// ─── Tool definition (sent to Ollama so it knows what tools exist) ────────────

export interface ToolParameterSchema {
  type: string;
  description?: string;
  enum?: string[];
  items?: ToolParameterSchema;
}

export interface ToolParameters {
  type: "object";
  properties: Record<string, ToolParameterSchema>;
  required?: string[];
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolParameters;
  };
}

// ─── Message shapes ───────────────────────────────────────────────────────────

// A single tool call as returned by the model inside an assistant message.
export interface ToolCall {
  id?: string;                     // Ollama may omit this; we generate one if absent
  type: "function";
  function: {
    name: string;
    arguments: Record<string, unknown>; // already parsed JSON from Ollama
  };
}

// The four roles Ollama's chat API understands.
export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: MessageRole;
  content: string;
  thinking?: string;               // only on assistant messages from thinking models
  tool_calls?: ToolCall[];         // only on assistant messages
  tool_call_id?: string;           // only on tool messages (matches ToolCall.id)
  name?: string;                   // tool name, used on tool-role messages
}

// ─── /api/chat request ────────────────────────────────────────────────────────

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  stream: boolean;                 // we use false (non-streaming) in this harness
  options?: {
    num_ctx?: number;              // CRITICAL: without this, Ollama caps at 4K context
    temperature?: number;
    [key: string]: unknown;
  };
}

// ─── /api/chat response (stream: false) ──────────────────────────────────────

export interface ChatResponse {
  model: string;
  created_at: string;
  message: ChatMessage;
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  eval_count?: number;             // tokens generated
  prompt_eval_count?: number;      // tokens in the prompt
}

// ─── /api/show response ──────────────────────────────────────────────────────

export interface ShowResponse {
  modelfile: string;
  parameters: string;
  template: string;
  details: {
    family: string;
    parameter_size: string;
    quantization_level: string;
  };
}
