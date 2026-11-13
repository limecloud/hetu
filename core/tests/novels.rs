use hetu_core::Kernel;
use serde_json::{Value, json};
use std::fs;

fn call(kernel: &Kernel, action: &str, input: Value) -> Value {
    kernel.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(result: Value) -> Value {
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn setup() -> (tempfile::TempDir, Kernel) {
    let folder = tempfile::tempdir().unwrap();
    let kernel = Kernel::open(json!({"workspace_path":folder.path(),"mode":"author","create":{"title":"雾港 🌿","locale":"zh-CN","operation_key":"create"}})).unwrap();
    (folder, kernel)
}
fn get(kernel: &Kernel) -> Value {
    ok(call(kernel, "novels.get", json!({})))
}
fn expected(value: &Value) -> Value {
    json!({"revision":value["revision"],"sha256":value["sha256"]})
}
fn chapter(kernel: &Kernel, key: &str) -> Value {
    ok(call(
        kernel,
        "documents.create",
        json!({"kind":"novel_chapter","title":key,"source_format":"markdown","content":"　　雾港的灯亮了。🌿\n\n第二段，不修改原文范围。","operation_key":key}),
    ))
}

#[test]
fn independent_books_keep_metadata_and_chapters_separate() {
    let (folder, kernel) = setup();
    let (_other_folder, other) = setup();
    let initial = get(&kernel);
    let other_initial = get(&other);
    assert_ne!(
        initial["novel"]["novel_id"],
        other_initial["novel"]["novel_id"]
    );
    assert_eq!(initial["novel"]["metadata"]["title"], "雾港 🌿");
    let config = fs::read(folder.path().join(".heturc.json")).unwrap();
    let mut metadata = initial["novel"]["metadata"].clone();
    metadata["title"] = json!("新书名");
    metadata["author_name"] = json!("听雨");
    metadata["status"] = json!("writing");
    let input =
        json!({"expected":expected(&initial),"metadata":metadata,"operation_key":"details"});
    let changed = ok(call(&kernel, "novels.update", input.clone()));
    assert_eq!(changed["revision"], 2);
    assert_eq!(changed["novel"]["previous_sha256"], initial["sha256"]);
    assert_eq!(
        fs::read(folder.path().join(".heturc.json")).unwrap(),
        config
    );
    assert_eq!(get(&other), other_initial);
    let created = chapter(&kernel, "第一章");
    assert_eq!(
        get(&kernel)["novel"]["chapters"][0]["document_id"],
        created["document"]["document_id"]
    );
    assert_eq!(ok(call(&kernel, "novels.update", input)), changed);
    assert_eq!(
        call(
            &kernel,
            "novels.update",
            json!({"expected":expected(&initial),"metadata":metadata,"operation_key":"stale"})
        )["error"]["code"],
        "revision_conflict"
    );
    let agent = Kernel::open(json!({"workspace_path":folder.path(),"mode":"agent"})).unwrap();
    assert_eq!(get(&agent), get(&kernel));
    assert_eq!(
        call(
            &agent,
            "novels.update",
            json!({"expected":expected(&get(&kernel)),"metadata":metadata,"operation_key":"agent"})
        )["error"]["code"],
        "forbidden"
    );
}

#[test]
fn reorder_preserves_chapter_identity_and_source_bytes_and_rejects_dropped_or_rebound_chapters() {
    let (_folder, kernel) = setup();
    let a = chapter(&kernel, "第一章");
    let b = chapter(&kernel, "第二章");
    let before = get(&kernel);
    let volume = "volume_00000000-0000-4000-8000-000000000001";
    let mut chapters = before["novel"]["chapters"].as_array().unwrap().clone();
    chapters.reverse();
    for chapter in &mut chapters {
        chapter["volume_id"] = json!(volume);
    }
    let input = json!({"expected":expected(&before),"volumes":[{"volume_id":volume,"title":"第一卷 雾起"}],"chapters":chapters,"operation_key":"reorder"});
    let reordered = ok(call(&kernel, "novels.save_structure", input.clone()));
    assert_eq!(
        reordered["novel"]["chapters"][0]["document_id"],
        b["document"]["document_id"]
    );
    let current = ok(call(
        &kernel,
        "documents.get",
        json!({"document_id":a["document"]["document_id"]}),
    ));
    assert_eq!(current["revision"], a["revision"]);
    assert_eq!(
        current["content"],
        "　　雾港的灯亮了。🌿\n\n第二段，不修改原文范围。"
    );
    assert_eq!(
        ok(call(&kernel, "novels.save_structure", input.clone())),
        reordered
    );
    for (key, change) in [
        ("drop", json!([chapters[0]])),
        ("duplicate", json!([chapters[0], chapters[0]])),
        ("empty", json!([])),
    ] {
        let mut bad = input.clone();
        bad["expected"] = expected(&reordered);
        bad["operation_key"] = json!(key);
        bad["chapters"] = change;
        assert_eq!(
            call(&kernel, "novels.save_structure", bad)["error"]["code"],
            "invalid_input"
        );
    }
    let mut rebound = input.clone();
    rebound["expected"] = expected(&reordered);
    rebound["operation_key"] = json!("rebind");
    rebound["chapters"][0]["document_id"] = a["document"]["document_id"].clone();
    rebound["chapters"][1]["document_id"] = b["document"]["document_id"].clone();
    assert_eq!(
        call(&kernel, "novels.save_structure", rebound)["error"]["code"],
        "invalid_input"
    );
    assert_eq!(get(&kernel), reordered);
}

#[test]
fn legacy_workspace_requires_explicit_initialization_and_collects_only_novel_chapters() {
    let (folder, kernel) = setup();
    let first = chapter(&kernel, "第一章");
    ok(call(
        &kernel,
        "documents.create",
        json!({"kind":"novel_outline","title":"大纲","source_format":"markdown","content":"","operation_key":"outline"}),
    ));
    let metadata = get(&kernel)["novel"]["metadata"].clone();
    drop(kernel);
    // 仅在测试私有目录中模拟旧格式作品。
    for relative in ["packages/novel/novel.json", ".hetu/novel-head.json"] {
        fs::remove_file(folder.path().join(relative)).unwrap();
    }
    fs::remove_dir_all(folder.path().join(".hetu/novels")).unwrap();
    let config_path = folder.path().join(".heturc.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    config.as_object_mut().unwrap().remove("novel_path");
    fs::write(&config_path, serde_json::to_vec_pretty(&config).unwrap()).unwrap();
    let kernel = Kernel::open(json!({"workspace_path":folder.path(),"mode":"author"})).unwrap();
    assert_eq!(get(&kernel)["initialized"], false);
    assert!(!folder.path().join("packages/novel/novel.json").exists());
    let refused = call(
        &kernel,
        "documents.create",
        json!({"kind":"novel_chapter","title":"需先确认","source_format":"markdown","content":"","operation_key":"refused"}),
    );
    assert_eq!(
        refused["error"]["code"],
        "hetu.novel_initialization_required"
    );
    assert_eq!(
        ok(call(&kernel, "documents.list", json!({})))["documents"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let result = ok(call(
        &kernel,
        "novels.initialize",
        json!({"metadata":metadata,"operation_key":"initialize"}),
    ));
    assert_eq!(result["novel"]["chapters"].as_array().unwrap().len(), 1);
    assert_eq!(
        result["novel"]["chapters"][0]["document_id"],
        first["document"]["document_id"]
    );
    assert_eq!(
        ok(call(
            &kernel,
            "documents.get",
            json!({"document_id":first["document"]["document_id"]})
        ))["revision"],
        first["revision"]
    );
}

#[test]
fn tampering_or_missing_catalog_blocks_writes_without_creating_orphan_documents() {
    let (folder, kernel) = setup();
    let path = folder.path().join("packages/novel/novel.json");
    let original = fs::read(&path).unwrap();
    let mut modified: Value = serde_json::from_slice(&original).unwrap();
    modified["metadata"]["title"] = json!("外部改写");
    fs::write(&path, serde_json::to_vec_pretty(&modified).unwrap()).unwrap();
    assert_eq!(
        call(&kernel, "novels.get", json!({}))["error"]["code"],
        "hetu.integrity_failure"
    );
    assert_eq!(
        call(
            &kernel,
            "documents.create",
            json!({"kind":"novel_chapter","title":"不可落盘","source_format":"markdown","content":"","operation_key":"broken"})
        )["status"],
        "failed"
    );
    assert_eq!(
        fs::read_dir(folder.path().join("packages/novel/documents"))
            .unwrap()
            .count(),
        0
    );
    fs::write(&path, original).unwrap();
    fs::remove_file(&path).unwrap();
    fs::remove_file(folder.path().join(".hetu/novel-head.json")).unwrap();
    assert_eq!(
        call(&kernel, "novels.get", json!({}))["error"]["code"],
        "hetu.integrity_failure"
    );
}
