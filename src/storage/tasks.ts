// src/storage/tasks.ts
// Scaffolding for per-task markdown files in the tasks/ directory.
// Tasks are stored as markdown checklists (- [ ] / - [x]) that the agent
// can read and update directly via the read_file / write_file tools.
// This module is not wired into the agent loop yet — it's here to be
// imported and used when task-tracking behavior is added.

import { resolve } from "node:path";
import { mkdir, readdir } from "node:fs/promises";

const TASKS_DIR = resolve(process.cwd(), "tasks");

// Slugify a task title for use as a filename: lowercase, spaces → dashes, strip specials.
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .slice(0, 64);
}

export interface Task {
  slug: string;
  path: string;
  title: string;
}

// Create a new task file with a blank checklist.
export async function createTask(title: string, description?: string): Promise<Task> {
  await mkdir(TASKS_DIR, { recursive: true });

  const slug = slugify(title);
  const path = resolve(TASKS_DIR, `${slug}.md`);

  const content =
    `# ${title}\n\n` +
    (description ? `${description}\n\n` : "") +
    `## Checklist\n\n` +
    `- [ ] (add steps here)\n`;

  await Bun.write(path, content);
  return { slug, path, title };
}

// List all existing task files.
export async function listTasks(): Promise<Task[]> {
  try {
    const entries = await readdir(TASKS_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => ({
        slug: e.name.replace(/\.md$/, ""),
        path: resolve(TASKS_DIR, e.name),
        title: e.name.replace(/\.md$/, "").replace(/-/g, " "),
      }));
  } catch {
    return [];
  }
}

// Read a task file by slug. Returns null if not found.
export async function readTask(slug: string): Promise<string | null> {
  const path = resolve(TASKS_DIR, `${slug}.md`);
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) return null;
  return file.text();
}

// Write updated content to a task file (used to check off items, etc).
export async function writeTask(slug: string, content: string): Promise<void> {
  const path = resolve(TASKS_DIR, `${slug}.md`);
  await Bun.write(path, content);
}
