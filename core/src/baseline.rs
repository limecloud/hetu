//! 随包基础能力只声明产品合同，不读取插件目录或授予作品权限。
use crate::{Error, Result};
use serde_json::{Value, json};

pub fn inspect() -> Result<Value> {
    let manifest: Value = serde_json::from_str(include_str!("../../contracts/baseline.json"))?;
    let catalog: Value = serde_json::from_str(include_str!("../../contracts/actions.json"))?;
    let available = catalog["actions"]
        .as_array()
        .ok_or_else(|| Error::new("hetu.integrity_failure", "核心能力目录无效。"))?;
    let mut missing = Vec::new();
    for action in manifest["shared_actions"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(
            manifest["modules"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|m| m["actions"].as_array().into_iter().flatten()),
        )
    {
        if !available.iter().any(|row| row["name"] == *action) {
            missing.push(action.clone());
        }
    }
    Ok(
        json!({"runtime_version":env!("CARGO_PKG_VERSION"),"manifest_sha256":crate::domain::digest(include_bytes!("../../contracts/baseline.json")),
        "status":if missing.is_empty(){"contract_complete"}else{"incomplete"},"missing_actions":missing,"manifest":manifest,
        "optional_plugins_required":false,"desktop_assembly":"not_checked","business_verification":"not_checked",
        "authorization":"listed_actions_do_not_grant_access"}),
    )
}
