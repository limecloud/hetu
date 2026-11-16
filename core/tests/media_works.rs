use base64::{Engine, engine::general_purpose::STANDARD};
use hetu_core::{Kernel, application::extensions::PluginSession, collaboration::CollaborationHub};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(v: Value) -> Value {
    assert_eq!(v["status"], "succeeded", "{v}");
    v["data"].clone()
}
fn setup() -> (tempfile::TempDir, Kernel, Value, Value) {
    let root = tempfile::tempdir().unwrap();
    let k = Kernel::open(
        json!({"workspace_path":root.path().join("作品"),"mode":"author",
        "create":{"title":"渡口","locale":"zh-CN","operation_key":"init"}}),
    )
    .unwrap();
    let work = ok(call(&k, "works.list", json!({})))["works"][0]["work_ref"].clone();
    let other = ok(call(&k, "video.projects.create", json!({"title":"同名作品","brief":"独立视频","language_tag":"zh-CN","operation_key":"video"})))["work_ref"].clone();
    (root, k, work, other)
}
fn import_input(k: &Kernel, work: &Value, key: &str) -> Value {
    // 与历史媒体测试相同的完整1×1 PNG；签名识别不冒充解码验收。
    let hex = "89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c020000000b4944415478da6364f80f00010501012718e3660000000049454e44ae426082";
    let bytes: Vec<u8> = (0..hex.len())
        .step_by(2)
        .map(|n| u8::from_str_radix(&hex[n..n + 2], 16).unwrap())
        .collect();
    let inline = json!({"filename":"渡口🌿.png","base64":STANDARD.encode(&bytes),"sha256":format!("{:x}",Sha256::digest(&bytes))});
    let scan = ok(call(k, "assets.inspect", json!({"inline_source":inline})));
    let mut input = json!({"inline_source":inline,"expected_file":{"sha256":scan["sha256"],"size_bytes":scan["size_bytes"]},
        "title":key,"source":{"source_type":"author_supplied","creator_statement":"作者提供"},"rights_status":"unknown",
        "redistribution_allowed":false,"rights_statement":"","operation_key":key});
    if work.is_object() {
        input["work_ref"] = work.clone();
    }
    input
}
fn asset(k: &Kernel, work: &Value, key: &str) -> Value {
    ok(call(k, "assets.import", import_input(k, work, key)))
}
fn asset_ref(v: &Value) -> Value {
    json!({"asset_id":v["asset"]["asset_id"],"revision":v["asset"]["revision"],"sha256":v["sha256"]})
}
fn update(v: &Value, key: &str) -> Value {
    let a = &v["asset"];
    json!({"asset_id":a["asset_id"],"expected":{"revision":a["revision"],"sha256":v["sha256"]},"title":key,
        "source":a["source"],"rights_status":a["rights_status"],"redistribution_allowed":a["redistribution_allowed"],
        "rights_statement":a["rights_statement"],"operation_key":key})
}
fn cue(work: &Value, assets: Value, sources: Value, key: &str) -> Value {
    let mut v = json!({"kind":"visual","title":key,"description":"渡口雨夜🌿","narrative_refs":sources,"asset_refs":assets,"archived":false,"operation_key":key});
    if work.is_object() {
        v["work_ref"] = work.clone();
    }
    v
}
fn grant(k: &Kernel, root: &std::path::Path, w: &Value) -> (CollaborationHub, Value) {
    let dir = root.join("授权");
    let r = ok(call(k,"collaboration.authorize_workspace",json!({"work_ref":w,"client_adapter":"codex","collaboration_path":dir,"operation_key":"grant"})))["management_ref"].clone();
    (CollaborationHub::open(&dir, "codex").unwrap(), r)
}
fn agent(h: &CollaborationHub, g: &Value, a: &str, mut i: Value) -> Value {
    i["management_ref"] = g.clone();
    h.request(json!({"action":format!("hetu.{a}"),"contract_revision":"1","input":i}))
}

#[test]
fn exact_media_reads_exclude_siblings_and_legacy_and_bind_cursors_to_work() {
    let (root, k, work, other) = setup();
    let owned = asset(&k, &work, "当前素材");
    asset(&k, &work, "当前素材二");
    let foreign = asset(&k, &other, "同名素材");
    let legacy = asset(&k, &Value::Null, "历史未归属");
    assert_eq!(owned["asset"]["schema_version"], "2.0.0");
    assert_eq!(legacy["asset"]["schema_version"], "1.0.0");
    let (h, g) = grant(&k, root.path(), &work);
    for name in ["assets.list", "cues.list"] {
        assert_eq!(agent(&h, &g, name, json!({}))["error"]["code"], "forbidden");
        assert_eq!(
            agent(&h, &g, name, json!({"work_ref":other}))["error"]["code"],
            "forbidden"
        );
    }
    let page = ok(agent(
        &h,
        &g,
        "assets.list",
        json!({"work_ref":work,"limit":1}),
    ));
    assert_eq!(page["assets"].as_array().unwrap().len(), 1);
    assert!(page["next_cursor"].is_string());
    assert_eq!(
        call(
            &k,
            "assets.list",
            json!({"work_ref":other,"limit":1,"cursor":page["next_cursor"]})
        )["error"]["code"],
        "cursor_invalid"
    );
    for denied in [&foreign, &legacy] {
        assert_eq!(
            agent(
                &h,
                &g,
                "assets.get",
                json!({"asset_id":denied["asset"]["asset_id"]})
            )["error"]["code"],
            "forbidden"
        );
    }
    assert_eq!(
        ok(agent(
            &h,
            &g,
            "assets.get",
            json!({"asset_id":owned["asset"]["asset_id"]})
        ))["asset"],
        owned["asset"]
    );
    let caps = ok(agent(&h, &g, "capabilities.get", json!({})));
    for action in ["hetu.assets.list", "hetu.cues.list", "hetu.assets.inspect"] {
        let a = caps["actions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["name"] == action)
            .unwrap();
        assert_eq!(a["input_schema"]["properties"]["work_ref"]["const"], work);
        jsonschema::validator_for(&a["input_schema"]).unwrap();
    }
    let handoff = ok(agent(
        &h,
        &g,
        "handoffs.get",
        json!({"view_kind":"media","object_ref":{"work_ref":work,"asset_id":owned["asset"]["asset_id"],"revision":1}}),
    ));
    assert!(
        handoff["fixed_refs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["kind"] == "asset" && r["work_ref"] == work)
    );
    ok(call(
        &k,
        "collaboration.revoke_management",
        json!({"grant_id":g["grant_id"],"client_adapter":"codex","collaboration_path":root.path().join("授权"),"operation_key":"revoke"}),
    ));
    assert_eq!(
        agent(
            &h,
            &g,
            "assets.get",
            json!({"asset_id":owned["asset"]["asset_id"]})
        )["error"]["code"],
        "forbidden"
    );
}

#[test]
fn inline_media_import_is_reviewed_then_executed_by_original_agent_and_replayed_once() {
    let (root, k, work, other) = setup();
    let (h, g) = grant(&k, root.path(), &work);
    let input = import_input(&k, &work, "原素材");
    ok(agent(
        &h,
        &g,
        "assets.inspect",
        json!({"work_ref":work,"inline_source":input["inline_source"]}),
    ));
    assert_eq!(
        agent(
            &h,
            &g,
            "assets.inspect",
            json!({"work_ref":work,"file_path":"/not-authorized.png"})
        )["error"]["code"],
        "forbidden"
    );
    let mut foreign = input.clone();
    foreign["work_ref"] = other.clone();
    assert_eq!(
        agent(
            &h,
            &g,
            "agent_operations.prepare",
            json!({"action":"hetu.assets.import","input":foreign,"summary":"不能跨作品","operation_key":"foreign"})
        )["error"]["code"],
        "forbidden"
    );
    let p = ok(agent(
        &h,
        &g,
        "agent_operations.prepare",
        json!({"action":"hetu.assets.import","input":input,"summary":"导入原素材","operation_key":"proposal"}),
    ));
    let execute = json!({"proposal_id":p["proposal_id"],"proposal_sha256":p["proposal_sha256"],"operation_key":"execute"});
    assert_eq!(
        agent(&h, &g, "agent_operations.execute", execute.clone())["error"]["code"],
        "hetu.author_confirmation_required"
    );
    assert_eq!(
        ok(agent(&h, &g, "assets.list", json!({"work_ref":work})))["assets"],
        json!([])
    );
    ok(call(
        &k,
        "agent_operations.decide",
        json!({"proposal_id":p["proposal_id"],"proposal_sha256":p["proposal_sha256"],"expected_state_revision":1,"decision":"approve","operation_key":"approve"}),
    ));
    let receipt = agent(&h, &g, "agent_operations.execute", execute.clone());
    let done = ok(receipt.clone());
    assert_eq!(done["result"]["asset"]["work_ref"], work);
    assert!(
        done["result"]["asset"]["actor_ref"]
            .as_str()
            .unwrap()
            .starts_with("actor_")
    );
    drop(h);
    let h = CollaborationHub::open(&root.path().join("授权"), "codex").unwrap();
    assert_eq!(agent(&h, &g, "agent_operations.execute", execute), receipt);
    assert_eq!(
        ok(agent(&h, &g, "assets.list", json!({"work_ref":work})))["assets"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let mut changed = update(&done["result"], "改归属");
    changed["work_ref"] = other;
    assert_eq!(
        call(&k, "assets.update", changed)["error"]["code"],
        "forbidden"
    );
    let revised = ok(call(&k, "assets.update", update(&done["result"], "更名")));
    assert_eq!(revised["asset"]["work_ref"], work);
    assert_eq!(revised["asset"]["blob"], done["result"]["asset"]["blob"]);
}

#[test]
fn cue_sources_are_fixed_to_same_work_and_owner_cannot_be_migrated() {
    let (_root, k, work, other) = setup();
    let a = asset(&k, &work, "作品素材");
    let b = asset(&k, &other, "他作品素材");
    let legacy = asset(&k, &Value::Null, "旧素材");
    let doc = ok(call(
        &k,
        "documents.create",
        json!({"kind":"novel_chapter","title":"渡口","source_format":"markdown","content":"江岚🌿","operation_key":"doc"}),
    ));
    let source = json!({"document_id":doc["document"]["document_id"],"revision_id":doc["revision"]["revision_id"],"byte_start":0,"byte_end":"江岚🌿".len(),"quote":"江岚🌿"});
    let saved = ok(call(
        &k,
        "cues.save",
        cue(&work, json!([asset_ref(&a)]), json!([source]), "scene"),
    ));
    assert_eq!(saved["cue"]["work_ref"], work);
    for foreign in [&b, &legacy] {
        assert_eq!(
            call(
                &k,
                "cues.save",
                cue(&work, json!([asset_ref(foreign)]), json!([]), "foreign")
            )["error"]["code"],
            "forbidden"
        );
    }
    assert_eq!(
        call(
            &k,
            "cues.save",
            cue(
                &other,
                json!([asset_ref(&b)]),
                json!([source]),
                "foreign-document"
            )
        )["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        call(
            &k,
            "cues.save",
            cue(
                &Value::Null,
                json!([asset_ref(&a)]),
                json!([]),
                "legacy-new-source"
            )
        )["error"]["code"],
        "forbidden"
    );
    let mut edit = cue(&other, json!([]), json!([]), "move-cue");
    edit["cue_id"] = saved["cue"]["cue_id"].clone();
    edit["expected"] = json!({"revision":1,"sha256":saved["sha256"]});
    assert_eq!(
        call(&k, "cues.save", edit.clone())["error"]["code"],
        "forbidden"
    );
    edit["work_ref"] = work.clone();
    let archived = ok(call(&k, "cues.save", edit));
    assert_eq!(archived["cue"]["revision"], 2);
    assert_eq!(
        ok(call(
            &k,
            "cues.get",
            json!({"cue_id":saved["cue"]["cue_id"],"revision":1})
        ))["cue"],
        saved["cue"]
    );
    let mut upgrade = update(&legacy, "不能自动迁移");
    upgrade["work_ref"] = work;
    assert_eq!(
        call(&k, "assets.update", upgrade)["error"]["code"],
        "forbidden"
    );
}

#[test]
fn plugins_can_bind_fixed_owned_media_sources_without_gaining_asset_access() {
    let (root, k, work, other) = setup();
    let a = asset(&k, &work, "固定素材");
    let b = asset(&k, &other, "他作品素材");
    let c = ok(call(
        &k,
        "cues.save",
        cue(&work, json!([asset_ref(&a)]), json!([]), "固定线索"),
    ));
    let sources = json!([
        {"kind":"asset","work_ref":work,"asset_id":a["asset"]["asset_id"],"revision":1,"sha256":a["sha256"]},
        {"kind":"cue","work_ref":work,"cue_id":c["cue"]["cue_id"],"revision":1,"sha256":c["sha256"]}
    ]);
    let dir = root.path().join("插件授权");
    let grant = ok(k.extension_host_request_in(&dir,json!({"method":"authorize","params":{"work_ref":work,"plugin_id":"org.hetu.media","package_sha256":"a".repeat(64),"permissions":["objects.read","objects.write"],"types":[{"kind":"scene","schema_version":"1","schema":{"type":"object"}}],"operation_key":"plugin"}})));
    let session = PluginSession::open(
        &root.path().join("作品"),
        &dir,
        grant["grant_id"].as_str().unwrap(),
        &"a".repeat(64),
    )
    .unwrap();
    let request = |input| json!({"action":"hetu.extensions.objects.save","contract_revision":"1","input":input});
    let input = json!({"work_ref":work,"kind":"scene","title":"固定场景","schema_version":"1","content":{},"source_refs":sources,"expected_revision":0,"expected_sha256":"","operation_key":"save"});
    let first = ok(session.request(request(input.clone())));
    assert_eq!(first["object"]["source_refs"], sources);
    assert_ne!(session.request(json!({"action":"hetu.assets.get","contract_revision":"1","input":{"asset_id":a["asset"]["asset_id"]}}))["status"],"succeeded");
    let mut bad = input.clone();
    bad["operation_key"] = json!("foreign");
    bad["source_refs"][0]["asset_id"] = b["asset"]["asset_id"].clone();
    assert_eq!(session.request(request(bad))["error"]["code"], "forbidden");
    let mut bad = input;
    bad["operation_key"] = json!("forged");
    bad["source_refs"][0]["sha256"] = json!("b".repeat(64));
    assert_eq!(
        session.request(request(bad))["error"]["code"],
        "hetu.stale_evidence"
    );
    ok(call(&k, "assets.update", update(&a, "新素材标题")));
    let exported = ok(k.extension_host_request_in(&dir,json!({"method":"read","params":{"work_ref":work,"plugin_id":"org.hetu.media","request":{"action":"hetu.extensions.objects.export","contract_revision":"1","input":{"work_ref":work,"object_id":first["object"]["object_id"],"format":"json"}}}})));
    assert_eq!(exported["object"]["source_refs"], sources);
}
