use hetu_core::Kernel;
use serde_json::{Value, json};
use std::fs;

fn call(k: &Kernel, name: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{name}"),"contract_revision":"1","input":input}))
}
fn ok(result: Value) -> Value {
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn setup() -> (tempfile::TempDir, Kernel) {
    let folder = tempfile::tempdir().unwrap();
    let k = Kernel::open(json!({"workspace_path":folder.path(),"mode":"author","create":{"title":"雾港听潮","locale":"zh-CN","operation_key":"book"}})).unwrap();
    (folder, k)
}
fn task(k: &Kernel, kind: &str, sources: Value, edit: Option<Value>) -> Value {
    let mut input = json!({"scope_ref":{"kind":"workspace","id":k.scope()},"task_kind":kind,"brief":"保留结尾，重写争执。","input_refs":sources,"client_adapter":"codex","language_tag":"zh-CN"});
    if let Some(edit) = edit {
        input["edit_scope"] = edit;
    }
    let p = ok(call(k, "creative_tasks.preview_prompt", input));
    let mut input = p["prepare_input"].clone();
    input["operation_key"] = p["task_ref"]["task_id"].clone();
    ok(call(k, "creative_tasks.prepare", input))
}
fn reader(folder: &tempfile::TempDir, t: &Value) -> Kernel {
    Kernel::open(
        json!({"workspace_path":folder.path(),"mode":"agent","task_id":t["task_ref"]["task_id"]}),
    )
    .unwrap()
}
fn working_input(t: &Value, content: &str) -> Value {
    json!({"task_ref":t["task_ref"],"artifact_kind":"text","source_format":"markdown","title":"第一章参考稿","base_refs":[],"content":content,"operation_key":"working-first"})
}
fn feedback(k: &Kernel, t: &Value, target: Value, head: Value, key: &str) -> Value {
    ok(call(
        k,
        "task_feedback.save",
        json!({"task_ref":t["task_ref"],"target_refs":[target],"expected_feedback_head":head,"intent":"request_changes","public_comment":"保留结尾，重写争执；不要解释人物动机。","selected_refs":[],"operation_key":key}),
    ))
}
fn get(k: &Kernel, t: &Value, r: &Value) -> Value {
    ok(call(
        k,
        "working_copies.get",
        json!({"task_ref":t["task_ref"],"working_copy_ref":r}),
    ))
}
fn submit(k: &Kernel, t: &Value, r: Value, feedback_refs: Value, key: &str) -> Value {
    ok(call(
        k,
        "creative_tasks.submit_result",
        json!({"task_ref":t["task_ref"],"request_sha256":t["request_sha256"],"working_copy_refs":[r],"feedback_refs":feedback_refs,"complete":true,"missing_items":[],"provenance":{"client":"codex-test","skill_version":"1"},"operation_key":key}),
    ))
}

#[test]
fn whole_book_working_copy_keeps_twenty_authorized_sources_after_reopen_and_submit() {
    let (folder, author) = setup();
    let mut sources = Vec::new();
    for index in 0..21 {
        let doc = ok(call(
            &author,
            "documents.create",
            json!({"kind":"novel_chapter","title":format!("第{}回", index + 1),"source_format":"markdown","content":format!("第{}回原著正文保持。", index + 1),"operation_key":format!("chapter-{index}")}),
        ));
        sources.push(json!({"kind":"document","document_id":doc["document"]["document_id"],"revision_id":doc["revision"]["revision_id"]}));
    }
    let authorized = json!(&sources[..20]);
    let t = task(&author, "outline", authorized.clone(), None);
    let agent = reader(&folder, &t);
    let input = json!({"task_ref":t["task_ref"],"artifact_kind":"outline","source_format":"markdown","title":"二十回复盘","base_refs":authorized,"content":"二十回初次复盘。","operation_key":"whole-book-copy"});
    let first = ok(call(&agent, "working_copies.create", input.clone()));
    assert_eq!(
        ok(call(&agent, "working_copies.create", input.clone())),
        first
    );
    assert_eq!(first["working_copy"]["base_refs"], authorized);
    let mut outside = input;
    outside["base_refs"] = json!([sources[20]]);
    outside["operation_key"] = json!("outside-task");
    assert_eq!(
        call(&agent, "working_copies.create", outside)["error"]["code"],
        "forbidden"
    );
    drop(agent);
    let agent = reader(&folder, &t);
    assert_eq!(
        get(&agent, &t, &first["working_copy_ref"])["working_copy"]["base_refs"],
        authorized
    );
    let second = ok(call(
        &agent,
        "working_copies.save",
        json!({"task_ref":t["task_ref"],"working_copy_id":first["working_copy_ref"]["working_copy_id"],"expected":first["working_copy_ref"],"content":"补充二十回跨章依据。","feedback_refs":[],"operation_key":"whole-book-second"}),
    ));
    submit(
        &agent,
        &t,
        second["working_copy_ref"].clone(),
        json!([]),
        "whole-book-submit",
    );
    let loaded = ok(call(
        &agent,
        "creative_tasks.get",
        json!({"task_ref":t["task_ref"]}),
    ));
    assert_eq!(
        loaded["submission"]["candidates"][0]["content"],
        "补充二十回跨章依据。"
    );
    assert_eq!(
        get(&agent, &t, &first["working_copy_ref"])["revision"]["content"],
        "二十回初次复盘。"
    );
    assert_eq!(
        get(&agent, &t, &second["working_copy_ref"])["working_copy"]["base_refs"],
        authorized
    );
    for source in &sources {
        let doc = ok(call(
            &author,
            "documents.get",
            json!({"document_id":source["document_id"]}),
        ));
        assert_eq!(doc["revision"]["revision_id"], source["revision_id"]);
    }
}

#[test]
fn continuous_revision_feedback_fixed_submission_and_resume_preserve_author_text() {
    let (folder, author) = setup();
    let doc = ok(call(
        &author,
        "documents.create",
        json!({"kind":"novel_chapter","title":"作者正文","source_format":"markdown","content":"作者手稿保持不变。","operation_key":"chapter"}),
    ));
    let t = task(&author, "chapter_draft", json!([]), None);
    let agent = reader(&folder, &t);
    let input = working_input(&t, "初稿的争执。\n\n结尾保留。🌿");
    let first = ok(call(&agent, "working_copies.create", input.clone()));
    assert_eq!(ok(call(&agent, "working_copies.create", input)), first);
    let first_ref = first["working_copy_ref"].clone();
    let f = feedback(
        &author,
        &t,
        json!({"kind":"working_copy","working_copy_ref":first_ref}),
        Value::Null,
        "opinion",
    );
    assert_eq!(f["delivery_state"], "not_requested");
    let saved_input = json!({"task_ref":t["task_ref"],"working_copy_id":first_ref["working_copy_id"],"expected":first_ref,"content":"不解释动机的争执。\n\n结尾保留。🌿","feedback_refs":[f["feedback_ref"]],"operation_key":"working-second"});
    // 重新打开连接，沿原任务、原意见继续，不依赖进程内 activeTask。
    drop(agent);
    let agent = reader(&folder, &t);
    let second = ok(call(&agent, "working_copies.save", saved_input.clone()));
    assert_eq!(ok(call(&agent, "working_copies.save", saved_input)), second);
    assert_eq!(
        get(&agent, &t, &first_ref)["revision"]["content"],
        "初稿的争执。\n\n结尾保留。🌿"
    );
    let batch = submit(
        &agent,
        &t,
        second["working_copy_ref"].clone(),
        json!([f["feedback_ref"]]),
        "fixed-submit",
    );
    let candidate = &batch["submission"]["candidates"][0];
    assert_eq!(candidate["working_copy_ref"], second["working_copy_ref"]);
    assert!(!candidate["draft_ref"]["draft_id"].is_null());
    let third_input = json!({"task_ref":t["task_ref"],"working_copy_id":first_ref["working_copy_id"],"expected":second["working_copy_ref"],"content":"下一版仍是参考稿。","feedback_refs":[],"operation_key":"working-third"});
    ok(call(&author, "working_copies.save", third_input));
    let stale = call(
        &agent,
        "working_copies.save",
        json!({"task_ref":t["task_ref"],"working_copy_id":first_ref["working_copy_id"],"expected":second["working_copy_ref"],"content":"不能覆盖作者刚保存的参考稿。","feedback_refs":[],"operation_key":"competing"}),
    );
    assert_eq!(stale["error"]["code"], "revision_conflict");
    let loaded = ok(call(
        &agent,
        "creative_tasks.get",
        json!({"task_ref":t["task_ref"]}),
    ));
    assert_eq!(
        loaded["submission"]["candidates"][0]["content"],
        "不解释动机的争执。\n\n结尾保留。🌿"
    );
    let list = ok(call(
        &agent,
        "task_feedback.list",
        json!({"task_ref":t["task_ref"]}),
    ));
    assert_eq!(
        list["feedback"][0]["reported_result_refs"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(list["feedback"][0]["author_acceptance"], "not_implied");
    let unchanged = ok(call(
        &author,
        "documents.get",
        json!({"document_id":doc["document"]["document_id"]}),
    ));
    assert_eq!(unchanged["content"], "作者手稿保持不变。");
}

#[test]
fn feedback_targets_head_conflicts_pagination_and_foreign_references_are_checked() {
    let (folder, author) = setup();
    let t = task(&author, "chapter_draft", json!([]), None);
    let agent = reader(&folder, &t);
    let w = ok(call(
        &agent,
        "working_copies.create",
        working_input(&t, "首稿"),
    ));
    let target = json!({"kind":"working_copy","working_copy_ref":w["working_copy_ref"]});
    let f1 = feedback(&author, &t, target.clone(), Value::Null, "feedback-first");
    assert_eq!(f1["feedback"]["schema_version"], "1.0.0");
    let wrong = call(
        &author,
        "task_feedback.save",
        json!({"task_ref":t["task_ref"],"target_refs":[target],"expected_feedback_head":null,"intent":"request_changes","public_comment":"冲突意见","selected_refs":[],"operation_key":"stale-feedback"}),
    );
    assert_eq!(wrong["error"]["code"], "revision_conflict");
    let f2 = feedback(
        &author,
        &t,
        target.clone(),
        f1["feedback_ref"].clone(),
        "feedback-next",
    );
    let first = ok(call(
        &agent,
        "task_feedback.list",
        json!({"task_ref":t["task_ref"],"limit":1}),
    ));
    assert_eq!(first["feedback"][0]["feedback_ref"], f1["feedback_ref"]);
    let page = ok(call(
        &agent,
        "task_feedback.list",
        json!({"task_ref":t["task_ref"],"limit":1,"after_cursor":first["next_cursor"]}),
    ));
    assert_eq!(page["feedback"][0]["feedback_ref"], f2["feedback_ref"]);
    let another = task(&author, "chapter_draft", json!([]), None);
    let mut foreign = working_input(&another, "其他任务");
    foreign["parent_ref"] = w["working_copy_ref"].clone();
    assert_eq!(
        call(&author, "working_copies.create", foreign)["error"]["code"],
        "not_found"
    );
    assert_eq!(
        call(
            &agent,
            "working_copies.get",
            json!({"task_ref":another["task_ref"],"working_copy_ref":w["working_copy_ref"]})
        )["error"]["code"],
        "forbidden"
    );
    let bad_feedback = json!({"task_ref":another["task_ref"],"target_refs":[target],"expected_feedback_head":null,"intent":"preference","public_comment":"串任务","selected_refs":[],"operation_key":"foreign-feedback"});
    assert_eq!(
        call(&author, "task_feedback.save", bad_feedback)["error"]["code"],
        "not_found"
    );
    let batch = submit(
        &agent,
        &t,
        w["working_copy_ref"].clone(),
        json!([]),
        "candidate",
    );
    let cref = json!({"kind":"candidate","candidate_ref":{"task_ref":t["task_ref"],"submission_id":batch["submission"]["submission_id"],"candidate_id":batch["submission"]["candidates"][0]["candidate_id"]}});
    feedback(
        &author,
        &t,
        cref,
        f2["feedback_ref"].clone(),
        "candidate-feedback",
    );
    assert_eq!(
        call(
            &agent,
            "task_feedback.list",
            json!({"task_ref":t["task_ref"],"after_cursor":first["next_cursor"]})
        )["error"]["code"],
        "cursor_invalid"
    );
}

#[test]
fn revision_working_copy_requires_authorized_utf8_patches_and_keeps_old_candidates_fixed() {
    let (folder, author) = setup();
    let original = "　　灯亮了。🌿\n\n结尾不改。";
    let doc = ok(call(
        &author,
        "documents.create",
        json!({"kind":"novel_chapter","title":"第一章","source_format":"markdown","content":original,"operation_key":"chapter"}),
    ));
    let start = original.find("灯亮了").unwrap();
    let end = start + "灯亮了".len();
    let source = json!({"kind":"document","document_id":doc["document"]["document_id"],"revision_id":doc["revision"]["revision_id"]});
    let t = task(
        &author,
        "revision",
        json!([source]),
        Some(
            json!({"document_id":doc["document"]["document_id"],"revision_id":doc["revision"]["revision_id"],"ranges":[{"byte_start":start,"byte_end":end,"quote":"灯亮了"}]}),
        ),
    );
    let agent = reader(&folder, &t);
    assert_eq!(
        call(
            &agent,
            "working_copies.create",
            working_input(&t, "整章替换")
        )["error"]["code"],
        "forbidden"
    );
    let mut input = working_input(&t, "");
    input.as_object_mut().unwrap().remove("content");
    input["patches"] =
        json!([{"byte_start":start,"byte_end":end,"quote":"灯亮了","replacement":"灯暗了"}]);
    let w = ok(call(&agent, "working_copies.create", input));
    assert_eq!(
        get(&agent, &t, &w["working_copy_ref"])["revision"]["content"],
        "　　灯暗了。🌿\n\n结尾不改。"
    );
    let bad = json!({"task_ref":t["task_ref"],"working_copy_id":w["working_copy_ref"]["working_copy_id"],"expected":w["working_copy_ref"],"patches":[{"byte_start":start+1,"byte_end":end,"quote":"灯亮了","replacement":"越界"}],"feedback_refs":[],"operation_key":"bad-utf8"});
    assert_eq!(
        call(&agent, "working_copies.save", bad)["error"]["code"],
        "hetu.invalid_source_ref"
    );
    let fixed = submit(
        &agent,
        &t,
        w["working_copy_ref"].clone(),
        json!([]),
        "submit-patch",
    );
    assert_eq!(
        fixed["submission"]["candidates"][0]["patches"][0]["replacement"],
        "灯暗了"
    );
    assert_eq!(
        ok(call(
            &author,
            "documents.get",
            json!({"document_id":doc["document"]["document_id"]})
        ))["content"],
        original
    );
}

#[test]
fn tampered_revisions_fail_and_closed_tasks_preserve_author_history() {
    let (folder, author) = setup();
    let t = task(&author, "chapter_draft", json!([]), None);
    let agent = reader(&folder, &t);
    let w = ok(call(
        &agent,
        "working_copies.create",
        working_input(&t, "测试稿"),
    ));
    let path = folder
        .path()
        .join(w["revision"]["content_ref"].as_str().unwrap());
    let bytes = fs::read(&path).unwrap();
    fs::write(&path, "外部篡改").unwrap();
    assert_eq!(
        call(
            &agent,
            "working_copies.get",
            json!({"task_ref":t["task_ref"],"working_copy_ref":w["working_copy_ref"]})
        )["error"]["code"],
        "hetu.integrity_failure"
    );
    fs::write(&path, bytes).unwrap();
    let loaded = ok(call(
        &author,
        "creative_tasks.get",
        json!({"task_ref":t["task_ref"]}),
    ));
    ok(call(
        &author,
        "creative_tasks.close",
        json!({"task_ref":t["task_ref"],"expected":loaded["expected"],"reason":"结束测试","operation_key":"close"}),
    ));
    assert_eq!(
        call(
            &agent,
            "working_copies.get",
            json!({"task_ref":t["task_ref"],"working_copy_ref":w["working_copy_ref"]})
        )["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        get(&author, &t, &w["working_copy_ref"])["revision"]["content"],
        "测试稿"
    );
    assert_eq!(
        call(&author, "working_copies.create", working_input(&t, "新稿"))["error"]["code"],
        "forbidden"
    );
}

#[test]
fn review_metadata_is_fixed_and_content_pages_do_not_repeat_history() {
    let (_folder, k) = setup();
    let t = task(&k, "chapter_draft", json!([]), None);
    let original = "旧稿来信🌿\r\n".repeat(4000);
    let first = ok(call(
        &k,
        "working_copies.create",
        working_input(&t, &original),
    ));
    let reference = &first["working_copy_ref"];
    let read = json!({"task_ref":t["task_ref"],"working_copy_ref":reference,"detail":"summary","result_path":"","max_bytes":256});
    let projection = ok(call(&k, "working_copies.get", read.clone()));
    assert!(projection["working_page_sha256"].is_string());
    let page = ok(call(
        &k,
        "working_copies.get",
        json!({"task_ref":t["task_ref"],"working_copy_ref":reference,"detail":"page","max_bytes":256}),
    ));
    assert_eq!(page["task_ref"], t["task_ref"]);
    assert_eq!(page["working_copy_ref"], *reference);
    assert!(page.get("history").is_none());
    assert!(page.get("working_copy").is_none());
    let content = page["content_page"]["content"].as_str().unwrap();
    assert!(original.starts_with(content));
    assert_eq!(page["content_page"]["range"]["byte_end"], content.len());
    assert_eq!(page["content_page"]["size_bytes"], original.len());
    assert_eq!(page["content_page"]["complete"], false);
    ok(call(
        &k,
        "working_copies.save",
        json!({"task_ref":t["task_ref"],"working_copy_id":reference["working_copy_id"],"expected":reference,"content":"新稿不能替换旧页。","feedback_refs":[],"operation_key":"advance-review-head"}),
    ));
    let mut continuation = read;
    continuation["result_path"] = json!("/history");
    continuation["expected_result_sha256"] = projection["working_page_sha256"].clone();
    assert_eq!(
        call(&k, "working_copies.get", continuation)["error"]["code"],
        "hetu.stale_evidence"
    );
    assert_eq!(get(&k, &t, reference)["revision"]["content"], original);
    let tasks = ok(call(&k, "creative_tasks.list", json!({})));
    assert_eq!(tasks["tasks"][0]["working_copy_count"], 1);
    assert_eq!(tasks["tasks"][0]["submission_count"], 0);
}
