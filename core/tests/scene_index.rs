use hetu_core::{Kernel, collaboration::CollaborationHub};
use serde_json::{Value, json};

fn call(kernel: &Kernel, action: &str, input: Value) -> Value {
    kernel.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(value: Value) -> Value {
    assert_eq!(value["status"], "succeeded", "{value}");
    value["data"].clone()
}
fn episode(kernel: &Kernel, project: &Value, title: &str, content: &str, key: &str) -> Value {
    let created = ok(call(
        kernel,
        "drama.episodes.create",
        json!({"project_ref":{"project_id":project["project"]["project_id"],
        "revision":project["project"]["revision"],"sha256":project["sha256"]},"title":title,"plan":"","language_tag":"zh-CN","operation_key":key}),
    ));
    ok(call(
        kernel,
        "documents.save",
        json!({"document_id":created["document"]["document_id"],"base_revision_id":created["document"]["current_revision_id"],
        "source_format":"fountain","content":content,"operation_key":format!("save-{key}")}),
    ));
    created
}

#[test]
fn scene_directory_reads_fixed_ranges_without_reinterpreting_new_text_or_crossing_work() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("work");
    let directory = folder.path().join("hub");
    let kernel=Kernel::open(json!({"mode":"author","workspace_path":path,"create":{"title":"基础资料","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let project = ok(call(
        &kernel,
        "drama.projects.create",
        json!({"title":"雨夜","mode":"original","operation_key":"drama"}),
    ));
    let work = json!({"workspace_id":kernel.scope(),"kind":"drama","object_id":project["project"]["project_id"]});
    let source = format!(
        "Title: 雨夜\r\n\r\nEXT. 旧站 - NIGHT #1#\r\n\r\n{}\r\n\r\n# 后记\r\n\r\n.尾声\r\n\r\n另一场。",
        "中文🌿\r\n".repeat(3000)
    );
    let first = episode(&kernel, &project, "同名分集", &source, "first");
    let project = ok(call(
        &kernel,
        "drama.projects.get",
        json!({"project_id":work["object_id"]}),
    ));
    let second = episode(
        &kernel,
        &project,
        "同名分集",
        "EXT. 旧站 - NIGHT\r\n\r\n另一份正式稿。",
        "second",
    );
    let other = ok(call(
        &kernel,
        "drama.projects.create",
        json!({"title":"同根他作","mode":"original","operation_key":"foreign"}),
    ));
    let foreign = episode(
        &kernel,
        &other,
        "同名分集",
        "EXT. 旧站 - NIGHT\n\n禁止串读的正文。",
        "foreign-episode",
    );
    let grant=ok(call(&kernel,"collaboration.authorize_workspace",json!({"work_ref":work,"client_adapter":"codex","collaboration_path":directory,"operation_key":"grant"})))["management_ref"].clone();
    let hub = CollaborationHub::open(&directory, "codex").unwrap();
    let read = |mut input: Value| {
        input["management_ref"] = grant.clone();
        hub.request(
            json!({"action":"hetu.documents.scene_index","contract_revision":"1","input":input}),
        )
    };
    let input = json!({"work_ref":work,"query":"旧站","limit":1});
    let page = ok(read(input.clone()));
    assert_eq!(page["scenes"].as_array().unwrap().len(), 1);
    let mut next = input.clone();
    next["cursor"] = page["next_cursor"].clone();
    let next = ok(read(next));
    assert_eq!(next["scenes"].as_array().unwrap().len(), 1);
    assert!(next["next_cursor"].is_null());
    assert_ne!(
        page["scenes"][0]["document_ref"]["document_id"],
        next["scenes"][0]["document_ref"]["document_id"]
    );
    let all = ok(read(json!({"work_ref":work})));
    assert_eq!(all["scenes"].as_array().unwrap().len(), 3);
    assert!(
        all["scenes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["document_ref"]["document_id"] != foreign["document"]["document_id"])
    );
    let row = all["scenes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| {
            row["document_ref"]["document_id"] == first["document"]["document_id"]
                && row["heading"].as_str().unwrap().contains("旧站")
        })
        .unwrap();
    let selected = json!({"work_ref":work,"document_id":row["document_ref"]["document_id"],"revision_id":row["document_ref"]["revision_id"],"sha256":row["document_ref"]["sha256"],"scene_range":row["range"],"max_bytes":1000});
    let mut read_all = String::new();
    let mut part = selected.clone();
    loop {
        let page = ok(read(part.clone()));
        assert!(page["scene"].get("document_title").is_none());
        read_all.push_str(page["content"].as_str().unwrap());
        if page["complete"] == true {
            break;
        }
        part["offset"] = page["next_offset"].clone();
    }
    let start = row["range"]["byte_start"].as_u64().unwrap() as usize;
    let end = row["range"]["byte_end"].as_u64().unwrap() as usize;
    assert_eq!(read_all, &source[start..end]);
    assert!(!read_all.contains("# 后记"));
    let stable = ok(read(selected.clone()));
    let current = ok(call(
        &kernel,
        "documents.get",
        json!({"document_id":first["document"]["document_id"]}),
    ));
    let updated = ok(call(
        &kernel,
        "documents.save",
        json!({"document_id":first["document"]["document_id"],"base_revision_id":current["revision"]["revision_id"],"source_format":"fountain","content":".全新开场\n\n新内容。","operation_key":"new-source"}),
    ));
    ok(call(
        &kernel,
        "documents.rename",
        json!({"document_id":first["document"]["document_id"],"base_revision_id":updated["revision"]["revision_id"],"title":"已改名分集","operation_key":"rename"}),
    ));
    assert_eq!(ok(read(selected.clone())), stable);
    let mut stale = input;
    stale["cursor"] = page["next_cursor"].clone();
    assert_eq!(read(stale)["error"]["code"], "cursor_invalid");
    for (key, value) in [
        ("sha256", json!("0".repeat(64))),
        ("offset", json!(6)),
        ("scene_range", json!({"byte_start":start+1,"byte_end":end})),
        ("document_id", foreign["document"]["document_id"].clone()),
    ] {
        let mut invalid = selected.clone();
        invalid[key] = value;
        assert_ne!(read(invalid)["status"], "succeeded", "{key}");
    }
    let mut wrong = selected.clone();
    wrong["work_ref"]["object_id"] = other["project"]["project_id"].clone();
    assert_eq!(read(wrong)["error"]["code"], "forbidden");
    ok(call(
        &kernel,
        "collaboration.revoke_management",
        json!({"grant_id":grant["grant_id"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"revoke"}),
    ));
    assert_eq!(read(selected)["error"]["code"], "forbidden");
    assert_eq!(
        ok(call(
            &kernel,
            "documents.get",
            json!({"document_id":second["document"]["document_id"]})
        ))["content"],
        "EXT. 旧站 - NIGHT\r\n\r\n另一份正式稿。"
    );
    assert_eq!(
        ok(call(
            &kernel,
            "creative_tasks.list",
            json!({"work_ref":work})
        ))["tasks"],
        json!([])
    );
}
