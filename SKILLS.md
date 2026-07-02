# Agent Skills

This file stores reusable skills the agent has learned.
Each skill has a name, description, and step-by-step instructions.
Skills are read at startup and injected into the system prompt.

---

## Add a new tool

Add a new tool to the agent's tool registry.

1. Create `src/tools/<toolName>.ts` exporting a `ToolDefinition` and handler function.
2. Import both exports in `src/tools/index.ts`.
3. Add an entry to `toolRegistry` with the tool name as key.
4. Run `bunx tsc --noEmit` to verify no type errors.

## Summarize a file

Produce a concise summary of any file's purpose and structure.

1. Call `read_file` with the target path.
2. Identify the file's primary responsibility in one sentence.
3. List the exported functions/classes and what each does in one line.
4. Note any non-obvious dependencies or side effects.

## Debug a failing command

Diagnose why a shell command is failing.

1. Call `run_command` with the failing command and capture stderr.
2. Read the error message carefully — identify whether it's a missing file, bad argument, or permission issue.
3. If a file is missing, call `list_dir` on the parent directory to confirm what exists.
4. Retry with a corrected command based on what you found.
