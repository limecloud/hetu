//! 作者选文件与 Agent 传文件使用不同权限；作品授权不授予任意本机路径读取权。
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};

const LIMIT: usize = 8 * 1024 * 1024;

impl Kernel {
    pub(super) fn inline_import_source(&self, input: &Value) -> Result<Option<(String, Vec<u8>)>> {
        let Some(source) = input.get("inline_source") else {
            ensure(
                self.author,
                "forbidden",
                "Agent 导入须提交 inline_source 文件内容与摘要，作品授权不包含本机文件路径读取权。",
            )?;
            return Ok(None);
        };
        let filename = text(source, "filename")?;
        ensure(
            !filename.is_empty()
                && filename != "."
                && filename != ".."
                && !filename.contains(['/', '\\'])
                && !filename.chars().any(char::is_control),
            "invalid_input",
            "导入文件名不能包含目录或控制字符。",
        )?;
        let encoded = text(source, "base64")?;
        ensure(
            encoded.len() <= LIMIT.div_ceil(3) * 4,
            "hetu.budget_exceeded",
            "Agent 单次导入不超过 8 MiB，请拆分文件。",
        )?;
        let content = STANDARD
            .decode(encoded)
            .map_err(|_| Error::new("invalid_input", "导入文件不是有效 Base64。"))?;
        ensure(
            !content.is_empty() && content.len() <= LIMIT,
            "hetu.budget_exceeded",
            "导入文件为空或超过 8 MiB。",
        )?;
        ensure(
            source["sha256"] == digest(&content),
            "hetu.integrity_failure",
            "导入文件摘要与提交内容不一致。",
        )?;
        Ok(Some((filename.to_owned(), content)))
    }
}
