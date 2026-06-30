// src/storage/session.ts
// Append-only session transcript writer.
// Each run of the CLI gets its own markdown file under sessions/<timestamp>.md.
// Transcripts are human-readable: open them in any markdown viewer to replay what happened.

import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import type { ToolCall } from "../ollama/types.ts";

const SESSIONS_DIR = resolve(process.cwd(), "sessions");

// Generate the session file path based on the current timestamp.
// Called once at startup; the same path is reused for the whole session.
function makeSessionPath(): string {
  // Format: 2026-06-30T10-00-00 (colons replaced with dashes for filesystem safety)
  const ts = new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "");
  return resolve(SESSIONS_DIR, `${ts}.md`);
}

export class SessionTranscript {
  private readonly path: string;
  private initialized = false;

  constructor() {
    this.path = makeSessionPath();
  }

  // Create the sessions directory and write the file header.
  // Called lazily on first write so we don't create empty files if the session produces nothing.
  private async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(SESSIONS_DIR, { recursive: true });

    const ts = new Date().toISOString().replace(/T/, " ").replace(/\.\d+Z$/, "");
    const header = `# Session ${ts}\n\n`;
    await Bun.write(this.path, header);
    this.initialized = true;
  }

  private async append(text: string): Promise<void> {
    await this.init();
    const existing = await Bun.file(this.path).text();
    await Bun.write(this.path, existing + text);
  }

  async writeUser(content: string): Promise<void> {
    await this.append(`## User\n\n${content}\n\n`);
  }

  async writeAssistant(content: string): Promise<void> {
    await this.append(`## Assistant\n\n${content}\n\n`);
  }

  async writeToolCall(call: ToolCall, result: string): Promise<void> {
    const argsJson = JSON.stringify(call.function.arguments, null, 2);
    // Truncate long tool results in the transcript (they can be huge; the model saw the full thing)
    const truncated =
      result.length > 2000 ? result.slice(0, 2000) + "\n... (truncated in transcript)" : result;

    await this.append(
      `## Tool Call: ${call.function.name}\n\n` +
        `args:\n\`\`\`json\n${argsJson}\n\`\`\`\n\n` +
        `result:\n\`\`\`\n${truncated}\n\`\`\`\n\n`
    );
  }

  async writeToolError(call: ToolCall, error: string): Promise<void> {
    const argsJson = JSON.stringify(call.function.arguments, null, 2);
    await this.append(
      `## Tool Error: ${call.function.name}\n\n` +
        `args:\n\`\`\`json\n${argsJson}\n\`\`\`\n\n` +
        `error:\n\`\`\`\n${error}\n\`\`\`\n\n`
    );
  }

  getPath(): string {
    return this.path;
  }
}
