use bevy_ecs::prelude::*;

#[derive(Default)]
pub struct AgentConfig {
    pub max_turns: usize,
}

#[derive(Resource)]
pub struct GlobalConfig {
    pub agent: AgentConfig,
}

impl Default for GlobalConfig {
    fn default() -> Self {
        Self {
            agent: AgentConfig { max_turns: 20 },
        }
    }
}
