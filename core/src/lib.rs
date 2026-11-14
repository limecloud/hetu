pub mod application;
pub mod collaboration;
pub mod model_service;
mod domain;
mod ffi;
mod infrastructure;

pub use application::Kernel;
pub use domain::{Error, Result};
