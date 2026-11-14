use hetu_core::{Kernel, collaboration::CollaborationHub};
use serde_json::{Value, json};

fn call(kernel: &Kernel, action: &str, input: Value) -> Value {
    kernel.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(value: Value) -> Value {
    assert_eq!(value["status"], "succeeded", "{value}");
    value["data"].clone()
}
fn task(kernel: &Kernel) -> Value {
    let preview = ok(call(
        kernel,
        "creative_tasks.preview_prompt",
        json!({"scope_ref":{"kind":kernel.scope_kind(),"id":kernel.scope()},"task_kind":"book_profile","brief":"为本作品拟三种简介，不改作者正文。","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN"}),
    ));
    let mut input = preview["prepare_input"].clone();
    input["operation_key"] = json!("prepare");
    ok(call(kernel, "creative_tasks.prepare", input))
}
fn hub_call(hub: &CollaborationHub, action: &str, input: Value) -> Value {
    hub.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn authorize(kernel: &Kernel, task: &Value, directory: &std::path::Path, key: &str) -> Value {
    call(
        kernel,
        "collaboration.authorize",
        json!({"task_ref":task["task_ref"],"client_adapter":"codex","collaboration_path":directory,"operation_key":key}),
    )
}
fn locator(task: &Value) -> Value {
    json!({"scope_ref":task["task_ref"]["scope_ref"],"task_id":task["task_ref"]["task_id"]})
}

#[test]
fn stable_connection_routes_two_books_and_creation_without_global_selection() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("本机授权");
    let hub = CollaborationHub::open(&directory, "codex").unwrap();
    let inspect = ok(hub_call(&hub, "collaboration.inspect", json!({})));
    assert_eq!(inspect["task_selection"], "explicit_reference");
    assert!(!directory.exists(), "发现能力不应创建私有目录或作品");
    let mut works = Vec::new();
    for title in ["雾港", "长河"] {
        let path = temp.path().join(title);
        let kernel=Kernel::open(json!({"workspace_path":path,"mode":"author","create":{"title":title,"locale":"zh-CN","operation_key":"create"}})).unwrap();
        let fixed = task(&kernel);
        assert_eq!(
            hub_call(
                &hub,
                "collaboration.open",
                json!({"task_locator":locator(&fixed)})
            )["error"]["code"],
            "forbidden"
        );
        ok(authorize(&kernel, &fixed, &directory, "grant"));
        let opened = ok(hub_call(
            &hub,
            "collaboration.open",
            json!({"task_locator":locator(&fixed)}),
        ));
        assert_eq!(opened["task_ref"]["sha256"], fixed["request_sha256"]);
        works.push((kernel, fixed, opened["task_ref"].clone()));
    }
    for (_, fixed, reference) in works.iter().rev().chain(works.iter()) {
        let current = ok(hub_call(
            &hub,
            "creative_tasks.get",
            json!({"task_ref":reference}),
        ));
        assert_eq!(
            current["request"]["scope_ref"],
            fixed["request"]["scope_ref"]
        );
        let candidates = json!([{"kind":"synopsis","title":"简介候选","source_format":"plain","source_ref_indices":[],"content":"河岸旧案，只作参考。"}]);
        let input = json!({"task_ref":reference,"request_sha256":fixed["request_sha256"],"candidates":candidates,"complete":true,"missing_items":[],"provenance":{"client":"test","skill_version":"1"},"operation_key":"same-key-different-book"});
        let first = hub_call(&hub, "creative_tasks.submit_result", input.clone());
        ok(first.clone());
        assert_eq!(first, hub_call(&hub, "creative_tasks.submit_result", input));
    }
    let (author, fixed, reference) = &works[0];
    assert_eq!(
        hub_call(&hub, "documents.list", json!({"task_ref":reference}))["error"]["code"],
        "invalid_input"
    );
    let mut stale = reference.clone();
    stale["sha256"] = json!("a".repeat(64));
    assert_eq!(
        hub_call(&hub, "creative_tasks.get", json!({"task_ref":stale}))["error"]["code"],
        "hetu.stale_request"
    );
    let other = CollaborationHub::open(&directory, "claude-code").unwrap();
    assert_eq!(
        hub_call(
            &other,
            "collaboration.open",
            json!({"task_locator":locator(fixed)})
        )["error"]["code"],
        "forbidden"
    );
    ok(call(
        author,
        "collaboration.revoke",
        json!({"task_ref":fixed["task_ref"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"revoke"}),
    ));
    assert_eq!(
        hub_call(&hub, "creative_tasks.get", json!({"task_ref":reference}))["error"]["code"],
        "forbidden"
    );
    // 撤权前的原写入回执也不能作为读取入口。
    assert_eq!(
        hub_call(
            &hub,
            "operations.get",
            json!({"task_ref":reference,"action":"hetu.creative_tasks.submit_result","key":"same-key-different-book"})
        )["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        ok(call(
            author,
            "creative_tasks.get",
            json!({"task_ref":fixed["task_ref"]})
        ))["observation"]["submission_refs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let path = temp.path().join("未命名筹备");
    let project=Kernel::open(json!({"creation_project_path":path,"mode":"author","create_project":{"brief":"还没想好书名","locale":"zh-CN","operation_key":"project"}})).unwrap();
    let fixed = task(&project);
    ok(authorize(&project, &fixed, &directory, "project-grant"));
    let opened = ok(hub_call(
        &hub,
        "collaboration.open",
        json!({"task_locator":locator(&fixed)}),
    ));
    assert_eq!(opened["task_ref"]["scope_ref"]["kind"], "creation_project");
    assert!(!path.join(".heturc.json").exists());
}

#[test]
fn authorization_is_author_only_private_idempotent_and_close_is_immediate() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("授权");
    let path = temp.path().join("作品");
    let author=Kernel::open(json!({"workspace_path":path,"mode":"author","create":{"title":"测试","locale":"zh-CN","operation_key":"book"}})).unwrap();
    let fixed = task(&author);
    let agent = Kernel::open(
        json!({"workspace_path":path,"mode":"agent","task_id":fixed["task_ref"]["task_id"]}),
    )
    .unwrap();
    assert_eq!(
        authorize(&agent, &fixed, &directory, "deny")["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        authorize(&author, &fixed, &path.join("private"), "inside")["error"]["code"],
        "hetu.unsafe_path"
    );
    let grant = authorize(&author, &fixed, &directory, "grant");
    ok(grant.clone());
    assert_eq!(grant, authorize(&author, &fixed, &directory, "grant"));
    let hub = CollaborationHub::open(&directory, "codex").unwrap();
    let opened = ok(hub_call(
        &hub,
        "collaboration.open",
        json!({"task_locator":locator(&fixed)}),
    ));
    ok(call(
        &author,
        "creative_tasks.close",
        json!({"task_ref":fixed["task_ref"],"expected":fixed["expected"],"reason":"作者结束任务","operation_key":"close"}),
    ));
    assert_eq!(
        hub_call(
            &hub,
            "creative_tasks.get",
            json!({"task_ref":opened["task_ref"]})
        )["error"]["code"],
        "forbidden"
    );
    assert!(
        ok(hub_call(&hub, "collaboration.inspect", json!({})))
            .get("works")
            .is_none()
    );
}

#[test]
fn stable_working_and_feedback_keep_full_task_refs_and_original_operation_recovery() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("grant");
    let kernel = Kernel::open(json!({"creation_project_path":temp.path().join("筹备"),"mode":"author","create_project":{"brief":"雾港故事","locale":"zh-CN","operation_key":"project"}})).unwrap();
    let fixed = task(&kernel);
    ok(authorize(&kernel, &fixed, &directory, "authorize"));
    let hub = CollaborationHub::open(&directory, "codex").unwrap();
    let opened = ok(hub_call(
        &hub,
        "collaboration.open",
        json!({"task_locator":locator(&fixed)}),
    ));
    let r = &opened["task_ref"];
    let create = json!({"task_ref":r,"artifact_kind":"synopsis","source_format":"plain","title":"简介参考","content":"旧港发生了一场争执。","base_refs":[],"operation_key":"create-working"});
    let copy = ok(hub_call(&hub, "working_copies.create", create.clone()));
    assert_eq!(ok(hub_call(&hub, "working_copies.create", create)), copy);
    let batch = ok(hub_call(
        &hub,
        "creative_tasks.submit_result",
        json!({"task_ref":r,"request_sha256":fixed["request_sha256"],"working_copy_refs":[copy["working_copy_ref"]],"feedback_refs":[],"complete":true,"missing_items":[],"provenance":{"client":"test","skill_version":"1"},"operation_key":"submit-working"}),
    ));
    let candidate = json!({"task_ref":r,"submission_id":batch["submission"]["submission_id"],"candidate_id":batch["submission"]["candidates"][0]["candidate_id"]});
    let input = json!({"task_ref":r,"expected_feedback_head":null,"target_refs":[{"kind":"candidate","candidate_ref":candidate}],"selected_refs":[],"intent":"request_changes","public_comment":"保留悬念，重写争执。","operation_key":"feedback"});
    let feedback = ok(hub_call(&hub, "task_feedback.save", input));
    assert_eq!(feedback["delivery_state"], "not_requested");
    let recovered = ok(hub_call(
        &hub,
        "operations.get",
        json!({"task_ref":r,"action":"hetu.task_feedback.save","key":"feedback"}),
    ));
    assert_eq!(
        recovered["original_result"]["data"]["feedback_ref"],
        feedback["feedback_ref"]
    );
    let mut missing_digest = candidate;
    missing_digest["task_ref"]
        .as_object_mut()
        .unwrap()
        .remove("sha256");
    let bad = hub_call(
        &hub,
        "task_feedback.save",
        json!({"task_ref":r,"expected_feedback_head":feedback["feedback_ref"],"target_refs":[{"kind":"candidate","candidate_ref":missing_digest}],"selected_refs":[],"intent":"preference","public_comment":"不能降级嵌套引用。","operation_key":"bad"}),
    );
    assert_eq!(bad["error"]["code"], "invalid_input");
    ok(call(
        &kernel,
        "collaboration.revoke",
        json!({"task_ref":fixed["task_ref"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"revoke"}),
    ));
    assert_eq!(
        hub_call(
            &hub,
            "working_copies.get",
            json!({"task_ref":r,"working_copy_ref":copy["working_copy_ref"]})
        )["error"]["code"],
        "forbidden"
    );
}
