use hetu_core::{Kernel, collaboration::CollaborationHub};
use serde_json::{Value, json};
fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(v: Value) -> Value {
    assert_eq!(v["status"], "succeeded", "{v}");
    v["data"].clone()
}
fn setup() -> (tempfile::TempDir, Kernel, Value) {
    let root = tempfile::tempdir().unwrap();
    let k = Kernel::open(
        json!({"workspace_path":root.path().join("作品"),"mode":"author",
        "create":{"title":"渡口","locale":"zh-CN","operation_key":"init"}}),
    )
    .unwrap();
    let work = ok(call(&k, "works.list", json!({})))["works"][0]["work_ref"].clone();
    (root, k, work)
}
fn fields(key: &str) -> Value {
    json!({"title":key,"category":"research","body":"渡口考据🌿\r\n保留原文。",
    "tags":["水文"],"project_id":null,"entity_refs":[],"source_notes":"作者笔记","operation_key":key})
}
fn resource(k: &Kernel, work: &Value, key: &str) -> Value {
    let mut i = fields(key);
    if !work.is_null() {
        i["work_ref"] = work.clone();
    }
    ok(call(k, "resources.create", i))
}
fn reference(r: &Value) -> Value {
    json!({"resource_id":r["resource"]["resource_id"],"revision":r["resource"]["revision"],"sha256":r["sha256"]})
}
fn expected(r: &Value) -> Value {
    json!({"revision":r["resource"]["revision"],"sha256":r["sha256"]})
}
fn drama(k: &Kernel, key: &str) -> Value {
    let p = ok(call(
        k,
        "drama.projects.create",
        json!({"title":"同名剧本","mode":"original","operation_key":key}),
    ));
    json!({"workspace_id":k.scope(),"kind":"drama","object_id":p["project"]["project_id"]})
}
fn grant(k: &Kernel, root: &std::path::Path, w: &Value) -> (CollaborationHub, Value) {
    let dir = root.join("授权");
    let r=ok(call(k,"collaboration.authorize_workspace",json!({"work_ref":w,"client_adapter":"codex","collaboration_path":dir,"operation_key":format!("grant-{}",w["object_id"])})))["management_ref"].clone();
    (CollaborationHub::open(&dir, "codex").unwrap(), r)
}
fn agent(h: &CollaborationHub, g: &Value, a: &str, mut i: Value) -> Value {
    i["management_ref"] = g.clone();
    h.request(json!({"action":format!("hetu.{a}"),"contract_revision":"1","input":i}))
}
#[test]
fn exact_work_reads_neither_siblings_nor_legacy_and_owner_never_changes() {
    let (root, k, novel) = setup();
    let d1 = drama(&k, "d1");
    let d2 = drama(&k, "d2");
    let video=ok(call(&k,"video.projects.create",json!({"title":"同名视频","brief":"独立视频","language_tag":"zh-CN","operation_key":"video"})))["work_ref"].clone();
    assert!(video.is_object());
    let owned = resource(&k, &novel, "同名资料");
    let others = [
        resource(&k, &d1, "剧本1"),
        resource(&k, &d2, "剧本2"),
        resource(&k, &video, "视频"),
        resource(&k, &Value::Null, "旧资料"),
    ];
    let (hub, g) = grant(&k, root.path(), &novel);
    let denied = agent(&hub, &g, "resources.list", json!({}));
    assert_eq!(denied["error"]["code"], "forbidden", "{denied}");
    let page = ok(agent(&hub, &g, "resources.list", json!({"work_ref":novel})));
    assert_eq!(page["resources"].as_array().unwrap().len(), 1);
    assert_eq!(
        page["resources"][0]["resource_id"],
        owned["resource"]["resource_id"]
    );
    for r in &others {
        for a in ["resources.get", "resource_usages.list"] {
            assert_eq!(
                agent(
                    &hub,
                    &g,
                    a,
                    json!({"resource_id":r["resource"]["resource_id"]})
                )["error"]["code"],
                "forbidden"
            );
        }
        assert_eq!(
            agent(
                &hub,
                &g,
                "handoffs.get",
                json!({"view_kind":"resource","object_ref":{"work_ref":novel,"resource_id":r["resource"]["resource_id"],"revision":1}})
            )["error"]["code"],
            "forbidden"
        );
    }
    let mut edit = fields("move");
    edit["resource_id"] = owned["resource"]["resource_id"].clone();
    edit["expected"] = expected(&owned);
    edit["work_ref"] = d1;
    assert_eq!(
        call(&k, "resources.update", edit)["error"]["code"],
        "forbidden"
    );
    let mut old = fields("old-move");
    old["resource_id"] = others[3]["resource"]["resource_id"].clone();
    old["expected"] = expected(&others[3]);
    old["work_ref"] = novel.clone();
    assert_eq!(
        call(&k, "resources.update", old)["error"]["code"],
        "forbidden"
    );
    let caps = ok(agent(&hub, &g, "capabilities.get", json!({})));
    let action = caps["actions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["name"] == "hetu.resources.list")
        .unwrap();
    assert_eq!(
        action["input_schema"]["properties"]["work_ref"]["const"],
        novel
    );
    jsonschema::validator_for(&action["input_schema"]).unwrap();
    let h = ok(agent(
        &hub,
        &g,
        "handoffs.get",
        json!({"view_kind":"resource","object_ref":{"work_ref":novel,"resource_id":owned["resource"]["resource_id"],"revision":1}}),
    ));
    assert!(
        h["fixed_refs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["kind"] == "resource" && r["work_ref"] == novel)
    );
}

#[test]
fn management_scope_can_create_and_update_draft_resources_without_a_task() {
    let (root, k, work) = setup();
    let (hub, grant) = grant(&k, root.path(), &work);
    let created = agent(&hub, &grant, "resources.create", {
        let mut input = fields("managed-create");
        input["work_ref"] = work.clone();
        input
    });
    assert_eq!(created["status"], "succeeded", "{created}");
    assert_eq!(created["data"]["resource"]["work_ref"], work);
    let mut update = fields("managed-update");
    update["resource_id"] = created["data"]["resource"]["resource_id"].clone();
    update["expected"] = expected(&created["data"]);
    update["work_ref"] = work.clone();
    let updated = agent(&hub, &grant, "resources.update", update);
    assert_eq!(updated["status"], "succeeded", "{updated}");
    assert_eq!(updated["data"]["resource"]["title"], "managed-update");
    let replay = agent(&hub, &grant, "resources.create", {
        let mut input = fields("managed-create");
        input["work_ref"] = work;
        input
    });
    assert_eq!(replay["status"], "succeeded", "{replay}");
    assert_eq!(replay["data"]["resource"]["resource_id"], created["data"]["resource"]["resource_id"]);
}
#[test]
fn fixed_task_proposal_binds_created_drafts_and_rejects_foreign_input() {
    let (root, k, work) = setup();
    let other = drama(&k, "other");
    let foreign = resource(&k, &other, "foreign");
    let known = resource(&k, &work, "known");
    let (hub, g) = grant(&k, root.path(), &work);
    let input = json!({"scope_ref":{"kind":"workspace","id":k.scope()},"work_ref":work,"task_kind":"resource_organize","brief":"整理考据","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN","resource_scope":{"resource_refs":[reference(&known)],"editable_resource_ids":[known["resource"]["resource_id"]],"allow_create":true}});
    let mut bad = input.clone();
    bad["resource_scope"]["resource_refs"] = json!([reference(&foreign)]);
    assert_eq!(
        agent(&hub, &g, "creative_tasks.preview_prompt", bad)["error"]["code"],
        "forbidden"
    );
    let preview = ok(agent(&hub, &g, "creative_tasks.preview_prompt", input));
    let mut prepare = preview["prepare_input"].clone();
    prepare["operation_key"] = json!("task");
    let proposal = ok(agent(
        &hub,
        &g,
        "agent_operations.prepare",
        json!({"action":"hetu.creative_tasks.prepare","input":prepare,"summary":"整理考据","operation_key":"proposal"}),
    ));
    ok(call(
        &k,
        "agent_operations.decide",
        json!({"proposal_id":proposal["proposal_id"],"proposal_sha256":proposal["proposal_sha256"],"expected_state_revision":1,"decision":"approve","operation_key":"approve"}),
    ));
    let done = ok(agent(
        &hub,
        &g,
        "agent_operations.execute",
        json!({"proposal_id":proposal["proposal_id"],"proposal_sha256":proposal["proposal_sha256"],"operation_key":"execute"}),
    ));
    let task = &done["result"]["task_ref"];
    assert!(task.is_object(), "{done}");
    let a = Kernel::open(
        json!({"workspace_path":root.path().join("作品"),"mode":"agent","task_id":task["task_id"]}),
    )
    .unwrap();
    let made = resource(&a, &Value::Null, "task-new");
    assert_eq!(made["resource"]["work_ref"], work);
    let mut forged = fields("forged");
    forged["work_ref"] = other;
    assert_eq!(
        call(&a, "resources.create", forged)["error"]["code"],
        "forbidden"
    );
    let mut edit = fields("edited");
    edit["resource_id"] = made["resource"]["resource_id"].clone();
    edit["expected"] = expected(&made);
    let edited = ok(call(&a, "resources.update", edit));
    assert_eq!(edited["resource"]["work_ref"], work);
    assert_eq!(
        call(
            &a,
            "resources.get",
            json!({"resource_id":foreign["resource"]["resource_id"]})
        )["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        ok(agent(
            &hub,
            &g,
            "resources.get",
            json!({"resource_id":edited["resource"]["resource_id"]})
        ))["resource"],
        edited["resource"]
    );
    assert_ne!(
        agent(
            &hub,
            &g,
            "resources.adopt",
            json!({"resource_id":made["resource"]["resource_id"],"expected":expected(&edited),"operation_key":"fake"})
        )["status"],
        "succeeded"
    );
}
#[test]
fn same_entity_id_and_revision_require_the_exact_work_canon() {
    let (_root, k, novel) = setup();
    let drama = drama(&k, "d");
    let id = "character_11111111-1111-4111-8111-111111111111";
    let mut canons = Vec::new();
    for (n, w) in [&novel, &drama].iter().enumerate() {
        let bp = ok(call(&k, "blueprints.get", json!({"work_ref":w})));
        let saved = ok(call(
            &k,
            "blueprints.save",
            json!({"work_ref":w,"expected":{"blueprint_id":bp["blueprint"]["blueprint_id"],"revision":bp["revision"],"sha256":bp["sha256"]},"typed_changes":[{"type":"upsert_character","entity":{"character_id":id,"name":"同名人物","aliases":[],"description":"各自的设定","traits":[],"facts":[],"archived":false}}],"operation_key":format!("canon-{n}")}),
        ));
        canons.push(saved);
    }
    let mut i = fields("exact");
    i["work_ref"] = drama.clone();
    i["entity_refs"] = json!([{"kind":"character","entity_id":id,"work_ref":drama,"blueprint_id":canons[1]["blueprint"]["blueprint_id"],"blueprint_revision":canons[1]["revision"],"blueprint_sha256":canons[1]["sha256"]}]);
    ok(call(&k, "resources.create", i.clone()));
    i["operation_key"] = json!("wrong");
    i["entity_refs"][0]["blueprint_id"] = canons[0]["blueprint"]["blueprint_id"].clone();
    assert_eq!(
        call(&k, "resources.create", i.clone())["error"]["code"],
        "hetu.stale_evidence"
    );
    i["entity_refs"][0]["work_ref"] = novel;
    assert_eq!(
        call(&k, "resources.create", i)["error"]["code"],
        "forbidden"
    );
}
#[test]
fn usages_fix_same_work_and_cannot_move_an_existing_usage() {
    let (_root, k, novel) = setup();
    let other = drama(&k, "d");
    let n = resource(&k, &novel, "n");
    let d = resource(&k, &other, "d");
    let chapter = ok(call(
        &k,
        "documents.create",
        json!({"kind":"novel_chapter","title":"渡口","source_format":"markdown","content":"渡口🌿","operation_key":"chapter"}),
    ));
    let target = json!({"document_id":chapter["document"]["document_id"],"revision_id":chapter["revision"]["revision_id"],"byte_start":6,"byte_end":10,"quote":"🌿"});
    let input = json!({"resource_ref":reference(&n),"target_ref":target,"role":"考据","archived":false,"operation_key":"usage"});
    let u = ok(call(&k, "resource_usages.save", input.clone()));
    let mut invalid = input.clone();
    invalid["resource_ref"] = reference(&d);
    invalid["operation_key"] = json!("bad");
    assert_eq!(
        call(&k, "resource_usages.save", invalid)["error"]["code"],
        "forbidden"
    );
    let legacy = resource(&k, &Value::Null, "legacy");
    let mut transfer = input;
    transfer["resource_ref"] = reference(&legacy);
    transfer["usage_id"] = u["usage"]["usage_id"].clone();
    transfer["expected"] = json!({"revision":1,"sha256":u["sha256"]});
    transfer["operation_key"] = json!("transfer");
    assert_eq!(
        call(&k, "resource_usages.save", transfer)["error"]["code"],
        "forbidden"
    );
}
