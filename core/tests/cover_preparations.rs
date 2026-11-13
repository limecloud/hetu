use hetu_core::Kernel;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, io::Cursor, path::Path};

fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(value: Value) -> Value {
    assert_eq!(value["status"], "succeeded", "{value}");
    value["data"].clone()
}
fn sha(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn prepared(parent: &Path) -> (Kernel, Value, Value, Vec<u8>) {
    let path = parent.join("筹备");
    fs::create_dir(&path).unwrap();
    let project = Kernel::open(json!({"creation_project_path":path,"mode":"author","create_project":{"brief":"无字灯塔封面","locale":"zh-CN","operation_key":"project"}})).unwrap();
    let preview = ok(call(
        &project,
        "creative_tasks.preview_prompt",
        json!({"scope_ref":{"kind":"creation_project","id":project.scope()},"task_kind":"cover","brief":"无字灯塔封面","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN","candidate_limit":1}),
    ));
    let mut input = preview["prepare_input"].clone();
    input["operation_key"] = json!("prepare");
    let task = ok(call(&project, "creative_tasks.prepare", input));
    let agent = Kernel::open(
        json!({"creation_project_path":path,"mode":"agent","task_id":task["task_ref"]["task_id"]}),
    )
    .unwrap();
    let mut buffer = Cursor::new(Vec::new());
    image::RgbImage::from_pixel(128, 192, image::Rgb([32, 150, 100]))
        .write_to(&mut buffer, image::ImageFormat::Png)
        .unwrap();
    let bytes = buffer.into_inner();
    fs::write(
        path.join(
            task["request"]["output_contract"]["relative_inbox"]
                .as_str()
                .unwrap(),
        )
        .join("cover.png"),
        &bytes,
    )
    .unwrap();
    let result = ok(call(
        &agent,
        "creative_tasks.submit_result",
        json!({"task_ref":task["task_ref"],"request_sha256":task["request_sha256"],"candidates":[{"kind":"image","title":"雨夜灯塔","source_format":"image","source_ref_indices":[],"file_name":"cover.png","sha256":sha(&bytes)}],"complete":true,"missing_items":[],"provenance":{"client":"test","skill_version":"1"},"operation_key":"submit"}),
    ));
    let reference = json!({"task_ref":task["task_ref"],"submission_id":result["submission"]["submission_id"],"candidate_id":result["submission"]["candidates"][0]["candidate_id"]});
    (
        project,
        reference,
        result["submission"]["candidates"][0].clone(),
        bytes,
    )
}
fn create(project: &Kernel, parent: &Path) -> Kernel {
    let record = ok(call(
        project,
        "creation_projects.get",
        json!({"project_id":project.scope()}),
    ));
    ok(call(
        project,
        "creation_projects.create_novel",
        json!({"project_id":project.scope(),"expected":{"revision":record["revision"],"sha256":record["sha256"]},"metadata":{"title":"雾港","author_name":"南山","synopsis":"港城旧事","genre":"悬疑","language_tag":"zh-CN","status":"planning"},"target_path":parent.join("小说"),"operation_key":"create"}),
    ));
    Kernel::open(json!({"workspace_path":parent.join("小说"),"mode":"author"})).unwrap()
}
fn select(reference: &Value, expected: Value, key: &str) -> Value {
    json!({"source":{"kind":"preparation","reference":reference},"expected_cover":expected,"presentation":{"crop_rect":{"x":0,"y":0,"width":1,"height":1},"title_overlay":"雾港","author_overlay":"南山"},"operation_key":key})
}

#[test]
fn transfer_preserves_sources_requires_selection_and_survives_missing_preparation() {
    let root = tempfile::tempdir().unwrap();
    let (project, candidate_ref, candidate, original) = prepared(root.path());
    let book = create(&project, root.path());
    let input = json!({"project_path":root.path().join("筹备"),"candidate_ref":candidate_ref,"operation_key":"import"});
    let imported = ok(call(&book, "covers.import_preparation", input.clone()));
    assert!(ok(call(&book, "covers.get", json!({})))["cover"].is_null());
    let asset = &imported["record"]["asset_ref"];
    let asset_data = ok(call(
        &book,
        "assets.get",
        json!({"asset_id":asset["asset_id"],"revision":asset["revision"]}),
    ));
    assert_eq!(
        fs::read(
            root.path()
                .join("小说")
                .join(asset_data["asset"]["blob"]["path"].as_str().unwrap())
        )
        .unwrap(),
        original
    );
    assert_eq!(asset_data["delivery_eligible"], false);
    assert_eq!(imported["record"]["source_ref"]["reference"], candidate_ref);
    assert_eq!(imported["record"]["source_ref"]["candidate"], candidate);
    fs::rename(root.path().join("筹备"), root.path().join("筹备已移走")).unwrap();
    assert_eq!(
        ok(call(&book, "covers.import_preparation", input.clone())),
        imported
    );
    let mut again = input;
    again["operation_key"] = json!("import-again");
    assert_eq!(
        ok(call(&book, "covers.import_preparation", again))["record"],
        imported["record"]
    );
    let list = ok(call(&book, "covers.list_preparations", json!({})));
    assert_eq!(list["imports"].as_array().unwrap().len(), 1);
    assert_eq!(list["imports"][0]["preview"]["width"], 128);
    assert_eq!(list["imports"][0]["preview"]["height"], 192);
    assert_eq!(list["imports"][0]["book_changed"], true);
    let selected = ok(call(
        &book,
        "covers.select",
        select(&imported["reference"], Value::Null, "select"),
    ));
    assert_eq!(
        selected["cover"]["source_ref"],
        imported["record"]["source_ref"]
    );
    assert_eq!(selected["cover"]["asset_ref"], *asset);
    assert_eq!(
        ok(call(&book, "covers.get", json!({})))["cover"],
        selected["cover"]
    );
    assert_eq!(
        call(
            &book,
            "covers.select",
            select(&imported["reference"], Value::Null, "stale")
        )["error"]["code"],
        "revision_conflict"
    );
}

#[test]
fn transfer_rejects_other_books_agents_changed_references_and_damaged_images() {
    let root = tempfile::tempdir().unwrap();
    let (project, reference, candidate, _) = prepared(root.path());
    let book = create(&project, root.path());
    let other_path = root.path().join("另一本书");
    let other = Kernel::open(json!({"workspace_path":other_path,"mode":"author","create":{"title":"别的作品","locale":"zh-CN","operation_key":"other"}})).unwrap();
    let input = json!({"project_path":root.path().join("筹备"),"candidate_ref":reference,"operation_key":"import"});
    assert_eq!(
        call(&other, "covers.import_preparation", input.clone())["error"]["code"],
        "forbidden"
    );
    let unrelated = root.path().join("另一本书的筹备");
    fs::create_dir(&unrelated).unwrap();
    let (other_project, other_ref, _, _) = prepared(&unrelated);
    let _other_book = create(&other_project, &unrelated);
    assert_eq!(
        call(
            &book,
            "covers.import_preparation",
            json!({
                "project_path":unrelated.join("筹备"),"candidate_ref":other_ref,"operation_key":"unrelated-project"
            })
        )["error"]["code"],
        "forbidden"
    );
    let agent =
        Kernel::open(json!({"workspace_path":root.path().join("小说"),"mode":"agent"})).unwrap();
    assert_eq!(
        call(&agent, "covers.import_preparation", input.clone())["error"]["code"],
        "forbidden"
    );
    let mut cross = input.clone();
    cross["candidate_ref"]["task_ref"]["scope_ref"]["id"] = json!(other.scope());
    assert_ne!(
        call(&book, "covers.import_preparation", cross)["status"],
        "succeeded"
    );
    fs::write(
        root.path()
            .join("筹备")
            .join(candidate["relative_path"].as_str().unwrap()),
        b"changed",
    )
    .unwrap();
    assert_ne!(
        call(&book, "covers.import_preparation", input)["status"],
        "succeeded"
    );
    assert!(
        ok(call(&book, "covers.list_preparations", json!({})))["imports"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(ok(call(&book, "covers.get", json!({})))["cover"].is_null());
}

#[test]
fn imported_record_tampering_never_changes_the_selected_cover() {
    let root = tempfile::tempdir().unwrap();
    let (project, reference, _, _) = prepared(root.path());
    let book = create(&project, root.path());
    let imported = ok(call(
        &book,
        "covers.import_preparation",
        json!({"project_path":root.path().join("筹备"),"candidate_ref":reference,"operation_key":"import"}),
    ));
    let path = root
        .path()
        .join("小说/packages/visual-prompt/covers/preparations")
        .join(format!(
            "{}.json",
            imported["reference"]["import_id"].as_str().unwrap()
        ));
    let mut damaged = imported["record"].clone();
    damaged["source_ref"]["completed_project"]["created_workspace_ref"]["workspace_id"] =
        json!("workspace_00000000-0000-4000-8000-000000000001");
    fs::write(path, serde_json::to_vec_pretty(&damaged).unwrap()).unwrap();
    assert_ne!(
        call(&book, "covers.list_preparations", json!({}))["status"],
        "succeeded"
    );
    assert_ne!(
        call(
            &book,
            "covers.select",
            select(&imported["reference"], Value::Null, "select")
        )["status"],
        "succeeded"
    );
    assert!(ok(call(&book, "covers.get", json!({})))["cover"].is_null());
}
