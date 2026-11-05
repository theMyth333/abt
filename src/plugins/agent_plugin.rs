use bevy_app::{App, Plugin, Update};
use bevy_ecs::prelude::*;
use uuid::Uuid;

use crate::components::{
    AgentId, AgentLabel, MaxTurns, RetryCount, TaskSubmitted, TurnCompleted, TurnCounter,
    TurnPhase, TurnStarted,
};
use crate::resources::GlobalConfig;

pub struct AgentPlugin;

impl Plugin for AgentPlugin {
    fn build(&self, app: &mut App) {
        app.add_message::<TaskSubmitted>()
            .add_message::<TurnStarted>()
            .add_message::<TurnCompleted>()
            .add_systems(
                Update,
                (
                    spawn_agent_system,
                    advance_phase_system,
                    check_stop_conditions_system,
                )
                    .chain(),
            );
    }
}

fn spawn_agent_system(
    mut commands: Commands,
    mut events: MessageReader<TaskSubmitted>,
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

fn advance_phase_system(
    mut q: Query<(Entity, &mut TurnPhase, &mut TurnCounter, &MaxTurns), With<AgentId>>,
    mut turn_ev: MessageWriter<TurnCompleted>,
) {
    for (entity, mut phase, mut counter, _max) in &mut q {
        if *phase == TurnPhase::Idle {
            counter.0 += 1;
            *phase = TurnPhase::Done;
            turn_ev.write(TurnCompleted {
                agent: entity,
                finish_reason: "stop".into(),
            });
        }
    }
}

fn check_stop_conditions_system(
    mut q: Query<(Entity, &mut TurnPhase, &TurnCounter, &MaxTurns), With<AgentId>>,
    mut exit: MessageWriter<bevy_app::AppExit>,
) {
    let mut all_done = true;
    for (_, mut phase, counter, max) in &mut q {
        if *phase != TurnPhase::Done && *phase != TurnPhase::Failed {
            all_done = false;
        }
        if counter.0 >= max.0 && *phase != TurnPhase::Done && *phase != TurnPhase::Failed {
            *phase = TurnPhase::Done;
        }
    }
    if all_done {
        exit.write(bevy_app::AppExit::Success);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy_app::ScheduleRunnerPlugin;

    fn make_app() -> App {
        let mut app = App::new();
        app.add_plugins(ScheduleRunnerPlugin::run_once())
            .insert_resource(GlobalConfig::default())
            .add_plugins(AgentPlugin);
        app
    }

    #[test]
    fn task_submitted_spawns_agent() {
        let mut app = make_app();
        app.world_mut()
            .write_message(TaskSubmitted { task: "test".into() });
        app.update();
        let count = app
            .world_mut()
            .query::<&AgentId>()
            .iter(app.world())
            .count();
        assert_eq!(count, 1);
    }

    #[test]
    fn agent_advances_to_done() {
        let mut app = make_app();
        app.world_mut()
            .write_message(TaskSubmitted { task: "test".into() });
        app.update(); // spawns agent
        app.update(); // advances phase
        let world = app.world_mut();
        let phase = world
            .query::<&TurnPhase>()
            .iter(&*world)
            .next()
            .copied()
            .unwrap();
        assert_eq!(phase, TurnPhase::Done);
    }

    #[test]
    fn max_turns_caps_counter() {
        let mut app = make_app();
        app.world_mut().insert_resource(GlobalConfig {
            agent: crate::resources::AgentConfig { max_turns: 1 },
        });
        app.world_mut()
            .write_message(TaskSubmitted { task: "test".into() });
        app.update();
        app.update();
        let world = app.world_mut();
        let phase = world
            .query::<&TurnPhase>()
            .iter(&*world)
            .next()
            .copied()
            .unwrap();
        assert_eq!(phase, TurnPhase::Done);
    }
}
