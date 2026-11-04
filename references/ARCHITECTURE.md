# Agent Harness Architecture

> The model is one part. The harness is the system around it.

---

## The 10 Primitives

### 1. Instructions
Who the agent is, what rules it follows, what it should never do.
Loaded once into the system prompt — the agent never has to be told twice.

**In `.abt/`:** `system_prompt.md`, `skills/`

---

### 2. Context Delivery
Giving the model the material it needs to act: files, logs, stack traces, docs.
The difference between a generic answer and a precise one.

**In `.abt/`:** workspace root resolution, `@file` references at runtime

---

### 3. Context Management
Deciding *what* enters the model at each turn — not dumping everything in.
Wrong context is worse than missing context; it creates plausible distraction.

Mechanisms: RAG / retrieval ranking, summarisation, compaction when the window fills.

---

### 4. Tool Interface
Structured actions the model can request: read file, write file, shell, grep, list dir.
The model names the tool and provides arguments; the harness executes it.

MCP servers extend this layer — any MCP-compatible service exposes its tools here.

**In `.abt/`:** `mcp/servers.json`, tool allow-list in `config.toml`

---

### 5. Execution Environment
Where tool calls run, and under what constraints.
File-system scope, network policy, secrets access, sandboxing.

The harness decides — not the model — what a command can see and change.

---

### 6. Durable State
Progress that survives the current turn: plan files, task state, session
summaries, trace logs, memory stores.

Context management decides what the model sees *now*; durable state preserves
what happened *before* so the next run starts further ahead.

**In `.abt/`:** `traces/`, `logs/`

---

### 7. Orchestration
How work moves through its lifecycle: hooks before/after tool calls, retries,
approval gates, human hand-offs, step ordering, task lists.

The model reasons; the harness carries the workflow.

**In `.abt/`:** `settings.json` (`hooks`, `permissions`)

---

### 8. Sub-agents
Branching work into bounded loops — each with narrower context, narrower tools,
and a single job. Prevents one agent's context from crowding with unrelated work.

Patterns: *agents-as-tools* (manager calls specialist), *handoff* (control transfers).

---

### 9. Skills
Reusable procedures for recurring work: how to review a PR, run browser checks,
use a specific repo. Loaded at invocation time so every agent follows the same
checklist without rediscovering it.

**In `.abt/`:** `skills/<name>.md`

---

### 10. Verification & Observability

**Verification** — the harness asks for receipts, not just "looks good to me".
Run tests, check builds, take screenshots, run evals.

**Observability** — the full run record: what the model saw, what tool it called,
what arguments, what came back, what changed, cost, latency, prompt version.
Turns "the agent messed up" into a debuggable system.

**In `.abt/`:** `traces/<run>.jsonl`, `logs/abt.log`

---

## How the Primitives Compose

```
User task
    │
    ▼
[ Instructions ]  ←  system_prompt.md + active skill
    │
    ▼
[ Context Delivery + Context Management ]  ←  relevant files, compaction
    │
    ▼
[ Model ] ──────────────────────────────────── reasons + decides
    │
    ▼
[ Tool Interface ]  ←  built-in tools + MCP servers
    │
    ▼
[ Execution Environment ]  ←  scope, sandbox, permissions
    │
    ▼
[ Durable State ]  ←  trace written, plan updated
    │
    ▼
[ Orchestration ]  ←  hooks, retries, approval gates
    │
    ├── fork? ──► [ Sub-agent ] ──► narrower context + tools
    │
    ▼
[ Verification ]  ←  tests, build, screenshot, evals
    │
    ▼
[ Observability ]  ←  trace + log flushed
    │
    ▼
  Done  (or loop back)
```

---

## Failure Diagnosis Checklist

When a run fails, ask which primitive ran out of road:

| Layer               | Question to ask                                      |
|---------------------|------------------------------------------------------|
| Instructions        | Was the rule or constraint missing from the prompt?  |
| Context Delivery    | Did the model have the right files / logs?           |
| Context Management  | Was the window noisy or over-compacted?              |
| Tool Interface      | Was the tool schema vague or the tool absent?        |
| Execution Env       | Did the command run in the wrong place / scope?      |
| Durable State       | Did the agent redo work it had already done?         |
| Orchestration       | Was a retry, gate, or hook missing?                  |
| Sub-agents          | Should this have been delegated with narrower scope? |
| Skills              | Was a known procedure missing or not loaded?         |
| Verification        | Did we trust "done" without running checks?          |
| Observability       | Can we even tell what went wrong?                    |

Fix the primitive, not just the prompt. Each fix makes the *next* run start
from a better place.
