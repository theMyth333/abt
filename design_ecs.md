# Coding Agent Harness — ECS Architecture (Bevy ECS)

## Overview

This document redesigns `abt` around **Bevy ECS** instead of a monolithic
`AgentHarness` struct. Every agent turn becomes data flowing through Systems;
all mutable state lives in Components attached to Entities. The same 10
harness primitives are preserved — the ECS just makes their interactions
explicit, composable, and testable in isolation.

There is **no Bevy rendering** dependency. The binary uses `bevy_ecs` and
`bevy_app` only, giving a full ECS scheduler without the game-engine overhead.

---

## The 10 Harness Primitives

`abt` is built around ten primitives — the fundamental capabilities every
coding-agent harness must provide. Every feature in this document exists to
implement one or more of them. The table below is your Rosetta stone: when
you see `[P3]` or `[P7]` anywhere else in this document, look here first.

| #  | Name                          | One-line purpose                                                        |
|----|-------------------------------|-------------------------------------------------------------------------|
| P1 | Instructions                  | Tell the model who it is and what procedure to follow                   |
| P2 | Context Delivery & Streaming  | Feed the model all relevant information and receive its output live     |
| P3 | Context Management            | Keep the conversation within the model's token budget                   |
| P4 | Tool Interface                | Give the model a typed, discoverable set of actions it can take         |
| P5 | Execution Environment         | Constrain and sandbox those actions so they cannot cause unintended harm|
| P6 | Durable State                 | Persist enough that a run can be inspected, resumed, or replayed        |
| P7 | Orchestration                 | Control the loop: hooks, retries, approval gates, stop conditions       |
| P8 | Sub-agents                    | Delegate subtasks to a child agent with a narrower scope                |
| P9 | Skills                        | Load task-specific procedure files that extend the base instructions    |
| P10| Verification & Observability  | Automatically check the model's work and record everything that happened|

---

### P1 — Instructions

**What it is.** Before the first user message is sent to the model, the
harness constructs a *system message* — a privileged, non-user-visible block
of text that tells the model its role, its constraints, and the step-by-step
procedure it should follow for the current task. This is analogous to a job
description handed to a new employee before they start work.

**Why it matters.** Without explicit instructions the model produces generic
output. With them it knows: which tools to prefer, which files are off-limits,
how to format its responses, when to ask for clarification, and in what order
to perform subtasks. The difference between a good coding agent and a
frustrating one is almost entirely in the quality and specificity of P1.

**In this design.** The system message is built by `SkillsPlugin` during
the `build_system_msg_system` system, which runs when `TurnPhase` is `Idle`
before the first provider call each turn. It reads two sources:

1. `~/.abt/system_prompt.md` — the permanent base prompt, loaded verbatim.
2. The active skill file (P9) — appended after a `--- skill: <name> ---`
   separator so the model can distinguish harness-level instructions from
   task-specific procedure.

The assembled string is stored in the `SystemPrompt` component on the
`AgentEntity` and injected as the `system` role message in every
`ChatRequest`. It is never sent as a user message.

**Config surface.**
- `~/.abt/system_prompt.md` — edit directly to change the permanent prompt.
- `--skill <name>` CLI flag — selects the active skill file (P9).
- `config.toml [agent] system_prompt` — override the base prompt path.

---

### P2 — Context Delivery & Streaming

**What it is.** Context delivery is how the harness packages everything the
model needs to know into a single API call: the system message (P1), the full
conversation history, any extra files or logs the user asked to inject, and
the current task description. Streaming is how the harness receives the
model's response — token by token over SSE — rather than waiting for the
entire completion before showing any output.

**Why it matters.** Coding tasks often require the model to see large files,
diffs, test output, or tool results from prior turns. Careful packaging of
this material (without exceeding the token budget — P3) is the difference
between a model that has enough information to act and one that hallucinates.
Streaming matters for user experience: a 2 000-token response that arrives
all at once after 30 seconds feels broken; the same response streamed live
feels responsive.

**In this design.** `ProviderPlugin` owns this primitive. It speaks the
**OpenAI Chat Completions API** wire format (`/v1/chat/completions` with
`stream: true`), making it compatible with **Ollama** (the local default),
OpenAI, Groq, LM Studio, and any other OpenAI-compatible endpoint — no code
changes required.

The streaming pipeline:

```
stream_system (sync)
    │  spawns tokio task with Arc<OpenAiClient>
    ▼
tokio task (async)
    │  POST /v1/chat/completions  →  SSE response
    │  parse each "data: {...}" line into StreamChunk
    │  send (entity, StreamChunk) over crossbeam channel
    ▼
accumulate_system (sync, runs next tick)
    │  drains channel
    │  Delta chunks: stream content → stdout, thinking → stderr
    │  Done chunk:  push assembled ChatMessage onto ConversationHistory
    │  emit ToolCallsReady or TurnCompleted
```

`StreamChunk` has two variants:
- `Delta { content, thinking, tool_calls }` — partial output, printed live.
- `Done { finish_reason, usage }` — signals end of turn; triggers the FSM
  transition to either `ToolDispatching` or `Verifying`.

**Wire types** (`provider/mod.rs`):

```rust
pub struct ChatRequest {
    pub model:    String,
    pub messages: Vec<ChatMessage>,
    pub tools:    Vec<ToolDef>,
    pub stream:   bool,
    pub thinking: Option<ThinkingConfig>,  // { type: "enabled", budget_tokens }
}

pub enum StreamChunk {
    Delta { content: Option<String>, thinking: Option<String>, tool_calls: Vec<ToolCallFragment> },
    Done  { finish_reason: String, usage: Usage },
}
```

**Config surface.**
- `config.toml [provider] base_url` — endpoint (default: Ollama at localhost).
- `config.toml [provider] model` — model name (default: `qwen2.5-coder:7b`).
- `config.toml [agent] stream` — set `false` to disable streaming.
- `config.toml [agent] thinking` / `thinking_budget` — enable extended thinking.
- `--base-url`, `--model`, `--thinking`, `--thinking-budget` CLI flags.

---

### P3 — Context Management

**What it is.** Every model has a fixed context window — a hard ceiling on
how many tokens can appear in a single request (system message + history +
tool results + reserved space for the next response combined). Context
management is the process of keeping the conversation within that ceiling,
either by dropping old messages, summarising them, or compacting tool results.

**Why it matters.** Without it, a multi-turn coding session hits the context
limit after a handful of turns and either crashes or starts hallucinating
because the model can no longer see its own earlier work. A well-implemented
P3 is invisible to the user — the session just keeps going.

**In this design.** `ContextPlugin` owns this primitive. Its `compact_system`
runs whenever `TurnPhase` is `Compacting` — which is the very first phase of
every turn loop cycle, before the provider call.

Two components drive the decision:

```rust
pub struct ContextBudget {
    pub max_tokens:     u32,   // hard ceiling (from config.toml [provider] max_tokens)
    pub reserve_tokens: u32,   // headroom kept for the next response
    pub compaction:     CompactionStrategy,
}

pub struct TokenCount(pub u32);  // current estimated token count of ConversationHistory
```

The `compact()` function (called inside `compact_system`) trims
`ConversationHistory` until `TokenCount ≤ max_tokens − reserve_tokens`.
It never removes the system message or the most recent user message.

**Compaction strategies** (configured via `config.toml [context] compaction`):

| Strategy    | Behaviour                                                              |
|-------------|------------------------------------------------------------------------|
| `summarise` | Drops the N oldest non-system turns, prepends a one-sentence summary   |
| `drop`      | Silently removes the N oldest non-system turns                         |
| `error`     | Returns an error if the budget is exceeded — useful during development |

Token counting uses `tiktoken-rs` (the same tokeniser OpenAI uses) so the
estimate matches what the model actually sees.

**Config surface.**
- `config.toml [provider] max_tokens` — context ceiling.
- `config.toml [context] reserve_tokens` — headroom (default: 512).
- `config.toml [context] compaction` — strategy (default: `summarise`).

---

### P4 — Tool Interface

**What it is.** Tools are typed actions the model can request the harness to
perform on its behalf: read a file, write a file, run a shell command, search
with regex, list a directory, or call an external MCP server. Each tool has a
JSON Schema definition that is sent to the model as part of every request, so
the model knows exactly what arguments each tool accepts. The model emits a
structured `tool_calls` block; the harness routes it to the right
implementation and returns the result as a `tool` role message.

**Why it matters.** Without tools the model can only produce text. With tools
it can actually read the codebase, run tests, apply patches, and inspect
build output — turning it from a text generator into an agent that can
complete real coding tasks.

**In this design.** `ToolsPlugin` and `McpPlugin` jointly own this primitive.

**Built-in tools** (in `tools/`):

| Tool         | Description                                              |
|--------------|----------------------------------------------------------|
| `read_file`  | Read the full contents of a file path                    |
| `write_file` | Write or overwrite a file at a given path                |
| `shell`      | Run a shell command (subject to P5 permission gate)      |
| `grep`       | Pure-Rust regex search across files/directories          |
| `list_dir`   | List a directory's contents (with optional depth)        |

**MCP tools** are registered at startup via `~/.abt/mcp/servers.json`. Each
MCP server process is connected over stdio or SSE; its tool list is discovered
via the MCP `tools/list` call and merged into the `ToolRegistry` resource.
From the model's perspective, built-in and MCP tools look identical.

**Tool trait** (in `tools/mod.rs`):

```rust
#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self)    -> &str;
    fn spec(&self)    -> ToolDef;                       // OpenAI function schema
    async fn run(&self, arguments: &str, env: &ExecEnv) -> Result<String>;
}
```

**ECS flow.** When `accumulate_system` receives a `Done` chunk with
`finish_reason = "tool_calls"`, it emits a `ToolCallsReady` event.
`spawn_tool_calls_system` reads that event and creates one `ToolCallEntity`
per requested call (after the P5 permission check). `dispatch_system` then
picks up each `ToolCallEntity`, spawns an async tokio task to run the tool,
and writes the `ToolResult` component back via a result channel.
`collect_results_system` waits until every `ToolCallEntity` owned by an agent
has a `ToolResult`, then pushes all results onto `ConversationHistory` and
fires `AllToolsDone`.

**Config surface.**
- `config.toml [tools] allowlist` — which built-in tools are active.
- `config.toml [tools] shell_timeout_secs` — per-command timeout.
- `config.toml [mcp] enabled` / `servers_file` — MCP toggle and registry path.
- `~/.abt/mcp/servers.json` — MCP server definitions.

---

### P5 — Execution Environment

**What it is.** A security and scoping layer that sits in front of every tool
invocation (especially `shell`) to enforce: which commands are permitted,
which paths the agent can read or write, and how long a command may run before
being killed. The model proposes an action; P5 decides whether it is allowed
to proceed.

**Why it matters.** An agent running `rm -rf /` or exfiltrating credentials
is not hypothetical — models do make mistakes. P5 is the last line of defence
before any OS-level side effect occurs. It also gives the user a legible audit
trail of what was and was not allowed.

**In this design.** P5 is implemented as the `PermissionGate` component on
each `AgentEntity` and the permission-check logic inside
`spawn_tool_calls_system`. The gate is checked *before* a `ToolCallEntity` is
even created, so a denied tool call never touches the async dispatch path.

```rust
pub struct PermissionGate(pub Permissions);

pub struct Permissions {
    pub allow: Vec<String>,   // e.g. ["Bash(cargo:*)", "Bash(git:*)"]
    pub deny:  Vec<String>,   // explicit denials; evaluated after allow
}
```

Pattern syntax mirrors Claude Code's `settings.json` format:
`Bash(cargo:*)` allows any `cargo` invocation; `Bash(rm:*)` would allow `rm`.
Deny rules take precedence over allow rules.

**Shell execution details** (in `tools/shell.rs`):
- Runtime-detected: `cmd.exe /C` on Windows, `/bin/sh -c` on Unix.
- `tokio::time::timeout` enforces `shell_timeout_secs`.
- `workspace_root` is passed as the working directory; the tool cannot `cd`
  outside it without an explicit path (which would then be pattern-matched by
  the permission gate).

**Approval gates.** When configured, a denied tool call can be escalated to
an interactive prompt rather than silently rejected — the user sees the
proposed command and can approve or deny it at runtime. This is controlled by
`settings.json "permissions" "mode"` (`auto` vs. `interactive`).

**Config surface.**
- `settings.json "permissions" "allow"` — allow-list patterns.
- `settings.json "permissions" "deny"` — deny-list patterns.
- `config.toml [tools] shell_timeout_secs` — per-command timeout.

---

### P6 — Durable State

**What it is.** Everything the harness produces that needs to survive a
process exit: the complete record of every turn (trace), the model's current
plan and task breakdown (state store), and the structured log. Durable state
lets you inspect what happened after the fact, resume an interrupted run, and
replay or diff two runs.

**Why it matters.** Coding agents run long tasks — sometimes dozens of turns
spanning minutes. Without P6, a crash or `Ctrl-C` loses all context. With it,
you have a JSONL audit trail you can `jq`-query, a plan file that a future run
can load and resume from, and a rolling log for debugging.

**In this design.** P6 is split across two plugins:

**`TracePlugin`** — owns the per-run JSONL trace.

Each run gets its own file at `~/.abt/traces/<timestamp>_<uuid>.jsonl`. Every
turn appended to the file is one JSON line with this shape:

```json
{
  "turn": 3,
  "role": "assistant",
  "content": "I'll read the file first.",
  "thinking": "...",
  "tool_calls": [{ "id": "call_1", "name": "read_file", "arguments": "{\"path\":\"src/lib.rs\"}" }],
  "tool_results": [{ "call_id": "call_1", "content": "pub fn add(...)" }],
  "usage": { "prompt_tokens": 1234, "completion_tokens": 456 }
}
```

`flush_system` runs in `TurnPhase::Tracing` — the final phase before `Done`
— and appends the current turn's assembled data to the JSONL file.

**`StatePlugin`** — owns the plan / task state store.

The model's plan (a structured JSON document the model maintains across turns,
tracking completed and pending tasks) is stored in the `PlanState` component
on the `AgentEntity`. After every tool round, `save_plan_system` writes the
component to `~/.abt/workspaces/<name>.json`. On startup, if a workspace file
exists for the current task name, it is loaded back into `PlanState` so the
agent can resume mid-plan.

**ECS components involved:**

```rust
#[derive(Component)] pub struct TraceHandle(pub Arc<TraceWriter>);
#[derive(Component)] pub struct StateStorePath(pub PathBuf);
#[derive(Component)] pub struct PlanState(pub serde_json::Value);
```

**Config surface.**
- `config.toml [trace] enabled` / `dir` — toggle tracing, set trace dir.
- `config.toml [log] level` / `file` — structured log level and path.
- `~/.abt/workspaces/<name>.json` — read at startup for resume, written each tool round.

---

### P7 — Orchestration

**What it is.** The control plane of the agent loop: lifecycle hooks that fire
at well-defined points (before a tool runs, after a tool runs, when the agent
stops), retry logic for transient failures, approval gates that pause
execution for human sign-off, and stop conditions that prevent runaway loops.

**Why it matters.** An agent loop without orchestration is a black box. P7
makes it observable and controllable: you can inject pre-flight checks,
post-process tool results, block dangerous operations, automatically retry
after a flaky HTTP 429, and cap the loop at a sensible turn count.

**In this design.** P7 is split across two plugins:

**`HooksPlugin`** — fires shell commands at lifecycle points.

Hooks are configured in `settings.json`:

```json
{
  "hooks": {
    "PreToolUse":  [{ "match": "shell", "command": "echo 'about to run shell'" }],
    "PostToolUse": [{ "match": "*",     "command": "log-tool-use.sh" }],
    "Stop":        [{ "match": "*",     "command": "notify-slack.sh" }]
  }
}
```

- **`PreToolUse`**: runs *before* `ToolDispatching`. A non-zero exit can block
  the tool call entirely (configurable: `warn` vs. `block`).
- **`PostToolUse`**: runs *after* all tool results are collected, still within
  `HookPostTool` phase.
- **`Stop`**: runs once when `TurnPhase` transitions to `Done`.

Hooks receive the tool name, arguments, and result as environment variables so
they can make context-aware decisions.

**`OrchestratorPlugin`** — retry logic and stop conditions.

```
retry_system watches for TurnPhase::Failed and inspects the error:
  - transient HTTP errors (429, 503, network timeout)
      → increment RetryCount, exponential back-off, return to Compacting
  - permanent errors (4xx auth, model not found, max retries exceeded)
      → leave in Failed, surface to user
```

Stop conditions checked by `check_stop_conditions_system` each tick:
- `TurnCounter ≥ MaxTurns` → transition to `Done` with a "max turns reached" message.
- `RetryCount ≥ max_retries` → transition to `Failed`.
- No `TaskSubmitted` events pending and all agents in `Done` → app exits cleanly.

**Config surface.**
- `settings.json "hooks"` — hook definitions per lifecycle event.
- `config.toml [agent] max_turns` — turn cap (default: 20).
- `config.toml [agent] max_retries` — retry cap (default: 3).
- Hook `"match"` field accepts glob patterns against tool names.

---

### P8 — Sub-agents

**What it is.** The ability to delegate a subtask to a child agent that runs
its own full turn loop with a narrower scope: a specific skill, a subset of
tools, a lower turn cap. The parent agent fires a tool call to launch the
sub-agent and receives the sub-agent's final answer as the tool result.

**Why it matters.** Some tasks are too large for a single context window or
benefit from specialisation. A root agent doing architecture review should not
also be running `cargo test` in a loop — it can delegate that to a
code-verification sub-agent. Sub-agents also provide natural isolation:
a sub-agent can be given read-only tools while the parent retains write access.

**In this design.** Sub-agents are implemented as additional `AgentEntity`
entities in the same ECS World. They carry the `ParentAgent(Entity)` component
linking them back to their creator. Because they are plain entities, the same
systems that drive the root agent (provider streaming, tool dispatch,
verification) drive sub-agents without any special-casing.

**Launch flow:**

1. The root agent emits a `tool_calls` request for a special `spawn_subagent`
   tool, providing task, skill, tool subset, and max turns.
2. `spawn_tool_calls_system` detects this and instead of creating a
   `ToolCallEntity`, fires a `SubAgentSpawnRequest` event.
3. `SubagentPlugin::spawn_subagent_system` creates a new `AgentEntity` with
   `ParentAgent(root_entity)` and emits `TaskSubmitted` for the child.
4. The child runs its full turn loop independently.
5. When the child reaches `TurnPhase::Done`, `collect_subagent_system`
   extracts the final assistant message, pushes it as a `tool` role message
   onto the parent's `ConversationHistory`, fires `SubAgentDone`, and despawns
   the child entity.

**Narrowing options** (set on `SubAgentSpawnRequest`):

```rust
pub struct SubAgentSpawnRequest {
    pub parent:      Entity,
    pub task:        String,
    pub skill:       Option<String>,     // load a specific skill file
    pub tool_subset: Vec<String>,        // whittle down the ToolAllowlist
    pub max_turns:   usize,              // child-specific turn cap
    pub inherit_trace: bool,             // share parent's TraceHandle or get own
}
```

**Concurrency.** Multiple sub-agents can exist simultaneously in the World.
Bevy's system scheduler runs their non-conflicting systems in parallel
automatically — a sub-agent doing file I/O does not block another sub-agent
waiting on an HTTP response.

**Config surface.**
- `--subagent-skill <name>` CLI flag — launches a named sub-agent for the
  root task (convenience wrapper around the `spawn_subagent` tool).
- `SubAgentSpawnRequest` fields above — set programmatically by the model
  when it decides to delegate.

---

### P9 — Skills

**What it is.** A skill is a Markdown file that encodes a specific procedure
for a specific kind of task — "how to do a Rust refactor", "how to write a
security review", "how to add an API endpoint". Loading a skill appends its
content to the system message (P1) so the model has step-by-step guidance
tailored to the current task without that guidance cluttering the base prompt.

**Why it matters.** A single base prompt cannot be optimal for every task
type. Skills let you capture expert procedure in a reusable, version-controlled
file. The same harness binary can behave like a "rust-refactor expert", a
"test-writer", or a "security auditor" just by selecting a different skill —
no code changes needed.

**In this design.** `SkillsPlugin` owns this primitive. It shares the
`build_system_msg_system` with P1 (since both feed the `SystemPrompt`
component).

**Loading sequence** inside `build_system_msg_system`:

```
1. Read ~/.abt/system_prompt.md                    → base prompt string
2. If ActiveSkill(Some(name)):
     Read ~/.abt/skills/<name>.md                  → skill string
     Append "--- skill: <name> ---\n" + skill string
3. Store assembled string in SystemPrompt component
4. Inject as "system" role message in ChatRequest
```

**Skill file format** (`~/.abt/skills/rust-refactor.md`):

```markdown
# When to use this skill
Use when asked to restructure, extract, or reorganise Rust code without
changing observable behaviour.

# Input expectations
- The codebase must compile before you start.
- Identify the target module or function before proposing changes.

# Procedure
1. Run `cargo test` to establish a green baseline.
2. Read the target file(s) in full.
3. Propose the refactor plan as a bulleted list before writing any code.
4. Apply changes incrementally — one logical step per tool call.
5. Run `cargo test` after each step. If tests fail, revert and re-plan.
6. Run `cargo clippy` at the end.
```

**CLI interface:**

```
abt run --skill rust-refactor "extract the config module"
abt skills list           # list ~/.abt/skills/
abt skills show <name>    # print skill file
abt skills edit <name>    # open in $EDITOR
```

**Config surface.**
- `~/.abt/skills/<name>.md` — skill files; create any number.
- `--skill <name>` CLI flag — activates a skill for a run.
- `config.toml [agent] default_skill` — optional: always-on skill.

---

### P10 — Verification & Observability

**What it is.** Two related concerns bundled into one primitive:

- **Verification**: automatically run a configured set of checks (tests,
  linters, type-checkers, custom scripts) after the model claims it is done,
  and feed failures back to the model for self-correction.
- **Observability**: record a complete, structured log of everything that
  happened during the run so it can be inspected, diffed, and debugged after
  the fact.

**Why it matters.** Models make mistakes — wrong function signatures,
off-by-one errors, broken imports. Without automatic verification, those
mistakes reach the user silently. With it, the harness catches them in the
same turn and gives the model a chance to fix them before declaring success.
Observability closes the debugging loop: when something goes wrong (either the
model's output or the harness itself), the trace file tells you exactly what
was sent, what was received, and what every tool returned.

**In this design.** P10 is split across two plugins:

**`VerifyPlugin`** — automated post-turn checks.

Verification steps are configured in `settings.json`:

```json
{
  "verify": [
    { "name": "tests",  "command": "cargo test",   "on_fail": "Block" },
    { "name": "clippy", "command": "cargo clippy", "on_fail": "Warn"  }
  ]
}
```

`on_fail` has three values:
- `Block` — push the failure report back to the model as a new user message
  and loop (the model gets one more attempt). This is the default for tests.
- `Warn` — log the failure and continue to `Done` anyway.
- `Retry` — increment `RetryCount` and retry the entire turn (not just
  verification) — useful for flaky external checks.

`run_verify_system` runs in `TurnPhase::Verifying`, which is entered only
when `finish_reason == "stop"` (the model declared it was done). If a `Block`
step fails, the phase returns to `Compacting` for another turn. If all steps
pass (or only `Warn` steps fail), phase advances to `Tracing`.

**`TracePlugin`** — structured JSONL trace (see also P6 for storage details).

Every event of significance is appended to the trace:

| Event type      | When recorded                                        |
|-----------------|------------------------------------------------------|
| `turn_start`    | Before each provider call                            |
| `stream_chunk`  | Optional; every delta chunk (can be verbose)         |
| `turn_end`      | After accumulation: role, content, thinking, usage   |
| `tool_call`     | Each tool invocation: name, arguments                |
| `tool_result`   | Each tool result: output, duration, exit code        |
| `hook_fired`    | Each hook: type, command, exit code                  |
| `verify_step`   | Each verification step: name, command, outcome       |
| `compaction`    | When history was trimmed: tokens before/after        |
| `subagent`      | Sub-agent spawn and completion events                |

The trace file is the authoritative record. `abt traces show <id>` pretty-prints
it; `abt traces list` shows all runs with their timestamps and final status.

**Config surface.**
- `settings.json "verify"` — verification step definitions.
- `config.toml [trace] enabled` / `dir` — toggle and locate traces.
- `config.toml [log] level` / `file` — structured log (`tracing` crate,
  rolling file via `tracing-appender`).
- `settings.json "ui" "show_thinking"` — whether thinking tokens appear in
  the trace and on stderr.

---

## Core ECS Concepts Used

| Concept     | Role in abt                                                        |
|-------------|--------------------------------------------------------------------|
| Entity      | One per agent run, one per sub-agent, one per in-flight tool call  |
| Component   | Typed data attached to an entity (messages, config, turn state...) |
| Resource    | Singleton data shared across all systems (HTTP client, registry…)  |
| System      | Pure function over queries — one step of the agent loop            |
| Event       | Fire-and-forget signals between systems (ToolResult, TurnDone…)    |
| Plugin      | Composable module that registers its own systems + resources        |

---

## Entity Taxonomy

```
AgentEntity          — one per running agent (root or sub-agent)
  ├── ToolCallEntity — one per pending tool invocation (child of AgentEntity)
  └── TraceEntity    — one per run (holds JSONL writer handle)
```

An `AgentEntity` carries all the components that define its state. A
`ToolCallEntity` is spawned when the model requests a tool, lives until the
result is written back, then is despawned. `TraceEntity` is created once and
shared (via a `Parent` link) with all tool calls so every event lands in the
right file.

---

## Component Catalogue

```rust
// ── Identity ──────────────────────────────────────────────────────────────
#[derive(Component)] pub struct AgentId(pub Uuid);
#[derive(Component)] pub struct ParentAgent(pub Entity);   // sub-agent only
#[derive(Component)] pub struct AgentLabel(pub String);    // display name

// ── Configuration (P1, P3, P5, P7) ───────────────────────────────────────
#[derive(Component)] pub struct ProviderConfig {
    pub base_url: String,
    pub model:    String,
    pub max_tokens: u32,
    pub stream:   bool,
    pub thinking: Option<ThinkingConfig>,
}
#[derive(Component)] pub struct ContextBudget {
    pub max_tokens:     u32,
    pub reserve_tokens: u32,
    pub compaction:     CompactionStrategy,
}
#[derive(Component)] pub struct ActiveSkill(pub Option<String>);
#[derive(Component)] pub struct HookConfig(pub HooksSettings);      // P7
#[derive(Component)] pub struct PermissionGate(pub Permissions);    // P5
#[derive(Component)] pub struct ToolAllowlist(pub Vec<String>);     // P4

// ── Conversation State (P2, P3) ───────────────────────────────────────────
#[derive(Component)] pub struct ConversationHistory(pub Vec<ChatMessage>);
#[derive(Component)] pub struct SystemPrompt(pub String);           // P1
#[derive(Component)] pub struct TokenCount(pub u32);                // P3

// ── Turn State machine ────────────────────────────────────────────────────
#[derive(Component, PartialEq, Eq, Clone, Copy, Debug)]
pub enum TurnPhase {
    Idle,            // waiting for user input
    Compacting,      // P3: trimming history
    HookPreTool,     // P7: running PreToolUse hooks
    Requesting,      // P2: SSE stream in flight
    ToolDispatching, // P4: running tool calls
    HookPostTool,    // P7: running PostToolUse hooks
    Verifying,       // P10: running verification steps
    Tracing,         // P6: flushing trace
    Done,            // terminal — result ready
    Failed(String),  // terminal — unrecoverable error
}

// ── Turn bookkeeping ──────────────────────────────────────────────────────
#[derive(Component)] pub struct TurnCounter(pub usize);
#[derive(Component)] pub struct MaxTurns(pub usize);
#[derive(Component)] pub struct RetryCount(pub usize);

// ── Pending tool calls (on ToolCallEntity) ────────────────────────────────
#[derive(Component)] pub struct PendingToolCall {
    pub call_id:   String,
    pub tool_name: String,
    pub arguments: String,
}
#[derive(Component)] pub struct ToolResult(pub String);             // written back when done
#[derive(Component)] pub struct ToolCallOwner(pub Entity);          // → parent AgentEntity

// ── Durable state (P6) ───────────────────────────────────────────────────
#[derive(Component)] pub struct TraceHandle(pub Arc<TraceWriter>);
#[derive(Component)] pub struct StateStorePath(pub PathBuf);
#[derive(Component)] pub struct PlanState(pub serde_json::Value);
```

---

## Resource Catalogue

Resources are singletons — one per `World`, not per entity.

```rust
// Provider HTTP client (P2)
#[derive(Resource)] pub struct ProviderClient(pub Arc<OpenAiClient>);

// Tool registry — all built-ins + MCP tools (P4)
#[derive(Resource)] pub struct ToolRegistry(pub Arc<dyn ToolDispatch>);

// MCP server pool (P4)
#[derive(Resource)] pub struct McpPool(pub Arc<McpRegistry>);

// Global config loaded at startup
#[derive(Resource)] pub struct GlobalConfig(pub Config);

// Dirs (home, traces, workspaces, skills, mcp)
#[derive(Resource)] pub struct AbtDirs(pub dirs::AbtDirs);

// tokio runtime handle — systems call .block_on() or .spawn() through this
#[derive(Resource)] pub struct TokioRuntime(pub tokio::runtime::Handle);
```

---

## Event Catalogue

Events are the only cross-system communication channel (besides shared Components).

```rust
#[derive(Event)] pub struct TaskSubmitted  { pub agent: Entity, pub task: String }
#[derive(Event)] pub struct TurnStarted    { pub agent: Entity }
#[derive(Event)] pub struct StreamChunkReceived { pub agent: Entity, pub chunk: StreamChunk }
#[derive(Event)] pub struct ToolCallsReady { pub agent: Entity, pub calls: Vec<RawToolCall> }
#[derive(Event)] pub struct ToolCallDone   { pub tool_entity: Entity }
#[derive(Event)] pub struct AllToolsDone   { pub agent: Entity }
#[derive(Event)] pub struct TurnCompleted  { pub agent: Entity, pub finish_reason: String }
#[derive(Event)] pub struct VerificationPassed { pub agent: Entity }
#[derive(Event)] pub struct VerificationFailed { pub agent: Entity, pub report: String }
#[derive(Event)] pub struct SubAgentSpawned{ pub parent: Entity, pub child: Entity }
#[derive(Event)] pub struct SubAgentDone   { pub parent: Entity, pub child: Entity, pub result: String }
#[derive(Event)] pub struct HookFired      { pub agent: Entity, pub hook_type: HookType }
#[derive(Event)] pub struct TraceFlushed   { pub agent: Entity }
```

---

## Plugin Layout

Each primitive becomes a Bevy Plugin. Plugins own their systems and any
resources they introduce. `main.rs` composes them.

```
src/
  main.rs              — App::new() + plugin registration + CLI dispatch
  lib.rs               — re-exports
  components.rs        — all Component + Event type definitions
  resources.rs         — all Resource type definitions
  error.rs             — unified Error/Result

  plugins/
    dirs_plugin.rs     — P6: init ~/.abt/, insert AbtDirs resource
    config_plugin.rs   — all: load config.toml + settings.json → resources
    provider_plugin.rs — P2: OpenAiClient resource + streaming system
    context_plugin.rs  — P3: token counting + compaction system
    skills_plugin.rs   — P1,P9: system_prompt + skill loader system
    tools_plugin.rs    — P4,P5: ToolRegistry resource + dispatch system
    mcp_plugin.rs      — P4: McpRegistry resource + server management
    trace_plugin.rs    — P6,P10: TraceWriter system + JSONL flush
    state_plugin.rs    — P6: StateStore read/write system
    hooks_plugin.rs    — P7: PreToolUse / PostToolUse / Stop hook system
    verify_plugin.rs   — P10: VerificationStep runner system
    subagent_plugin.rs — P8: sub-agent spawn + result integration system
    orchestrator_plugin.rs — P7: retry logic + approval gate system
    commands_plugin.rs — slash command parsing + dispatch
    agent_plugin.rs    — glue: spawns AgentEntity, drives TurnPhase FSM

  provider/
    mod.rs             — wire types (ChatMessage, ChatRequest, StreamChunk)
    client.rs          — OpenAiClient::chat_stream()
    stream.rs          — SSE decoder

  tools/
    mod.rs             — Tool trait + built-in registrations
    read_file.rs
    write_file.rs
    shell.rs
    grep.rs
    list_dir.rs

  mcp/
    mod.rs
    server.rs
    servers_json.rs
```

---

## System Graph

Systems are ordered by `TurnPhase`. Bevy's scheduler runs them in the right
order because each system `With<TurnPhase>` filters to only the phases it
owns, and the scheduler sees no write-write conflicts.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  TaskSubmitted event                                                    │
│       │                                                                 │
│       ▼  agent_plugin::spawn_agent_system                               │
│  AgentEntity created with all components at default values              │
│       │                                                                 │
│       ▼  TurnPhase::Idle                                                │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │  TURN LOOP                                                     │     │
│  │                                                                │     │
│  │  context_plugin::compact_system      [Compacting]             │     │
│  │       ↓ P3                                                     │     │
│  │  skills_plugin::build_system_msg     [Idle→Requesting]        │     │
│  │       ↓ P1,P9  injects system_prompt + skill                  │     │
│  │  hooks_plugin::pre_tool_hook_system  [HookPreTool]            │     │
│  │       ↓ P7                                                     │     │
│  │  provider_plugin::stream_system      [Requesting]             │     │
│  │       ↓ P2  fires StreamChunkReceived events                  │     │
│  │  provider_plugin::accumulate_system  [Requesting]             │     │
│  │       ↓     assembles full assistant message                  │     │
│  │       ├── finish_reason "stop"  ──────────────────────────┐   │     │
│  │       └── finish_reason "tool_calls"                      │   │     │
│  │               ↓                                           │   │     │
│  │  tools_plugin::spawn_tool_calls_system [ToolDispatching]  │   │     │
│  │       ↓ P4  spawns ToolCallEntity per call                │   │     │
│  │  tools_plugin::dispatch_system        [ToolDispatching]   │   │     │
│  │       ↓ P4,P5  runs each tool; writes ToolResult component │   │     │
│  │  tools_plugin::collect_results_system [ToolDispatching]   │   │     │
│  │       ↓     when all done → fires AllToolsDone            │   │     │
│  │  hooks_plugin::post_tool_hook_system  [HookPostTool]      │   │     │
│  │       ↓ P7                                                │   │     │
│  │  state_plugin::save_plan_system       [HookPostTool]      │   │     │
│  │       ↓ P6  persists PlanState component                  │   │     │
│  │       └──────────────────── loop ←───────────────────────┘   │     │
│  │                                                          │         │
│  │  verify_plugin::run_verify_system     [Verifying]   ←───┘   │     │
│  │       ↓ P10  cargo test / clippy / custom steps             │     │
│  │  trace_plugin::flush_system           [Tracing]             │     │
│  │       ↓ P6,P10  writes JSONL, fires TraceFlushed            │     │
│  │  TurnPhase → Done                                           │     │
│  └────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Primitive → Plugin/System Mapping

| # | Primitive                    | Plugin(s)                                | Key Systems                                                |
|---|------------------------------|------------------------------------------|------------------------------------------------------------|
| 1 | Instructions                 | `skills_plugin`                          | `build_system_msg_system`                                  |
| 2 | Context Delivery + Streaming | `provider_plugin`                        | `stream_system`, `accumulate_system`                       |
| 3 | Context Management           | `context_plugin`                         | `compact_system`, `token_count_system`                     |
| 4 | Tool Interface               | `tools_plugin`, `mcp_plugin`             | `spawn_tool_calls_system`, `dispatch_system`               |
| 5 | Execution Environment        | `tools_plugin` (shell gate)              | permission check inside `dispatch_system`                  |
| 6 | Durable State                | `trace_plugin`, `state_plugin`           | `flush_system`, `save_plan_system`                         |
| 7 | Orchestration                | `hooks_plugin`, `orchestrator_plugin`    | `pre_tool_hook_system`, `post_tool_hook_system`, `retry_system` |
| 8 | Sub-agents                   | `subagent_plugin`                        | `spawn_subagent_system`, `collect_subagent_system`         |
| 9 | Skills                       | `skills_plugin`                          | `build_system_msg_system` (appends skill file)             |
|10 | Verification & Observability | `verify_plugin`, `trace_plugin`          | `run_verify_system`, `flush_system`                        |

---

## TurnPhase FSM

```
             TaskSubmitted
                  │
                  ▼
               [Idle]
                  │  compact_system fires if over budget
                  ▼
           [Compacting] ──→ [Idle] (done trimming)
                  │  build_system_msg_system
                  ▼
          [HookPreTool] ──→ block if hook returns non-zero
                  │
                  ▼
          [Requesting]  ──→ [Failed] on provider error
                  │
           finish_reason?
          ┌──────┴───────┐
        "stop"      "tool_calls"
          │               │
          ▼               ▼
     [Verifying]  [ToolDispatching]
          │               │ all tools done
          │               ▼
          │         [HookPostTool]
          │               │
          │               └──────→ loop back to [Compacting]
          ▼
       [Tracing]
          │
          ▼
       [Done]
```

Transitions are driven by Systems reading + writing the `TurnPhase` component.
No central controller exists — each system advances phase for the entities it
owns.

---

## Plugin Deep-Dives

### `AgentPlugin` — entity spawning + phase dispatch

```rust
pub struct AgentPlugin;

impl Plugin for AgentPlugin {
    fn build(&self, app: &mut App) {
        app
            .add_event::<TaskSubmitted>()
            .add_event::<TurnCompleted>()
            .add_systems(Update, (
                spawn_agent_system          // TaskSubmitted → AgentEntity
                    .run_if(on_event::<TaskSubmitted>()),
                check_stop_conditions_system,  // max_turns / error threshold
                advance_phase_system,          // drives phase transitions
            ));
    }
}

fn spawn_agent_system(
    mut commands: Commands,
    mut events: EventReader<TaskSubmitted>,
    config: Res<GlobalConfig>,
    dirs: Res<AbtDirs>,
) {
    for ev in events.read() {
        commands.spawn((
            AgentId(Uuid::new_v4()),
            AgentLabel(ev.task.chars().take(40).collect()),
            ProviderConfig::from(&config.0),
            ContextBudget::from(&config.0),
            ActiveSkill(None),
            HookConfig(config.0.hooks.clone()),
            PermissionGate(config.0.permissions.clone()),
            ToolAllowlist(config.0.tools.allowlist.clone()),
            ConversationHistory(vec![]),
            SystemPrompt(String::new()),
            TokenCount(0),
            TurnPhase::Idle,
            TurnCounter(0),
            MaxTurns(config.0.agent.max_turns),
            RetryCount(0),
            TraceHandle(Arc::new(TraceWriter::open(&dirs.traces).unwrap())),
            StateStorePath(dirs.workspaces.clone()),
            PlanState(serde_json::Value::Null),
        ));
    }
}
```

### `ContextPlugin` — P3

```rust
fn compact_system(
    mut q: Query<(&mut ConversationHistory, &mut TokenCount, &ContextBudget, &mut TurnPhase),
                 With<AgentId>>,
) {
    for (mut hist, mut tok, budget, mut phase) in &mut q {
        if *phase != TurnPhase::Compacting { continue; }
        let report = compact(&mut hist.0, budget);
        tok.0 = report.new_token_count;
        *phase = TurnPhase::Idle;
    }
}
```

Compaction is pure data manipulation — no I/O — so it runs synchronously in
the ECS tick without touching the tokio runtime.

### `ProviderPlugin` — P2

Streaming is async. The system spawns a tokio task that posts chunks back via
a `crossbeam_channel` or `std::sync::mpsc` channel read by a second system:

```rust
fn stream_system(
    mut q: Query<(Entity, &ConversationHistory, &ProviderConfig, &mut TurnPhase)>,
    client: Res<ProviderClient>,
    rt: Res<TokioRuntime>,
    mut chunk_tx: ResMut<ChunkSender>,   // channel → accumulate_system
) {
    for (entity, hist, cfg, mut phase) in &mut q {
        if *phase != TurnPhase::Requesting { continue; }
        let req = build_request(hist, cfg);
        let client = client.0.clone();
        let tx = chunk_tx.0.clone();
        rt.0.spawn(async move {
            let mut stream = client.chat_stream(req).await.unwrap();
            while let Some(chunk) = stream.next().await {
                tx.send((entity, chunk.unwrap())).ok();
            }
        });
    }
}

fn accumulate_system(
    mut q: Query<(&mut ConversationHistory, &mut TurnPhase)>,
    mut rx: ResMut<ChunkReceiver>,
    mut tool_ev: EventWriter<ToolCallsReady>,
    mut turn_ev: EventWriter<TurnCompleted>,
) {
    // drain the channel each tick
    while let Ok((entity, chunk)) = rx.0.try_recv() {
        // ... accumulate delta content / tool_call fragments
        // on Done chunk: push assembled message onto ConversationHistory,
        //               emit ToolCallsReady or TurnCompleted
    }
}
```

### `ToolsPlugin` — P4, P5

```rust
fn spawn_tool_calls_system(
    mut commands: Commands,
    mut ev: EventReader<ToolCallsReady>,
    q: Query<&PermissionGate>,
) {
    for ev in ev.read() {
        let gate = q.get(ev.agent).unwrap();
        for call in &ev.calls {
            if gate.0.is_allowed(&call.tool_name, &call.arguments) {
                commands.spawn((
                    PendingToolCall {
                        call_id:   call.id.clone(),
                        tool_name: call.name.clone(),
                        arguments: call.args.clone(),
                    },
                    ToolCallOwner(ev.agent),
                ));
            } else {
                // spawn with a pre-filled ToolResult("Permission denied")
            }
        }
    }
}

fn dispatch_system(
    mut commands: Commands,
    q: Query<(Entity, &PendingToolCall, &ToolCallOwner), Without<ToolResult>>,
    registry: Res<ToolRegistry>,
    rt: Res<TokioRuntime>,
    mut done_ev: EventWriter<ToolCallDone>,
) {
    for (entity, call, owner) in &q {
        let registry = registry.0.clone();
        let call = call.clone();
        // spawn async task; write result back via channel
        rt.0.spawn(async move {
            let result = registry.dispatch(&call.tool_name, &call.arguments).await;
            // send (entity, result) through a ToolResultSender resource
        });
        // mark in-progress to avoid double-dispatch
        commands.entity(entity).insert(Dispatching);
    }
}
```

### `SubagentPlugin` — P8

```rust
fn spawn_subagent_system(
    mut commands: Commands,
    mut ev: EventReader<SubAgentSpawnRequest>,
    parent_q: Query<(&ProviderConfig, &TraceHandle)>,
    config: Res<GlobalConfig>,
) {
    for req in ev.read() {
        let (parent_cfg, parent_trace) = parent_q.get(req.parent).unwrap();
        let child = commands.spawn((
            AgentId(Uuid::new_v4()),
            ParentAgent(req.parent),
            ProviderConfig { model: parent_cfg.model.clone(), ..parent_cfg.clone() },
            ActiveSkill(req.skill.clone()),
            ToolAllowlist(req.tool_subset.clone()),
            ConversationHistory(vec![]),
            SystemPrompt(String::new()),
            TokenCount(0),
            TurnPhase::Idle,
            TurnCounter(0),
            MaxTurns(req.max_turns),
            RetryCount(0),
            // shares parent trace file when inherit_trace = true
            TraceHandle(parent_trace.0.clone()),
            StateStorePath(PathBuf::new()),
            PlanState(serde_json::Value::Null),
        )).id();
        // emit TaskSubmitted for the child so the normal loop picks it up
        // ...
    }
}

fn collect_subagent_system(
    mut commands: Commands,
    children: Query<(Entity, &ParentAgent, &TurnPhase, &ConversationHistory)>,
    mut parent_hist: Query<&mut ConversationHistory, Without<ParentAgent>>,
    mut ev: EventWriter<SubAgentDone>,
) {
    for (child, &ParentAgent(parent), phase, hist) in &children {
        if *phase == TurnPhase::Done {
            // extract last assistant message as the result
            let result = last_assistant_message(hist);
            // push it as a tool_result onto the parent history
            if let Ok(mut ph) = parent_hist.get_mut(parent) {
                ph.0.push(tool_result_message(result.clone()));
            }
            ev.send(SubAgentDone { parent, child, result });
            commands.entity(child).despawn();
        }
    }
}
```

### `HooksPlugin` — P7

```rust
fn pre_tool_hook_system(
    mut q: Query<(Entity, &HookConfig, &mut TurnPhase)>,
    rt: Res<TokioRuntime>,
    mut hook_ev: EventWriter<HookFired>,
) {
    for (entity, hooks, mut phase) in &mut q {
        if *phase != TurnPhase::HookPreTool { continue; }
        for hook in &hooks.0.pre_tool_use {
            rt.0.block_on(run_hook(hook)); // non-zero → set Failed or stay
        }
        *phase = TurnPhase::Requesting;
        hook_ev.send(HookFired { agent: entity, hook_type: HookType::PreToolUse });
    }
}
```

### `VerifyPlugin` — P10

```rust
fn run_verify_system(
    mut q: Query<(Entity, &mut TurnPhase, &mut ConversationHistory)>,
    config: Res<GlobalConfig>,
    rt: Res<TokioRuntime>,
    mut pass_ev: EventWriter<VerificationPassed>,
    mut fail_ev: EventWriter<VerificationFailed>,
) {
    for (entity, mut phase, mut hist) in &mut q {
        if *phase != TurnPhase::Verifying { continue; }
        let report = rt.0.block_on(run_all_steps(&config.0.verify));
        match report.outcome {
            Outcome::Pass => {
                *phase = TurnPhase::Tracing;
                pass_ev.send(VerificationPassed { agent: entity });
            }
            Outcome::Fail(msg) if report.on_fail == FailAction::Block => {
                // push failure back to model for one more turn
                hist.0.push(user_message(format!("Verification failed:\n{msg}")));
                *phase = TurnPhase::Compacting;
            }
            Outcome::Fail(msg) => {
                *phase = TurnPhase::Tracing;
                fail_ev.send(VerificationFailed { agent: entity, report: msg });
            }
        }
    }
}
```

---

## App Composition (`main.rs`)

```rust
fn main() {
    let cli = Cli::parse();

    let mut app = App::new();
    app
        // ECS core only — no rendering
        .add_plugins(MinimalPlugins)

        // Infrastructure plugins (order matters: dirs before config before rest)
        .add_plugins(DirsPlugin)
        .add_plugins(ConfigPlugin::from_cli(&cli))

        // Primitive plugins
        .add_plugins(ProviderPlugin)   // P2
        .add_plugins(ContextPlugin)    // P3
        .add_plugins(SkillsPlugin)     // P1, P9
        .add_plugins(ToolsPlugin)      // P4, P5
        .add_plugins(McpPlugin)        // P4
        .add_plugins(TracePlugin)      // P6, P10
        .add_plugins(StatePlugin)      // P6
        .add_plugins(HooksPlugin)      // P7
        .add_plugins(OrchestratorPlugin) // P7
        .add_plugins(VerifyPlugin)     // P10
        .add_plugins(SubagentPlugin)   // P8

        // Glue — must come last (queries entities inserted by above plugins)
        .add_plugins(AgentPlugin);

    // Fire the initial task
    app.world_mut()
       .send_event(TaskSubmitted { agent: Entity::PLACEHOLDER, task: cli.task });

    app.run();
}
```

The `run()` call spins the Bevy scheduler. Because all state is in the ECS
World, a controlled shutdown is just: no more `TaskSubmitted` events and all
`AgentEntity` components are in `TurnPhase::Done`.

---

## Async Integration Pattern

Bevy ECS is synchronous by design. Async I/O (provider streaming, tool shell
exec) lives in tokio tasks. The bridge is:

```
System (sync)  ──spawn──▶  tokio task (async)
                               │
                               │ result ready
                               ▼
                         crossbeam channel
                               │
                               ▼
System (sync)  ──drain──▶  write Component / send Event
```

The tokio runtime is inserted as a `TokioRuntime` resource. Systems call
`rt.0.spawn(...)` to start async work and `rt.0.block_on(...)` only for
fast synchronous async calls (e.g. reading a small file). Long I/O always
goes through a channel so the ECS tick never blocks.

---

## Testing Strategy

Each plugin is independently testable:

```rust
#[test]
fn test_compact_system() {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins).add_plugins(ContextPlugin);

    // spawn a fake agent entity with known history
    let agent = app.world_mut().spawn((
        ConversationHistory(long_history()),
        ContextBudget { max_tokens: 100, reserve_tokens: 20, compaction: CompactionStrategy::Drop },
        TokenCount(200),
        TurnPhase::Compacting,
    )).id();

    app.update();

    let phase = app.world().get::<TurnPhase>(agent).unwrap();
    assert_eq!(*phase, TurnPhase::Idle);
    let tok = app.world().get::<TokenCount>(agent).unwrap();
    assert!(tok.0 <= 80);
}
```

No HTTP calls, no file I/O — just component mutation in a sandboxed world.
Provider and tool tests mock the `ProviderClient` / `ToolRegistry` resources.

---

## Home Directory & Config

Unchanged from `DESIGN.md`. `DirsPlugin` scaffolds `~/.abt/` and inserts
`AbtDirs` as a resource. `ConfigPlugin` reads `config.toml` + `settings.json`
and inserts `GlobalConfig`. All primitives read from these resources; none
open files themselves (except `TracePlugin` and `StatePlugin` which own their
own writers).

---

## Dependencies

All dependencies from `DESIGN.md` are retained. New additions:

| Crate              | Purpose                                          |
|--------------------|--------------------------------------------------|
| `bevy_ecs`         | ECS World, Components, Systems, Events           |
| `bevy_app`         | App builder + scheduler (`MinimalPlugins`)       |
| `crossbeam-channel`| sync→async bridge (chunk sender / tool results)  |
| `uuid`             | `AgentId` unique identifiers                     |

`bevy` full feature-set is **not** required — `bevy_ecs` + `bevy_app` pull in
only the scheduler and the ECS core, adding ~2 MB to the binary.

---

## Open Questions (ECS-specific)

- [ ] **Tick rate**: run the scheduler at `bevy::app::ScheduleRunnerPlugin` fixed
      interval (e.g. 60 Hz polling channels) or `EventLoop`-driven (fire on event)?
      Event-driven avoids busy-wait but requires manual wakeup from async channels.
- [ ] **World persistence**: ECS World lives in memory. On crash, only the
      `StateStore` JSONL on disk allows resume. Should `PlanState` component be
      checkpointed more aggressively?
- [ ] **Parallel tool dispatch**: Bevy can run non-conflicting systems in parallel.
      Multiple `ToolCallEntity`s with no shared components can dispatch concurrently
      today — verify this is desirable vs. serialized tool calls.
- [ ] **Sub-agent isolation**: Sub-agent entities share the parent World. Full
      process-level isolation requires spawning a child process instead. Decide
      per threat model.
- [x] **TUI live view**: `TuiPlugin` (ratatui) renders live output in the
      terminal. Decided: use `ratatui`. See the TUI section below.

---

## Slash Commands

Slash commands are typed in the **TUI input bar** while the agent is running or
idle. They are processed locally by the harness — they are never sent to the
model as conversation messages.

### Input Bar

The TUI input bar sits at the bottom of the screen (above the status bar). It
activates when the user presses `/`. The typed command is parsed and dispatched
immediately on `Enter`; `Escape` cancels.

`TuiPlugin` owns the input bar widget and the command dispatch loop.

### Built-in Commands

| Command | Effect |
|---------|--------|
| `/help` | Print all available slash commands with one-line descriptions in the conversation pane |
| `/skill <name>` | Load `~/.abt/skills/<name>.md` and set `ActiveSkill` on the current `AgentEntity`; rebuilds `SystemPrompt` next tick |
| `/clear` | Discard conversation history (fires `ClearHistory` event); optionally runs P3 compaction first to preserve a summary |
| `/status` | Print current agent state: turn count, token count, active skill, model, provider endpoint, `TurnPhase` |
| `/mcp` | List connected MCP servers, their status (connected / error), and the number of tools each exposes |

### Architecture

Slash commands are implemented as a **`CommandsPlugin`** that:

1. Receives a `SlashCommandEntered { raw: String }` event from `TuiPlugin`.
2. Parses the raw string into a `SlashCommand` enum.
3. Dispatches the appropriate action — either mutating ECS state directly
   (e.g. writing `ActiveSkill`) or emitting a dedicated event.

No `AgentEntity` components are written directly from the input bar handler;
mutations always go through the normal event pipeline so other plugins react
correctly (e.g. `SkillsPlugin` rebuilds `SystemPrompt` on `ActiveSkill` change).

```rust
// components.rs / events
#[derive(Event)] pub struct SlashCommandEntered { pub raw: String }
#[derive(Event)] pub struct ClearHistory        { pub agent: Entity }
#[derive(Event)] pub struct SkillChanged        { pub agent: Entity, pub name: String }

pub enum SlashCommand {
    Help,
    Skill(String),
    Clear,
    Status,
    Mcp,
    Unknown(String),
}
```

### Interaction with TurnPhase

Slash commands are accepted in **any** `TurnPhase`. Commands that mutate state
(`/skill`, `/clear`) take effect at the start of the next turn cycle
(i.e. when the current phase reaches `Idle` or `Compacting`), so they never
interrupt an in-flight provider call or tool dispatch.

`/clear` mid-turn queues a `ClearHistory` event; `compact_system` drains it
at the next `Compacting` phase.

### TUI Input Bar Integration

```
user presses /
  → TuiPlugin activates input bar widget
  → user types command, presses Enter
  → TuiPlugin emits SlashCommandEntered { raw }
  → CommandsPlugin::dispatch_system parses + acts
  → result printed to conversation pane as [harness] role message
```

The `[harness]` role is a new `TuiRole` variant — visually distinct from
`[assistant]`, `[tool]`, and `[thinking]`.

### Module Location

```
src/plugins/commands_plugin.rs   — CommandsPlugin + dispatch_system
```

No separate `src/commands/` directory; all logic fits in one file for
built-ins-only scope.

---

## TUI — ratatui

The terminal UI is built with **ratatui**. It is a separate plugin (`TuiPlugin`)
that subscribes to ECS events and renders a live view of the agent loop without
touching any other plugin's systems.

### Why ratatui

- Pure Rust, no system dependencies, cross-platform.
- Decoupled from Bevy: renders from ECS events only — no component queries.
- No extra threads needed: the ratatui draw call runs in a dedicated
  `TuiPlugin` system each tick.

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  abt  [model: qwen2.5-coder:7b]  [turn 3/20]  [tokens: 1.2k]│  ← header bar
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  [assistant]  I'll read src/lib.rs first.                   │  ← conversation
│  [tool]       read_file("src/lib.rs")  →  OK (312 tokens)   │    scroll pane
│  [thinking]   The struct layout suggests…                   │
│  [assistant]  Here is the refactored version:               │
│               …streaming text appears here live…            │
│  [harness]    Skill changed → rust-refactor                 │  ← slash cmd output
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  [P5 GATE]  shell("cargo test")  Allow? [Y/n]               │  ← approval gate
│             (only visible when interactive permission mode)  │    (optional row)
├─────────────────────────────────────────────────────────────┤
│  > /skill rust-refactor_                                    │  ← input bar
│    (activates on `/`; Enter dispatches; Escape cancels)     │
├─────────────────────────────────────────────────────────────┤
│  [verify]  cargo test ✓   cargo clippy ✓                    │  ← status bar
│  [hooks]   PostToolUse: log-tool-use.sh ✓                   │
│  [trace]   ~/.abt/traces/20260105_abc123.jsonl              │
└─────────────────────────────────────────────────────────────┘
```

### Events Consumed

`TuiPlugin` systems read these events (read-only; no component mutation):

| Event | Rendered as |
|-------|------------|
| `StreamChunkReceived` | Appends delta content to conversation pane live |
| `ToolCallsReady` | Shows pending tool calls with `[dispatching…]` indicator |
| `ToolCallDone` | Updates tool row with result summary + duration |
| `AllToolsDone` | Clears dispatching indicators |
| `HookFired` | Appends hook row to status bar |
| `VerificationPassed` / `VerificationFailed` | Updates verify row in status bar |
| `TraceFlushed` | Updates trace path in status bar |
| `SubAgentSpawned` / `SubAgentDone` | Shows sub-agent lifecycle in conversation pane |

`TuiPlugin` **emits** one event:

| Event | When |
|-------|------|
| `SlashCommandEntered { raw: String }` | User presses Enter in the input bar |

`TuiPlugin` also reads the `TurnPhase` component on `AgentEntity` entities
to display the current phase in the header.

### TUI State

`TuiPlugin` maintains its own private resource (not shared with other plugins):

```rust
#[derive(Resource)]
pub struct TuiState {
    pub terminal:     ratatui::Terminal<CrosstermBackend<Stdout>>,
    pub messages:     Vec<TuiMessage>,   // conversation pane buffer
    pub status:       StatusBar,         // verify + hook + trace rows
    pub scroll:       usize,             // conversation pane scroll offset
    pub pending_gate: Option<GatePrompt>, // P5 approval gate prompt
}

pub struct TuiMessage {
    pub role:    TuiRole,   // Assistant | Tool | Thinking | SubAgent
    pub content: String,
    pub meta:    String,    // e.g. "312 tokens", "1.4s", "✓"
}
```

`TuiState` is the only ratatui state. All other plugins remain unaware of the
TUI — they just fire events as always.

### Streaming Text

`StreamChunkReceived` events carry `Delta { content, thinking, tool_calls }`.
`TuiPlugin::handle_stream_chunks_system` appends `content` to the last
`Assistant` message in `TuiState.messages` and calls `terminal.draw()` each
tick, producing a live typewriter effect.

`thinking` tokens are appended to a collapsible `[thinking]` row (dimmed by
default; toggle with `t`).

### P5 Approval Gate in TUI

When `permissions.mode = "interactive"` and a tool call is denied by the
pattern gate, `TuiPlugin` renders the `GatePrompt` row at the bottom. The user
presses `y` / `n` (or `Enter` to accept the default). The answer is sent back
via a `GateResponse` channel that `spawn_tool_calls_system` reads before
deciding to spawn or deny the `ToolCallEntity`.

### Key Bindings

| Key | Action |
|-----|--------|
| `↑` / `↓` | Scroll conversation pane |
| `t` | Toggle thinking token visibility |
| `/` | Activate input bar for slash command entry |
| `Escape` | Cancel input bar |
| `q` | Quit (only after `TurnPhase::Done` or `Failed`) |
| `y` / `n` | Approve / deny gate prompt (interactive mode only) |

### Headless Mode

Set `config.toml [ui] tui = false` (or pass `--no-tui`) to disable `TuiPlugin`
entirely. In headless mode the binary falls back to plain stdout/stderr output
(delta content → stdout, thinking → stderr), which is the existing behaviour
used by CI and scripting.

### Plugin Registration

```rust
// main.rs
if !cli.no_tui && config.ui.tui {
    app.add_plugins(TuiPlugin);
}
```

`TuiPlugin` is the last plugin added. It has no systems that write Components
or Resources owned by other plugins, so ordering constraints are minimal.

### Module Location

```
src/plugins/tui_plugin.rs    — TuiPlugin impl + all TUI systems
src/plugins/commands_plugin.rs — CommandsPlugin + dispatch_system (see Slash Commands section)
src/tui/
  mod.rs                     — re-exports
  layout.rs                  — ratatui widget composition
  state.rs                   — TuiState, TuiMessage, StatusBar
  gate.rs                    — GatePrompt + GateResponse channel
  input.rs                   — input bar widget + SlashCommandEntered emit
```

---

## Dependencies (updated)

All prior dependencies retained. New addition:

| Crate | Purpose |
|-------|---------|
| `ratatui` | Terminal UI rendering |
| `crossterm` | Cross-platform terminal backend for ratatui |

---

## Milestones (ECS)

| # | Milestone | Primitives delivered |
|---|-----------|----------------------|
| M1 | `bevy_ecs` skeleton: `AgentPlugin`, `TurnPhase` FSM, event wiring | — |
| M2 | `ProviderPlugin`: SSE stream → channel → accumulate | P2 |
| M3 | `SkillsPlugin`: system_prompt + skill load | P1, P9 |
| M4 | `ToolsPlugin` + `McpPlugin`: dispatch, permission gate | P4, P5 |
| M5 | Full turn loop wired: Idle → Requesting → ToolDispatching → loop | P2–P5, P7 |
| M6 | `ContextPlugin`: token count + compaction | P3 |
| M7 | `TracePlugin` + `StatePlugin`: JSONL flush, plan persistence | P6, P10 |
| M8 | `HooksPlugin` + `VerifyPlugin`: hooks + verification steps | P7, P10 |
| M9 | `SubagentPlugin`: child entity spawn + result collection | P8 |
| M10 | `TuiPlugin`: ratatui live view, input bar, gate prompts, headless mode | UI |
| M11 | `CommandsPlugin`: /help, /skill, /clear, /status, /mcp | slash cmds |
| M12 | CLI polish, cross-platform release, integration tests | all |
