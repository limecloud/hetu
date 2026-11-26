use hetu_core::{Kernel, collaboration::CollaborationHub};
use serde_json::{Value, json};

fn call(kernel: &Kernel, action: &str, input: Value) -> Value {
    kernel.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(value: Value) -> Value {
    assert_eq!(value["status"], "succeeded", "{value}");
    value["data"].clone()
}

#[test]
fn retained_directory_searches_multiple_owners_without_runtime_or_other_work_and_keeps_history(){
    let folder=tempfile::tempdir().unwrap();let directory=folder.path().join("hub");
    let kernel=Kernel::open(json!({"mode":"author","workspace_path":folder.path().join("work"),"create":{"title":"保留成果","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let work=ok(call(&kernel,"works.list",json!({})))["works"][0]["work_ref"].clone();
    let other=ok(call(&kernel,"drama.projects.create",json!({"title":"同根他作","mode":"original","operation_key":"drama"})));
    let foreign=json!({"workspace_id":kernel.scope(),"kind":"drama","object_id":other["project"]["project_id"]});
    let save=|work:&Value,owner:&str,id:Option<&Value>,revision:u64,sha:Value,note:&str,key:&str|{
        let context=json!({"plugin_id":owner,"package_sha256":"a".repeat(64),"work_ref":work,"types":[{"kind":"notes","schema_version":"1","schema":{"type":"object"}}]});
        let mut input=json!({"work_ref":work,"kind":"notes","title":"共享名称","schema_version":"1","content":{"note":note},"expected_revision":revision,"expected_sha256":sha,"operation_key":key});
        if let Some(id)=id{input["object_id"]=id.clone();}
        ok(kernel.open_plugin_request(json!({"context":context,"request":{"action":"hetu.extensions.objects.save","contract_revision":"1","input":input}})))
    };
    let a=save(&work,"org.hetu.owner-a",None,0,json!(""),"第一份固定成果","a");
    let b=save(&work,"org.hetu.owner-b",None,0,json!(""),"第二份固定成果","b");
    save(&foreign,"org.hetu.owner-a",None,0,json!(""),"他作隐藏内容","foreign");
    for owner in ["org.hetu.owner-a","org.hetu.owner-b"]{
        ok(kernel.extension_host_request_in(&folder.path().join("plugin-access"),json!({"method":"disable","params":{"plugin_id":owner,"package_sha256":"a".repeat(64)}})));
    }
    let grant=ok(call(&kernel,"collaboration.authorize_workspace",json!({"work_ref":work,"client_adapter":"codex","collaboration_path":directory,"operation_key":"grant"})))["management_ref"].clone();
    let hub=CollaborationHub::open(&directory,"codex").unwrap();
    let list=|mut input:Value|{input["management_ref"]=grant.clone();hub.request(json!({"action":"hetu.plugin_results.list","contract_revision":"1","input":input}))};
    let input=json!({"work_ref":work,"query":"共享","limit":1});
    let first=ok(list(input.clone()));let mut more=input.clone();more["cursor"]=first["next_cursor"].clone();
    let second=ok(list(more.clone()));assert!(second["next_cursor"].is_null());
    assert_ne!(first["objects"][0]["owner_plugin_id"],second["objects"][0]["owner_plugin_id"]);
    assert!(first["objects"][0].get("content").is_none());
    let all=ok(list(json!({"work_ref":work})));assert_eq!(all["objects"].as_array().unwrap().len(),2);
    assert!(!all.to_string().contains("他作隐藏内容"));assert!(!all.to_string().contains(folder.path().to_str().unwrap()));
    assert_eq!(ok(list(json!({"work_ref":work,"owner_plugin_id":"org.hetu.owner-b"})))["objects"][0]["sha256"],b["sha256"]);
    save(&work,"org.hetu.owner-a",Some(&a["object"]["object_id"]),1,a["sha256"].clone(),"新版内容","next");
    assert_eq!(list(more)["error"]["code"],"cursor_invalid");
    let historical=hub.request(json!({"action":"hetu.plugin_results.get","contract_revision":"1","input":{"management_ref":grant,
        "work_ref":work,"owner_plugin_id":"org.hetu.owner-a","object_id":a["object"]["object_id"],"revision":1}}));
    assert_eq!(ok(historical)["object"],a["object"]);
    assert!(!folder.path().join("work/.hetu/cache/extension-index").exists(),"只读目录不重建持久索引");
    assert_eq!(list(json!({"work_ref":foreign}))["error"]["code"],"forbidden");
    ok(call(&kernel,"collaboration.revoke_management",json!({"grant_id":grant["grant_id"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"revoke"})));
    assert_eq!(list(input)["error"]["code"],"forbidden");
}

#[test]
fn precise_connection_reads_retained_history_without_plugin_runtime_and_cannot_cross_work_or_revocation()
 {
    let folder = tempfile::tempdir().unwrap();
    let directory = folder.path().join("connection");
    let kernel = Kernel::open(
        json!({"workspace_path":folder.path().join("work"),"mode":"author",
        "create":{"title":"专业成果保留","locale":"zh-CN","operation_key":"create"}}),
    )
    .unwrap();
    let work = ok(call(&kernel, "works.list", json!({})))["works"][0]["work_ref"].clone();
    let owner = "org.hetu.retained";
    let context = json!({"plugin_id":owner,"package_sha256":"a".repeat(64),"work_ref":work,
        "types":[{"kind":"notes","schema_version":"1","schema":{"type":"object"}}]});
    let save = |input: Value| {
        ok(kernel.open_plugin_request(json!({"context":context,
        "request":{"action":"hetu.extensions.objects.save","contract_revision":"1","input":input}})))
    };
    let first = save(
        json!({"work_ref":work,"kind":"notes","title":"第一版专业规划","schema_version":"1",
        "content":{"note":"保留第一版"},"expected_revision":0,"expected_sha256":"","operation_key":"first"}),
    );
    let second = save(
        json!({"work_ref":work,"kind":"notes","object_id":first["object"]["object_id"],
        "title":"第二版专业规划","schema_version":"1","content":{"note":"第二版"},
        "expected_revision":1,"expected_sha256":first["sha256"],"operation_key":"second"}),
    );
    // 此包不安装；停用状态不影响Core读取既有固定字节。
    ok(kernel.extension_host_request_in(
        &folder.path().join("plugin-access"),
        json!({"method":"disable",
        "params":{"plugin_id":owner,"package_sha256":"a".repeat(64)}}),
    ));
    let grant = ok(call(
        &kernel,
        "collaboration.authorize_workspace",
        json!({"work_ref":work,
        "client_adapter":"codex","collaboration_path":directory,"operation_key":"grant"}),
    ))["management_ref"]
        .clone();
    let hub = CollaborationHub::open(&directory, "codex").unwrap();
    let input = json!({"work_ref":work,"owner_plugin_id":owner,"object_id":first["object"]["object_id"],"revision":1,"management_ref":grant});
    let read = |input: Value| {
        hub.request(
            json!({"action":"hetu.plugin_results.get","contract_revision":"1","input":input}),
        )
    };
    assert_eq!(ok(read(input.clone()))["object"], first["object"]);
    assert_eq!(ok(read(input.clone()))["sha256"], first["sha256"]);
    let mut latest = input.clone();
    latest["revision"] = json!(2);
    assert_eq!(ok(read(latest))["object"], second["object"]);
    let drama = ok(call(
        &kernel,
        "drama.projects.create",
        json!({"title":"同根他作","mode":"original","operation_key":"drama"}),
    ));
    let mut foreign = input.clone();
    foreign["work_ref"] = json!({"workspace_id":kernel.scope(),"kind":"drama","object_id":drama["project"]["project_id"]});
    assert_eq!(read(foreign)["error"]["code"], "forbidden");
    let mut wrong_owner = input.clone();
    wrong_owner["owner_plugin_id"] = json!("org.hetu.other");
    assert_ne!(read(wrong_owner)["status"], "succeeded");
    let mut unspecified = input.clone();
    unspecified.as_object_mut().unwrap().remove("revision");
    assert_ne!(read(unspecified)["status"], "succeeded");
    ok(call(
        &kernel,
        "collaboration.revoke_management",
        json!({"grant_id":grant["grant_id"],
        "client_adapter":"codex","collaboration_path":directory,"operation_key":"revoke"}),
    ));
    assert_eq!(read(input)["error"]["code"], "forbidden");
}
