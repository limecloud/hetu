pub mod application;
mod domain;
mod ffi;
mod infrastructure;

pub use application::Kernel;
pub use domain::{Error, Result};
