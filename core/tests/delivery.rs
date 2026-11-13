use hetu_core::Kernel;
use serde_json::{Value, json};
use std::fs;

fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn data(result: Value) -> Value {
    assert!(
        matches!(result["status"].as_str(), Some("succeeded" | "partial")),
        "{result}"
    );
    result["data"].clone()
}
fn setup() -> (tempfile::TempDir, Kernel) {
    let root = tempfile::tempdir().unwrap();
    let k = Kernel::open(json!({"workspace_path":root.path(),"mode":"author","create":{"title":"雾港交付","locale":"zh-CN","operation_key":"init"}})).unwrap();
    (root, k)
}
fn document(k: &Kernel) -> Value {
    data(call(
        k,
        "documents.create",
        json!({"kind":"novel_chapter","title":"第一章 雾起","source_format":"markdown","content":"# 第一章 雾起\n\n林舟走进雾港。\n\n<!-- 私有备忘不得交付 -->\n","operation_key":"chapter"}),
    ))
}
fn reference(document: &Value) -> Value {
    json!({"document_id":document["document"]["document_id"],"revision_id":document["revision"]["revision_id"],"sha256":document["revision"]["sha256"]})
}
fn finalized(k: &Kernel, document: &Value) -> Value {
    let checked = data(call(
        k,
        "documents.validate",
        json!({"document_ref":reference(document),"plot_options":{},"validation_options":{},"operation_key":"check"}),
    ));
    let preview = data(call(
        k,
        "documents.preview_finalization",
        json!({"document_ref":reference(document),"expected_finalization_ref":null,"report_refs":[checked["reference"]],"comments":"作者确认。","coverage_acknowledgement":"已核对本次检查覆盖范围。"}),
    ));
    let approved = data(call(
        k,
        "documents.finalize",
        json!({"preview":preview["preview"],"operation_key":"finalize"}),
    ));
    let mut selected = reference(document);
    selected["finalization_ref"] = approved["finalization"]["reference"].clone();
    selected
}
fn bundle_request(k: &Kernel, selected: Value, profile: &str) -> Value {
    let bp = data(call(k, "blueprints.get", json!({})));
    json!({"selection":{"blueprint_ref":{"revision":bp["revision"],"sha256":bp["sha256"]},"document_refs":[selected]},"profile":profile,"reading_formats":["docx"]})
}
fn export(preview: Value, key: &str) -> Value {
    json!({"preview":preview,"acknowledgement":"已核对所选修订、格式损失和素材范围。","operation_key":key})
}

#[test]
fn offline_bundle_keeps_old_finalization_after_writing_advances_and_excludes_private_data() {
    let (root, k) = setup();
    let doc = document(&k);
    let selected = finalized(&k, &doc);
    let request = bundle_request(&k, selected.clone(), "production_delivery");
    let preview = data(call(&k, "bundles.preview", request.clone()))["preview"].clone();
    assert_eq!(preview["eligible"], true);
    assert!(
        fs::read_dir(root.path().join("exports"))
            .unwrap()
            .next()
            .is_none()
    );
    data(call(
        &k,
        "documents.save",
        json!({"document_id":selected["document_id"],"base_revision_id":selected["revision_id"],"source_format":"markdown","content":"作者尚未定稿的新内容。","operation_key":"save-new"}),
    ));
    assert_eq!(
        data(call(&k, "bundles.preview", request))["preview"],
        preview
    );
    let input = export(preview, "deliver");
    let receipt = call(&k, "bundles.export", input.clone());
    let result = data(receipt.clone());
    assert_eq!(call(&k, "bundles.export", input), receipt);
    let verified = data(call(
        &k,
        "bundles.verify",
        json!({"bundle_id":result["bundle_id"]}),
    ));
    assert_eq!(verified["verified"], true);
    assert_eq!(verified["sha256"], result["sha256"]);
    let file = fs::File::open(root.path().join(result["path"].as_str().unwrap())).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    let names: Vec<_> = archive
        .file_names()
        .map(|name| name.unwrap().into_owned())
        .collect();
    assert!(names.iter().any(|name| name == "DELIVERY.md"));
    assert!(names.iter().any(|name| name == "provenance/reviews.json"));
    assert!(
        names
            .iter()
            .all(|name| !name.starts_with(".hetu/") && !name.starts_with(".git/"))
    );
    use std::io::Read;
    let source_path = names
        .iter()
        .find(|name| name.starts_with("novel/") && name.ends_with(".md"))
        .unwrap();
    let mut source = String::new();
    archive
        .by_name(source_path)
        .unwrap()
        .read_to_string(&mut source)
        .unwrap();
    assert!(source.contains("林舟走进雾港"));
    assert!(!source.contains("私有备忘"));
    assert!(!source.contains("尚未定稿的新内容"));
}

#[test]
fn production_rejects_unfinalized_withdrawn_forged_and_agent_requests() {
    let (root, k) = setup();
    let doc = document(&k);
    let request = bundle_request(&k, reference(&doc), "production_delivery");
    let preview = data(call(&k, "bundles.preview", request))["preview"].clone();
    assert_eq!(preview["eligible"], false);
    assert_ne!(
        call(&k, "bundles.export", export(preview, "unfinalized"))["status"],
        "succeeded"
    );
    let selected = finalized(&k, &doc);
    let preview = data(call(
        &k,
        "bundles.preview",
        bundle_request(&k, selected.clone(), "production_delivery"),
    ))["preview"]
        .clone();
    let mut forged = preview.clone();
    forged["files"][0]["sha256"] = json!("0".repeat(64));
    assert_eq!(
        call(&k, "bundles.export", export(forged, "forged"))["error"]["code"],
        "revision_conflict"
    );
    let agent = Kernel::open(json!({"workspace_path":root.path(),"mode":"agent"})).unwrap();
    assert_eq!(
        call(&agent, "bundles.export", export(preview.clone(), "agent"))["error"]["code"],
        "forbidden"
    );
    data(call(
        &k,
        "documents.withdraw_finalization",
        json!({"document_id":selected["document_id"],"expected_finalization_ref":selected["finalization_ref"],"reason":"重新修改。","operation_key":"withdraw"}),
    ));
    assert_eq!(
        call(&k, "bundles.export", export(preview, "withdrawn"))["error"]["code"],
        "revision_conflict"
    );
}

#[test]
fn published_file_recovers_original_unknown_receipt_and_detects_tampering() {
    let (root, k) = setup();
    let doc = document(&k);
    let preview = data(call(
        &k,
        "bundles.preview",
        bundle_request(&k, reference(&doc), "review_delivery"),
    ))["preview"]
        .clone();
    let input = export(preview, "review");
    let output = call(&k, "bundles.export", input.clone());
    let result = data(output.clone());
    let operation_path = fs::read_dir(root.path().join(".hetu/operations"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            serde_json::from_slice::<Value>(&fs::read(path).unwrap()).unwrap()["key"] == "review"
        })
        .unwrap();
    let mut record: Value = serde_json::from_slice(&fs::read(&operation_path).unwrap()).unwrap();
    let delivery_id = result["delivery_id"].as_str().unwrap();
    let intent: Value = serde_json::from_slice(
        &fs::read(
            root.path()
                .join(format!(".hetu/deliveries/{delivery_id}/intent.json")),
        )
        .unwrap(),
    )
    .unwrap();
    use sha2::{Digest, Sha256};
    record["result"]["status"] = json!("unknown");
    record["delivery_id"] = json!(delivery_id);
    record["intent_sha256"] = json!(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec_pretty(&intent).unwrap())
    ));
    fs::write(operation_path, serde_json::to_vec_pretty(&record).unwrap()).unwrap();
    let recovered = data(call(&k, "bundles.export", input.clone()));
    assert_eq!(recovered, result);
    let mut conflicting = input;
    conflicting["acknowledgement"] = json!("另一份确认");
    assert_eq!(
        call(&k, "bundles.export", conflicting)["error"]["code"],
        "idempotency_conflict"
    );
    fs::write(
        root.path().join(result["path"].as_str().unwrap()),
        b"tampered",
    )
    .unwrap();
    assert_ne!(
        call(
            &k,
            "bundles.verify",
            json!({"bundle_id":result["bundle_id"]})
        )["status"],
        "succeeded"
    );
}

#[test]
fn document_import_previews_loss_preserves_original_and_rejects_changed_file() {
    let (root, k) = setup();
    let source = root.path().join("外部原稿.txt");
    let original = "第一章 雾起\n\n  保留原有缩进。\n";
    fs::write(&source, original).unwrap();
    let request = json!({"file_path":source,"format":"txt","profile":"hetu-novel-zh/1"});
    let preview = data(call(&k, "documents.preview_import", request.clone()))["preview"].clone();
    assert_eq!(preview["converted"]["confirmation_required"], true);
    assert!(
        data(call(&k, "documents.list", json!({})))["documents"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let input = json!({"preview":preview,"kind":"novel_chapter","title":"雾起","language_tag":"zh-CN","acknowledgement":"已确认章节识别预览。","operation_key":"import"});
    fs::write(&source, "文件已经改变。\n").unwrap();
    assert_eq!(
        call(&k, "documents.import", input.clone())["error"]["code"],
        "revision_conflict"
    );
    fs::write(&source, original).unwrap();
    let result = data(call(&k, "documents.import", input.clone()));
    fs::rename(&source, root.path().join("原稿已移走.txt")).unwrap();
    assert_eq!(data(call(&k, "documents.import", input)), result);
    assert_eq!(
        fs::read_to_string(root.path().join(format!(
            ".hetu/imports/{}/original",
            result["document"]["document_id"].as_str().unwrap()
        )))
        .unwrap(),
        original
    );
    let doc = data(call(
        &k,
        "documents.get",
        json!({"document_id":result["document"]["document_id"]}),
    ));
    assert!(doc["content"].as_str().unwrap().contains("保留原有缩进"));
    assert!(doc["document"]["finalization_ref"].is_null());
    assert_eq!(doc["revision"]["origin_kind"], "import");
    assert_eq!(
        doc["revision"]["import_ref"]["source_sha256"],
        result["import_report"]["source_sha256"]
    );
    let preview = data(call(
        &k,
        "documents.preview_export",
        json!({"revision_refs":[reference(&result)],"format":"docx","profile":"hetu-novel-zh/1"}),
    ))["preview"]
        .clone();
    let exported = data(call(&k, "documents.export", export(preview, "docx")));
    let imported = data(call(
        &k,
        "documents.preview_import",
        json!({"file_path":root.path().join(exported["path"].as_str().unwrap()),"format":"docx","profile":"hetu-novel-zh/1"}),
    ));
    assert!(
        imported["preview"]["converted"]["content"]
            .as_str()
            .unwrap()
            .contains("保留原有缩进")
    );
}

#[test]
fn import_rejects_symlinks_and_invalid_utf8_without_creating_documents() {
    let (root, k) = setup();
    let source = root.path().join("invalid.txt");
    fs::write(&source, [0xff, 0xfe, 0x00]).unwrap();
    let request = json!({"file_path":source,"format":"txt","profile":"source/1"});
    assert_eq!(
        call(&k, "documents.preview_import", request.clone())["error"]["code"],
        "hetu.encoding_confirmation_required"
    );
    let link = root.path().join("link.txt");
    std::os::unix::fs::symlink(&source, &link).unwrap();
    let mut request = request;
    request["file_path"] = json!(link);
    assert_ne!(
        call(&k, "documents.preview_import", request)["status"],
        "succeeded"
    );
    assert!(
        data(call(&k, "documents.list", json!({})))["documents"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn asset_delivery_checks_selected_and_current_rights_and_never_exports_local_paths() {
    let (root, k) = setup();
    let doc = document(&k);
    let image_path = root.path().join("参考封面.png");
    let hex = "89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c020000000b4944415478da6364f80f00010501012718e3660000000049454e44ae426082";
    let image: Vec<u8> = (0..hex.len())
        .step_by(2)
        .map(|n| u8::from_str_radix(&hex[n..n + 2], 16).unwrap())
        .collect();
    fs::write(&image_path, &image).unwrap();
    let inspected = data(call(&k, "assets.inspect", json!({"file_path":image_path})));
    let unknown = data(call(
        &k,
        "assets.import",
        json!({"file_path":image_path,"expected_file":{"sha256":inspected["sha256"],"size_bytes":inspected["size_bytes"]},"title":"封面素材","source":{"source_type":"author_supplied","creator_statement":"作者提供"},"rights_status":"unknown","redistribution_allowed":false,"rights_statement":"","operation_key":"asset"}),
    ));
    let unknown_ref = json!({"asset_id":unknown["asset"]["asset_id"],"revision":unknown["asset"]["revision"],"sha256":unknown["sha256"]});
    let mut request = bundle_request(&k, reference(&doc), "review_delivery");
    request["selection"]["asset_refs"] = json!([unknown_ref]);
    let excluded = data(call(&k, "bundles.preview", request.clone()))["preview"].clone();
    assert_eq!(excluded["inputs"]["asset_refs"][0]["embedded"], false);
    assert!(
        !excluded["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["path"].as_str().unwrap().ends_with("source.png"))
    );
    let mut update = json!({"asset_id":unknown["asset"]["asset_id"],"expected":{"revision":unknown["asset"]["revision"],"sha256":unknown["sha256"]},"title":"封面素材","source":unknown["asset"]["source"],"rights_status":"author_owned","redistribution_allowed":true,"rights_statement":"作者拥有原图，允许本次再分发。","operation_key":"grant"});
    let granted = data(call(&k, "assets.update", update.clone()));
    let granted_ref = json!({"asset_id":granted["asset"]["asset_id"],"revision":granted["asset"]["revision"],"sha256":granted["sha256"]});
    request["selection"]["asset_refs"] = json!([granted_ref]);
    let allowed = data(call(&k, "bundles.preview", request.clone()))["preview"].clone();
    assert_eq!(allowed["inputs"]["asset_refs"][0]["embedded"], true);
    let result = data(call(
        &k,
        "bundles.export",
        export(allowed.clone(), "with-asset"),
    ));
    assert_eq!(
        data(call(
            &k,
            "bundles.verify",
            json!({"bundle_id":result["bundle_id"]})
        ))["verified"],
        true
    );
    let file = fs::File::open(root.path().join(result["path"].as_str().unwrap())).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    let path = format!(
        "assets/{}/metadata.json",
        granted["asset"]["asset_id"].as_str().unwrap()
    );
    use std::io::Read;
    let mut meta = String::new();
    archive
        .by_name(&path)
        .unwrap()
        .read_to_string(&mut meta)
        .unwrap();
    assert!(!meta.contains(root.path().to_str().unwrap()));
    assert!(!meta.contains("packages/visual-prompt"));
    assert!(meta.contains("bundle_path"));
    update["expected"] =
        json!({"revision":granted["asset"]["revision"],"sha256":granted["sha256"]});
    update["rights_status"] = json!("reference_only");
    update["redistribution_allowed"] = json!(false);
    update["rights_statement"] = json!("撤回再分发。");
    update["operation_key"] = json!("revoke");
    data(call(&k, "assets.update", update));
    assert_eq!(
        call(&k, "bundles.export", export(allowed, "revoked"))["error"]["code"],
        "revision_conflict"
    );
    assert_eq!(
        data(call(&k, "bundles.preview", request))["preview"]["inputs"]["asset_refs"][0]["embedded"],
        false
    );
}

#[test]
fn public_review_projection_preserves_disposition_and_omits_private_reasons() {
    let (root, k) = setup();
    let doc = document(&k);
    let bp = data(call(&k, "blueprints.get", json!({})));
    data(call(
        &k,
        "blueprints.save",
        json!({"expected":{"revision":bp["revision"],"sha256":bp["sha256"]},"typed_changes":[{"type":"upsert_rule","entity":{"rule_id":"rule_11111111-1111-4111-8111-111111111111","revision":1,"type":"forbidden_term","scope":{"packages":["novel"],"document_ids":[doc["document"]["document_id"]],"entity_refs":[]},"severity":"warning","parameters":{"terms":["雾港"],"case_sensitive":true,"exceptions":[]},"rationale":"检查地名。","exception_policy":"author_review"}}],"operation_key":"rule"}),
    ));
    let checked = data(call(
        &k,
        "documents.validate",
        json!({"document_ref":reference(&doc),"plot_options":{},"validation_options":{},"operation_key":"check"}),
    ));
    assert!(!checked["report"]["findings"].as_array().unwrap().is_empty());
    data(call(
        &k,
        "findings.disposition",
        json!({"report_id":checked["report"]["report_id"],"finding_id":checked["report"]["findings"][0]["finding_id"],"expected_inputs":checked["report"]["input_snapshot"],"expected_disposition_revision":0,"disposition":"acknowledged","reason":"只在工作区保留的私有批注。","operation_key":"acknowledge"}),
    ));
    let report = data(call(
        &k,
        "reports.get",
        json!({"report_id":checked["report"]["report_id"]}),
    ));
    let mut request = bundle_request(&k, reference(&doc), "review_delivery");
    request["selection"]["report_refs"] = json!([report["reference"]]);
    let preview = data(call(&k, "bundles.preview", request))["preview"].clone();
    let result = data(call(&k, "bundles.export", export(preview, "reviews")));
    let file = fs::File::open(root.path().join(result["path"].as_str().unwrap())).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    use std::io::Read;
    let mut contents = String::new();
    archive
        .by_name("provenance/reviews.json")
        .unwrap()
        .read_to_string(&mut contents)
        .unwrap();
    let reviews: Value = serde_json::from_str(&contents).unwrap();
    assert_eq!(
        reviews["reports"][0]["dispositions"][0]["disposition"],
        "acknowledged"
    );
    assert!(!contents.contains("私有批注"));
    contents.clear();
    archive
        .by_name("DELIVERY.md")
        .unwrap()
        .read_to_string(&mut contents)
        .unwrap();
    assert!(
        !contents.contains("\"code\""),
        "交付说明应为可读文字，不能倾倒内部JSON。"
    );
}

#[test]
fn document_recovery_checks_confirmed_output_even_if_ready_record_is_changed() {
    let (root, k) = setup();
    let doc = document(&k);
    let preview = data(call(
        &k,
        "documents.preview_export",
        json!({"revision_refs":[reference(&doc)],"format":"txt","profile":"hetu-novel-zh/1"}),
    ))["preview"]
        .clone();
    let input = export(preview, "recover-document");
    let result = data(call(&k, "documents.export", input.clone()));
    let delivery_id = result["delivery_id"].as_str().unwrap();
    let intent_path = root
        .path()
        .join(format!(".hetu/deliveries/{delivery_id}/intent.json"));
    let intent: Value = serde_json::from_slice(&fs::read(intent_path).unwrap()).unwrap();
    let operation_path = fs::read_dir(root.path().join(".hetu/operations"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            serde_json::from_slice::<Value>(&fs::read(path).unwrap()).unwrap()["key"]
                == "recover-document"
        })
        .unwrap();
    let mut record: Value = serde_json::from_slice(&fs::read(&operation_path).unwrap()).unwrap();
    use sha2::{Digest, Sha256};
    record["result"]["status"] = json!("unknown");
    record["delivery_id"] = json!(delivery_id);
    record["intent_sha256"] = json!(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec_pretty(&intent).unwrap())
    ));
    fs::write(operation_path, serde_json::to_vec_pretty(&record).unwrap()).unwrap();
    let path = root.path().join(result["path"].as_str().unwrap());
    let altered = b"altered and falsely re-hashed";
    fs::write(&path, altered).unwrap();
    let ready_path = root
        .path()
        .join(format!(".hetu/deliveries/{delivery_id}/ready.json"));
    let mut ready: Value = serde_json::from_slice(&fs::read(&ready_path).unwrap()).unwrap();
    ready["artifact"]["sha256"] = json!(format!("{:x}", Sha256::digest(altered)));
    ready["artifact"]["size_bytes"] = json!(altered.len());
    fs::write(ready_path, serde_json::to_vec_pretty(&ready).unwrap()).unwrap();
    assert_eq!(
        call(&k, "documents.export", input)["error"]["code"],
        "hetu.integrity_failure"
    );
    assert_eq!(fs::read(path).unwrap(), altered);
}
