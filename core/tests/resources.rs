use hetu_core::Kernel;
use serde_json::{Value, json};

fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(v: Value) -> Value {
    assert_eq!(v["status"], "succeeded", "{v}");
    v["data"].clone()
}
fn setup() -> (tempfile::TempDir, Kernel) {
    let folder = tempfile::tempdir().unwrap();
    let k=Kernel::open(json!({"workspace_path":folder.path(),"mode":"author","create":{"title":"雾港","locale":"zh-CN","operation_key":"book"}})).unwrap();
    (folder, k)
}
fn fields(title: &str) -> Value {
    json!({"title":title,"category":"research","body":"资料原文🌿\r\n第二段","tags":["渡口"],"project_id":null,"entity_refs":[],"source_notes":"作者考据笔记"})
}
fn create(k: &Kernel, title: &str, key: &str) -> Value {
    let mut i = fields(title);
    i["operation_key"] = json!(key);
    ok(call(k, "resources.create", i))
}
fn expected(v: &Value) -> Value {
    json!({"revision":v["resource"]["revision"],"sha256":v["sha256"]})
}
fn reference(v: &Value) -> Value {
    json!({"resource_id":v["resource"]["resource_id"],"revision":v["resource"]["revision"],"sha256":v["sha256"]})
}

#[test]
fn text_resources_cas_history_and_usage_never_change_manuscript_or_canon() {
    let (_folder, k) = setup();
    let resource = create(&k, "渡口考据", "resource");
    let doc = ok(call(
        &k,
        "documents.create",
        json!({"kind":"novel_chapter","title":"第一章","source_format":"markdown","content":"渡口🌿\r\n原稿","operation_key":"chapter"}),
    ));
    let input = json!({"resource_ref":reference(&resource),"target_ref":{"document_id":doc["document"]["document_id"],"revision_id":doc["revision"]["revision_id"],"byte_start":6,"byte_end":10,"quote":"🌿"},"role":"地理参考","archived":false,"operation_key":"usage"});
    let usage = ok(call(&k, "resource_usages.save", input.clone()));
    assert_eq!(usage, ok(call(&k, "resource_usages.save", input)));
    let mut update = fields("渡口考据修订");
    update["resource_id"] = resource["resource"]["resource_id"].clone();
    update["expected"] = expected(&resource);
    update["operation_key"] = json!("update");
    let saved = ok(call(&k, "resources.update", update.clone()));
    assert_eq!(saved, ok(call(&k, "resources.update", update.clone())));
    update["operation_key"] = json!("conflict");
    assert_eq!(
        call(&k, "resources.update", update)["error"]["code"],
        "revision_conflict"
    );
    let historical = ok(call(
        &k,
        "resources.get",
        json!({"resource_id":resource["resource"]["resource_id"],"revision":1}),
    ));
    assert_eq!(historical["resource"], resource["resource"]);
    assert_eq!(historical["is_head"], false);
    let usages = ok(call(
        &k,
        "resource_usages.list",
        json!({"resource_id":resource["resource"]["resource_id"]}),
    ));
    assert_eq!(usages["usages"][0]["stale_resource"], true);
    assert_eq!(usages["usages"][0]["stale_source"], false);
    let unchanged = ok(call(
        &k,
        "documents.get",
        json!({"document_id":doc["document"]["document_id"]}),
    ));
    assert_eq!(unchanged["content"], "渡口🌿\r\n原稿");
    assert_eq!(unchanged["document"]["approved_revision_id"], Value::Null);
    let adopt = json!({"resource_id":saved["resource"]["resource_id"],"expected":expected(&saved),"operation_key":"adopt"});
    let adopted = ok(call(&k, "resources.adopt", adopt));
    assert_eq!(adopted["resource"]["state"], "adopted");
    let archived = ok(call(
        &k,
        "resources.archive",
        json!({"resource_id":adopted["resource"]["resource_id"],"expected":expected(&adopted),"operation_key":"archive"}),
    ));
    assert_eq!(archived["resource"]["state"], "archived");
    assert!(
        ok(call(&k, "resources.list", json!({})))["resources"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        ok(call(
            &k,
            "resources.get",
            json!({"resource_id":archived["resource"]["resource_id"]})
        ))["resource"]["state"],
        "archived"
    );
}

#[test]
fn scoped_agent_can_iterate_drafts_but_not_adopted_records_other_tasks_or_author_text() {
    let (folder, k) = setup();
    let known = create(&k, "已知资料", "known");
    let private = create(&k, "无关资料", "private");
    let preview = ok(call(
        &k,
        "creative_tasks.preview_prompt",
        json!({"scope_ref":{"kind":"workspace","id":k.scope()},"task_kind":"resource_organize","brief":"整理渡口资料，不改正式正文","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN","resource_scope":{"resource_refs":[reference(&known)],"editable_resource_ids":[known["resource"]["resource_id"]],"allow_create":true}}),
    ));
    let mut prepared = preview["prepare_input"].clone();
    prepared["operation_key"] = json!("task");
    let task = ok(call(&k, "creative_tasks.prepare", prepared));
    let agent=Kernel::open(json!({"workspace_path":folder.path(),"mode":"agent","task_id":task["task_ref"]["task_id"]})).unwrap();
    let new = create(&agent, "资料候选", "new");
    let mut update = fields("资料候选修订");
    update["resource_id"] = new["resource"]["resource_id"].clone();
    update["expected"] = expected(&new);
    update["operation_key"] = json!("edit");
    let edited = ok(call(&agent, "resources.update", update));
    let list = ok(call(&agent, "resources.list", json!({})));
    assert_eq!(list["resources"].as_array().unwrap().len(), 2);
    assert_eq!(
        call(
            &agent,
            "resources.get",
            json!({"resource_id":private["resource"]["resource_id"]})
        )["error"]["code"],
        "forbidden"
    );
    let adopted = ok(call(
        &k,
        "resources.adopt",
        json!({"resource_id":known["resource"]["resource_id"],"expected":expected(&known),"operation_key":"adopt"}),
    ));
    let mut official = fields("作者采用后的私有修订");
    official["resource_id"] = known["resource"]["resource_id"].clone();
    official["expected"] = expected(&adopted);
    official["operation_key"] = json!("author-official");
    let official = ok(call(&k, "resources.update", official));
    assert_eq!(
        ok(call(
            &agent,
            "resources.get",
            json!({"resource_id":known["resource"]["resource_id"]})
        ))["resource"],
        known["resource"]
    );
    assert!(
        ok(call(&agent, "resources.list", json!({})))["resources"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["title"] != "作者采用后的私有修订")
    );
    assert_eq!(
        call(
            &agent,
            "resources.get",
            json!({"resource_id":known["resource"]["resource_id"],"revision":official["resource"]["revision"]})
        )["error"]["code"],
        "forbidden"
    );
    let mut input = fields("不应覆盖正式资料");
    input["resource_id"] = known["resource"]["resource_id"].clone();
    input["expected"] = expected(&adopted);
    input["operation_key"] = json!("forbidden");
    assert_eq!(
        call(&agent, "resources.update", input)["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        call(
            &agent,
            "resources.adopt",
            json!({"resource_id":edited["resource"]["resource_id"],"expected":expected(&edited),"operation_key":"promote"})
        )["error"]["code"],
        "forbidden"
    );
    let observed = ok(call(
        &k,
        "creative_tasks.get",
        json!({"task_ref":task["task_ref"]}),
    ));
    ok(call(
        &k,
        "creative_tasks.close",
        json!({"task_ref":task["task_ref"],"expected":observed["expected"],"reason":"作者结束整理","operation_key":"close"}),
    ));
    let mut replay = fields("资料候选");
    replay["operation_key"] = json!("new");
    assert_eq!(
        call(&agent, "resources.create", replay)["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        ok(call(
            &k,
            "resources.get",
            json!({"resource_id":edited["resource"]["resource_id"]})
        ))["resource"],
        edited["resource"]
    );
}

#[test]
fn reference_only_task_reads_fixed_version_and_lists_do_not_leak_later_author_edits() {
    let (folder, k) = setup();
    let original = create(&k, "固定资料", "fixed");
    let preview = ok(call(
        &k,
        "creative_tasks.preview_prompt",
        json!({"scope_ref":{"kind":"workspace","id":k.scope()},"task_kind":"resource_organize","brief":"只参考资料","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN","resource_scope":{"resource_refs":[reference(&original)],"editable_resource_ids":[],"allow_create":false}}),
    ));
    let mut i = preview["prepare_input"].clone();
    i["operation_key"] = json!("prepare");
    let task = ok(call(&k, "creative_tasks.prepare", i));
    let mut update = fields("作者之后的私有编辑");
    update["resource_id"] = original["resource"]["resource_id"].clone();
    update["expected"] = expected(&original);
    update["operation_key"] = json!("update");
    ok(call(&k, "resources.update", update));
    let agent=Kernel::open(json!({"workspace_path":folder.path(),"mode":"agent","task_id":task["task_ref"]["task_id"]})).unwrap();
    let got = ok(call(
        &agent,
        "resources.get",
        json!({"resource_id":original["resource"]["resource_id"]}),
    ));
    assert_eq!(got["resource"], original["resource"]);
    assert_eq!(
        ok(call(&agent, "resources.list", json!({})))["resources"][0]["title"],
        "固定资料"
    );
    assert_eq!(
        call(
            &agent,
            "resources.get",
            json!({"resource_id":original["resource"]["resource_id"],"revision":2})
        )["error"]["code"],
        "forbidden"
    );
    let mut create = fields("越权新增");
    create["operation_key"] = json!("new");
    assert_eq!(
        call(&agent, "resources.create", create)["error"]["code"],
        "forbidden"
    );
}
