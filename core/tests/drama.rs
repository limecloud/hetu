use hetu_core::Kernel;
use serde_json::{Value, json};

const LIN: &str = "character_11111111-1111-4111-8111-111111111111";
const TOWER: &str = "location_22222222-2222-4222-8222-222222222222";
const HOME: &str = "location_33333333-3333-4333-8333-333333333333";
fn call(k: &Kernel, name: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{name}"),"contract_revision":"1","input":input}))
}
fn data(result: Value) -> Value {
    assert!(
        matches!(result["status"].as_str(), Some("succeeded" | "partial")),
        "{result}"
    );
    result["data"].clone()
}
fn setup() -> (tempfile::TempDir, Kernel, Value, Vec<Value>) {
    let root = tempfile::tempdir().unwrap();
    let k = Kernel::open(json!({"workspace_path":root.path(),"mode":"author","create":{"title":"雾港短剧","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let bp = data(call(&k, "blueprints.get", json!({})));
    data(call(
        &k,
        "blueprints.save",
        json!({"expected":{"revision":bp["revision"],"sha256":bp["sha256"]},"operation_key":"bible","typed_changes":[
            {"type":"upsert_character","entity":{"character_id":LIN,"name":"林舟","aliases":[],"description":"","traits":[],"facts":[],"archived":false}},
            {"type":"upsert_location","entity":{"location_id":TOWER,"name":"灯塔","aliases":[],"interior_exterior":"exterior","description":"","archived":false}},
            {"type":"upsert_location","entity":{"location_id":HOME,"name":"旧宅","aliases":[],"interior_exterior":"interior","description":"","archived":false}}
        ]}),
    ));
    let mut docs = Vec::new();
    for (i, content) in [
        "# 灯塔 — 夜\r\n\r\n林舟推开门。👩🏽‍💻\r\n\r\n林舟走出灯塔。\r\n",
        "# 旧宅\n\n林舟走进旧宅。\n\n没有结构提示。\n",
    ]
    .iter()
    .enumerate()
    {
        docs.push(data(call(&k,"documents.create",json!({"kind":"novel_chapter","title":format!("第{}章",i+1),"source_format":"markdown","content":content,"operation_key":format!("doc-{i}")}))));
    }
    let sources: Vec<_> = docs.iter().map(|d|json!({"document_id":d["document"]["document_id"],"revision_id":d["revision"]["revision_id"],"sha256":d["revision"]["sha256"]})).collect();
    let p = data(call(&k,"plot.extract",json!({"document_revisions":sources,"blueprint_revision":2,"options":{},"save_result":true,"operation_key":"plot"})))["plot"].clone();
    (root, k, p, docs)
}
fn confirmed(k: &Kernel, p: &Value, docs: &[Value]) -> Value {
    let corrections: Vec<_> = p["nodes"].as_array().unwrap().iter().map(|n| {
        let first=n["source_refs"][0]["document_id"]==docs[0]["document"]["document_id"];
        json!({"type":"update_node","node_id":n["node_id"],"kind":n["kind"],"entity_refs":[LIN],"location_ref":if first {TOWER} else {HOME},"time_ref":null,"speaker_ref":null,"time_of_day":if first {"night"} else {"unknown"},"verification":"confirmed"})
    }).collect();
    data(call(k,"plot.correct",json!({"plot_revision_id":p["plot_revision_id"],"corrections":corrections,"operation_key":"confirm"})))["plot"].clone()
}
fn build(k: &Kernel, p: &Value, key: &str) -> Value {
    data(call(
        k,
        "drama.build_skeleton",
        json!({"plot_revision_id":p["plot_revision_id"],"blueprint_revision":p["blueprint_revision"],"episode_options":{},"operation_key":key}),
    ))
}
fn script_input(s: &Value, language: &str, key: &str) -> Value {
    json!({"skeleton_ref":{"skeleton_id":s["skeleton"]["skeleton_id"],"revision":s["skeleton"]["revision"],"sha256":s["sha256"]},"title":"雾港 👩🏽‍💻","language_tag":language,"operation_key":key})
}

#[test]
fn fountain_structure_is_independent_and_mapping_uses_fixed_utf8_ranges() {
    let (_root, k, p, docs) = setup();
    let p = confirmed(&k, &p, &docs);
    let s = build(&k, &p, "initial");
    let request = script_input(&s, "zh-CN", "script");
    let response = call(&k, "drama.create_script", request.clone());
    let created = data(response.clone());
    let loaded = data(call(
        &k,
        "documents.get",
        json!({"document_id":created["document"]["document_id"]}),
    ));
    assert_eq!(
        loaded["content"],
        "Title: 雾港 👩🏽‍💻\n\n# 第1集\n\nEXT. 灯塔 - NIGHT #1-1#\n\nINT. 旧宅 #1-2#\n\n"
    );
    assert!(!loaded["content"].as_str().unwrap().contains("林舟"));
    let mapping = data(call(
        &k,
        "drama.get_script_mapping",
        json!({"document_id":created["document"]["document_id"]}),
    ));
    assert_eq!(mapping["mapping"], created["mapping"]);
    for scene in mapping["mapping"]["scenes"].as_array().unwrap() {
        let text = loaded["content"].as_str().unwrap();
        assert_eq!(
            text.get(
                scene["byte_start"].as_u64().unwrap() as usize
                    ..scene["byte_end"].as_u64().unwrap() as usize
            ),
            scene["quote"].as_str()
        );
    }
    let saved = data(call(
        &k,
        "documents.save",
        json!({"document_id":created["document"]["document_id"],"base_revision_id":created["revision"]["revision_id"],"source_format":"fountain","content":format!("{}@林舟\n作者亲自写的台词。\n",loaded["content"].as_str().unwrap()),"operation_key":"author-text"}),
    ));
    let old = data(call(
        &k,
        "drama.get_script_mapping",
        json!({"document_id":created["document"]["document_id"]}),
    ));
    assert_eq!(old["mapping"], mapping["mapping"]);
    assert_eq!(old["current_revision_id"], saved["revision"]["revision_id"]);
    assert_eq!(old["stale"], true);
    assert!(
        old["stale_reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["code"] == "script_changed")
    );
    assert_eq!(call(&k, "drama.create_script", request), response);
    let second = data(call(
        &k,
        "drama.create_script",
        script_input(&s, "en", "new-script"),
    ));
    assert_ne!(
        second["document"]["document_id"],
        created["document"]["document_id"]
    );
    let text = data(call(
        &k,
        "documents.get",
        json!({"document_id":second["document"]["document_id"]}),
    ));
    assert!(text["content"].as_str().unwrap().contains("# Episode 1"));
    assert!(text["content"].as_str().unwrap().contains("灯塔"));
}

#[test]
fn unknown_structure_never_defaults_to_interior_or_day_and_history_is_explicit() {
    let (_root, k, p, _docs) = setup();
    let s = build(&k, &p, "raw");
    let created = data(call(
        &k,
        "drama.create_script",
        script_input(&s, "en", "unknown"),
    ));
    let original = data(call(
        &k,
        "documents.get",
        json!({"document_id":created["document"]["document_id"]}),
    ));
    let content = original["content"].as_str().unwrap();
    assert!(content.contains(".LOCATION UNSET #1-1#"));
    assert!(!content.contains("INT.") && !content.contains("DAY"));
    let ep = &s["skeleton"]["episodes"][0];
    data(call(
        &k,
        "drama.edit_skeleton",
        edit_input(
            &s,
            json!([{"type":"update_episode","episode_id":ep["episode_id"],"title":"新结构"}]),
            "new-head",
        ),
    ));
    let mapping = data(call(
        &k,
        "drama.get_script_mapping",
        json!({"document_id":created["document"]["document_id"]}),
    ));
    assert!(
        mapping["stale_reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["code"] == "skeleton_changed")
    );
    assert_eq!(mapping["mapping"]["skeleton_ref"]["revision"], 1);
    let historical = data(call(
        &k,
        "drama.create_script",
        script_input(&s, "zh-CN", "historical"),
    ));
    assert_eq!(historical["stale"], true);
    let fixed = data(call(
        &k,
        "documents.get",
        json!({"document_id":historical["document"]["document_id"]}),
    ));
    assert!(fixed["content"].as_str().unwrap().contains(".地点待补充"));
    assert!(!fixed["content"].as_str().unwrap().contains("新结构"));
}

#[test]
fn script_author_boundary_rejects_bad_evidence_and_unrepresentable_headings() {
    let (root, k, p, _docs) = setup();
    let s = build(&k, &p, "raw");
    let agent = Kernel::open(json!({"workspace_path":root.path(),"mode":"agent"})).unwrap();
    assert_eq!(
        call(
            &agent,
            "drama.create_script",
            script_input(&s, "en", "denied")
        )["error"]["code"],
        "forbidden"
    );
    let mut wrong = script_input(&s, "en", "wrong");
    wrong["skeleton_ref"]["sha256"] = json!("0".repeat(64));
    assert_eq!(
        call(&k, "drama.create_script", wrong)["error"]["code"],
        "hetu.stale_evidence"
    );
    for title in [
        "\n@人物\n台词",
        "标题 [[隐藏]]",
        "标题 #场号#",
        "标题\u{2028}新行",
    ] {
        let mut input = script_input(&s, "en", "unsafe-title");
        input["title"] = json!(title);
        assert_eq!(
            call(&k, "drama.create_script", input)["error"]["code"],
            "hetu.format_unrepresentable"
        );
    }
    let docs = data(call(&k, "documents.list", json!({"kind":"drama_script"})));
    assert!(docs["documents"].as_array().unwrap().is_empty());
    let partial = call(
        &k,
        "plot.extract",
        json!({"document_revisions":p["source_revisions"].as_array().unwrap().iter().map(|s|json!({"document_id":s["document_id"],"revision_id":s["revision_id"],"sha256":s["sha256"]})).collect::<Vec<_>>(),"blueprint_revision":2,"options":{"max_nodes":1},"save_result":true,"operation_key":"partial-script-source"}),
    );
    let partial_skeleton = build(&k, &partial["data"]["plot"], "partial-skeleton");
    let result = call(
        &k,
        "drama.create_script",
        script_input(&partial_skeleton, "en", "partial-script"),
    );
    assert_eq!(result["status"], "partial");
    let read = call(
        &agent,
        "drama.get_script_mapping",
        json!({"document_id":result["data"]["document"]["document_id"]}),
    );
    assert_eq!(read["status"], "partial");
}

#[test]
fn script_mapping_and_fixed_text_tampering_fail_closed() {
    let (root, k, p, _docs) = setup();
    let s = build(&k, &p, "raw");
    let created = data(call(
        &k,
        "drama.create_script",
        script_input(&s, "en", "script"),
    ));
    let path = created["document"]["structure_origin"]["mapping_path"]
        .as_str()
        .unwrap();
    std::fs::write(root.path().join(path), b"{}").unwrap();
    assert_eq!(
        call(
            &k,
            "drama.get_script_mapping",
            json!({"document_id":created["document"]["document_id"]})
        )["error"]["code"],
        "hetu.integrity_failure"
    );
    let another = data(call(
        &k,
        "drama.create_script",
        script_input(&s, "en", "another"),
    ));
    let content = another["revision"]["content_path"].as_str().unwrap();
    std::fs::write(root.path().join(content), b"rewritten").unwrap();
    assert_eq!(
        call(
            &k,
            "drama.get_script_mapping",
            json!({"document_id":another["document"]["document_id"]})
        )["error"]["code"],
        "hetu.integrity_failure"
    );
}
fn edit_input(s: &Value, changes: Value, key: &str) -> Value {
    json!({"skeleton_id":s["skeleton"]["skeleton_id"],"expected":{"revision":s["skeleton"]["revision"],"sha256":s["sha256"]},"typed_changes":changes,"operation_key":key})
}
fn scene_update(scene: &Value, day: &str) -> Value {
    json!({"type":"update_scene","scene_id":scene["scene_id"],"title":"夜访","location_ref":scene["location_ref"],"interior_exterior":scene["interior_exterior"],"time_of_day":day,"character_refs":scene["character_refs"],"adaptation_note":"作者保留的改编说明"})
}
fn compare_input(s: &Value, sources: &Value, key: Option<&str>) -> Value {
    let mut input = json!({"skeleton_ref":{"skeleton_id":s["skeleton"]["skeleton_id"],"revision":s["skeleton"]["revision"],"sha256":s["sha256"]},"source_revisions":sources,"save_result":key.is_some()});
    if let Some(key) = key {
        input["operation_key"] = json!(key);
    }
    input
}

#[test]
fn skeleton_uses_only_confirmed_associations_and_preserves_unknown_and_exact_sources() {
    let (_root, k, p, docs) = setup();
    let raw = build(&k, &p, "raw");
    for scene in raw["skeleton"]["episodes"][0]["scenes"].as_array().unwrap() {
        assert!(scene["location_ref"].is_null());
        assert_eq!(scene["time_of_day"], "unknown");
        assert_eq!(scene["interior_exterior"], "unknown");
        assert_eq!(scene["character_refs"], json!([]));
        assert_eq!(scene["dialogue"], "");
        assert_eq!(scene["shot_description"], "");
        assert!(
            scene["missing_fields"]
                .as_array()
                .unwrap()
                .contains(&json!("author_review"))
        );
    }
    let p = confirmed(&k, &p, &docs);
    let s = build(&k, &p, "confirmed");
    let scenes = s["skeleton"]["episodes"][0]["scenes"].as_array().unwrap();
    assert_eq!(scenes.len(), 2);
    assert_eq!(scenes[0]["location_ref"], TOWER);
    assert_eq!(scenes[0]["time_of_day"], "night");
    assert_eq!(scenes[1]["location_ref"], HOME);
    assert_eq!(scenes[1]["time_of_day"], "unknown");
    for scene in scenes {
        assert_eq!(scene["dialogue"], "");
        assert_eq!(scene["shot_description"], "");
        for source in scene["source_refs"].as_array().unwrap() {
            let doc = docs
                .iter()
                .find(|d| d["document"]["document_id"] == source["document_id"])
                .unwrap();
            let loaded = data(call(
                &k,
                "documents.get",
                json!({"document_id":doc["document"]["document_id"],"revision_id":doc["revision"]["revision_id"]}),
            ));
            let content = loaded["content"].as_str().unwrap();
            assert_eq!(
                content.get(
                    source["byte_start"].as_u64().unwrap() as usize
                        ..source["byte_end"].as_u64().unwrap() as usize
                ),
                source["quote"].as_str()
            );
        }
    }
    let second = scenes[1]["plot_node_refs"][0].clone();
    let split = data(call(
        &k,
        "drama.build_skeleton",
        json!({"plot_revision_id":p["plot_revision_id"],"blueprint_revision":2,"episode_options":{"episode_start_node_ids":[second]},"operation_key":"anchors"}),
    ));
    assert_eq!(split["skeleton"]["episodes"].as_array().unwrap().len(), 2);
    assert_eq!(
        data(call(
            &k,
            "drama.get_skeleton",
            json!({"skeleton_id":s["skeleton"]["skeleton_id"]})
        ))["skeleton"],
        s["skeleton"]
    );
}

#[test]
fn author_split_merge_reorder_keep_stable_identity_and_cas_replays_before_current_head() {
    let (_root, k, p, docs) = setup();
    let p = confirmed(&k, &p, &docs);
    let s = build(&k, &p, "initial");
    let first = s["skeleton"]["episodes"][0]["scenes"][0].clone();
    let request = edit_input(
        &s,
        json!([{"type":"split_scene","scene_id":first["scene_id"],"at_node_id":first["plot_node_refs"][1]}]),
        "split",
    );
    let response = call(&k, "drama.edit_skeleton", request.clone());
    let split = data(response.clone());
    let scenes = &split["skeleton"]["episodes"][0]["scenes"];
    assert_eq!(scenes.as_array().unwrap().len(), 3);
    assert_eq!(scenes[0]["scene_id"], first["scene_id"]);
    assert_ne!(scenes[1]["scene_id"], first["scene_id"]);
    let merged = data(call(
        &k,
        "drama.edit_skeleton",
        edit_input(
            &split,
            json!([{"type":"merge_scene","scene_id":scenes[0]["scene_id"],"with_scene_id":scenes[1]["scene_id"]}]),
            "merge",
        ),
    ));
    assert_eq!(
        merged["skeleton"]["episodes"][0]["scenes"][0]["scene_id"],
        first["scene_id"]
    );
    assert_eq!(
        merged["skeleton"]["episodes"][0]["scenes"][0]["plot_node_refs"],
        first["plot_node_refs"]
    );
    assert_eq!(call(&k, "drama.edit_skeleton", request.clone()), response);
    let mut obsolete = request.clone();
    obsolete["operation_key"] = json!("obsolete");
    assert_eq!(
        call(&k, "drama.edit_skeleton", obsolete)["error"]["code"],
        "revision_conflict"
    );
    let mut wrong = request;
    wrong["typed_changes"][0]["at_node_id"] = first["plot_node_refs"][0].clone();
    assert_eq!(
        call(&k, "drama.edit_skeleton", wrong)["error"]["code"],
        "idempotency_conflict"
    );
    let ep = merged["skeleton"]["episodes"][0].clone();
    let split_ep = data(call(
        &k,
        "drama.edit_skeleton",
        edit_input(
            &merged,
            json!([{"type":"split_episode","episode_id":ep["episode_id"],"at_scene_id":ep["scenes"][1]["scene_id"]}]),
            "split-ep",
        ),
    ));
    assert_eq!(
        split_ep["skeleton"]["episodes"][0]["episode_id"],
        ep["episode_id"]
    );
    let moved = data(call(
        &k,
        "drama.edit_skeleton",
        edit_input(
            &split_ep,
            json!([{"type":"move_episode","episode_id":split_ep["skeleton"]["episodes"][1]["episode_id"],"index":0}]),
            "move-ep",
        ),
    ));
    assert_eq!(
        moved["skeleton"]["episodes"][0]["scenes"][0]["scene_id"],
        ep["scenes"][1]["scene_id"]
    );
    let original = data(call(
        &k,
        "drama.get_skeleton",
        json!({"skeleton_id":s["skeleton"]["skeleton_id"],"revision":1}),
    ));
    assert_eq!(original["skeleton"], s["skeleton"]);
    let rebuild = build(&k, &p, "rebuild");
    assert_ne!(
        rebuild["skeleton"]["skeleton_id"],
        s["skeleton"]["skeleton_id"]
    );
}

#[test]
fn comparison_distinguishes_structural_changes_and_unmapped_text_without_rewriting_sources() {
    let (root, k, p, docs) = setup();
    let p = confirmed(&k, &p, &docs);
    let s = build(&k, &p, "initial");
    let ep = &s["skeleton"]["episodes"][0];
    let scene = &ep["scenes"][0];
    let reversed: Vec<_> = scene["plot_node_refs"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .cloned()
        .collect();
    let changed = data(call(
        &k,
        "drama.edit_skeleton",
        edit_input(
            &s,
            json!([
                {"type":"set_scene_nodes","scene_id":scene["scene_id"],"plot_node_refs":reversed},
                scene_update(scene,"day"),
                {"type":"remove_scene","scene_id":ep["scenes"][1]["scene_id"]},
                {"type":"add_scene","episode_id":ep["episode_id"],"index":1,"plot_node_refs":[]}
            ]),
            "changes",
        ),
    ));
    let mut sources = changed["skeleton"]["source_revisions"].clone();
    let saved_doc = data(call(
        &k,
        "documents.save",
        json!({"document_id":docs[0]["document"]["document_id"],"base_revision_id":docs[0]["revision"]["revision_id"],"source_format":"markdown","content":"# 改写后的章节\n\n林舟推门。\n","operation_key":"new-source"}),
    ));
    sources[0] = json!({"document_id":saved_doc["document"]["document_id"],"revision_id":saved_doc["revision"]["revision_id"],"sha256":saved_doc["revision"]["sha256"],"source_format":"markdown","size_bytes":saved_doc["revision"]["size_bytes"]});
    let preview = data(call(
        &k,
        "drama.compare",
        compare_input(&changed, &sources, None),
    ));
    assert_eq!(preview["saved"], false);
    assert!(!root.path().join(".hetu/comparisons").exists());
    let kinds: std::collections::BTreeSet<_> = preview["comparison"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["kind"].as_str().unwrap())
        .collect();
    assert_eq!(
        kinds,
        std::collections::BTreeSet::from([
            "added",
            "omitted",
            "reordered",
            "modified",
            "unmapped",
            "stale_source"
        ])
    );
    assert_eq!(preview["stale"], true);
    let request = compare_input(&changed, &sources, Some("comparison"));
    let first = call(&k, "drama.compare", request.clone());
    let report = data(first.clone());
    assert_eq!(call(&k, "drama.compare", request), first);
    let read = data(call(
        &k,
        "drama.get_comparison",
        json!({"comparison_id":report["comparison"]["comparison_id"]}),
    ));
    assert_eq!(read["comparison"], report["comparison"]);
    let updated = data(call(
        &k,
        "drama.edit_skeleton",
        edit_input(
            &changed,
            json!([{"type":"update_episode","episode_id":ep["episode_id"],"title":"第一集"}]),
            "title",
        ),
    ));
    assert!(
        updated["skeleton"]["revision"].as_u64().unwrap()
            > changed["skeleton"]["revision"].as_u64().unwrap()
    );
    let old = data(call(
        &k,
        "drama.get_comparison",
        json!({"comparison_id":report["comparison"]["comparison_id"]}),
    ));
    assert_eq!(old["comparison"], report["comparison"]);
    assert!(
        old["stale_reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["code"] == "skeleton_changed")
    );
}

#[test]
fn partial_inputs_and_agent_permissions_remain_explicit() {
    let (root, k, p, _docs) = setup();
    let partial = call(
        &k,
        "plot.extract",
        json!({"document_revisions":p["source_revisions"].as_array().unwrap().iter().map(|s|json!({"document_id":s["document_id"],"revision_id":s["revision_id"],"sha256":s["sha256"]})).collect::<Vec<_>>(),"blueprint_revision":2,"options":{"max_nodes":1},"save_result":true,"operation_key":"partial"}),
    );
    assert_eq!(partial["status"], "partial");
    let agent = Kernel::open(json!({"workspace_path":root.path(),"mode":"agent"})).unwrap();
    let built = call(
        &agent,
        "drama.build_skeleton",
        json!({"plot_revision_id":partial["data"]["plot"]["plot_revision_id"],"blueprint_revision":2,"episode_options":{},"operation_key":"partial-build"}),
    );
    assert_eq!(built["status"], "partial");
    let s = data(built);
    let denied = call(
        &agent,
        "drama.edit_skeleton",
        edit_input(&s, json!([{"type":"add_episode","index":1}]), "denied"),
    );
    assert_eq!(denied["error"]["code"], "forbidden");
    let compared = call(
        &agent,
        "drama.compare",
        compare_input(&s, &s["skeleton"]["source_revisions"], None),
    );
    assert_eq!(compared["status"], "partial");
    let mut invalid = compare_input(&s, &s["skeleton"]["source_revisions"], None);
    invalid["operation_key"] = json!("not-permitted");
    assert_eq!(
        call(&k, "drama.compare", invalid)["error"]["code"],
        "invalid_input"
    );
    let mut wrong = json!({"plot_revision_id":p["plot_revision_id"],"blueprint_revision":1,"episode_options":{},"operation_key":"wrong-bp"});
    assert_eq!(
        call(&k, "drama.build_skeleton", wrong.clone())["error"]["code"],
        "hetu.stale_evidence"
    );
    wrong["blueprint_revision"] = json!(2);
    wrong["episode_options"] =
        json!({"episode_start_node_ids":["node_99999999-9999-4999-8999-999999999999"]});
    assert_eq!(
        call(&k, "drama.build_skeleton", wrong)["error"]["code"],
        "invalid_input"
    );
}

#[test]
fn revisions_pagination_and_integrity_checks_never_accept_tampered_history() {
    let (root, k, p, _docs) = setup();
    let s = build(&k, &p, "initial");
    let ep = &s["skeleton"]["episodes"][0];
    let updated = data(call(
        &k,
        "drama.edit_skeleton",
        edit_input(
            &s,
            json!([{"type":"update_episode","episode_id":ep["episode_id"],"title":"序章"}]),
            "rename",
        ),
    ));
    let page = data(call(&k, "drama.list_skeletons", json!({"limit":1})));
    assert_eq!(page["skeletons"].as_array().unwrap().len(), 1);
    let cursor = page["next_cursor"].clone();
    assert!(cursor.is_string());
    let next = data(call(
        &k,
        "drama.list_skeletons",
        json!({"limit":1,"cursor":cursor}),
    ));
    assert_eq!(next["skeletons"].as_array().unwrap().len(), 1);
    build(&k, &p, "another");
    assert_eq!(
        call(&k, "drama.list_skeletons", json!({"cursor":cursor}))["error"]["code"],
        "cursor_invalid"
    );
    let source_path = root.path().join(format!(
        "packages/drama/skeletons/{}/1.json",
        s["skeleton"]["skeleton_id"].as_str().unwrap()
    ));
    std::fs::write(source_path, b"{}").unwrap();
    assert_eq!(
        call(
            &k,
            "drama.get_skeleton",
            json!({"skeleton_id":s["skeleton"]["skeleton_id"],"revision":1})
        )["error"]["code"],
        "hetu.integrity_failure"
    );
    assert_eq!(
        call(
            &k,
            "drama.get_skeleton",
            json!({"skeleton_id":updated["skeleton"]["skeleton_id"]})
        )["error"]["code"],
        "hetu.integrity_failure"
    );
}

#[test]
fn manual_empty_scenes_and_source_mapping_are_author_only_and_do_not_duplicate_nodes() {
    let (_root, k, p, _docs) = setup();
    let s = build(&k, &p, "initial");
    let ep = &s["skeleton"]["episodes"][0];
    let invalid = edit_input(
        &s,
        json!([{"type":"add_scene","episode_id":ep["episode_id"],"index":0,"plot_node_refs":ep["scenes"][0]["plot_node_refs"]}]),
        "duplicate",
    );
    assert_eq!(
        call(&k, "drama.edit_skeleton", invalid)["error"]["code"],
        "invalid_input"
    );
    let added = data(call(
        &k,
        "drama.edit_skeleton",
        edit_input(&s, json!([{"type":"add_episode","index":1}]), "manual"),
    ));
    let scene = &added["skeleton"]["episodes"][1]["scenes"][0];
    assert_eq!(scene["source_refs"], json!([]));
    assert!(
        scene["missing_fields"]
            .as_array()
            .unwrap()
            .contains(&json!("source_mapping"))
    );
    let moved = data(call(
        &k,
        "drama.edit_skeleton",
        edit_input(
            &added,
            json!([{"type":"move_scene","scene_id":ep["scenes"][0]["scene_id"],"episode_id":added["skeleton"]["episodes"][1]["episode_id"],"index":0}]),
            "move",
        ),
    ));
    assert_eq!(
        moved["skeleton"]["episodes"][1]["scenes"][0]["scene_id"],
        ep["scenes"][0]["scene_id"]
    );
}
