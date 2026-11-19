//! 随包共同方法的发现与固定字节读取；不安装方法，不授予业务权限。
use crate::{
    Error, Result,
    domain::{digest, ensure},
};
use serde_json::{Value, json};
use std::sync::OnceLock;

fn resources() -> &'static Value {
    static METHODS: OnceLock<Value> = OnceLock::new();
    METHODS.get_or_init(|| {
        serde_json::from_str(include_str!("../../contracts/method-resources.json"))
            .expect("embedded methods")
    })
}

pub fn request(action: &str, input: &Value) -> Result<Value> {
    let bundle = resources();
    let rows = bundle["resources"]
        .as_array()
        .ok_or_else(|| Error::new("hetu.integrity_failure", "共同方法目录无效。"))?;
    let identity = json!({"version":bundle["version"],"suite_id":bundle["suite_id"],"authority":"methodology_not_authorization"});
    match action {
        "hetu.methods.list" => {
            let selected = rows
                .iter()
                .filter(|row| {
                    input["skill"]
                        .as_str()
                        .is_none_or(|skill| row["skill"] == skill)
                        && input["query"].as_str().is_none_or(|query| {
                            let text = format!(
                                "{} {}",
                                row["path"].as_str().unwrap_or(""),
                                row["summary"].as_str().unwrap_or("")
                            )
                            .to_lowercase();
                            query
                                .split_whitespace()
                                .all(|word| text.contains(&word.to_lowercase()))
                        })
                })
                .collect::<Vec<_>>();
            let catalog_sha = digest(include_bytes!("../../contracts/method-resources.json"));
            ensure(
                input
                    .get("expected_catalog_sha256")
                    .is_none_or(|expected| expected == &catalog_sha),
                "hetu.stale_evidence",
                "共同方法已变化，请重新发现。",
            )?;
            let start = input["offset"].as_u64().unwrap_or(0) as usize;
            ensure(
                start <= selected.len(),
                "invalid_input",
                "方法分页超出范围。",
            )?;
            let end = start
                .saturating_add(input["limit"].as_u64().unwrap_or(10) as usize)
                .min(selected.len());
            let entries = selected[start..end]
                .iter()
                .map(|row| {
                    let mut metadata = (*row).clone();
                    metadata.as_object_mut().unwrap().remove("content");
                    metadata
                })
                .collect::<Vec<_>>();
            Ok(
                json!({"bundle":identity,"catalog_sha256":catalog_sha,"total":selected.len(),"resources":entries,
                "next_offset":(end<selected.len()).then_some(end),"read_action":"hetu.methods.read",
                "professional_methods":"discover_enabled_plugin_skills"}),
            )
        }
        "hetu.methods.read" => {
            let row = rows
                .iter()
                .find(|row| row["path"] == input["path"])
                .ok_or_else(|| {
                    Error::new("not_found", "随包目录没有此方法资源，请使用methods.list。")
                })?;
            let text = row["content"]
                .as_str()
                .ok_or_else(|| Error::new("hetu.integrity_failure", "共同方法内容无效。"))?;
            ensure(
                row["sha256"] == digest(text) && row["size_bytes"] == text.len(),
                "hetu.integrity_failure",
                "共同方法与随包摘要不同步。",
            )?;
            ensure(
                input["expected_sha256"] == row["sha256"],
                "hetu.stale_evidence",
                "方法修订已变化，请重新发现，不拼接不同版本。",
            )?;
            let page = crate::machine::text_page(
                text,
                &json!({"range":{"byte_start":input["offset"].as_u64().unwrap_or(0),"byte_end":text.len()},"max_bytes":input["max_bytes"].as_u64().unwrap_or(8192)}),
            )?;
            Ok(json!({"bundle":identity,"path":row["path"],"sha256":row["sha256"],"page":page}))
        }
        _ => Err(Error::new(
            "hetu.capability_unavailable",
            "未知共同方法动作。",
        )),
    }
}
