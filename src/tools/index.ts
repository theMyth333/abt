// src/tools/index.ts
// Tool registry — the single source of truth for what tools the agent can call.
// Maps tool name → { definition (schema for Ollama), handler (actual implementation) }.
// The agent loop imports `toolDefinitions` to send to Ollama and `toolRegistry` to dispatch calls.

import type { ToolDefinition } from "../ollama/types.ts";
import { readFileDefinition, readFileHandler } from "./readFile.ts";
import { writeFileDefinition, writeFileHandler } from "./writeFile.ts";
import { listDirDefinition, listDirHandler } from "./listDir.ts";
import { runCommandDefinition, runCommandHandler } from "./runCommand.ts";
import { saveMemoryDefinition, saveMemoryHandler } from "./saveMemory.ts";
import { saveSkillDefinition, saveSkillHandler } from "./saveSkill.ts";
import { useSkillDefinition, useSkillHandler } from "./useSkill.ts";

export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

// Add new tools here — they'll automatically appear in every Ollama request.
export const toolRegistry: Record<string, RegisteredTool> = {
  read_file: { definition: readFileDefinition, handler: readFileHandler },
  write_file: { definition: writeFileDefinition, handler: writeFileHandler },
  list_dir: { definition: listDirDefinition, handler: listDirHandler },
  run_command: { definition: runCommandDefinition, handler: runCommandHandler },
  save_memory: { definition: saveMemoryDefinition, handler: saveMemoryHandler },
  save_skill: { definition: saveSkillDefinition, handler: saveSkillHandler },
  use_skill: { definition: useSkillDefinition, handler: useSkillHandler },
};

// Flat array of just the definitions — this is what gets sent in the `tools` field of /api/chat.
export const toolDefinitions: ToolDefinition[] = Object.values(toolRegistry).map(
  (t) => t.definition
);
