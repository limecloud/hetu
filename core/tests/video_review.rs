use base64::{Engine, engine::general_purpose::STANDARD};
use hetu_core::{Kernel, collaboration::CollaborationHub};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(value: Value) -> Value {
    assert_eq!(value["status"], "succeeded", "{value}");
    value["data"].clone()
}
fn project_ref(p: &Value) -> Value {
    json!({"video_project_id":p["project"]["video_project_id"],"revision":p["project"]["revision"],"sha256":p["sha256"]})
}
fn setup() -> (tempfile::TempDir, Kernel, Value, Value, Value) {
    let dir = tempfile::tempdir().unwrap();
    let k = Kernel::open(json!({"workspace_path":dir.path().join("作品"),"mode":"author","create":{"title":"基础作品","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let p = ok(call(
        &k,
        "video.projects.create",
        json!({"title":"渡口","brief":"独立视频","language_tag":"zh-CN","operation_key":"video"}),
    ));
    let ep = ok(call(
        &k,
        "video.episodes.create",
        json!({"project_ref":project_ref(&p),"title":"第一集","brief":"雨夜","operation_key":"episode"}),
    ));
    // 真实可解码的隔离MP4，Core只证明固定字节，不冒充观看和作者认可。
    let bytes = include_bytes!("../../apps/desktop/tests/fixtures/preview.mp4");
    let sha = format!("{:x}", Sha256::digest(bytes));
    let inline = json!({"filename":"渡口.mp4","sha256":sha,"base64":STANDARD.encode(bytes)});
    let scan = ok(call(&k, "assets.inspect", json!({"inline_source":inline})));
    let a = ok(call(
        &k,
        "assets.import",
        json!({"work_ref":p["work_ref"],"inline_source":inline,"expected_file":{"sha256":scan["sha256"],"size_bytes":scan["size_bytes"]},"title":"雨夜","source":{"source_type":"author_supplied","creator_statement":"隔离样本"},"rights_status":"author_owned","redistribution_allowed":true,"rights_statement":"作者拥有此隔离样本并允许交付","operation_key":"asset"}),
    ));
    (
        dir,
        k,
        p["work_ref"].clone(),
        ep["episode"]["video_episode_id"].clone(),
        json!({"asset_id":a["asset"]["asset_id"],"revision":1,"sha256":a["sha256"]}),
    )
}
fn save(work: &Value, episode: &Value, asset: &Value, key: &str) -> Value {
    json!({"work_ref":work,"video_episode_id":episode,"asset_ref":asset,"title":key,"purpose":"clip","stream_index":0,"time_base":{"numerator":1,"denominator":1000},"duration_ticks":2000,"operation_key":key})
}

#[test]
fn baseline_is_discoverable_without_workspace_or_optional_plugins() {
    let dir = tempfile::tempdir().unwrap();
    let hub = CollaborationHub::open(&dir.path().join("不存在的接入目录"), "codex").unwrap();
    let result =
        ok(hub
            .request(json!({"action":"hetu.baseline.inspect","contract_revision":"1","input":{}})));
    assert_eq!(result["status"], "contract_complete");
    assert_eq!(result["optional_plugins_required"], false);
    assert_eq!(result["manifest"]["modules"].as_array().unwrap().len(), 3);
    assert!(!dir.path().join("不存在的接入目录").exists());
}

#[test]
fn fixed_media_feedback_history_and_original_keys_survive_reopen() {
    let (dir, k, work, ep, asset) = setup();
    let input = save(&work, &ep, &asset, "v1");
    let first = ok(call(&k, "video.media.save", input.clone()));
    assert_eq!(first, ok(call(&k, "video.media.save", input)));
    let note = json!({"work_ref":work,"media_ref":first["media_ref"],"comment":"先听脚步，再切门口。","range":{"start_tick":100,"end_tick":900},"operation_key":"feedback"});
    let feedback = ok(call(&k, "video.feedback.save", note.clone()));
    assert_eq!(feedback, ok(call(&k, "video.feedback.save", note)));
    let mut second = save(&work, &ep, &asset, "v2");
    second["previous_media_ref"] = first["media_ref"].clone();
    let second = ok(call(&k, "video.media.save", second));
    drop(k);
    let k =
        Kernel::open(json!({"workspace_path":dir.path().join("作品"),"mode":"author"})).unwrap();
    let old = ok(call(
        &k,
        "video.feedback.list",
        json!({"work_ref":work,"media_ref":first["media_ref"]}),
    ));
    assert_eq!(old["items"][0]["feedback"], feedback["feedback"]);
    assert_eq!(
        ok(call(
            &k,
            "video.feedback.list",
            json!({"work_ref":work,"media_ref":second["media_ref"]})
        ))["total"],
        0
    );
    assert_eq!(
        ok(call(
            &k,
            "video.media.get",
            json!({"work_ref":work,"media_ref":second["media_ref"]})
        ))["media"]["previous_media_ref"],
        first["media_ref"]
    );
    let delivered = ok(call(
        &k,
        "video.delivery.preview",
        json!({"work_ref":work,"media_refs":[first["media_ref"],second["media_ref"]]}),
    ));
    assert_eq!(delivered["items"].as_array().unwrap().len(), 2);
    let blob = ok(call(
        &k,
        "assets.read_blob",
        json!({"work_ref":work,"asset_ref":asset,"offset":0,"length":524288}),
    ));
    assert_eq!(
        STANDARD.decode(blob["base64"].as_str().unwrap()).unwrap(),
        include_bytes!("../../apps/desktop/tests/fixtures/preview.mp4")
    );
}

#[test]
fn foreign_work_tampered_references_and_out_of_range_feedback_are_refused() {
    let (_dir, k, work, ep, asset) = setup();
    let first = ok(call(&k, "video.media.save", save(&work, &ep, &asset, "v1")));
    for (start, end) in [(100, 100), (900, 800), (0, 2001)] {
        assert_eq!(
            call(
                &k,
                "video.feedback.save",
                json!({"work_ref":work,"media_ref":first["media_ref"],"comment":"意见","range":{"start_tick":start,"end_tick":end},"operation_key":format!("bad-{start}-{end}")})
            )["error"]["code"],
            "invalid_range"
        );
    }
    let other = ok(call(
        &k,
        "video.projects.create",
        json!({"title":"另一作品","brief":"隔离","language_tag":"zh-CN","operation_key":"other"}),
    ));
    assert_eq!(
        call(
            &k,
            "video.media.get",
            json!({"work_ref":other["work_ref"],"media_ref":first["media_ref"]})
        )["error"]["code"],
        "forbidden"
    );
    let mut bad = first["media_ref"].clone();
    bad["sha256"] = json!("0".repeat(64));
    assert_eq!(
        call(
            &k,
            "video.media.get",
            json!({"work_ref":work,"media_ref":bad})
        )["error"]["code"],
        "hetu.stale_evidence"
    );
    let mut zero = save(&work, &ep, &asset, "zero");
    zero["time_base"]["denominator"] = json!(0);
    assert_eq!(
        call(&k, "video.media.save", zero)["error"]["code"],
        "invalid_input"
    );
    let foreign = save(&other["work_ref"], &ep, &asset, "foreign");
    assert_eq!(
        call(&k, "video.media.save", foreign)["error"]["code"],
        "forbidden"
    );
}

#[test]
fn managed_scope_discovers_reads_and_executes_only_fixed_approved_writes() {
    let (dir, k, work, ep, asset) = setup();
    let location = dir.path().join("接入");
    let grant=ok(call(&k,"collaboration.authorize_workspace",json!({"work_ref":work,"client_adapter":"codex","collaboration_path":location,"operation_key":"grant"})))["management_ref"].clone();
    let hub = CollaborationHub::open(&location, "codex").unwrap();
    let invoke = |action: &str, mut input: Value| {
        input["management_ref"] = grant.clone();
        hub.request(
            json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}),
        )
    };
    let proposal = ok(invoke(
        "agent_operations.prepare",
        json!({"action":"hetu.video.media.save","input":save(&work,&ep,&asset,"managed-media"),"summary":"接收本集片段","operation_key":"prepare"}),
    ));
    let execute = json!({"proposal_id":proposal["proposal_id"],"proposal_sha256":proposal["proposal_sha256"],"operation_key":"execute"});
    assert_eq!(
        invoke("agent_operations.execute", execute.clone())["error"]["code"],
        "hetu.author_confirmation_required"
    );
    // 准备不执行；确切作者决定仍由已有固定方案合同负责。
    assert_eq!(
        ok(invoke(
            "video.media.list",
            json!({"work_ref":work,"video_episode_id":ep})
        ))["total"],
        0
    );
    ok(call(
        &k,
        "agent_operations.decide",
        json!({"proposal_id":proposal["proposal_id"],"proposal_sha256":proposal["proposal_sha256"],"expected_state_revision":proposal["state_revision"],"decision":"approve","operation_key":"approve"}),
    ));
    let done = ok(invoke("agent_operations.execute", execute.clone()));
    assert_eq!(done, ok(invoke("agent_operations.execute", execute)));
    let handoff = ok(invoke(
        "handoffs.get",
        json!({"view_kind":"video","object_ref":{"work_ref":work,"video_episode_id":ep,"media_ref":done["result"]["media_ref"]}}),
    ));
    assert_eq!(
        handoff["workflow"]["author_decision"],
        "hetu.agent_operations.record_decision"
    );
    assert!(
        handoff["fixed_refs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| {
                item["kind"] == "video_media"
                    && item["media_ref"] == done["result"]["media_ref"]
                    && item["feedback_action"] == "hetu.video.feedback.list"
            })
    );
    let mut tampered_media = done["result"]["media_ref"].clone();
    tampered_media["sha256"] = json!("0".repeat(64));
    assert_eq!(
        invoke(
            "handoffs.get",
            json!({"view_kind":"video","object_ref":{"work_ref":work,"video_episode_id":ep,"media_ref":tampered_media}}),
        )["error"]["code"],
        "hetu.stale_evidence"
    );
    assert_eq!(
        ok(invoke(
            "video.media.list",
            json!({"work_ref":work,"video_episode_id":ep})
        ))["total"],
        1
    );
    let read = ok(invoke(
        "assets.read_blob",
        json!({"work_ref":work,"asset_ref":asset,"offset":0,"length":16}),
    ));
    assert_eq!(read["size_bytes"], 16);
}

#[test]
fn pagination_does_not_mix_snapshots_and_current_rights_apply_to_old_media() {
    let (_dir, k, work, ep, asset) = setup();
    let first = ok(call(&k, "video.media.save", save(&work, &ep, &asset, "v1")));
    ok(call(&k, "video.media.save", save(&work, &ep, &asset, "v2")));
    let page = ok(call(
        &k,
        "video.media.list",
        json!({"work_ref":work,"video_episode_id":ep,"limit":1}),
    ));
    assert!(page["next_cursor"].is_string());
    ok(call(&k, "video.media.save", save(&work, &ep, &asset, "v3")));
    assert_eq!(
        call(
            &k,
            "video.media.list",
            json!({"work_ref":work,"video_episode_id":ep,"limit":1,"cursor":page["next_cursor"]})
        )["error"]["code"],
        "hetu.stale_evidence"
    );
    let fixed = ok(call(
        &k,
        "assets.get",
        json!({"asset_id":asset["asset_id"],"revision":1}),
    ));
    ok(call(
        &k,
        "assets.update",
        json!({"asset_id":asset["asset_id"],"expected":{"revision":1,"sha256":asset["sha256"]},
        "title":fixed["asset"]["title"],"source":fixed["asset"]["source"],"rights_status":"reference_only",
        "redistribution_allowed":false,"rights_statement":"撤回再分发许可","operation_key":"revoke-rights"}),
    ));
    assert_eq!(
        call(
            &k,
            "video.delivery.preview",
            json!({"work_ref":work,"media_refs":[first["media_ref"]]})
        )["error"]["code"],
        "forbidden"
    );
    // 历史媒体仍可审阅，当前权利限制只阻止交付，不篡改旧依据。
    assert_eq!(
        ok(call(
            &k,
            "video.media.get",
            json!({"work_ref":work,"media_ref":first["media_ref"]})
        ))["media_ref"],
        first["media_ref"]
    );
}
