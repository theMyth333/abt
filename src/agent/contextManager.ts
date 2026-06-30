// src/agent/contextManager.ts
// Manages the message history that gets sent to Ollama on each request.
//
// Why this exists:
// LLMs have a finite context window. If we naively append every message forever,
// we'll eventually exceed num_ctx and either get an error or silent truncation.
// The strategy here is: always preserve the system message + the most recent N
// messages unchanged (so the model has immediate context), and summarize/drop
// older messages to reclaim space.

import type { ChatMessage } from "../ollama/types.ts";

// Rough token estimate: production systems use a proper tokenizer (tiktoken, etc).
// `chars / 4` is a common approximation for English text and is close enough for
// triggering the trim — we add a 30% safety margin anyway.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function messageTokens(msg: ChatMessage): number {
  let text = msg.content;
  if (msg.tool_calls) {
    text += JSON.stringify(msg.tool_calls);
  }
  return estimateTokens(text);
}

function totalTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0);
}

export interface FitOptions {
  // Keep at least this many messages at the tail of the history untouched.
  keepLast?: number;
  // Fire trimming when estimated usage exceeds this fraction of numCtx.
  trimThreshold?: number;
}

// Fit messages into numCtx tokens, summarizing/dropping old messages as needed.
// Returns a new array — never mutates the input.
export function fit(
  messages: ChatMessage[],
  numCtx: number,
  options: FitOptions = {}
): ChatMessage[] {
  const keepLast = options.keepLast ?? 10;
  const trimThreshold = options.trimThreshold ?? 0.7;

  // Nothing to do if we're under the threshold
  const budget = Math.floor(numCtx * trimThreshold);
  if (totalTokens(messages) <= budget) return [...messages];

  // Invariants:
  // messages[0] is always the system message — never drop it.
  // The most recent `keepLast` messages are always preserved verbatim.
  const systemMsg = messages[0]!;
  const recent = messages.slice(Math.max(1, messages.length - keepLast));
  const older = messages.slice(1, Math.max(1, messages.length - keepLast));

  if (older.length === 0) {
    // Can't trim further — return as-is and let Ollama handle overflow
    return [...messages];
  }

  // Build a "summarized history" block from the older messages.
  // Each message becomes a one-liner: role + first 200 chars of content.
  // TODO: replace with LLM-generated summary for production use —
  // a cheap summarization call would give the model meaningful context instead of raw truncation.
  const summaryLines = older.map((m) => {
    const preview = m.content.slice(0, 200).replace(/\n+/g, " ");
    const suffix = m.content.length > 200 ? "..." : "";
    return `[${m.role}] ${preview}${suffix}`;
  });

  const summaryMessage: ChatMessage = {
    role: "user",
    content:
      `[Summarized history — ${older.length} earlier messages]\n\n` +
      summaryLines.join("\n"),
  };

  // Assemble: system + summary block + recent messages
  const trimmed = [systemMsg, summaryMessage, ...recent];

  // Log so the user can see trimming happened (helpful for learning the mechanics)
  const before = totalTokens(messages);
  const after = totalTokens(trimmed);
  console.error(
    `[context] Trimmed ${messages.length} → ${trimmed.length} messages ` +
      `(~${before} → ~${after} estimated tokens, budget: ${budget})`
  );

  return trimmed;
}
