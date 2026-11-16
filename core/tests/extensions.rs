use hetu_core::{application::extensions::PluginSession, Kernel};
use serde_json::{json, Value};
fn fixture(path: &std::path::Path) -> (Kernel, Value) {
    let kernel=Kernel::open(json!({"workspace_path":path,"mode":"author","create":{"title":"插件闭环","locale":"zh-CN","operation_key":"fixture"}})).unwrap();
    let works =
        kernel.request(json!({"action":"hetu.works.list","contract_revision":"1","input":{}}));
    (kernel, works["data"]["works"][0]["work_ref"].clone())
}
fn authorize(
    kernel: &Kernel,
    dir: &std::path::Path,
    work: &Value,
    permissions: Value,
    key: &str,
) -> Value {
    let r=kernel.extension_host_request_in(dir,json!({"method":"authorize","params":{"work_ref":work,"plugin_id":"org.hetu.relationships","package_sha256":"a".repeat(64),"permissions":permissions,"types":[{"kind":"relationships","schema_version":"1","schema":{"type":"object","required":["nodes"],"additionalProperties":false,"properties":{"nodes":{"type":"array","items":{"type":"string"}}}}}],"operation_key":key}}));
    assert_eq!(r["status"], "succeeded", "{r}");
    r["data"].clone()
}
fn req(action: &str, input: Value) -> Value {
    json!({"action":format!("hetu.extensions.{action}"),"contract_revision":"1","input":input})
}
fn call(kernel: &Kernel, action: &str, input: Value) -> Value {
    let result = kernel
        .request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}));
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}

#[test]
fn fixed_domain_sources_reject_forgery_preserve_history_and_do_not_grant_domain_access() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("作品");
    let dir = root.path().join("private");
    let (kernel, work) = fixture(&path);
    let document = call(
        &kernel,
        "documents.create",
        json!({"kind":"novel_chapter","title":"雾港","source_format":"markdown","content":"江岚在雾中看见灯塔。🌿","operation_key":"source-document"}),
    );
    let blueprint = call(&kernel, "blueprints.get", json!({"work_ref":work}));
    let profile = call(&kernel, "works.get", json!({"work_ref":work}));
    let mut metadata = profile["summary"]["fixed_ref"].clone();
    metadata["kind"] = json!("work");
    let sources = json!([
        {"kind":"document","work_ref":work,"document_id":document["document"]["document_id"],"revision_id":document["revision"]["revision_id"],"sha256":document["revision"]["sha256"]},
        {"kind":"blueprint","work_ref":work,"blueprint_id":blueprint["blueprint"]["blueprint_id"],"revision":blueprint["blueprint"]["revision"],"sha256":blueprint["sha256"]},
        metadata
    ]);
    let grant = authorize(
        &kernel,
        &dir,
        &work,
        json!(["objects.read", "objects.write"]),
        "grant",
    );
    let session = PluginSession::open(
        &path,
        &dir,
        grant["grant_id"].as_str().unwrap(),
        &"a".repeat(64),
    )
    .unwrap();
    let input = json!({"work_ref":work,"kind":"relationships","title":"固定人物关系","schema_version":"1","content":{"nodes":["江岚"]},"source_refs":sources,"expected_revision":0,"expected_sha256":"","operation_key":"sources-create"});
    let first = session.request(req("objects.save", input.clone()));
    assert_eq!(first["status"], "succeeded", "{first}");
    assert_eq!(first["data"]["object"]["source_refs"], sources);
    // 领域来源不是新的读取权限。
    let domain = session.request(json!({"action":"hetu.documents.get","contract_revision":"1","input":{"document_id":document["document"]["document_id"]}}));
    assert_ne!(domain["status"], "succeeded", "{domain}");
    let mut forged = input.clone();
    forged["operation_key"] = json!("forged-sha");
    forged["source_refs"][0]["sha256"] = json!("b".repeat(64));
    assert_eq!(
        session.request(req("objects.save", forged))["error"]["code"],
        "hetu.stale_evidence"
    );
    let drama = call(
        &kernel,
        "drama.projects.create",
        json!({"title":"独立剧本","mode":"original","operation_key":"drama"}),
    );
    let episode = call(
        &kernel,
        "drama.episodes.create",
        json!({"project_ref":{"project_id":drama["project"]["project_id"],"revision":1,"sha256":drama["sha256"]},"title":"第一集","plan":"独立故事","language_tag":"zh-CN","operation_key":"episode"}),
    );
    let foreign_document = call(
        &kernel,
        "documents.get",
        json!({"document_id":episode["episode"]["document_id"]}),
    );
    let mut foreign = input.clone();
    foreign["operation_key"] = json!("foreign-document");
    foreign["source_refs"][0] = json!({"kind":"document","work_ref":work,"document_id":foreign_document["document"]["document_id"],"revision_id":foreign_document["revision"]["revision_id"],"sha256":foreign_document["revision"]["sha256"]});
    assert_eq!(
        session.request(req("objects.save", foreign.clone()))["error"]["code"],
        "forbidden"
    );
    foreign["operation_key"] = json!("foreign-work");
    foreign["source_refs"][0]["work_ref"] = json!({"workspace_id":work["workspace_id"],"kind":"drama","object_id":drama["project"]["project_id"]});
    assert_eq!(
        session.request(req("objects.save", foreign))["error"]["code"],
        "forbidden"
    );
    call(
        &kernel,
        "documents.save",
        json!({"document_id":document["document"]["document_id"],"base_revision_id":document["revision"]["revision_id"],"source_format":"markdown","content":"新版正文不回写旧人物关系。","operation_key":"source-advance"}),
    );
    // 相同原键在来源推进后仍回到原回执。
    assert_eq!(session.request(req("objects.save", input.clone())), first);
    let mut next = input;
    next.as_object_mut().unwrap().remove("source_refs");
    next["object_id"] = first["data"]["object"]["object_id"].clone();
    next["expected_revision"] = json!(1);
    next["expected_sha256"] = first["data"]["sha256"].clone();
    next["operation_key"] = json!("sources-keep");
    next["content"] = json!({"nodes":["江岚","叶渡"]});
    let second = session.request(req("objects.save", next));
    assert_eq!(second["status"], "succeeded", "{second}");
    assert_eq!(second["data"]["object"]["source_refs"], sources);
    let history = session.request(req(
        "objects.get",
        json!({"work_ref":work,"object_id":first["data"]["object"]["object_id"],"revision":1}),
    ));
    assert_eq!(history["data"]["object"]["source_refs"], sources);
    let revoked = kernel.extension_host_request_in(
        &dir,
        json!({"method":"revoke","params":{"grant_id":grant["grant_id"]}}),
    );
    assert_eq!(revoked["status"], "succeeded");
    let export = kernel.extension_host_request_in(&dir, json!({"method":"read","params":{"work_ref":work,"plugin_id":"org.hetu.relationships","request":req("objects.export",json!({"work_ref":work,"object_id":first["data"]["object"]["object_id"],"format":"json"}))}}));
    assert_eq!(export["status"], "succeeded", "{export}");
    assert_eq!(export["data"]["object"]["source_refs"], sources);
}
#[test]
fn isolated_plugin_data_survives_reopen_revocation_and_missing_code() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("中文 空格");
    let dir = root.path().join("private");
    let (kernel, work) = fixture(&path);
    assert!(work.is_object(), "{work}");
    let grant = authorize(
        &kernel,
        &dir,
        &work,
        json!(["objects.read", "objects.write"]),
        "grant",
    );
    let open = || {
        PluginSession::open(
            &path,
            &dir,
            grant["grant_id"].as_str().unwrap(),
            &"a".repeat(64),
        )
        .unwrap()
    };
    let session = open();
    assert_eq!(
        session.request(req("objects.list", json!({"work_ref":work})))["data"]["objects"],
        json!([])
    );
    let input = json!({"work_ref":work,"kind":"relationships","title":"人物网🌿","schema_version":"1","content":{"nodes":["江岚","叶渡"]},"expected_revision":0,"expected_sha256":"","operation_key":"create"});
    let first = session.request(req("objects.save", input.clone()));
    assert_eq!(first["status"], "succeeded", "{first}");
    assert_eq!(open().request(req("objects.save", input.clone())), first);
    let mut changed = input.clone();
    changed["title"] = json!("异输入");
    assert_eq!(
        session.request(req("objects.save", changed))["error"]["code"],
        "idempotency_conflict"
    );
    let mut next = input.clone();
    next["object_id"] = first["data"]["object"]["object_id"].clone();
    next["expected_revision"] = json!(1);
    next["expected_sha256"] = first["data"]["sha256"].clone();
    next["operation_key"] = json!("update");
    next["content"] = json!({"nodes":["叶渡"]});
    let second = session.request(req("objects.save", next.clone()));
    assert_eq!(second["status"], "succeeded", "{second}");
    next["operation_key"] = json!("stale");
    assert_eq!(
        session.request(req("objects.save", next))["error"]["code"],
        "revision_conflict"
    );
    let mut read =
        json!({"work_ref":work,"object_id":first["data"]["object"]["object_id"],"revision":1});
    assert_eq!(
        open().request(req("objects.get", read.clone()))["data"]["object"]["content"],
        input["content"]
    );
    read["work_ref"]["object_id"] = json!("novel_11111111-1111-4111-8111-111111111111");
    assert_eq!(
        session.request(req("objects.get", read))["error"]["code"],
        "forbidden"
    );
    assert!(PluginSession::open(
        &path,
        &dir,
        grant["grant_id"].as_str().unwrap(),
        &"b".repeat(64)
    )
    .is_err());
    let revoked = kernel.extension_host_request_in(
        &dir,
        json!({"method":"revoke","params":{"grant_id":grant["grant_id"]}}),
    );
    assert_eq!(revoked["status"], "succeeded");
    assert_eq!(
        session.request(req("objects.list", json!({"work_ref":work})))["error"]["code"],
        "forbidden"
    );
    let exported=kernel.extension_host_request_in(&dir,json!({"method":"read","params":{"work_ref":work,"plugin_id":"org.hetu.relationships","request":req("objects.export",json!({"work_ref":work,"object_id":first["data"]["object"]["object_id"],"format":"markdown"}))}}));
    assert_eq!(exported["status"], "succeeded", "{exported}");
    assert!(exported["data"]["content"]
        .as_str()
        .unwrap()
        .contains("叶渡"));
    assert!(std::fs::read_to_string(path.join(".heturc.json"))
        .unwrap()
        .find("grant_")
        .is_none());
}
#[test]
fn schema_readonly_and_foreign_workspace_fail_closed() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("work");
    let dir = root.path().join("private");
    let (kernel, work) = fixture(&path);
    let grant = authorize(&kernel, &dir, &work, json!(["objects.read"]), "read-only");
    let session = PluginSession::open(
        &path,
        &dir,
        grant["grant_id"].as_str().unwrap(),
        &"a".repeat(64),
    )
    .unwrap();
    let input = json!({"work_ref":work,"kind":"relationships","title":"测试","schema_version":"1","content":{"unknown":1},"expected_revision":0,"expected_sha256":"","operation_key":"bad"});
    assert_eq!(
        session.request(req("objects.save", input.clone()))["error"]["code"],
        "forbidden"
    );
    let grant = authorize(
        &kernel,
        &dir,
        &work,
        json!(["objects.read", "objects.write"]),
        "write",
    );
    let session = PluginSession::open(
        &path,
        &dir,
        grant["grant_id"].as_str().unwrap(),
        &"a".repeat(64),
    )
    .unwrap();
    assert_ne!(
        session.request(req("objects.save", input))["status"],
        "succeeded"
    );
    let foreign = root.path().join("foreign");
    fixture(&foreign);
    assert!(PluginSession::open(
        &foreign,
        &dir,
        grant["grant_id"].as_str().unwrap(),
        &"a".repeat(64)
    )
    .is_err());
}

#[test]
fn damaged_grants_fail_closed_and_local_disable_needs_no_workspace() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("work");
    let dir = root.path().join("private");
    let (kernel, work) = fixture(&path);
    let grant = authorize(
        &kernel,
        &dir,
        &work,
        json!(["objects.read", "objects.write"]),
        "grant",
    );
    let grant_id = grant["grant_id"].as_str().unwrap();
    let file = dir.join("grants").join(format!("{grant_id}.json"));
    let session = PluginSession::open(&path, &dir, grant_id, &"a".repeat(64)).unwrap();
    for field in ["permissions", "types", "root", "grant_id", "work_ref"] {
        let mut damaged = grant.clone();
        damaged[field] = Value::Null;
        std::fs::write(&file, serde_json::to_vec(&damaged).unwrap()).unwrap();
        assert!(PluginSession::open(&path, &dir, grant_id, &"a".repeat(64)).is_err());
        assert_eq!(session.inspect()["error"]["code"], "hetu.integrity_failure");
        assert_eq!(
            session.request(req("objects.list", json!({"work_ref":work})))["error"]["code"],
            "hetu.integrity_failure"
        );
    }
    std::fs::write(&file, serde_json::to_vec(&grant).unwrap()).unwrap();
    let disabled = hetu_core::application::extensions::disable_package_in(
        &dir,
        "org.hetu.relationships",
        &"a".repeat(64),
    )
    .unwrap();
    assert_eq!(disabled["revoked_count"], 1);
    assert_eq!(session.inspect()["error"]["code"], "forbidden");
    let next = authorize(&kernel, &dir, &work, json!(["objects.read"]), "fresh-grant");
    assert_ne!(grant["grant_id"], next["grant_id"]);
    assert!(PluginSession::open(&path, &dir, grant_id, &"a".repeat(64)).is_err());
}

#[test]
fn empty_data_permissions_bind_computation_without_exposing_work_objects() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("作品");
    let directory = root.path().join("绑定");
    let (kernel, work) = fixture(&path);
    let params = json!({"work_ref":work,"plugin_id":"org.hetu.counter","package_sha256":"b".repeat(64),"permissions":[],"types":[],"operation_key":"bind-computation"});
    let binding =
        kernel.extension_host_request_in(&directory, json!({"method":"authorize","params":params}));
    assert_eq!(binding["status"], "succeeded", "{binding}");
    let grant = binding["data"]["grant_id"].as_str().unwrap();
    let session = PluginSession::open(&path, &directory, grant, &"b".repeat(64)).unwrap();
    let inspected = session.inspect();
    assert_eq!(inspected["status"], "succeeded", "{inspected}");
    assert_eq!(inspected["data"]["actions"], json!([]));
    assert_eq!(inspected["data"]["permissions"], json!([]));
    assert_eq!(
        kernel.extension_host_request_in(
            &directory,
            json!({"method":"inspect","params":{"grant_id":grant,"package_sha256":"b".repeat(64)}})
        ),
        inspected
    );
    assert_eq!(
        session.request(req("objects.list", json!({"work_ref":work})))["error"]["code"],
        "forbidden"
    );
    let mut invalid = params;
    invalid["permissions"] = json!(["objects.read"]);
    invalid["operation_key"] = json!("invalid-read");
    assert_eq!(
        kernel
            .extension_host_request_in(&directory, json!({"method":"authorize","params":invalid}))
            ["error"]["code"],
        "invalid_input"
    );
    let revoke = kernel.extension_host_request_in(
        &directory,
        json!({"method":"revoke","params":{"grant_id":grant}}),
    );
    assert_eq!(revoke["status"], "succeeded");
    assert_eq!(session.inspect()["error"]["code"], "forbidden");
}
