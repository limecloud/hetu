use hetu_core::Kernel;
use serde_json::{Value, json};

fn call(k: &Kernel, name: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{name}"),"contract_revision":"1","input":input}))
}
fn ok(v: Value) -> Value {
    assert_eq!(v["status"], "succeeded", "{v}");
    v["data"].clone()
}
fn setup() -> (tempfile::TempDir, Kernel, Value, Value) {
    let dir = tempfile::tempdir().unwrap();
    let k = Kernel::open(json!({"workspace_path":dir.path(),"mode":"author","create":{"title":"渡口","locale":"zh-CN","operation_key":"work"}})).unwrap();
    let p = ok(call(
        &k,
        "drama.projects.create",
        json!({"title":"渡口","operation_key":"project"}),
    ));
    let a = ok(call(
        &k,
        "drama.episodes.create",
        json!({"project_ref":{"project_id":p["project"]["project_id"],"revision":p["project"]["revision"],"sha256":p["sha256"]},"title":"相同标题","language_tag":"zh-CN","operation_key":"episode"}),
    ));
    let b = ok(call(
        &k,
        "drama.episodes.create",
        json!({"project_ref":{"project_id":a["project"]["project_id"],"revision":a["project"]["revision"],"sha256":a["sha256"]},"title":"相同标题","language_tag":"zh-CN","operation_key":"episode-b"}),
    ));
    (dir, k, a, b)
}
fn target(k: &Kernel, episode: &Value) -> Value {
    let doc = ok(call(
        k,
        "documents.get",
        json!({"document_id":episode["document"]["document_id"]}),
    ));
    json!({"document_id":doc["document"]["document_id"],"revision_id":doc["revision"]["revision_id"],"sha256":doc["revision"]["sha256"]})
}
fn prepare(k: &Kernel, refs: Value, destination: Option<Value>) -> Value {
    let mut input = json!({"scope_ref":{"kind":"workspace","id":k.scope()},"task_kind":"drama_draft","brief":"渡口相遇","input_refs":refs,"client_adapter":"codex","language_tag":"zh-CN"});
    if let Some(r) = destination {
        input["target_ref"] = r;
    }
    let preview = ok(call(k, "creative_tasks.preview_prompt", input));
    let mut input = preview["prepare_input"].clone();
    input["operation_key"] = preview["task_ref"]["task_id"].clone();
    ok(call(k, "creative_tasks.prepare", input))
}
fn working(k: &Kernel, t: &Value) -> Value {
    ok(call(
        k,
        "working_copies.create",
        json!({"task_ref":t["task_ref"],"artifact_kind":"text","source_format":"fountain","title":"渡口参考稿","base_refs":[],"content":".EXT. 渡口 - 日\n\n@林溪\n船还没来。\n","operation_key":"write"}),
    ))
}
fn episode(k: &Kernel, e: &Value) -> Value {
    ok(call(
        k,
        "drama.episodes.get",
        json!({"episode_id":e["episode"]["episode_id"]}),
    ))
}

#[test]
fn episode_reads_fixed_submission_and_new_working_revision_without_adopting() {
    let (dir, k, a, b) = setup();
    let destination = target(&k, &a);
    let t = prepare(&k, json!([]), Some(destination.clone()));
    let agent = Kernel::open(
        json!({"workspace_path":dir.path(),"mode":"agent","task_id":t["task_ref"]["task_id"]}),
    )
    .unwrap();
    let w = working(&agent, &t);
    assert_eq!(
        episode(&k, &a)["manuscript"]["references"][0]["kind"],
        "working"
    );
    let submitted = ok(call(
        &agent,
        "creative_tasks.submit_result",
        json!({"task_ref":t["task_ref"],"request_sha256":t["request_sha256"],"working_copy_refs":[w["working_copy_ref"]],"feedback_refs":[],"complete":true,"missing_items":[],"provenance":{"client":"codex","skill_version":"test"},"operation_key":"submit"}),
    ));
    let first = episode(&k, &a);
    assert_eq!(first["manuscript"]["author_state"], "empty");
    assert_eq!(
        first["manuscript"]["references"].as_array().unwrap().len(),
        1
    );
    let reference = &first["manuscript"]["references"][0];
    assert_eq!(reference["kind"], "submitted");
    assert_eq!(
        reference["submission_id"],
        submitted["submission"]["submission_id"]
    );
    let draft = ok(call(
        &k,
        "drafts.get",
        json!({"draft_id":reference["draft_ref"]["draft_id"]}),
    ));
    assert_eq!(
        draft["draft"]["target_document_id"],
        destination["document_id"]
    );
    let saved = ok(call(
        &agent,
        "working_copies.get",
        json!({"task_ref":t["task_ref"],"working_copy_ref":w["working_copy_ref"]}),
    ));
    assert_eq!(draft["content"], saved["revision"]["content"]);
    assert_eq!(reference["sha256"], saved["revision"]["sha256"]);
    ok(call(
        &agent,
        "working_copies.save",
        json!({"task_ref":t["task_ref"],"working_copy_id":w["working_copy_ref"]["working_copy_id"],"expected":w["working_copy_ref"],"content":".EXT. 渡口 - 夜\n\n船靠岸。","feedback_refs":[],"operation_key":"next"}),
    ));
    let next = episode(&k, &a);
    assert_eq!(
        next["manuscript"]["references"].as_array().unwrap().len(),
        2
    );
    assert_eq!(
        next["manuscript"]["references"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["kind"] == "submitted")
            .unwrap()["sha256"],
        reference["sha256"]
    );
    assert_eq!(episode(&k, &b)["manuscript"]["references"], json!([]));
    assert_eq!(
        ok(call(
            &k,
            "documents.get",
            json!({"document_id":destination["document_id"]})
        ))["content"],
        ""
    );
    let filtered = ok(call(
        &k,
        "creative_tasks.list",
        json!({"target_document_id":destination["document_id"]}),
    ));
    assert_eq!(filtered["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(
        call(
            &agent,
            "drama.episodes.get",
            json!({"episode_id":b["episode"]["episode_id"]})
        )["error"]["code"],
        "forbidden"
    );
}

#[test]
fn legacy_unique_identity_is_readable_but_ambiguous_inputs_never_guess() {
    let (_dir, k, a, b) = setup();
    let a_ref = target(&k, &a);
    let b_ref = target(&k, &b);
    let source = |r: &Value| json!({"kind":"document","document_id":r["document_id"],"revision_id":r["revision_id"]});
    let t = prepare(&k, json!([source(&a_ref)]), None);
    let w = working(&k, &t);
    let submitted = ok(call(
        &k,
        "creative_tasks.submit_result",
        json!({"task_ref":t["task_ref"],"request_sha256":t["request_sha256"],"working_copy_refs":[w["working_copy_ref"]],"feedback_refs":[],"complete":true,"missing_items":[],"provenance":{"client":"codex","skill_version":"test"},"operation_key":"legacy-submit"}),
    ));
    let legacy = ok(call(
        &k,
        "drafts.get",
        json!({"draft_id":submitted["submission"]["candidates"][0]["draft_ref"]["draft_id"]}),
    ));
    assert!(legacy["draft"]["target_document_id"].is_null());
    assert_eq!(legacy["suggested_target_ref"], a_ref);
    let ambiguous = prepare(&k, json!([source(&a_ref), source(&b_ref)]), None);
    let mut input = json!({"task_ref":ambiguous["task_ref"],"artifact_kind":"text","source_format":"fountain","title":"不可猜","base_refs":[],"content":".EXT. 渡口 - 日\n\n无归属。","operation_key":"ambiguous-write"});
    ok(call(&k, "working_copies.create", input.take()));
    assert_eq!(
        episode(&k, &a)["manuscript"]["references"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(episode(&k, &b)["manuscript"]["references"], json!([]));
}

#[test]
fn target_digest_and_document_type_are_verified_before_preparation() {
    let (_dir, k, a, _b) = setup();
    let mut r = target(&k, &a);
    r["sha256"] = json!("0".repeat(64));
    let mut input = json!({"scope_ref":{"kind":"workspace","id":k.scope()},"task_kind":"drama_draft","brief":"改编","input_refs":[],"target_ref":r,"client_adapter":"codex","language_tag":"zh-CN"});
    assert_eq!(
        call(&k, "creative_tasks.preview_prompt", input.clone())["error"]["code"],
        "hetu.integrity_failure"
    );
    input["target_ref"] = target(&k, &a);
    input["task_kind"] = json!("chapter_draft");
    assert_eq!(
        call(&k, "creative_tasks.preview_prompt", input)["error"]["code"],
        "invalid_input"
    );
}
