// src/tools/useSkill.ts
// Tool: use_skill
// Looks up a named skill from SKILLS.md and returns its full steps.
// Calling this tool makes skill usage explicit and observable in the transcript.

import type { ToolDefinition } from "../ollama/types.ts";
import { readSkills, parseSkills } from "../storage/skills.ts";

export const useSkillDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "use_skill",
    description:
      "Look up a named skill from SKILLS.md and return its step-by-step instructions. Call this before executing a skill so your intent is explicit and logged. After calling it, follow the returned steps using the available tools.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The exact name of the skill to retrieve (as it appears in SKILLS.md).",
        },
      },
      required: ["name"],
    },
  },
};

export async function useSkillHandler(args: Record<string, unknown>): Promise<string> {
  const name = args.name as string;
  if (!name || typeof name !== "string") {
    throw new Error("use_skill requires a 'name' argument (string).");
  }

  const content = await readSkills();
  if (!content) {
    throw new Error("SKILLS.md not found or empty. No skills are defined yet.");
  }

  const skills = parseSkills(content);
  const body = skills.get(name);

  if (!body) {
    const available = [...skills.keys()].map((k) => `"${k}"`).join(", ");
    throw new Error(
      `No skill named "${name}" found in SKILLS.md. Available skills: ${available || "(none)"}.`
    );
  }

  return `Skill: ${name}\n\n${body}`;
}
