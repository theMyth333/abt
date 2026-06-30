// src/ollama/client.ts
// Thin HTTP wrapper around Ollama's /api/chat endpoint.
// All actual intelligence about *when* to call and *what* to send lives in the agent loop.
// This module only handles the network boundary: serialization, error handling, and response parsing.

import type {
  ChatRequest,
  ChatResponse,
  ShowResponse,
} from "./types.ts";

export class OllamaClient {
  private readonly host: string;
  private readonly model: string;
  private readonly numCtx: number;

  constructor(host: string, model: string, numCtx: number) {
    this.host = host.replace(/\/$/, ""); // strip trailing slash
    this.model = model;
    this.numCtx = numCtx;
  }

  // Send a chat request. Returns the full parsed response (stream: false).
  // Throws a descriptive error if the HTTP call fails or Ollama returns an error body.
  async chat(request: Omit<ChatRequest, "model" | "stream">): Promise<ChatResponse> {
    const body: ChatRequest = {
      ...request,
      model: this.model,
      stream: false,
      // Merge our num_ctx into options so it's always present.
      // Without num_ctx, Ollama silently truncates context to 4K — a footgun that
      // makes long conversations appear to "forget" earlier context.
      options: {
        num_ctx: this.numCtx,
        ...request.options,
      },
    };

    let response: Response;
    try {
      response = await fetch(`${this.host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `Failed to reach Ollama at ${this.host}. Is it running? (${String(err)})`
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "(unreadable body)");
      throw new Error(
        `Ollama returned HTTP ${response.status}: ${text}`
      );
    }

    const data = (await response.json()) as ChatResponse;
    return data;
  }

  // Fetch metadata about the loaded model (parameter count, quantization, etc).
  // Used at startup to confirm the model is available before the REPL starts.
  async show(): Promise<ShowResponse> {
    const response = await fetch(`${this.host}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: this.model }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "(unreadable body)");
      throw new Error(
        `Could not load model info for "${this.model}". Is the model pulled? (HTTP ${response.status}: ${text})`
      );
    }

    return (await response.json()) as ShowResponse;
  }

  getModel(): string {
    return this.model;
  }

  getHost(): string {
    return this.host;
  }

  getNumCtx(): number {
    return this.numCtx;
  }
}
