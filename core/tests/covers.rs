use hetu_core::Kernel;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, io::Cursor, path::Path};

fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(
        json!({"action":format!("hetu.covers.{action}"),"contract_revision":"1","input":input}),
    )
}
fn ok(result: Value) -> Value {
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn setup() -> (tempfile::TempDir, Kernel) {
    let root = tempfile::tempdir().unwrap();
    let k = Kernel::open(json!({"workspace_path":root.path(),"mode":"author","create":{"title":"雾港","locale":"zh-CN","operation_key":"create"}})).unwrap();
    (root, k)
}
fn png(path: &Path) -> Vec<u8> {
    let mut buffer = Cursor::new(Vec::new());
    image::RgbImage::from_pixel(64, 96, image::Rgb([32, 150, 100]))
        .write_to(&mut buffer, image::ImageFormat::Png)
        .unwrap();
    let bytes = buffer.into_inner();
    fs::write(path, &bytes).unwrap();
    bytes
}
fn presentation() -> Value {
    json!({"crop_rect":{"x":0,"y":0,"width":1,"height":1},"title_overlay":"雾港","author_overlay":"听雨"})
}
fn manual(path: &Path, bytes: &[u8], expected: Value, key: &str) -> Value {
    json!({"source":{"kind":"file","file_path":path,"expected_file":{"sha256":sha(bytes),"size_bytes":bytes.len()}},"expected_cover":expected,"presentation":presentation(),"operation_key":key})
}
fn preview(k: &Kernel, count: usize, language: &str) -> Value {
    ok(call(
        k,
        "preview_prompt",
        json!({"book":{"title":"雾港","author_name":"听雨","synopsis":"河港的灯塔故事。","language_tag":"zh-CN"},"design":{"art_direction":"夜雨中的灯塔，无字底图","width":64,"height":96,"text_mode":"background_only","cover_language":"zh-CN","candidate_count":count},"language_tag":language}),
    ))
}

#[test]
fn author_selection_is_atomic_cas_versioned_and_recoverable_without_the_external_file() {
    let (root, k) = setup();
    let source = root.path().join("中文封面.png");
    let bytes = png(&source);
    assert!(ok(call(&k, "get", json!({})))["cover"].is_null());
    let input = manual(&source, &bytes, Value::Null, "first");
    let selected = ok(call(&k, "select", input.clone()));
    assert_eq!(selected["cover"]["revision"], 1);
    assert_eq!(selected["cover"]["width"], 64);
    assert_eq!(selected["cover"]["height"], 96);
    assert_eq!(
        selected["cover"]["source_ref"],
        json!({"kind":"author_supplied","original_filename":"中文封面.png"})
    );
    fs::write(&source, b"external file changed").unwrap();
    assert_eq!(ok(call(&k, "select", input)), selected);
    let loaded = ok(call(&k, "get", json!({})));
    assert_eq!(loaded["cover"], selected["cover"]);
    assert_eq!(loaded["preview"]["width"], 64);
    assert_eq!(loaded["preview"]["height"], 96);
    assert_eq!(loaded["asset"]["asset"]["rights_status"], "unknown");
    assert_eq!(loaded["asset"]["delivery_eligible"], false);
    let mut replacement = json!({"source":{"kind":"asset","asset_ref":selected["cover"]["asset_ref"]},"expected_cover":null,"presentation":presentation(),"operation_key":"stale"});
    assert_eq!(
        call(&k, "select", replacement.clone())["error"]["code"],
        "revision_conflict"
    );
    replacement["expected_cover"] = selected["expected_cover"].clone();
    replacement["operation_key"] = json!("second");
    replacement["presentation"]["title_overlay"] = json!("新书名");
    let second = ok(call(&k, "select", replacement));
    assert_eq!(second["cover"]["revision"], 2);
    assert_eq!(
        ok(call(&k, "get", json!({"revision":1})))["cover"],
        selected["cover"]
    );
    let agent = Kernel::open(json!({"workspace_path":root.path(),"mode":"agent"})).unwrap();
    assert_eq!(
        call(
            &agent,
            "select",
            manual(&source, &bytes, second["expected_cover"].clone(), "agent")
        )["error"]["code"],
        "forbidden"
    );
    fs::write(root.path().join(".hetu/covers/1.json"), b"{}").unwrap();
    assert_ne!(
        call(&k, "get", json!({"revision":1}))["status"],
        "succeeded"
    );
}

#[test]
fn fixed_requests_validate_partial_candidates_and_only_author_selection_changes_the_cover() {
    let (root, k) = setup();
    let before = fs::read(root.path().join("packages/novel/novel.json")).unwrap();
    let preview = preview(&k, 2, "en");
    assert!(
        preview["prompt"]
            .as_str()
            .unwrap()
            .contains("Book title (keep exact): 雾港")
    );
    assert!(!root.path().join("packages/visual-prompt/covers").exists());
    for field in ["title", "art_direction", "prompt"] {
        let mut blank = preview["request"].clone();
        match field {
            "title" => blank["book"][field] = json!(" \n"),
            "art_direction" => blank["design"][field] = json!(" \n"),
            _ => blank[field] = json!(" \n"),
        }
        assert_eq!(
            call(
                &k,
                "create_request",
                json!({"request":blank,"operation_key":format!("blank-{field}")})
            )["error"]["code"],
            "invalid_input"
        );
    }
    assert!(!root.path().join("packages/visual-prompt/covers").exists());
    let input = json!({"request":preview["request"],"operation_key":"request"});
    let request = ok(call(&k, "create_request", input.clone()));
    assert_eq!(ok(call(&k, "create_request", input)), request);
    let request_id = request["request"]["request_id"].as_str().unwrap();
    let inbox = root
        .path()
        .join(request["request"]["output_relative_dir"].as_str().unwrap());
    let bytes = png(&inbox.join("candidate-01.png"));
    assert_eq!(
        ok(call(
            &k,
            "list_candidates",
            json!({"request_id":request_id})
        ))["state"],
        "files_discovered"
    );
    let mut result = json!({"schema_version":"1.0.0","workspace_id":k.scope(),"request_id":request_id,"request_sha256":request["request_sha256"],"completed_at":"2026-11-13T00:00:00Z","candidates":[{"filename":"candidate-01.png","sha256":sha(&bytes),"size_bytes":bytes.len(),"width":64,"height":96,"media_type":"image/png","used_prompt":"夜雨灯塔","generator":{"agent":"fixture","tool":"fixture-image"}}]});
    let save = |value: &Value| {
        fs::write(
            inbox.join("result.json"),
            serde_json::to_vec(value).unwrap(),
        )
        .unwrap()
    };
    save(&result);
    let list = ok(call(
        &k,
        "list_candidates",
        json!({"request_id":request_id}),
    ));
    assert_eq!(list["state"], "partial_result");
    assert_eq!(list["candidates"][0]["target_size_matches"], true);
    assert!(ok(call(&k, "get", json!({})))["cover"].is_null());
    let choose = json!({"source":{"kind":"candidate","reference":list["candidates"][0]["reference"]},"expected_cover":null,"presentation":presentation(),"operation_key":"choose"});
    result["candidates"][0]["width"] = json!(65);
    save(&result);
    assert_ne!(call(&k, "select", choose.clone())["status"], "succeeded");
    save(
        &json!({"schema_version":"1.0.0","workspace_id":"workspace_00000000-0000-4000-8000-000000000001","request_id":request_id,"request_sha256":request["request_sha256"],"completed_at":"2026-11-13T00:00:00Z","candidates":result["candidates"]}),
    );
    assert_ne!(
        call(&k, "list_candidates", json!({"request_id":request_id}))["status"],
        "succeeded"
    );
    result["candidates"][0]["width"] = json!(64);
    save(&result);
    let selected = ok(call(&k, "select", choose));
    assert_eq!(
        selected["cover"]["source_ref"]["reference"],
        list["candidates"][0]["reference"]
    );
    assert_eq!(
        fs::read(root.path().join("packages/novel/novel.json")).unwrap(),
        before
    );
    assert_eq!(
        ok(call(&k, "list_requests", json!({})))["requests"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn damaged_images_links_bad_crops_and_changed_previews_preserve_the_current_cover() {
    let (root, k) = setup();
    let source = root.path().join("bad.png");
    let bytes = png(&source);
    let mut input = manual(&source, &bytes, Value::Null, "crop");
    input["presentation"]["crop_rect"]["x"] = json!(0.5);
    assert_eq!(call(&k, "select", input)["error"]["code"], "invalid_input");
    let wrong = manual(&source, b"wrong", Value::Null, "wrong");
    assert_eq!(
        call(&k, "select", wrong)["error"]["code"],
        "revision_conflict"
    );
    let linked = root.path().join("linked.png");
    std::os::unix::fs::symlink(&source, &linked).unwrap();
    assert_ne!(
        call(&k, "select", manual(&linked, &bytes, Value::Null, "linked"))["status"],
        "succeeded"
    );
    fs::write(&source, &bytes[..bytes.len() / 2]).unwrap();
    assert_ne!(
        call(
            &k,
            "select",
            manual(&source, &bytes[..bytes.len() / 2], Value::Null, "truncated")
        )["status"],
        "succeeded"
    );
    assert!(ok(call(&k, "get", json!({})))["cover"].is_null());
}
