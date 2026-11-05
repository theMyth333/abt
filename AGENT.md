# AGENT.md — AI Coding Assistant Context

## What This Project Is

`abt` is a Rust-based coding agent harness. It wraps any OpenAI-compatible LLM
(default: Ollama locally) in a full agentic loop implemented as a **Bevy ECS**
application (`bevy_ecs` + `bevy_app` — no game engine, no rendering).

The design document is `design_ecs.md`. Read it before making any architectural
decisions. It is still evolving; do not assume it is complete.

## Current Phase: Design / Pre-Development

No source files exist yet. When development begins, follow the milestones in
`design_ecs.md` in order (M1 → M10). Do not jump ahead.

## Non-Negotiables

1. **ECS everywhere.** Agent state lives in ECS Components on `AgentEntity`.
   No `AgentHarness` struct, no monolithic loop, no global mutable state.
2. **Sync systems, async tasks.** ECS systems are sync. All long I/O (SSE
   streaming, shell execution) goes in tokio tasks. Results come back via
   `crossbeam-channel` resources. Never block an ECS tick.
3. **Plugin per primitive.** Each of the 10 harness primitives maps to one or
   more Bevy Plugins. New features extend existing plugins or add new ones.
4. **`bevy_ecs` + `bevy_app` only.** No `bevy_render`, no `bevy_window`, no
   full `bevy` feature set. Check binary size impact before adding any new
   Bevy sub-crate.
5. **`TurnPhase` drives the FSM.** Phase transitions are written by the system
   that owns that phase. No central dispatch function. Sub-agents reuse all
   the same systems automatically because they are plain entities.

## The 10 Primitives (Quick Reference)

When you see `[P3]` or `[P7]` in code comments, refer here:

| Tag | Name | Implemented by |
|-----|------|---------------|
| P1 | Instructions | `skills_plugin` → `build_system_msg_system` |
| P2 | Context Delivery & Streaming | `provider_plugin` → `stream_system` + `accumulate_system` |
| P3 | Context Management | `context_plugin` → `compact_system` |
| P4 | Tool Interface | `tools_plugin` + `mcp_plugin` → `dispatch_system` |
| P5 | Execution Environment | `tools_plugin` → permission check in `spawn_tool_calls_system` |
| P6 | Durable State | `trace_plugin` + `state_plugin` |
| P7 | Orchestration | `hooks_plugin` + `orchestrator_plugin` |
| P8 | Sub-agents | `subagent_plugin` |
| P9 | Skills | `skills_plugin` (shared with P1) |
| P10 | Verification & Observability | `verify_plugin` + `trace_plugin` |

## Entity Model

```
AgentEntity          — one per running agent (root or sub-agent)
  ├── ToolCallEntity — one per pending tool invocation; despawned when result arrives
  └── TraceEntity    — one per run; holds JSONL writer handle
```

Sub-agents are `AgentEntity` instances with a `ParentAgent(Entity)` component.
They are driven by exactly the same systems as root agents.

## TurnPhase FSM

```
Idle → Compacting → HookPreTool → Requesting → ToolDispatching
     → HookPostTool → (loop back to Compacting) → Verifying → Tracing → Done
                                                                       → Failed(String)
```

- `Compacting` runs P3 (token budget trim) before every provider call.
- `HookPreTool` runs P7 pre-tool hooks; non-zero exit can block the call.
- `Requesting` owns the SSE stream; `accumulate_system` drains the channel.
- `ToolDispatching` spawns/runs/collects tool calls.
- `HookPostTool` runs P7 post-tool hooks; also persists `PlanState` (P6).
- `Verifying` runs P10 checks; `Block` failures loop back to `Compacting`.
- `Tracing` flushes P6 JSONL; then transitions to `Done`.

## Critical Component Types (from `components.rs`)

```rust
TurnPhase           // the FSM state — one per AgentEntity
ConversationHistory // Vec<ChatMessage> — the full history sent each turn
ContextBudget       // max_tokens, reserve_tokens, CompactionStrategy
PermissionGate      // allow/deny patterns for tool calls
ToolAllowlist       // which tools this agent may use
ActiveSkill         // Optional<String> — name of loaded skill file
SystemPrompt        // assembled system message (P1 + P9)
TokenCount          // current estimated token count
PlanState           // JSON plan persisted each tool round
TraceHandle         // Arc<TraceWriter> for JSONL append
```

## Async Bridge Pattern

```
ECS system (sync)
  └── rt.0.spawn(async move { ... })   // start work
         └── channel.send(result)      // result arrives in next tick
ECS system (sync)
  └── channel.try_recv()               // drain + write Component / send Event
```

The `TokioRuntime` resource holds the handle. Never call `block_on` for anything
that involves network I/O or shell execution.

## Tool Trait

```rust
#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self)    -> &str;
    fn spec(&self)    -> ToolDef;               // JSON Schema for the model
    async fn run(&self, arguments: &str, env: &ExecEnv) -> Result<String>;
}
```

Built-in tools: `read_file`, `write_file`, `shell`, `grep`, `list_dir`.
MCP tools are discovered at startup and registered in `ToolRegistry` — they
look identical to built-ins from the dispatch side.

## Permission System

```json
// settings.json
{
  "permissions": {
    "allow": ["Bash(cargo:*)", "Bash(git:*)"],
    "deny":  []
  }
}
```

Pattern syntax mirrors Claude Code's `settings.json`. Deny takes precedence.
The gate runs inside `spawn_tool_calls_system` — a denied call never reaches
the async dispatch path. It gets a pre-filled `ToolResult("Permission denied")`.

## Hooks (P7)

```json
// settings.json
{
  "hooks": {
    "PreToolUse":  [{ "match": "shell", "command": "..." }],
    "PostToolUse": [{ "match": "*",     "command": "..." }],
    "Stop":        [{ "match": "*",     "command": "..." }]
  }
}
```

Hooks receive tool name, arguments, and result as environment variables.
`PreToolUse` non-zero exit blocks the tool call (configurable: `warn` vs `block`).

## Verification Steps (P10)

```json
// settings.json
{
  "verify": [
    { "name": "tests",  "command": "cargo test",   "on_fail": "Block" },
    { "name": "clippy", "command": "cargo clippy", "on_fail": "Warn"  }
  ]
}
```

`Block` → push failure as user message, loop back for another turn.
`Warn` → log and proceed to Done.
`Retry` → retry the entire turn.

## Home Directory Layout

```
~/.abt/
  config.toml          — provider, context budget, tool settings
  settings.json        — permissions, hooks, verify steps
  system_prompt.md     — base system prompt (P1)
  skills/<name>.md     — skill procedure files (P9)
  mcp/servers.json     — MCP server definitions (P4)
  traces/<ts>_<id>.jsonl — per-run JSONL traces (P6, P10)
  workspaces/<name>.json — plan state for resume (P6)
  logs/abt.log         — rolling structured log
```

## Testing Approach

Each plugin is testable in isolation using a minimal Bevy app:

```rust
let mut app = App::new();
app.add_plugins(MinimalPlugins).add_plugins(ThePluginUnderTest);
// spawn entities with test components
app.update();
// assert on component state
```

No HTTP, no disk I/O needed to test most plugins. Mock `ProviderClient` and
`ToolRegistry` resources for provider/tool tests.

## Slash Commands

Slash commands are typed in the **TUI input bar** (user presses `/`). They are
parsed and executed by `CommandsPlugin` — never forwarded to the model.

### Built-in commands

| Command | What it does |
|---------|-------------|
| `/help` | Print all commands as `[harness]` messages in the conversation pane |
| `/skill <name>` | Write `ActiveSkill(Some(name))` on the current `AgentEntity`; `SkillsPlugin` rebuilds `SystemPrompt` next tick |
| `/clear` | Emit `ClearHistory { agent }`; `compact_system` drains it at next `Compacting` phase |
| `/status` | Read `TurnCounter`, `TokenCount`, `ActiveSkill`, `ProviderConfig`, `TurnPhase` from the entity; print as `[harness]` message |
| `/mcp` | Read `McpPool` resource; print server names, connection status, tool counts |

### Flow

```
user presses /
  → TuiPlugin activates input bar (src/tui/input.rs)
  → user types, presses Enter
  → TuiPlugin emits SlashCommandEntered { raw: String }
  → CommandsPlugin::dispatch_system parses into SlashCommand enum
  → mutates ECS state or emits follow-on event
  → result printed as [harness] TuiRole message in conversation pane
```

### Key rules

- Commands that mutate agent state (`/skill`, `/clear`) take effect at the
  **next `Compacting` phase** — they queue an event and return immediately,
  never interrupting an in-flight provider call or tool dispatch.
- `CommandsPlugin` may write `ActiveSkill` but may **not** write
  `ConversationHistory` directly — it emits `ClearHistory` and lets
  `compact_system` apply it.
- No user-defined commands. Built-ins only.
- `/skill` with an unknown name should emit an error `[harness]` message,
  not panic.

### New events (add to `components.rs`)

```rust
#[derive(Event)] pub struct SlashCommandEntered { pub raw: String }
#[derive(Event)] pub struct ClearHistory        { pub agent: Entity }
#[derive(Event)] pub struct SkillChanged        { pub agent: Entity, pub name: String }
```

### Module

```
src/plugins/commands_plugin.rs   — CommandsPlugin, SlashCommand enum, dispatch_system
```



The terminal UI is built with **ratatui** + **crossterm** inside `TuiPlugin`.

### Key rules

- `TuiPlugin` is **read-only** with respect to all other plugins. It consumes
  ECS events and reads `TurnPhase` components, but never writes any Component
  or Resource owned by another plugin.
- It is the **last plugin registered** in `main.rs`.
- Disabled via `config.toml [ui] tui = false` or `--no-tui`. In headless mode
  content → stdout, thinking → stderr (existing behaviour).

### Events consumed by TuiPlugin

| Event | What the TUI does |
|-------|------------------|
| `StreamChunkReceived` | Appends `content` live to conversation pane; `thinking` to collapsible row |
| `ToolCallsReady` | Adds tool rows with `[dispatching…]` indicator |
| `ToolCallDone` | Updates tool row with result summary + duration |
| `AllToolsDone` | Clears dispatching indicators |
| `HookFired` | Appends hook row to status bar |
| `VerificationPassed` / `VerificationFailed` | Updates verify row in status bar |
| `TraceFlushed` | Updates trace path in status bar |
| `SubAgentSpawned` / `SubAgentDone` | Shows sub-agent lifecycle in conversation pane |

`TuiPlugin` **emits** one event (consumed by `CommandsPlugin`):

| Event | When |
|-------|------|
| `SlashCommandEntered { raw: String }` | User presses Enter in the input bar |

### TuiState resource (private to TuiPlugin)

```rust
#[derive(Resource)]
pub struct TuiState {
    pub terminal:     ratatui::Terminal<CrosstermBackend<Stdout>>,
    pub messages:     Vec<TuiMessage>,
    pub status:       StatusBar,
    pub scroll:       usize,
    pub pending_gate: Option<GatePrompt>,
}
```

No other plugin touches `TuiState`.

### P5 approval gate in TUI

When `permissions.mode = "interactive"` and a tool call hits a deny pattern,
`TuiPlugin` renders a `GatePrompt` row. The user presses `y`/`n`. The answer
travels back via a `GateResponse` channel that `spawn_tool_calls_system` reads.

### Key bindings

| Key | Action |
|-----|--------|
| `↑` / `↓` | Scroll conversation pane |
| `t` | Toggle thinking token visibility |
| `/` | Activate input bar |
| `Escape` | Cancel input bar |
| `q` | Quit (only after `Done` or `Failed`) |
| `y` / `n` | Approve / deny gate prompt (interactive mode only) |

### Module layout

```
src/plugins/tui_plugin.rs
src/plugins/commands_plugin.rs  — CommandsPlugin (see Slash Commands section)
src/tui/
  mod.rs       — re-exports
  layout.rs    — ratatui widget composition
  state.rs     — TuiState, TuiMessage, StatusBar
  gate.rs      — GatePrompt + GateResponse channel
  input.rs     — input bar widget + SlashCommandEntered emit
```

### Registration

```rust
// main.rs — always last
if !cli.no_tui && config.ui.tui {
    app.add_plugins(TuiPlugin);
}
```



## What NOT to Do

- Do not create a monolithic `AgentHarness` struct that owns the loop.
- Do not add Bevy rendering or UI dependencies (ratatui + crossterm is the UI layer).
- Do not use `block_on` for network I/O or shell execution inside ECS systems.
- Do not share mutable state between systems outside of ECS Components/Resources/Events.
- Do not let `TuiPlugin` or `CommandsPlugin` write Components or Resources owned by other plugins — use events.
- Do not start M2+ work before the M1 skeleton compiles and the FSM is wired.
- Do not change `design_ecs.md` without flagging it as a design decision —
  it is the living spec and the user is iterating on it.

## Open Design Questions (Do Not Resolve Without Asking)

- Tick rate: fixed-interval scheduler vs. event-driven wakeup?
- `PlanState` checkpoint frequency (currently: every tool round)?
- Tool dispatch: parallel (default Bevy) vs. serialised — pick per threat model?
- Sub-agent isolation: ECS World (current design) vs. child process?
