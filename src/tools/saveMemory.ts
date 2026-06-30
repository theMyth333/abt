// src/tools/saveMemory.ts
// Tool: save_memory
// Appends a note to memory.md — the agent's durable long-term memory.
// Use this when you learn something worth persisting across sessions:
// user preferences, project conventions, recurring patterns, etc.

import type { ToolDefinition } from "../ollama/types.ts";
import { appendMemory } from "../storage/memory.ts";

export const saveMemoryDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "save_memory",
    description:
      "Persist a note to long-term memory (memory.md). Use when you learn something worth remembering across sessions: user preferences, project conventions, key decisions, etc. Keep notes concise.",
    parameters: {
      type: "object",
      properties: {
        note: {
          type: "string",
          description:
            "The note to save. One to three sentences. Be specific — vague notes are useless later.",
        },
      },
      required: ["note"],
    },
  },
};

export async function saveMemoryHandler(args: Record<string, unknown>): Promise<string> {
  const note = args.note as string;

  if (!note || typeof note !== "string") {
    throw new Error("save_memory requires a 'note' argument (string).");
  }

  await appendMemory(note);
  return `Memory saved: "${note}"`;
}
