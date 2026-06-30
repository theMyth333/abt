# Coding Agent Harness

A minimal, transparent implementation of a local coding agent — the orchestration loop that lets a local LLM read/write files and run commands on your machine. Built to teach how agent harnesses actually work, not to abstract it away.

**Stack:** Bun · TypeScript · Ollama (`gemma4:12b`) · plain Markdown

---

## Architecture

```
User input
    │
    ▼
src/index.ts          ← REPL: read line, call agent, print response
    │
    ▼
src/agent/loop.ts     ← Core agentic loop (the interesting part)
    │
    ├── src/ollama/client.ts      ← HTTP wrapper for /api/chat
    ├── src/tools/index.ts        ← Tool registry (name → schema + handler)
    ├── src/agent/contextManager.ts ← Trim message history to fit context window
    └── src/storage/
            session.ts            ← Append-only markdown transcript per run
            memory.ts             ← Durable memory.md across sessions
```

### The agentic loop (`agent/loop.ts`)

The loop has one job: keep calling Ollama until the model stops requesting tool calls and produces a final answer.

```
while (iterations < maxIterations):
    trimmedMessages = contextManager.fit(messages, num_ctx)
    response = ollama.chat(trimmedMessages, tools=[...])

    if response.tool_calls:
        for each call:
            result = tools[call.name](call.args)   # execute locally
            messages.append(assistant msg with tool_calls)
            messages.append(tool msg with result)
        continue  ← loop back, model sees the results

    else:
        return response.content  ← final answer
```

The key insight: the model and the harness are ping-ponging. The model says "call this tool", the harness does it, sends the result back, and the model decides what to do next. The user isn't in this loop — they only see the final answer.

### Why `tool` role messages?

Ollama (and the underlying chat API format) uses message roles to distinguish who produced each piece of content:
- `system` — instructions baked in at startup
- `user` — human input
- `assistant` — model output (may include `tool_calls`)
- `tool` — result of a tool execution, linked to the call by `tool_call_id`

Without the `tool` role, the model couldn't distinguish "output I requested from a tool" from "something the user typed". The role is how provenance is tracked.

### Context management (`agent/contextManager.ts`)

Ollama defaults to a **4K context window** even for models that support 128K+. We override this with `options.num_ctx` in every request. But even with a large window, long conversations eventually overflow it.

The trim strategy:
1. Always keep the system message (it has the operating instructions).
2. Always keep the last N messages verbatim (immediate context).
3. Older messages become one-line summaries and are collapsed into a `[Summarized history]` block.

The token count is estimated as `chars / 4` — good enough for triggering the trim. A production system would use a proper tokenizer.

### Markdown as a database

All persistence is `.md` files:

- `sessions/<timestamp>.md` — append-only transcript of every turn, tool call, and result. Human-readable without any tooling.
- `memory.md` — freeform notes the agent writes via `save_memory`. Read in full at startup and summarized into the system prompt.
- `tasks/<slug>.md` — markdown checklists the agent can read/update via `read_file`/`write_file` (scaffolded in `storage/tasks.ts`, not yet wired into the loop).

No SQLite, no JSON-as-DB. Opening any of these files in a text editor shows you exactly what the agent has done and knows.

### Tool sandboxing

Every file tool (`read_file`, `write_file`, `list_dir`) resolves the given path with `path.resolve` and checks that it starts with `process.cwd()`. Paths like `../../etc/passwd` are rejected before the filesystem is touched.

`run_command` has a regexp denylist for obviously destructive patterns (`rm -rf /`, fork bombs, disk overwrites). This is a footgun-prevention layer, not a security boundary — don't run this harness with untrusted model weights or on a machine where arbitrary shell execution would be catastrophic.

---

## Setup

### Prerequisites

1. [Bun](https://bun.sh) installed
2. [Ollama](https://ollama.ai) running locally
3. `gemma4:12b` pulled: `ollama pull gemma4:12b`

### Install and run

```bash
cd harness
cp .env.example .env   # edit if your Ollama is on a non-default port or you want a different model
bun install
bun run src/index.ts
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `gemma4:12b` | Model to use (must be pulled) |
| `HARNESS_NUM_CTX` | `32768` | Context window size passed to Ollama |
| `HARNESS_MAX_ITER` | `15` | Max tool-call iterations per user turn |
| `HARNESS_KEEP_LAST` | `10` | Messages preserved verbatim during context trim |

---

## What you'll see

The REPL prints internal events to `stderr` (prefixed with `[tool]` or `[context]`) so you can watch the agent working without them mixing into the conversation output on `stdout`. If you want a clean output, redirect stderr: `bun run src/index.ts 2>/dev/null`.

Example session:
```
You: What files are in the current directory?

[tool] Calling list_dir({})
[loop] Completed in 1 tool-call iteration(s).

Agent: The current directory contains: src/, package.json, tsconfig.json, ...
```

Session transcript saved to `sessions/2026-06-30T10-00-00.md`. Open it to see the full turn-by-turn record including tool args and results.

---

## Extending the harness

**Adding a tool:** Create `src/tools/myTool.ts` exporting a `ToolDefinition` and a `handler`, then add it to the registry in `src/tools/index.ts`. It will automatically appear in every Ollama request.

**Adding streaming:** In `client.ts`, set `stream: true` and consume the response as NDJSON (each line is a partial `ChatResponse`). Accumulate `message.content` until `done: true`. Tool calls arrive in the final chunk.

**Better summarization:** In `contextManager.ts`, replace the `slice(0, 200)` truncation with an actual Ollama call to summarize the dropped messages. Use a small/fast model for this to keep latency low.
