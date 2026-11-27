//! 外部执行只拥有会话与本机操作；作品、权限和作者决定保持原Core权威。
mod bots;
pub mod computer;
mod computer_actions;
mod computer_operations;
mod computer_snapshots;
mod sessions;

use crate::{Error, Result, domain, infrastructure::store::Store};
use serde::Serialize;
use std::path::Path;

pub(crate) fn definition(name: &str) -> serde_json::Value {
    static SCHEMA: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
    SCHEMA.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../contracts/schemas/external-execution.schema.json"
        ))
        .expect("external execution schema")
    })["$defs"][name]
        .clone()
}

pub(crate) fn request_for(
    client: &str,
    directory: &Path,
    action: &str,
    input: serde_json::Value,
) -> serde_json::Value {
    if action == "hetu.computer.request" {
        return computer::request_for(client, Some(directory), input);
    }
    let recovery = serde_json::json!({"kind":"read","action":action,"input":{"method":"operation","operation_key":input["operation_key"]}});
    let result = if action == "hetu.sessions.request" {
        sessions::request(client, directory, input)
    } else {
        bots::request(client, directory, input)
    };
    match result {
        Ok(data) if matches!(data["state"].as_str(), Some("unknown" | "dispatching")) => {
            let mut result = domain::failure(
                action,
                "collaboration",
                &Error::new(
                    "hetu.outcome_unknown",
                    "原外部操作结果待核对，请查询原operation_key，没有自动重发。",
                ),
            );
            result["error"]["resolution"] = recovery;
            result["data"] = data;
            result
        }
        Ok(data) if data["state"] == "rejected" => {
            let mut result = domain::failure(
                action,
                "collaboration",
                &Error::new(
                    "external_request_rejected",
                    data["error"]["message"]
                        .as_str()
                        .unwrap_or("原外部操作已拒绝，没有重新派发。"),
                ),
            );
            result["error"]["resolution"] = recovery;
            result["data"] = data;
            result
        }
        Ok(data) => domain::success(action, "collaboration", data),
        Err(error) => {
            let mut result = domain::failure(action, "collaboration", &error);
            if error.code == "hetu.outcome_unknown" {
                result["error"]["resolution"] = recovery;
            }
            result
        }
    }
}

pub(crate) fn record_digest(value: &impl Serialize) -> Result<String> {
    Ok(domain::digest(serde_json_canonicalizer::to_vec(value)?))
}

pub(crate) fn private_dir(path: &Path) -> Result<()> {
    domain::ensure(
        path.is_absolute(),
        "invalid_input",
        "外部执行目录必须为绝对路径。",
    )?;
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            domain::ensure(
                metadata.is_dir() && !metadata.file_type().is_symlink(),
                "hetu.unsafe_path",
                "外部执行目录必须是普通目录。",
            )?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                std::fs::DirBuilder::new()
                    .recursive(true)
                    .mode(0o700)
                    .create(path)?;
            }
            #[cfg(not(unix))]
            std::fs::create_dir_all(path)?;
        }
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

pub(crate) fn read_checked(path: &Path, budget: u64) -> Result<Vec<u8>> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::new("invalid_input", "文件缺少父目录。"))?;
    let leaf = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| Error::new("invalid_input", "文件名无效。"))?;
    let bytes = Store::open(parent)?.read(leaf)?;
    domain::ensure(
        bytes.len() as u64 <= budget,
        "hetu.budget_exceeded",
        "外部执行记录超出读取预算。",
    )?;
    Ok(bytes)
}
