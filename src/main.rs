use abt::components::TaskSubmitted;
use abt::plugins::agent_plugin::AgentPlugin;
use abt::resources::GlobalConfig;
use bevy_app::{App, ScheduleRunnerPlugin};

fn main() {
    let mut app = App::new();
    app.add_plugins(ScheduleRunnerPlugin::run_once())
        .insert_resource(GlobalConfig::default())
        .add_plugins(AgentPlugin);

    app.world_mut()
        .write_message(TaskSubmitted { task: "hello world".into() });

    app.run();
}
