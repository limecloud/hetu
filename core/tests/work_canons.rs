use hetu_core::{Kernel, collaboration::CollaborationHub};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn call(k: &Kernel, name: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{name}"),"contract_revision":"1","input":input}))
}
fn ok(result: Value) -> Value {
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn setup(path: &std::path::Path) -> (Kernel, Value, Value) {
    let k = Kernel::open(json!({"workspace_path":path,"mode":"author","create":{"title":"雨夜旧站","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let n = ok(call(&k, "novels.get", json!({})));
    let nref = json!({"workspace_id":k.scope(),"kind":"novel","object_id":n["novel"]["novel_id"]});
    let d = ok(call(
        &k,
        "drama.projects.create",
        json!({"title":"雨夜旧站","operation_key":"drama"}),
    ));
    let dref =
        json!({"workspace_id":k.scope(),"kind":"drama","object_id":d["project"]["project_id"]});
    (k, nref, dref)
}
fn get(k: &Kernel, reference: &Value) -> Value {
    ok(call(k, "blueprints.get", json!({"work_ref":reference})))
}
fn expected(value: &Value) -> Value {
    json!({"blueprint_id":value["blueprint"]["blueprint_id"],"revision":value["revision"],"sha256":value["sha256"]})
}
fn change(name: &str) -> Value {
    json!([{"type":"upsert_character","entity":{"character_id":"character_11111111-1111-4111-8111-111111111111",
        "name":name,"aliases":[],"description":"一位守站人","traits":[],"facts":[],"archived":false}}])
}
fn save(k: &Kernel, reference: &Value, name: &str, key: &str) -> Value {
    ok(call(
        k,
        "blueprints.save",
        json!({"work_ref":reference,"expected":expected(&get(k,reference)),"typed_changes":change(name),"operation_key":key}),
    ))
}

#[test]
fn same_revision_different_canons_never_overwrite_or_reinterpret_each_other() {
    let root = tempfile::tempdir().unwrap();
    let (k, nref, dref) = setup(root.path());
    let video = ok(call(
        &k,
        "video.projects.create",
        json!({"title":"雨夜旧站","brief":"视频","language_tag":"zh-CN","operation_key":"video"}),
    ));
    let before_root = std::fs::read(root.path().join("shared/blueprint.json")).unwrap();
    let novel = get(&k, &nref);
    let drama = get(&k, &dref);
    let v = get(&k, &video["work_ref"]);
    assert_ne!(
        novel["blueprint"]["blueprint_id"],
        drama["blueprint"]["blueprint_id"]
    );
    assert_ne!(
        drama["blueprint"]["blueprint_id"],
        v["blueprint"]["blueprint_id"]
    );
    assert_eq!(novel["binding"]["storage"], "legacy");
    let draft = save(&k, &dref, "剧本中的阿青", "drama-v2");
    assert_eq!(get(&k, &nref), novel);
    assert_eq!(get(&k, &video["work_ref"]), v);
    assert_eq!(
        std::fs::read(root.path().join("shared/blueprint.json")).unwrap(),
        before_root
    );
    let original = save(&k, &nref, "原著中的阿青", "novel-v2");
    assert_eq!(original["revision"], draft["revision"]);
    assert_ne!(original["sha256"], draft["sha256"]);
    assert_eq!(
        get(&k, &dref)["blueprint"]["characters"][0]["name"],
        "剧本中的阿青"
    );
    assert_eq!(
        ok(call(
            &k,
            "blueprints.get",
            json!({"work_ref":dref,"revision":1})
        )),
        drama
    );
    assert_eq!(
        ok(call(&k, "blueprints.get", json!({"revision":2})))["blueprint"],
        original["blueprint"]
    );
    assert_eq!(
        call(
            &k,
            "blueprints.save",
            json!({"work_ref":dref,"expected":expected(&original),"typed_changes":change("误改"),"operation_key":"wrong-cas"})
        )["error"]["code"],
        "revision_conflict"
    );
    let locked = ok(call(
        &k,
        "blueprints.lock",
        json!({"work_ref":dref,"expected":expected(&get(&k,&dref)),"reason":"作者确认","operation_key":"lock"}),
    ));
    assert_eq!(get(&k, &nref)["blueprint"]["lock"]["locked"], false);
    assert_eq!(
        call(
            &k,
            "blueprints.preview_change",
            json!({"work_ref":dref,"expected":expected(&locked),"typed_changes":change("锁定误改")})
        )["error"]["code"],
        "hetu.blueprint_locked"
    );
    let mut foreign = dref.clone();
    foreign["workspace_id"] = json!("workspace_00000000-0000-4000-8000-000000000000");
    assert_eq!(
        call(&k, "blueprints.get", json!({"work_ref":foreign}))["error"]["code"],
        "forbidden"
    );
}

#[test]
fn fixed_canon_reads_resolve_same_numbered_histories_and_reject_wrong_owner_or_digest() {
    let root = tempfile::tempdir().unwrap();
    let (k, nref, dref) = setup(root.path());
    let original = save(&k, &nref, "原著旧名", "novel-v2");
    let adaptation = save(&k, &dref, "改编旧名", "drama-v2");
    save(&k, &nref, "原著新名", "novel-v3");
    save(&k, &dref, "改编新名", "drama-v3");
    for (reference, fixed) in [(&nref, &original), (&dref, &adaptation)] {
        let input = json!({"revision":2,"sha256":fixed["sha256"]});
        let read = ok(call(&k, "blueprints.get", input.clone()));
        assert_eq!(read["blueprint"], fixed["blueprint"]);
        let mut owned = input;
        owned["work_ref"] = reference.clone();
        assert_eq!(
            ok(call(&k, "blueprints.get", owned))["blueprint"],
            fixed["blueprint"]
        );
    }
    assert_eq!(
        ok(call(&k, "blueprints.get", json!({"revision":2})))["blueprint"],
        original["blueprint"]
    );
    assert_eq!(
        call(
            &k,
            "blueprints.get",
            json!({"work_ref":dref,"revision":2,"sha256":original["sha256"]})
        )["error"]["code"],
        "hetu.integrity_failure"
    );
    assert_eq!(
        call(
            &k,
            "blueprints.get",
            json!({"revision":3,"sha256":adaptation["sha256"]})
        )["error"]["code"],
        "hetu.integrity_failure"
    );
    assert_ne!(
        call(&k, "blueprints.get", json!({"sha256":adaptation["sha256"]}))["status"],
        "succeeded"
    );
    assert_eq!(
        call(
            &k,
            "blueprints.get",
            json!({"revision":2,"sha256":"0".repeat(64)})
        )["error"]["code"],
        "hetu.integrity_failure"
    );
}

#[test]
fn exact_grant_prepares_canon_changes_without_root_access_or_author_decision_power() {
    let root = tempfile::tempdir().unwrap();
    let (k, nref, dref) = setup(&root.path().join("works"));
    let grants = root.path().join("grants");
    let hub = CollaborationHub::open(&grants, "codex").unwrap();
    let grant=ok(call(&k,"collaboration.authorize_workspace",json!({"work_ref":dref,"client_adapter":"codex","collaboration_path":grants,"operation_key":"grant"})))["management_ref"].clone();
    let agent = |name: &str, mut input: Value| {
        input["management_ref"] = grant.clone();
        hub.request(json!({"action":format!("hetu.{name}"),"contract_revision":"1","input":input}))
    };
    assert_eq!(
        agent("blueprints.get", json!({}))["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        agent("blueprints.get", json!({"work_ref":nref}))["error"]["code"],
        "forbidden"
    );
    let bp = ok(agent("blueprints.get", json!({"work_ref":dref})));
    let root_bp = get(&k, &nref);
    assert_eq!(
        agent(
            "blueprints.get",
            json!({"revision":1,"sha256":root_bp["sha256"]})
        )["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        agent(
            "blueprints.get",
            json!({"work_ref":dref,"revision":1,"sha256":root_bp["sha256"]})
        )["error"]["code"],
        "hetu.integrity_failure"
    );
    let plan = ok(agent(
        "agent_operations.prepare",
        json!({"action":"hetu.blueprints.save","input":{"work_ref":dref,"expected":expected(&bp),"typed_changes":change("剧本改编人物"),"operation_key":"save"},"summary":"只更新剧本设定","operation_key":"plan"}),
    ));
    assert_eq!(get(&k, &dref)["blueprint"], bp["blueprint"]);
    assert_eq!(
        agent(
            "agent_operations.execute",
            json!({"proposal_id":plan["proposal_id"],"proposal_sha256":plan["proposal_sha256"],"operation_key":"premature"})
        )["error"]["code"],
        "hetu.author_confirmation_required"
    );
    ok(call(
        &k,
        "agent_operations.decide",
        json!({"proposal_id":plan["proposal_id"],"proposal_sha256":plan["proposal_sha256"],"expected_state_revision":plan["state_revision"],"decision":"approve","operation_key":"decision"}),
    ));
    let input = json!({"proposal_id":plan["proposal_id"],"proposal_sha256":plan["proposal_sha256"],"operation_key":"execute"});
    let receipt = ok(agent("agent_operations.execute", input.clone()));
    assert_eq!(receipt, ok(agent("agent_operations.execute", input)));
    assert_eq!(
        get(&k, &dref)["blueprint"]["characters"][0]["name"],
        "剧本改编人物"
    );
    assert!(
        get(&k, &nref)["blueprint"]["characters"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let handoff = ok(agent(
        "handoffs.get",
        json!({"view_kind":"bible","object_ref":{"work_ref":dref}}),
    ));
    assert_eq!(
        handoff["fixed_refs"][1]["blueprint_id"],
        bp["blueprint"]["blueprint_id"]
    );
    assert_eq!(
        agent(
            "blueprints.unlock",
            json!({"work_ref":dref,"expected":expected(&get(&k,&dref)),"reason":"越权","operation_key":"unlock"})
        )["error"]["code"],
        "hetu.capability_unavailable"
    );
    let preview = ok(agent(
        "creative_tasks.preview_prompt",
        json!({"scope_ref":{"kind":"workspace","id":k.scope()},"work_ref":dref,"task_kind":"artwork","brief":"剧本人物形象","input_refs":[{"kind":"blueprint","work_ref":dref,"blueprint_id":get(&k,&dref)["blueprint"]["blueprint_id"],"revision":2}],"client_adapter":"codex","language_tag":"zh-CN"}),
    ));
    assert_eq!(preview["prepare_input"]["work_ref"], dref);
    assert_eq!(
        agent(
            "creative_tasks.preview_prompt",
            json!({"scope_ref":{"kind":"workspace","id":k.scope()},"work_ref":dref,"task_kind":"artwork","brief":"越权输入","input_refs":[{"kind":"blueprint","revision":1}],"client_adapter":"codex","language_tag":"zh-CN"})
        )["error"]["code"],
        "forbidden"
    );
    ok(call(
        &k,
        "collaboration.revoke_management",
        json!({"grant_id":grant["grant_id"],"client_adapter":"codex","collaboration_path":grants,"operation_key":"revoke"}),
    ));
    assert_ne!(
        agent("blueprints.get", json!({"work_ref":dref}))["status"],
        "succeeded"
    );
}

#[test]
fn task_context_draft_and_diagnostics_keep_their_exact_own_canon_after_other_work_changes() {
    let root = tempfile::tempdir().unwrap();
    let (k, nref, dref) = setup(root.path());
    let bp = save(&k, &dref, "剧本人物", "drama-setting");
    let project = ok(call(
        &k,
        "drama.projects.get",
        json!({"project_id":dref["object_id"]}),
    ));
    let episode = ok(call(
        &k,
        "drama.episodes.create",
        json!({"project_ref":{"project_id":dref["object_id"],"revision":project["project"]["revision"],"sha256":project["sha256"]},"title":"第一集","plan":"雨夜","language_tag":"zh-CN","operation_key":"episode"}),
    ));
    let doc = ok(call(
        &k,
        "documents.get",
        json!({"document_id":episode["episode"]["document_id"]}),
    ));
    let source = json!({"kind":"blueprint","work_ref":dref,"blueprint_id":bp["blueprint"]["blueprint_id"],"revision":bp["revision"],"sha256":bp["sha256"]});
    let preview = ok(call(
        &k,
        "creative_tasks.preview_prompt",
        json!({"scope_ref":{"kind":"workspace","id":k.scope()},"work_ref":dref,"task_kind":"drama_draft","brief":"雨夜旧站，保持守站人设定。","input_refs":[source],"target_ref":{"document_id":doc["document"]["document_id"],"revision_id":doc["revision"]["revision_id"],"sha256":doc["revision"]["sha256"]},"client_adapter":"codex","language_tag":"zh-CN"}),
    ));
    let mut input = preview["prepare_input"].clone();
    input["operation_key"] = json!("prepare");
    let task = ok(call(&k, "creative_tasks.prepare", input));
    assert_eq!(
        task["request"]["input_snapshot"]["scope_context"]["blueprint_ref"]["work_ref"],
        dref
    );
    let agent = Kernel::open(
        json!({"workspace_path":root.path(),"mode":"agent","task_id":task["task_ref"]["task_id"]}),
    )
    .unwrap();
    let content = "INT. 候车室 - NIGHT\n\n雨打窗棂。守站人把最后一张车票压在灯下。\n\n守站人\n你等的车，昨天已经走了。\n";
    let submitted = ok(call(
        &agent,
        "creative_tasks.submit_result",
        json!({"task_ref":task["task_ref"],"request_sha256":task["request_sha256"],"candidates":[{"kind":"text","title":"第一集参考稿","source_format":"fountain","source_ref_indices":[0],"content":content}],"complete":true,"missing_items":[],"provenance":{"client":"test","skill_version":"1"},"operation_key":"submit"}),
    ));
    let draft_id = &submitted["submission"]["candidates"][0]["draft_ref"]["draft_id"];
    let draft = ok(call(&k, "drafts.get", json!({"draft_id":draft_id})))["draft"].clone();
    assert_eq!(draft["blueprint_ref"]["work_ref"], dref);
    for reference in [&nref, &dref] {
        let belongs = reference == &dref;
        let tasks = ok(call(
            &k,
            "creative_tasks.list",
            json!({"work_ref":reference}),
        ));
        assert_eq!(
            tasks["tasks"].as_array().unwrap().len(),
            usize::from(belongs)
        );
        let documents = ok(call(&k, "documents.list", json!({"work_ref":reference})));
        assert_eq!(
            documents["documents"].as_array().unwrap().len(),
            usize::from(belongs)
        );
        let drafts = ok(call(&k, "drafts.list", json!({"work_ref":reference})));
        assert_eq!(
            drafts["drafts"].as_array().unwrap().len(),
            usize::from(belongs)
        );
    }
    save(&k, &nref, "原著人物变化", "novel-setting");
    let report = ok(call(
        &k,
        "reviews.validate",
        json!({"draft_id":draft_id,"expected_draft_revision":draft["revision"],"plot_options":{},"validation_options":{},"operation_key":"validate"}),
    ));
    assert_eq!(
        report["report"]["input_snapshot"]["blueprint_sha256"],
        bp["sha256"]
    );
    assert_eq!(report["stale"], false);
    ok(call(
        &k,
        "reports.get",
        json!({"report_id":report["report"]["report_id"]}),
    ));
    save(&k, &dref, "剧本人物更新", "drama-setting-v3");
    let reread = ok(call(
        &k,
        "reports.get",
        json!({"report_id":report["report"]["report_id"]}),
    ));
    assert_eq!(reread["stale"], true);
    assert_eq!(reread["report"], report["report"]);
    let context = ok(call(
        &agent,
        "task_context.list",
        json!({"task_ref":task["task_ref"]}),
    ));
    assert!(!context.is_null());
    let saved = ok(call(
        &k,
        "documents.save",
        json!({"document_id":doc["document"]["document_id"],"base_revision_id":doc["revision"]["revision_id"],"source_format":"fountain","content":content,"operation_key":"author-save"}),
    ));
    let current = get(&k, &dref);
    let author_draft = ok(call(
        &k,
        "drafts.submit_current",
        json!({"document_id":doc["document"]["document_id"],"base_revision_id":saved["revision"]["revision_id"],"blueprint_revision":current["revision"],"operation_key":"author-submit"}),
    ));
    assert_eq!(author_draft["draft"]["blueprint_ref"]["work_ref"], dref);
    assert_eq!(author_draft["draft"]["blueprint_sha256"], current["sha256"]);
}

#[test]
fn approved_canon_plan_ignores_other_work_but_conflicts_when_its_owner_changes() {
    let root = tempfile::tempdir().unwrap();
    let (k, nref, dref) = setup(root.path());
    let prepare = |key: &str| {
        ok(call(
            &k,
            "agent_operations.prepare",
            json!({"action":"hetu.blueprints.save",
        "input":{"work_ref":dref,"expected":expected(&get(&k,&dref)),"typed_changes":change("下一版人物"),"operation_key":format!("save-{key}")},
        "summary":"更新此剧本的人物","operation_key":key}),
        ))
    };
    let approve = |plan: &Value, key: &str| {
        ok(call(
            &k,
            "agent_operations.decide",
            json!({"proposal_id":plan["proposal_id"],
        "proposal_sha256":plan["proposal_sha256"],"expected_state_revision":plan["state_revision"],"decision":"approve","operation_key":key}),
        ))
    };
    let plan = prepare("first");
    approve(&plan, "approve-first");
    save(&k, &nref, "原著新人物", "novel-new");
    ok(call(
        &k,
        "agent_operations.execute",
        json!({"proposal_id":plan["proposal_id"],"proposal_sha256":plan["proposal_sha256"],"operation_key":"execute-first"}),
    ));
    let plan = prepare("second");
    approve(&plan, "approve-second");
    let project = ok(call(
        &k,
        "drama.projects.get",
        json!({"project_id":dref["object_id"]}),
    ));
    ok(call(
        &k,
        "drama.projects.update",
        json!({"project_ref":{"project_id":dref["object_id"],"revision":project["project"]["revision"],"sha256":project["sha256"]},
        "title":"雨夜旧站","description":"已归档","archived":true,"operation_key":"archive"}),
    ));
    assert_eq!(
        call(
            &k,
            "agent_operations.execute",
            json!({"proposal_id":plan["proposal_id"],"proposal_sha256":plan["proposal_sha256"],"operation_key":"execute-stale"})
        )["error"]["code"],
        "revision_conflict"
    );
    assert_eq!(get(&k, &dref)["revision"], 2);
}

#[test]
fn image_subject_cannot_reuse_same_entity_and_revision_from_a_different_work() {
    let root = tempfile::tempdir().unwrap();
    let (k, nref, dref) = setup(root.path());
    let novel = save(&k, &nref, "原著人物", "novel-character");
    let drama = save(&k, &dref, "改编人物", "drama-character");
    let input = json!({"scope_ref":{"kind":"workspace","id":k.scope()},"work_ref":dref,"task_kind":"artwork","brief":"单人正面图",
        "input_refs":[{"kind":"blueprint","work_ref":dref,"blueprint_id":drama["blueprint"]["blueprint_id"],"revision":2,"sha256":drama["sha256"]}],
        "client_adapter":"codex","language_tag":"zh-CN"});
    let preview = ok(call(&k, "creative_tasks.preview_prompt", input));
    let mut input = preview["prepare_input"].clone();
    input["operation_key"] = json!("artwork");
    let task = ok(call(&k, "creative_tasks.prepare", input));
    let agent = Kernel::open(
        json!({"workspace_path":root.path(),"mode":"agent","task_id":task["task_ref"]["task_id"]}),
    )
    .unwrap();
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(120, 180)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    std::fs::write(
        root.path()
            .join(
                task["request"]["output_contract"]["relative_inbox"]
                    .as_str()
                    .unwrap(),
            )
            .join("portrait.png"),
        png.get_ref(),
    )
    .unwrap();
    let subject = json!({"kind":"entity","entity_ref":"character_11111111-1111-4111-8111-111111111111","work_ref":dref,"blueprint_id":drama["blueprint"]["blueprint_id"],"blueprint_revision":2});
    let candidate = json!({"kind":"image","title":"单人形象","source_format":"image","source_ref_indices":[0],"file_name":"portrait.png",
        "sha256":format!("{:x}",Sha256::digest(png.get_ref())),"image_category":"character","image_view":"front","subject_refs":[subject]});
    let submit = |candidate: Value, key: &str| {
        call(
            &agent,
            "creative_tasks.submit_result",
            json!({"task_ref":task["task_ref"],"request_sha256":task["request_sha256"],
        "candidates":[candidate],"complete":true,"missing_items":[],"provenance":{"client":"test","skill_version":"1"},"operation_key":key}),
        )
    };
    let mut wrong = candidate.clone();
    wrong["subject_refs"][0]["work_ref"] = nref.clone();
    wrong["subject_refs"][0]["blueprint_id"] = novel["blueprint"]["blueprint_id"].clone();
    assert_eq!(
        submit(wrong, "cross-work")["error"]["code"],
        "hetu.invalid_source_ref"
    );
    let result = ok(submit(candidate, "own-image"));
    assert_eq!(
        result["submission"]["candidates"][0]["subject_refs"][0]["work_ref"],
        dref
    );
    assert_eq!(
        ok(call(&k, "creative_tasks.list", json!({"work_ref":nref})))["tasks"],
        json!([])
    );
}

#[test]
fn legacy_project_is_not_silently_bound_and_explicit_initialization_keeps_the_root() {
    let root = tempfile::tempdir().unwrap();
    let (k, _, dref) = setup(root.path());
    let bp = get(&k, &dref);
    // 仅移除隔离测试夹具中的新格式，复现旧版仅有根设定的剧本目录。
    std::fs::remove_dir_all(root.path().join(format!(
        "shared/work-canons/drama/{}",
        dref["object_id"].as_str().unwrap()
    )))
    .unwrap();
    std::fs::remove_file(root.path().join(format!(
        ".hetu/canon-revisions/{}.json",
        bp["sha256"].as_str().unwrap()
    )))
    .unwrap();
    let root_before = std::fs::read(root.path().join("shared/blueprint.json")).unwrap();
    assert_eq!(get(&k, &dref)["initialized"], false);
    assert_eq!(
        call(&k, "blueprints.get", json!({"work_ref":dref,"revision":1}))["error"]["code"],
        "not_found"
    );
    let handoff = ok(call(
        &k,
        "handoffs.get",
        json!({"view_kind":"bible","object_ref":{"work_ref":dref}}),
    ));
    assert!(
        handoff["proposal_actions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|action| action["name"] == "hetu.blueprints.initialize")
    );
    let input = json!({"work_ref":dref,"operation_key":"initialize"});
    let initialized = ok(call(&k, "blueprints.initialize", input.clone()));
    assert_eq!(initialized, ok(call(&k, "blueprints.initialize", input)));
    assert_ne!(
        initialized["blueprint"]["blueprint_id"],
        bp["blueprint"]["blueprint_id"]
    );
    assert_eq!(
        std::fs::read(root.path().join("shared/blueprint.json")).unwrap(),
        root_before
    );
    assert_eq!(
        call(
            &k,
            "blueprints.initialize",
            json!({"work_ref":dref,"operation_key":"second"})
        )["error"]["code"],
        "revision_conflict"
    );
    save(&k, &dref, "独立人物", "change");
    let path = root.path().join(format!(
        "shared/work-canons/drama/{}/revisions/1.json",
        dref["object_id"].as_str().unwrap()
    ));
    std::fs::write(path, b"{}").unwrap();
    assert_eq!(
        call(&k, "blueprints.get", json!({"work_ref":dref,"revision":1}))["error"]["code"],
        "hetu.integrity_failure"
    );
}
