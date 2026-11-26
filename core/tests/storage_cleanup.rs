use hetu_core::local_settings::LocalSettings;
use serde_json::{Value, json};
use std::{fs, path::Path};
fn call(service: &LocalSettings, action: &str, input: Value) -> Value {
    service.request("generic", json!({"action":format!("hetu.local_settings.{action}"),"contract_revision":"1","input":input}))
}
fn data(value: Value) -> Value {
    assert_eq!(value["status"], "succeeded", "{value}");
    value["data"].clone()
}
fn write(root: &Path, path: &str, contents: &[u8]) {
    fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
    fs::write(root.join(path), contents).unwrap();
}
fn prepare(service: &LocalSettings, key: &str) -> Value {
    let scan = data(call(service, "inspect_storage", json!({})));
    data(call(
        service,
        "prepare",
        json!({"kind":"storage_cleanup","storage_snapshot":scan["storage_snapshot"],
        "selected_ids":scan["candidates"].as_array().unwrap().iter().map(|v|v["id"].clone()).collect::<Vec<_>>(),"summary":"清理所选测试资料","operation_key":key}),
    ))
}
fn approve(service: &LocalSettings, plan: &Value) -> Value {
    data(call(
        service,
        "record_decision",
        json!({"operation_id":plan["operation_id"],"sha256":plan["sha256"],"revision":plan["revision"],
        "decision":"approve","authorization_note":"测试作者明确确认此固定清单","operation_key":"approve"}),
    ))
}
fn execute(service: &LocalSettings, plan: &Value) -> Value {
    call(
        service,
        "execute",
        json!({"operation_id":plan["operation_id"],"sha256":plan["sha256"],"operation_key":"execute"}),
    )
}
#[test]
fn cleanup_requires_exact_decision_even_in_auto_and_replays_without_touching_new_files() {
    let root = tempfile::tempdir().unwrap();
    let service = LocalSettings::open(&root.path().join("LocalSettings")).unwrap();
    write(root.path(), "GPUCache/data", b"cache");
    write(root.path(), "Collaboration/managed/data", b"protected task");
    write(root.path(), "Recovery/draft", b"protected draft");
    let before = fs::read(root.path().join("LocalSettings/settings.json")).unwrap();
    let scan = data(call(&service, "inspect_storage", json!({})));
    assert_eq!(scan["cleanable_bytes"], 5);
    assert_eq!(scan["candidates"].as_array().unwrap().len(), 1);
    let plan = prepare(&service, "first");
    assert_eq!(
        execute(&service, &plan)["error"]["code"],
        "hetu.author_confirmation_required"
    );
    assert!(root.path().join("GPUCache/data").exists());
    approve(&service, &plan);
    let done = data(execute(&service, &plan));
    assert_eq!(done["result"]["deleted_bytes"], 5);
    assert!(!root.path().join("GPUCache/data").exists());
    write(root.path(), "GPUCache/data", b"new cache must survive");
    assert_eq!(data(execute(&service, &plan)), done);
    assert_eq!(
        fs::read(root.path().join("GPUCache/data")).unwrap(),
        b"new cache must survive"
    );
    assert_eq!(
        fs::read(root.path().join("LocalSettings/settings.json")).unwrap(),
        before
    );
    assert_eq!(
        fs::read(root.path().join("Collaboration/managed/data")).unwrap(),
        b"protected task"
    );
    assert_eq!(
        fs::read(root.path().join("Recovery/draft")).unwrap(),
        b"protected draft"
    );
}
#[test]
fn rejected_and_absent_items_do_not_claim_deleted_bytes() {
    let root = tempfile::tempdir().unwrap();
    let service = LocalSettings::open(&root.path().join("LocalSettings")).unwrap();
    write(root.path(), "GPUCache/data", b"keep");
    let plan = prepare(&service, "cancel");
    data(call(
        &service,
        "record_decision",
        json!({"operation_id":plan["operation_id"],"sha256":plan["sha256"],"revision":plan["revision"],"decision":"reject","authorization_note":"测试作者放弃此清理清单","operation_key":"cancel"}),
    ));
    assert_eq!(
        execute(&service, &plan)["error"]["code"],
        "hetu.author_confirmation_required"
    );
    assert!(root.path().join("GPUCache/data").exists());
    let plan = prepare(&service, "absent");
    approve(&service, &plan);
    fs::remove_file(root.path().join("GPUCache/data")).unwrap();
    let done = data(execute(&service, &plan));
    assert_eq!(done["result"]["deleted_bytes"], 0);
    assert_eq!(done["result"]["absent_count"], 1);
    assert_eq!(
        call(&service, "inspect_storage", json!({"path":"/private"}))["error"]["code"],
        "invalid_input"
    );
}
#[test]
fn stale_selection_changed_files_and_removed_drafts_are_protected() {
    let root = tempfile::tempdir().unwrap();
    let service = LocalSettings::open(&root.path().join("local-settings")).unwrap();
    let record = json!({"schema_version":1,"session_id":"codex-1234567890123456","title":"已结束的会话","draft":"","messages":[],"tools":[]});
    for (name, value) in [("good", record.clone()), ("draft", record.clone())] {
        let value = if name == "draft" {
            let mut v = record.clone();
            v["draft"] = json!("unsaved");
            v
        } else {
            value
        };
        write(
            root.path(),
            &format!("agent-sessions/removed/codex-{name}-1234567890123456-123.json"),
            &serde_json::to_vec(&value).unwrap(),
        );
    }
    let mut unknown = record.clone();
    unknown["messages"] = json!([{"role":"user","text":"unknown","delivery":"unknown"}]);
    write(
        root.path(),
        "agent-sessions/removed/codex-unknown-1234567890123456-123.json",
        &serde_json::to_vec(&unknown).unwrap(),
    );
    write(
        root.path(),
        "agent-sessions/codex-live.json",
        &serde_json::to_vec(&record).unwrap(),
    );
    write(root.path(), "GPUCache/data", b"before");
    let scan = data(call(&service, "inspect_storage", json!({})));
    assert_eq!(scan["candidates"].as_array().unwrap().len(), 2);
    write(root.path(), "GPUCache/data", b"changed");
    assert_eq!(
        call(
            &service,
            "prepare",
            json!({"kind":"storage_cleanup","storage_snapshot":scan["storage_snapshot"],"selected_ids":[scan["candidates"][0]["id"]],"summary":"stale","operation_key":"stale"})
        )["error"]["code"],
        "revision_conflict"
    );
    let plan = prepare(&service, "new");
    approve(&service, &plan);
    write(root.path(), "GPUCache/data", b"changed again");
    let done = data(execute(&service, &plan));
    assert_eq!(done["result"]["retained_count"], 1);
    assert_eq!(done["result"]["deleted_count"], 1);
    assert!(
        root.path()
            .join("agent-sessions/removed/codex-draft-1234567890123456-123.json")
            .exists()
    );
    assert!(
        root.path()
            .join("agent-sessions/removed/codex-unknown-1234567890123456-123.json")
            .exists()
    );
    assert!(root.path().join("agent-sessions/codex-live.json").exists());
}
#[test]
fn staged_crash_recovers_original_item_and_preserves_replacement_source() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("LocalSettings");
    let service = LocalSettings::open(&settings).unwrap();
    write(root.path(), "GPUCache/data", b"original");
    let plan = prepare(&service, "recover");
    let mut approved = approve(&service, &plan);
    let operation = plan["operation_id"].as_str().unwrap();
    let stage = format!("LocalSettings/storage-staging/{operation}/0");
    fs::create_dir_all(root.path().join(&stage).parent().unwrap()).unwrap();
    approved["state"] = json!("executing");
    approved["execute_key"] = json!("execute");
    approved["file_results"] = json!([]);
    fs::write(
        settings.join(format!("plans/{operation}.json")),
        serde_json::to_vec(&approved).unwrap(),
    )
    .unwrap();
    fs::rename(root.path().join("GPUCache/data"), root.path().join(stage)).unwrap();
    write(root.path(), "GPUCache/data", b"replacement");
    drop(service);
    let service = LocalSettings::open(&settings).unwrap();
    let done = data(execute(&service, &plan));
    assert_eq!(done["result"]["deleted_bytes"], 8);
    assert_eq!(
        fs::read(root.path().join("GPUCache/data")).unwrap(),
        b"replacement"
    );
}
#[cfg(unix)]
#[test]
fn links_and_replaced_parent_never_delete_outside_profile() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let service = LocalSettings::open(&root.path().join("LocalSettings")).unwrap();
    write(outside.path(), "secret", b"keep");
    fs::create_dir(root.path().join("GPUCache")).unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("secret"),
        root.path().join("GPUCache/link"),
    )
    .unwrap();
    fs::hard_link(
        outside.path().join("secret"),
        root.path().join("GPUCache/hard"),
    )
    .unwrap();
    write(root.path(), "GPUCache/normal", b"normal");
    let scan = data(call(&service, "inspect_storage", json!({})));
    assert_eq!(scan["candidates"].as_array().unwrap().len(), 1);
    assert_eq!(scan["partial"], true);
    let plan = prepare(&service, "links");
    approve(&service, &plan);
    fs::rename(root.path().join("GPUCache"), root.path().join("old-cache")).unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join("GPUCache")).unwrap();
    let done = data(execute(&service, &plan));
    assert_eq!(done["result"]["retained_count"], 1);
    assert_eq!(fs::read(outside.path().join("secret")).unwrap(), b"keep");
}
