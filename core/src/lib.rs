pub mod application;
pub mod capability_map;
pub mod collaboration;
mod domain;
mod infrastructure;
pub mod local_settings;
pub mod model_service;
pub mod plugin_settings;

pub use application::Kernel;
pub use domain::{Error, Result, failure as failure_result};
