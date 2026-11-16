use base64::{Engine, engine::general_purpose::STANDARD};
use hetu_core::Kernel;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn call(k: &Kernel, action: &str, input: Value) -> Value {
    let v =
        k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}));
    assert_eq!(v["status"], "succeeded", "{v}");
    v["data"].clone()
}
fn asset(k: &Kernel, work: Option<&Value>, key: &str) -> (Value, Vec<u8>) {
    // 签名可识别的较大样本用于验证分块合同，不冒充完整音频解码。
    let mut raw = vec![0; 1024 * 1024 + 17];
    raw[..12].copy_from_slice(b"RIFF\x00\x00\x10\x00WAVE");
    *raw.last_mut().unwrap() = 77;
    (import_bytes(k, work, key, &raw), raw)
}
fn import_bytes(k: &Kernel, work: Option<&Value>, key: &str, raw: &[u8]) -> Value {
    let inline = json!({"filename":"测试素材","base64":STANDARD.encode(raw),"sha256":format!("{:x}",Sha256::digest(raw))});
    let scan = call(k, "assets.inspect", json!({"inline_source":inline}));
    let mut input = json!({"inline_source":inline,"expected_file":{"sha256":scan["sha256"],"size_bytes":scan["size_bytes"]},
        "title":key,"source":{"source_type":"author_supplied","creator_statement":"测试参考"},
        "rights_status":"unknown","redistribution_allowed":false,"rights_statement":"","operation_key":key});
    if let Some(w) = work {
        input["work_ref"] = w.clone();
    }
    call(k, "assets.import", input)
}
fn setup() -> (tempfile::TempDir, Kernel, Value, Value) {
    let root = tempfile::tempdir().unwrap();
    let k = Kernel::open(json!({"workspace_path":root.path().join("作品"),"mode":"author", "create":{"title":"渡口","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let work = call(&k, "works.list", json!({}))["works"][0]["work_ref"].clone();
    let other = call(&k, "video.projects.create", json!({"title":"独立视频","brief":"不能共享权限","language_tag":"zh-CN","operation_key":"video"}))["work_ref"].clone();
    (root, k, work, other)
}
fn reference(work: &Value, asset: &Value) -> Value {
    json!({"work_ref":work,"asset_id":asset["asset"]["asset_id"],"revision":asset["asset"]["revision"],"sha256":asset["sha256"]})
}
fn denied(k: &Kernel, input: &Value) -> &'static str {
    match k.open_asset_media(input) {
        Err(e) => e.code,
        Ok(_) => panic!("unexpected media access"),
    }
}

#[test]
fn fixed_media_chunks_preserve_bytes_and_do_not_grant_other_work_or_agent_access() {
    let (root, k, work, other) = setup();
    let (a, raw) = asset(&k, Some(&work), "原图");
    let (old, _) = asset(&k, None, "未归属旧图");
    let fixed = reference(&work, &a);
    let mut reader = k.open_asset_media(&fixed).unwrap();
    assert_eq!(reader.metadata()["asset_ref"], fixed);
    assert!(reader.metadata().get("path").is_none());
    let mut complete = vec![];
    for offset in (0..raw.len()).step_by(512 * 1024) {
        let chunk = reader.read(offset as u64, 512 * 1024).unwrap();
        assert_eq!(chunk["offset"], offset);
        complete.extend(STANDARD.decode(chunk["base64"].as_str().unwrap()).unwrap());
    }
    assert_eq!(complete, raw);
    let suffix = reader.read(raw.len() as u64 - 17, 100).unwrap();
    assert_eq!(suffix["size_bytes"], 17);
    for (offset, length) in [
        (0, 0),
        (0, 512 * 1024 + 1),
        (raw.len() as u64, 1),
        (u64::MAX, 1),
    ] {
        assert_eq!(
            reader.read(offset, length).unwrap_err().code,
            "invalid_range"
        );
    }
    let mut wrong = fixed.clone();
    wrong["work_ref"] = other;
    assert_eq!(denied(&k, &wrong), "forbidden");
    assert_eq!(denied(&k, &reference(&work, &old)), "forbidden");
    wrong = fixed.clone();
    wrong["sha256"] = json!("0".repeat(64));
    assert_eq!(denied(&k, &wrong), "revision_conflict");
    wrong = fixed.clone();
    wrong["file_path"] = json!("/arbitrary");
    assert_eq!(denied(&k, &wrong), "invalid_input");
    let agent =
        Kernel::open(json!({"workspace_path":root.path().join("作品"),"mode":"agent"})).unwrap();
    assert_eq!(denied(&agent, &fixed), "forbidden");
    assert_eq!(
        k.request(json!({"action":"hetu.media.read","contract_revision":"1","input":{}}))["error"]
            ["code"],
        "hetu.capability_unavailable"
    );
}

#[test]
fn preview_keeps_fixed_history_and_rejects_changed_or_linked_original_bytes() {
    let (root, k, work, _) = setup();
    let (a, mut raw) = asset(&k, Some(&work), "原始资料");
    let fixed = reference(&work, &a);
    let mut reader = k.open_asset_media(&fixed).unwrap();
    let changed = call(
        &k,
        "assets.update",
        json!({"asset_id":a["asset"]["asset_id"],"expected":{"revision":1,"sha256":a["sha256"]},"title":"新版说明",
        "source":a["asset"]["source"],"rights_status":"reference_only","redistribution_allowed":false,"rights_statement":"只供参考","operation_key":"update"}),
    );
    assert_eq!(changed["asset"]["revision"], 2);
    assert_eq!(reader.metadata()["asset_ref"], fixed);
    assert_eq!(
        k.open_asset_media(&fixed).unwrap().metadata()["asset_ref"],
        fixed
    );
    let file = root
        .path()
        .join("作品")
        .join(a["asset"]["blob"]["path"].as_str().unwrap());
    raw[100] = 99;
    std::fs::write(&file, &raw).unwrap();
    assert_eq!(
        reader.read(0, 32).unwrap_err().code,
        "hetu.integrity_failure"
    );
    assert_eq!(denied(&k, &fixed), "hetu.integrity_failure");
    #[cfg(unix)]
    {
        let (b, _) = asset(&k, Some(&work), "链接拒绝");
        let file = root
            .path()
            .join("作品")
            .join(b["asset"]["blob"]["path"].as_str().unwrap());
        std::fs::hard_link(&file, root.path().join("硬链接")).unwrap();
        assert_eq!(denied(&k, &reference(&work, &b)), "hetu.unsafe_path");
    }
}

#[test]
fn image_preview_accepts_tiny_images_and_bounds_dimensions_before_browser_decode() {
    let (_root, k, work, _) = setup();
    for (width, expected) in [(1, None), (9000, Some("hetu.budget_exceeded"))] {
        let mut output = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(width, 1)
            .write_to(&mut output, image::ImageFormat::Png)
            .unwrap();
        let a = import_bytes(&k, Some(&work), &format!("image-{width}"), output.get_ref());
        let fixed = reference(&work, &a);
        if let Some(code) = expected {
            assert_eq!(denied(&k, &fixed), code);
        } else {
            assert_eq!(
                k.open_asset_media(&fixed).unwrap().metadata()["media_type"],
                "image/png"
            );
            assert_eq!(a["asset"]["blob"]["validation"], "signature_only");
        }
    }
    let bad = import_bytes(
        &k,
        Some(&work),
        "bad-header",
        b"\x89PNG\r\n\x1a\nnot-an-image",
    );
    assert_eq!(
        denied(&k, &reference(&work, &bad)),
        "hetu.unsupported_media"
    );
    let mut pixels = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(30, 30)
        .write_to(&mut pixels, image::ImageFormat::Png)
        .unwrap();
    let mut corrupt = pixels.into_inner();
    corrupt[45] ^= 0xff;
    let broken = import_bytes(&k, Some(&work), "bad-pixels", &corrupt);
    assert_eq!(
        denied(&k, &reference(&work, &broken)),
        "hetu.unsupported_media"
    );
}
