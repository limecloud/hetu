use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fmt;
pub mod blueprint;
pub mod drama;
pub mod drama_comparison;
pub mod media;
pub mod novel;
pub mod plot;
pub(crate) mod schema;
pub mod script;
pub mod validation;

#[derive(Debug)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}
impl Error {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(_: std::io::Error) -> Self {
        Self::new(
            "hetu.io_failure",
            "文件操作失败，请检查访问权限与磁盘空间。",
        )
    }
}
impl From<rustix::io::Errno> for Error {
    fn from(_: rustix::io::Errno) -> Self {
        Self::new(
            "hetu.unsafe_path",
            "无法安全访问受管路径，请检查链接和文件权限。",
        )
    }
}
impl From<serde_json::Error> for Error {
    fn from(_: serde_json::Error) -> Self {
        Self::new("invalid_input", "JSON 格式或 UTF-8 编码无效。")
    }
}
pub type Result<T> = std::result::Result<T, Error>;
pub fn ensure(value: bool, code: &'static str, message: &str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(Error::new(code, message))
    }
}
pub fn digest(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
pub fn id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4())
}
pub fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .expect("UTC has RFC3339 representation")
}
pub fn checked_id(value: &str, prefix: &str) -> Result<String> {
    let raw = value
        .strip_prefix(&format!("{prefix}_"))
        .ok_or_else(|| Error::new("invalid_input", "对象标识类型无效。"))?;
    let parsed = uuid::Uuid::parse_str(raw)
        .map_err(|_| Error::new("invalid_input", "对象标识格式无效。"))?;
    ensure(
        parsed.get_version_num() == 4 && parsed.to_string() == raw,
        "invalid_input",
        "对象标识不是规范 UUIDv4。",
    )?;
    Ok(value.into())
}
pub fn success(action: &str, scope: &str, data: Value) -> Value {
    let mut result = json!({"spec_version":"0.2.1","kind":"result","action":action,"contract_revision":"1", "status":"succeeded","context":{"scope_id":scope}});
    // data 已是完整 JSON 树，直接转移所有权，避免重复遍历并序列化大结果。
    result["data"] = data;
    result
}
pub fn failure(action: &str, scope: &str, error: &Error) -> Value {
    let resolution = match error.code {
        "revision_conflict" | "hetu.stale_evidence" => {
            json!({"kind":"read","action":"hetu.workspaces.get"})
        }
        "forbidden" | "hetu.author_confirmation_required" => json!({"kind":"request_decision"}),
        "hetu.recovery_required" | "result_unknown" => {
            json!({"kind":"recover","action":"hetu.operations.get"})
        }
        _ => json!({"kind":"correct_input"}),
    };
    let status = if error.code == "result_unknown" {
        "unknown"
    } else if matches!(
        error.code,
        "hetu.io_failure" | "hetu.integrity_failure" | "hetu.recovery_required"
    ) {
        "failed"
    } else {
        "blocked"
    };
    json!({"spec_version":"0.2.1","kind":"result","action":action,"contract_revision":"1", "status":status,"context":{"scope_id":scope},"error":{"code":error.code,"message":error.message,"resolution":resolution}})
}
