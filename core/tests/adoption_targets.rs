use hetu_core::Kernel;
use serde_json::{Value, json};

fn call(kernel: &Kernel, action: &str, input: Value) -> Value {
    kernel.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}

fn data(result: Value) -> Value {
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}

fn project(kernel: &Kernel, key: &str) -> Value {
    data(call(
        kernel,
        "drama.projects.create",
        json!({"title":key,"mode":"original","operation_key":key}),
    ))
}

fn project_ref(project: &Value) -> Value {
    json!({"project_id":project["project"]["project_id"],"revision":project["project"]["revision"],"sha256":project["sha256"]})
}

fn work(kernel: &Kernel, project: &Value) -> Value {
    json!({"workspace_id":kernel.scope(),"kind":"drama","object_id":project["project"]["project_id"]})
}

#[test]
fn legacy_unowned_drama_keeps_its_contract_without_guessing_a_project() {
    let directory = tempfile::tempdir().unwrap();
    let kernel = Kernel::open(json!({"workspace_path":directory.path(),"mode":"author","create":{"title":"旧稿","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let project = project(&kernel, "独立剧本");
    let content = "INT. 房间 - DAY\n\n旧稿内容。\n";
    let submitted = data(call(
        &kernel,
        "drafts.submit",
        json!({"package":"drama","source_format":"fountain","title":"旧参考稿","content":content,"blueprint_revision":1,"operation_key":"draft"}),
    ));
    let draft = &submitted["draft"];
    let request = json!({"draft_ref":{"draft_id":draft["draft_id"],"revision":draft["revision"],"sha256":draft["content_sha256"]},"target_ref":null,
        "new_document":{"title":"旧稿采纳","volume_id":null,"novel_expected":null},"selected_ranges":[{"source":{"byte_start":0,"byte_end":content.len(),"quote":content},"target":{"byte_start":0,"byte_end":0,"quote":""}}]});
    let mut guessed = request.clone();
    guessed["new_document"]["drama_project_ref"] = project_ref(&project);
    assert_eq!(
        call(&kernel, "drafts.preview_adoption", guessed)["error"]["code"],
        "forbidden"
    );
    let preview = data(call(&kernel, "drafts.preview_adoption", request));
    let input = json!({"preview":preview["preview"],"operation_key":"old-adopt"});
    let committed = call(&kernel, "drafts.adopt", input.clone());
    let adopted = data(committed.clone());
    assert!(adopted["document"]["drama_episode_id"].is_null());
    assert_eq!(call(&kernel, "drafts.adopt", input), committed);
    assert!(
        data(call(
            &kernel,
            "drama.projects.get",
            json!({"project_id":project["project"]["project_id"]})
        ))["episodes"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn new_episode_adoption_is_owned_atomic_and_recoverable_after_directory_changes() {
    let directory = tempfile::tempdir().unwrap();
    let kernel = Kernel::open(json!({"workspace_path":directory.path(),"mode":"author","create":{"title":"新稿采纳","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let first = project(&kernel, "雾港剧本");
    let other = project(&kernel, "独立剧本");
    let owner = work(&kernel, &first);
    let content = "INT. 灯塔 - NIGHT\n\n江岚推开门。🌿\n";
    let prompt = data(call(
        &kernel,
        "creative_tasks.preview_prompt",
        json!({"scope_ref":{"kind":"workspace","id":kernel.scope()},"work_ref":owner,"task_kind":"drama_draft","brief":"准备新分集","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN","candidate_limit":1}),
    ));
    let mut prepare = prompt["prepare_input"].clone();
    prepare["operation_key"] = json!("task");
    let task = data(call(&kernel, "creative_tasks.prepare", prepare));
    let agent = Kernel::open(json!({"workspace_path":directory.path(),"mode":"agent","task_id":task["task_ref"]["task_id"]})).unwrap();
    let submitted = data(call(
        &agent,
        "creative_tasks.submit_result",
        json!({"task_ref":task["task_ref"],"request_sha256":task["request_sha256"],"candidates":[{"kind":"text","title":"第二集 灯塔","content":content,"source_format":"fountain","source_ref_indices":[]}],"complete":true,"missing_items":[],"provenance":{"client":"test","skill_version":"1"},"operation_key":"submit"}),
    ));
    let draft_value = data(call(
        &kernel,
        "drafts.get",
        json!({"draft_id":submitted["submission"]["candidates"][0]["draft_ref"]["draft_id"]}),
    ));
    let draft = &draft_value["draft"];
    let mut request = json!({"draft_ref":{"draft_id":draft["draft_id"],"revision":draft["revision"],"sha256":draft["content_sha256"]},
        "target_ref":null,"new_document":{"title":"第二集 灯塔","volume_id":null,"novel_expected":null,"drama_project_ref":project_ref(&first)},
        "selected_ranges":[{"source":{"byte_start":0,"byte_end":content.len(),"quote":content},"target":{"byte_start":0,"byte_end":0,"quote":""}}]});
    let mut wrong = request.clone();
    wrong["new_document"]["drama_project_ref"] = project_ref(&other);
    assert_eq!(
        call(&kernel, "drafts.preview_adoption", wrong)["error"]["code"],
        "forbidden"
    );
    let mut unbound = request.clone();
    unbound["new_document"]
        .as_object_mut()
        .unwrap()
        .remove("drama_project_ref");
    assert_eq!(
        call(&kernel, "drafts.preview_adoption", unbound)["error"]["code"],
        "invalid_input"
    );
    let preview = data(call(&kernel, "drafts.preview_adoption", request.clone()));
    assert!(
        data(call(&kernel, "documents.list", json!({"work_ref":owner})))["documents"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    let concurrent = data(call(
        &kernel,
        "drama.episodes.create",
        json!({"project_ref":project_ref(&first),"title":"第一集 雾起","language_tag":"zh-CN","operation_key":"concurrent"}),
    ));
    assert_eq!(
        call(
            &kernel,
            "drafts.adopt",
            json!({"preview":preview["preview"],"operation_key":"stale"})
        )["error"]["code"],
        "revision_conflict"
    );
    let before = data(call(
        &kernel,
        "drama.projects.get",
        json!({"project_id":owner["object_id"]}),
    ));
    assert_eq!(before["episodes"].as_array().unwrap().len(), 1);
    assert_eq!(
        data(call(&kernel, "documents.list", json!({"work_ref":owner})))["documents"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    request["new_document"]["drama_project_ref"] = project_ref(&concurrent);
    let preview = data(call(&kernel, "drafts.preview_adoption", request));
    let input = json!({"preview":preview["preview"],"operation_key":"adopt-new"});
    let committed = call(&kernel, "drafts.adopt", input.clone());
    let adopted = data(committed.clone());
    assert_eq!(
        adopted["document"]["drama_episode_id"],
        adopted["episode"]["episode_id"]
    );
    assert_eq!(adopted["episode"]["project_id"], owner["object_id"]);
    assert!(adopted["document"]["finalization_ref"].is_null());
    let id = &adopted["document"]["document_id"];
    let saved = data(call(&kernel, "documents.get", json!({"document_id":id})));
    assert_eq!(saved["content"], content);
    assert_eq!(
        data(call(
            &kernel,
            "documents.lifecycle",
            json!({"document_id":id})
        ))["adoptions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    // 成功后目录再变化，原键仍返回原结果，不创建第三份分集。
    data(call(
        &kernel,
        "drama.projects.update",
        json!({"project_ref":project_ref(&adopted),"title":"雾港修订版","description":"保留原采纳","archived":false,"operation_key":"rename"}),
    ));
    drop(kernel);
    let kernel = Kernel::open(json!({"workspace_path":directory.path(),"mode":"author"})).unwrap();
    assert_eq!(call(&kernel, "drafts.adopt", input), committed);
    let receipt = data(call(
        &kernel,
        "operations.get",
        json!({"action":"hetu.drafts.adopt","key":"adopt-new"}),
    ));
    assert_eq!(receipt["original_result"], committed);
    let after = data(call(
        &kernel,
        "drama.projects.get",
        json!({"project_id":owner["object_id"]}),
    ));
    assert_eq!(after["episodes"].as_array().unwrap().len(), 2);
    assert!(
        data(call(
            &kernel,
            "documents.list",
            json!({"work_ref":work(&kernel, &other)})
        ))["documents"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    let mut wrong_existing = preview["preview"]["request"].clone();
    let other_episode = data(call(
        &kernel,
        "drama.episodes.create",
        json!({"project_ref":project_ref(&other),"title":"无关分集","language_tag":"zh-CN","operation_key":"other-episode"}),
    ));
    wrong_existing["new_document"] = Value::Null;
    wrong_existing["target_ref"] = json!({"document_id":other_episode["document"]["document_id"],"revision_id":other_episode["document_revision"]["revision_id"],"sha256":other_episode["document_revision"]["sha256"]});
    assert_eq!(
        call(&kernel, "drafts.preview_adoption", wrong_existing)["error"]["code"],
        "forbidden"
    );
}
