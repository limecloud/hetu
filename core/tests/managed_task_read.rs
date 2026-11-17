use hetu_core::{Kernel, collaboration::CollaborationHub};
use serde_json::{Value, json};

fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(result: Value) -> Value {
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn task(k: &Kernel, work: &Value, key: &str) -> Value {
    let kind = if work["kind"] == "novel" { "chapter_draft" } else { "drama_draft" };
    let preview = ok(call(k, "creative_tasks.preview_prompt", json!({
        "scope_ref":{"kind":"workspace","id":k.scope()},"work_ref":work,
        "task_kind":kind,"brief":"固定本作品，提交参考稿供审阅。","input_refs":[],
        "client_adapter":"codex","language_tag":"zh-CN"
    })));
    let mut input = preview["prepare_input"].clone();
    input["operation_key"] = json!(key);
    ok(call(k, "creative_tasks.prepare", input))
}
fn plugin(k: &Kernel, work: &Value, reference: &Value) -> Value {
    k.open_plugin_request(json!({"context":{
        "plugin_id":"org.test.task-read","package_sha256":"a".repeat(64),"work_ref":work,"types":[]},
        "request":{"action":"hetu.creative_tasks.get","contract_revision":"1","input":{"task_ref":reference}}}))
}

#[test]
fn management_reads_owned_tasks_but_not_sibling_tasks_and_revocation_is_immediate() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("作品");
    let k = Kernel::open(json!({"workspace_path":workspace,"mode":"author","create":{
        "title":"潮汐邮局","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let novel = ok(call(&k, "works.list", json!({})))["works"][0]["work_ref"].clone();
    let drama = ok(call(&k, "drama.projects.create", json!({"title":"同根独立剧本","operation_key":"drama"})));
    let sibling = json!({"workspace_id":k.scope(),"kind":"drama","object_id":drama["project"]["project_id"]});
    let owned = task(&k, &novel, "own-task");
    let other = task(&k, &sibling, "sibling-task");
    let submitted = ok(call(&k, "creative_tasks.submit_result", json!({"task_ref":owned["task_ref"],
        "request_sha256":owned["request_sha256"],"candidates":[{"kind":"text","title":"第一章候选",
        "source_format":"markdown","source_ref_indices":[],"content":"信封未拆，留下待查的差异。"}],
        "complete":true,"missing_items":[],"provenance":{"client":"test","skill_version":"1"},"operation_key":"submit"})));
    let collaboration = directory.path().join("连接");
    let grant = ok(call(&k, "collaboration.authorize_workspace", json!({"work_ref":novel,
        "client_adapter":"codex","collaboration_path":collaboration,"operation_key":"grant"})));
    let reference = grant["management_ref"].clone();
    let hub = CollaborationHub::open(&collaboration, "codex").unwrap();
    let read = |reference: &Value, input: Value| hub.request(json!({"action":"hetu.creative_tasks.get",
        "contract_revision":"1","input":{"management_ref":reference,"task_ref":input}}));
    let catalog = hub.request(json!({"action":"hetu.capabilities.get","contract_revision":"1",
        "input":{"management_ref":reference}}));
    assert!(ok(catalog)["actions"].as_array().unwrap().iter().any(|a| a["name"] == "hetu.creative_tasks.get"));
    let actual = ok(read(&reference, owned["task_ref"].clone()));
    assert_eq!(actual["request_sha256"], owned["request_sha256"]);
    assert_eq!(actual["request"]["input_snapshot"]["scope_context"]["work_ref"], novel);
    assert_eq!(actual["submission"]["submission_id"], submitted["submission"]["submission_id"]);
    assert_eq!(actual["submission"]["candidates"][0]["content"], "信封未拆，留下待查的差异。");
    assert_eq!(read(&reference, other["task_ref"].clone())["error"]["code"], "forbidden");
    let foreign = json!({"scope_ref":{"kind":"workspace","id":"workspace_00000000-0000-4000-8000-000000000000"},
        "task_id":owned["task_ref"]["task_id"],"request_revision":1});
    assert_ne!(read(&reference, foreign)["status"], "succeeded");
    // 只读任务详情不使管理连接获得提交或作者决定权。
    for action in ["hetu.creative_tasks.submit_result", "hetu.creative_tasks.close"] {
        assert!(!ok(hub.request(json!({"action":"hetu.capabilities.get","contract_revision":"1",
            "input":{"management_ref":reference}})))["actions"].as_array().unwrap().iter().any(|a| a["name"] == action));
    }
    ok(call(&k, "collaboration.revoke_management", json!({"grant_id":reference["grant_id"],
        "client_adapter":"codex","collaboration_path":collaboration,"operation_key":"revoke"})));
    assert_eq!(read(&reference, owned["task_ref"].clone())["error"]["code"], "forbidden");
}

#[test]
fn trusted_plugin_view_still_cannot_read_another_work_task() {
    let directory = tempfile::tempdir().unwrap();
    let k = Kernel::open(json!({"workspace_path":directory.path(),"mode":"author","create":{
        "title":"海边","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let novel = ok(call(&k, "works.list", json!({})))["works"][0]["work_ref"].clone();
    let drama = ok(call(&k, "drama.projects.create", json!({"title":"独立剧本","operation_key":"drama"})));
    let sibling = json!({"workspace_id":k.scope(),"kind":"drama","object_id":drama["project"]["project_id"]});
    let owned = task(&k, &novel, "own-task");
    let other = task(&k, &sibling, "other-task");
    assert_eq!(plugin(&k, &novel, &owned["task_ref"])["status"], "succeeded");
    assert_eq!(plugin(&k, &novel, &other["task_ref"])["error"]["code"], "forbidden");
    assert_eq!(plugin(&k, &sibling, &other["task_ref"])["status"], "succeeded");
    assert_eq!(plugin(&k, &sibling, &owned["task_ref"])["error"]["code"], "forbidden");
}
