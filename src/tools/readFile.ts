// src/tools/readFile.ts
// Tool: read_file
// Reads the contents of a file from the local filesystem.
// Sandboxed to the current working directory to prevent path-traversal attacks.

import { resolve, relative } from "node:path";
import type { ToolDefinition } from "../ollama/types.ts";

const CWD = process.cwd();

export const readFileDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "read_file",
    description:
      "Read the full text contents of a file. Use this before editing a file — never assume its current contents.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to the file, relative to the current working directory or absolute.",
        },
      },
      required: ["path"],
    },
  },
};

export async function readFileHandler(args: Record<string, unknown>): Promise<string> {
  const rawPath = args.path as string;
  if (!rawPath || typeof rawPath !== "string") {
    throw new Error("read_file requires a 'path' argument (string).");
  }

  const resolved = resolve(CWD, rawPath);

  // Sandbox check: resolved path must be inside CWD.
  // relative() will start with ".." if resolved is outside CWD.
  const rel = relative(CWD, resolved);
  if (rel.startsWith("..") || resolve(rel) === resolved) {
    // Second condition catches absolute paths that resolve outside CWD
    if (!resolved.startsWith(CWD)) {
      throw new Error(
        `Access denied: "${rawPath}" resolves outside the working directory.`
      );
    }
  }

  const file = Bun.file(resolved);
  const exists = await file.exists();
  if (!exists) {
    throw new Error(`File not found: "${rawPath}"`);
  }

  const content = await file.text();
  // Prepend a small header so the model knows exactly which file it's reading
  return `=== ${rawPath} (${content.length} chars) ===\n${content}`;
}
