//! 以最终工具结果预算保护传输；业务状态与完整持久回执保持原义。
use super::*;
use sha2::{Digest, Sha256};

fn size(value: &Value) -> usize {
    serde_json::to_vec(&tool_result(value.clone()))
        .map_or(usize::MAX, |v| v.len().saturating_add(256))
}
pub(crate) fn tool_result(result: Value) -> CallToolResult {
    let action=result["action"].as_str().unwrap_or("hetu.request.invalid").to_owned();
    let mut provenance=hetu_core::application::result_provenance(&action);
    provenance["action"]=json!(action);
    if result.get("error").is_some() { provenance["data_roles"]=json!(["core_error"]); }
    let mut response=if result.get("error").is_some() {CallToolResult::structured_error(result)} else {CallToolResult::structured(result)};
    response.meta=Some(serde_json::from_value(json!({"provenance":provenance})).expect("fixed provenance metadata"));
    response
}
pub(crate) fn plugin_read(result: &Value) -> bool {
    result["action"] == "hetu.plugins.invoke" && result["data"]["invocation"]["effect"] == "read"
}
pub(crate) fn summary_read(mut result: Value, action: &str, input: &Value) -> Value {
    if result.get("error").is_some()
        || size(&result) <= MAX_RESULT_BYTES
        || matches!(
            action,
            "hetu.capabilities.get" | "hetu.working_copies.get" | "hetu.operations.get"
        )
    {
        return result;
    }
    if let Ok(projected) = hetu_core::machine::read_projection(result.clone(), &json!({})) {
        let sha = projected["data"]["view"]["source_result_sha256"].clone();
        let mut fields = serde_json::Map::new();
        for (key, value) in result["data"].as_object().into_iter().flatten() {
            if serde_json::to_vec(value).is_ok_and(|raw| raw.len() <= 1024) {
                fields.insert(key.clone(), value.clone());
            }
        }
        let view = json!({"result_path":"","expected_result_sha256":sha});
        let read = if action == "hetu.plugins.invoke" {
            let mut read = input.clone();
            read["view"] = view.clone();
            json!({"action":action,"input":read})
        } else {
            json!({"action":"hetu.collaboration.invoke","input":{"action":action,"input":input,"view":view}})
        };
        fields.insert("response".into(),json!({"detail":"summary","complete":false,"retained":false,
            "source_result_sha256":sha,"read":read}));
        fields.insert(
            "result_fields".into(),
            projected["data"]["view"]["fields"].clone(),
        );
        result["data"] = Value::Object(fields);
        // 大输入已经在调用方手中；不要让恢复说明复制输入后再次超预算。
        if action == "hetu.plugins.invoke" && size(&result) > MAX_RESULT_BYTES
            && let Ok(canonical) = serde_json_canonicalizer::to_vec(input)
        {
            result["data"]["response"]["read"] = json!({
                "action":action,
                "base_input":{"source":"original_request","sha256":format!("{:x}",Sha256::digest(canonical))},
                "input_patch":{"view":view}
            });
        }
    }
    result
}
pub(crate) fn read_input(action: &str, input: &mut Value) {
    if !input.is_object() {
        return;
    }
    if action == "hetu.collaboration.invoke" {
        let actual = input["action"].as_str().unwrap_or("").to_owned();
        if actual != "hetu.collaboration.invoke" {
            read_input(&actual, &mut input["input"]);
        }
        return;
    }
    let cap = if action == "hetu.task_context.read" && !input["entity_id"].is_string() {
        8192
    } else {
        16384
    };
    if matches!(
        action,
        "hetu.task_context.read"
            | "hetu.working_copies.get"
            | "hetu.creative_tasks.read_candidate"
            | "hetu.creative_tasks.get"
            | "hetu.operations.get"
    ) && (input.get("max_bytes").is_some() || action == "hetu.task_context.read")
        && let Some(max) = input["max_bytes"]
            .as_u64()
            .or_else(|| input.get("max_bytes").is_none().then_some(cap))
        && max <= 65536
    {
        input["max_bytes"] = json!(max.min(cap));
    }
}
pub(crate) fn interrupted(action: &str, input: &Value, code: &'static str, message: &str) -> Value {
    let mut result = hetu_core::failure_result(
        action,
        "collaboration",
        &hetu_core::Error::new(code, message),
    );
    hetu_core::machine::recovery(&mut result, action, input);
    result
}
pub(crate) fn bounded(mut result: Value, action: &str, input: &Value, budget: usize) -> Value {
    if size(&result) <= budget {
        return result;
    }
    let actual = result["action"].as_str().unwrap_or(action).to_owned();
    if actual == "hetu.plugins.invoke" && result.get("error").is_none()
        && result["data"]["invocation"]["effect"] == "managed_write"
        && result["data"]["result"]["operation"]["recover_action"] == "hetu.extensions.operations.get"
        && let (Some(key), Some(sha)) = (result["data"]["invocation"]["operation_key"].as_str(),
            result["data"]["invocation"]["sha256"].as_str())
    {
        let original_data = result["data"].clone();
        let mut recovery = input.clone();
        recovery.as_object_mut().unwrap().remove("view");
        recovery["action"] = json!("hetu.extensions.operations.get");
        recovery["arguments"] = json!({"operation_key":key,"invocation_sha256":sha});
        let original = result["data"].as_object_mut().unwrap().remove("result").unwrap();
        result["data"]["result_status"] = original["status"].clone();
        result["data"]["operation"] = original["operation"].clone();
        result["data"]["response"] = json!({"detail":"summary","complete":false,"retained":true,
            "reason":"transport_budget","limit_bytes":budget});
        result["data"]["recovery"] = json!({"action":"hetu.plugins.invoke","input":recovery,"retry":"query_original"});
        if size(&result) <= budget { return result; }
        result["data"] = original_data;
    }
    let mut recover_input = json!({});
    for key in ["task_ref", "management_ref"] {
        if let Some(value) = input.get(key) {
            recover_input[key] = value.clone();
        }
    }
    if result.get("error").is_none()
        && actual == "hetu.capabilities.get"
        && let Some(actions) = result["data"]["actions"].as_array_mut()
    {
        for action in actions {
            action.as_object_mut().unwrap().remove("input_schema");
        }
        result["data"]["schema_source"] = json!("tools/list or exact collaboration.inspect");
        result["data"]["response"] = json!({"detail":"summary","schemas_omitted":true});
        if size(&result) <= budget {
            return result;
        }
    }
    if result.get("error").is_none() && actual == "hetu.working_copies.get" {
        let bytes = result["data"]["revision"]["content"].as_str().map(str::len);
        if let Some(bytes) = bytes {
            result["data"]["revision"]
                .as_object_mut()
                .unwrap()
                .remove("content");
            let mut read = recover_input.clone();
            read["working_copy_ref"] = input["working_copy_ref"].clone();
            read["range"] = json!({"byte_start":0,"byte_end":bytes});
            read["max_bytes"] = json!(16 * 1024);
            result["data"]["content_read"] = json!({"action":actual,"input":read});
            result["data"]["response"] = json!({"detail":"summary","complete":false,"retained":true,"reason":"transport_budget"});
            if size(&result) <= budget {
                return result;
            }
        }
    }
    if result.get("error").is_none()
        && actual == "hetu.operations.get"
        && let Some(original) = result["data"].get("original_result")
    {
        let record =
            json!({"result":original,"input_digest":original["operation"]["input_digest"]});
        let mut summary = input.clone();
        summary["detail"] = json!("summary");
        if let Ok(data) = hetu_core::machine::operation_view(&record, &summary) {
            result["data"] = data;
            if size(&result) <= budget {
                return result;
            }
        }
    }
    let operation = result.get("operation").cloned();
    if let Some(operation) = operation {
        recover_input["operation_id"] = operation["id"].clone();
        recover_input["input_digest"] = operation["input_digest"].clone();
        recover_input["detail"] = json!("summary");
        result["data"] = json!({"response":{"detail":"summary","complete":false,"retained":true,
            "reason":"transport_budget","limit_bytes":budget},
            "recovery":{"action":"hetu.operations.get","input":recover_input,"retry":"query_original"}});
        // 业务错误的说明不变，只有成功或在途回执可投影为有界摘要。
        if result.get("error").is_none() && size(&result) <= budget {
            return result;
        }
    }
    let mut failure = hetu_core::failure_result(
        &actual,
        result["context"]["scope_id"]
            .as_str()
            .unwrap_or("collaboration"),
        &hetu_core::Error::new(
            "hetu.budget_exceeded",
            "结果超过当前连接预算；读取固定摘要或缩小范围，勿重做写入。",
        ),
    );
    if let Some(op) = result.get("operation") {
        failure["operation"] = op.clone();
    }
    for key in [
        "working_copy_ref",
        "candidate_ref",
        "action",
        "key",
        "input_digest",
    ] {
        if let Some(value) = input.get(key) {
            recover_input[key] = value.clone();
        }
    }
    let target = if matches!(
        actual.as_str(),
        "hetu.collaboration.inspect" | "hetu.agent_operations.catalog" | "hetu.capabilities.map"
    ) {
        for key in [
            "action",
            "group",
            "skill",
            "offset",
            "expected_catalog_sha256",
            "include_schema",
        ] {
            if let Some(value) = input.get(key) {
                recover_input[key] = value.clone();
            }
        }
        recover_input["limit"] = json!(1);
        actual.as_str()
    } else if matches!(
        actual.as_str(),
        "hetu.creative_tasks.get" | "hetu.working_copies.get" | "hetu.operations.get"
    ) {
        recover_input["detail"] = json!("summary");
        actual.as_str()
    } else {
        "hetu.collaboration.inspect"
    };
    if target == "hetu.collaboration.inspect" && actual != "hetu.collaboration.inspect" {
        recover_input = json!({"action":actual,"include_schema":true,"limit":1});
    }
    failure["error"]["resolution"] =
        json!({"kind":"read","action":target,"input":recover_input,"retry":"after_read"});
    failure
}

#[cfg(test)]
mod tests {
    use super::*;
use sha2::{Digest, Sha256};
    #[test]
    fn plugin_read_with_large_input_reuses_original_instead_of_echoing_it() {
        let input = json!({"management_ref":{"grant_id":"private"},"work_ref":{"kind":"novel"},
            "plugin_id":"org.test.large","package_sha256":"a".repeat(64),"capabilities_sha256":"b".repeat(64),
            "action":"preview","arguments":{"scope":"资料中🌿\n\"保持\"\\固定".repeat(20000)}});
        let original = json!({"spec_version":"0.2.1","kind":"result","action":"hetu.plugins.invoke",
            "contract_revision":"1","status":"succeeded","context":{"scope_id":"test"},
            "data":{"invocation":{"action":"preview","effect":"read"},"result":{"status":"succeeded","data":input["arguments"]}}});
        let summary = bounded(summary_read(original.clone(), "hetu.plugins.invoke", &input),
            "hetu.plugins.invoke", &input, MAX_RESULT_BYTES);
        assert_eq!(summary["status"], "succeeded");
        let read = &summary["data"]["response"]["read"];
        assert!(read.get("input").is_none());
        assert_eq!(read["base_input"]["source"], "original_request");
        assert_eq!(read["base_input"]["sha256"],
            format!("{:x}", Sha256::digest(serde_json_canonicalizer::to_vec(&input).unwrap())));
        let mut restored = input.clone();
        restored.as_object_mut().unwrap().extend(read["input_patch"].as_object().unwrap().clone());
        assert_eq!(restored["arguments"], input["arguments"]);
        for key in ["management_ref", "work_ref", "package_sha256", "capabilities_sha256"] {
            assert_eq!(restored[key], input[key]);
        }
        assert_eq!(restored["view"]["expected_result_sha256"],
            hetu_core::machine::read_projection(original, &json!({})).unwrap()["data"]["view"]["source_result_sha256"]);
        assert!(size(&summary) <= MAX_RESULT_BYTES);
    }
    #[test]
    fn plugin_read_summary_recovers_only_the_verified_read_action_with_fixed_sha() {
        let input = json!({"management_ref":{"grant_id":"private"},"work_ref":{"kind":"novel"},
            "plugin_id":"org.test.large","package_sha256":"a".repeat(64),"capabilities_sha256":"b".repeat(64),
            "action":"preview","arguments":{"scope":"fixed"}});
        let original = json!({"spec_version":"0.2.1","kind":"result","action":"hetu.plugins.invoke",
            "contract_revision":"1","status":"succeeded","context":{"scope_id":"test"},
            "data":{"invocation":{"action":"preview","effect":"read"},"result":{"status":"succeeded","data":{"content":"中🌿".repeat(20000)}}}});
        assert!(plugin_read(&original));
        let mut spoofed = original.clone();
        spoofed["data"]["invocation"]["effect"] = json!("managed_write");
        spoofed["data"]["result"]["invocation"] = json!({"effect":"read"});
        assert!(!plugin_read(&spoofed));
        let summary = summary_read(original.clone(), "hetu.plugins.invoke", &input);
        let read = &summary["data"]["response"]["read"];
        assert_eq!(read["action"], "hetu.plugins.invoke");
        assert_eq!(read["input"]["action"], "preview");
        assert_eq!(read["input"]["arguments"], input["arguments"]);
        assert_eq!(read["input"]["view"]["expected_result_sha256"],
            hetu_core::machine::read_projection(original, &json!({})).unwrap()["data"]["view"]["source_result_sha256"]);
        assert!(size(&summary) <= MAX_RESULT_BYTES);
    }
    #[test]
    fn plugin_write_budget_recovers_original_extension_operation_without_replaying_write() {
        let input = json!({"management_ref":{"grant_id":"private"},"work_ref":{"kind":"novel"},
            "plugin_id":"org.test.large","package_sha256":"a".repeat(64),"capabilities_sha256":"b".repeat(64),
            "action":"save","arguments":{"operation_key":"original","content":"中🌿".repeat(20000)}});
        let original = json!({"spec_version":"0.2.1","kind":"result","action":"hetu.plugins.invoke",
            "contract_revision":"1","status":"succeeded","context":{"scope_id":"test"},
            "data":{"invocation":{"action":"save","effect":"managed_write","operation_key":"original","sha256":"c".repeat(64)},
                "result":{"status":"succeeded","operation":{"id":"original-op","recover_action":"hetu.extensions.operations.get"},
                    "data":{"content":"中🌿".repeat(20000)}}}});
        let summary = bounded(original, "hetu.plugins.invoke", &input, MAX_RESULT_BYTES);
        assert_eq!(summary["status"], "succeeded");
        assert_eq!(summary["data"]["result_status"], "succeeded");
        assert!(summary["data"].get("result").is_none());
        let recovery = &summary["data"]["recovery"];
        assert_eq!(recovery["retry"], "query_original");
        assert_eq!(recovery["input"]["action"], "hetu.extensions.operations.get");
        assert_eq!(recovery["input"]["arguments"], json!({"operation_key":"original","invocation_sha256":"c".repeat(64)}));
        assert!(recovery["input"].get("view").is_none());
        assert_eq!(recovery["input"]["management_ref"], input["management_ref"]);
        assert!(size(&summary) <= MAX_RESULT_BYTES);
    }
    #[test]
    fn plugin_read_with_large_input_reuses_original_instead_of_echoing_it() {
        let input = json!({"management_ref":{"grant_id":"private"},"work_ref":{"kind":"novel"},
            "plugin_id":"org.test.large","package_sha256":"a".repeat(64),"capabilities_sha256":"b".repeat(64),
            "action":"preview","arguments":{"scope":"资料中🌿\n\"保持\"\\固定".repeat(20000)}});
        let original = json!({"spec_version":"0.2.1","kind":"result","action":"hetu.plugins.invoke",
            "contract_revision":"1","status":"succeeded","context":{"scope_id":"test"},
            "data":{"invocation":{"action":"preview","effect":"read"},"result":{"status":"succeeded","data":input["arguments"]}}});
        let summary = bounded(summary_read(original.clone(), "hetu.plugins.invoke", &input),
            "hetu.plugins.invoke", &input, MAX_RESULT_BYTES);
        assert_eq!(summary["status"], "succeeded");
        let read = &summary["data"]["response"]["read"];
        assert!(read.get("input").is_none());
        assert_eq!(read["base_input"]["source"], "original_request");
        assert_eq!(read["base_input"]["sha256"],
            format!("{:x}", Sha256::digest(serde_json_canonicalizer::to_vec(&input).unwrap())));
        let mut restored = input.clone();
        restored.as_object_mut().unwrap().extend(read["input_patch"].as_object().unwrap().clone());
        assert_eq!(restored["arguments"], input["arguments"]);
        for key in ["management_ref", "work_ref", "package_sha256", "capabilities_sha256"] {
            assert_eq!(restored[key], input[key]);
        }
        assert_eq!(restored["view"]["expected_result_sha256"],
            hetu_core::machine::read_projection(original, &json!({})).unwrap()["data"]["view"]["source_result_sha256"]);
        assert!(size(&summary) <= MAX_RESULT_BYTES);
    }
    #[test]
    fn plugin_read_summary_recovers_only_the_verified_read_action_with_fixed_sha() {
        let input = json!({"management_ref":{"grant_id":"private"},"work_ref":{"kind":"novel"},
            "plugin_id":"org.test.large","package_sha256":"a".repeat(64),"capabilities_sha256":"b".repeat(64),
            "action":"preview","arguments":{"scope":"fixed"}});
        let original = json!({"spec_version":"0.2.1","kind":"result","action":"hetu.plugins.invoke",
            "contract_revision":"1","status":"succeeded","context":{"scope_id":"test"},
            "data":{"invocation":{"action":"preview","effect":"read"},"result":{"status":"succeeded","data":{"content":"中🌿".repeat(20000)}}}});
        assert!(plugin_read(&original));
        let mut spoofed = original.clone();
        spoofed["data"]["invocation"]["effect"] = json!("managed_write");
        spoofed["data"]["result"]["invocation"] = json!({"effect":"read"});
        assert!(!plugin_read(&spoofed));
        let summary = summary_read(original.clone(), "hetu.plugins.invoke", &input);
        let read = &summary["data"]["response"]["read"];
        assert_eq!(read["action"], "hetu.plugins.invoke");
        assert_eq!(read["input"]["action"], "preview");
        assert_eq!(read["input"]["arguments"], input["arguments"]);
        assert_eq!(read["input"]["view"]["expected_result_sha256"],
            hetu_core::machine::read_projection(original, &json!({})).unwrap()["data"]["view"]["source_result_sha256"]);
        assert!(size(&summary) <= MAX_RESULT_BYTES);
    }
    #[test]
    fn plugin_write_budget_recovers_original_extension_operation_without_replaying_write() {
        let input = json!({"management_ref":{"grant_id":"private"},"work_ref":{"kind":"novel"},
            "plugin_id":"org.test.large","package_sha256":"a".repeat(64),"capabilities_sha256":"b".repeat(64),
            "action":"save","arguments":{"operation_key":"original","content":"中🌿".repeat(20000)}});
        let original = json!({"spec_version":"0.2.1","kind":"result","action":"hetu.plugins.invoke",
            "contract_revision":"1","status":"succeeded","context":{"scope_id":"test"},
            "data":{"invocation":{"action":"save","effect":"managed_write","operation_key":"original","sha256":"c".repeat(64)},
                "result":{"status":"succeeded","operation":{"id":"original-op","recover_action":"hetu.extensions.operations.get"},
                    "data":{"content":"中🌿".repeat(20000)}}}});
        let summary = bounded(original, "hetu.plugins.invoke", &input, MAX_RESULT_BYTES);
        assert_eq!(summary["status"], "succeeded");
        assert_eq!(summary["data"]["result_status"], "succeeded");
        assert!(summary["data"].get("result").is_none());
        let recovery = &summary["data"]["recovery"];
        assert_eq!(recovery["retry"], "query_original");
        assert_eq!(recovery["input"]["action"], "hetu.extensions.operations.get");
        assert_eq!(recovery["input"]["arguments"], json!({"operation_key":"original","invocation_sha256":"c".repeat(64)}));
        assert!(recovery["input"].get("view").is_none());
        assert_eq!(recovery["input"]["management_ref"], input["management_ref"]);
        assert!(size(&summary) <= MAX_RESULT_BYTES);
    }
    #[test]
    fn model_confirmation_summary_preserves_approval_and_fixed_plan_read() {
        let original = json!({"spec_version":"0.2.1","kind":"result","action":"hetu.model_tasks.get","contract_revision":"1","status":"succeeded","context":{"scope_id":"collaboration"},"data":{"approval":{"confirmation_channel":"mcp_elicitation"},"plan":{"payload":{"prompt":"字".repeat(40000)}},"submitted":false}});
        let summarized = summary_read(
            original.clone(),
            "hetu.model_tasks.get",
            &json!({"plan_id":"fixed-plan"}),
        );
        assert_eq!(summarized["data"]["approval"], original["data"]["approval"]);
        assert_eq!(summarized["data"]["submitted"], false);
        assert_eq!(
            summarized["data"]["response"]["read"]["input"]["input"]["plan_id"],
            "fixed-plan"
        );
        assert!(size(&summarized) <= MAX_RESULT_BYTES);
        assert_eq!(
            original["data"]["plan"]["payload"]["prompt"]
                .as_str()
                .unwrap()
                .len(),
            120000
        );
    }
    #[test]
    fn read_budget_preserves_invalid_inputs_for_schema_rejection_and_never_changes_writes() {
        let mut invalid = json!({"action":"hetu.task_context.read","input":"invalid"});
        let original = invalid.clone();
        read_input("hetu.collaboration.invoke", &mut invalid);
        assert_eq!(invalid, original);
        let mut write = json!({"max_bytes":65536,"content":"保持原输入"});
        let original = write.clone();
        read_input("hetu.working_copies.save", &mut write);
        assert_eq!(write, original);
        let mut read = json!({"max_bytes":65536});
        read_input("hetu.task_context.read", &mut read);
        assert_eq!(read["max_bytes"], 8192);
        let mut invalid = json!({"max_bytes":65537});
        read_input("hetu.task_context.read", &mut invalid);
        assert_eq!(invalid["max_bytes"], 65537);
    }
    #[test]
    fn cancellation_before_execution_keeps_cancelled_status() {
        let value = interrupted(
            "hetu.working_copies.save",
            &json!({}),
            "cancelled",
            "before start",
        );
        assert_eq!(value["status"], "cancelled");
        let schema: Value = serde_json::from_str(include_str!(
            "../../../contracts/schemas/result.schema.json"
        ))
        .unwrap();
        assert!(jsonschema::is_valid(&schema, &value));
    }
    #[test]
    fn persisted_oversize_keeps_receipt_and_exact_recovery_without_content() {
        let original = json!({"spec_version":"0.2.1","kind":"result","action":"hetu.working_copies.save","contract_revision":"1","status":"succeeded","context":{"scope_id":"collaboration"},"data":{"content":"字".repeat(10000)},"operation":{"id":"op_11111111-1111-4111-8111-111111111111","key":"once","input_digest":format!("sha256:{}","a".repeat(64)),"recover_action":"hetu.operations.get"}});
        let bounded = bounded(
            original.clone(),
            "hetu.working_copies.save",
            &json!({}),
            4096,
        );
        assert_eq!(bounded["operation"], original["operation"]);
        assert_eq!(bounded["status"], "succeeded");
        assert_eq!(
            bounded["data"]["recovery"]["input"]["operation_id"],
            original["operation"]["id"]
        );
        assert!(size(&bounded) <= 4096);
        let mut read = original;
        read.as_object_mut().unwrap().remove("operation");
        let rejected = bounded_read(read);
        assert!(rejected.get("error").is_some());
        assert!(rejected["data"].is_null());
    }
    fn bounded_read(value: Value) -> Value {
        bounded(value, "hetu.creative_tasks.get", &json!({}), 4096)
    }
}
