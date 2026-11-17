use hetu_core::{Kernel, application::extensions::PluginSession, collaboration::CollaborationHub};
use serde_json::{Value, json};

fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(result: Value) -> Value {
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn fields(work: &Value, body: &str, key: &str) -> Value {
    json!({"work_ref":work,"title":"明湖居原著摘录","category":"research","body":body,
        "tags":[],"project_id":null,"entity_refs":[],"source_notes":"固定原著修订的节选，公版练习，非第三方授权证明。","operation_key":key})
}
fn source(work: &Value, resource: &Value) -> Value {
    json!({"kind":"resource","work_ref":work,"resource_id":resource["resource"]["resource_id"],
        "revision":resource["resource"]["revision"],"sha256":resource["sha256"]})
}
fn setup() -> (tempfile::TempDir, Kernel, Value) {
    let root = tempfile::tempdir().unwrap();
    let author = Kernel::open(
        json!({"workspace_path":root.path().join("作品"),"mode":"author",
        "create":{"title":"固定资料写作","locale":"zh-CN","operation_key":"book"}}),
    )
    .unwrap();
    let work = ok(call(&author, "works.list", json!({})))["works"][0]["work_ref"].clone();
    (root, author, work)
}
fn preview(author: &Kernel, work: &Value, sources: Value) -> Value {
    call(
        author,
        "creative_tasks.preview_prompt",
        json!({"scope_ref":{"kind":"workspace","id":author.scope()},
        "work_ref":work,"task_kind":"chapter_draft","brief":"按固定摘录写待审参考稿。",
        "input_refs":sources,"client_adapter":"codex","language_tag":"zh-CN"}),
    )
}

#[test]
fn fixed_resource_context_survives_update_submission_reopen_and_checks_revocation() {
    let (root, author, work) = setup();
    let body = "开篇🌿\r\n白妞登台，观众屏息。\r\n期待再唱不等于已经再唱。";
    let resource = ok(call(
        &author,
        "resources.create",
        fields(&work, body, "source"),
    ));
    let reference = source(&work, &resource);
    let p = ok(preview(&author, &work, json!([reference])));
    let mut prepare = p["prepare_input"].clone();
    prepare["operation_key"] = json!("prepare");
    let task = ok(call(&author, "creative_tasks.prepare", prepare));
    assert!(
        task["request"]["input_snapshot"]["sources"][0]
            .get("content")
            .is_none()
    );
    let private = root.path().join("连接");
    ok(call(
        &author,
        "collaboration.authorize",
        json!({"task_ref":task["task_ref"],
        "client_adapter":"codex","collaboration_path":private,"operation_key":"grant"}),
    ));
    let hub = CollaborationHub::open(&private, "codex").unwrap();
    let route = |action: &str, input: Value| {
        hub.request(
            json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}),
        )
    };
    let opened = ok(route(
        "collaboration.open",
        json!({"task_locator":{"scope_ref":task["task_ref"]["scope_ref"],"task_id":task["task_ref"]["task_id"]}}),
    ));
    let task_ref = &opened["task_ref"];
    let entries = ok(route(
        "task_context.list",
        json!({"task_ref":task_ref,"kind":"resource"}),
    ));
    assert_eq!(entries["entries"].as_array().unwrap().len(), 1);
    let entry = &entries["entries"][0];
    assert_eq!(entry["source_kind"], "resource");
    assert_eq!(entry["fixed_ref"], reference);
    assert_eq!(entry["size_bytes"], body.len());
    let context_ref = &entry["context_ref"];
    assert_eq!(
        ok(route(
            "task_context.read",
            json!({"task_ref":task_ref,"context_ref":context_ref,"max_bytes":4})
        ))["content"],
        "开"
    );
    assert_eq!(
        route(
            "task_context.read",
            json!({"task_ref":task_ref,"context_ref":context_ref,"range":{"byte_start":1}})
        )["error"]["code"],
        "hetu.invalid_source_ref"
    );
    assert_eq!(
        route(
            "task_context.read",
            json!({"task_ref":task_ref,"context_ref":{"context_id":"context_99","sha256":resource["sha256"]}})
        )["error"]["code"],
        "forbidden"
    );
    let mut edit = fields(&work, "后来的资料不能渗入旧任务。", "source-update");
    edit["resource_id"] = reference["resource_id"].clone();
    edit["expected"] = json!({"revision":1,"sha256":resource["sha256"]});
    let mut attempted = edit.clone();
    attempted["task_ref"] = task_ref.clone();
    let denied = route("resources.update", attempted);
    assert_eq!(denied["error"]["code"], "forbidden", "{denied}");
    let updated = ok(call(&author, "resources.update", edit));
    assert_eq!(updated["resource"]["revision"], 2);
    let read = ok(route(
        "task_context.read",
        json!({"task_ref":task_ref,"context_ref":context_ref}),
    ));
    assert_eq!(read["content"], body);
    assert_eq!(read["sha256"], resource["sha256"]);
    assert_eq!(read["source_ref"]["resource_id"], reference["resource_id"]);
    assert_eq!(read["source_ref"]["revision"], 1);
    assert_eq!(read["source_ref"]["quote"], body);
    let hits = ok(route(
        "task_context.search",
        json!({"task_ref":task_ref,"kind":"resource","query":"白妞"}),
    ));
    assert_eq!(hits["matches"].as_array().unwrap().len(), 1);
    let span = &hits["matches"][0]["source_ref"];
    assert_eq!(span["sha256"], reference["sha256"]);
    assert_eq!(
        &body[span["byte_start"].as_u64().unwrap() as usize
            ..span["byte_end"].as_u64().unwrap() as usize],
        "白妞"
    );
    assert_eq!(
        ok(route(
            "task_context.search",
            json!({"task_ref":task_ref,"query":"后来"})
        ))["matches"],
        json!([])
    );
    let copy = ok(route(
        "working_copies.create",
        json!({"task_ref":task_ref,"artifact_kind":"text","source_format":"markdown",
        "title":"明湖居候选","base_refs":[reference],"content":"第一稿：观众等候。","operation_key":"copy"}),
    ));
    let mut outside = reference.clone();
    outside["revision"] = json!(2);
    outside["sha256"] = updated["sha256"].clone();
    assert_eq!(
        route(
            "working_copies.create",
            json!({"task_ref":task_ref,"artifact_kind":"text","source_format":"markdown",
        "title":"越出任务","base_refs":[outside],"content":"不应保存。","operation_key":"outside"})
        )["error"]["code"],
        "forbidden"
    );
    let submit_input = json!({"task_ref":task_ref,"request_sha256":task["request_sha256"],"working_copy_refs":[copy["working_copy_ref"]],
        "feedback_refs":[],"complete":true,"missing_items":[],"provenance":{"client":"resource-context-test","skill_version":"1"},"operation_key":"submit"});
    let submitted = ok(route("creative_tasks.submit_result", submit_input.clone()));
    assert_eq!(
        submitted["submission"]["candidates"][0]["source_refs"],
        json!([reference])
    );
    assert_eq!(
        ok(route("creative_tasks.submit_result", submit_input)),
        submitted
    );
    let reopened = CollaborationHub::open(&private, "codex").unwrap();
    let read = ok(reopened.request(
        json!({"action":"hetu.task_context.read","contract_revision":"1",
        "input":{"task_ref":task_ref,"context_ref":context_ref}}),
    ));
    assert_eq!(read["content"], body);
    ok(call(
        &author,
        "collaboration.revoke",
        json!({"task_ref":task["task_ref"],"client_adapter":"codex",
        "collaboration_path":private,"operation_key":"revoke"}),
    ));
    assert_eq!(
        route(
            "task_context.read",
            json!({"task_ref":task_ref,"context_ref":context_ref})
        )["error"]["code"],
        "forbidden"
    );
}

#[test]
fn resource_sources_reject_forged_digest_and_true_foreign_owner_in_tasks_and_plugins() {
    let (root, author, work) = setup();
    let resource = ok(call(
        &author,
        "resources.create",
        fields(&work, "固定原文。", "source"),
    ));
    let reference = source(&work, &resource);
    let mut wrong_sha = reference.clone();
    wrong_sha["sha256"] = json!("b".repeat(64));
    assert_eq!(
        preview(&author, &work, json!([wrong_sha]))["error"]["code"],
        "hetu.stale_evidence"
    );
    let drama = ok(call(
        &author,
        "drama.projects.create",
        json!({"title":"独立下游","mode":"original","operation_key":"drama"}),
    ));
    let other_work = json!({"workspace_id":author.scope(),"kind":"drama","object_id":drama["project"]["project_id"]});
    let foreign = ok(call(
        &author,
        "resources.create",
        fields(&other_work, "别的作品。", "foreign"),
    ));
    let mut forged = source(&work, &foreign);
    assert_eq!(
        preview(&author, &work, json!([forged]))["error"]["code"],
        "forbidden"
    );
    forged["work_ref"] = other_work.clone();
    assert_eq!(
        preview(&author, &work, json!([forged]))["error"]["code"],
        "forbidden"
    );
    let dir = root.path().join("插件");
    let grant = ok(author.extension_host_request_in(
        &dir,
        json!({"method":"authorize","params":{
        "work_ref":work,"plugin_id":"org.hetu.resource-reader","package_sha256":"a".repeat(64),
        "permissions":["work.read"],"types":[],"operation_key":"grant"}}),
    ));
    let session = PluginSession::open(
        &root.path().join("作品"),
        &dir,
        grant["grant_id"].as_str().unwrap(),
        &"a".repeat(64),
    )
    .unwrap();
    let inspect = |source: &Value| {
        session.request(json!({"action":"hetu.extensions.sources.inspect","contract_revision":"1","input":{"work_ref":work,"source_ref":source}}))
    };
    assert_eq!(ok(inspect(&reference))["resource"]["body"], "固定原文。");
    assert_eq!(inspect(&wrong_sha)["error"]["code"], "hetu.stale_evidence");
    assert_eq!(
        inspect(&source(&work, &foreign))["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        inspect(&source(&other_work, &foreign))["error"]["code"],
        "forbidden"
    );
}
