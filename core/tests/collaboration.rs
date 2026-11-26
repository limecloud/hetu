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

#[test]
fn workspace_access_rechecks_directory_identity_before_an_author_reconnects() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("作品");
    let author = Kernel::open(json!({"workspace_path":work,"mode":"author","create":{"title":"渡口","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let directory = temp.path().join("接入");
    let hub = CollaborationHub::open(&directory, "codex").unwrap();
    let reference = ok(call(&author, "works.list", json!({})))["works"][0]["work_ref"].clone();
    let document = ok(call(&author, "documents.create", json!({"kind":"novel_chapter","title":"第一章","source_format":"markdown","content":"固定原文。","operation_key":"document"})));
    let access = json!({"client_adapter":"codex","collaboration_path":directory,"work_ref":reference});
    let mut grant_input = access.clone();
    grant_input["operation_key"] = json!("grant");
    let mut grant = ok(call(&author, "collaboration.authorize_workspace", grant_input))["management_ref"].clone();
    let file = directory.join("management/codex").join(format!("{}.json", grant["grant_id"].as_str().unwrap()));
    let read = json!({"document_id":document["document"]["document_id"],"revision_id":document["revision"]["revision_id"]});
    // 设备号可随重新挂载变化；inode替换也必须使状态与实际读取同时失效。
    for field in ["device", "inode"] {
        assert_eq!(ok(call(&author, "collaboration.workspace_access", access.clone()))["authorized"], true);
        let mut record: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        record["root_identity"][field] = json!(record["root_identity"][field].as_u64().unwrap() + 1);
        std::fs::write(&file, serde_json::to_vec(&record).unwrap()).unwrap();
        let state = ok(call(&author, "collaboration.workspace_access", access.clone()));
        assert_eq!(state["authorized"], false, "{field}: {state}");
        let mut input = read.clone();
        input["management_ref"] = grant.clone();
        assert_eq!(hub_call(&hub, "documents.get", input.clone())["error"]["code"], "forbidden");
        let mut reconnect = access.clone();
        reconnect["operation_key"] = json!(format!("reconnect-{field}"));
        let renewed = ok(call(&author, "collaboration.authorize_workspace", reconnect))["management_ref"].clone();
        assert_ne!(renewed["grant_revision"], grant["grant_revision"]);
        assert_eq!(hub_call(&hub, "documents.get", input.clone())["error"]["code"], "forbidden");
        input["management_ref"] = renewed.clone();
        let content = ok(hub_call(&hub, "documents.get", input));
        assert_eq!(content["content"], "固定原文。");
        assert_eq!(content["revision"], document["revision"]);
        grant = renewed;
    }
}

#[test]
fn workspace_management_is_explicit_fixed_and_revocation_does_not_revive_old_tasks() {
    let temp = tempfile::tempdir().unwrap();
    let work = temp.path().join("作品");
    let author = Kernel::open(json!({"workspace_path":work,"mode":"author","create":{"title":"渡口","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let directory = temp.path().join("接入");
    let hub = CollaborationHub::open(&directory, "codex").unwrap();
    let grant = ok(call(
        &author,
        "collaboration.authorize_workspace",
        json!({"client_adapter":"codex","collaboration_path":directory,"operation_key":"grant"}),
    ));
    let reference = grant["management_ref"].clone();
    // 显式传入引用，避开优化构建中闭包反复移动可变 Value 的内存错误。
    // 独立 serde_json 复现与工具链对照见 release-optimized-json-2026-11-15.json。
    fn bound(hub: &CollaborationHub, reference: &Value, name: &str, mut input: Value) -> Value {
        input["management_ref"] = reference.clone();
        hub_call(hub, name, input)
    }
    let before = ok(bound(&hub, &reference, "novels.get", json!({})));
    let mut metadata = before["novel"]["metadata"].clone();
    metadata["synopsis"] = json!("潮水退去后的一封信。");
    assert_ne!(
        bound(
            &hub,
            &reference,
            "novels.update",
            json!({"expected":{"revision":before["revision"],"sha256":before["sha256"]},"metadata":metadata,"operation_key":"direct"})
        )["status"],
        "succeeded"
    );
    let prepared = ok(bound(
        &hub,
        &reference,
        "agent_operations.prepare",
        json!({"action":"hetu.novels.update","input":{"expected":{"revision":before["revision"],"sha256":before["sha256"]},"metadata":metadata,"operation_key":"change"},"summary":"整理简介","operation_key":"prepare"}),
    ));
    assert_eq!(
        bound(
            &hub,
            &reference,
            "agent_operations.execute",
            json!({"proposal_id":prepared["proposal_id"],"proposal_sha256":prepared["proposal_sha256"],"operation_key":"early"})
        )["error"]["code"],
        "hetu.author_confirmation_required"
    );
    ok(call(
        &author,
        "agent_operations.decide",
        json!({"proposal_id":prepared["proposal_id"],"proposal_sha256":prepared["proposal_sha256"],"expected_state_revision":1,"decision":"approve","operation_key":"approve"}),
    ));
    ok(bound(
        &hub,
        &reference,
        "agent_operations.execute",
        json!({"proposal_id":prepared["proposal_id"],"proposal_sha256":prepared["proposal_sha256"],"operation_key":"execute"}),
    ));
    assert_eq!(
        ok(bound(&hub, &reference, "novels.get", json!({})))["novel"]["metadata"]["synopsis"],
        metadata["synopsis"]
    );
    let preview = ok(bound(
        &hub,
        &reference,
        "creative_tasks.preview_prompt",
        json!({"scope_ref":reference["scope_ref"],"task_kind":"book_profile","brief":"整理书名与简介","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN"}),
    ));
    let mut input = preview["prepare_input"].clone();
    input["operation_key"] = json!("task");
    let proposal = ok(bound(
        &hub,
        &reference,
        "agent_operations.prepare",
        json!({"action":"hetu.creative_tasks.prepare","input":input,"summary":"拟简介","operation_key":"prepare-task"}),
    ));
    ok(call(
        &author,
        "agent_operations.decide",
        json!({"proposal_id":proposal["proposal_id"],"proposal_sha256":proposal["proposal_sha256"],"expected_state_revision":1,"decision":"approve","operation_key":"approve-task"}),
    ));
    let execute = json!({"proposal_id":proposal["proposal_id"],"proposal_sha256":proposal["proposal_sha256"],"operation_key":"execute-task"});
    let task = ok(bound(
        &hub,
        &reference,
        "agent_operations.execute",
        execute.clone(),
    ));
    assert!(task["task_locator"].is_object());
    assert_eq!(
        ok(bound(&hub, &reference, "agent_operations.execute", execute))["task_locator"],
        task["task_locator"]
    );
    ok(hub_call(
        &hub,
        "collaboration.open",
        json!({"task_locator":task["task_locator"]}),
    ));
    let other = CollaborationHub::open(&directory, "claude-code").unwrap();
    assert_ne!(
        hub_call(
            &other,
            "workspaces.get",
            json!({"management_ref":reference})
        )["status"],
        "succeeded"
    );
    ok(call(
        &author,
        "collaboration.revoke_management",
        json!({"grant_id":reference["grant_id"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"revoke-work"}),
    ));
    assert_ne!(
        bound(&hub, &reference, "novels.get", json!({}))["status"],
        "succeeded"
    );
    let renewed = ok(call(
        &author,
        "collaboration.authorize_workspace",
        json!({"client_adapter":"codex","collaboration_path":directory,"operation_key":"regrant"}),
    ));
    assert_ne!(
        renewed["management_ref"]["grant_revision"],
        reference["grant_revision"]
    );
    assert_ne!(
        bound(&hub, &reference, "novels.get", json!({}))["status"],
        "succeeded"
    );
    assert_ne!(
        hub_call(
            &hub,
            "collaboration.open",
            json!({"task_locator":task["task_locator"]})
        )["status"],
        "succeeded"
    );
    ok(hub_call(
        &hub,
        "novels.get",
        json!({"management_ref":renewed["management_ref"]}),
    ));
}
