use hetu_core::Kernel;
use serde_json::{Value, json};
use std::path::Path;

fn call(kernel: &Kernel, action: &str, input: Value) -> Value {
    kernel.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn open(path: &Path, create: bool) -> Kernel {
    let mut input = json!({"workspace_path":path,"mode":"author"});
    if create {
        input["create"] = json!({"title":"时间记录验收","locale":"zh-CN","operation_key":"create"});
    }
    Kernel::open(input).unwrap()
}
fn properties(kernel: &Kernel) -> Value {
    let result = call(kernel, "workspaces.get", json!({}));
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"]["properties"].clone()
}

#[test]
fn timestamps_survive_reopen_and_only_successful_new_writes_advance_update_time() {
    let root = tempfile::tempdir().unwrap();
    let kernel = open(root.path(), true);
    let initial = properties(&kernel);
    assert!(initial["created_at"].as_str().is_some());
    assert_eq!(initial["created_at"], initial["updated_at"]);
    assert_eq!(initial, properties(&open(root.path(), false)));
    let input = json!({"kind":"novel_chapter","title":"第一章","source_format":"markdown","content":"旧站的夜。","operation_key":"chapter"});
    let created = call(&kernel, "documents.create", input.clone());
    assert_eq!(created["status"], "succeeded");
    let changed = properties(&kernel);
    assert_eq!(changed["created_at"], initial["created_at"]);
    assert_ne!(changed["updated_at"], initial["updated_at"]);
    assert_eq!(created, call(&kernel, "documents.create", input));
    assert_eq!(changed, properties(&kernel));
    let failed = call(
        &kernel,
        "documents.save",
        json!({"document_id":created["data"]["document"]["document_id"],"base_revision_id":"rev_00000000-0000-4000-8000-000000000000","source_format":"markdown","content":"过期修改","operation_key":"stale"}),
    );
    assert_ne!(failed["status"], "succeeded");
    assert_eq!(changed, properties(&kernel));
    let saved = call(
        &kernel,
        "documents.save",
        json!({"document_id":created["data"]["document"]["document_id"],"base_revision_id":created["data"]["revision"]["revision_id"],"source_format":"markdown","content":"修改后的旧站。","operation_key":"save"}),
    );
    assert_eq!(saved["status"], "succeeded");
    assert_eq!(
        saved["data"]["document"]["created_at"],
        created["data"]["document"]["created_at"]
    );
    assert_ne!(
        saved["data"]["revision"]["created_at"],
        created["data"]["revision"]["created_at"]
    );
    assert_ne!(properties(&kernel)["updated_at"], changed["updated_at"]);
    assert_eq!(properties(&kernel), properties(&open(root.path(), false)));
}

#[test]
fn legacy_times_come_from_records_and_reading_does_not_create_or_rewrite_properties() {
    let root = tempfile::tempdir().unwrap();
    let kernel = open(root.path(), true);
    let initial = properties(&kernel);
    // 仅移除本测试临时作品的新投影，模拟旧版文件布局。
    let path = root.path().join(".hetu/workspace-properties.json");
    std::fs::remove_file(&path).unwrap();
    let legacy = properties(&kernel);
    assert_eq!(legacy["created_at"], initial["created_at"]);
    assert!(legacy["updated_at"].is_null());
    assert!(!path.exists());
    let result = call(
        &kernel,
        "documents.create",
        json!({"kind":"novel_chapter","title":"旧作品首章","source_format":"markdown","content":"","operation_key":"legacy-chapter"}),
    );
    assert_eq!(result["status"], "succeeded");
    let stored = std::fs::read(&path).unwrap();
    assert_eq!(properties(&kernel)["created_at"], initial["created_at"]);
    assert_eq!(stored, std::fs::read(path).unwrap());
}

#[test]
fn moved_workspace_rejects_writes_from_old_handles_even_if_original_path_is_reused() {
    let root = tempfile::tempdir().unwrap();
    let original = root.path().join("original");
    let moved = root.path().join("moved");
    let stale = open(&original, true);
    let input = json!({"kind":"novel_chapter","title":"旧窗口写入","source_format":"markdown","content":"不能进入已移走作品","operation_key":"stale-write"});
    std::fs::rename(&original, &moved).unwrap();
    assert_eq!(
        call(&stale, "documents.create", input.clone())["error"]["code"],
        "hetu.workspace_moved"
    );
    let replacement = open(&original, true);
    assert_eq!(
        call(&stale, "documents.create", input)["error"]["code"],
        "hetu.workspace_moved"
    );
    assert!(
        call(&replacement, "documents.list", json!({}))["data"]["documents"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let restored = open(&moved, false);
    assert!(
        call(&restored, "documents.list", json!({}))["data"]["documents"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        call(
            &restored,
            "documents.create",
            json!({"kind":"novel_chapter","title":"重新打开后可写","source_format":"markdown","content":"恢复后的作品","operation_key":"reopened"})
        )["status"],
        "succeeded"
    );
}
