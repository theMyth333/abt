// src/tools/saveSkill.ts
// Tool: save_skill
// Writes or overwrites a named skill in SKILLS.md.
// Skills are reusable routines the agent can define once and reference by name
// in future sessions — think of them as the agent's personal playbook.

import type { ToolDefinition } from "../ollama/types.ts";
import { saveSkill } from "../storage/skills.ts";

export const saveSkillDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "save_skill",
    description:
      "Save a reusable skill to SKILLS.md. A skill is a named, step-by-step routine for a task you expect to repeat. Use this when you figure out a non-obvious process — capturing it once means future sessions can follow the same steps without rediscovering them. If a skill with the same name already exists, it is overwritten.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Short, unique skill name in kebab-case or Title Case. Examples: 'deploy-to-staging', 'Add a new tool'.",
        },
        description: {
          type: "string",
          description: "One sentence explaining what this skill accomplishes.",
        },
        steps: {
          type: "array",
          items: { type: "string" },
          description:
            "Ordered list of steps to execute the skill. Each step should be a concrete, actionable instruction.",
        },
      },
      required: ["name", "description", "steps"],
    },
  },
};

export async function saveSkillHandler(args: Record<string, unknown>): Promise<string> {
  const { name, description, steps } = args as {
    name: string;
    description: string;
    steps: string[];
  };

  if (!name || typeof name !== "string") {
    throw new Error("save_skill requires a 'name' argument (string).");
  }
  if (!description || typeof description !== "string") {
    throw new Error("save_skill requires a 'description' argument (string).");
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("save_skill requires a 'steps' argument (non-empty array of strings).");
  }

  await saveSkill(name, description, steps);
  return `Skill "${name}" saved to SKILLS.md (${steps.length} step${steps.length === 1 ? "" : "s"}).`;
}
