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

  // Stream a chat request. Yields content and thinking chunks as they arrive;
  // the final chunk (done: true) carries tool_calls if the model requested any.
  // Usage: for await (const chunk of client.chatStream(req)) {
  //   process.stdout.write(chunk.message.content)      // answer text
  //   process.stdout.write(chunk.message.thinking ?? "") // reasoning (thinking models only)
  // }
  async *chatStream(
    request: Omit<ChatRequest, "model" | "stream">
  ): AsyncGenerator<ChatResponse> {
    const body: ChatRequest = {
      ...request,
      model: this.model,
      stream: true,
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
      throw new Error(`Ollama returned HTTP ${response.status}: ${text}`);
    }

    if (!response.body) {
      throw new Error("Ollama returned an empty response body for streaming.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last (possibly incomplete) line in the buffer.
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const chunk = JSON.parse(trimmed) as ChatResponse;
        yield chunk;
        if (chunk.done) return;
      }
    }

    // Flush any remaining bytes in the decoder.
    const remaining = decoder.decode();
    if (remaining.trim()) {
      yield JSON.parse(remaining.trim()) as ChatResponse;
    }
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
