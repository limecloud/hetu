use hetu_core::{Kernel, collaboration::CollaborationHub};
use serde_json::{Value, json};
use std::fs;

fn call(k: &Kernel, name: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{name}"),"contract_revision":"1","input":input}))
}
fn ok(result: Value) -> Value {
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn setup() -> (tempfile::TempDir, Kernel) {
    let folder = tempfile::tempdir().unwrap();
    let author = Kernel::open(json!({"workspace_path":folder.path(),"mode":"author","create":{"title":"长河","locale":"zh-CN","operation_key":"book"}})).unwrap();
    (folder, author)
}
fn document(author: &Kernel, title: &str, content: &str) -> Value {
    ok(call(
        author,
        "documents.create",
        json!({"kind":"novel_chapter","title":title,"source_format":"markdown","content":content,"operation_key":title}),
    ))
}
fn source(doc: &Value) -> Value {
    json!({"kind":"document","document_id":doc["document"]["document_id"],"revision_id":doc["revision"]["revision_id"]})
}
fn task(author: &Kernel, refs: Vec<Value>) -> Value {
    let preview = ok(call(
        author,
        "creative_tasks.preview_prompt",
        json!({"scope_ref":{"kind":"workspace","id":author.scope()},"task_kind":"chapter_draft","brief":"核对已授权的旧稿，只提交参考稿。","input_refs":refs,"client_adapter":"codex","language_tag":"zh-CN"}),
    ));
    let mut input = preview["prepare_input"].clone();
    input["operation_key"] = preview["task_ref"]["task_id"].clone();
    ok(call(author, "creative_tasks.prepare", input))
}
fn reader(folder: &tempfile::TempDir, task: &Value) -> Kernel {
    Kernel::open(json!({"workspace_path":folder.path(),"mode":"agent","task_id":task["task_ref"]["task_id"]})).unwrap()
}

#[test]
fn large_authorized_collection_is_lazy_utf8_bounded_and_fixed_to_old_revisions() {
    let (folder, author) = setup();
    let original = format!("开篇🌿\n\n{}\n\n结尾。", "河港旧事。".repeat(45_000));
    let docs = (0..10)
        .map(|index| document(&author, &format!("第{index}章"), &original))
        .collect::<Vec<_>>();
    document(&author, "未授权秘密章节", "结局在私人手稿里。");
    let t = task(&author, docs.iter().map(source).collect());
    assert!(
        serde_json::to_vec(&t).unwrap().len() < 30_000,
        "打开任务不应携带整书原文"
    );
    let agent = reader(&folder, &t);
    let listed = ok(call(
        &agent,
        "task_context.list",
        json!({"task_ref":t["task_ref"],"limit":3}),
    ));
    assert_eq!(listed["entries"].as_array().unwrap().len(), 3);
    assert!(!listed.to_string().contains("秘密章节"));
    let reference = &listed["entries"][0]["context_ref"];
    let first = ok(call(
        &agent,
        "task_context.read",
        json!({"task_ref":t["task_ref"],"context_ref":reference,"max_bytes":4}),
    ));
    assert_eq!(first["content"], "开");
    assert_eq!(first["next_range"]["byte_start"], 3);
    assert_eq!(
        call(
            &agent,
            "task_context.read",
            json!({"task_ref":t["task_ref"],"context_ref":reference,"range":{"byte_start":1}})
        )["error"]["code"],
        "hetu.invalid_source_ref"
    );
    ok(call(
        &author,
        "documents.save",
        json!({"document_id":docs[0]["document"]["document_id"],"base_revision_id":docs[0]["revision"]["revision_id"],"source_format":"markdown","content":"作者现在已改写。","operation_key":"changed"}),
    ));
    let mut collected = String::new();
    let mut range = json!({"byte_start":0});
    loop {
        let part = ok(call(
            &agent,
            "task_context.read",
            json!({"task_ref":t["task_ref"],"context_ref":reference,"range":range,"max_bytes":65_536}),
        ));
        assert!(part["content"].as_str().unwrap().len() <= 65_536);
        assert_eq!(part["source_ref"]["quote"], part["content"]);
        collected.push_str(part["content"].as_str().unwrap());
        if part["complete"] == true {
            break;
        }
        range = part["next_range"].clone();
    }
    assert_eq!(collected, original);
    let hit = ok(call(
        &agent,
        "task_context.search",
        json!({"task_ref":t["task_ref"],"query":"开篇🌿","limit":2}),
    ));
    assert_eq!(hit["coverage"]["scanned_entries"], 10);
    assert_eq!(hit["matches"][0]["source_ref"]["byte_end"], "开篇🌿".len());
    assert_eq!(
        ok(call(
            &agent,
            "task_context.search",
            json!({"task_ref":t["task_ref"],"query":"私人手稿"})
        ))["matches"],
        json!([])
    );
    let next = ok(call(
        &agent,
        "task_context.list",
        json!({"task_ref":t["task_ref"],"cursor":listed["next_cursor"],"limit":3}),
    ));
    assert_eq!(next["entries"].as_array().unwrap().len(), 3);
    let other = task(&author, vec![source(&docs[1])]);
    assert_eq!(
        call(
            &author,
            "task_context.list",
            json!({"task_ref":other["task_ref"],"cursor":listed["next_cursor"],"limit":3})
        )["error"]["code"],
        "cursor_invalid"
    );
}

#[test]
fn stable_context_checks_manifest_integrity_authorization_and_revocation() {
    let (folder, author) = setup();
    let doc = document(&author, "公开参考", "林舟来到雾港。🌿");
    let t = task(&author, vec![source(&doc)]);
    let private = tempfile::tempdir().unwrap();
    ok(call(
        &author,
        "collaboration.authorize",
        json!({"task_ref":t["task_ref"],"client_adapter":"codex","collaboration_path":private.path(),"operation_key":"grant"}),
    ));
    let hub = CollaborationHub::open(private.path(), "codex").unwrap();
    let route = |name: &str, input: Value| {
        hub.request(json!({"action":format!("hetu.{name}"),"contract_revision":"1","input":input}))
    };
    let opened = ok(route(
        "collaboration.open",
        json!({"task_locator":{"scope_ref":t["task_ref"]["scope_ref"],"task_id":t["task_ref"]["task_id"]}}),
    ));
    let list = ok(route(
        "task_context.list",
        json!({"task_ref":opened["task_ref"]}),
    ));
    let reference = &list["entries"][0]["context_ref"];
    assert_eq!(
        ok(route(
            "task_context.read",
            json!({"task_ref":opened["task_ref"],"context_ref":reference})
        ))["content"],
        "林舟来到雾港。🌿"
    );
    assert_eq!(
        route(
            "task_context.read",
            json!({"task_ref":opened["task_ref"],"context_ref":{"context_id":"context_99","sha256":reference["sha256"]}})
        )["error"]["code"],
        "forbidden"
    );
    ok(call(
        &author,
        "collaboration.revoke",
        json!({"task_ref":t["task_ref"],"client_adapter":"codex","collaboration_path":private.path(),"operation_key":"revoke"}),
    ));
    assert_eq!(
        route(
            "task_context.read",
            json!({"task_ref":opened["task_ref"],"context_ref":reference})
        )["error"]["code"],
        "forbidden"
    );
    let manifest = &t["request"]["context_manifest_ref"];
    let path = folder.path().join(format!(
        ".hetu/tasks/{}/context/{}.json",
        t["task_ref"]["task_id"].as_str().unwrap(),
        manifest["manifest_id"].as_str().unwrap()
    ));
    let mut record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    record["entries"][0]["title"] = json!("外部篡改");
    fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
    assert_eq!(
        call(
            &author,
            "task_context.list",
            json!({"task_ref":t["task_ref"]})
        )["error"]["code"],
        "hetu.integrity_failure"
    );
}

#[test]
fn large_story_bible_has_bounded_entity_directory_and_immutable_entity_reads() {
    let (folder, author) = setup();
    let initial = ok(call(&author, "blueprints.get", json!({})));
    let changes = (0..80).map(|index| json!({"type":"upsert_character","entity":{
        "character_id":format!("character_{index:08x}-1111-4111-8111-111111111111"),"name":format!("人物{index}"),
        "aliases":[],"description":"旧设定。".repeat(150),"traits":[],"facts":[],"archived":false
    }})).collect::<Vec<_>>();
    let fixed = ok(call(
        &author,
        "blueprints.save",
        json!({"expected":{"revision":initial["revision"],"sha256":initial["sha256"]},"typed_changes":changes,"operation_key":"bible"}),
    ));
    let t = task(
        &author,
        vec![json!({"kind":"blueprint","revision":fixed["revision"]})],
    );
    let agent = reader(&folder, &t);
    let list = ok(call(
        &agent,
        "task_context.list",
        json!({"task_ref":t["task_ref"]}),
    ));
    let context = &list["entries"][0]["context_ref"];
    let read = |extra: Value| {
        let mut input = json!({"task_ref":t["task_ref"],"context_ref":context});
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        call(&agent, "task_context.read", input)
    };
    let sections = ok(read(json!({"max_bytes":65_536})));
    assert!(sections.get("blueprint").is_none());
    assert_eq!(sections["sections"][0]["count"], 80);
    assert_eq!(sections["complete"], false);
    let directory = ok(read(
        json!({"section":"characters","limit":80,"max_bytes":1500}),
    ));
    assert!(directory["entities"].as_array().unwrap().len() < 80);
    assert!(directory.to_string().len() < 2200);
    assert!(!directory.to_string().contains("旧设定"));
    let mut count = directory["entities"].as_array().unwrap().len();
    let mut cursor = directory["next_cursor"].clone();
    while !cursor.is_null() {
        let page = ok(read(
            json!({"section":"characters","cursor":cursor,"max_bytes":1500}),
        ));
        count += page["entities"].as_array().unwrap().len();
        cursor = page["next_cursor"].clone();
    }
    assert_eq!(count, 80);
    assert_eq!(
        read(json!({"section":"locations","cursor":directory["next_cursor"],"max_bytes":1500}))["error"]
            ["code"],
        "cursor_invalid"
    );
    let first = &directory["entities"][0];
    let mut changed = fixed["blueprint"]["characters"][0].clone();
    changed["description"] = json!("作者之后更改的设定。");
    ok(call(
        &author,
        "blueprints.save",
        json!({"expected":{"revision":fixed["revision"],"sha256":fixed["sha256"]},"typed_changes":[{"type":"upsert_character","entity":changed}],"operation_key":"new-bible"}),
    ));
    let entity = ok(read(
        json!({"section":"characters","entity_id":first["entity_id"]}),
    ));
    assert_eq!(entity["entity"]["description"], "旧设定。".repeat(150));
    assert_eq!(entity["entity_sha256"], first["entity_sha256"]);
    assert_eq!(entity["sha256"], context["sha256"]);
    assert_eq!(
        read(json!({"section":"characters","entity_id":first["entity_id"],"max_bytes":100}))["error"]
            ["code"],
        "hetu.budget_exceeded"
    );
    assert_eq!(
        read(json!({"entity_id":first["entity_id"]}))["error"]["code"],
        "invalid_input"
    );
    assert_eq!(
        read(json!({"section":"characters","range":{"byte_start":0}}))["error"]["code"],
        "invalid_input"
    );
    assert_eq!(
        read(json!({"section":"locations","entity_id":first["entity_id"]}))["error"]["code"],
        "not_found"
    );
}
