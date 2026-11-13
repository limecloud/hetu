use hetu_core::Kernel;
use serde_json::{Value, json};

const CHARACTER: &str = "character_11111111-1111-4111-8111-111111111111";
const PLACE: &str = "location_22222222-2222-4222-8222-222222222222";
const EARLY: &str = "event_33333333-3333-4333-8333-333333333333";
const LATE: &str = "event_44444444-4444-4444-8444-444444444444";
const CONTENT: &str = "# 灯塔 — 夜\r\n\r\n林舟推开门，心想秘密，心中觉得不安。👩🏽‍💻\r\n\r\n普通段落也含禁词，允许禁词不应报告。\r\n\r\n```text\r\n禁词\r\n```\r\n";
fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn success(value: Value) -> Value {
    assert!(
        matches!(value["status"].as_str(), Some("succeeded" | "partial")),
        "{value}"
    );
    value["data"].clone()
}
fn setup() -> (tempfile::TempDir, Kernel, Value, Value) {
    let root = tempfile::tempdir().unwrap();
    let kernel = Kernel::open(json!({"workspace_path":root.path(),"mode":"author","create":{"title":"诊断测试","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let document = success(call(
        &kernel,
        "documents.create",
        json!({"kind":"novel_chapter","title":"灯塔之夜","source_format":"markdown","content":CONTENT,"operation_key":"doc"}),
    ));
    let mut changes = vec![
        json!({"type":"upsert_character","entity":{"character_id":CHARACTER,"name":"林舟","aliases":[],"description":"","traits":[],"archived":false,"facts":[{"fact_id":"fact_55555555-5555-4555-8555-555555555555","subject_ref":CHARACTER,"predicate":"life_state","value":"alive","valid_from":EARLY,"valid_to":LATE,"source_refs":[]},{"fact_id":"fact_66666666-6666-4666-8666-666666666666","subject_ref":CHARACTER,"predicate":"life_state","value":"dead","valid_from":LATE,"source_refs":[]}]}}),
        json!({"type":"upsert_location","entity":{"location_id":PLACE,"name":"灯塔","aliases":[],"description":"","interior_exterior":"exterior","archived":false}}),
    ];
    for (event, tick) in [(EARLY, 0), (LATE, 10)] {
        changes.push(json!({"type":"upsert_event","entity":{"event_id":event,"title":format!("事件 {tick}"),"time_anchor":{"calendar":"雾港历","tick":tick},"before_refs":[],"after_refs":[],"source_refs":[]}}));
    }
    for (index, kind, parameters, policy) in [
        (
            1,
            "required_reference",
            json!({"entity_types":["character","location"]}),
            "none",
        ),
        (
            2,
            "fact_equals",
            json!({"predicates":["life_state"]}),
            "author_review",
        ),
        (
            3,
            "event_precedes",
            json!({"before_event_id":EARLY,"after_event_id":LATE}),
            "none",
        ),
        (
            4,
            "forbidden_term",
            json!({"terms":["禁词"],"case_sensitive":false,"exceptions":["允许禁词"]}),
            "author_review",
        ),
        (
            5,
            "world_constraint",
            json!({"location_ref":PLACE,"forbidden_capability":"飞行"}),
            "author_review",
        ),
        (
            6,
            "advisory",
            json!({"text":"核对角色动机"}),
            "author_review",
        ),
    ] {
        changes.push(json!({"type":"upsert_rule","entity":{"rule_id":format!("rule_{index:08}-1111-4111-8111-111111111111"),"revision":1,"type":kind,"scope":{"packages":["novel"],"document_ids":[],"entity_refs":[]},"severity":"error","parameters":parameters,"rationale":"测试","exception_policy":policy}}));
    }
    let bp = success(call(&kernel, "blueprints.get", json!({})));
    success(call(
        &kernel,
        "blueprints.save",
        json!({"expected":{"revision":bp["revision"],"sha256":bp["sha256"]},"typed_changes":changes,"operation_key":"bible"}),
    ));
    let plot = success(call(&kernel,"plot.extract",json!({"document_revisions":[{"document_id":document["document"]["document_id"],"revision_id":document["revision"]["revision_id"],"sha256":document["revision"]["sha256"]}],"blueprint_revision":2,"options":{},"save_result":true,"operation_key":"plot"})))["plot"].clone();
    (root, kernel, document, plot)
}
fn input(plot: &Value, save: bool, key: &str) -> Value {
    let mut input = json!({"plot_revision_id":plot["plot_revision_id"],"rule_set_version":"1","options":{},"save_report":save});
    if save {
        input["operation_key"] = json!(key);
    }
    input
}
fn annotation(document: &Value, context: &str, time: &str) -> Value {
    let quote = "林舟推开门，心想秘密，心中觉得不安。👩🏽‍💻";
    let start = CONTENT.find(quote).unwrap();
    json!({"type":"add_node","kind":"action","source_ref":{"document_id":document["document"]["document_id"],"revision_id":document["revision"]["revision_id"],"byte_start":start,"byte_end":start+quote.len(),"quote":quote},"entity_refs":[CHARACTER],"location_ref":PLACE,"time_ref":time,"speaker_ref":null,"time_of_day":"night","verification":"confirmed","annotation":{"context":context,"facts":[{"subject_ref":CHARACTER,"predicate":"life_state","value":"dead"}],"capabilities":["飞行"]}})
}
fn corrected(k: &Kernel, plot: &Value, changes: Value, key: &str) -> Value {
    success(call(k,"plot.correct",json!({"plot_revision_id":plot["plot_revision_id"],"corrections":changes,"operation_key":key})))["plot"].clone()
}
#[test]
fn unconfirmed_candidates_are_unknown_and_terms_scan_unstructured_prose_with_exact_sources() {
    let (root, k, _, p) = setup();
    let output = call(&k, "validation.run", input(&p, false, ""));
    assert_eq!(output["status"], "succeeded", "{output}");
    assert!(output.get("operation").is_none());
    assert!(!root.path().join(".hetu/reports").exists());
    let report = &output["data"]["report"];
    assert!(report["coverage"]["counts"]["unknown"].as_u64().unwrap() > 0);
    let findings = report["findings"].as_array().unwrap();
    assert!(!findings.iter().any(|f| matches!(
        f["message_key"].as_str(),
        Some("validation.fact_conflict" | "validation.world_conflict")
    )));
    let terms: Vec<_> = findings
        .iter()
        .filter(|f| f["message_key"] == "validation.forbidden_term")
        .collect();
    assert_eq!(terms.len(), 1, "{findings:?}");
    let source = &terms[0]["source_refs"][0];
    assert_eq!(source["quote"], "禁词");
    assert_eq!(
        CONTENT.get(
            source["byte_start"].as_u64().unwrap() as usize
                ..source["byte_end"].as_u64().unwrap() as usize
        ),
        source["quote"].as_str()
    );
    assert!(
        findings
            .iter()
            .any(|f| f["message_key"] == "validation.mental_density"
                && f["severity"] == "warning"
                && f["certainty"] == "heuristic")
    );
    assert!(
        findings
            .iter()
            .filter(|f| f["message_key"] == "validation.advisory")
            .all(|f| f["severity"] == "info")
    );
}
#[test]
fn confirmed_facts_respect_half_open_time_and_nonactual_context() {
    let (_root, k, d, p) = setup();
    for (context, time, conflict) in [
        ("actual", EARLY, true),
        ("actual", LATE, false),
        ("dream", EARLY, false),
        ("reported", EARLY, false),
        ("hypothetical", EARLY, false),
        ("unknown", EARLY, false),
    ] {
        let next = corrected(
            &k,
            &p,
            json!([annotation(&d, context, time)]),
            &format!("{context}-{time}"),
        );
        let report = success(call(&k, "validation.run", input(&next, false, "")))["report"].clone();
        assert_eq!(
            report["findings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f["message_key"] == "validation.fact_conflict"),
            conflict,
            "{report}"
        );
        assert_eq!(
            report["findings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f["message_key"] == "validation.world_conflict"),
            context == "actual",
            "{report}"
        );
    }
}
#[test]
fn chronology_uses_author_story_order_never_narrative_order() {
    let (_root, k, d, p) = setup();
    let next = corrected(
        &k,
        &p,
        json!([
            annotation(&d, "actual", LATE),
            annotation(&d, "actual", EARLY)
        ]),
        "annotations",
    );
    let nodes = next["nodes"].as_array().unwrap();
    let from = &nodes[nodes.len() - 2];
    let to = &nodes[nodes.len() - 1];
    for relation in ["narrative_next", "story_before"] {
        let next = corrected(
            &k,
            &next,
            json!([{"type":"add_edge","from_node_id":from["node_id"],"to_node_id":to["node_id"],"relation":relation,"source_refs":from["source_refs"]}]),
            relation,
        );
        let report = success(call(&k, "validation.run", input(&next, false, "")))["report"].clone();
        assert_eq!(
            report["findings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f["message_key"] == "validation.event_conflict"),
            relation == "story_before"
        );
    }
}
#[test]
fn partial_report_is_terminal_replay_and_coverage_cannot_claim_completion() {
    let (_root, k, _, p) = setup();
    for (option, budget) in [
        ("max_bytes", 10),
        ("max_evaluations", 1),
        ("max_findings", 1),
        ("max_matches", 1),
    ] {
        let mut request = input(&p, true, option);
        request["options"][option] = json!(budget);
        let first = call(&k, "validation.run", request.clone());
        assert_eq!(first["status"], "partial", "{first}");
        assert_eq!(call(&k, "validation.run", request), first);
        let reread = call(
            &k,
            "reports.get",
            json!({"report_id":first["data"]["report"]["report_id"]}),
        );
        assert_eq!(reread["status"], "partial", "{reread}");
        assert_eq!(reread["data"]["report"], first["data"]["report"]);
    }
}
#[test]
fn dispositions_use_fixed_evidence_cas_permissions_and_immutable_history() {
    let (root, k, _, p) = setup();
    let saved = success(call(&k, "validation.run", input(&p, true, "validation")));
    let report = &saved["report"];
    let finding = report["findings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["message_key"] == "validation.forbidden_term")
        .unwrap();
    let request = json!({"report_id":report["report_id"],"finding_id":finding["finding_id"],"expected_inputs":report["input_snapshot"],"expected_disposition_revision":0,"disposition":"false_positive","reason":"这是引述的书名，作者保留。","operation_key":"review"});
    let agent = Kernel::open(json!({"workspace_path":root.path(),"mode":"agent"})).unwrap();
    assert_eq!(
        call(&agent, "findings.disposition", request.clone())["error"]["code"],
        "forbidden"
    );
    let first = call(&k, "findings.disposition", request.clone());
    success(first.clone());
    assert_eq!(call(&k, "findings.disposition", request.clone()), first);
    let mut stale = request.clone();
    stale["operation_key"] = json!("other");
    assert_eq!(
        call(&k, "findings.disposition", stale)["error"]["code"],
        "revision_conflict"
    );
    let reread = success(call(
        &k,
        "reports.get",
        json!({"report_id":report["report_id"]}),
    ));
    assert_eq!(reread["report"], *report);
    assert_eq!(reread["dispositions"][0]["current"]["revision"], 1);
    let path = root.path().join(format!(
        "packages/drama/reports/dispositions/{}.1.json",
        finding["finding_id"].as_str().unwrap()
    ));
    let mut item: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    item["reason"] = json!("篡改");
    std::fs::write(path, serde_json::to_vec(&item).unwrap()).unwrap();
    assert_eq!(
        call(&k, "reports.get", json!({"report_id":report["report_id"]}))["error"]["code"],
        "hetu.integrity_failure"
    );
}
#[test]
fn reports_detect_correction_source_change_tampering_and_paginate() {
    let (root, k, d, p) = setup();
    let first = success(call(&k, "validation.run", input(&p, true, "one")));
    success(call(&k, "validation.run", input(&p, true, "two")));
    let page = success(call(&k, "reports.list", json!({"limit":1})));
    assert_eq!(page["reports"].as_array().unwrap().len(), 1);
    assert!(!page["next_cursor"].is_null());
    assert_eq!(
        success(call(
            &k,
            "reports.list",
            json!({"limit":1,"cursor":page["next_cursor"]})
        ))["reports"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    corrected(&k, &p, json!([annotation(&d, "actual", EARLY)]), "correct");
    success(call(
        &k,
        "documents.save",
        json!({"document_id":d["document"]["document_id"],"base_revision_id":d["revision"]["revision_id"],"source_format":"markdown","content":"新正文","operation_key":"edit"}),
    ));
    let report = &first["report"];
    let read = success(call(
        &k,
        "reports.get",
        json!({"report_id":report["report_id"]}),
    ));
    assert_eq!(read["stale"], true);
    assert_eq!(read["stale_reasons"].as_array().unwrap().len(), 2);
    let path = root.path().join(format!(
        "packages/drama/reports/{}.json",
        report["report_id"].as_str().unwrap()
    ));
    std::fs::write(path, b"{}").unwrap();
    assert_eq!(
        call(&k, "reports.get", json!({"report_id":report["report_id"]}))["error"]["code"],
        "hetu.integrity_failure"
    );
}

#[test]
fn scoped_literal_matching_preserves_case_offsets_and_local_exceptions() {
    let (_root, k, first, _) = setup();
    let source = "PORTAL allowPORTAL portal Ångström ångström `PORTAL`\n";
    let second = success(call(
        &k,
        "documents.create",
        json!({"kind":"novel_chapter","title":"字面匹配","source_format":"markdown","content":source,"operation_key":"literal-doc"}),
    ));
    let bp = success(call(&k, "blueprints.get", json!({})));
    let mut rule = bp["blueprint"]["rules"][3].clone();
    rule["scope"]["document_ids"] = json!([second["document"]["document_id"]]);
    rule["parameters"] =
        json!({"terms":["PORTAL","Ångström"],"exceptions":["allowPORTAL"],"case_sensitive":false});
    success(call(
        &k,
        "blueprints.save",
        json!({"expected":{"revision":bp["revision"],"sha256":bp["sha256"]},"typed_changes":[{"type":"upsert_rule","entity":rule}],"operation_key":"literal-rule"}),
    ));
    let sources: Vec<_> = [&first,&second].iter().map(|d|json!({"document_id":d["document"]["document_id"],"revision_id":d["revision"]["revision_id"],"sha256":d["revision"]["sha256"]})).collect();
    let p = success(call(&k,"plot.extract",json!({"document_revisions":sources,"blueprint_revision":3,"options":{},"save_result":true,"operation_key":"literal-plot"})))["plot"].clone();
    let report = success(call(&k, "validation.run", input(&p, false, "")))["report"].clone();
    let terms: Vec<_> = report["findings"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["message_key"] == "validation.forbidden_term")
        .collect();
    assert_eq!(terms.len(), 3);
    for finding in terms {
        let reference = &finding["source_refs"][0];
        assert_eq!(reference["document_id"], second["document"]["document_id"]);
        assert_eq!(
            source.get(
                reference["byte_start"].as_u64().unwrap() as usize
                    ..reference["byte_end"].as_u64().unwrap() as usize
            ),
            reference["quote"].as_str()
        );
        assert_ne!(reference["quote"], "ångström");
    }
}

#[test]
fn author_annotation_rejects_invalid_types_and_exceptions_cannot_change_evidence() {
    let (_root, k, d, p) = setup();
    let mut invalid = annotation(&d, "actual", EARLY);
    invalid["annotation"]["facts"][0]["predicate"] = json!("age");
    invalid["annotation"]["facts"][0]["value"] = json!("18");
    let result = call(
        &k,
        "plot.correct",
        json!({"plot_revision_id":p["plot_revision_id"],"corrections":[invalid],"operation_key":"invalid-assertion"}),
    );
    assert_eq!(result["error"]["code"], "invalid_input");
    let report =
        success(call(&k, "validation.run", input(&p, true, "policy-report")))["report"].clone();
    let finding = report["findings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["exception_policy"] == "none")
        .unwrap();
    let mut request = json!({"report_id":report["report_id"],"finding_id":finding["finding_id"],"expected_inputs":report["input_snapshot"],"expected_disposition_revision":0,"disposition":"accepted_exception","reason":"不能豁免的测试规则","operation_key":"policy"});
    assert_eq!(
        call(&k, "findings.disposition", request.clone())["error"]["code"],
        "forbidden"
    );
    request["disposition"] = json!("acknowledged");
    request["expected_inputs"]["blueprint_revision"] = json!(1);
    assert_eq!(
        call(&k, "findings.disposition", request)["error"]["code"],
        "hetu.stale_evidence"
    );
}
