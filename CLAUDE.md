# abt — Coding Agent Harness

## Project Summary

`abt` is a Rust CLI/library that implements a full coding-agent harness built on **Bevy ECS** (`bevy_ecs` + `bevy_app` only — no rendering). Every agent turn is data flowing through ECS Systems; all mutable state lives in Components attached to Entities.

The binary speaks the **OpenAI Chat Completions API** (streaming + tool calls) and is compatible with Ollama (local default), OpenAI, Groq, and LM Studio.

## Status

Design phase. `design_ecs.md` is the authoritative, iteratively-growing architecture document. Development has not started yet.

## The 10 Harness Primitives

Every feature exists to implement one or more of these:

| # | Name | Purpose |
|---|------|---------|
| P1 | Instructions | System message: role, constraints, procedure |
| P2 | Context Delivery & Streaming | Package everything for the API call; receive output live via SSE |
| P3 | Context Management | Keep conversation within token budget (compaction strategies) |
| P4 | Tool Interface | Typed actions the model can request (read/write/shell/grep/list + MCP) |
| P5 | Execution Environment | Permission gate — what tool calls are actually allowed to run |
| P6 | Durable State | JSONL trace, plan persistence, resume across crashes |
| P7 | Orchestration | Lifecycle hooks, retries, approval gates, stop conditions |
| P8 | Sub-agents | Child `AgentEntity` in same ECS World with narrower scope/tools |
| P9 | Skills | Markdown procedure files appended to system prompt at invocation |
| P10 | Verification & Observability | Auto-run checks post-turn; complete structured trace |

References `[P3]`, `[P7]`, etc. throughout the codebase point to this table.

## Architecture at a Glance

```
AgentEntity (one per agent/sub-agent)
  ├── ToolCallEntity (one per in-flight tool call)
  └── TraceEntity (JSONL writer handle)

TurnPhase FSM:
  Idle → Compacting → HookPreTool → Requesting → ToolDispatching
       → HookPostTool → (loop) → Verifying → Tracing → Done
```

Async bridge: ECS systems are sync; long I/O (SSE stream, shell exec) runs in tokio tasks and posts results back via `crossbeam-channel`. The tokio runtime is a `TokioRuntime` ECS Resource.

## Plugin Layout (`src/plugins/`)

Each primitive maps to one or more plugins:

| Plugin | Primitives |
|--------|-----------|
| `agent_plugin` | glue: spawns AgentEntity, drives TurnPhase FSM |
| `provider_plugin` | P2: SSE stream + accumulate |
| `context_plugin` | P3: token count + compaction |
| `skills_plugin` | P1, P9: system_prompt + skill file load |
| `tools_plugin` | P4, P5: ToolRegistry, dispatch, permission gate |
| `mcp_plugin` | P4: MCP server pool |
| `trace_plugin` | P6, P10: JSONL flush |
| `state_plugin` | P6: plan persistence |
| `hooks_plugin` | P7: PreToolUse / PostToolUse / Stop |
| `orchestrator_plugin` | P7: retry logic + approval gate |
| `verify_plugin` | P10: verification steps |
| `subagent_plugin` | P8: child entity spawn + result collection |
| `tui_plugin` | UI: ratatui live view, input bar, gate prompts, headless mode |
| `commands_plugin` | slash command parsing + dispatch |
| `dirs_plugin` | infra: scaffold `~/.abt/` |
| `config_plugin` | infra: load `config.toml` + `settings.json` |

## Key Files

- `design_ecs.md` — authoritative architecture spec (read this first)
- `references/ARCHITECTURE.md` — conceptual overview of the 10 primitives
- `references/design_monolithic.md` — superseded monolithic design (reference only)
- `src/components.rs` — all Component + Event type definitions
- `src/resources.rs` — all Resource type definitions

## Config Surface

| File | Controls |
|------|---------|
| `~/.abt/config.toml` | provider endpoint, model, context budget, tool allowlist, tracing |
| `~/.abt/settings.json` | permissions allow/deny, hooks, verification steps |
| `~/.abt/system_prompt.md` | base system prompt |
| `~/.abt/skills/<name>.md` | skill procedure files |
| `~/.abt/mcp/servers.json` | MCP server definitions |
| `~/.abt/traces/` | per-run JSONL trace files |
| `~/.abt/workspaces/<name>.json` | plan state for resume |

## Development Milestones

| # | Milestone | Primitives |
|---|-----------|-----------|
| M1 | `bevy_ecs` skeleton: AgentPlugin, TurnPhase FSM, event wiring | — |
| M2 | ProviderPlugin: SSE stream → channel → accumulate | P2 |
| M3 | SkillsPlugin: system_prompt + skill load | P1, P9 |
| M4 | ToolsPlugin + McpPlugin: dispatch, permission gate | P4, P5 |
| M5 | Full turn loop wired | P2–P5, P7 |
| M6 | ContextPlugin: token count + compaction | P3 |
| M7 | TracePlugin + StatePlugin: JSONL flush, plan persistence | P6, P10 |
| M8 | HooksPlugin + VerifyPlugin | P7, P10 |
| M9 | SubagentPlugin | P8 |
| M10 | TuiPlugin: ratatui live view, input bar, gate prompts, headless mode | UI |
| M11 | CommandsPlugin: /help, /skill, /clear, /status, /mcp | slash cmds |
| M12 | CLI polish, cross-platform release, integration tests | all |

## Code Style & Conventions

- Rust edition 2021
- `bevy_ecs` + `bevy_app` only (no full Bevy; no rendering)
- Async work in tokio tasks; sync ECS systems communicate via `crossbeam-channel`
- Each plugin registers its own systems and resources in `Plugin::build()`
- Components are the single source of truth for agent state — no shared mutable globals
- `TurnPhase` is an ECS Component, not a central controller; each system advances phase only for entities it owns
- Built-in tools implement the `Tool` trait in `tools/mod.rs`
- MCP tools are discovered at startup and merged into `ToolRegistry` — indistinguishable from built-ins at dispatch time

## Slash Commands

Slash commands are typed in the **TUI input bar** (activated by pressing `/`).
They are processed by `CommandsPlugin` — never sent to the model.

| Command | Effect |
|---------|--------|
| `/help` | List all commands in the conversation pane |
| `/skill <name>` | Load `~/.abt/skills/<name>.md`, update `ActiveSkill`, rebuild `SystemPrompt` |
| `/clear` | Discard conversation history (queued as `ClearHistory` event, applied at next `Compacting`) |
| `/status` | Print turn count, token count, active skill, model, provider, `TurnPhase` |
| `/mcp` | List connected MCP servers, status, and tool counts |

All commands are built-in only (no user-defined commands). Results appear as
`[harness]`-role messages in the conversation pane. Commands that mutate state
take effect at the start of the next turn cycle, never mid-flight.

## Terminal UI (ratatui)

The TUI is owned by `TuiPlugin` and built with **ratatui** + **crossterm**.
It subscribes to ECS events (read-only) and renders a live view:

- **Header bar**: model name, turn counter, token count, current `TurnPhase`
- **Input bar**: activates on `/`; `Enter` dispatches; `Escape` cancels
- **Conversation pane**: streaming assistant text, tool call rows, thinking tokens (toggle `t`), `[harness]` slash command output
- **Approval gate row**: shown only in `interactive` permission mode when a tool is gated
- **Status bar**: verification results, hook outcomes, trace file path

`TuiPlugin` never writes Components or Resources owned by other plugins.
Disable with `config.toml [ui] tui = false` or `--no-tui`; falls back to
plain stdout/stderr (streaming content → stdout, thinking → stderr).

Module layout: `src/plugins/tui_plugin.rs`, `src/tui/{layout,state,gate}.rs`

## Key Dependencies

| Crate | Purpose |
|-------|---------|
| `bevy_ecs` | ECS World, Components, Systems, Events |
| `bevy_app` | App builder + scheduler (MinimalPlugins) |
| `crossbeam-channel` | sync↔async bridge |
| `tokio` | async runtime |
| `reqwest` | HTTP client for provider SSE |
| `serde` / `serde_json` | serialisation |
| `tiktoken-rs` | token counting |
| `clap` | CLI parsing |
| `uuid` | AgentId |
| `tracing` / `tracing-appender` | structured logging |
| `ratatui` | terminal UI rendering |
| `crossterm` | cross-platform terminal backend for ratatui |
