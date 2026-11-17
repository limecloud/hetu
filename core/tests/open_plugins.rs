use hetu_core::Kernel;
use serde_json::{Value, json};

fn call(kernel: &Kernel, action: &str, input: Value) -> Value {
    kernel.request(json!({"action":action,"contract_revision":"1","input":input}))
}
fn fixture(path: &std::path::Path) -> (Kernel, Value) {
    let k = Kernel::open(json!({"workspace_path":path,"mode":"author","create":{"title":"开放核心验证","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let work = call(&k, "hetu.works.list", json!({}))["data"]["works"][0]["work_ref"].clone();
    (k, work)
}
fn context(work: &Value) -> Value {
    json!({"plugin_id":"org.test.open","package_sha256":"a".repeat(64),"work_ref":work,
        "types":[{"kind":"plan","schema_version":"1","schema":{"type":"object","required":["text"],"properties":{"text":{"type":"string"}},"additionalProperties":false}}]})
}
fn request(k: &Kernel, context: &Value, action: &str, input: Value) -> Value {
    k.open_plugin_request(json!({"context":context,"request":{"action":action,"contract_revision":"1","input":input}}))
}

#[test]
fn open_sdk_reuses_novel_and_document_services_without_plugin_grants() {
    let folder = tempfile::tempdir().unwrap();
    let (k, work) = fixture(folder.path());
    let ctx = context(&work);
    let catalog = request(&k, &ctx, "hetu.plugins.catalog", json!({}));
    assert_eq!(catalog["status"], "succeeded", "{catalog}");
    assert_eq!(catalog["data"]["access_mode"], "open");
    assert!(
        catalog["data"]["core_actions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["name"] == "hetu.documents.rename")
    );
    let chapter = request(
        &k,
        &ctx,
        "hetu.documents.create",
        json!({"kind":"novel_chapter","title":"旧章名","source_format":"markdown","content":"灯塔 🌿\n江岚","operation_key":"create"}),
    );
    assert_eq!(chapter["status"], "succeeded", "{chapter}");
    let id = chapter["data"]["document"]["document_id"].clone();
    let input = json!({"document_id":id,"base_revision_id":chapter["data"]["revision"]["revision_id"],"title":"正式章名","operation_key":"rename"});
    let renamed = request(&k, &ctx, "hetu.documents.rename", input.clone());
    assert_eq!(renamed["status"], "succeeded", "{renamed}");
    assert_eq!(
        renamed["data"]["revision"]["sha256"],
        chapter["data"]["revision"]["sha256"]
    );
    assert_eq!(
        request(&k, &ctx, "hetu.documents.rename", input.clone()),
        renamed
    );
    let mut stale = input;
    stale["operation_key"] = json!("stale");
    assert_eq!(
        request(&k, &ctx, "hetu.documents.rename", stale)["error"]["code"],
        "revision_conflict"
    );
    let read = call(&k, "hetu.documents.get", json!({"document_id":id}));
    assert_eq!(read["data"]["content"], "灯塔 🌿\n江岚");
    assert_eq!(read["data"]["document"]["title"], "正式章名");
    let snapshot = request(&k, &ctx, "hetu.novels.snapshot", json!({}));
    assert_eq!(snapshot["status"], "succeeded", "{snapshot}");
    assert_eq!(snapshot["data"]["document_count"], 1);
    assert_eq!(snapshot["data"]["word_count"], 5);
    assert_eq!(
        snapshot["data"]["documents"][0]["source_ref"]["revision_id"],
        renamed["data"]["revision"]["revision_id"]
    );
    // 无专业类型的插件也可以使用小说核心，不需要虚构数据类型申请权限。
    let mut compute = ctx.clone();
    compute["types"] = json!([]);
    assert_eq!(
        request(&k, &compute, "hetu.novels.get", json!({}))["status"],
        "succeeded"
    );
}

#[test]
fn open_objects_keep_schema_cas_owner_and_original_operation() {
    let folder = tempfile::tempdir().unwrap();
    let (k, work) = fixture(folder.path());
    let ctx = context(&work);
    let input = json!({"kind":"plan","title":"规划","schema_version":"1","content":{"text":"起点"},"source_refs":[],"expected_revision":0,"expected_sha256":"","operation_key":"save"});
    let saved = request(&k, &ctx, "hetu.extensions.objects.save", input.clone());
    assert_eq!(saved["status"], "succeeded", "{saved}");
    assert_eq!(
        request(&k, &ctx, "hetu.extensions.objects.save", input.clone()),
        saved
    );
    let mut changed = input;
    changed["content"]["text"] = json!("不同输入");
    assert_eq!(
        request(&k, &ctx, "hetu.extensions.objects.save", changed)["error"]["code"],
        "idempotency_conflict"
    );
    let mut other = ctx.clone();
    other["plugin_id"] = json!("org.test.other");
    assert_eq!(
        request(&k, &other, "hetu.extensions.objects.list", json!({}))["data"]["objects"],
        json!([])
    );
    let get = json!({"object_id":saved["data"]["object"]["object_id"],"revision":1});
    assert_eq!(
        request(&k, &ctx, "hetu.extensions.objects.get", get)["data"]["sha256"],
        saved["data"]["sha256"]
    );
    let malformed = request(
        &k,
        &ctx,
        "hetu.extensions.objects.save",
        json!({"kind":"plan","title":"坏数据","schema_version":"1","content":{"unknown":true},"source_refs":[],"expected_revision":0,"expected_sha256":"","operation_key":"bad"}),
    );
    assert_ne!(malformed["status"], "succeeded");
}

#[test]
fn open_sdk_reads_fixed_other_owner_without_transferring_write_ownership() {
    let folder = tempfile::tempdir().unwrap();
    let (k, work) = fixture(folder.path());
    let producer = context(&work);
    let mut consumer = producer.clone();
    consumer["plugin_id"] = json!("org.test.consumer");
    consumer["types"] = json!([]);
    let saved = request(&k, &producer, "hetu.extensions.objects.save", json!({"kind":"plan","title":"上游依据","schema_version":"1","content":{"text":"固定结论"},"source_refs":[],"expected_revision":0,"expected_sha256":"","operation_key":"basis-create"}));
    assert_eq!(saved["status"], "succeeded", "{saved}");
    let read = json!({"owner_plugin_id":"org.test.open","object_id":saved["data"]["object"]["object_id"],"revision":1});
    let first = request(&k, &consumer, "hetu.extensions.objects.get", read.clone());
    assert_eq!(first["data"], saved["data"], "{first}");
    let updated = request(&k, &producer, "hetu.extensions.objects.save", json!({"object_id":saved["data"]["object"]["object_id"],"kind":"plan","title":"上游新版","schema_version":"1","content":{"text":"新的结论"},"source_refs":[],"expected_revision":1,"expected_sha256":saved["data"]["sha256"],"operation_key":"basis-update"}));
    assert_eq!(updated["status"], "succeeded", "{updated}");
    assert_eq!(request(&k, &consumer, "hetu.extensions.objects.get", read.clone())["data"], first["data"]);
    let mut missing_revision = read.clone();
    missing_revision.as_object_mut().unwrap().remove("revision");
    assert_ne!(request(&k, &consumer, "hetu.extensions.objects.get", missing_revision)["status"], "succeeded");
    let mut wrong_owner = read.clone();
    wrong_owner["owner_plugin_id"] = json!("org.test.wrong");
    assert_ne!(request(&k, &consumer, "hetu.extensions.objects.get", wrong_owner)["status"], "succeeded");
    let mut wrong_work = consumer.clone();
    wrong_work["work_ref"]["object_id"] = json!("novel_11111111-1111-4111-8111-111111111111");
    assert_ne!(request(&k, &wrong_work, "hetu.extensions.objects.get", read.clone())["status"], "succeeded");
    assert_ne!(request(&k, &consumer, "hetu.extensions.objects.get", json!({"object_id":read["object_id"],"revision":1}))["status"], "succeeded");
    let mut forged = updated["data"]["object"].clone();
    forged["owner_plugin_id"] = json!("org.test.open");
    assert_ne!(request(&k, &consumer, "hetu.extensions.objects.save", forged)["status"], "succeeded");
}
