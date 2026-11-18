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
    let digest = &projected["view"]["source_result_sha256"];
    assert_eq!(
        projected["view"]["page"]["content"],
        env!("CARGO_PKG_VERSION")
    );
    assert_eq!(projected["view"]["retained"], false);
    ok(hub(
        &h,
        "collaboration.invoke",
        json!({"action":"hetu.runtime.inspect","input":{},"view":{"result_path":"/platform","expected_result_sha256":digest}}),
    ));
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
