// src/storage/memory.ts
// Manages memory.md — the agent's durable long-term memory store.
// memory.md is plain markdown: a human-readable, append-only log of things
// the agent has decided are worth remembering across sessions.
// The agent writes to it via the save_memory tool; it's read at startup.

import { resolve } from "node:path";

const MEMORY_PATH = resolve(process.cwd(), "memory.md");

const INITIAL_MEMORY = `# Agent Memory

This file stores notes the agent has saved for future sessions.
It is read at startup and summarized into the system prompt.

---
`;

// Read the full contents of memory.md.
// Returns null if the file doesn't exist yet (first run).
export async function readMemory(): Promise<string | null> {
  const file = Bun.file(MEMORY_PATH);
  const exists = await file.exists();
  if (!exists) return null;
  return file.text();
}

// Create memory.md with the default template if it doesn't exist.
export async function ensureMemoryFile(): Promise<void> {
  const file = Bun.file(MEMORY_PATH);
  const exists = await file.exists();
  if (!exists) {
    await Bun.write(MEMORY_PATH, INITIAL_MEMORY);
  }
}

// Append a timestamped note to memory.md.
// Notes are separated by horizontal rules so they're easy to scan.
export async function appendMemory(note: string): Promise<void> {
  await ensureMemoryFile();

  const existing = await Bun.file(MEMORY_PATH).text();
  const timestamp = new Date().toISOString();
  const entry = `\n**[${timestamp}]** ${note}\n`;

  await Bun.write(MEMORY_PATH, existing + entry);
}

// Produce a compact one-paragraph summary of memory.md for injection into the system prompt.
// If memory is short enough, returns the whole thing. Otherwise truncates and notes the cutoff.
export async function getMemorySummary(): Promise<string> {
  const content = await readMemory();
  if (!content) return "(no memory yet)";

  // Strip the file header (everything before and including the first ---)
  const afterHr = content.split("---").slice(1).join("---").trim();
  if (!afterHr) return "(no memory notes yet)";

  // If it fits in ~1500 chars, return as-is
  if (afterHr.length <= 1500) return afterHr;

  // Otherwise, take the most recent entries (tail of the file)
  return (
    "... (older entries truncated) ...\n\n" +
    afterHr.slice(afterHr.length - 1500)
  );
}
