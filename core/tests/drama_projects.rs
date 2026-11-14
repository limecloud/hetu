use hetu_core::Kernel;
use serde_json::{Value, json};
fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(v: Value) -> Value {
    assert_eq!(v["status"], "succeeded", "{v}");
    v["data"].clone()
}
fn project_ref(v: &Value) -> Value {
    json!({"project_id":v["project"]["project_id"],"revision":v["project"]["revision"],"sha256":v["sha256"]})
}
#[test]
fn original_drama_has_no_empty_novel_and_episode_order_has_one_owner() {
    let folder = tempfile::tempdir().unwrap();
    let k=Kernel::open(json!({"workspace_path":folder.path(),"mode":"author","create":{"title":"渡口旧事","work_type":"drama","locale":"zh-CN","operation_key":"work"}})).unwrap();
    assert!(!folder.path().join("packages/novel/novel.json").exists());
    assert_eq!(ok(call(&k, "novels.get", json!({})))["initialized"], false);
    assert_eq!(
        call(
            &k,
            "documents.create",
            json!({"kind":"novel_chapter","title":"不应建章","source_format":"markdown","content":"原著参考","operation_key":"no-novel"})
        )["error"]["code"],
        "invalid_input"
    );
    let project = ok(call(
        &k,
        "drama.projects.create",
        json!({"title":"渡口旧事","mode":"original","operation_key":"project"}),
    ));
    let first_input = json!({"project_ref":project_ref(&project),"title":"初见","language_tag":"zh-CN","operation_key":"first"});
    let first = ok(call(&k, "drama.episodes.create", first_input.clone()));
    assert_eq!(first, ok(call(&k, "drama.episodes.create", first_input)));
    let second = ok(call(
        &k,
        "drama.episodes.create",
        json!({"project_ref":project_ref(&first),"title":"再会","language_tag":"zh-CN","operation_key":"second"}),
    ));
    let a = first["episode"]["episode_id"].clone();
    let b = second["episode"]["episode_id"].clone();
    assert!(a.as_str().unwrap().starts_with("depisode_"));
    assert!(first["document"].get("episode_number").is_none());
    let reordered = ok(call(
        &k,
        "drama.episodes.reorder",
        json!({"project_ref":project_ref(&second),"episode_refs":[b,a],"operation_key":"reorder"}),
    ));
    let got = ok(call(
        &k,
        "drama.projects.get",
        json!({"project_id":project["project"]["project_id"]}),
    ));
    assert_eq!(got["episodes"][0]["episode"]["title"], "再会");
    assert_eq!(got["episodes"][1]["episode_number"], 2);
    assert_eq!(
        call(
            &k,
            "drama.episodes.reorder",
            json!({"project_ref":project_ref(&reordered),"episode_refs":[a,a],"operation_key":"bad-order"})
        )["error"]["code"],
        "invalid_input"
    );
    let another = ok(call(
        &k,
        "drama.projects.create",
        json!({"title":"另一个方案","operation_key":"other"}),
    ));
    assert_eq!(
        call(
            &k,
            "drama.projects.attach",
            json!({"project_ref":project_ref(&another),"document_id":first["document"]["document_id"],"title":"不可重用","operation_key":"duplicate"})
        )["error"]["code"],
        "invalid_input"
    );
    let reader = Kernel::open(json!({"workspace_path":folder.path(),"mode":"agent"})).unwrap();
    assert_eq!(
        ok(call(
            &reader,
            "drama.projects.get",
            json!({"project_id":project["project"]["project_id"]})
        ))["project"]["episode_refs"],
        json!([b, a])
    );
    assert_eq!(
        call(
            &reader,
            "drama.episodes.create",
            json!({"project_ref":project_ref(&reordered),"title":"越权","language_tag":"zh-CN","operation_key":"agent"})
        )["error"]["code"],
        "forbidden"
    );
}

#[test]
fn preparation_creates_drama_once_and_keeps_source_receipt_without_a_novel() {
    let folder = tempfile::tempdir().unwrap();
    let planning = folder.path().join("筹备");
    let target = folder.path().join("原创短剧");
    let k=Kernel::open(json!({"creation_project_path":planning,"mode":"author","create_project":{"brief":"渡口重逢的原创短剧","locale":"zh-CN","operation_key":"planning"}})).unwrap();
    let state = ok(call(
        &k,
        "creation_projects.get",
        json!({"project_id":k.scope()}),
    ));
    let profile = json!({"work_type":"drama","drama_mode":"original","language_tag":"zh-CN"});
    let selected = ok(call(
        &k,
        "creation_projects.save",
        json!({"project_id":k.scope(),"expected":{"revision":state["revision"],"sha256":state["sha256"]},"brief":"准备原创短剧。","selected_fields":{},"work_profile":profile,"operation_key":"save-type"}),
    ));
    let preview = ok(call(
        &k,
        "creative_tasks.preview_prompt",
        json!({"scope_ref":{"kind":"creation_project","id":k.scope()},"task_kind":"book_concept","brief":"为短剧构思题名","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN"}),
    ));
    assert_eq!(
        preview["input_snapshot"]["scope_context"]["work_profile"],
        profile
    );
    let input = json!({"project_id":k.scope(),"expected":{"revision":selected["revision"],"sha256":selected["sha256"]},"profile":{"title":"渡口重逢","description":"两个故人在渡口相遇。","mode":"original","language_tag":"zh-CN"},"target_path":target,"operation_key":"create-drama"});
    let mut mismatched = input.clone();
    mismatched["profile"]["mode"] = json!("adaptation");
    mismatched["operation_key"] = json!("wrong-mode");
    assert_eq!(
        call(&k, "creation_projects.create_drama", mismatched)["error"]["code"],
        "revision_conflict"
    );
    assert!(!target.exists());
    let created = ok(call(&k, "creation_projects.create_drama", input.clone()));
    assert_eq!(
        created,
        ok(call(&k, "creation_projects.create_drama", input.clone()))
    );
    assert!(
        created["created_workspace_ref"]["drama_project_id"]
            .as_str()
            .unwrap()
            .starts_with("drama_")
    );
    assert!(!target.join("packages/novel/novel.json").exists());
    let work = Kernel::open(json!({"workspace_path":target,"mode":"author"})).unwrap();
    assert_eq!(
        ok(call(&work, "workspaces.get", json!({})))["workspace"]["work_type"],
        "drama"
    );
    let source: Value =
        serde_json::from_slice(&std::fs::read(target.join(".hetu/creation-source.json")).unwrap())
            .unwrap();
    assert_eq!(source["work_profile"], profile);
    assert_eq!(
        ok(call(&work, "drama.projects.list", json!({})))["projects"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let resumed = Kernel::open(json!({"creation_project_path":planning,"mode":"author"})).unwrap();
    assert_eq!(
        created,
        ok(call(&resumed, "creation_projects.create_drama", input))
    );
    let pending = ok(call(
        &work,
        "drama.projects.create",
        json!({"title":"改编筹划","mode":"adaptation","operation_key":"adaptation"}),
    ));
    assert_eq!(pending["project"]["source_refs"], json!([]));
}

#[test]
fn episode_metadata_conflicts_and_archival_keep_script_and_history_readable() {
    let folder = tempfile::tempdir().unwrap();
    let kernel = Kernel::open(json!({
        "workspace_path":folder.path(), "mode":"author",
        "create":{"title":"渡口剧本","work_type":"drama","locale":"zh-CN","operation_key":"init"}
    }))
    .unwrap();
    let project = ok(call(
        &kernel,
        "drama.projects.create",
        json!({"title":"渡口剧本","operation_key":"project"}),
    ));
    let first = ok(call(
        &kernel,
        "drama.episodes.create",
        json!({
            "project_ref":project_ref(&project),"title":"初见","plan":"故人重逢。",
            "language_tag":"zh-CN","operation_key":"episode"
        }),
    ));
    let episode_id = &first["episode"]["episode_id"];
    let document_id = &first["document"]["document_id"];
    let before = ok(call(
        &kernel,
        "documents.get",
        json!({"document_id":document_id}),
    ));
    let content = "INT. 渡口候船室 - NIGHT\n\n故人递过一封信。🌿\n";
    let saved = ok(call(
        &kernel,
        "documents.save",
        json!({
            "document_id":document_id,"base_revision_id":before["revision"]["revision_id"],
            "source_format":"fountain","content":content,"operation_key":"script"
        }),
    ));
    let update = json!({
        "project_ref":project_ref(&first),"episode_id":episode_id,
        "expected":{"revision":first["episode"]["revision"],"sha256":first["episode_sha256"]},
        "title":"未寄出的信","plan":"保留作者计划。","archived":true,"operation_key":"rename"
    });
    let renamed = ok(call(&kernel, "drama.episodes.update", update.clone()));
    assert_eq!(
        renamed,
        ok(call(&kernel, "drama.episodes.update", update.clone()))
    );
    let mut stale = update;
    stale["operation_key"] = json!("stale-rename");
    assert_eq!(
        call(&kernel, "drama.episodes.update", stale)["error"]["code"],
        "revision_conflict"
    );
    let script = ok(call(
        &kernel,
        "documents.get",
        json!({"document_id":document_id}),
    ));
    assert_eq!(script["content"], content);
    assert_eq!(script["revision"], saved["revision"]);
    assert_eq!(script["document"]["title"], "未寄出的信");
    let old = ok(call(
        &kernel,
        "drama.episodes.get",
        json!({"episode_id":episode_id,"revision":1}),
    ));
    assert_eq!(old["episode"], first["episode"]);
    assert_eq!(old["is_head"], false);
    assert_eq!(old["project_ref"], project_ref(&first));
    let archived = ok(call(
        &kernel,
        "drama.projects.update",
        json!({
            "project_ref":project_ref(&first),"title":"渡口剧本","description":"","archived":true,"operation_key":"archive"
        }),
    ));
    assert_eq!(
        ok(call(&kernel, "drama.projects.list", json!({})))["projects"],
        json!([])
    );
    assert_eq!(
        ok(call(
            &kernel,
            "drama.projects.get",
            json!({"project_id":project["project"]["project_id"]})
        ))["episodes"][0]["episode"],
        renamed["episode"]
    );
    assert_eq!(
        ok(call(
            &kernel,
            "documents.get",
            json!({"document_id":document_id})
        ))["content"],
        content
    );
    let edit = json!({
        "project_ref":project_ref(&archived),"episode_id":episode_id,
        "expected":{"revision":renamed["episode"]["revision"],"sha256":renamed["sha256"]},
        "title":"再会","plan":"","archived":false,"operation_key":"edit-archived"
    });
    assert_eq!(
        call(&kernel, "drama.episodes.update", edit)["error"]["code"],
        "forbidden"
    );
    let restored = ok(call(
        &kernel,
        "drama.projects.update",
        json!({
            "project_ref":project_ref(&archived),"title":"渡口剧本","description":"","archived":false,"operation_key":"restore"
        }),
    ));
    assert_eq!(
        ok(call(
            &kernel,
            "drama.episodes.get",
            json!({"episode_id":episode_id})
        ))["project_ref"],
        project_ref(&restored)
    );
    assert_eq!(
        ok(call(
            &kernel,
            "drama.episodes.get",
            json!({"episode_id":episode_id,"revision":1})
        ))["episode"],
        first["episode"]
    );
}
