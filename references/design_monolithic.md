# Coding Agent Harness — Design Plan

## Overview

`abt` is a Rust CLI / library that implements all 10 harness primitives
described in `ARCHITECTURE.md`. It speaks the **OpenAI Chat Completions API**
(streaming + tool calls), making it compatible with any OpenAI-compatible
backend. **Ollama** (local) is the primary test target; OpenAI, Groq, and
LM Studio work without code changes.

Ships as a single self-contained binary for Windows, macOS, and Linux.

---

## Goals

- [ ] Implement all 10 harness primitives (instructions → observability)
- [ ] Drive any OpenAI-compatible LLM through a streaming, multi-turn agentic loop
- [ ] Test and develop against **Ollama** locally (no API key needed)
- [ ] Scaffold `.abt/` home directory on first run with all config, skills, MCP, traces
- [ ] Ship as a static binary for Windows x86-64, macOS arm64/x86-64, Linux arm64/x86-64

---

## Primitive → Implementation Mapping

| # | Primitive              | Implemented by                                      | `.abt/` file(s)                          |
|---|------------------------|-----------------------------------------------------|------------------------------------------|
| 1 | Instructions           | `skills.rs` — loads `system_prompt.md` + skill file | `system_prompt.md`, `skills/<name>.md`   |
| 2 | Context Delivery       | `harness.rs` — injects files/logs into messages     | workspace root in `config.toml`          |
| 3 | Context Management     | `context.rs` — token counting, compaction, summary  | `config.toml` `[context]` section        |
| 4 | Tool Interface         | `tools/` + `mcp/` — built-in tools + MCP servers   | `mcp/servers.json`, `config.toml [tools]`|
| 5 | Execution Environment  | `tools/shell.rs` — scope, timeout, permissions gate | `settings.json` `permissions`            |
| 6 | Durable State          | `trace.rs`, `state.rs` — JSONL trace + plan files   | `traces/`, `workspaces/`                 |
| 7 | Orchestration          | `harness.rs` — hooks, retries, approval gates       | `settings.json` `hooks`                  |
| 8 | Sub-agents             | `subagent.rs` — spawn child harness, narrow context | inherits `skills/`, own trace            |
| 9 | Skills                 | `skills.rs` — load `.md`, append to system prompt   | `skills/<name>.md`                       |
|10 | Verification & Observability | `verify.rs` + `trace.rs` — run checks, JSONL log | `traces/`, `logs/abt.log`          |

---

## Module Layout

```
src/
  main.rs          — CLI entry point (clap); calls dirs::init_home() on startup
  lib.rs           — public re-exports
  dirs.rs          — home dir resolution + first-run scaffold         [P1,P6]
  harness.rs       — AgentHarness: agentic loop, hooks, retries       [P2,P7]
  context.rs       — token budget, compaction, message trimming        [P3]
  skills.rs        — load system_prompt.md + skills/<name>.md          [P1,P9]
  subagent.rs      — spawn child AgentHarness with narrowed context    [P8]
  verify.rs        — post-turn verification checks (tests, build, lint)[P10]
  state.rs         — durable plan/task state (read/write JSON)         [P6]
  settings.rs      — parse settings.json (permissions, hooks, env, ui) [P5,P7]
  config.rs        — Config loader: merges home config + env + CLI     [all]
  trace.rs         — TraceLogger: JSONL per-run trace + thinking blocks[P6,P10]
  error.rs         — unified Error / Result types
  provider/
    mod.rs         — OpenAI Chat Completions wire types                [P2]
    client.rs      — OpenAiClient: chat() + chat_stream() (SSE)        [P2]
    stream.rs      — SSE line parser → StreamChunk decoder             [P2]
  tools/
    mod.rs         — Tool trait + ToolRegistry                         [P4]
    read_file.rs
    write_file.rs
    shell.rs       — exec env: scope, timeout, permission gate         [P4,P5]
    grep.rs        — pure-Rust regex search                            [P4]
    list_dir.rs
  mcp/
    mod.rs         — MCP client trait + McpRegistry                    [P4]
    server.rs      — spawn/connect stdio or SSE MCP servers            [P4]
    servers_json.rs — parse ~/.abt/mcp/servers.json                   [P4]
```

---

## High-Level Architecture

```
CLI / Library entry-point
        │
        ▼  init_home() → scaffold ~/.abt/
   AgentHarness
        │
        ├─[P1] Instructions ──── system_prompt.md + active skill.md
        │
        ├─[P2] Provider ───────── OpenAiClient (streaming SSE)
        │         ├─ Ollama  http://localhost:11434/v1   ← default
        │         ├─ OpenAI  https://api.openai.com/v1
        │         └─ any OpenAI-compatible endpoint
        │
        ├─[P3] ContextManager ── token counter, compaction, summaries
        │
        ├─[P4] ToolRegistry ───── built-in tools + MCP servers
        │         ├─ ReadFileTool / WriteFileTool / GrepTool / ListDirTool
        │         └─ ShellTool  [P5 execution env: scope + permissions]
        │
        ├─[P6] TraceLogger ────── JSONL per run  →  ~/.abt/traces/
        │       StateStore ─────── plan / task state  →  ~/.abt/workspaces/
        │
        ├─[P7] Orchestrator ───── hooks (Pre/PostToolUse, Stop), retries,
        │                          approval gates  ←  settings.json
        │
        ├─[P8] SubagentSpawner ── fork child harness with narrow context
        │
        ├─[P9] SkillLoader ────── ~/.abt/skills/<name>.md appended to prompt
        │
        └─[P10] Verifier ──────── post-turn checks; flushes trace + log
```

---

## Agent Loop (harness.rs)

```
Startup:
  1. init_home()                          — scaffold ~/.abt/ [P6]
  2. load Config                          — config.toml + settings.json
  3. build system message:
       system_prompt.md + active skill    — [P1]
       inject requested context files     — [P2]
  4. push user task onto history

Loop:
  5. ContextManager.trim(history)         — stay within token budget [P3]
  6. run PreToolUse hooks                 — settings.json hooks      [P7]
  7. OpenAiClient::chat_stream()          — provider call            [P2]
     stream thinking tokens → stderr
     stream content tokens  → stdout
     accumulate tool_call fragments
  8. on Done:
     a. finish_reason == "stop"
          → Verifier.run()               — tests, build, lint        [P10]
          → TraceLogger.flush()          — write JSONL               [P6,P10]
          → return final answer
     b. finish_reason == "tool_calls"
          → for each ToolCall:
              i.  check permissions gate               [P5]
              ii. ToolRegistry.dispatch(tool, args)    [P4]
                  (may spawn SubAgent for heavy work)  [P8]
              iii.push tool result onto history
          → run PostToolUse hooks                      [P7]
          → StateStore.save(plan)                      [P6]
          → loop
  9. check stop conditions (max_turns, error threshold)
```

---

## Primitive Deep-Dives

### P1 — Instructions (skills.rs)

- `system_prompt.md` loaded verbatim as the `system` message on every run
- `--skill <name>` appends `~/.abt/skills/<name>.md` to the system message
- Skills encode: when to use the skill, input expectations, step order, preferred tools

### P2 — Context Delivery + Streaming (provider/)

`ChatMessage` / `ChatRequest` / `StreamChunk` mirror the OpenAI wire format exactly.
`chat_stream()` returns `impl Stream<Item = Result<StreamChunk>>` over SSE.

`ChatRequest` fields relevant here:
```rust
pub stream:   bool,
pub thinking: Option<ThinkingConfig>,   // { type: "enabled", budget_tokens }
```

`StreamChunk` variants: `Delta { content, thinking, tool_calls }` and `Done { finish_reason, usage }`.

Thinking tokens stream to stderr; content tokens stream to stdout. Both are recorded in the trace.

### P3 — Context Management (context.rs)

```rust
pub struct ContextManager {
    max_tokens:    u32,
    reserve_tokens: u32,   // headroom for the next response
}

impl ContextManager {
    // Trim oldest non-system messages until history fits the budget.
    // Summarises dropped turns rather than silently discarding them.
    pub fn trim(&self, history: &mut Vec<ChatMessage>) -> TrimReport;
}
```

Compaction triggers when `token_count(history) > max_tokens - reserve_tokens`.

### P4 — Tool Interface (tools/ + mcp/)

```rust
#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn spec(&self) -> ToolDef;                       // OpenAI function schema
    async fn run(&self, arguments: &str, env: &ExecEnv) -> Result<String>;
}
```

Built-in tools: `read_file`, `write_file`, `shell`, `grep`, `list_dir`.
MCP tools: registered via `mcp/servers.json`; each MCP server's tool list is
merged into the `ToolRegistry` at startup.

### P5 — Execution Environment (tools/shell.rs + settings.rs)

- `ExecEnv` carries: `workspace_root`, `allow` patterns, `deny` patterns, `shell_timeout`
- `ShellTool` checks `permissions.allow/deny` from `settings.json` before exec
- Invokes `cmd.exe /C` on Windows, `/bin/sh -c` on Unix (runtime detection)
- Timeout enforced via `tokio::time::timeout`

### P6 — Durable State (trace.rs + state.rs)

- `TraceLogger` writes one JSONL file per run to `~/.abt/traces/<ts>_<id>.jsonl`
  — each line is one turn: role, content, thinking, tool calls, tool results, usage
- `StateStore` reads/writes `~/.abt/workspaces/<name>.json` for plan + task state
  so runs can resume rather than restart

### P7 — Orchestration (harness.rs + settings.rs)

Hooks in `settings.json`:
```json
{
  "hooks": {
    "PreToolUse":  [{ "match": "shell", "command": "echo pre" }],
    "PostToolUse": [],
    "Stop":        []
  }
}
```
Hooks are shell commands; the harness runs them and surfaces non-zero exits
as warnings (configurable to block). Retry logic: up to `max_retries` on
transient provider errors with exponential back-off.

### P8 — Sub-agents (subagent.rs)

```rust
pub struct SubAgentConfig {
    pub task:          String,
    pub skill:         Option<String>,   // narrow skill loaded
    pub tools:         Vec<String>,      // subset of parent's tool registry
    pub max_turns:     usize,
    pub inherit_trace: bool,             // append to parent trace or own file
}

pub async fn spawn_subagent(cfg: SubAgentConfig, parent: &AgentHarness) -> Result<String>;
```

Sub-agents share the provider client but get their own `ConversationHistory`
and `ContextManager`. Parent integrates the result as a tool result message.

### P9 — Skills (skills.rs)

```rust
pub fn load_skill(name: &str, home: &AbtDirs) -> Result<String>;
pub fn list_skills(home: &AbtDirs) -> Result<Vec<String>>;
```

Skill file is appended after `system_prompt.md` with a `--- skill: <name> ---`
separator so the model can distinguish harness instructions from task procedure.

### P10 — Verification & Observability (verify.rs + trace.rs)

`Verifier` runs after every `finish_reason == "stop"`:

```rust
pub struct VerificationStep {
    pub name:    String,
    pub command: String,   // e.g. "cargo test", "cargo clippy"
    pub on_fail: FailAction,  // Warn | Block | Retry
}
```

Steps are configured in `settings.json` under `"verify"`. Results are appended
to the trace and printed as a summary. A failed `Block`-step causes the harness
to push the failure back to the model for one more turn before giving up.

---

## Home Directory (`~/.abt/`)

| Platform | Path                                  |
|----------|---------------------------------------|
| Windows  | `%USERPROFILE%\Documents\.abt\`       |
| macOS    | `~/Documents/.abt/`                   |
| Linux    | `~/Documents/.abt/`                   |

Resolved via `dirs::document_dir()`, fallback to `$HOME/.abt`.

### Layout

```
~/.abt/
  config.toml          — provider, agent, tool, trace, log settings
  credentials.toml     — API keys  (0600 / ACL-restricted)
  settings.json        — permissions, hooks, verify steps, env, ui
  system_prompt.md     — default system prompt  [P1]
  skills/              — skill .md files         [P9]
    default.md
  mcp/                 — MCP server registry     [P4]
    servers.json
  traces/              — per-run JSONL            [P6,P10]
  logs/                — rolling log              [P10]
    abt.log
  workspaces/          — durable plan/task state  [P6]
```

### `config.toml` defaults

```toml
[provider]
base_url        = "http://localhost:11434/v1"
model           = "qwen2.5-coder:7b"
max_tokens      = 4096

[agent]
max_turns       = 20
stream          = true
thinking        = false
thinking_budget = 2048
system_prompt   = "~/.abt/system_prompt.md"

[context]
reserve_tokens  = 512     # headroom for next response  [P3]
compaction      = "summarise"  # summarise | drop | error

[tools]
allowlist       = ["read_file", "write_file", "shell", "grep", "list_dir"]
shell_timeout_secs = 30

[mcp]
enabled         = true
servers_file    = "~/.abt/mcp/servers.json"

[trace]
enabled         = true
dir             = "~/.abt/traces"

[log]
level           = "info"
file            = "~/.abt/logs/abt.log"
```

### `settings.json` defaults

```json
{
  "permissions": {
    "allow": ["Bash(cargo:*)", "Bash(git:*)"],
    "deny":  []
  },
  "hooks": {
    "PreToolUse":  [],
    "PostToolUse": [],
    "Stop":        []
  },
  "verify": [
    { "name": "tests", "command": "cargo test", "on_fail": "Block" }
  ],
  "env":  { "RUST_LOG": "info" },
  "ui":   { "show_thinking": true, "color": "auto" }
}
```

### Config resolution order

```
CLI flags  >  env vars  >  ~/.abt/config.toml  >  compiled-in defaults
API keys:  CLI  >  OPENAI_API_KEY  >  credentials.toml
```

---

## CLI Interface

```
# Run a task (all primitives active by default)
abt run "add a Fibonacci function to src/lib.rs"

# With a skill loaded  [P9]
abt run --skill rust-refactor "extract this into a module"

# Enable thinking  [P2]
abt run --thinking --thinking-budget 8192 "design a caching strategy"

# Spawn a sub-agent for a subtask  [P8]
abt run --subagent-skill code-review "review the diff in src/"

# Disable streaming / verification
abt run --no-stream --no-verify "add docstrings"

# Point at OpenAI
abt run --base-url https://api.openai.com/v1 --model gpt-4o "fix tests"

# Home directory management
abt init                          # re-scaffold ~/.abt/ (never overwrites)
abt config show                   # print resolved config
abt config edit                   # open config.toml in $EDITOR
abt skills list / show / edit     # manage skills        [P9]
abt mcp list / add / enable       # manage MCP servers   [P4]
abt traces list / show <id>       # inspect traces       [P10]
```

---

## Dependencies

| Crate                | Purpose                                          | Notes                           |
|----------------------|--------------------------------------------------|---------------------------------|
| `tokio`              | async runtime                                    |                                 |
| `reqwest`            | HTTP client + SSE streaming                      | `rustls-tls`, `stream` features |
| `futures-util`       | `StreamExt` for SSE stream                       |                                 |
| `serde`/`serde_json` | OpenAI wire format + trace JSONL                 |                                 |
| `toml`               | `config.toml` / `credentials.toml`               |                                 |
| `clap`               | CLI argument parsing                             |                                 |
| `dirs`               | platform Documents dir → `~/.abt/`               |                                 |
| `async-trait`        | trait-object-safe async methods                  |                                 |
| `anyhow`/`thiserror` | error handling                                   |                                 |
| `tracing`            | structured logging                               |                                 |
| `tracing-appender`   | rolling log file → `~/.abt/logs/`                |                                 |
| `tiktoken-rs`        | token counting for context management            | [P3]                            |
| `regex`              | grep tool — pure Rust, no external binary        |                                 |
| `walkdir`            | directory walking (list_dir + grep scope)        |                                 |

---

## Cross-Platform Distribution

| Platform       | Target triple                | Archive   |
|----------------|------------------------------|-----------|
| Linux x86-64   | `x86_64-unknown-linux-musl`  | `.tar.gz` |
| Linux arm64    | `aarch64-unknown-linux-musl` | `.tar.gz` |
| macOS x86-64   | `x86_64-apple-darwin`        | `.tar.gz` |
| macOS arm64    | `aarch64-apple-darwin`       | `.tar.gz` |
| Windows x86-64 | `x86_64-pc-windows-msvc`     | `.zip`    |

- Linux: musl static — zero runtime deps
- TLS: `rustls` (statically linked — no OpenSSL)
- CI: GitHub Actions matrix via `taiki-e/upload-rust-binary-action`

---

## Open Questions

- [ ] Compaction strategy: summarise-in-place vs. rolling window vs. RAG retrieval?
- [ ] Sub-agent concurrency: sequential by default, parallel opt-in?
- [ ] Sandboxing: allow-list only (v1) or container/devcontainer (v2)?
- [ ] Checkpoint/resume: resume from last `StateStore` snapshot on crash?
- [ ] TUI: live trace viewer during run?

---

## Milestones

| # | Milestone | Primitives delivered |
|---|-----------|----------------------|
| M1 | Skeleton: `cargo new`, module stubs, CI | — |
| M2 | Provider: `OpenAiClient` + SSE streaming against Ollama | P2 |
| M3 | Instructions + Skills: `system_prompt.md`, `skills/` load | P1, P9 |
| M4 | Tools + Exec Env: all 5 built-in tools, permission gate | P4, P5 |
| M5 | Agent loop: full streaming loop, tool dispatch, stop conditions | P2–P5, P7 |
| M6 | Context management: token budget, compaction | P3 |
| M7 | Durable state + Observability: trace JSONL, state store, log | P6, P10 |
| M8 | Orchestration + Verification: hooks, retries, verify steps | P7, P10 |
| M9 | MCP + Sub-agents: MCP server registry, child harness spawn | P4, P8 |
| M10 | CLI polish + cross-platform release pipeline | all |
