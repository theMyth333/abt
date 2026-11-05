# M1 Dev Plan — bevy_ecs Skeleton

**Goal:** A compiling Rust project with `bevy_ecs` + `bevy_app`, an `AgentEntity` that can be spawned, a `TurnPhase` FSM component, and all core events wired. No I/O yet — just the ECS skeleton that all later milestones build on.

**Done when:**
- `cargo build` succeeds with no warnings
- `cargo test` passes the M1 unit tests
- An `AgentEntity` can be spawned via `TaskSubmitted`, transitions through `TurnPhase::Idle → Done`, and fires `TurnCompleted`

---

## Step 1 — Cargo setup

**Files:** `Cargo.toml`, `src/lib.rs`, `src/main.rs`

Add dependencies:

```toml
[dependencies]
bevy_ecs  = { version = "0.20.1", default-features = false }
bevy_app  = { version = "0.20.1", default-features = false }
uuid      = { version = "1.29.0", features = ["v4"] }
thiserror = "2.0.21"
```

`src/lib.rs` — empty re-export stub for now.  
`src/main.rs` — `fn main() {}` stub (filled in Step 6).

---

## Step 2 — `src/error.rs`

Unified `Error` and `Result` types. Keeps error handling consistent from day one.

```rust
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("ECS error: {0}")]
    Ecs(String),
}

pub type Result<T> = std::result::Result<T, Error>;
```

---

## Step 3 — `src/components.rs`

Define every Component and Event needed for the FSM skeleton. No plugin-specific
types yet — just the core set that `AgentPlugin` depends on.

**Components:**

```rust
#[derive(Component)] pub struct AgentId(pub Uuid);
#[derive(Component)] pub struct AgentLabel(pub String);

#[derive(Component, PartialEq, Eq, Clone, Copy, Debug)]
pub enum TurnPhase {
    Idle,
    Compacting,
    HookPreTool,
    Requesting,
    ToolDispatching,
    HookPostTool,
    Verifying,
    Tracing,
    Done,
    Failed,   // no payload yet; reason added in M7
}

#[derive(Component)] pub struct TurnCounter(pub usize);
#[derive(Component)] pub struct MaxTurns(pub usize);
#[derive(Component)] pub struct RetryCount(pub usize);
```

**Events:**

```rust
#[derive(Event)] pub struct TaskSubmitted { pub task: String }
#[derive(Event)] pub struct TurnStarted   { pub agent: Entity }
#[derive(Event)] pub struct TurnCompleted { pub agent: Entity, pub finish_reason: String }
```

All other component and event types (ProviderConfig, ConversationHistory, etc.)
are stubs in later milestones. Add `pub mod components;` to `lib.rs`.

---

## Step 4 — `src/resources.rs`

Stub resource types. Only `GlobalConfig` is needed for M1 (to supply `MaxTurns`
to the spawner). All other resources are placeholders for later milestones.

```rust
#[derive(Resource, Default)]
pub struct GlobalConfig {
    pub agent: AgentConfig,
}

#[derive(Default)]
pub struct AgentConfig {
    pub max_turns: usize,   // default 20
}

impl Default for GlobalConfig {
    fn default() -> Self {
        Self { agent: AgentConfig { max_turns: 20 } }
    }
}
```

Add `pub mod resources;` to `lib.rs`.

---

## Step 5 — `src/plugins/agent_plugin.rs`

The core plugin for M1. Implements three systems:

### `spawn_agent_system`

Runs when `TaskSubmitted` fires. Spawns an `AgentEntity` with all M1 components
at their default values and transitions `TurnPhase` to `Idle`.

```rust
fn spawn_agent_system(
    mut commands: Commands,
    mut events: EventReader<TaskSubmitted>,
    config: Res<GlobalConfig>,
) {
    for ev in events.read() {
        commands.spawn((
            AgentId(Uuid::new_v4()),
            AgentLabel(ev.task.chars().take(40).collect()),
            TurnPhase::Idle,
            TurnCounter(0),
            MaxTurns(config.agent.max_turns),
            RetryCount(0),
        ));
    }
}
```

### `advance_phase_system`

Placeholder FSM driver for M1. Advances `TurnPhase` for any agent in `Idle`
straight to `Done` (since no provider or tools exist yet). Emits `TurnCompleted`.

Later milestones replace the interior logic while leaving the system signature
unchanged.

```rust
fn advance_phase_system(
    mut q: Query<(Entity, &mut TurnPhase, &mut TurnCounter, &MaxTurns), With<AgentId>>,
    mut turn_ev: EventWriter<TurnCompleted>,
) {
    for (entity, mut phase, mut counter, max) in &mut q {
        match *phase {
            TurnPhase::Idle => {
                // M1 stub: skip straight to Done
                counter.0 += 1;
                *phase = TurnPhase::Done;
                turn_ev.send(TurnCompleted {
                    agent: entity,
                    finish_reason: "stop".into(),
                });
            }
            _ => {}
        }
    }
}
```

### `check_stop_conditions_system`

Checks `TurnCounter ≥ MaxTurns` and transitions to `Done` if exceeded.
Also detects when all agents are `Done` and sends the app exit signal.

```rust
fn check_stop_conditions_system(
    mut q: Query<(Entity, &mut TurnPhase, &TurnCounter, &MaxTurns), With<AgentId>>,
    mut exit: EventWriter<AppExit>,
) {
    let mut all_done = true;
    for (_, mut phase, counter, max) in &mut q {
        if *phase != TurnPhase::Done && *phase != TurnPhase::Failed {
            all_done = false;
        }
        if counter.0 >= max.0 && *phase != TurnPhase::Done {
            *phase = TurnPhase::Done;
        }
    }
    if all_done {
        exit.send(AppExit::Success);
    }
}
```

### Plugin registration

```rust
pub struct AgentPlugin;

impl Plugin for AgentPlugin {
    fn build(&self, app: &mut App) {
        app
            .add_event::<TaskSubmitted>()
            .add_event::<TurnStarted>()
            .add_event::<TurnCompleted>()
            .add_systems(Update, (
                spawn_agent_system.run_if(on_event::<TaskSubmitted>()),
                advance_phase_system,
                check_stop_conditions_system,
            ));
    }
}
```

Create `src/plugins/mod.rs` with `pub mod agent_plugin;`.

---

## Step 6 — `src/main.rs`

Wire everything together:

```rust
fn main() {
    let mut app = App::new();
    app
        .add_plugins(MinimalPlugins)
        .insert_resource(GlobalConfig::default())
        .add_plugins(AgentPlugin);

    app.world_mut()
       .send_event(TaskSubmitted { task: "hello world".into() });

    app.run();
}
```

`MinimalPlugins` pulls in `ScheduleRunnerPlugin` (fixed-rate loop) and the
minimal Bevy core without any rendering dependencies.

---

## Step 7 — Unit tests

Add `#[cfg(test)]` module to `src/plugins/agent_plugin.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use bevy_app::App;
    use bevy_app::MinimalPlugins;

    fn make_app() -> App {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
           .insert_resource(GlobalConfig::default())
           .add_plugins(AgentPlugin);
        app
    }

    #[test]
    fn task_submitted_spawns_agent() {
        let mut app = make_app();
        app.world_mut().send_event(TaskSubmitted { task: "test".into() });
        app.update();
        let count = app.world().query::<&AgentId>().iter(app.world()).count();
        assert_eq!(count, 1);
    }

    #[test]
    fn agent_advances_to_done() {
        let mut app = make_app();
        app.world_mut().send_event(TaskSubmitted { task: "test".into() });
        app.update(); // spawns agent
        app.update(); // advances phase
        let phase = app.world()
            .query::<&TurnPhase>()
            .iter(app.world())
            .next()
            .copied()
            .unwrap();
        assert_eq!(phase, TurnPhase::Done);
    }

    #[test]
    fn max_turns_caps_counter() {
        let mut app = make_app();
        // Override max_turns to 1
        app.world_mut()
           .insert_resource(GlobalConfig { agent: AgentConfig { max_turns: 1 } });
        app.world_mut().send_event(TaskSubmitted { task: "test".into() });
        app.update();
        app.update();
        let phase = app.world()
            .query::<&TurnPhase>()
            .iter(app.world())
            .next()
            .copied()
            .unwrap();
        assert_eq!(phase, TurnPhase::Done);
    }
}
```

---

## File Checklist

| File | Action |
|------|--------|
| `Cargo.toml` | Add `bevy_ecs`, `bevy_app`, `uuid`, `thiserror` |
| `src/main.rs` | App composition + initial `TaskSubmitted` |
| `src/lib.rs` | `pub mod components; pub mod resources; pub mod plugins;` |
| `src/error.rs` | `Error` enum + `Result` alias |
| `src/components.rs` | Core components + events |
| `src/resources.rs` | `GlobalConfig` stub |
| `src/plugins/mod.rs` | `pub mod agent_plugin;` |
| `src/plugins/agent_plugin.rs` | `AgentPlugin` + 3 systems + tests |

---

## Acceptance Criteria

- [ ] `cargo build` — zero errors, zero warnings
- [ ] `cargo test` — all 3 unit tests pass
- [ ] Running `cargo run` spawns one agent, transitions to `Done`, and exits cleanly
- [ ] `TurnPhase` values match the FSM diagram in `design_ecs.md` exactly
- [ ] No rendering dependencies pulled in (verify with `cargo tree | grep bevy_render` — should be empty)
