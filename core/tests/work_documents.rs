use hetu_core::{Kernel, collaboration::CollaborationHub};
use serde_json::{Value, json};

fn call(kernel: &Kernel, action: &str, input: Value) -> Value {
    kernel.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(result: Value) -> Value {
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn agent(hub: &CollaborationHub, grant: &Value, action: &str, mut input: Value) -> Value {
    input["management_ref"] = grant.clone();
    hub.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn setup(root: &std::path::Path) -> (Kernel, CollaborationHub, Value, Value) {
    let kernel = Kernel::open(json!({"workspace_path":root.join("作品"),"mode":"author",
        "create":{"title":"末班车","locale":"zh-CN","operation_key":"init"}}))
    .unwrap();
    let reference = ok(call(&kernel, "works.list", json!({})))["works"][0]["work_ref"].clone();
    let directory = root.join("授权");
    let grant = ok(call(
        &kernel,
        "collaboration.authorize_workspace",
        json!({"work_ref":reference,
        "client_adapter":"codex","collaboration_path":directory,"operation_key":"authorize"}),
    ))["management_ref"]
        .clone();
    (
        kernel,
        CollaborationHub::open(&directory, "codex").unwrap(),
        reference,
        grant,
    )
}
fn chapter(kernel: &Kernel, key: &str) -> Value {
    ok(call(
        kernel,
        "documents.create",
        json!({"kind":"novel_chapter","title":"雨夜","content":"雨落在旧站，阿青仍在等车。\r\n", "source_format":"markdown","operation_key":key}),
    ))
}

#[test]
fn title_search_returns_fixed_revision_refs_for_only_the_selected_authorized_page() {
    let root=tempfile::tempdir().unwrap();
    let (k,hub,work,grant)=setup(root.path());
    for (index,title) in ["灯塔 Codex","旧站 codex","另一份原稿"].iter().enumerate(){
        ok(call(&k,"documents.create",json!({"kind":"novel_chapter","title":title,"source_format":"markdown",
            "content":format!("原文{index}🌿\r\n"),"operation_key":format!("search-{index}")})));
    }
    let query=json!({"work_ref":work,"query":" coDEX ","include_revision_ref":true,"limit":1});
    let first=ok(agent(&hub,&grant,"documents.list",query.clone()));
    assert_eq!(first["documents"].as_array().unwrap().len(),1);
    let row=&first["documents"][0];
    let content=ok(agent(&hub,&grant,"documents.get",json!({"document_id":row["document_id"],"revision_id":row["current_revision_id"]})));
    assert_eq!(row["current_revision_ref"],json!({"revision_id":content["revision"]["revision_id"],
        "sha256":content["revision"]["sha256"],"size_bytes":content["revision"]["size_bytes"]}));
    assert!(row.get("content").is_none());
    let mut next=query.clone();next["cursor"]=first["next_cursor"].clone();
    let second=ok(agent(&hub,&grant,"documents.list",next.clone()));
    assert_ne!(second["documents"][0]["document_id"],row["document_id"]);
    assert!(second["next_cursor"].is_null());
    next["query"]=json!("另一份");
    assert_eq!(agent(&hub,&grant,"documents.list",next)["error"]["code"],"cursor_invalid");
    let plain=ok(agent(&hub,&grant,"documents.list",json!({"work_ref":work,"query":"","limit":10})));
    assert_eq!(plain["documents"].as_array().unwrap().len(),3);
    assert!(plain["documents"].as_array().unwrap().iter().all(|row|row.get("current_revision_ref").is_none()));
    let foreign=episode(&k,"other").0;
    let mut bad=query;bad["work_ref"]=foreign;
    assert_eq!(agent(&hub,&grant,"documents.list",bad)["error"]["code"],"forbidden");
}
fn episode(kernel: &Kernel, key: &str) -> (Value, Value) {
    let project = ok(call(
        kernel,
        "drama.projects.create",
        json!({"title":"末班车","mode":"original","operation_key":format!("project-{key}")}),
    ));
    let episode = ok(call(
        kernel,
        "drama.episodes.create",
        json!({"project_ref":{"project_id":project["project"]["project_id"],
        "revision":1,"sha256":project["sha256"]},"title":"雨夜","plan":"空作者稿与参考稿分开。","language_tag":"zh-CN","operation_key":key}),
    ));
    (
        json!({"workspace_id":kernel.scope(),"kind":"drama","object_id":project["project"]["project_id"]}),
        episode,
    )
}
fn authorize(kernel: &Kernel, root: &std::path::Path, reference: &Value, key: &str) -> Value {
    ok(call(
        kernel,
        "collaboration.authorize_workspace",
        json!({"work_ref":reference,"client_adapter":"codex",
        "collaboration_path":root.join("授权"),"operation_key":key}),
    ))["management_ref"]
        .clone()
}

#[test]
fn exact_novel_reads_directory_and_fixed_history_but_never_sibling_scripts_or_writes() {
    let root = tempfile::tempdir().unwrap();
    let (k, hub, reference, grant) = setup(root.path());
    let first = chapter(&k, "first");
    chapter(&k, "second");
    let (_, drama) = episode(&k, "other-script");
    let original = &first["revision"]["revision_id"];
    let updated = ok(call(
        &k,
        "documents.save",
        json!({"document_id":first["document"]["document_id"],"base_revision_id":original,
        "source_format":"markdown","content":"车站改名了，旧稿仍保留。","operation_key":"author-save"}),
    ));
    assert_eq!(
        agent(&hub, &grant, "documents.list", json!({}))["error"]["code"],
        "forbidden"
    );
    let page = ok(agent(
        &hub,
        &grant,
        "documents.list",
        json!({"work_ref":reference,"limit":1}),
    ));
    let next = ok(agent(
        &hub,
        &grant,
        "documents.list",
        json!({"work_ref":reference,"limit":1,"cursor":page["next_cursor"]}),
    ));
    assert_eq!(page["documents"].as_array().unwrap().len(), 1);
    assert_ne!(
        page["documents"][0]["document_id"],
        next["documents"][0]["document_id"]
    );
    assert!(next["next_cursor"].is_null());
    let history = ok(agent(
        &hub,
        &grant,
        "documents.history",
        json!({"document_id":first["document"]["document_id"],"limit":1}),
    ));
    assert_eq!(
        history["revisions"][0]["revision_id"],
        updated["revision"]["revision_id"]
    );
    let previous = ok(agent(
        &hub,
        &grant,
        "documents.history",
        json!({"document_id":first["document"]["document_id"],"limit":1,"cursor":history["next_cursor"]}),
    ));
    assert_eq!(previous["revisions"][0]["revision_id"], *original);
    assert!(previous["next_cursor"].is_null());
    let old = ok(agent(
        &hub,
        &grant,
        "documents.get",
        json!({"document_id":first["document"]["document_id"],"revision_id":original}),
    ));
    assert_eq!(old["content"], "雨落在旧站，阿青仍在等车。\r\n");
    assert_eq!(old["work_ref"], reference);
    assert!(old["document"].get("work_ref").is_none());
    assert_eq!(old["revision"], first["revision"]);
    assert_ne!(old["document"]["current_revision_id"], *original);
    for action in ["documents.get", "documents.history"] {
        assert_eq!(
            agent(
                &hub,
                &grant,
                action,
                json!({"document_id":drama["episode"]["document_id"]})
            )["error"]["code"],
            "forbidden"
        );
    }
    let save = agent(
        &hub,
        &grant,
        "documents.save",
        json!({"document_id":first["document"]["document_id"],
        "base_revision_id":updated["revision"]["revision_id"],"source_format":"markdown","content":"不允许替作者改稿","operation_key":"not-allowed"}),
    );
    assert_ne!(save["status"], "succeeded");
    let current = ok(call(
        &k,
        "documents.get",
        json!({"document_id":first["document"]["document_id"]}),
    ));
    assert_eq!(current["content"], "车站改名了，旧稿仍保留。");
    assert_eq!(current["work_ref"], reference);
}

#[test]
fn exact_drama_filters_same_title_projects_and_legacy_unowned_scripts() {
    let root = tempfile::tempdir().unwrap();
    let (k, hub, novel, _) = setup(root.path());
    let n = chapter(&k, "novel");
    let (reference, owned) = episode(&k, "owned");
    let (sibling, other) = episode(&k, "sibling");
    let unowned = ok(call(
        &k,
        "documents.create",
        json!({"kind":"drama_script","title":"雨夜","content":"INT. 旧站 - NIGHT\n\n未归属剧本。",
        "source_format":"fountain","operation_key":"unowned"}),
    ));
    let grant = authorize(&k, root.path(), &reference, "drama-grant");
    let listing = ok(agent(
        &hub,
        &grant,
        "documents.list",
        json!({"work_ref":reference}),
    ));
    assert_eq!(listing["documents"].as_array().unwrap().len(), 1);
    assert_eq!(
        listing["documents"][0]["document_id"],
        owned["episode"]["document_id"]
    );
    for reference in [&novel, &sibling] {
        assert_eq!(
            agent(
                &hub,
                &grant,
                "documents.list",
                json!({"work_ref":reference})
            )["error"]["code"],
            "forbidden"
        );
    }
    for document in [
        &n["document"]["document_id"],
        &other["episode"]["document_id"],
        &unowned["document"]["document_id"],
    ] {
        assert_eq!(
            agent(
                &hub,
                &grant,
                "documents.get",
                json!({"document_id":document})
            )["error"]["code"],
            "forbidden"
        );
    }
    let script = ok(agent(
        &hub,
        &grant,
        "documents.get",
        json!({"document_id":owned["episode"]["document_id"]}),
    ));
    assert_eq!(script["content"], "");
    assert_eq!(script["work_ref"], reference);
    assert!(script["document"].get("work_ref").is_none());
    let sibling_script = ok(call(
        &k,
        "documents.get",
        json!({"document_id":other["episode"]["document_id"]}),
    ));
    assert_eq!(sibling_script["work_ref"], sibling);
    let legacy_script = ok(call(
        &k,
        "documents.get",
        json!({"document_id":unowned["document"]["document_id"]}),
    ));
    assert_eq!(legacy_script["work_ref"], Value::Null);
    assert_eq!(legacy_script["revision"], unowned["revision"]);
    let caps = ok(agent(&hub, &grant, "capabilities.get", json!({})));
    assert_eq!(caps["work_ref"], reference);
    for name in ["hetu.documents.list", "hetu.creative_tasks.list"] {
        let action = caps["actions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["name"] == name)
            .unwrap();
        assert!(
            action["input_schema"]["required"]
                .as_array()
                .unwrap()
                .contains(&json!("work_ref"))
        );
        assert_eq!(
            action["input_schema"]["properties"]["work_ref"]["const"],
            reference
        );
        jsonschema::validator_for(&action["input_schema"]).unwrap();
    }
}

#[test]
fn directory_cursors_bind_authorization_query_and_content_and_revoke_immediately() {
    let root = tempfile::tempdir().unwrap();
    let (k, hub, reference, grant) = setup(root.path());
    let first = chapter(&k, "one");
    chapter(&k, "two");
    let page = ok(agent(
        &hub,
        &grant,
        "documents.list",
        json!({"work_ref":reference,"limit":1}),
    ));
    let cursor = &page["next_cursor"];
    assert_eq!(
        agent(
            &hub,
            &grant,
            "documents.list",
            json!({"work_ref":reference,"limit":1,"kind":"novel_outline","cursor":cursor})
        )["error"]["code"],
        "cursor_invalid"
    );
    chapter(&k, "third");
    assert_eq!(
        agent(
            &hub,
            &grant,
            "documents.list",
            json!({"work_ref":reference,"limit":1,"cursor":cursor})
        )["error"]["code"],
        "cursor_invalid"
    );
    let fresh = ok(agent(
        &hub,
        &grant,
        "documents.list",
        json!({"work_ref":reference,"limit":1}),
    ));
    ok(call(
        &k,
        "collaboration.revoke_management",
        json!({"grant_id":grant["grant_id"],"client_adapter":"codex",
        "collaboration_path":root.path().join("授权"),"operation_key":"revoke"}),
    ));
    assert_eq!(
        agent(
            &hub,
            &grant,
            "documents.get",
            json!({"document_id":first["document"]["document_id"]})
        )["error"]["code"],
        "forbidden"
    );
    let renewed = authorize(&k, root.path(), &reference, "renew");
    assert_ne!(renewed, grant);
    assert_eq!(
        agent(
            &hub,
            &renewed,
            "documents.list",
            json!({"work_ref":reference,"limit":1,"cursor":fresh["next_cursor"]})
        )["error"]["code"],
        "cursor_invalid"
    );
    assert_eq!(
        ok(agent(
            &hub,
            &renewed,
            "documents.list",
            json!({"work_ref":reference})
        ))["documents"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn task_discovery_stays_in_work_and_does_not_grant_task_execution() {
    let root = tempfile::tempdir().unwrap();
    let (k, hub, novel, novel_grant) = setup(root.path());
    let n = chapter(&k, "novel");
    let (drama, episode) = episode(&k, "drama");
    let grant = authorize(&k, root.path(), &drama, "drama-grant");
    let prepare = |reference: &Value, task_kind: &str, document_id: &Value, key: &str| {
        let doc = ok(call(
            &k,
            "documents.get",
            json!({"document_id":document_id}),
        ));
        let preview = ok(call(
            &k,
            "creative_tasks.preview_prompt",
            json!({"scope_ref":{"kind":"workspace","id":k.scope()},
            "work_ref":reference,"task_kind":task_kind,"brief":"沿本任务继续，不新建同义任务。","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN",
            "target_ref":{"document_id":document_id,"revision_id":doc["revision"]["revision_id"],"sha256":doc["revision"]["sha256"]}}),
        ));
        let mut input = preview["prepare_input"].clone();
        input["operation_key"] = json!(key);
        ok(call(&k, "creative_tasks.prepare", input))
    };
    let nt = prepare(&novel, "chapter_draft", &n["document"]["document_id"], "nt");
    let dt = prepare(
        &drama,
        "drama_draft",
        &episode["episode"]["document_id"],
        "dt",
    );
    for (reference, granted, task) in [(&novel, &novel_grant, &nt), (&drama, &grant, &dt)] {
        let list = ok(agent(
            &hub,
            granted,
            "creative_tasks.list",
            json!({"work_ref":reference,"limit":1}),
        ));
        assert_eq!(list["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(list["tasks"][0]["task_ref"], task["task_ref"]);
        assert_eq!(
            agent(&hub, granted, "creative_tasks.list", json!({}))["error"]["code"],
            "forbidden"
        );
        let locator = &list["tasks"][0]["task_locator"];
        assert_eq!(
            *locator,
            json!({"scope_ref":task["task_ref"]["scope_ref"],"task_id":task["task_ref"]["task_id"]})
        );
        let opened = hub.request(json!({"action":"hetu.collaboration.open","contract_revision":"1","input":{"task_locator":locator}}));
        assert_eq!(opened["error"]["code"], "forbidden");
    }
    assert_eq!(
        agent(
            &hub,
            &grant,
            "creative_tasks.list",
            json!({"work_ref":drama,"target_document_id":n["document"]["document_id"]})
        )["error"]["code"],
        "forbidden"
    );
}

#[test]
fn machine_directory_has_a_bounded_default_and_legacy_author_directory_stays_complete() {
    let root = tempfile::tempdir().unwrap();
    let (k, hub, reference, grant) = setup(root.path());
    for number in 0..51 {
        chapter(&k, &format!("chapter-{number}"));
    }
    let first = ok(agent(
        &hub,
        &grant,
        "documents.list",
        json!({"work_ref":reference}),
    ));
    assert_eq!(first["documents"].as_array().unwrap().len(), 50);
    let second = ok(agent(
        &hub,
        &grant,
        "documents.list",
        json!({"work_ref":reference,"cursor":first["next_cursor"]}),
    ));
    assert_eq!(second["documents"].as_array().unwrap().len(), 1);
    assert!(second["next_cursor"].is_null());
    assert_eq!(
        ok(call(&k, "documents.list", json!({})))["documents"]
            .as_array()
            .unwrap()
            .len(),
        51
    );
    assert_eq!(
        ok(call(&k, "documents.list", json!({"limit":10})))["documents"]
            .as_array()
            .unwrap()
            .len(),
        10
    );
    assert_eq!(
        agent(
            &hub,
            &grant,
            "documents.list",
            json!({"work_ref":reference,"limit":201})
        )["error"]["code"],
        "invalid_input"
    );
}
