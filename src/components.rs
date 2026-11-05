use bevy_ecs::prelude::*;
use uuid::Uuid;

#[derive(Component)]
pub struct AgentId(pub Uuid);

#[derive(Component)]
pub struct AgentLabel(pub String);

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
    Failed,
}

#[derive(Component)]
pub struct TurnCounter(pub usize);

#[derive(Component)]
pub struct MaxTurns(pub usize);

#[derive(Component)]
pub struct RetryCount(pub usize);

#[derive(Message)]
pub struct TaskSubmitted {
    pub task: String,
}

#[derive(Message)]
pub struct TurnStarted {
    pub agent: Entity,
}

#[derive(Message)]
pub struct TurnCompleted {
    pub agent: Entity,
    pub finish_reason: String,
}
