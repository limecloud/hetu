use hetu_core::Kernel;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

fn call(kernel: &Kernel, action: &str, input: Value) -> Value {
    kernel.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(result: Value) -> Value {
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn setup() -> (tempfile::TempDir, Kernel, PathBuf) {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("作品 素材 🌿");
    let kernel = Kernel::open(json!({"workspace_path":path,"mode":"author","create":{"title":"雾港","locale":"zh-CN","operation_key":"init"}})).unwrap();
    (folder, kernel, path)
}
fn image(root: &Path) -> PathBuf {
    // 完整的 1×1 PNG；生产识别仍明确标记为仅核对文件签名。
    let hex = "89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c020000000b4944415478da6364f80f00010501012718e3660000000049454e44ae426082";
    let bytes: Vec<u8> = (0..hex.len())
        .step_by(2)
        .map(|n| u8::from_str_radix(&hex[n..n + 2], 16).unwrap())
        .collect();
    let path = root.join("灯塔 参考 🌿.png");
    fs::write(&path, bytes).unwrap();
    path
}
fn import_input(kernel: &Kernel, path: &Path, key: &str) -> Value {
    let preview = ok(call(kernel, "assets.inspect", json!({"file_path":path})));
    json!({"file_path":path,"expected_file":{"sha256":preview["sha256"],"size_bytes":preview["size_bytes"]},"title":"灯塔参考 🌿",
        "source":{"source_type":"author_supplied","creator_statement":"作者手工提供","source_uri":"https://hetu.limeai.run/"},
        "rights_status":"unknown","redistribution_allowed":false,"rights_statement":"","operation_key":key})
}
fn cue_input(title: &str, refs: Value, sources: Value, key: &str) -> Value {
    json!({"kind":"visual","title":title,"description":"雾港雨夜，冷色灯光；由作者录入。","narrative_refs":sources,"asset_refs":refs,"archived":false,"operation_key":key})
}
fn asset_ref(value: &Value) -> Value {
    json!({"asset_id":value["asset"]["asset_id"],"revision":value["asset"]["revision"],"sha256":value["sha256"]})
}
fn update_input(value: &Value, key: &str) -> Value {
    let mut input = value["asset"].clone();
    input.as_object_mut().unwrap().retain(|key, _| {
        [
            "asset_id",
            "title",
            "source",
            "rights_status",
            "redistribution_allowed",
            "rights_statement",
        ]
        .contains(&key.as_str())
    });
    input["expected"] = json!({"revision":value["asset"]["revision"],"sha256":value["sha256"]});
    input["operation_key"] = json!(key);
    input
}

#[test]
fn media_import_preserves_exact_bytes_provenance_and_original_key_after_reopen() {
    let (root, kernel, workspace) = setup();
    let file = image(root.path());
    let input = import_input(&kernel, &file, "导入 🌿 原键");
    let receipt = call(&kernel, "assets.import", input.clone());
    let data = ok(receipt.clone());
    assert_eq!(data["asset"]["original_filename"], "灯塔 参考 🌿.png");
    assert_eq!(data["asset"]["blob"]["validation"], "signature_only");
    assert_eq!(data["delivery_eligible"], false);
    assert_eq!(
        fs::read(workspace.join(data["asset"]["blob"]["path"].as_str().unwrap())).unwrap(),
        fs::read(&file).unwrap()
    );
    assert!(
        !serde_json::to_string(&data)
            .unwrap()
            .contains(root.path().to_str().unwrap())
    );
    drop(kernel);
    fs::remove_file(file).unwrap();
    let reopened = Kernel::open(json!({"workspace_path":workspace,"mode":"author"})).unwrap();
    assert_eq!(
        call(&reopened, "assets.import", input.clone()),
        receipt,
        "replay must not reread a removed external file"
    );
    let mut changed = input;
    changed["title"] = json!("不能复用");
    assert_eq!(
        call(&reopened, "assets.import", changed)["error"]["code"],
        "idempotency_conflict"
    );
    let fetched = ok(call(
        &reopened,
        "assets.get",
        json!({"asset_id":data["asset"]["asset_id"]}),
    ));
    assert_eq!(fetched["asset"], data["asset"]);
    assert_eq!(fetched["media_verified"], true);
}

#[test]
fn local_import_cannot_be_used_by_agents_or_with_unsafe_files_or_changed_preview() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let (root, kernel, workspace) = setup();
    let file = image(root.path());
    let input = import_input(&kernel, &file, "import");
    let agent = Kernel::open(json!({"workspace_path":workspace,"mode":"agent"})).unwrap();
    for action in ["assets.inspect", "assets.import"] {
        let fields = if action.ends_with("inspect") {
            json!({"file_path":file})
        } else {
            input.clone()
        };
        assert_eq!(call(&agent, action, fields)["error"]["code"], "forbidden");
    }
    let linked = root.path().join("linked.png");
    symlink(&file, &linked).unwrap();
    assert_eq!(
        call(&kernel, "assets.inspect", json!({"file_path":linked}))["error"]["code"],
        "hetu.unsafe_path"
    );
    let hard = root.path().join("hard.png");
    fs::hard_link(&file, &hard).unwrap();
    assert_eq!(
        call(&kernel, "assets.inspect", json!({"file_path":file}))["error"]["code"],
        "hetu.unsafe_path"
    );
    fs::remove_file(hard).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        call(&kernel, "assets.inspect", json!({"file_path":file}))["error"]["code"],
        "hetu.unsafe_path"
    );
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&file, b"<svg onload='unsafe'></svg>").unwrap();
    assert_eq!(
        call(&kernel, "assets.inspect", json!({"file_path":file}))["error"]["code"],
        "hetu.unsupported_media"
    );
    image(root.path());
    let mut changed = fs::read(&file).unwrap();
    changed.push(0);
    fs::write(&file, changed).unwrap();
    assert_eq!(
        call(&kernel, "assets.import", input)["error"]["code"],
        "revision_conflict"
    );
    assert!(
        ok(call(&kernel, "assets.list", json!({})))["assets"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn rights_changes_are_versioned_with_cas_and_current_revocation_applies_to_history() {
    let (root, kernel, workspace) = setup();
    let file = image(root.path());
    let imported = ok(call(
        &kernel,
        "assets.import",
        import_input(&kernel, &file, "import"),
    ));
    let mut invalid = update_input(&imported, "rights");
    invalid["redistribution_allowed"] = json!(true);
    assert_eq!(
        call(&kernel, "assets.update", invalid.clone())["error"]["code"],
        "hetu.rights_confirmation_required"
    );
    invalid["rights_status"] = json!("author_owned");
    invalid["rights_statement"] = json!("作者确认拥有本作品素材并允许本次交付再分发。");
    let allowed = ok(call(&kernel, "assets.update", invalid.clone()));
    assert_eq!(allowed["asset"]["revision"], 2);
    assert_eq!(allowed["delivery_eligible"], true);
    assert_eq!(allowed["asset"]["previous_sha256"], imported["sha256"]);
    invalid["operation_key"] = json!("stale");
    assert_eq!(
        call(&kernel, "assets.update", invalid)["error"]["code"],
        "revision_conflict"
    );
    let mut revoke = update_input(&allowed, "revoke");
    revoke["rights_status"] = json!("reference_only");
    revoke["redistribution_allowed"] = json!(false);
    ok(call(&kernel, "assets.update", revoke));
    let old = ok(call(
        &kernel,
        "assets.get",
        json!({"asset_id":allowed["asset"]["asset_id"],"revision":2}),
    ));
    assert_eq!(old["asset"], allowed["asset"]);
    assert_eq!(old["current_revision"], 3);
    assert_eq!(
        old["delivery_eligible"], false,
        "old permissive declaration must not bypass present revocation"
    );
    let payload = workspace.join(imported["asset"]["blob"]["path"].as_str().unwrap());
    fs::write(payload, b"tampered").unwrap();
    let damaged = call(
        &kernel,
        "assets.get",
        json!({"asset_id":imported["asset"]["asset_id"]}),
    );
    assert_ne!(damaged["status"], "succeeded");
}

#[test]
fn credentialled_or_signed_urls_and_unjustified_redistribution_are_rejected() {
    let (root, kernel, _) = setup();
    let file = image(root.path());
    for (index, uri) in [
        "https://user:password@hetu.test/media",
        "https://hetu.test/media?signature=secret",
        "file:///Users/author/private.png",
        "https://hetu.test/media#token",
    ]
    .iter()
    .enumerate()
    {
        let mut input = import_input(&kernel, &file, &format!("bad-{index}"));
        input["source"]["source_uri"] = json!(uri);
        assert_eq!(
            call(&kernel, "assets.import", input)["error"]["code"],
            "invalid_input"
        );
    }
    assert!(
        ok(call(&kernel, "assets.list", json!({})))["assets"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn cues_bind_exact_unicode_sources_and_fixed_assets_and_retain_stale_history() {
    let (root, kernel, workspace) = setup();
    let asset = ok(call(
        &kernel,
        "assets.import",
        import_input(&kernel, &image(root.path()), "import"),
    ));
    let document = ok(call(
        &kernel,
        "documents.create",
        json!({"kind":"novel_chapter","title":"雾港","source_format":"markdown","content":"第一行\r\n闻溪推门 🌿。\n","operation_key":"create-doc"}),
    ));
    let quote = "闻溪推门 🌿。";
    let start = "第一行\r\n".len();
    let source = json!({"document_id":document["document"]["document_id"],"revision_id":document["revision"]["revision_id"],"byte_start":start,"byte_end":start+quote.len(),"quote":quote});
    let input = cue_input(
        "灯塔夜景",
        json!([asset_ref(&asset)]),
        json!([source]),
        "cue",
    );
    let cue = ok(call(&kernel, "cues.save", input.clone()));
    assert!(cue["stale_sources"].as_array().unwrap().is_empty());
    let mut bad = input;
    bad["operation_key"] = json!("bad-source");
    bad["narrative_refs"][0]["byte_start"] = json!(start + 1);
    assert_eq!(
        call(&kernel, "cues.save", bad)["error"]["code"],
        "hetu.invalid_source_ref"
    );
    ok(call(
        &kernel,
        "documents.save",
        json!({"document_id":document["document"]["document_id"],"base_revision_id":document["revision"]["revision_id"],"source_format":"markdown","content":"作者修订后的正文","operation_key":"edit-doc"}),
    ));
    let changed = ok(call(
        &kernel,
        "cues.get",
        json!({"cue_id":cue["cue"]["cue_id"]}),
    ));
    assert_eq!(changed["cue"], cue["cue"]);
    assert_eq!(changed["stale_sources"][0]["code"], "document_changed");
    let updated_asset = ok(call(
        &kernel,
        "assets.update",
        update_input(&asset, "metadata"),
    ));
    let changed = ok(call(
        &kernel,
        "cues.get",
        json!({"cue_id":cue["cue"]["cue_id"]}),
    ));
    assert_eq!(changed["assets"][0]["metadata_stale"], true);
    assert_eq!(changed["assets"][0]["delivery_eligible"], false);
    let mut next = cue_input(
        "灯塔夜景 二稿",
        json!([asset_ref(&updated_asset)]),
        json!([source]),
        "cue-next",
    );
    next["cue_id"] = cue["cue"]["cue_id"].clone();
    next["expected"] = json!({"revision":1,"sha256":cue["sha256"]});
    let new_cue = ok(call(&kernel, "cues.save", next.clone()));
    assert_eq!(new_cue["cue"]["revision"], 2);
    next["operation_key"] = json!("cue-stale");
    assert_eq!(
        call(&kernel, "cues.save", next)["error"]["code"],
        "revision_conflict"
    );
    assert_eq!(
        ok(call(
            &kernel,
            "cues.get",
            json!({"cue_id":cue["cue"]["cue_id"],"revision":1})
        ))["cue"],
        cue["cue"]
    );
    let agent = Kernel::open(json!({"workspace_path":workspace,"mode":"agent"})).unwrap();
    assert_eq!(
        ok(call(
            &agent,
            "cues.get",
            json!({"cue_id":cue["cue"]["cue_id"]})
        ))["cue"],
        new_cue["cue"]
    );
    assert_eq!(
        call(
            &agent,
            "cues.save",
            cue_input("越权", json!([]), json!([]), "agent")
        )["error"]["code"],
        "forbidden"
    );
}

#[test]
fn cue_list_is_snapshot_bound_and_archive_and_kind_filters_are_explicit() {
    let (_root, kernel, workspace) = setup();
    let one = ok(call(
        &kernel,
        "cues.save",
        cue_input("一", json!([]), json!([]), "one"),
    ));
    ok(call(
        &kernel,
        "cues.save",
        cue_input("二", json!([]), json!([]), "two"),
    ));
    let page = ok(call(&kernel, "cues.list", json!({"limit":1})));
    assert_eq!(page["cues"].as_array().unwrap().len(), 1);
    let cursor = page["next_cursor"].clone();
    assert!(cursor.is_string());
    assert_eq!(
        ok(call(
            &kernel,
            "cues.list",
            json!({"cursor":cursor,"limit":1})
        ))["cues"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        call(
            &kernel,
            "cues.list",
            json!({"cursor":cursor,"kind":"visual"})
        )["error"]["code"],
        "cursor_invalid"
    );
    let mut archived = cue_input("归档", json!([]), json!([]), "archive");
    archived["cue_id"] = one["cue"]["cue_id"].clone();
    archived["expected"] = json!({"revision":1,"sha256":one["sha256"]});
    archived["archived"] = json!(true);
    ok(call(&kernel, "cues.save", archived));
    assert_eq!(
        ok(call(&kernel, "cues.list", json!({})))["cues"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        ok(call(&kernel, "cues.list", json!({"include_archived":true})))["cues"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        call(&kernel, "cues.list", json!({"cursor":cursor}))["error"]["code"],
        "cursor_invalid"
    );
    let id = one["cue"]["cue_id"].as_str().unwrap();
    fs::write(
        workspace.join(format!("packages/visual-prompt/cues/{id}/revisions/1.json")),
        b"{}",
    )
    .unwrap();
    assert_eq!(
        call(&kernel, "cues.get", json!({"cue_id":id,"revision":1}))["error"]["code"],
        "hetu.integrity_failure"
    );
}

#[test]
fn large_media_streams_beyond_record_read_limit_and_oversized_files_fail_before_copy() {
    use std::io::{Seek, SeekFrom, Write};
    let (root, kernel, workspace) = setup();
    let file = image(root.path());
    let mut external = fs::OpenOptions::new().write(true).open(&file).unwrap();
    external.seek(SeekFrom::End(0)).unwrap();
    external.write_all(&vec![0u8; 17 * 1024 * 1024]).unwrap();
    drop(external);
    let imported = ok(call(
        &kernel,
        "assets.import",
        import_input(&kernel, &file, "large"),
    ));
    assert!(imported["asset"]["blob"]["size_bytes"].as_u64().unwrap() > 16 * 1024 * 1024);
    let media_path = workspace.join(imported["asset"]["blob"]["path"].as_str().unwrap());
    assert_eq!(
        fs::metadata(media_path).unwrap().len(),
        fs::metadata(&file).unwrap().len()
    );
    ok(call(
        &kernel,
        "assets.get",
        json!({"asset_id":imported["asset"]["asset_id"]}),
    ));
    fs::OpenOptions::new()
        .write(true)
        .open(&file)
        .unwrap()
        .set_len(2 * 1024 * 1024 * 1024 + 1)
        .unwrap();
    assert_eq!(
        call(&kernel, "assets.inspect", json!({"file_path":file}))["error"]["code"],
        "hetu.budget_exceeded"
    );
}
