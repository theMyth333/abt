# Development Log

## Milestone Status

| # | Milestone | Primitives | Status |
|---|-----------|------------|--------|
| M1 | `bevy_ecs` skeleton: `AgentPlugin`, `TurnPhase` FSM, event wiring | — | not started |
| M2 | `ProviderPlugin`: SSE stream → channel → accumulate | P2 | not started |
| M3 | `SkillsPlugin`: system_prompt + skill load | P1, P9 | not started |
| M4 | `ToolsPlugin` + `McpPlugin`: dispatch, permission gate | P4, P5 | not started |
| M5 | Full turn loop wired: Idle → Requesting → ToolDispatching → loop | P2–P5, P7 | not started |
| M6 | `ContextPlugin`: token count + compaction | P3 | not started |
| M7 | `TracePlugin` + `StatePlugin`: JSONL flush, plan persistence | P6, P10 | not started |
| M8 | `HooksPlugin` + `VerifyPlugin`: hooks + verification steps | P7, P10 | not started |
| M9 | `SubagentPlugin`: child entity spawn + result collection | P8 | not started |
| M10 | `TuiPlugin`: ratatui live view, input bar, gate prompts, headless mode | UI | not started |
| M11 | `CommandsPlugin`: /help, /skill, /clear, /status, /mcp | slash cmds | not started |
| M12 | CLI polish, cross-platform release, integration tests | all | not started |

---

## M1 — bevy_ecs Skeleton

**Status:** not started  
**Primitives:** none (structural foundation only)

### Plan

See [dev_plan_m1.md](dev_plan_m1.md) for the detailed implementation plan.
