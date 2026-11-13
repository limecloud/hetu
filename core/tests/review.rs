use hetu_core::Kernel;
use serde_json::{Value, json};

fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":if action == "reviews.decide" {"2"} else {"1"},"input":input}))
}
fn data(v: Value) -> Value {
    assert!(
        matches!(v["status"].as_str(), Some("succeeded" | "partial")),
        "{v}"
    );
    v["data"].clone()
}
fn setup() -> (tempfile::TempDir, Kernel) {
    let root = tempfile::tempdir().unwrap();
    let k=Kernel::open(json!({"workspace_path":root.path(),"mode":"author","create":{"title":"审核作品","locale":"zh-CN","operation_key":"init"}})).unwrap();
    (root, k)
}
fn draft(k: &Kernel, key: &str) -> Value {
    data(call(k,"drafts.submit",json!({"package":"novel","source_format":"markdown","title":"雾港第一章","content":"# 灯塔\n\n林舟推开门。🌿\n","blueprint_revision":1,"operation_key":key})))["draft"].clone()
}
fn begin(k: &Kernel, d: &Value, key: &str) -> Value {
    data(call(k,"reviews.begin",json!({"draft_id":d["draft_id"],"expected_draft_revision":d["revision"],"operation_key":key})))["draft"].clone()
}
fn get(k: &Kernel, d: &Value) -> Value {
    data(call(k, "reviews.get", json!({"draft_id":d["draft_id"]})))
}
fn validate(k: &Kernel, d: &Value, key: &str) -> Value {
    data(call(
        k,
        "reviews.validate",
        json!({"draft_id":d["draft_id"],"expected_draft_revision":d["revision"],"plot_options":{},"validation_options":{},"operation_key":key}),
    ))
}
fn decision(context: &Value, decision: &str, key: &str) -> Value {
    json!({"draft_id":context["draft"]["draft_id"],"expected_draft_revision":context["draft"]["revision"],"input_snapshot":context["input_snapshot"],"report_refs":if decision=="approved" {context["reports"].as_array().unwrap().iter().take(1).map(|r|r["reference"].clone()).collect::<Vec<_>>()}else{vec![]},"decision":decision,"comments":"作者已核对原文与诊断。","private_comments":"私密：角色下一章的结局。","coverage_acknowledgement":"作者已人工核对未确认的人物和语境。","operation_key":key})
}

#[test]
fn approval_is_atomic_and_replays_before_state_cas_with_immutable_history() {
    let (root, k) = setup();
    let d = draft(&k, "draft");
    assert!(
        data(call(&k, "documents.list", json!({})))["documents"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let source = data(call(
        &k,
        "documents.get",
        json!({"document_id":d["evidence_document_id"]}),
    ));
    assert_eq!(source["content"], "# 灯塔\n\n林舟推开门。🌿\n");
    assert_eq!(
        call(
            &k,
            "documents.save",
            json!({"document_id":d["evidence_document_id"],"base_revision_id":d["evidence_revision_id"],"content":"越权改写","source_format":"markdown","operation_key":"source-write"})
        )["error"]["code"],
        "forbidden"
    );
    let d = begin(&k, &d, "begin");
    validate(&k, &d, "validate");
    let view = get(&k, &d);
    let input = decision(&view, "approved", "approve");
    let result = call(&k, "reviews.decide", input.clone());
    let approved = data(result.clone());
    assert_eq!(approved["draft"]["state"], "approved");
    assert_eq!(call(&k, "reviews.decide", input.clone()), result);
    assert!(approved.get("approval_target").is_none());
    assert!(data(call(&k, "documents.list", json!({})))["documents"].as_array().unwrap().is_empty());
    let after = get(&k, &d);
    assert_eq!(after["decisions"].as_array().unwrap().len(), 1);
    assert_eq!(after["stale"], false);
    let agent = Kernel::open(json!({"workspace_path":root.path(),"mode":"agent"})).unwrap();
    let public = get(&agent, &d);
    assert!(public["decisions"][0].get("private_comments").is_none());
    assert_eq!(public["decisions"][0]["comments"], "作者已核对原文与诊断。");
    assert_eq!(
        call(&agent, "reviews.decide", input.clone())["error"]["code"],
        "forbidden"
    );
    let mut duplicate = input;
    duplicate["operation_key"] = json!("concurrent-approval");
    assert_eq!(
        call(&k, "reviews.decide", duplicate)["error"]["code"],
        "revision_conflict"
    );
    let withdrawal = decision(&get(&k, &d), "withdrawn", "withdraw");
    let withdrawn = data(call(&k, "reviews.decide", withdrawal));
    assert_eq!(withdrawn["draft"]["state"], "in_review");
    assert!(data(call(&k, "documents.list", json!({})))["documents"].as_array().unwrap().is_empty());
    assert_eq!(get(&k, &d)["decisions"].as_array().unwrap().len(), 2);

}

#[test]
fn corrected_draft_annotations_produce_fresh_pageable_review_evidence() {
    let (_root, k) = setup();
    let d = begin(&k, &draft(&k, "draft"), "begin");
    let original = validate(&k, &d, "first");
    let plot = data(call(
        &k,
        "plot.get",
        json!({"plot_revision_id":original["report"]["input_snapshot"]["plot_revision_id"]}),
    ))["plot"]
        .clone();
    let node = &plot["nodes"][0];
    let corrected = data(call(&k, "plot.correct", json!({"plot_revision_id":plot["plot_revision_id"],"corrections":[{"type":"update_node","node_id":node["node_id"],"kind":node["kind"],"entity_refs":[],"location_ref":null,"time_ref":null,"speaker_ref":null,"time_of_day":"unknown","verification":"confirmed"}],"operation_key":"correct"})))["plot"].clone();
    assert_eq!(get(&k, &d)["reports"][0]["stale"], true);
    data(call(
        &k,
        "validation.run",
        json!({"plot_revision_id":corrected["plot_revision_id"],"rule_set_version":"1","options":{},"save_report":true,"operation_key":"corrected-report"}),
    ));
    let page = data(call(
        &k,
        "reviews.get",
        json!({"draft_id":d["draft_id"],"report_limit":1}),
    ));
    assert_eq!(page["reports"].as_array().unwrap().len(), 1);
    assert_eq!(
        page["reports"][0]["plot_revision_id"],
        corrected["plot_revision_id"]
    );
    assert_eq!(page["reports"][0]["stale"], false);
    let next = data(call(
        &k,
        "reviews.get",
        json!({"draft_id":d["draft_id"],"report_limit":1,"report_cursor":page["reports_next_cursor"]}),
    ));
    assert_eq!(
        next["reports"][0]["reference"]["report_id"],
        original["report"]["report_id"]
    );
    assert_eq!(next["reports_next_cursor"], Value::Null);
    validate(&k, &d, "third-report");
    assert_eq!(
        call(
            &k,
            "reviews.get",
            json!({"draft_id":d["draft_id"],"report_limit":1,"report_cursor":page["reports_next_cursor"]})
        )["error"]["code"],
        "cursor_invalid"
    );
    data(call(
        &k,
        "reviews.decide",
        decision(&page, "approved", "approve-corrected"),
    ));
}

#[test]
fn reference_decisions_are_independent_and_target_changes_still_invalidate_evidence() {
    let (root, k) = setup();
    let doc = data(call(
        &k,
        "documents.create",
        json!({"kind":"novel_chapter","title":"审核章节","source_format":"markdown","content":"# 灯塔\n\n林舟走进灯塔。","operation_key":"doc"}),
    ));
    let make = |revision: &Value, key: &str| {
        data(call(&k,"drafts.submit_current",json!({"document_id":doc["document"]["document_id"],"base_revision_id":revision,"blueprint_revision":1,"operation_key":key})))["draft"].clone()
    };
    let first = begin(
        &k,
        &make(&doc["revision"]["revision_id"], "first"),
        "begin-first",
    );
    assert_eq!(first["title"], "审核章节");
    validate(&k, &first, "check-first");
    let screen = get(&k, &first);
    let other = Kernel::open(json!({"workspace_path":root.path(),"mode":"author"})).unwrap();
    data(call(&k, "reviews.decide", decision(&screen, "approved", "approve-first")));
    assert_eq!(get(&k, &first)["stale"], false);
    assert_eq!(
        call(
            &other,
            "reviews.decide",
            decision(&screen, "approved", "other-approval")
        )["error"]["code"],
        "revision_conflict"
    );
    let second = begin(
        &k,
        &make(&doc["revision"]["revision_id"], "second"),
        "begin-second",
    );
    validate(&k, &second, "check-second");
    let _newer = data(call(
        &k,
        "reviews.decide",
        decision(&get(&k, &second), "approved", "approve-second"),
    ));
    assert_eq!(data(call(&k, "reviews.decide", decision(&get(&k, &first), "withdrawn", "old-withdrawal")))["draft"]["state"], "in_review");
    let current = data(call(
        &k,
        "documents.get",
        json!({"document_id":doc["document"]["document_id"]}),
    ));
    assert!(current["document"]["approved_revision_id"].is_null());
    assert_eq!(current["revision"], doc["revision"]);
    let third = begin(
        &k,
        &make(&current["revision"]["revision_id"], "third"),
        "begin-third",
    );
    validate(&k, &third, "check-third");
    let screen = get(&k, &third);
    data(call(
        &k,
        "documents.save",
        json!({"document_id":doc["document"]["document_id"],"base_revision_id":current["revision"]["revision_id"],"source_format":"markdown","content":"另一窗口的新编辑","operation_key":"external-edit"}),
    ));
    assert_eq!(
        call(
            &k,
            "reviews.decide",
            decision(&screen, "approved", "stale-target")
        )["error"]["code"],
        "hetu.stale_evidence"
    );
    assert_eq!(get(&k, &third)["stale"], true);
}

#[test]
fn legacy_submission_requires_author_evidence_binding_before_validation() {
    use sha2::{Digest, Sha256};
    let (root, k) = setup();
    let id = "draft_11111111-1111-4111-8111-111111111111";
    let path = format!("packages/novel/drafts/{id}");
    std::fs::create_dir(root.path().join(&path)).unwrap();
    let content = "# 旧稿\n\n林舟走进灯塔。🌿";
    std::fs::write(root.path().join(format!("{path}/content.md")), content).unwrap();
    let legacy = json!({"schema_version":"1.0.0","draft_id":id,"revision":1,"package":"novel","source_format":"markdown","title":"旧提交","content_path":format!("{path}/content.md"),"content_sha256":format!("{:x}",Sha256::digest(content)),"state":"submitted","actor_ref":"actor_00000000-0000-4000-8000-000000000002","created_at":"2026-11-01T00:00:00Z","blueprint_revision":1,"diagnostic_state":"not_requested"});
    std::fs::write(
        root.path().join(format!("{path}/draft.json")),
        serde_json::to_vec(&legacy).unwrap(),
    )
    .unwrap();
    assert_eq!(get(&k, &legacy)["evidence_ready"], false);
    let input = json!({"draft_id":id,"expected_draft_revision":1,"plot_options":{},"validation_options":{},"operation_key":"unbound"});
    assert_eq!(
        call(&k, "reviews.validate", input)["error"]["code"],
        "missing_context"
    );
    let agent = Kernel::open(json!({"workspace_path":root.path(),"mode":"agent"})).unwrap();
    assert_eq!(
        call(
            &agent,
            "reviews.begin",
            json!({"draft_id":id,"expected_draft_revision":1,"operation_key":"agent-begin"})
        )["error"]["code"],
        "forbidden"
    );
    let bound = begin(&k, &legacy, "bind");
    assert_eq!(get(&k, &bound)["evidence_ready"], true);
    validate(&k, &bound, "bound-report");
    assert_eq!(get(&k, &bound)["content"], content);
    assert!(
        data(call(&k, "documents.list", json!({})))["documents"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn author_rework_preserves_both_texts_and_rejects_sibling_overwrites() {
    let (_root, k) = setup();
    let d = begin(&k, &draft(&k, "draft"), "begin");
    let requested = data(call(
        &k,
        "reviews.decide",
        decision(&get(&k, &d), "changes_requested", "request"),
    ));
    let input = json!({"package":"novel","source_format":"markdown","title":"返工第一章","content":"作者重新写的正文。","blueprint_revision":1,"parent_draft_id":d["draft_id"],"operation_key":"rework"});
    let new = data(call(&k, "drafts.submit", input.clone()));
    assert_eq!(new["draft"]["parent_draft_id"], d["draft_id"]);
    let original = get(&k, &d);
    assert_eq!(original["draft"]["state"], "superseded");
    assert_eq!(original["draft"]["superseded_by"], new["draft"]["draft_id"]);
    assert_eq!(original["decisions"][0], requested["review"]);
    assert_eq!(original["content"], "# 灯塔\n\n林舟推开门。🌿\n");
    let mut sibling = input;
    sibling["operation_key"] = json!("sibling");
    assert_eq!(
        call(&k, "drafts.submit", sibling)["error"]["code"],
        "revision_conflict"
    );
}

#[test]
fn reports_must_cover_exact_draft_and_fresh_author_context() {
    let (_root, k) = setup();
    let d = begin(&k, &draft(&k, "one"), "begin");
    let empty = get(&k, &d);
    assert_eq!(
        call(
            &k,
            "reviews.decide",
            decision(&empty, "approved", "no-report")
        )["error"]["code"],
        "hetu.review_evidence_required"
    );
    validate(&k, &d, "validate");
    let context = get(&k, &d);
    let other = begin(&k, &draft(&k, "other"), "begin-other");
    validate(&k, &other, "other-report");
    let mut input = decision(&context, "approved", "wrong-report");
    input["report_refs"] = json!([get(&k, &other)["reports"][0]["reference"]]);
    assert_eq!(
        call(&k, "reviews.decide", input)["error"]["code"],
        "hetu.stale_evidence"
    );
    let bp = data(call(&k, "blueprints.get", json!({})));
    data(call(
        &k,
        "blueprints.lock",
        json!({"expected":{"revision":bp["revision"],"sha256":bp["sha256"]},"operation_key":"change-context"}),
    ));
    assert_eq!(
        call(
            &k,
            "reviews.decide",
            decision(&context, "approved", "stale-screen")
        )["error"]["code"],
        "hetu.stale_evidence"
    );
    let now = get(&k, &d);
    assert_eq!(now["stale"], true);
    assert_eq!(
        call(
            &k,
            "reviews.decide",
            decision(&now, "approved", "stale-source")
        )["error"]["code"],
        "hetu.stale_evidence"
    );
    assert_eq!(
        data(call(
            &k,
            "reviews.decide",
            decision(&now, "rejected", "reject-stale")
        ))["draft"]["state"],
        "rejected"
    );
}

#[test]
fn target_scoped_errors_need_specific_allowed_exception_and_disposition_cas() {
    let (_root, k) = setup();
    let doc = data(call(
        &k,
        "documents.create",
        json!({"kind":"novel_chapter","title":"第一章","source_format":"markdown","content":"原文","operation_key":"doc"}),
    ));
    let bp = data(call(&k, "blueprints.get", json!({})));
    let rule = "rule_11111111-1111-4111-8111-111111111111";
    data(call(
        &k,
        "blueprints.save",
        json!({"expected":{"revision":bp["revision"],"sha256":bp["sha256"]},"typed_changes":[{"type":"upsert_rule","entity":{"rule_id":rule,"revision":1,"type":"forbidden_term","scope":{"packages":["novel"],"document_ids":[doc["document"]["document_id"]],"entity_refs":[]},"severity":"error","parameters":{"terms":["传送门"],"case_sensitive":true,"exceptions":[]},"rationale":"设定中没有传送","exception_policy":"author_review"}}],"operation_key":"rule"}),
    ));
    let d=data(call(&k,"drafts.submit",json!({"package":"novel","source_format":"markdown","target_document_id":doc["document"]["document_id"],"base_revision_id":doc["revision"]["revision_id"],"content":"林舟打开传送门。","blueprint_revision":2,"operation_key":"draft"})))["draft"].clone();
    let d = begin(&k, &d, "begin");
    let report = validate(&k, &d, "report")["report"].clone();
    let finding = report["findings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["certainty"] == "certain")
        .unwrap();
    let before = get(&k, &d);
    assert_eq!(
        call(
            &k,
            "reviews.decide",
            decision(&before, "approved", "conflict")
        )["error"]["code"],
        "hetu.review_conflict"
    );
    data(call(
        &k,
        "findings.disposition",
        json!({"report_id":report["report_id"],"finding_id":finding["finding_id"],"expected_inputs":report["input_snapshot"],"expected_disposition_revision":0,"disposition":"accepted_exception","reason":"作者确认这是剧中假想叙述。","operation_key":"exception"}),
    ));
    assert_eq!(
        call(
            &k,
            "reviews.decide",
            decision(&before, "approved", "old-dispositions")
        )["error"]["code"],
        "hetu.stale_evidence"
    );
    let after = get(&k, &d);
    let approved = data(call(
        &k,
        "reviews.decide",
        decision(&after, "approved", "approved-exception"),
    ));
    assert_eq!(
        approved["review"]["exceptions"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        data(call(
            &k,
            "documents.get",
            json!({"document_id":doc["document"]["document_id"]})
        ))["content"],
        "原文"
    );
}

#[test]
fn partial_coverage_requires_explicit_reason_and_original_key_survives_reopen() {
    let (root, k) = setup();
    let d = begin(&k, &draft(&k, "draft"), "begin");
    let request = json!({"draft_id":d["draft_id"],"expected_draft_revision":d["revision"],"plot_options":{"max_nodes":1},"validation_options":{"max_bytes":1},"operation_key":"partial"});
    let result = call(&k, "reviews.validate", request.clone());
    assert_eq!(result["status"], "partial");
    let context = get(&k, &d);
    let mut input = decision(&context, "approved", "no-reason");
    input["coverage_acknowledgement"] = json!("");
    assert_eq!(
        call(&k, "reviews.decide", input)["error"]["code"],
        "hetu.review_coverage_required"
    );
    drop(k);
    let reopened = Kernel::open(json!({"workspace_path":root.path(),"mode":"author"})).unwrap();
    assert_eq!(call(&reopened, "reviews.validate", request), result);
    assert_eq!(
        data(call(
            &reopened,
            "reviews.decide",
            decision(&get(&reopened, &d), "approved", "explicit-reason")
        ))["draft"]["state"],
        "approved"
    );
}

#[test]
fn tampered_submission_decision_or_state_never_becomes_approval_evidence() {
    let (root, k) = setup();
    let d = begin(&k, &draft(&k, "draft"), "begin");
    let rejected = data(call(
        &k,
        "reviews.decide",
        decision(&get(&k, &d), "rejected", "reject"),
    ));
    let id = rejected["review"]["review_id"].as_str().unwrap();
    let path = root.path().join(format!(
        "packages/novel/drafts/{}/reviews/{id}.json",
        d["draft_id"].as_str().unwrap()
    ));
    std::fs::write(path, b"{}").unwrap();
    assert_eq!(
        call(&k, "reviews.get", json!({"draft_id":d["draft_id"]}))["error"]["code"],
        "hetu.integrity_failure"
    );
    let other = draft(&k, "other");
    let path = root.path().join(format!(
        "packages/novel/drafts/{}/draft.json",
        other["draft_id"].as_str().unwrap()
    ));
    std::fs::write(path, b"{}").unwrap();
    assert_eq!(
        call(&k, "drafts.get", json!({"draft_id":other["draft_id"]}))["error"]["code"],
        "hetu.integrity_failure"
    );
}
