use hetu_core::{Kernel, collaboration::CollaborationHub};
use serde_json::{Value, json};

fn call(kernel: &Kernel, action: &str, input: Value) -> Value {
    let result = kernel.request(json!({"action":action,"contract_revision":"1","input":input}));
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn read(hub: &CollaborationHub, input: Value) -> Value {
    hub.request(
        json!({"action":"hetu.collaboration.library","contract_revision":"1","input":input}),
    )
}

#[test]
fn shared_library_lists_registered_works_without_granting_content_and_rechecks_each_grant() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("Collaboration");
    let hub = CollaborationHub::open(&directory, "codex").unwrap();
    let empty = read(&hub, json!({}));
    assert_eq!(empty["data"]["works"], json!([]));
    assert!(!directory.exists(), "读取空库不创建目录");
    let mut records = vec![];
    let mut authors = vec![];
    for title in ["雾港", "长河"] {
        let path = temp.path().join(title);
        let author=Kernel::open(json!({"workspace_path":path,"mode":"author","create":{"title":title,"locale":"zh-CN","operation_key":"create"}})).unwrap();
        let works = call(&author, "hetu.works.list", json!({}));
        let work = works["works"][0]["work_ref"].clone();
        call(
            &author,
            "hetu.documents.create",
            json!({"kind":"novel_chapter","title":"秘密正文","source_format":"markdown","content":"这段正文不能出现在创作库。","operation_key":"chapter"}),
        );
        records.push(json!({"path":path,"workspace_id":author.scope(),"works":[{"work_ref":work,"title":title,"status":"writing","chapter_count":1,"content":"私密缓存不可外发","token":"private"}]}));
        authors.push((author, work));
    }
    let file = temp.path().join("creative-library.json");
    std::fs::write(
        &file,
        serde_json::to_vec(&json!({"schema_version":1,"roots":records})).unwrap(),
    )
    .unwrap();
    let catalog = read(&hub, json!({}));
    assert_eq!(catalog["status"], "succeeded", "{catalog}");
    assert_eq!(catalog["data"]["total"], 2);
    assert!(
        catalog["data"]["works"]
            .as_array()
            .unwrap()
            .iter()
            .all(|w| w["authorized"] == false && w["management_ref"].is_null())
    );
    let text = catalog.to_string();
    for private in [
        "target_path",
        "root_identity",
        "私密缓存不可外发",
        "private",
        "这段正文不能出现在创作库。",
    ] {
        assert!(!text.contains(private), "{private}");
    }
    assert!(!text.contains(temp.path().to_str().unwrap()));
    let grant = call(
        &authors[0].0,
        "hetu.collaboration.authorize_workspace",
        json!({"client_adapter":"codex","collaboration_path":directory,"work_ref":authors[0].1,"operation_key":"authorize"}),
    );
    std::fs::write(directory.join("management/codex").join(format!("{}.json","f".repeat(64))),
        serde_json::to_vec(&json!({"client_adapter":"codex","revoked":false,
            "created_workspace":{"workspace_id":authors[1].0.scope(),"path":temp.path().join("长河"),
                "management_ref":{"scope_ref":{"kind":"workspace","id":authors[1].0.scope()},"grant_id":"f".repeat(64)}}})).unwrap()).unwrap();
    let page = read(&hub, json!({"limit":1}));
    assert_eq!(page["data"]["works"][0]["authorized"], true);
    assert_eq!(
        page["data"]["works"][0]["management_ref"],
        grant["management_ref"]
    );
    let cursor = page["data"]["next_cursor"].clone();
    let second = read(&hub, json!({"limit":1,"cursor":cursor}));
    assert_eq!(second["data"]["works"][0]["title"], "长河");
    assert_eq!(second["data"]["works"][0]["authorized"], false);
    let other = CollaborationHub::open(&directory, "claude-code").unwrap();
    assert!(
        read(&other, json!({}))["data"]["works"]
            .as_array()
            .unwrap()
            .iter()
            .all(|w| w["authorized"] == false)
    );
    call(
        &authors[0].0,
        "hetu.collaboration.revoke_management",
        json!({"client_adapter":"codex","collaboration_path":directory,"grant_id":grant["management_ref"]["grant_id"],"operation_key":"revoke"}),
    );
    assert_eq!(
        read(&hub, json!({"cursor":cursor}))["error"]["code"],
        "hetu.stale_request"
    );
    let revoked = read(&hub, json!({}));
    assert_eq!(revoked["data"]["total"], 2, "撤权不删除目录登记");
    assert_eq!(revoked["data"]["works"][0]["authorized"], false);
    assert!(revoked["data"]["works"][0]["management_ref"].is_null());
    std::fs::write(&file, b"broken").unwrap();
    assert_eq!(
        read(&hub, json!({}))["error"]["code"],
        "hetu.integrity_failure",
        "损坏不能冒充空库"
    );
    assert_eq!(
        read(&hub, json!({"file_path":"/tmp/other"}))["error"]["code"],
        "invalid_input"
    );
}
