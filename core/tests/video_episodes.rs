use hetu_core::Kernel;
use serde_json::{Value, json};

fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(result: Value) -> Value {
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn project_ref(value: &Value) -> Value {
    json!({"video_project_id":value["project"]["video_project_id"],"revision":value["project"]["revision"],"sha256":value["sha256"]})
}
fn setup() -> (tempfile::TempDir, Kernel, Value, Value) {
    let root = tempfile::tempdir().unwrap();
    let k = Kernel::open(json!({"workspace_path":root.path(),"mode":"author","create":{"work_type":"video","title":"渡口短剧","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let p = ok(call(
        &k,
        "video.projects.create",
        json!({"title":"渡口短剧","brief":"独立视频","language_tag":"zh-CN","operation_key":"project"}),
    ));
    let a = ok(call(
        &k,
        "video.episodes.create",
        json!({"project_ref":project_ref(&p),"title":"相同标题","brief":"第一集制作范围","operation_key":"a"}),
    ));
    let b = ok(call(
        &k,
        "video.episodes.create",
        json!({"project_ref":project_ref(&a),"title":"相同标题","brief":"第二集制作范围","operation_key":"b"}),
    ));
    (root, k, a, b)
}

#[test]
fn episode_metadata_is_versioned_and_replay_keeps_identity_and_directory() {
    let (_root, k, a, b) = setup();
    let id = &a["episode"]["video_episode_id"];
    let before = ok(call(
        &k,
        "video.episodes.get",
        json!({"video_episode_id":id}),
    ));
    assert_eq!(before["project_ref"], project_ref(&b));
    let update = json!({"project_ref":project_ref(&b),"video_episode_id":id,"expected":{"revision":a["episode"]["revision"],"sha256":a["episode_sha256"]},"title":"迟到的船","brief":"先听到汽笛，再切到渡口。","archived":false,"operation_key":"update"});
    let saved = ok(call(&k, "video.episodes.update", update.clone()));
    assert_eq!(saved["episode"]["revision"], 2);
    assert_eq!(saved["episode"]["video_episode_id"], *id);
    assert_eq!(saved["episode"]["previous_sha256"], a["episode_sha256"]);
    assert_eq!(saved, ok(call(&k, "video.episodes.update", update.clone())));
    let mut stale = update.clone();
    stale["operation_key"] = json!("stale");
    assert_eq!(
        call(&k, "video.episodes.update", stale)["error"]["code"],
        "revision_conflict"
    );
    let mut different = update;
    different["brief"] = json!("原键不能改变内容");
    assert_eq!(
        call(&k, "video.episodes.update", different)["error"]["code"],
        "idempotency_conflict"
    );
    let history = ok(call(
        &k,
        "video.episodes.get",
        json!({"video_episode_id":id,"revision":1}),
    ));
    assert_eq!(history["episode"], a["episode"]);
    assert_eq!(history["is_head"], false);
    let current_project = ok(call(
        &k,
        "video.projects.get",
        json!({"video_project_id":b["project"]["video_project_id"]}),
    ));
    assert_eq!(current_project["project"], b["project"]);
    assert_eq!(current_project["episodes"][0]["episode"], saved["episode"]);
    assert_eq!(current_project["episodes"][1]["episode"], b["episode"]);
}

#[test]
fn reorder_requires_complete_identity_set_and_project_cas_preserving_episode_history() {
    let (_root, k, a, b) = setup();
    let a_id = &a["episode"]["video_episode_id"];
    let b_id = &b["episode"]["video_episode_id"];
    for (index, refs) in [
        json!([a_id]),
        json!([a_id, a_id]),
        json!([a_id, "vepisode_11111111-1111-4111-8111-111111111111"]),
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(
            call(
                &k,
                "video.episodes.reorder",
                json!({"project_ref":project_ref(&b),"episode_refs":refs,"operation_key":format!("invalid-{index}")})
            )["error"]["code"],
            "invalid_input"
        );
    }
    let input =
        json!({"project_ref":project_ref(&b),"episode_refs":[b_id,a_id],"operation_key":"reorder"});
    let ordered = ok(call(&k, "video.episodes.reorder", input.clone()));
    assert_eq!(ordered["project"]["episode_refs"], json!([b_id, a_id]));
    assert_eq!(
        ordered,
        ok(call(&k, "video.episodes.reorder", input.clone()))
    );
    let mut stale = input;
    stale["operation_key"] = json!("stale-directory");
    assert_eq!(
        call(&k, "video.episodes.reorder", stale)["error"]["code"],
        "revision_conflict"
    );
    let read = ok(call(
        &k,
        "video.episodes.get",
        json!({"video_episode_id":a_id}),
    ));
    assert_eq!(read["episode_number"], 2);
    assert_eq!(read["episode"], a["episode"]);
    let historical = ok(call(
        &k,
        "video.projects.get",
        json!({"video_project_id":b["project"]["video_project_id"],"revision":b["project"]["revision"]}),
    ));
    assert_eq!(historical["project"], b["project"]);
}

#[test]
fn archived_project_and_foreign_episode_cannot_be_modified() {
    let (_root, k, a, b) = setup();
    let other = ok(call(
        &k,
        "video.projects.create",
        json!({"title":"另一个项目","brief":"独立","language_tag":"zh-CN","operation_key":"other"}),
    ));
    let mut update = json!({"project_ref":project_ref(&other),"video_episode_id":a["episode"]["video_episode_id"],"expected":{"revision":a["episode"]["revision"],"sha256":a["episode_sha256"]},"title":"改名","brief":"保留","archived":true,"operation_key":"foreign"});
    assert_eq!(
        call(&k, "video.episodes.update", update.clone())["error"]["code"],
        "invalid_input"
    );
    let archived = ok(call(
        &k,
        "video.projects.update",
        json!({"project_ref":project_ref(&b),"title":"渡口短剧","brief":"保留制作资料","archived":true,"operation_key":"archive"}),
    ));
    update["project_ref"] = project_ref(&archived);
    update["operation_key"] = json!("archived-update");
    assert_eq!(
        call(&k, "video.episodes.update", update.clone())["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        call(
            &k,
            "video.episodes.reorder",
            json!({"project_ref":project_ref(&archived),"episode_refs":archived["project"]["episode_refs"],"operation_key":"archived-reorder"})
        )["error"]["code"],
        "forbidden"
    );
    let restored = ok(call(
        &k,
        "video.projects.update",
        json!({"project_ref":project_ref(&archived),"title":"渡口短剧","brief":"保留制作资料","archived":false,"operation_key":"restore"}),
    ));
    update["project_ref"] = project_ref(&restored);
    update["operation_key"] = json!("restored-update");
    ok(call(&k, "video.episodes.update", update));
}
