use hetu_core::{Kernel, collaboration::CollaborationHub};
use serde_json::{Value, json};

fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn hub(h: &CollaborationHub, action: &str, input: Value) -> Value {
    h.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(v: Value) -> Value {
    assert_eq!(v["status"], "succeeded", "{v}");
    v["data"].clone()
}
fn note() -> Value {
    json!({"phase":"返工","working_copy_refs":[],"feedback_refs":[],"coverage":[],"statements":[],"next_actions":["继续原稿，不创建同义任务"],"pending_operations":[]})
}
fn fixture() -> (tempfile::TempDir, Kernel, CollaborationHub, Value, Value) {
    let root = tempfile::tempdir().unwrap();
    let k=Kernel::open(json!({"workspace_path":root.path().join("work"),"mode":"author","create":{"title":"接续验收","locale":"zh-CN","operation_key":"create"}})).unwrap();
    let doc = ok(call(
        &k,
        "documents.create",
        json!({"kind":"novel_chapter","title":"固定原文","source_format":"markdown","content":"河面落雨。🌿\r\n旧船驶来。","operation_key":"source"}),
    ));
    let preview = ok(call(
        &k,
        "creative_tasks.preview_prompt",
        json!({"scope_ref":{"kind":"workspace","id":k.scope()},"task_kind":"chapter_draft","brief":"依据固定原文写独立参考稿","input_refs":[{"kind":"document","document_id":doc["document"]["document_id"],"revision_id":doc["revision"]["revision_id"]}],"client_adapter":"codex","language_tag":"zh-CN"}),
    ));
    let mut prepare = preview["prepare_input"].clone();
    prepare["operation_key"] = json!("task");
    let task = ok(call(&k, "creative_tasks.prepare", prepare));
    let directory = root.path().join("connection");
    ok(call(
        &k,
        "collaboration.authorize",
        json!({"task_ref":task["task_ref"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"grant"}),
    ));
    let h = CollaborationHub::open(&directory, "codex").unwrap();
    let opened = ok(hub(
        &h,
        "collaboration.open",
        json!({"task_locator":{"scope_ref":task["task_ref"]["scope_ref"],"task_id":task["task_ref"]["task_id"]}}),
    ));
    (root, k, h, opened["task_ref"].clone(), doc)
}

#[test]
fn discovery_is_bounded_snapshot_checked_and_diagnostics_are_read_only() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("absent");
    let h = CollaborationHub::open(&dir, "codex").unwrap();
    let first = ok(hub(&h, "collaboration.inspect", json!({})));
    assert!(first.to_string().len() < 20000);
    assert_eq!(first["actions"].as_array().unwrap().len(), 25);
    assert!(
        first["actions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|a| a.get("input_schema").is_none())
    );
    let exact = ok(hub(
        &h,
        "collaboration.inspect",
        json!({"action":"hetu.task_checkpoint.save","include_schema":true}),
    ));
    assert_eq!(exact["total"], 1);
    assert!(exact["actions"][0]["input_schema"].is_object());
    assert_eq!(
        hub(
            &h,
            "collaboration.inspect",
            json!({"offset":25,"expected_catalog_sha256":"0".repeat(64)})
        )["error"]["code"],
        "hetu.stale_evidence"
    );
    let second = ok(hub(
        &h,
        "collaboration.inspect",
        json!({"offset":25,"expected_catalog_sha256":first["catalog_sha256"]}),
    ));
    assert_ne!(first["actions"][0]["name"], second["actions"][0]["name"]);
    let doctor = ok(hub(
        &h,
        "runtime.inspect",
        json!({"observed_skill_version":"old"}),
    ));
    assert_eq!(doctor["session_skill_loading"], "unknown");
    assert_eq!(doctor["checks"][2]["state"], "different");
    assert!(!dir.exists());
    let projected = ok(hub(
        &h,
        "collaboration.invoke",
        json!({"action":"hetu.runtime.inspect","input":{},"view":{"result_path":"/runtime_version"}}),
    ));
    assert_eq!(
        projected["view"]["page"]["content"],
        env!("CARGO_PKG_VERSION")
    );
    assert_eq!(projected["view"]["retained"], false);
    ok(hub(
        &h,
        "collaboration.invoke",
        json!({"action":"hetu.runtime.inspect","input":{},"view":{"result_path":"/platform"}}),
    ));
    // 运行诊断含进程级加载计数；固定快照断言使用不随并发发现变化的方法目录。
    let methods = ok(hub(&h,"collaboration.invoke",json!({"action":"hetu.methods.list",
        "input":{"query":"task-contract"},"view":{"result_path":"/bundle"}})));
    ok(hub(&h,"collaboration.invoke",json!({"action":"hetu.methods.list",
        "input":{"query":"task-contract"},"view":{"result_path":"/resources",
            "expected_result_sha256":methods["view"]["source_result_sha256"]}})));
    assert_eq!(
        hub(
            &h,
            "collaboration.invoke",
            json!({"action":"hetu.runtime.inspect","input":{},"view":{"expected_result_sha256":"0".repeat(64)}})
        )["error"]["code"],
        "hetu.stale_evidence"
    );
    assert_eq!(
        hub(
            &h,
            "collaboration.invoke",
            json!({"action":"hetu.creation_projects.create","input":{"brief":"不得写入","locale":"zh-CN","operation_key":"blocked-view"},"view":{}})
        )["error"]["code"],
        "invalid_input"
    );
    assert!(!dir.exists());
    assert_eq!(
        hub(
            &h,
            "collaboration.invoke",
            json!({"action":"hetu.collaboration.invoke","input":{}})
        )["error"]["code"],
        "invalid_input"
    );
    assert_eq!(
        hub(
            &h,
            "collaboration.invoke",
            json!({"action":"hetu.documents.save","input":{}})
        )["error"]["code"],
        "hetu.capability_unavailable"
    );
}

#[test]
fn checkpoint_reopens_replays_rejects_conflicts_and_revocation() {
    let (root, k, h, t, _) = fixture();
    assert_eq!(
        hub(
            &h,
            "operations.get",
            json!({"task_ref":t,"action":"hetu.task_checkpoint.save","key":"never-received"})
        )["error"]["code"],
        "not_found"
    );
    let input =
        json!({"task_ref":t,"expected":null,"checkpoint":note(),"operation_key":"checkpoint-v1"});
    let receipt = hub(&h, "task_checkpoint.save", input.clone());
    let saved = ok(receipt.clone());
    assert_eq!(hub(&h, "task_checkpoint.save", input.clone()), receipt);
    let reopened = CollaborationHub::open(&root.path().join("connection"), "codex").unwrap();
    assert_eq!(
        ok(hub(&reopened, "task_checkpoint.get", json!({"task_ref":t})))["expected"],
        saved["expected"]
    );
    let mut conflict = input.clone();
    conflict["operation_key"] = json!("stale");
    let denied = hub(&h, "task_checkpoint.save", conflict);
    assert_eq!(denied["error"]["code"], "revision_conflict");
    assert_eq!(
        denied["error"]["resolution"]["action"],
        "hetu.task_checkpoint.get"
    );
    let mut changed = input;
    changed["checkpoint"]["phase"] = json!("changed");
    assert_eq!(
        hub(&h, "task_checkpoint.save", changed)["error"]["code"],
        "idempotency_conflict"
    );
    let original = ok(hub(
        &h,
        "operations.get",
        json!({"task_ref":t,"operation_id":receipt["operation"]["id"],"input_digest":receipt["operation"]["input_digest"],"detail":"summary"}),
    ));
    assert_eq!(original["original_status"], "succeeded");
    ok(call(
        &k,
        "collaboration.revoke",
        json!({"task_ref":{"scope_ref":t["scope_ref"],"task_id":t["task_id"],"request_revision":t["request_revision"]},"client_adapter":"codex","collaboration_path":root.path().join("connection"),"operation_key":"revoke"}),
    ));
    assert_eq!(
        hub(&h, "task_checkpoint.get", json!({"task_ref":t}))["error"]["code"],
        "forbidden"
    );
}

#[test]
fn checkpoint_rejects_foreign_sources_invalid_utf8_and_preserves_author_text() {
    let (_root, k, h, t, doc) = fixture();
    let directory = ok(hub(&h, "task_context.list", json!({"task_ref":t})));
    let source = &directory["entries"][0]["context_ref"];
    assert!(source.is_object(), "{directory}");
    let mut checkpoint = note();
    checkpoint["coverage"] = json!([{"context_ref":source,"ranges":[{"byte_start":0,"byte_end":1}],"status":"agent_reviewed"}]);
    let mut input =
        json!({"task_ref":t,"expected":null,"checkpoint":checkpoint,"operation_key":"bad-range"});
    assert_eq!(
        hub(&h, "task_checkpoint.save", input.clone())["error"]["code"],
        "invalid_input"
    );
    input["checkpoint"]["coverage"][0]["ranges"][0]["byte_end"] = json!(15);
    input["operation_key"] = json!("valid-range");
    ok(hub(&h, "task_checkpoint.save", input.clone()));
    input["checkpoint"]["coverage"][0]["context_ref"]["sha256"] = json!("0".repeat(64));
    input["operation_key"] = json!("bad-source");
    input["expected"] =
        ok(hub(&h, "task_checkpoint.get", json!({"task_ref":t})))["expected"].clone();
    assert_eq!(
        hub(&h, "task_checkpoint.save", input)["error"]["code"],
        "forbidden"
    );
    let read = ok(call(
        &k,
        "documents.get",
        json!({"document_id":doc["document"]["document_id"]}),
    ));
    assert_eq!(
        read["revision"]["revision_id"],
        doc["revision"]["revision_id"]
    );
}

#[test]
fn fixed_working_copy_and_operation_pages_reassemble_unicode_after_new_revision() {
    let (_root, _k, h, t, _) = fixture();
    let text = "雨🌿\r\n".repeat(5000);
    let input = json!({"task_ref":t,"artifact_kind":"text","source_format":"markdown","title":"长参考稿","base_refs":[],"content":text,"operation_key":"long-copy"});
    let receipt = hub(&h, "working_copies.create", input);
    let first = ok(receipt.clone());
    let second = ok(hub(
        &h,
        "working_copies.save",
        json!({"task_ref":t,"working_copy_id":first["working_copy_ref"]["working_copy_id"],"expected":first["working_copy_ref"],"content":"新版","feedback_refs":[],"operation_key":"second"}),
    ));
    assert_ne!(first["working_copy_ref"], second["working_copy_ref"]);
    let mut range = json!({"byte_start":0,"byte_end":text.len()});
    let mut restored = String::new();
    loop {
        let read = ok(hub(
            &h,
            "working_copies.get",
            json!({"task_ref":t,"working_copy_ref":first["working_copy_ref"],"range":range,"max_bytes":4096}),
        ));
        let page = &read["content_page"];
        restored.push_str(page["content"].as_str().unwrap());
        if page["next_range"].is_null() {
            break;
        }
        range = page["next_range"].clone();
    }
    assert_eq!(restored, text);
    let page = ok(hub(
        &h,
        "operations.get",
        json!({"task_ref":t,"operation_id":receipt["operation"]["id"],"input_digest":receipt["operation"]["input_digest"],"result_path":"/data/working_copy/title","max_bytes":256}),
    ));
    assert_eq!(page["page"]["content"], "长参考稿");
    assert!(page["page"]["complete"].as_bool().unwrap());
    let submitted_receipt = hub(
        &h,
        "creative_tasks.submit_result",
        json!({"task_ref":t,"request_sha256":t["sha256"],
        "working_copy_refs":[first["working_copy_ref"]],"feedback_refs":[],"complete":true,"missing_items":[],
        "provenance":{"client":"machine-test","skill_version":"1"},"operation_key":"fixed-submit"}),
    );
    let submitted = ok(submitted_receipt.clone());
    let candidate = &submitted["candidate_refs"][0];
    assert_eq!(candidate["task_ref"], t);
    let part = ok(hub(
        &h,
        "creative_tasks.read_candidate",
        json!({"task_ref":t,"candidate_ref":candidate,"max_bytes":256}),
    ));
    assert!(text.starts_with(part["page"]["content"].as_str().unwrap()));
    assert_eq!(part["candidate_ref"], *candidate);
    let replay = ok(hub(
        &h,
        "operations.get",
        json!({"task_ref":t,"operation_id":submitted_receipt["operation"]["id"]}),
    ));
    assert_eq!(
        replay["original_result"]["data"]["candidate_refs"][0],
        *candidate
    );
}

#[test]
fn closed_task_rejects_checkpoint_writes_and_tampering_cannot_replace_history() {
    let (root, k, h, t, _) = fixture();
    let input = json!({"task_ref":t,"expected":null,"checkpoint":note(),"operation_key":"first-checkpoint"});
    ok(hub(&h, "task_checkpoint.save", input));
    let path = root
        .path()
        .join("work/.hetu/tasks")
        .join(t["task_id"].as_str().unwrap())
        .join("checkpoints/1.json");
    let original = std::fs::read(&path).unwrap();
    let mut changed: Value = serde_json::from_slice(&original).unwrap();
    changed["checkpoint"]["phase"] = json!("外部改写");
    std::fs::write(&path, serde_json::to_vec(&changed).unwrap()).unwrap();
    assert_eq!(
        hub(&h, "task_checkpoint.get", json!({"task_ref":t}))["error"]["code"],
        "hetu.integrity_failure"
    );
    std::fs::write(&path, original).unwrap();
    let mut legacy = t.clone();
    legacy.as_object_mut().unwrap().remove("sha256");
    let current = ok(call(&k, "creative_tasks.get", json!({"task_ref":legacy})));
    ok(call(
        &k,
        "creative_tasks.close",
        json!({"task_ref":legacy,"expected":current["expected"],"reason":"测试关闭","operation_key":"close"}),
    ));
    assert_eq!(
        hub(
            &h,
            "task_checkpoint.save",
            json!({"task_ref":t,"expected":null,"checkpoint":note(),"operation_key":"after-close"})
        )["error"]["code"],
        "forbidden"
    );
}

#[test]
fn evidence_notes_keep_fixed_references_hypotheses_and_handoff_after_reopen() {
    let (root, k, h, t, doc) = fixture();
    let source =
        ok(hub(&h, "task_context.list", json!({"task_ref":t})))["entries"][0]["context_ref"]
            .clone();
    let first = ok(hub(
        &h,
        "working_copies.create",
        json!({"task_ref":t,"artifact_kind":"text",
        "source_format":"markdown","title":"证据初稿","base_refs":[],"content":"旧船驶来。",
        "operation_key":"evidence-draft"}),
    ));
    let feedback = ok(hub(
        &h,
        "task_feedback.save",
        json!({"task_ref":t,
        "target_refs":[{"kind":"working_copy","working_copy_ref":first["working_copy_ref"]}],
        "expected_feedback_head":null,"intent":"request_changes","public_comment":"Agent自查：新版保留旧船。",
        "selected_refs":[],"operation_key":"evidence-feedback"}),
    ));
    let mut checkpoint = note();
    checkpoint["steps"] = json!([{"title":"核对旧稿与公开意见","status":"done"},
        {"title":"验证返工稿保留旧船","status":"doing"}]);
    checkpoint["statements"] = json!([
        {"kind":"observation","text":"固定原文中有旧船。","context_refs":[source]},
        {"kind":"derivation","text":"已保存工作稿含5个Unicode字符。","context_refs":[],
            "working_copy_refs":[first["working_copy_ref"]]},
        {"kind":"hypothesis","text":"返工可以保留旧船意象。","prediction":"新版仍含旧船。",
            "status":"testing","context_refs":[],"feedback_refs":[feedback["feedback_ref"]]}
    ]);
    checkpoint["handoff"] = json!({"summary":"已读初稿和Agent自查，尚未提交。",
        "pitfalls":["反馈来自Agent自查，不能称为作者或读者意见。"]});
    let input = json!({"task_ref":t,"expected":null,"checkpoint":checkpoint,"operation_key":"evidence-checkpoint"});
    let saved = ok(hub(&h, "task_checkpoint.save", input.clone()));
    assert_eq!(ok(hub(&h, "task_checkpoint.save", input)), saved);
    let second = ok(hub(
        &h,
        "working_copies.save",
        json!({"task_ref":t,
        "working_copy_id":first["working_copy_ref"]["working_copy_id"],"expected":first["working_copy_ref"],
        "content":"雨中旧船驶来。","feedback_refs":[feedback["feedback_ref"]],"operation_key":"evidence-revise"}),
    ));
    checkpoint["statements"][2]["status"] = json!("supported");
    checkpoint["statements"][2]["working_copy_refs"] = json!([second["working_copy_ref"]]);
    checkpoint["steps"][1]["status"] = json!("done");
    checkpoint["handoff"]["summary"] = json!("新稿保留旧船并核对预测，尚未提交或采用。");
    let updated = ok(hub(
        &h,
        "task_checkpoint.save",
        json!({"task_ref":t,"expected":saved["expected"],
        "checkpoint":checkpoint,"operation_key":"evidence-supported"}),
    ));
    let reopened = CollaborationHub::open(&root.path().join("connection"), "codex").unwrap();
    let loaded = ok(hub(&reopened, "task_checkpoint.get", json!({"task_ref":t})));
    assert_eq!(loaded["checkpoint"], checkpoint);
    assert_eq!(loaded["expected"], updated["expected"]);
    assert_eq!(loaded["authority"], "agent_notes");
    assert_eq!(
        loaded["checkpoint"]["statements"][1]["working_copy_refs"][0],
        first["working_copy_ref"]
    );
    let author = ok(call(
        &k,
        "documents.get",
        json!({"document_id":doc["document"]["document_id"]}),
    ));
    assert_eq!(author["revision"], doc["revision"]);
}

#[test]
fn evidence_notes_reject_unbacked_claims_forged_references_and_incomplete_hypotheses() {
    let (_root, _k, h, t, _) = fixture();
    let draft = ok(hub(
        &h,
        "working_copies.create",
        json!({"task_ref":t,"artifact_kind":"text",
        "source_format":"markdown","title":"固定参考","base_refs":[],"content":"河面落雨。",
        "operation_key":"valid-evidence"}),
    ));
    let (_other_root, _other_k, other_hub, other_t, _) = fixture();
    let foreign = ok(hub(
        &other_hub,
        "working_copies.create",
        json!({"task_ref":other_t,
        "artifact_kind":"text","source_format":"markdown","title":"其他任务","base_refs":[],
        "content":"不可借用。","operation_key":"foreign-evidence"}),
    ));
    let feedback = ok(hub(
        &other_hub,
        "task_feedback.save",
        json!({"task_ref":other_t,
        "target_refs":[{"kind":"working_copy","working_copy_ref":foreign["working_copy_ref"]}],
        "expected_feedback_head":null,"intent":"request_changes","public_comment":"其他任务的公开意见。",
        "selected_refs":[],"operation_key":"foreign-feedback"}),
    ));
    let mut forged = draft["working_copy_ref"].clone();
    forged["sha256"] = json!("0".repeat(64));
    let cases = [
        json!({"kind":"observation","text":"没有依据的观察","context_refs":[]}),
        json!({"kind":"derivation","text":"没有依据的计算","context_refs":[]}),
        json!({"kind":"hypothesis","text":"缺预测","status":"testing","context_refs":[]}),
        json!({"kind":"hypothesis","text":"缺状态","prediction":"待检验","context_refs":[]}),
        json!({"kind":"hypothesis","text":"无依据支持","prediction":"待检验","status":"supported","context_refs":[]}),
        json!({"kind":"hypothesis","text":"无依据反驳","prediction":"待检验","status":"refuted","context_refs":[]}),
        json!({"kind":"proposal","text":"不能携带假设状态","status":"supported","context_refs":[]}),
        json!({"kind":"observation","text":"摘要伪造","context_refs":[],"working_copy_refs":[forged]}),
        json!({"kind":"observation","text":"跨任务工作稿","context_refs":[],"working_copy_refs":[foreign["working_copy_ref"]]}),
        json!({"kind":"observation","text":"跨任务反馈","context_refs":[],"feedback_refs":[feedback["feedback_ref"]]}),
    ];
    for (index, statement) in cases.into_iter().enumerate() {
        let mut checkpoint = note();
        checkpoint["statements"] = json!([statement]);
        let result = hub(
            &h,
            "task_checkpoint.save",
            json!({"task_ref":t,"expected":null,
            "checkpoint":checkpoint,"operation_key":format!("deny-{index}")}),
        );
        assert_ne!(result["status"], "succeeded", "case {index}: {result}");
        assert!(ok(hub(&h, "task_checkpoint.get", json!({"task_ref":t})))["expected"].is_null());
    }
    let mut checkpoint = note();
    checkpoint["statements"] = json!([
        {"kind":"hypothesis","text":"待核验的方向","prediction":"需要新稿","status":"testing","context_refs":[]},
        {"kind":"hypothesis","text":"放弃的方向","prediction":"已不再检验","status":"abandoned","context_refs":[]},
        {"kind":"hypothesis","text":"原稿没有晴天","prediction":"检索有晴天","status":"refuted",
            "context_refs":[],"working_copy_refs":[draft["working_copy_ref"]]}
    ]);
    ok(hub(
        &h,
        "task_checkpoint.save",
        json!({"task_ref":t,"expected":null,
        "checkpoint":checkpoint,"operation_key":"valid-testing-abandoned-refuted"}),
    ));
}

#[test]
fn execution_history_reopens_replays_and_recovers_without_recording_creative_content() {
    let (root, _, h, t, _) = fixture();
    let input = json!({"task_ref":t,"artifact_kind":"text","source_format":"markdown",
        "title":"私密测试标题不应入执行记录","content":"私密测试正文不应入执行记录","base_refs":[],"operation_key":"execution-copy"});
    let first = hub(&h, "working_copies.create", input.clone());
    ok(first.clone());
    assert_eq!(hub(&h, "working_copies.create", input), first);
    let source =
        ok(hub(&h, "task_context.list", json!({"task_ref":t})))["entries"][0]["context_ref"]
            .clone();
    assert_eq!(
        hub(
            &h,
            "task_context.read",
            json!({"task_ref":t,"context_ref":source,
        "range":{"byte_start":1,"byte_end":3},"max_bytes":1024})
        )["error"]["code"],
        "hetu.invalid_source_ref"
    );
    let cancelled = h.request_cancellable(
        json!({"action":"hetu.working_copies.create","contract_revision":"1",
        "input":{"task_ref":t,"artifact_kind":"text","source_format":"markdown","title":"取消",
            "content":"取消后不得写入","base_refs":[],"operation_key":"execution-cancelled"}}),
        &|| true,
    );
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(
        ok(hub(&h, "working_copies.list", json!({"task_ref":t})))["working_copies"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let reopened = CollaborationHub::open(&root.path().join("connection"), "codex").unwrap();
    let mut query =
        json!({"task_ref":t,"action":"hetu.working_copies.create","status":"succeeded","limit":1});
    let mut attempts = Vec::new();
    loop {
        let page = ok(hub(&reopened, "task_executions.list", query.clone()));
        attempts.extend(page["executions"].as_array().unwrap().iter().cloned());
        if page["next_cursor"].is_null() {
            break;
        }
        query["cursor"] = page["next_cursor"].clone();
    }
    assert_eq!(attempts.len(), 2);
    assert_ne!(attempts[0]["attempt_ref"], attempts[1]["attempt_ref"]);
    let fixed = ok(hub(
        &reopened,
        "task_executions.get",
        json!({"task_ref":t,"attempt_ref":attempts[0]["attempt_ref"]}),
    ));
    let recovery = &fixed["execution"]["recovery"];
    assert_eq!(recovery["input"]["task_ref"], t);
    let original = ok(reopened.request(
        json!({"action":recovery["action"],"contract_revision":"1","input":recovery["input"]}),
    ));
    assert_eq!(
        original["original_result"]["data"]["working_copy_ref"],
        first["data"]["working_copy_ref"]
    );
    for (status, action, code) in [
        ("cancelled", "hetu.working_copies.create", "cancelled"),
        (
            "blocked",
            "hetu.task_context.read",
            "hetu.invalid_source_ref",
        ),
    ] {
        let found = ok(hub(
            &reopened,
            "task_executions.list",
            json!({"task_ref":t,"status":status,"action":action}),
        ));
        assert_eq!(found["executions"].as_array().unwrap().len(), 1);
        assert_eq!(found["executions"][0]["error_code"], code);
    }
    let mut folders = vec![root.path().join("work/.hetu/audit/task-executions")];
    while let Some(folder) = folders.pop() {
        for entry in std::fs::read_dir(folder).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                folders.push(path);
            } else {
                let stored = std::fs::read_to_string(path).unwrap();
                assert!(!stored.contains("私密测试") && !stored.contains("取消后不得写入"));
                assert!(!stored.contains("execution-copy"));
            }
        }
    }
}

#[test]
fn execution_history_refuses_foreign_references_changed_queries_and_revoked_grants() {
    let (root, k, h, t, _) = fixture();
    ok(hub(&h, "task_checkpoint.get", json!({"task_ref":t})));
    ok(hub(&h, "task_checkpoint.get", json!({"task_ref":t})));
    let page = ok(hub(
        &h,
        "task_executions.list",
        json!({"task_ref":t,"limit":1}),
    ));
    let reference = &page["executions"][0]["attempt_ref"];
    let mut forged = reference.clone();
    forged["sha256"] = json!("0".repeat(64));
    assert_eq!(
        hub(
            &h,
            "task_executions.get",
            json!({"task_ref":t,"attempt_ref":forged})
        )["error"]["code"],
        "hetu.stale_evidence"
    );
    assert_eq!(
        hub(
            &h,
            "task_executions.list",
            json!({"task_ref":t,"status":"failed","cursor":page["next_cursor"]})
        )["error"]["code"],
        "cursor_invalid"
    );
    let (_other_root, _, other, other_t, _) = fixture();
    assert_ne!(
        hub(
            &other,
            "task_executions.get",
            json!({"task_ref":other_t,"attempt_ref":reference})
        )["status"],
        "succeeded"
    );
    ok(call(
        &k,
        "collaboration.revoke",
        json!({"task_ref":{"scope_ref":t["scope_ref"],"task_id":t["task_id"],"request_revision":1},
        "client_adapter":"codex","collaboration_path":root.path().join("connection"),"operation_key":"revoke-executions"}),
    ));
    assert_eq!(
        hub(&h, "task_executions.list", json!({"task_ref":t}))["error"]["code"],
        "forbidden"
    );
}

#[test]
fn rejected_schema_is_recorded_only_for_a_verified_task() {
    let (_root, _, h, t, _) = fixture();
    let bad = json!({"task_ref":t,"unexpected":"不可写入日志的私密字段"});
    assert_eq!(
        hub(&h, "task_checkpoint.get", bad.clone())["error"]["code"],
        "invalid_input"
    );
    let rows = ok(hub(
        &h,
        "task_executions.list",
        json!({"task_ref":t,"action":"hetu.task_checkpoint.get"}),
    ));
    assert_eq!(rows["executions"].as_array().unwrap().len(), 1);
    assert_eq!(rows["executions"][0]["error_code"], "invalid_input");
    let mut forged = bad;
    forged["task_ref"]["sha256"] = json!("0".repeat(64));
    hub(&h, "task_checkpoint.get", forged);
    assert_eq!(
        ok(hub(
            &h,
            "task_executions.list",
            json!({"task_ref":t,"action":"hetu.task_checkpoint.get"})
        ))["executions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn stable_statements_preserve_opposing_evidence_and_issue_lifecycle() {
    let (_root, _, h, t, _) = fixture();
    let sources = ok(hub(&h, "task_context.list", json!({"task_ref":t})));
    let source = sources["entries"][0]["context_ref"].clone();
    let identifier = "statement_11111111-1111-4111-8111-111111111111";
    let mut checkpoint = note();
    checkpoint["statements"] = json!([{"statement_id":identifier,"kind":"hypothesis","text":"雨势影响行动",
        "prediction":"人物会暂缓离港","status":"testing","context_refs":[],"supporting":[{"kind":"context","reference":source}],"contradicting":[]}]);
    checkpoint["issues"] = json!([{"issue_id":"issue_11111111-1111-4111-8111-111111111111","text":"核对行动",
        "scope":"task","status":"open","statement_ids":[identifier],"resolution":[]}]);
    let saved = ok(hub(
        &h,
        "task_checkpoint.save",
        json!({"task_ref":t,"expected":null,"checkpoint":checkpoint,"operation_key":"stable-start"}),
    ));
    let mut dropped = note();
    assert_eq!(
        hub(
            &h,
            "task_checkpoint.save",
            json!({"task_ref":t,"expected":saved["expected"],"checkpoint":dropped,"operation_key":"stable-drop"})
        )["error"]["code"],
        "hetu.stale_schema"
    );
    dropped = checkpoint.clone();
    dropped["issues"][0]["status"] = json!("resolved");
    assert_eq!(
        hub(
            &h,
            "task_checkpoint.save",
            json!({"task_ref":t,"expected":saved["expected"],"checkpoint":dropped,"operation_key":"stable-empty-resolution"})
        )["error"]["code"],
        "invalid_input"
    );
    let mut opposed = checkpoint.clone();
    opposed["statements"][0]["contradicting"] = opposed["statements"][0]["supporting"].clone();
    assert_eq!(
        hub(
            &h,
            "task_checkpoint.save",
            json!({"task_ref":t,"expected":saved["expected"],"checkpoint":opposed,"operation_key":"stable-opposed"})
        )["error"]["code"],
        "invalid_input"
    );
    checkpoint["statements"][0]["status"] = json!("supported");
    checkpoint["issues"][0]["status"] = json!("resolved");
    checkpoint["issues"][0]["resolution"] = json!([{"kind":"context","reference":source}]);
    ok(hub(
        &h,
        "task_checkpoint.save",
        json!({"task_ref":t,"expected":saved["expected"],"checkpoint":checkpoint,"operation_key":"stable-resolution"}),
    ));
    assert_eq!(
        ok(hub(&h, "task_checkpoint.get", json!({"task_ref":t})))["checkpoint"],
        checkpoint
    );
}

#[test]
fn assessment_separates_delivery_agent_claims_and_author_decisions() {
    let (_root, k, h, t, document) = fixture();
    let empty = ok(hub(&h, "creative_tasks.assess", json!({"task_ref":t})));
    assert_eq!(empty["delivery"]["status"], "missing");
    assert!(empty.get("executions").is_none() && empty.get("candidate_refs").is_none());
    assert_eq!(empty["professional"]["status"], "no_checks");
    assert_eq!(empty["author_decision"]["status"], "awaiting_author");
    let working = ok(hub(
        &h,
        "working_copies.create",
        json!({"task_ref":t,"artifact_kind":"text","source_format":"markdown",
        "title":"评估稿","content":"独立参考候选。","base_refs":[],"operation_key":"assessment-copy"}),
    ));
    let task = ok(hub(
        &h,
        "creative_tasks.get",
        json!({"task_ref":t,"detail":"summary"}),
    ));
    let submission = ok(hub(
        &h,
        "creative_tasks.submit_result",
        json!({"task_ref":t,"request_sha256":task["request_sha256"],
        "working_copy_refs":[working["working_copy_ref"]],"complete":true,"missing_items":[],
        "provenance":{"client":"acceptance","skill_version":"test","model":"fixture"},"operation_key":"assessment-deliver"}),
    ));
    let assessed = ok(hub(
        &h,
        "creative_tasks.assess",
        json!({"task_ref":t,"candidate_refs":submission["candidate_refs"]}),
    ));
    assert_eq!(assessed["delivery"]["status"], "fixed_candidates_verified");
    assert_eq!(assessed["delivery"]["agent_reported_complete"], true);
    assert_eq!(assessed["professional"]["status"], "no_checks");
    assert_eq!(assessed["completion"], "requires_layer_review");
    assert_eq!(assessed["author_decision"]["status"], "awaiting_author");
    let reopened = ok(hub(&h,"collaboration.open",json!({"task_locator":{
        "scope_ref":t["scope_ref"],"task_id":t["task_id"]}})));
    assert_eq!(reopened["candidate_refs"][0]["task_ref"],t);
    ok(call(&k,"documents.save",json!({"document_id":document["document"]["document_id"],
        "base_revision_id":document["revision"]["revision_id"],"source_format":"markdown","content":"作者的新原文。","operation_key":"assessment-target-advance"})));
    let stale=ok(hub(&h,"creative_tasks.assess",json!({"task_ref":t})));
    assert_eq!(stale["delivery"]["target"]["status"],"stale_target");
}

#[test]
fn creation_assessment_uses_exact_task_reference_with_management_authorization() {
    let root = tempfile::tempdir().unwrap();
    let h = CollaborationHub::open(&root.path().join("connection"), "codex").unwrap();
    let project = ok(hub(&h, "creation_projects.create", json!({
        "brief":"整理新作品资料","locale":"zh-CN","operation_key":"assessment-project"})));
    let management = &project["management_ref"];
    let preview = ok(hub(&h, "creative_tasks.preview_prompt", json!({
        "management_ref":management,"scope_ref":management["scope_ref"],"task_kind":"book_profile",
        "brief":"准备三个书名","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN"})));
    let mut prepare = preview["prepare_input"].clone();
    prepare["management_ref"] = management.clone();
    prepare["operation_key"] = json!("assessment-project-task");
    let prepared = ok(hub(&h, "creative_tasks.prepare", prepare));
    let opened = ok(hub(&h, "collaboration.open", json!({"task_locator":prepared["task_locator"]})));
    let exact = &opened["task_ref"];
    let result = ok(hub(&h, "creative_tasks.assess", json!({"management_ref":management,"task_ref":exact})));
    assert_eq!(result["task_ref"], *exact);
    assert_eq!(result["delivery"]["status"], "missing");
    let mut stale = exact.clone();
    stale["sha256"] = json!("0".repeat(64));
    assert_eq!(hub(&h,"creative_tasks.assess",json!({"management_ref":management,"task_ref":stale}))["error"]["code"],"hetu.stale_request");
}

#[test]
fn professional_reports_bind_candidate_sources_and_task_authorization() {
    use hetu_core::application::extensions::PluginSession;
    let (root, k, h, t, doc) = fixture();
    let work = ok(call(&k, "works.list", json!({})))["works"][0]["work_ref"].clone();
    let working = ok(hub(
        &h,
        "working_copies.create",
        json!({"task_ref":t,"artifact_kind":"text","source_format":"markdown",
        "title":"专业检查目标","content":"港口仍在落雨。","base_refs":[],"operation_key":"professional-copy"}),
    ));
    let task = ok(hub(
        &h,
        "creative_tasks.get",
        json!({"task_ref":t,"detail":"summary"}),
    ));
    ok(hub(
        &h,
        "creative_tasks.submit_result",
        json!({"task_ref":t,"request_sha256":task["request_sha256"],
        "working_copy_refs":[working["working_copy_ref"]],"complete":true,"missing_items":[],
        "provenance":{"client":"test","skill_version":"test"},"operation_key":"professional-deliver"}),
    ));
    let legacy = json!({"scope_ref":t["scope_ref"],"task_id":t["task_id"],"request_revision":1});
    let assessment = ok(call(
        &k,
        "creative_tasks.assess",
        json!({"task_ref":legacy}),
    ));
    let mut source = assessment["delivery"]["candidates"][0]["evidence_source"].clone();
    source["work_ref"] = work.clone();
    let private = root.path().join("professional-access");
    let grant=ok(k.extension_host_request_in(&private,json!({"method":"authorize","params":{"work_ref":work,
        "plugin_id":"org.wordflowlab.novel-review","package_sha256":"a".repeat(64),"permissions":["objects.read","objects.write","work.read"],
        "types":[{"kind":"novel_review","schema_version":"1.0.0","schema":{"type":"object"}}],"operation_key":"professional-grant"}})));
    let session = PluginSession::open(
        &root.path().join("work"),
        &private,
        grant["grant_id"].as_str().unwrap(),
        &"a".repeat(64),
    )
    .unwrap();
    let domains = [
        "continuity",
        "characters",
        "promises",
        "pacing",
        "prose",
        "canon",
    ];
    let checks=domains.iter().map(|domain|json!({"id":domain,"domain":domain,"status":"pass","source_indices":[0],"summary":"固定检查声明"})).collect::<Vec<_>>();
    let mut content = json!({"format_version":1,"title":"检查夹具","framework_version":"1","scope_indices":[0],"checks":checks,"issues":[]});
    let save = |content: Value, sources: Value, key: &str| {
        let record=ok(session.request(json!({"action":"hetu.extensions.objects.save","contract_revision":"1","input":{
            "work_ref":work,"kind":"novel_review","title":"检查夹具","schema_version":"1.0.0","content":content,
            "source_refs":sources,"expected_revision":0,"expected_sha256":"","operation_key":key}})));
        json!({"kind":"plugin_object","work_ref":work,"owner_plugin_id":"org.wordflowlab.novel-review",
            "object_id":record["object"]["object_id"],"revision":record["object"]["revision"],"sha256":record["sha256"]})
    };
    let fixed = save(content.clone(), json!([source]), "professional-all");
    let managed_directory=root.path().join("assessment-management");
    let managed=ok(call(&k,"collaboration.authorize_workspace",json!({"work_ref":work,"client_adapter":"codex",
        "collaboration_path":managed_directory,"operation_key":"assessment-management"})));
    let managed_hub=CollaborationHub::open(&managed_directory,"codex").unwrap();
    let mut stale = t.clone();
    stale["sha256"] = json!("0".repeat(64));
    assert_eq!(hub(&managed_hub,"creative_tasks.assess",json!({"management_ref":managed["management_ref"],
        "task_ref":stale,"professional_refs":[fixed]}))["error"]["code"],"hetu.stale_request");
    assert_eq!(hub(&managed_hub,"creative_tasks.assess",json!({"management_ref":managed["management_ref"],
        "task_ref":legacy,"professional_refs":[fixed]}))["error"]["code"],"invalid_input");
    for (status, reference) in [
        ("reported_pass", fixed.clone()),
        ("partial", {
            content["checks"][0]["status"] = json!("unchecked");
            save(content.clone(), json!([source]), "professional-partial")
        }),
        ("findings", {
            content["checks"][0]["status"] = json!("finding");
            save(content.clone(), json!([source]), "professional-finding")
        }),
        (
            "wrong_target",
            save(
                content.clone(),
                json!([{"kind":"document","work_ref":work,"document_id":doc["document"]["document_id"],
            "revision_id":doc["revision"]["revision_id"],"sha256":doc["revision"]["sha256"]}]),
                "professional-old-target",
            ),
        ),
    ] {
        let report = ok(call(
            &k,
            "creative_tasks.assess",
            json!({"task_ref":legacy,"professional_refs":[reference]}),
        ));
        assert_eq!(
            report["professional"]["reports"][0]["candidate_coverage"][0]["status"], status,
            "{report}"
        );
        let managed_report=ok(hub(&managed_hub,"creative_tasks.assess",json!({"management_ref":managed["management_ref"],
            "task_ref":t,"professional_refs":[reference]})));
        let mut professional = report["professional"].clone();
        for coverage in professional["reports"][0]["candidate_coverage"].as_array_mut().unwrap() {
            coverage["candidate_ref"]["task_ref"] = t.clone();
        }
        assert_eq!(managed_report["professional"],professional);
        assert_eq!(managed_report["task_ref"],t);
        assert_eq!(managed_report["delivery"]["candidates"][0]["candidate_ref"]["task_ref"],t);
        assert_eq!(
            hub(
                &h,
                "creative_tasks.assess",
                json!({"task_ref":t,"professional_refs":[reference]})
            )["error"]["code"],
            "forbidden"
        );
    }
    content["issues"] = json!([{"id":"owner-issue-1","title":"保留原问题","domain":"continuity","severity":"suggestion",
        "description":"固定候选的问题夹具","evidence":[{"source_index":0,"byte_start":0,"byte_end":3,"quote":"港"}],
        "disposition":"open","candidate_source_index":null,"resolution":"","resolution_source_indices":[]}]);
    let fixed = save(content, json!([source]), "professional-open-issue");
    let open=ok(hub(&managed_hub,"creative_tasks.assess",json!({"management_ref":managed["management_ref"],"task_ref":t,"professional_refs":[fixed]})));
    assert_eq!(open["professional"]["reports"][0]["candidate_coverage"][0]["counterevidence"][0]["id"],"owner-issue-1");
    let preview = ok(call(
        &k,
        "creative_tasks.preview_prompt",
        json!({"work_ref":work,"scope_ref":legacy["scope_ref"],
        "task_kind":"book_profile","brief":"固定专业检查，接续原Owner问题","input_refs":[fixed],"client_adapter":"codex","language_tag":"zh-CN"}),
    ));
    let mut prepare = preview["prepare_input"].clone();
    prepare["operation_key"] = json!("professional-context");
    let prepared = ok(call(&k, "creative_tasks.prepare", prepare));
    ok(call(
        &k,
        "collaboration.authorize",
        json!({"task_ref":prepared["task_ref"],"client_adapter":"codex",
        "collaboration_path":root.path().join("connection"),"operation_key":"professional-context-grant"}),
    ));
    let exact=ok(hub(&h,"collaboration.open",json!({"task_locator":{"scope_ref":prepared["task_ref"]["scope_ref"],"task_id":prepared["task_ref"]["task_id"]}})))["task_ref"].clone();
    let context =
        ok(hub(&h, "task_context.list", json!({"task_ref":exact})))["entries"][0]["context_ref"]
            .clone();
    ok(hub(
        &h,
        "task_context.read",
        json!({"task_ref":exact,"context_ref":context,"result_path":"/content/title","max_bytes":1024}),
    ));
    let mut note = note();
    note["issues"] = json!([{"issue_id":"issue_22222222-2222-4222-8222-222222222222","text":"在原审校项目继续",
        "scope":"professional","status":"referred","statement_ids":[],"resolution":[],"owner_context_ref":context,"owner_item_id":"owner-issue-1"}]);
    let mut foreign = note.clone();
    foreign["issues"][0]["owner_item_id"] = json!("other-issue");
    assert_eq!(
        hub(
            &h,
            "task_checkpoint.save",
            json!({"task_ref":exact,"expected":null,"checkpoint":foreign,"operation_key":"professional-foreign-issue"})
        )["error"]["code"],
        "not_found"
    );
    ok(hub(
        &h,
        "task_checkpoint.save",
        json!({"task_ref":exact,"expected":null,"checkpoint":note,"operation_key":"professional-issue"}),
    ));
}
