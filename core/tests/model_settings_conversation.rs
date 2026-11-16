use hetu_core::model_service::ModelService;
use serde_json::json;

#[test]
fn conversation_channel_settings_are_atomic_private_replayable_and_detect_conflicts() {
    let root = tempfile::tempdir().unwrap();
    let mut service = ModelService::open(root.path()).unwrap();
    let before = service
        .machine_request("codex", "hetu.model_settings.inspect", &json!({}))
        .unwrap();
    let input = json!({"method":"custom_save","expected_sha256":before["settings_sha256"],"settings":{"name":"测试渠道","base_url":"https://models.hetu.test","api_key":"fixture-private-credential","models":{"text":["text-one"],"image":[]}},"authorization_note":"测试用户要求配置自己的模型渠道。","operation_key":"save-channel"});
    let result = service
        .machine_request("codex", "hetu.model_settings.update", &input)
        .unwrap();
    assert_ne!(result["settings_sha256"], before["settings_sha256"]);
    assert!(!result.to_string().contains("fixture-private-credential"));
    assert_eq!(
        service
            .machine_request("codex", "hetu.model_settings.update", &input)
            .unwrap(),
        result
    );
    assert_eq!(
        service
            .machine_request(
                "codex",
                "hetu.model_settings.get_operation",
                &json!({"operation_key":"save-channel"})
            )
            .unwrap(),
        result
    );
    assert!(
        service
            .machine_request(
                "claude-code",
                "hetu.model_settings.get_operation",
                &json!({"operation_key":"save-channel"})
            )
            .is_err()
    );
    let mut stale = input.clone();
    stale["operation_key"] = json!("stale");
    assert_eq!(
        service
            .machine_request("codex", "hetu.model_settings.update", &stale)
            .unwrap_err()
            .code,
        "revision_conflict"
    );
    let mut changed = input.clone();
    changed["settings"]["name"] = json!("篡改");
    assert_eq!(
        service
            .machine_request("codex", "hetu.model_settings.update", &changed)
            .unwrap_err()
            .code,
        "idempotency_conflict"
    );
    for entry in std::fs::read_dir(root.path().join("machine-operations")).unwrap() {
        assert!(
            !std::fs::read_to_string(entry.unwrap().path())
                .unwrap()
                .contains("fixture-private-credential")
        );
    }
}
