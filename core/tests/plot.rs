use hetu_core::Kernel;
use serde_json::{Value, json};

const LIN: &str = "character_11111111-1111-4111-8111-111111111111";
const OTHER: &str = "character_22222222-2222-4222-8222-222222222222";
const ANN: &str = "character_33333333-3333-4333-8333-333333333333";
const PLACE: &str = "location_44444444-4444-4444-8444-444444444444";
const EVENT: &str = "event_55555555-5555-4555-8555-555555555555";
fn call(k: &Kernel, name: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{name}"),"contract_revision":"1","input":input}))
}
fn setup() -> (tempfile::TempDir, Kernel) {
    let root = tempfile::tempdir().unwrap();
    let k = Kernel::open(json!({"workspace_path":root.path(),"mode":"author","create":{"title":"雾港纪事","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let bp = call(&k, "blueprints.get", json!({}))["data"].clone();
    let characters: Vec<_> = [(LIN, "林舟", vec!["巡夜人"]), (OTHER, "林舟然", vec!["巡夜人"]), (ANN, "Ann", vec![])].into_iter().map(|(id,name,aliases)| json!({"type":"upsert_character","entity":{"character_id":id,"name":name,"aliases":aliases,"description":"","traits":[],"facts":[],"archived":false}})).collect();
    let mut changes = characters;
    changes.push(json!({"type":"upsert_location","entity":{"location_id":PLACE,"name":"灯塔","aliases":[],"interior_exterior":"exterior","description":"","archived":false}}));
    changes.push(json!({"type":"upsert_event","entity":{"event_id":EVENT,"title":"点灯之夜","time_anchor":{"calendar":"雾港历","tick":0},"before_refs":[],"after_refs":[],"source_refs":[]}}));
    let result = call(
        &k,
        "blueprints.save",
        json!({"expected":{"revision":bp["revision"],"sha256":bp["sha256"]},"typed_changes":changes,"operation_key":"bible"}),
    );
    assert_eq!(result["status"], "succeeded", "{result}");
    (root, k)
}
fn document(k: &Kernel, content: &str, format: &str, key: &str) -> Value {
    let result = call(
        k,
        "documents.create",
        json!({"kind":if format=="fountain" {"drama_script"} else {"novel_chapter"},"title":key,"source_format":format,"content":content,"operation_key":key}),
    );
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn input(doc: &Value, save: bool, key: &str) -> Value {
    let mut input = json!({"document_revisions":[{"document_id":doc["document"]["document_id"],"revision_id":doc["revision"]["revision_id"],"sha256":doc["revision"]["sha256"]}],"blueprint_revision":2,"options":{},"save_result":save});
    if save {
        input["operation_key"] = json!(key);
    }
    input
}
fn plot(result: &Value) -> Value {
    assert!(
        matches!(result["status"].as_str(), Some("succeeded" | "partial")),
        "{result}"
    );
    result["data"]["plot"].clone()
}
fn correction(node: &Value) -> Value {
    json!({"type":"update_node","node_id":node["node_id"],"kind":node["kind"],"entity_refs":[],"location_ref":null,"time_ref":null,"speaker_ref":null,"time_of_day":"unknown","verification":"confirmed"})
}
fn evidence(content: &str, source: &Value) {
    assert_eq!(
        content.get(
            source["byte_start"].as_u64().unwrap() as usize
                ..source["byte_end"].as_u64().unwrap() as usize
        ),
        source["quote"].as_str()
    );
}

#[test]
fn markdown_offsets_are_original_utf8_and_dictionary_hits_remain_candidates() {
    let (root, k) = setup();
    let content = "\u{feff}# 灯塔 — 夜\r\n\r\n林舟推开门。👩🏽‍💻 e\u{301}\r\n\r\n林舟：“不要走！”\r\n\r\n巡夜人走向灯塔。\r\n\r\n林舟然走来。\r\n\r\nAnna walks. Ann走。 Ann walks.\r\n\r\n```text\r\n林舟推开禁用代码。\r\n```\r\n\r\n`林舟走出行内代码`\r\n\r\n<div>林舟走进HTML</div>\r\n\r\n[链接](https://host/林舟走)\r\n\r\n没有结构提示。\r\n";
    let doc = document(&k, content, "markdown", "chapter");
    let output = call(&k, "plot.extract", input(&doc, false, ""));
    let p = plot(&output);
    assert_eq!(output["data"]["saved"], false);
    assert!(output.get("operation").is_none());
    assert!(!root.path().join(".hetu/plots").exists());
    assert_eq!(p["coverage"]["status"], "complete");
    assert_eq!(p["coverage"]["scanned_bytes"], content.len());
    let nodes = p["nodes"].as_array().unwrap();
    assert_eq!(nodes[0]["kind"], "scene");
    assert_eq!(nodes[0]["time_of_day"], "night");
    let mut ambiguous = false;
    let mut longest = false;
    let mut ann_hits = 0;
    for n in nodes {
        assert_eq!(n["verification"], "needs_author_review");
        assert!(n["entity_refs"].as_array().unwrap().is_empty());
        for source in n["source_refs"].as_array().unwrap() {
            evidence(content, source);
            assert!(!source["quote"].as_str().unwrap().contains("禁用代码"));
        }
        for c in n["entity_candidates"].as_array().unwrap() {
            evidence(content, &c["source_ref"]);
            if c["entity_ref"] == ANN {
                assert_eq!(c["matched_text"], "Ann");
                ann_hits += 1;
            }
        }
        if n["source_refs"][0]["quote"]
            .as_str()
            .unwrap()
            .contains("巡夜人")
        {
            ambiguous = n["missing_prerequisites"]
                .as_array()
                .unwrap()
                .contains(&json!("ambiguous_name"));
        }
        if n["source_refs"][0]["quote"] == "林舟然走来。" {
            longest = n["entity_candidates"]
                .as_array()
                .unwrap()
                .iter()
                .all(|c| c["entity_ref"] == OTHER);
        }
    }
    assert!(ambiguous && longest);
    assert_eq!(ann_hits, 2);
    let dialogue = nodes.iter().find(|n| n["kind"] == "dialogue").unwrap();
    assert_eq!(dialogue["speaker_candidates"], json!([LIN]));
    assert!(dialogue["speaker_ref"].is_null());
    let skipped = p["coverage"]["unparsed_ranges"].as_array().unwrap();
    for reason in ["code", "html", "no_structural_signal"] {
        assert!(skipped.iter().any(|r| r["reason"] == reason));
    }
    assert!(
        p["edges"].as_array().unwrap().iter().all(
            |e| e["relation"] == "narrative_next" && e["verification"] == "needs_author_review"
        )
    );
}
#[test]
fn fountain_chinese_cues_scenes_and_unknown_speaker_have_explicit_evidence() {
    let (_root, k) = setup();
    let content = "Title:\n    林舟走过这里\nAuthor: 作者\n\nEXT. 灯塔 - NIGHT\n\n@林舟\n（低声）\n我走过这里。\n\nANN\nStay.\n\n@陌生人\n别回头。\n\n林舟\n这行中文不是人物标记。\n\n/* 林舟走进不公开笔记 */\n\n[[ 林舟走出笔记 ]]\n\n[[林舟走\n林舟推门]]\n\n林舟推开门。[[Ann走进不公开笔记]]\n";
    let doc = document(&k, content, "fountain", "script");
    let p = plot(&call(&k, "plot.extract", input(&doc, true, "fountain")));
    let nodes = p["nodes"].as_array().unwrap();
    assert_eq!(nodes[0]["kind"], "scene");
    assert_eq!(nodes[0]["time_of_day"], "night");
    let dialogues: Vec<_> = nodes.iter().filter(|n| n["kind"] == "dialogue").collect();
    assert_eq!(dialogues.len(), 3);
    assert_eq!(dialogues[0]["speaker_candidates"], json!([LIN]));
    assert_eq!(dialogues[1]["speaker_candidates"], json!([ANN]));
    assert_eq!(dialogues[2]["unresolved_names"][0]["name"], "陌生人");
    evidence(content, &dialogues[2]["unresolved_names"][0]["source_ref"]);
    assert!(nodes.iter().all(|n| {
        !n["source_refs"][0]["quote"]
            .as_str()
            .unwrap()
            .contains("林舟走过这里")
    }));
    assert!(nodes.iter().all(|n| {
        n["entity_candidates"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["entity_ref"] != ANN)
    }));
    assert_eq!(
        call(
            &k,
            "plot.get",
            json!({"plot_revision_id":p["plot_revision_id"]})
        )["data"]["plot"],
        p
    );
}
#[test]
fn persisted_partial_replays_original_key_and_preview_has_no_receipt() {
    let (_root, k) = setup();
    let doc = document(
        &k,
        "# 夜\n\n林舟走。\n\n林舟跑。\n\n林舟推门。\n",
        "markdown",
        "budgets",
    );
    for (option, value, reason) in [
        ("max_nodes", 1, "max_nodes"),
        ("max_matches", 1, "max_matches"),
        ("max_bytes", 17, "max_bytes"),
    ] {
        let mut i = input(&doc, true, option);
        i["options"][option] = json!(value);
        let first = call(&k, "plot.extract", i.clone());
        let p = plot(&first);
        assert_eq!(first["status"], "partial", "{first}");
        assert_eq!(p["coverage"]["budget_stop"]["reason"], reason);
        assert!(
            p["coverage"]["scanned_bytes"].as_u64().unwrap() <= value as u64
                || option != "max_bytes"
        );
        assert_eq!(call(&k, "plot.extract", i.clone()), first);
        assert_eq!(
            call(
                &k,
                "plot.get",
                json!({"plot_revision_id":p["plot_revision_id"]})
            )["status"],
            "partial"
        );
        i["options"]["max_nodes"] = json!(3);
        assert_eq!(
            call(&k, "plot.extract", i)["error"]["code"],
            "idempotency_conflict"
        );
    }
    let mut i = input(&doc, false, "");
    i["operation_key"] = json!("invalid");
    assert_eq!(
        call(&k, "plot.extract", i)["error"]["code"],
        "invalid_input"
    );
}
#[test]
fn corrections_preserve_node_evidence_history_and_authority_and_reject_cycles() {
    let (root, k) = setup();
    let doc = document(
        &k,
        "林舟推开门。\n\n林舟：“回来。”\n",
        "markdown",
        "correct",
    );
    let p = plot(&call(&k, "plot.extract", input(&doc, true, "initial")));
    let nodes = p["nodes"].as_array().unwrap();
    let dialogue = nodes.iter().find(|n| n["kind"] == "dialogue").unwrap();
    let mut c = correction(dialogue);
    c["entity_refs"] = json!([LIN]);
    c["location_ref"] = json!(PLACE);
    c["time_ref"] = json!(EVENT);
    c["speaker_ref"] = json!(LIN);
    c["time_of_day"] = json!("night");
    let i = json!({"plot_revision_id":p["plot_revision_id"],"corrections":[c],"operation_key":"author-correct"});
    let agent = Kernel::open(json!({"workspace_path":root.path(),"mode":"agent"})).unwrap();
    assert_eq!(
        call(&agent, "plot.correct", i.clone())["error"]["code"],
        "forbidden"
    );
    let next = plot(&call(&k, "plot.correct", i.clone()));
    assert_eq!(plot(&call(&k, "plot.correct", i)), next);
    assert_eq!(next["parent_plot_revision_id"], p["plot_revision_id"]);
    let corrected = next["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["node_id"] == dialogue["node_id"])
        .unwrap();
    assert_eq!(corrected["source_refs"], dialogue["source_refs"]);
    assert!(
        corrected["missing_prerequisites"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        call(
            &k,
            "plot.get",
            json!({"plot_revision_id":p["plot_revision_id"]})
        )["data"]["plot"],
        p
    );
    let edges:Vec<_>=[(0,1),(1,0)].into_iter().map(|(a,b)|json!({"type":"add_edge","from_node_id":nodes[a]["node_id"],"to_node_id":nodes[b]["node_id"],"relation":"causes","source_refs":nodes[a]["source_refs"]})).collect();
    assert_eq!(
        call(
            &k,
            "plot.correct",
            json!({"plot_revision_id":p["plot_revision_id"],"corrections":edges,"operation_key":"cycle"})
        )["error"]["code"],
        "hetu.plot_cycle"
    );
    let mut c = correction(&nodes[0]);
    c["type"] = json!("add_node");
    c.as_object_mut().unwrap().remove("node_id");
    c["source_ref"] = nodes[0]["source_refs"][0].clone();
    c["source_ref"]["byte_start"] = json!(1);
    assert_eq!(
        call(
            &k,
            "plot.correct",
            json!({"plot_revision_id":p["plot_revision_id"],"corrections":[c],"operation_key":"forged"})
        )["error"]["code"],
        "hetu.invalid_source_ref"
    );
}
#[test]
fn source_and_bible_staleness_and_snapshot_pagination_are_explicit() {
    let (root, k) = setup();
    let doc = document(&k, "林舟走向灯塔。", "markdown", "stale");
    let p = plot(&call(&k, "plot.extract", input(&doc, true, "first")));
    plot(&call(&k, "plot.extract", input(&doc, true, "second")));
    let list = call(&k, "plot.list", json!({"limit":1}));
    let cursor = list["data"]["next_cursor"].clone();
    assert!(cursor.is_string());
    assert_eq!(
        call(&k, "plot.list", json!({"limit":1,"cursor":cursor}))["data"]["plots"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    plot(&call(&k, "plot.extract", input(&doc, true, "third")));
    assert_eq!(
        call(&k, "plot.list", json!({"cursor":cursor}))["error"]["code"],
        "cursor_invalid"
    );
    assert_eq!(
        call(
            &k,
            "documents.save",
            json!({"document_id":doc["document"]["document_id"],"base_revision_id":doc["revision"]["revision_id"],"source_format":"markdown","content":"新版：林舟离开。","operation_key":"advance"})
        )["status"],
        "succeeded"
    );
    let bp = call(&k, "blueprints.get", json!({}))["data"].clone();
    assert_eq!(
        call(
            &k,
            "blueprints.lock",
            json!({"expected":{"revision":bp["revision"],"sha256":bp["sha256"]},"operation_key":"lock"})
        )["status"],
        "succeeded"
    );
    let old = call(
        &k,
        "plot.get",
        json!({"plot_revision_id":p["plot_revision_id"]}),
    );
    assert_eq!(old["data"]["plot"], p);
    assert_eq!(old["data"]["stale"], true);
    assert_eq!(old["data"]["stale_reasons"].as_array().unwrap().len(), 2);
    let id = p["plot_revision_id"].as_str().unwrap();
    std::fs::write(
        root.path().join(format!("packages/novel/plot/{id}.json")),
        "{}",
    )
    .unwrap();
    assert_eq!(
        call(&k, "plot.get", json!({"plot_revision_id":id}))["error"]["code"],
        "hetu.integrity_failure"
    );
}

#[test]
fn parser_boundaries_and_large_outputs_never_turn_budget_stops_into_success() {
    let (_root, k) = setup();
    let text = "# 灯塔 — 日\n\n林舟：“别走。\n陌生人：“回来！”\n\n林舟：“她说『快走』。”\n陌生人：“停下！”\n\n林舟推开门。`林舟走` **林舟跑** &quot;\n\n【场景：灯塔｜夜】\n\n——走吧。\n\n";
    let doc = document(&k, text, "markdown", "boundary-cases");
    let p = plot(&call(&k, "plot.extract", input(&doc, false, "")));
    let different_speakers: Vec<_> = p["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|n| n["kind"] == "dialogue" && n["source_refs"][0]["quote"] == "“停下！”")
        .collect();
    assert_eq!(different_speakers.len(), 1);
    assert!(
        different_speakers[0]["speaker_candidates"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        different_speakers[0]["unresolved_names"][0]["name"],
        "陌生人"
    );
    // 每一个预算边界都可能落在中文、引号、换行或 Markdown 标记中间。
    for size in [1, 2, 3, 5, 7, 11, 17, 29, 61, 97, 149, 211] {
        let mut i = input(&doc, false, "");
        i["options"]["max_bytes"] = json!(size);
        let p = plot(&call(&k, "plot.extract", i));
        assert_eq!(p["coverage"]["status"], "partial");
        for node in p["nodes"].as_array().unwrap() {
            for source in node["source_refs"].as_array().unwrap() {
                evidence(text, source);
            }
        }
    }
    let content = ("林舟走".repeat(200) + "。\n\n").repeat(300);
    let doc = document(&k, &content, "markdown", "large-output");
    let mut i = input(&doc, false, "");
    i["options"] = json!({"max_bytes":8_388_608,"max_nodes":10000,"max_matches":200000,"max_duration_ms":10000});
    let p = plot(&call(&k, "plot.extract", i));
    // 输出与耗时预算独立竞争；高负载下耗时先到同样必须诚实返回 partial。
    assert!(matches!(
        p["coverage"]["budget_stop"]["reason"].as_str(),
        Some("max_output" | "max_duration")
    ));
    assert_eq!(p["coverage"]["status"], "partial");
    assert!(serde_json::to_vec(&p).unwrap().len() <= 8 * 1024 * 1024);
    let mut i = input(&doc, false, "");
    i["options"]["max_duration_ms"] = json!(1);
    let p = plot(&call(&k, "plot.extract", i));
    assert_eq!(p["coverage"]["budget_stop"]["reason"], "max_duration");
}
