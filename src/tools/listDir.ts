// src/tools/listDir.ts
// Tool: list_dir
// Lists the entries in a directory (names + whether each entry is a file or directory).
// Sandboxed to CWD.

import { resolve } from "node:path";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import type { ToolDefinition } from "../ollama/types.ts";

const CWD = process.cwd();

export const listDirDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "list_dir",
    description:
      "List the files and subdirectories inside a directory. Returns each entry's name and type (file or dir).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Directory path to list, relative to cwd or absolute. Defaults to '.' (the working directory).",
        },
      },
      required: [],
    },
  },
};

export async function listDirHandler(args: Record<string, unknown>): Promise<string> {
  const rawPath = (args.path as string | undefined) ?? ".";
  const resolved = resolve(CWD, rawPath);

  // Sandbox check
  if (!resolved.startsWith(CWD)) {
    throw new Error(
      `Access denied: "${rawPath}" resolves outside the working directory.`
    );
  }

  let entries: Dirent[];
  try {
    // withFileTypes gives us Dirent objects so we can distinguish file vs dir
    entries = await readdir(resolved, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Directory not found: "${rawPath}"`);
    }
    if ((err as NodeJS.ErrnoException).code === "ENOTDIR") {
      throw new Error(`"${rawPath}" is a file, not a directory.`);
    }
    throw err;
  }

  if (entries.length === 0) {
    return `Directory "${rawPath}" is empty.`;
  }

  const lines = entries.map((e) => {
    const type = e.isDirectory() ? "dir " : "file";
    return `${type}  ${e.name}`;
  });

  return `Contents of "${rawPath}" (${entries.length} entries):\n${lines.join("\n")}`;
}
