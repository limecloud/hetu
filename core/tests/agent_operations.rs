use hetu_core::Kernel;
use serde_json::{Value, json};
use std::path::Path;

fn inline_source(filename: &str, content: &[u8]) -> Value {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use sha2::{Digest, Sha256};
    json!({"filename":filename,"base64":STANDARD.encode(content),"sha256":format!("{:x}",Sha256::digest(content))})
}

fn open(path: &Path, author: bool, create: bool) -> Kernel {
    let mut config = json!({"workspace_path":path,"mode":if author { "author" } else { "agent" }});
    if create {
        config["create"] = json!({"title":"长河夜航","locale":"zh-CN","operation_key":"init"});
    }
    Kernel::open(config).unwrap()
}
fn call(kernel: &Kernel, action: &str, input: Value) -> Value {
    kernel.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(result: Value) -> Value {
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn prepare(agent: &Kernel, action: &str, input: Value, key: &str) -> Value {
    ok(call(
        agent,
        "agent_operations.prepare",
        json!({"action":format!("hetu.{action}"),"input":input,"summary":"整理作品资料","operation_key":key}),
    ))
}
fn decide(author: &Kernel, proposal: &Value, decision: &str, key: &str) -> Value {
    call(
        author,
        "agent_operations.decide",
        json!({"proposal_id":proposal["proposal_id"],"proposal_sha256":proposal["proposal_sha256"],"expected_state_revision":proposal["state_revision"],"decision":decision,"operation_key":key}),
    )
}
fn execute(agent: &Kernel, proposal: &Value, key: &str) -> Value {
    call(
        agent,
        "agent_operations.execute",
        json!({"proposal_id":proposal["proposal_id"],"proposal_sha256":proposal["proposal_sha256"],"operation_key":key}),
    )
}
#[test]
fn metadata_proposal_is_fixed_author_decision_is_separate_and_execution_is_replayable() {
    let root = tempfile::tempdir().unwrap();
    let author = open(root.path(), true, true);
    let agent = open(root.path(), false, false);
    let before = ok(call(&agent, "novels.get", json!({})));
    let mut metadata = before["novel"]["metadata"].clone();
    metadata["synopsis"] = json!("江河渡口的原创故事。🌧️");
    let arguments = json!({"expected":{"revision":before["revision"],"sha256":before["sha256"]},"metadata":metadata,"operation_key":"metadata"});
    assert_eq!(
        call(&agent, "novels.update", arguments.clone())["error"]["code"],
        "forbidden"
    );
    let proposal = prepare(&agent, "novels.update", arguments.clone(), "prepare");
    assert_eq!(
        ok(call(&agent, "novels.get", json!({}))),
        before,
        "准备方案不能修改作品资料"
    );
    assert_eq!(
        execute(&agent, &proposal, "early")["error"]["code"],
        "hetu.author_confirmation_required"
    );
    assert_eq!(
        decide(&agent, &proposal, "approve", "fake")["error"]["code"],
        "forbidden"
    );
    let mut forged = arguments.clone();
    forged["approved"] = json!(true);
    assert_eq!(
        call(
            &agent,
            "agent_operations.prepare",
            json!({"action":"hetu.novels.update","input":forged,"summary":"伪造确认","operation_key":"forged"})
        )["error"]["code"],
        "invalid_input"
    );
    ok(decide(&author, &proposal, "approve", "approve"));
    let result = ok(execute(&agent, &proposal, "execute"));
    assert_eq!(result["state"], "executed");
    assert_eq!(
        ok(call(&agent, "novels.get", json!({})))["novel"]["metadata"],
        metadata
    );
    assert_eq!(
        ok(execute(&agent, &proposal, "another-execute"))["result"],
        result["result"]
    );
    let record: Value = serde_json::from_slice(
        &std::fs::read(root.path().join(format!(
            ".hetu/agent-proposals/{}.state.json",
            proposal["proposal_id"].as_str().unwrap()
        )))
        .unwrap(),
    )
    .unwrap();
    assert!(
        record["executed_by"].as_str().unwrap().ends_with("000002"),
        "执行必须保留Agent身份"
    );
    assert!(record["decided_by"].as_str().unwrap().ends_with("000001"));
}
#[test]
fn approved_proposal_cannot_overwrite_new_author_revision_and_can_be_revoked() {
    let root = tempfile::tempdir().unwrap();
    let author = open(root.path(), true, true);
    let agent = open(root.path(), false, false);
    let before = ok(call(&agent, "novels.get", json!({})));
    let arguments = json!({"expected":{"revision":before["revision"],"sha256":before["sha256"]},"metadata":before["novel"]["metadata"],"operation_key":"metadata"});
    let proposal = prepare(&agent, "novels.update", arguments.clone(), "p");
    let approved = ok(decide(&author, &proposal, "approve", "a"));
    ok(call(&author, "novels.update", arguments));
    assert_eq!(
        execute(&agent, &proposal, "e")["error"]["code"],
        "revision_conflict"
    );
    ok(decide(&author, &approved, "reject", "revoke"));
    assert_eq!(
        execute(&agent, &proposal, "e2")["error"]["code"],
        "hetu.author_confirmation_required"
    );
}
#[test]
fn empty_chapter_and_drama_project_use_reserved_identity_without_author_impersonation() {
    let root = tempfile::tempdir().unwrap();
    let author = open(root.path(), true, true);
    let agent = open(root.path(), false, false);
    let arguments = json!({"kind":"novel_chapter","title":"第一章 渡口","source_format":"markdown","content":"","operation_key":"chapter"});
    let proposal = prepare(&agent, "documents.create", arguments, "p");
    assert!(
        ok(call(&agent, "documents.list", json!({})))["documents"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let reserved = proposal["preview"]["document"]["document_id"].clone();
    ok(decide(&author, &proposal, "approve", "a"));
    ok(execute(&agent, &proposal, "e"));
    let document = ok(call(
        &agent,
        "documents.get",
        json!({"document_id":reserved}),
    ));
    assert_eq!(document["content"], "");
    assert!(
        document["revision"]["actor_ref"]
            .as_str()
            .unwrap()
            .ends_with("000002")
    );
    let project = prepare(
        &agent,
        "drama.projects.create",
        json!({"title":"渡口短剧","description":"原创","mode":"original","operation_key":"drama"}),
        "p2",
    );
    ok(decide(&author, &project, "approve", "a2"));
    ok(execute(&agent, &project, "e2"));
    assert_eq!(
        ok(call(
            &agent,
            "drama.projects.get",
            json!({"project_id":project["preview"]["project"]["project_id"]})
        ))["project"]["title"],
        "渡口短剧"
    );
    for forbidden in [
        "hetu.model_tasks.approve",
        "hetu.collaboration.authorize_workspace",
    ] {
        assert_eq!(
            call(
                &agent,
                "agent_operations.prepare",
                json!({"action":forbidden,"input":{},"summary":"不能提升身份","operation_key":forbidden})
            )["error"]["code"],
            "hetu.capability_unavailable"
        );
    }
    for fixed_decision in [
        "hetu.documents.save",
        "hetu.documents.finalize",
        "hetu.drafts.adopt",
        "hetu.blueprints.unlock",
        "hetu.covers.select",
    ] {
        assert_eq!(
            call(
                &agent,
                "agent_operations.prepare",
                json!({"action":fixed_decision,"input":{},"summary":"必须先准备完整固定结果","operation_key":fixed_decision})
            )["error"]["code"],
            "invalid_input"
        );
    }
    let other = tempfile::tempdir().unwrap();
    let _ = open(other.path(), true, true);
    let other_agent = open(other.path(), false, false);
    assert_ne!(
        call(
            &other_agent,
            "agent_operations.get",
            json!({"proposal_id":project["proposal_id"]})
        )["status"],
        "succeeded"
    );
}
#[test]
fn page_handoff_resolves_fixed_chinese_document_and_does_not_advertise_author_execution() {
    let root = tempfile::tempdir().unwrap();
    let author = open(root.path(), true, true);
    let agent = open(root.path(), false, false);
    let created = ok(call(
        &author,
        "documents.create",
        json!({"kind":"novel_chapter","title":"中文章节","source_format":"markdown","content":"原稿🌧️","operation_key":"doc"}),
    ));
    let object = json!({"document_id":created["document"]["document_id"],"revision_id":created["revision"]["revision_id"]});
    for page in [
        "book",
        "novel",
        "structure",
        "document",
        "search",
        "notes",
        "bible",
        "entity",
        "drama",
        "episode",
        "resources",
        "resource",
        "media",
        "artwork",
        "cover",
        "plot",
        "validation",
        "reviews",
        "git",
        "delivery",
        "import",
    ] {
        let handoff = ok(call(
            &agent,
            "handoffs.get",
            json!({"view_kind":page,"object_ref":object}),
        ));
        assert_eq!(
            handoff["fixed_refs"][0]["sha256"],
            created["revision"]["sha256"]
        );
        assert_eq!(handoff["unsaved_buffer_included"], false);
        assert_eq!(
            handoff["workflow"]["author_decision"],
            "hetu.agent_operations.record_decision"
        );
        for action in handoff["direct_actions"].as_array().unwrap() {
            assert_eq!(action["author_only"], false);
        }
        if page == "delivery" {
            assert!(
                handoff["proposal_actions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|a| a["name"] == "hetu.bundles.export")
            );
            assert!(
                !handoff["direct_actions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|a| a["name"] == "hetu.bundles.export")
            );
            for name in [
                "hetu.documents.preview_import",
                "hetu.documents.preview_export",
                "hetu.bundles.preview",
            ] {
                assert!(
                    handoff["direct_actions"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|a| a["name"] == name),
                    "缺少可获权读取的预览：{name}"
                );
            }
        }
    }
    let other = tempfile::tempdir().unwrap();
    let _ = open(other.path(), true, true);
    let other_agent = open(other.path(), false, false);
    assert_ne!(
        call(
            &other_agent,
            "handoffs.get",
            json!({"view_kind":"document","object_ref":object})
        )["status"],
        "succeeded"
    );
}

#[test]
fn agent_prepares_task_from_page_and_continues_reference_work_without_gui_forms() {
    let root = tempfile::tempdir().unwrap();
    let author = open(root.path(), true, true);
    let agent = open(root.path(), false, false);
    let preview = ok(call(
        &agent,
        "creative_tasks.preview_prompt",
        json!({"scope_ref":{"kind":"workspace","id":agent.scope()},"task_kind":"chapter_draft","brief":"以渡口雨夜开篇，返回参考稿","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN"}),
    ));
    let mut input = preview["prepare_input"].clone();
    input["operation_key"] = json!("task");
    let proposal = prepare(&agent, "creative_tasks.prepare", input, "proposal");
    let task_id = proposal["preview"]["task_ref"]["task_id"].clone();
    assert!(
        !root
            .path()
            .join(format!(
                ".hetu/tasks/{}/request.json",
                task_id.as_str().unwrap()
            ))
            .exists(),
        "任务不得在作者确认前成为正式任务"
    );
    ok(decide(&author, &proposal, "approve", "approve"));
    let result = ok(execute(&agent, &proposal, "execute"));
    let reference = &result["result"]["task_ref"];
    let task = Kernel::open(json!({"workspace_path":root.path(),"mode":"agent","task_id":task_id}))
        .unwrap();
    let working = ok(call(
        &task,
        "working_copies.create",
        json!({"task_ref":reference,"artifact_kind":"text","source_format":"markdown","title":"第一章 雨夜渡口","content":"雨落在渡口，沈砚收起湿透的过所。","base_refs":[],"operation_key":"working"}),
    ));
    let recovered = ok(call(
        &task,
        "working_copies.get",
        json!({"task_ref":reference,"working_copy_ref":working["working_copy_ref"]}),
    ));
    assert!(recovered.to_string().contains("雨落在渡口"), "{recovered}");
    assert!(
        ok(call(&agent, "documents.list", json!({})))["documents"]
            .as_array()
            .unwrap()
            .is_empty(),
        "写参考稿不得自动采纳正文"
    );
    assert_eq!(
        call(&task, "agent_operations.list", json!({}))["error"]["code"],
        "forbidden",
        "任务权限不能扩成作品管理权限"
    );
}

#[test]
fn corrupted_proposal_and_decision_records_fail_closed_without_panicking() {
    let root = tempfile::tempdir().unwrap();
    let _author = open(root.path(), true, true);
    let agent = open(root.path(), false, false);
    let before = ok(call(&agent, "novels.get", json!({})));
    let proposal = prepare(
        &agent,
        "novels.update",
        json!({"expected":{"revision":before["revision"],"sha256":before["sha256"]},"metadata":before["novel"]["metadata"],"operation_key":"metadata"}),
        "prepare",
    );
    let path = root.path().join(format!(
        ".hetu/agent-proposals/{}.json",
        proposal["proposal_id"].as_str().unwrap()
    ));
    let state_path = path.with_extension("state.json");
    let original: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    for field in ["before_files", "writes", "baseline", "review_changes"] {
        let mut corrupted = original.clone();
        corrupted["fixed"][field] = json!("broken");
        std::fs::write(&path, serde_json::to_vec(&corrupted).unwrap()).unwrap();
        assert_ne!(
            call(
                &agent,
                "agent_operations.get",
                json!({"proposal_id":proposal["proposal_id"]})
            )["status"],
            "succeeded"
        );
    }
    std::fs::write(&path, serde_json::to_vec(&original).unwrap()).unwrap();
    let state: Value = serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
    for (field, value) in [
        ("revision", json!("broken")),
        ("state", json!("executed")),
        ("state", json!("unknown")),
    ] {
        let mut corrupted = state.clone();
        corrupted[field] = value;
        std::fs::write(&state_path, serde_json::to_vec(&corrupted).unwrap()).unwrap();
        assert_ne!(execute(&agent, &proposal, field)["status"], "succeeded");
    }
    assert_eq!(ok(call(&agent, "novels.get", json!({}))), before);
}

#[test]
fn maximum_length_summary_survives_readback_and_corrupt_counter_cannot_commit() {
    let root = tempfile::tempdir().unwrap();
    let author = open(root.path(), true, true);
    let agent = open(root.path(), false, false);
    let before = ok(call(&agent, "novels.get", json!({})));
    let proposal = ok(call(
        &agent,
        "agent_operations.prepare",
        json!({"action":"hetu.novels.update","input":{"expected":{"revision":before["revision"],"sha256":before["sha256"]},"metadata":before["novel"]["metadata"],"operation_key":"metadata"},"summary":"中".repeat(2000),"operation_key":"prepare"}),
    ));
    let read = ok(call(
        &agent,
        "agent_operations.get",
        json!({"proposal_id":proposal["proposal_id"]}),
    ));
    assert_eq!(read["summary"], "中".repeat(2000));
    ok(decide(&author, &proposal, "approve", "approve"));
    let state_path = root.path().join(format!(
        ".hetu/agent-proposals/{}.state.json",
        proposal["proposal_id"].as_str().unwrap()
    ));
    let mut state: Value = serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
    state["revision"] = json!(u64::MAX);
    std::fs::write(&state_path, serde_json::to_vec(&state).unwrap()).unwrap();
    assert_ne!(execute(&agent, &proposal, "execute")["status"], "succeeded");
    assert_eq!(ok(call(&agent, "novels.get", json!({}))), before);
}

#[test]
fn original_drama_handoff_does_not_invent_a_novel_revision() {
    let root = tempfile::tempdir().unwrap();
    let author=Kernel::open(json!({"workspace_path":root.path(),"mode":"author","create":{"title":"原创剧本","locale":"zh-CN","work_type":"drama","operation_key":"create"}})).unwrap();
    let document = ok(call(
        &author,
        "documents.create",
        json!({"kind":"drama_script","title":"第一集","source_format":"fountain","content":"INT. 渡船 - NIGHT\n","operation_key":"script"}),
    ));
    let agent = open(root.path(), false, false);
    let context = ok(call(
        &agent,
        "handoffs.get",
        json!({"view_kind":"document","object_ref":{"document_id":document["document"]["document_id"],"revision_id":document["revision"]["revision_id"]}}),
    ));
    let refs = context["fixed_refs"].as_array().unwrap();
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0]["kind"], "document");
    assert_eq!(refs[0]["sha256"], document["revision"]["sha256"]);
}

#[test]
fn import_is_fixed_before_review_and_git_initialization_has_no_prepare_side_effect() {
    let root = tempfile::tempdir().unwrap();
    let author = open(root.path(), true, true);
    let agent = open(root.path(), false, false);
    let file = root.path().join("原稿.txt");
    std::fs::write(&file, "第一章 渡口\n\n潮声中有人敲门。🌧️").unwrap();
    let preview = ok(call(&author,"documents.preview_import",json!({"inline_source":inline_source("原稿.txt", &std::fs::read(&file).unwrap()),"format":"txt","profile":"hetu-novel-zh/1"})))["preview"].clone();
    let proposed = prepare(
        &agent,
        "documents.import",
        json!({"preview":preview,"kind":"novel_chapter","title":"渡口","language_tag":"zh-CN","acknowledgement":"核对原稿及格式","operation_key":"import"}),
        "prepare-import",
    );
    assert!(
        ok(call(&agent, "documents.list", json!({})))["documents"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    ok(decide(&author, &proposed, "approve", "approve-import"));
    let receipt = ok(execute(&agent, &proposed, "import-execute"));
    assert!(receipt["result"]["document"]["document_id"].is_string());
    let imported = ok(call(
        &agent,
        "documents.get",
        json!({"document_id":receipt["result"]["document"]["document_id"]}),
    ));
    assert!(imported["content"].as_str().unwrap().contains("潮声"));
    let init = prepare(
        &agent,
        "git.init",
        json!({"branch":"main","operation_key":"git-init"}),
        "prepare-init",
    );
    assert!(!root.path().join(".git").exists());
    assert_ne!(execute(&agent, &init, "unapproved")["status"], "succeeded");
    ok(decide(&author, &init, "approve", "approve-init"));
    let result = ok(execute(&agent, &init, "initialize"));
    assert_eq!(result["result"]["initialized"], true);
    assert_eq!(ok(execute(&agent, &init, "initialize")), result);
    assert_eq!(
        ok(execute(&agent, &init, "initialize-again"))["result"],
        result["result"]
    );
    assert_ne!(
        decide(&author, &init, "reject", "late")["status"],
        "succeeded"
    );
}
