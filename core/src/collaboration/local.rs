//! 稳定 CLI/MCP 直接复用本机设置 Owner，无需窗口或子 CLI。
use super::*;

impl CollaborationHub {
    pub(super) fn execute_local(&self, request: &Value) -> Result<Value> {
        Ok(crate::local_settings::LocalSettings::open_default()?
            .request(&self.client, request.clone()))
    }
}
