use hetu_core::{Kernel, collaboration::CollaborationHub};
use serde_json::{Value, json};

fn call(kernel: &Kernel, name: &str, input: Value) -> Value {
    kernel.request(json!({"action":format!("hetu.{name}"),"contract_revision":"1","input":input}))
}
fn ok(value: Value) -> Value {
    assert_eq!(value["status"], "succeeded", "{value}");
    value["data"].clone()
}
fn create(path: &std::path::Path, kind: &str) -> Kernel {
    Kernel::open(json!({"workspace_path":path,"mode":"author","create":{"work_type":kind,"title":"雨夜旧站","locale":"zh-CN","operation_key":"init"}})).unwrap()
}
fn fixed(kernel: &Kernel, reference: &Value) -> Value {
    ok(call(kernel, "works.get", json!({"work_ref":reference})))["summary"]["fixed_ref"].clone()
}

#[test]
fn work_identity_reuses_existing_records_and_links_have_one_bidirectional_owner() {
    let dir = tempfile::tempdir().unwrap();
    let k = create(dir.path(), "novel");
    let novel = ok(call(&k, "novels.get", json!({})));
    let novel_bytes = std::fs::read(dir.path().join("packages/novel/novel.json")).unwrap();
    let drama = ok(call(
        &k,
        "drama.projects.create",
        json!({"title":"雨夜旧站","operation_key":"drama"}),
    ));
    let works = ok(call(&k, "works.list", json!({"limit":1})));
    assert_eq!(works["works"].as_array().unwrap().len(), 1);
    assert!(!works["next_cursor"].is_null());
    let page = ok(call(
        &k,
        "works.list",
        json!({"limit":1,"cursor":works["next_cursor"]}),
    ));
    assert_eq!(page["works"].as_array().unwrap().len(), 1);
    assert!(page["next_cursor"].is_null());
    let nref =
        json!({"workspace_id":k.scope(),"kind":"novel","object_id":novel["novel"]["novel_id"]});
    let dref =
        json!({"workspace_id":k.scope(),"kind":"drama","object_id":drama["project"]["project_id"]});
    let source = fixed(&k, &nref);
    let target = fixed(&k, &dref);
    let input = json!({"source_ref":source,"target_ref":target,"relation":"adaptation","operation_key":"link"});
    let linked = call(&k, "work_links.create", input.clone());
    let link = ok(linked.clone());
    assert_eq!(linked, call(&k, "work_links.create", input));
    for (reference, direction) in [(&nref, "outgoing"), (&dref, "incoming")] {
        let result = ok(call(&k, "work_links.list", json!({"work_ref":reference})));
        assert_eq!(result["links"].as_array().unwrap().len(), 1);
        assert_eq!(result["links"][0]["link"], link["link"]);
        assert_eq!(result["links"][0]["direction"], direction);
    }
    assert_eq!(
        novel_bytes,
        std::fs::read(dir.path().join("packages/novel/novel.json")).unwrap()
    );
    let mut profile = novel["novel"]["metadata"].clone();
    profile["synopsis"] = json!("新的梗概不改写旧来源。");
    ok(call(
        &k,
        "novels.update",
        json!({"expected":{"revision":novel["revision"],"sha256":novel["sha256"]},"metadata":profile,"operation_key":"novel-update"}),
    ));
    let related = ok(call(&k, "work_links.list", json!({"work_ref":dref})));
    assert_eq!(related["links"][0]["related_has_newer_revision"], true);
    assert_eq!(related["links"][0]["link"]["source_ref"], source);
    let historical = ok(call(&k, "works.get", json!({"work_ref":nref,"revision":1})));
    assert_eq!(historical["summary"]["fixed_ref"], source);
    assert_eq!(historical["record"], novel["novel"]);
}

#[test]
fn video_is_independent_and_keeps_cas_history_and_exact_type_boundaries() {
    let dir = tempfile::tempdir().unwrap();
    let k = create(dir.path(), "video");
    let v = ok(call(
        &k,
        "video.projects.create",
        json!({"title":"雨夜旧站","brief":"从已有素材开始。","language_tag":"zh-CN","operation_key":"video"}),
    ));
    assert!(!dir.path().join("packages/novel/novel.json").exists());
    assert_eq!(
        ok(call(&k, "drama.projects.list", json!({})))["projects"],
        json!([])
    );
    assert_eq!(
        ok(call(&k, "works.list", json!({})))["works"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let reference = json!({"video_project_id":v["project"]["video_project_id"],"revision":1,"sha256":v["sha256"]});
    let episode = ok(call(
        &k,
        "video.episodes.create",
        json!({"project_ref":reference,"title":"第一集","brief":"末班车驶过。","operation_key":"episode"}),
    ));
    assert_eq!(episode["project"]["revision"], 2);
    let read = ok(call(
        &k,
        "video.episodes.get",
        json!({"video_episode_id":episode["episode"]["video_episode_id"]}),
    ));
    assert_eq!(read["episode_number"], 1);
    assert_eq!(read["work_ref"], v["work_ref"]);
    let handoff = ok(call(
        &k,
        "handoffs.get",
        json!({"view_kind":"video","object_ref":{"work_ref":v["work_ref"],"video_episode_id":episode["episode"]["video_episode_id"]}}),
    ));
    assert!(
        handoff["fixed_refs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "work")
    );
    assert!(
        handoff["fixed_refs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "video_episode")
    );
    assert!(
        handoff["limitations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item == "video_media_task_required")
    );
    assert!(
        handoff["direct_actions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["name"] == "hetu.video.episodes.get")
    );
    let stale = json!({"project_ref":reference,"title":"不能覆盖","brief":"","archived":false,"operation_key":"stale"});
    assert_eq!(
        call(&k, "video.projects.update", stale)["error"]["code"],
        "revision_conflict"
    );
    let old = ok(call(
        &k,
        "video.projects.get",
        json!({"video_project_id":v["project"]["video_project_id"],"revision":1}),
    ));
    assert_eq!(old["episodes"], json!([]));
    assert_eq!(old["sha256"], v["sha256"]);
    let mut wrong = v["work_ref"].clone();
    wrong["kind"] = json!("drama");
    assert_eq!(
        call(&k, "works.get", json!({"work_ref":wrong}))["error"]["code"],
        "invalid_input"
    );
    let mut foreign = v["work_ref"].clone();
    foreign["workspace_id"] = json!("workspace_00000000-0000-4000-8000-000000000000");
    assert_eq!(
        call(&k, "works.get", json!({"work_ref":foreign}))["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        call(
            &k,
            "documents.create",
            json!({"kind":"novel_chapter","title":"不造空小说","source_format":"markdown","content":"","operation_key":"no-novel"})
        )["error"]["code"],
        "invalid_input"
    );
}

#[test]
fn archiving_one_work_does_not_archive_its_siblings_or_erase_fixed_links() {
    let dir = tempfile::tempdir().unwrap();
    let k = create(dir.path(), "novel");
    let n = ok(call(&k, "novels.get", json!({})));
    let v = ok(call(
        &k,
        "video.projects.create",
        json!({"title":"雨夜旧站","brief":"","language_tag":"zh-CN","operation_key":"v"}),
    ));
    let mut metadata = n["novel"]["metadata"].clone();
    metadata["status"] = json!("archived");
    ok(call(
        &k,
        "novels.update",
        json!({"metadata":metadata,"expected":{"revision":n["revision"],"sha256":n["sha256"]},"operation_key":"archive"}),
    ));
    let active = ok(call(&k, "works.list", json!({})));
    assert_eq!(active["works"].as_array().unwrap().len(), 1);
    assert_eq!(active["works"][0]["work_ref"], v["work_ref"]);
    let all = ok(call(&k, "works.list", json!({"include_archived":true})));
    assert_eq!(all["works"].as_array().unwrap().len(), 2);
    assert_eq!(
        ok(call(
            &k,
            "video.projects.get",
            json!({"video_project_id":v["project"]["video_project_id"]})
        ))["project"],
        v["project"]
    );
}

#[test]
fn bootstrap_video_is_a_public_agent_path_with_replay_and_no_empty_upstream() {
    let dir = tempfile::tempdir().unwrap();
    let hub = CollaborationHub::open(&dir.path().join("授权"), "codex").unwrap();
    let request = |name: &str, input: Value| {
        hub.request(json!({"action":format!("hetu.{name}"),"contract_revision":"1","input":input}))
    };
    let started = ok(request(
        "creation_projects.create",
        json!({"brief":"从一段拍摄素材整理视频。","locale":"zh-CN","operation_key":"start"}),
    ));
    let management = started["management_ref"].clone();
    let save = ok(request(
        "creation_projects.save",
        json!({"management_ref":management,"project_id":started["project"]["project_id"],"expected":{"revision":started["revision"],"sha256":started["sha256"]},"brief":"素材已知，无小说前置。","selected_fields":{},"work_profile":{"work_type":"video","language_tag":"zh-CN","drama_mode":null},"operation_key":"save"}),
    ));
    let input = json!({"management_ref":management,"project_id":started["project"]["project_id"],"expected":{"revision":save["revision"],"sha256":save["sha256"]},"profile":{"title":"末班车","brief":"旧站视频","language_tag":"zh-CN"},"target_path":started["target_path"],"operation_key":"create"});
    let created = request("creation_projects.create_video", input.clone());
    let data = ok(created.clone());
    assert_eq!(created, request("creation_projects.create_video", input));
    assert_eq!(data["workspace"]["work_type"], "video");
    assert!(
        !std::path::Path::new(data["target_path"].as_str().unwrap())
            .join("packages/novel/novel.json")
            .exists()
    );
    let list = ok(request(
        "works.list",
        json!({"management_ref":data["workspace_management_ref"]}),
    ));
    assert_eq!(list["works"].as_array().unwrap().len(), 1);
    assert_eq!(
        list["works"][0]["work_ref"],
        data["video_project"]["work_ref"]
    );
    let recover = ok(request(
        "operations.get",
        json!({"management_ref":management,"action":"hetu.creation_projects.create_video","key":"create"}),
    ));
    assert_eq!(
        recover["original_result"]["data"]["workspace"],
        data["workspace"]
    );
}

#[test]
fn opening_legacy_workspace_keeps_config_and_ids_without_rewriting() {
    let dir = tempfile::tempdir().unwrap();
    let k = create(dir.path(), "novel");
    let works = ok(call(&k, "works.list", json!({})));
    drop(k);
    let path = dir.path().join(".heturc.json");
    let mut legacy: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    legacy["packages"] = json!(["novel", "drama", "music-cue", "visual-prompt"]);
    let original = serde_json::to_vec_pretty(&legacy).unwrap();
    std::fs::write(&path, &original).unwrap();
    let k = Kernel::open(json!({"workspace_path":dir.path(),"mode":"author"})).unwrap();
    assert_eq!(ok(call(&k, "works.list", json!({}))), works);
    assert_eq!(std::fs::read(&path).unwrap(), original);
}

#[test]
fn one_work_grant_cannot_read_a_sibling_or_execute_its_proposal() {
    let dir = tempfile::tempdir().unwrap();
    let k = create(&dir.path().join("作品"), "novel");
    let make = |key: &str| {
        ok(call(
            &k,
            "video.projects.create",
            json!({"title":"同名视频","brief":key,"language_tag":"zh-CN","operation_key":key}),
        ))
    };
    let a = make("one");
    let b = make("two");
    let grants = dir.path().join("授权");
    let hub = CollaborationHub::open(&grants, "codex").unwrap();
    let authorize = |work: &Value, key: &str| {
        ok(call(&k,"collaboration.authorize_workspace",json!({"work_ref":work["work_ref"],"client_adapter":"codex","collaboration_path":grants,"operation_key":key})))["management_ref"].clone()
    };
    let ga = authorize(&a, "grant-a");
    let gb = authorize(&b, "grant-b");
    assert_ne!(ga["grant_id"], gb["grant_id"]);
    let request = |grant: &Value, name: &str, mut input: Value| {
        input["management_ref"] = grant.clone();
        hub.request(json!({"action":format!("hetu.{name}"),"contract_revision":"1","input":input}))
    };
    let works = ok(request(&ga, "works.list", json!({})));
    assert_eq!(works["works"].as_array().unwrap().len(), 1);
    assert_eq!(works["works"][0]["work_ref"], a["work_ref"]);
    assert_eq!(
        request(&ga, "works.get", json!({"work_ref":b["work_ref"]}))["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        request(
            &ga,
            "video.projects.get",
            json!({"video_project_id":b["project"]["video_project_id"]})
        )["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        request(&ga, "novels.get", json!({}))["error"]["code"],
        "forbidden"
    );
    let sibling_episode = ok(call(
        &k,
        "video.episodes.create",
        json!({"project_ref":{"video_project_id":b["project"]["video_project_id"],"revision":1,"sha256":b["sha256"]},"title":"未获权分集","brief":"不应进入另一个页面交接","operation_key":"sibling-episode"}),
    ));
    let other_document = ok(call(
        &k,
        "documents.create",
        json!({"kind":"novel_chapter","title":"未获权原稿","content":"另一对象的正文不能因页面引用外发。","source_format":"markdown","operation_key":"other-document"}),
    ));
    for extra in [
        json!({"video_episode_id":sibling_episode["episode"]["video_episode_id"]}),
        json!({"document_id":other_document["document"]["document_id"]}),
        json!({"asset_id":"asset_00000000-0000-4000-8000-000000000000"}),
    ] {
        let mut object = extra;
        object["work_ref"] = a["work_ref"].clone();
        assert_eq!(
            request(
                &ga,
                "handoffs.get",
                json!({"view_kind":"related_works","object_ref":object})
            )["error"]["code"],
            "forbidden"
        );
    }
    let caps = ok(request(&ga, "capabilities.get", json!({})));
    assert!(
        !caps["actions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["name"] == "hetu.documents.list")
    );
    let input = json!({"project_ref":{"video_project_id":a["project"]["video_project_id"],"revision":1,"sha256":a["sha256"]},"title":"第一集","brief":"只属于第一个视频","operation_key":"episode"});
    let prepared = ok(request(
        &ga,
        "agent_operations.prepare",
        json!({"action":"hetu.video.episodes.create","input":input,"summary":"新增第一集","operation_key":"proposal"}),
    ));
    assert_eq!(
        request(
            &gb,
            "agent_operations.get",
            json!({"proposal_id":prepared["proposal_id"]})
        )["error"]["code"],
        "forbidden"
    );
    assert!(
        ok(request(&gb, "agent_operations.list", json!({})))["proposals"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let recover = ok(request(
        &ga,
        "operations.get",
        json!({"action":"hetu.agent_operations.prepare","key":"proposal"}),
    ));
    assert_eq!(
        recover["original_result"]["data"]["proposal_id"],
        prepared["proposal_id"]
    );
    assert_ne!(
        request(
            &gb,
            "operations.get",
            json!({"action":"hetu.agent_operations.prepare","key":"proposal"})
        )["status"],
        "succeeded"
    );
    assert_ne!(
        request(
            &gb,
            "operations.get",
            json!({"operation_id":recover["original_result"]["operation"]["id"]})
        )["status"],
        "succeeded"
    );
    ok(call(
        &k,
        "collaboration.revoke_management",
        json!({"grant_id":ga["grant_id"],"client_adapter":"codex","collaboration_path":grants,"operation_key":"revoke-a"}),
    ));
    assert_ne!(request(&ga, "works.list", json!({}))["status"], "succeeded");
    assert_eq!(
        ok(request(&gb, "works.list", json!({})))["works"][0]["work_ref"],
        b["work_ref"]
    );
}

#[test]
fn document_activity_updates_its_novel_without_rewriting_a_sibling_or_old_revision() {
    let dir = tempfile::tempdir().unwrap();
    let k = create(dir.path(), "novel");
    let n = ok(call(&k, "novels.get", json!({})));
    assert_eq!(n["novel"]["created_at"], n["novel"]["updated_at"]);
    let reference =
        json!({"workspace_id":k.scope(),"kind":"novel","object_id":n["novel"]["novel_id"]});
    let before = ok(call(&k, "works.get", json!({"work_ref":reference})));
    let v = ok(call(
        &k,
        "video.projects.create",
        json!({"title":"另一个视频","brief":"","language_tag":"zh-CN","operation_key":"video"}),
    ));
    let video_before = ok(call(&k, "works.get", json!({"work_ref":v["work_ref"]})));
    let drama = ok(call(
        &k,
        "drama.projects.create",
        json!({"title":"独立剧本","mode":"original","operation_key":"drama"}),
    ));
    let episode = ok(call(
        &k,
        "drama.episodes.create",
        json!({"project_ref":{"project_id":drama["project"]["project_id"],"revision":1,"sha256":drama["sha256"]},"title":"同事务的新分集","plan":"先创建空作者稿。","language_tag":"zh-CN","operation_key":"drama-episode"}),
    ));
    assert_eq!(
        episode["episode"]["project_id"],
        drama["project"]["project_id"]
    );
    ok(call(
        &k,
        "documents.create",
        json!({"kind":"novel_chapter","title":"雨夜","content":"车票写着明天。","source_format":"markdown","operation_key":"chapter"}),
    ));
    let after = ok(call(&k, "works.get", json!({"work_ref":reference})));
    assert!(after["summary"]["updated_at"].as_str() > before["summary"]["updated_at"].as_str());
    assert_eq!(
        ok(call(&k, "works.get", json!({"work_ref":v["work_ref"]}))),
        video_before
    );
    let old = ok(call(
        &k,
        "works.get",
        json!({"work_ref":reference,"revision":1}),
    ));
    assert_eq!(old["record"], before["record"]);
    assert_eq!(old["summary"]["updated_at"], before["record"]["updated_at"]);
}
