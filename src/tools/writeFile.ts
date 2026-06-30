// src/tools/writeFile.ts
// Tool: write_file
// Writes (or overwrites) a file at the given path.
// Creates any missing parent directories automatically.
// Sandboxed to CWD — refuses to write outside the working directory.

import { resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { ToolDefinition } from "../ollama/types.ts";

const CWD = process.cwd();

export const writeFileDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "write_file",
    description:
      "Write text content to a file, creating it (and any missing parent directories) if needed. Overwrites existing files.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Destination path, relative to cwd or absolute.",
        },
        content: {
          type: "string",
          description: "Full text content to write to the file.",
        },
      },
      required: ["path", "content"],
    },
  },
};

export async function writeFileHandler(args: Record<string, unknown>): Promise<string> {
  const rawPath = args.path as string;
  const content = args.content as string;

  if (!rawPath || typeof rawPath !== "string") {
    throw new Error("write_file requires a 'path' argument (string).");
  }
  if (content === undefined || typeof content !== "string") {
    throw new Error("write_file requires a 'content' argument (string).");
  }

  const resolved = resolve(CWD, rawPath);

  // Sandbox check
  if (!resolved.startsWith(CWD)) {
    throw new Error(
      `Access denied: "${rawPath}" resolves outside the working directory.`
    );
  }

  // Create parent directories if they don't exist
  const parentDir = dirname(resolved);
  await mkdir(parentDir, { recursive: true });

  await Bun.write(resolved, content);

  return `Written ${content.length} chars to "${rawPath}".`;
}
