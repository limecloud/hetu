use hetu_core::collaboration::CollaborationHub;
use serde_json::json;
#[test]
fn capability_map_is_available_without_work_and_navigates_exact_machine_contracts() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("not-created");
    let hub = CollaborationHub::open(&path, "codex").unwrap();
    let result=hub.request(json!({"action":"hetu.capabilities.map","contract_revision":"1","input":{"action":"hetu.documents.finalize","include_schema":true}}));
    let schema: serde_json::Value =
        serde_json::from_str(include_str!("../../contracts/schemas/result.schema.json")).unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();
    validator.validate(&result).unwrap();
    assert_eq!(result["status"], "succeeded", "{result}");
    assert_eq!(result["data"]["total"], 1);
    let action = &result["data"]["actions"][0];
    assert_eq!(action["proposal_target"], "hetu.documents.finalize");
    assert_eq!(action["mcp_via_proposal"], true);
    assert!(action["input_schema"].is_object());
    assert_eq!(action["skill"], "hetu-manage");
    assert!(!path.exists());
    let result=hub.request(json!({"action":"hetu.capabilities.map","contract_revision":"1","input":{"skill":"hetu-import","limit":1}}));
    assert_eq!(result["data"]["actions"].as_array().unwrap().len(), 1);
    assert_eq!(result["data"]["next_offset"], 1);
    assert_eq!(result["data"]["skills"].as_array().unwrap().len(), 1);
    assert_eq!(result["data"]["workflows"][0]["entry"], "hetu.import_authorizations.register");
    let denied = hub.request(
        json!({"action":"hetu.capabilities.map","contract_revision":"1","input":{"limit":0}}),
    );
    assert_eq!(denied["error"]["code"], "invalid_input");
    validator.validate(&denied).unwrap();
    for name in ["hetu.creative_tasks.close","hetu.covers.import_preparation","hetu.covers.list_preparations"] {
        let result=hub.request(json!({"action":"hetu.capabilities.map","contract_revision":"1","input":{"action":name}}));
        validator.validate(&result).unwrap();assert_eq!(result["status"],"succeeded","{result}");
        let action=&result["data"]["actions"][0];assert_eq!(action["routes"],json!(["workspace_execution"]));
        assert_eq!(action["workspace_execution"]["action"],"hetu.execution.invoke");assert_eq!(action["workspace_execution"]["input_template"]["command"]["action"],name);
        assert_eq!(action["mcp"][0]["name"],"hetu_call_action");assert_eq!(action["status"],"source_wired");
    }
}
