#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("ECS error: {0}")]
    Ecs(String),
}

pub type Result<T> = std::result::Result<T, Error>;
