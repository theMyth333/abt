// src/storage/skills.ts
// Manages SKILLS.md — the agent's library of reusable named skills.
// Each skill has a name, description, and a list of steps.
// The agent writes skills via the save_skill tool; they're read at startup
// and injected into the system prompt so the model can reference them.

import { resolve } from "node:path";

const SKILLS_PATH = resolve(process.cwd(), "SKILLS.md");

const INITIAL_SKILLS = `# Agent Skills

This file stores reusable skills the agent has learned.
Each skill has a name, description, and step-by-step instructions.
Skills are read at startup and injected into the system prompt.

---
`;

export async function ensureSkillsFile(): Promise<void> {
  const file = Bun.file(SKILLS_PATH);
  if (!(await file.exists())) {
    await Bun.write(SKILLS_PATH, INITIAL_SKILLS);
  }
}

export async function readSkills(): Promise<string | null> {
  const file = Bun.file(SKILLS_PATH);
  if (!(await file.exists())) return null;
  return file.text();
}

// Parse SKILLS.md into a map of skill name → full skill block text.
// Skills are delimited by `## SkillName` headings.
export function parseSkills(content: string): Map<string, string> {
  const map = new Map<string, string>();
  // Split on level-2 headings; skip the preamble before the first heading
  const sections = content.split(/^## /m);
  for (const section of sections.slice(1)) {
    const newline = section.indexOf("\n");
    if (newline === -1) continue;
    const name = section.slice(0, newline).trim();
    const body = section.slice(newline + 1);
    map.set(name, body.trim());
  }
  return map;
}

// Write or overwrite a named skill in SKILLS.md.
// If a skill with the same name already exists, it is replaced in-place.
// Otherwise the skill is appended.
export async function saveSkill(
  name: string,
  description: string,
  steps: string[]
): Promise<void> {
  await ensureSkillsFile();

  const content = await Bun.file(SKILLS_PATH).text();
  const existing = parseSkills(content);

  const stepList = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const skillBlock = `## ${name}\n\n${description}\n\n${stepList}\n`;

  if (existing.has(name)) {
    // Replace the existing skill section in-place
    const updated = content.replace(
      new RegExp(`## ${escapeRegex(name)}\\n[\\s\\S]*?(?=\\n## |$)`),
      skillBlock
    );
    await Bun.write(SKILLS_PATH, updated);
  } else {
    // Append as a new skill
    await Bun.write(SKILLS_PATH, content + "\n" + skillBlock);
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Produce a compact summary of SKILLS.md for injection into the system prompt.
// Lists skill names and descriptions; truncates step details if too long.
export async function getSkillsSummary(): Promise<string> {
  const content = await readSkills();
  if (!content) return "(no skills defined yet)";

  const afterHr = content.split("---").slice(1).join("---").trim();
  if (!afterHr) return "(no skills defined yet)";

  // Collect skill name + description lines only for a compact overview
  const lines: string[] = [];
  for (const [name, body] of parseSkills(content)) {
    const firstLine = body.split("\n")[0].trim();
    lines.push(`**${name}**: ${firstLine}`);
  }

  if (lines.length === 0) return "(no skills defined yet)";

  const summary = lines.join("\n");
  if (summary.length <= 2000) return summary;
  return summary.slice(0, 2000) + "\n... (truncated)";
}
