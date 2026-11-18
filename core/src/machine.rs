//! 机器入口的有界投影；不持有作品、权限或第二份业务状态。
use crate::{
    Error, Result,
    domain::{digest, ensure},
};
use serde_json::{Value, json};

pub fn catalog_page(catalog: &Value, input: &Value) -> Result<Value> {
    let sha = digest(serde_json::to_vec(catalog)?);
    ensure(
        input
            .get("expected_catalog_sha256")
            .is_none_or(|v| v == &sha),
        "hetu.stale_evidence",
        "能力目录已变化，请重新发现。",
    )?;
    let all = catalog
        .as_array()
        .ok_or_else(|| Error::new("hetu.integrity_failure", "能力目录无效。"))?;
    let groups = all
        .iter()
        .filter_map(|a| a["name"].as_str()?.split('.').nth(1))
        .collect::<std::collections::BTreeSet<_>>();
    let selected = all
        .iter()
        .filter(|a| {
            input.get("action").is_none_or(|v| v == &a["name"])
                && input["group"]
                    .as_str()
                    .is_none_or(|g| a["name"].as_str().and_then(|s| s.split('.').nth(1)) == Some(g))
        })
        .collect::<Vec<_>>();
    let start = input["offset"].as_u64().unwrap_or(0) as usize;
    ensure(
        start <= selected.len(),
        "invalid_input",
        "目录分页超出筛选范围。",
    )?;
    let end = start
        .saturating_add(input["limit"].as_u64().unwrap_or(25) as usize)
        .min(selected.len());
    let actions = selected[start..end]
        .iter()
        .map(|a| {
            let mut a = (*a).clone();
            if input["include_schema"] != true {
                a.as_object_mut().unwrap().remove("input_schema");
            }
            a
        })
        .collect::<Vec<_>>();
    Ok(
        json!({"discovery_revision":"2","catalog_sha256":sha,"groups":groups,
        "total":selected.len(),"actions":actions,"next_offset":(end<selected.len()).then_some(end),
        "schema_lookup":{"action":"hetu.collaboration.inspect","input":{"include_schema":true,"limit":1}},
        "authorization":"listed_actions_do_not_grant_access"}),
    )
}

pub fn runtime(catalog: &Value, input: &Value) -> Result<Value> {
    let package: Value =
        serde_json::from_str(include_str!("../../integrations/codex/hetu/plugin.json"))?;
    let sha = digest(serde_json::to_vec(catalog)?);
    let mut checks = Vec::new();
    for (field, actual) in [
        ("expected_runtime_version", json!(env!("CARGO_PKG_VERSION"))),
        ("expected_catalog_sha256", json!(sha)),
        ("observed_skill_version", package["version"].clone()),
    ] {
        checks.push(json!({"check":field,"state":input.get(field).map(|v|if v == &actual {"match"}else{"different"}).unwrap_or("unknown"),
            "actual":actual,"reported":input.get(field),"reported_is_verified":false}));
    }
    Ok(
        json!({"runtime_version":env!("CARGO_PKG_VERSION"),"platform":std::env::consts::OS,
        "architecture":std::env::consts::ARCH,"catalog_sha256":sha,"discovery_revision":"2",
        "bundled_skill":{"name":package["name"],"version":package["version"]},"checks":checks,
        "installation":"unknown","session_skill_loading":"unknown","repairs_performed":false,
        "next_actions":["Compare this receipt with the tools and methods actually visible in the current Agent session.",
            "Use the selected suite's local_settings.inspect receipt for installation and registration; do not infer session loading."]}),
    )
}

pub fn text_page(content: &str, input: &Value) -> Result<Value> {
    let start = input["range"]["byte_start"].as_u64().unwrap_or(0) as usize;
    let requested_end = input["range"]["byte_end"]
        .as_u64()
        .unwrap_or(content.len() as u64) as usize;
    ensure(
        start <= requested_end
            && requested_end <= content.len()
            && content.is_char_boundary(start)
            && content.is_char_boundary(requested_end),
        "invalid_input",
        "读取范围必须在固定文本UTF-8边界内。",
    )?;
    let budget = input["max_bytes"].as_u64().unwrap_or(16 * 1024) as usize;
    let mut end = requested_end.min(start.saturating_add(budget));
    while !content.is_char_boundary(end) {
        end -= 1;
    }
    // JSON转义也计入片段预算，避免控制字符在MCP双重表示中膨胀。
    while end > start && serde_json::to_vec(&content[start..end])?.len() > budget.saturating_add(2)
    {
        end = start + (end - start) / 2;
        while !content.is_char_boundary(end) {
            end -= 1;
        }
    }
    Ok(
        json!({"content":&content[start..end],"sha256":digest(content),"size_bytes":content.len(),
        "range":{"byte_start":start,"byte_end":end},"complete":end==requested_end,
        "next_range":(end<requested_end).then(||json!({"byte_start":end,"byte_end":requested_end})),
        "coverage_kind":"returned_bytes_not_semantic_understanding"}),
    )
}

fn inventory(value: &Value) -> Value {
    let kind = match value {
        Value::Object(_) => "object",
        Value::Array(_) => "array",
        Value::String(_) => "string",
        _ => "scalar",
    };
    json!({"kind":kind,"size_bytes":value.to_string().len(),"items":value.as_array().map(Vec::len)})
}

pub fn read_projection(mut result: Value, view: &Value) -> Result<Value> {
    let sha = digest(serde_json::to_vec(&result)?);
    ensure(
        view.get("expected_result_sha256")
            .is_none_or(|expected| expected == &sha),
        "hetu.stale_evidence",
        "读取结果已变化，请重新读取摘要，不拼接不同快照。",
    )?;
    let mut page = value_page(&result["data"], view)?;
    page["retained"] = json!(false);
    page["source_result_sha256"] = json!(sha);
    page["snapshot_binding"] = json!("revalidate_each_read");
    result["data"] = json!({"view":page});
    Ok(result)
}

pub fn operation_view(record: &Value, input: &Value) -> Result<Value> {
    ensure(
        input
            .get("input_digest")
            .is_none_or(|v| v == &record["input_digest"]),
        "idempotency_conflict",
        "原操作输入摘要不匹配。",
    )?;
    let original = &record["result"];
    if input.get("result_path").is_none() && input["detail"] != "summary" {
        return Ok(json!({"original_result":original}));
    }
    let mut result = value_page(original, input)?;
    result["operation"] = original["operation"].clone();
    result["original_action"] = original["action"].clone();
    result["original_status"] = original["status"].clone();
    result["result_sha256"] = json!(digest(serde_json::to_vec(original)?));
    Ok(result)
}

/// 对调用方已核验的固定JSON值分页；不解析路径或扩大读取范围。
pub fn value_page(original: &Value, input: &Value) -> Result<Value> {
    let mut result =
        json!({"retained":true,"coverage_kind":"returned_bytes_not_semantic_understanding"});
    let path = input["result_path"].as_str().unwrap_or("");
    let value = original
        .pointer(path)
        .ok_or_else(|| Error::new("not_found", "原结果没有此JSON pointer。"))?;
    result["result_path"] = json!(path);
    result["summary"] = inventory(value);
    let budget = input["max_bytes"].as_u64().unwrap_or(16 * 1024) as usize;
    if let Some(text) = value.as_str() {
        result["page"] = text_page(
            text,
            &json!({"range":{"byte_start":input["offset"].as_u64().unwrap_or(0),"byte_end":text.len()},"max_bytes":budget}),
        )?;
        result["next_offset"] = result["page"]["next_range"]
            .get("byte_start")
            .cloned()
            .unwrap_or(Value::Null);
    } else if let Some(rows) = value.as_array() {
        let start = input["offset"].as_u64().unwrap_or(0) as usize;
        ensure(start <= rows.len(), "invalid_input", "原结果分页超出范围。")?;
        let mut end = start
            .saturating_add(input["limit"].as_u64().unwrap_or(20) as usize)
            .min(rows.len());
        while end > start && serde_json::to_vec(&rows[start..end])?.len() > budget {
            end -= 1;
        }
        if end == start && start < rows.len() {
            result["item"] = inventory(&rows[start]);
            result["next_path"] = json!(format!("{path}/{start}"));
        } else {
            result["items"] = json!(&rows[start..end]);
            result["next_offset"] = json!((end < rows.len()).then_some(end));
        }
    } else if let Some(fields) = value
        .as_object()
        .filter(|_| input["detail"] == "summary" || value.to_string().len() > budget)
    {
        result["fields"] = json!(fields.iter().map(|(name,v)|{
            let escaped=name.replace('~',"~0").replace('/',"~1");
            json!({"name":name,"value":inventory(v),"result_path":format!("{path}/{escaped}")})
        }).collect::<Vec<_>>());
    } else {
        result["value"] = value.clone();
    }
    Ok(result)
}

/// 只回显恢复所必需的固定引用，不回显正文、凭据或任意输入。
pub fn recovery(result: &mut Value, action: &str, input: &Value) {
    let Some(code) = result["error"]["code"].as_str() else {
        return;
    };
    let mut args = json!({});
    for key in ["task_ref", "management_ref"] {
        if let Some(value) = input.get(key) {
            args[key] = value.clone();
        }
    }
    let target = match code {
        "hetu.stale_evidence"
            if matches!(
                action,
                "hetu.collaboration.inspect" | "hetu.agent_operations.catalog"
            ) =>
        {
            for key in ["action", "group"] {
                if let Some(value) = input.get(key) {
                    args[key] = value.clone();
                }
            }
            action
        }

        "hetu.budget_exceeded"
            if action == "hetu.task_context.read" && input["entity_id"].is_string() =>
        {
            for key in ["context_ref", "section", "entity_id"] {
                args[key] = input[key].clone();
            }
            args["result_path"] = json!("");
            args["max_bytes"] = json!(16384);
            action
        }
        "revision_conflict" if action.starts_with("hetu.working_copies.") => {
            "hetu.working_copies.list"
        }
        "revision_conflict" if action.starts_with("hetu.task_checkpoint.") => {
            "hetu.task_checkpoint.get"
        }
        "revision_conflict" if action.starts_with("hetu.task_feedback.") => {
            "hetu.task_feedback.list"
        }
        "revision_conflict"
            if action.starts_with("hetu.documents.") && input["document_id"].is_string() =>
        {
            args["document_id"] = input["document_id"].clone();
            "hetu.documents.get"
        }
        "revision_conflict"
            if action.starts_with("hetu.agent_operations.") && input["proposal_id"].is_string() =>
        {
            args["proposal_id"] = input["proposal_id"].clone();
            "hetu.agent_operations.get"
        }
        "revision_conflict" if action.starts_with("hetu.creative_tasks.") => {
            args["detail"] = json!("summary");
            "hetu.creative_tasks.get"
        }
        "result_unknown" | "workspace_busy" | "hetu.recovery_required" => {
            args["action"] = json!(action);
            args["key"] = input["operation_key"].clone();
            "hetu.operations.get"
        }
        "invalid_input" | "unsupported_version" | "hetu.capability_unavailable" => {
            args = json!({"action":action,"include_schema":true,"limit":1});
            "hetu.collaboration.inspect"
        }
        _ => return,
    };
    let recover = target == "hetu.operations.get";
    if recover && !input["operation_key"].is_string() {
        result["error"]["resolution"] = json!({"kind":"read","action":"hetu.collaboration.inspect","input":{"action":action,"include_schema":true,"limit":1},"retry":"after_read"});
        return;
    }

    result["error"]["resolution"] = json!({"kind":if recover{"recover"}else{"read"},"action":target,"input":args,
        "retry":if recover{"query_original"}else if matches!(code,"revision_conflict"|"hetu.stale_evidence"|"hetu.budget_exceeded"){"after_read"}else{"correct_input"}});
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflict_recovery_reads_the_exact_object_without_echoing_content() {
        for (action, input, expected) in [
            (
                "hetu.documents.save",
                json!({"document_id":"doc_11111111-1111-4111-8111-111111111111","content":"private-body"}),
                "hetu.documents.get",
            ),
            (
                "hetu.agent_operations.execute",
                json!({"proposal_id":"proposal_11111111-1111-4111-8111-111111111111"}),
                "hetu.agent_operations.get",
            ),
        ] {
            let mut result = crate::failure_result(
                action,
                "collaboration",
                &Error::new("revision_conflict", "changed"),
            );
            recovery(&mut result, action, &input);
            assert_eq!(result["error"]["resolution"]["action"], expected);
            assert_eq!(result["error"]["resolution"]["retry"], "after_read");
            assert!(!result.to_string().contains("private-body"));
        }
    }
}
