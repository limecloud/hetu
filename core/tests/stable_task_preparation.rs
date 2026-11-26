use hetu_core::{Kernel, collaboration::CollaborationHub, local_settings::LocalSettings};
use serde_json::{Value, json};

fn call(kernel: &Kernel, action: &str, input: Value) -> Value {
    kernel.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(value: Value) -> Value {
    assert_eq!(value["status"], "succeeded", "{value}");
    value["data"].clone()
}

#[test]
fn existing_exact_work_can_prepare_task_and_open_its_locator_without_author_identity() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("work");
    let directory = root.path().join("connection");
    let kernel=Kernel::open(json!({"workspace_path":workspace,"mode":"author","create":{"title":"原有作品","locale":"zh-CN","operation_key":"create"}})).unwrap();
    let work = ok(call(&kernel, "works.list", json!({})))["works"][0]["work_ref"].clone();
    let document = ok(call(
        &kernel,
        "documents.create",
        json!({"kind":"novel_chapter","title":"第一章","source_format":"markdown","content":"原稿保持。","operation_key":"doc"}),
    ));
    let grant=ok(call(&kernel,"collaboration.authorize_workspace",json!({"work_ref":work,"client_adapter":"codex","collaboration_path":directory,"operation_key":"grant"})))["management_ref"].clone();
    let hub = CollaborationHub::open(&directory, "codex").unwrap();
    let invoke = |action: &str, mut input: Value| {
        input["management_ref"] = grant.clone();
        hub.request(
            json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}),
        )
    };
    let catalog = ok(invoke("capabilities.get", json!({})));
    assert!(
        catalog["actions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["name"] == "hetu.creative_tasks.prepare")
    );
    let preview = ok(invoke(
        "creative_tasks.preview_prompt",
        json!({"scope_ref":{"kind":"workspace","id":kernel.scope()},"work_ref":work,"task_kind":"chapter_draft","brief":"固定来源任务","input_refs":[{"kind":"document","document_id":document["document"]["document_id"],"revision_id":document["revision"]["revision_id"]}],"client_adapter":"codex","language_tag":"zh-CN","candidate_limit":1}),
    ));
    let mut input = preview["prepare_input"].clone();
    input["operation_key"] = json!("prepare-once");
    if std::env::var_os("HETU_TEST_FIXED_TASK_CONFIRM").is_some() {
        assert_eq!(
            invoke("creative_tasks.prepare", input)["error"]["code"],
            "hetu.execution_confirmation_required"
        );
        assert!(
            ok(call(
                &kernel,
                "creative_tasks.list",
                json!({"work_ref":work})
            ))["tasks"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        return;
    }
    let prepared = ok(invoke("creative_tasks.prepare", input.clone()));
    assert_eq!(
        ok(invoke("creative_tasks.prepare", input.clone()))["task_ref"],
        prepared["task_ref"]
    );
    let opened=ok(hub.request(json!({"action":"hetu.collaboration.open","contract_revision":"1","input":{"task_locator":prepared["task_locator"]}})));
    assert_eq!(
        opened["task_ref"]["task_id"],
        prepared["task_ref"]["task_id"]
    );
    let actual = ok(call(
        &kernel,
        "creative_tasks.get",
        json!({"task_ref":prepared["task_ref"]}),
    ));
    assert_eq!(
        actual["request"]["input_snapshot"]["scope_context"]["work_ref"],
        work
    );
    assert_eq!(
        ok(call(
            &kernel,
            "documents.get",
            json!({"document_id":document["document"]["document_id"]})
        ))["content"],
        "原稿保持。"
    );
    input["client_adapter"] = json!("claude-code");
    input["operation_key"] = json!("other-client");
    assert_eq!(
        invoke("creative_tasks.prepare", input)["error"]["code"],
        "forbidden"
    );
    ok(call(
        &kernel,
        "collaboration.revoke_management",
        json!({"grant_id":grant["grant_id"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"revoke"}),
    ));
    assert_ne!(
        invoke(
            "creative_tasks.preview_prompt",
            preview["prepare_input"].clone()
        )["status"],
        "succeeded"
    );
    // 子进程隔离共享策略目录，不修改作者本机设置或并行测试的环境。
    let settings_directory = root.path().join("confirm-settings");
    let settings = LocalSettings::open(&settings_directory).unwrap();
    let before = settings.host(json!({"method":"get","input":{}})).unwrap();
    settings.host(json!({"method":"update","input":{"expected_revision":before["revision"],"patch":{"execution_mode":"confirm"},"operation_key":"confirm-mode"}})).unwrap();
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "existing_exact_work_can_prepare_task_and_open_its_locator_without_author_identity",
            "--nocapture",
        ])
        .env("HETU_LOCAL_SETTINGS_DIR", settings_directory)
        .env("HETU_TEST_FIXED_TASK_CONFIRM", "1")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
