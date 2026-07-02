# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the agent REPL
bun run src/index.ts

# Development mode (auto-restart on file changes)
bun --watch run src/index.ts

# Type-check without running
bunx tsc --noEmit

# Install dependencies
bun install
```

No build step — Bun runs TypeScript directly. No test framework is configured; testing is manual via the REPL. Session transcripts in `sessions/` serve as audit logs.

To suppress internal tool/context events from the REPL output:
```bash
bun run src/index.ts 2>/dev/null
```

## Environment

Copy `.env.example` to `.env`. Key variables:

| Variable | Default | Effect |
|---|---|---|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `gemma4:12b` | Must be pulled via `ollama pull <model>` |
| `HARNESS_NUM_CTX` | `32768` | Context window passed to Ollama on every request |
| `HARNESS_MAX_ITER` | `15` | Iteration cap per turn (prevents infinite tool loops) |
| `HARNESS_KEEP_LAST` | `10` | Messages preserved verbatim during context trimming |

`HARNESS_NUM_CTX` is always sent explicitly in requests — without it, Ollama silently caps at 4K regardless of model capability.

## Architecture

The project is a minimal, educational coding agent harness. The model requests tools, the harness executes them locally, results are fed back, and this repeats until the model produces a final answer without tool calls.

### Agentic loop (`src/agent/loop.ts`)

The core of the system. Each call to `AgentLoop.turn()`:
1. Appends the user message to history
2. Trims context if needed (`contextManager.fit()`)
3. Calls Ollama with the full message history and tool schemas
4. If the response contains `tool_calls`: executes each tool, appends `assistant` (with `tool_calls`) + `tool` (with result) messages, and loops
5. If no `tool_calls`: streams the final answer token-by-token via the `onChunk` callback

Streaming only happens on the final answer. Tool-call turns use non-streaming requests because the complete response is needed immediately to extract `tool_calls`.

### Context management (`src/agent/contextManager.ts`)

When estimated token count (`chars / 4`) exceeds 70% of `num_ctx`:
- System message (index 0) is always preserved
- Most recent `keepLast` messages are always preserved verbatim
- Older messages are collapsed into a `[Summarized history]` block (role + first 200 chars per message)

### Tools (`src/tools/`)

All tools are registered in `src/tools/index.ts` (schema + handler pairs). To add a tool: create `src/tools/myTool.ts` exporting a `ToolDefinition` and handler, then register it in `index.ts`. It will automatically appear in every Ollama request.

File tools (`read_file`, `write_file`, `list_dir`) reject any path that resolves outside `process.cwd()`. `run_command` has a regexp denylist for destructive shell patterns — this is footgun prevention, not a security boundary.

### Persistence (`src/storage/`)

All state is plain Markdown:
- `sessions/<timestamp>.md` — append-only transcript per REPL session (every turn, tool call, and result)
- `memory.md` — durable notes written by the agent via `save_memory`; read at startup and injected into the system prompt
- `tasks/<slug>.md` — markdown checklists scaffolded in `storage/tasks.ts` but **not yet wired into the agent loop**

### Ollama client (`src/ollama/client.ts`)

Thin HTTP wrapper around `/api/chat`. `.chat()` returns a full response; `.chatStream()` is an async generator yielding content chunks with `tool_calls` arriving in the final chunk.

### Message roles

`system` (startup instructions + memory), `user` (human input), `assistant` (model output, may include `tool_calls`), `tool` (tool result, linked to its call via `tool_call_id`).
