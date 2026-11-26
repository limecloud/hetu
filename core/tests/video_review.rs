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
fn work_media_search_keeps_episode_filter_query_cursor_and_archived_history_separate(){
    let (_dir,k,work,ep,asset)=setup();
    let project=ok(call(&k,"video.projects.get",json!({"video_project_id":work["object_id"]})));
    let other=ok(call(&k,"video.episodes.create",json!({"project_ref":project_ref(&project),"title":"第二集","brief":"","operation_key":"other-episode"})));
    let other_id=&other["episode"]["video_episode_id"];
    let first=ok(call(&k,"video.media.save",save(&work,&ep,&asset,"共同前缀 第一集")));
    let second=ok(call(&k,"video.media.save",save(&work,other_id,&asset,"共同前缀 第二集")));
    let all=ok(call(&k,"video.media.list",json!({"work_ref":work,"query":"共同前缀","limit":1})));
    assert_eq!(all["items"].as_array().unwrap().len(),1);assert_eq!(all["total"],2);
    let next=ok(call(&k,"video.media.list",json!({"work_ref":work,"query":"共同前缀","limit":1,"cursor":all["next_cursor"]})));
    assert_ne!(next["items"][0]["media_ref"],all["items"][0]["media_ref"]);
    assert_eq!(call(&k,"video.media.list",json!({"work_ref":work,"query":"共同","limit":1,"cursor":all["next_cursor"]}))["error"]["code"],"hetu.stale_evidence");
    assert_eq!(ok(call(&k,"video.media.list",json!({"work_ref":work,"video_episode_id":ep})))["items"][0]["media_ref"],first["media_ref"]);
    ok(call(&k,"video.episodes.update",json!({"project_ref":project_ref(&other),"video_episode_id":other_id,
        "expected":{"revision":other["episode"]["revision"],"sha256":other["episode_sha256"]},"title":"第二集","brief":"","archived":true,"operation_key":"archive-episode"})));
    assert_eq!(ok(call(&k,"video.media.list",json!({"work_ref":work})))["total"],1);
    assert_eq!(ok(call(&k,"video.media.list",json!({"work_ref":work,"video_episode_id":other_id})))["items"][0]["media_ref"],second["media_ref"]);
    assert_eq!(ok(call(&k,"video.media.get",json!({"work_ref":work,"media_ref":second["media_ref"]})))["media"],second["media"]);
}

fn decision_request(work:&Value,media:&Value,purpose:&str,decision:&str,previous:Value)->Value {
    json!({"work_ref":work,"media_ref":media,"purpose":purpose,"decision":decision,
        "expected_decision_ref":previous,"author_statement":"隔离验收：仅将本条样本记录为所展示的决定，不代表真实创作品质认可。"})
}
fn record_decision(k:&Kernel,request:Value,key:&str)->Value {
    let preview=ok(call(k,"video.decisions.preview",request));
    ok(call(k,"video.decisions.save",json!({"work_ref":preview["preview"]["request"]["work_ref"],"preview":preview["preview"],"operation_key":key})))
}

#[test]
fn media_decisions_keep_separate_purposes_fixed_history_and_original_operation() {
    let (dir,k,work,ep,asset)=setup();
    let mut saved=Vec::new();let mut decisions=Vec::new();
    for purpose in ["previsualization","clip","final"] {
        let mut input=save(&work,&ep,&asset,purpose);input["purpose"]=json!(purpose);
        let media=ok(call(&k,"video.media.save",input));
        let preview=ok(call(&k,"video.decisions.preview",decision_request(&work,&media["media_ref"],purpose,"confirmed",Value::Null)));
        let input=json!({"work_ref":work,"preview":preview["preview"],"operation_key":format!("confirm-{purpose}")});
        let first=call(&k,"video.decisions.save",input.clone());let fixed=ok(first.clone());
        assert_eq!(first,call(&k,"video.decisions.save",input.clone()));
        let mut altered=input;altered["preview"]["request"]["author_statement"]=json!("同键不能改变决定");
        assert_eq!(call(&k,"video.decisions.save",altered)["error"]["code"],"idempotency_conflict");
        assert_eq!(fixed["decision"]["purpose"],purpose);assert_eq!(fixed["decision"]["revision"],1);
        let view=ok(call(&k,"video.media.get",json!({"work_ref":work,"media_ref":media["media_ref"]})));
        assert_eq!(view["author_decision"]["state"],"confirmed");assert_eq!(view["verification"]["decoding"],"not_checked");assert_eq!(view["verification"]["viewing"],"not_checked");
        saved.push(media);decisions.push(fixed);
    }
    let old=saved[2].clone();let mut next=save(&work,&ep,&asset,"next-final");next["purpose"]=json!("final");next["previous_media_ref"]=old["media_ref"].clone();
    let next=ok(call(&k,"video.media.save",next));
    assert_eq!(ok(call(&k,"video.media.get",json!({"work_ref":work,"media_ref":next["media_ref"]})))["author_decision"]["state"],"other_media");
    let confirmed=record_decision(&k,decision_request(&work,&next["media_ref"],"final","confirmed",decisions[2]["decision_ref"].clone()),"new-final");
    assert_eq!(confirmed["decision"]["revision"],2);assert_eq!(confirmed["decision"]["previous_ref"],decisions[2]["decision_ref"]);
    let old_head=ok(call(&k,"video.media.get",json!({"work_ref":work,"media_ref":old["media_ref"]})));assert_eq!(old_head["author_decision"]["state"],"other_media");assert_eq!(old_head["media"],old["media"]);
    let historical=ok(call(&k,"video.decisions.get",json!({"work_ref":work,"video_episode_id":ep,"purpose":"final","decision_ref":decisions[2]["decision_ref"]})));
    assert_eq!(historical["decision"],decisions[2]["decision"]);assert_eq!(historical["current_decision_ref"],confirmed["decision_ref"]);
    let page=ok(call(&k,"video.decisions.history",json!({"work_ref":work,"video_episode_id":ep,"purpose":"final","limit":1})));
    assert_eq!(page["items"][0]["decision_ref"],confirmed["decision_ref"]);
    let second=ok(call(&k,"video.decisions.history",json!({"work_ref":work,"video_episode_id":ep,"purpose":"final","limit":1,"cursor":page["next_cursor"]})));
    assert_eq!(second["items"][0]["decision_ref"],decisions[2]["decision_ref"]);assert!(second["next_cursor"].is_null());
    let withdrawn=record_decision(&k,decision_request(&work,&next["media_ref"],"final","withdrawn",confirmed["decision_ref"].clone()),"withdraw");
    assert_eq!(withdrawn["decision"]["revision"],3);
    assert_eq!(call(&k,"video.decisions.history",json!({"work_ref":work,"video_episode_id":ep,"purpose":"final","limit":1,"cursor":page["next_cursor"]}))["error"]["code"],"hetu.stale_evidence");
    for purpose in ["previsualization","clip"]{assert_eq!(ok(call(&k,"video.decisions.get",json!({"work_ref":work,"video_episode_id":ep,"purpose":purpose})))["decision"]["revision"],1);}
    drop(k);let reopened=Kernel::open(json!({"workspace_path":dir.path().join("作品"),"mode":"author"})).unwrap();
    let view=ok(call(&reopened,"video.media.get",json!({"work_ref":work,"media_ref":next["media_ref"]})));
    assert_eq!(view["author_decision"]["state"],"withdrawn");assert_eq!(view["media"]["adoption"],"not_recorded");
    assert_eq!(ok(call(&reopened,"video.decisions.get",json!({"work_ref":work,"video_episode_id":ep,"purpose":"final","decision_ref":decisions[2]["decision_ref"]})))["decision"],decisions[2]["decision"]);
}

#[test]
fn decision_preview_rejects_wrong_identity_purpose_digest_blank_statement_and_forgery() {
    let (_dir,k,work,ep,asset)=setup();let media=ok(call(&k,"video.media.save",save(&work,&ep,&asset,"candidate")));
    let request=decision_request(&work,&media["media_ref"],"clip","confirmed",Value::Null);
    let preview=ok(call(&k,"video.decisions.preview",request.clone()));
    for (field,value) in [("purpose",json!("final")),("author_statement",json!(" \n\t")),("media_ref",json!({"media_id":media["media_ref"]["media_id"],"revision":1,"sha256":"0".repeat(64)}))] {
        let mut input=request.clone();input[field]=value;assert_ne!(call(&k,"video.decisions.preview",input)["status"],"succeeded");
    }
    let other=ok(call(&k,"video.projects.create",json!({"title":"同根他作","brief":"隔离","language_tag":"zh-CN","operation_key":"other-decision"})));
    let mut foreign=request.clone();foreign["work_ref"]=other["work_ref"].clone();assert_eq!(call(&k,"video.decisions.preview",foreign)["error"]["code"],"forbidden");
    let mut tampered=preview["preview"].clone();tampered["snapshot"]["title"]=json!("伪标题");
    assert_eq!(call(&k,"video.decisions.save",json!({"work_ref":work,"preview":tampered,"operation_key":"tampered"}))["error"]["code"],"hetu.stale_evidence");
    assert_eq!(call(&k,"video.decisions.save",json!({"work_ref":other["work_ref"],"preview":preview["preview"],"operation_key":"foreign-save"}))["error"]["code"],"forbidden");
    assert!(ok(call(&k,"video.decisions.get",json!({"work_ref":work,"video_episode_id":ep,"purpose":"clip"})))["decision"].is_null());
    assert_eq!(ok(call(&k,"video.decisions.history",json!({"work_ref":work,"video_episode_id":ep,"purpose":"clip"})))["total"],0);
}

#[test]
fn decisions_cannot_withdraw_another_media_or_overwrite_stale_head_and_do_not_imply_delivery_rights() {
    let (_dir,k,work,ep,asset)=setup();let first=ok(call(&k,"video.media.save",save(&work,&ep,&asset,"one")));let second=ok(call(&k,"video.media.save",save(&work,&ep,&asset,"two")));
    assert_ne!(call(&k,"video.decisions.preview",decision_request(&work,&first["media_ref"],"clip","withdrawn",Value::Null))["status"],"succeeded");
    let first_preview=ok(call(&k,"video.decisions.preview",decision_request(&work,&first["media_ref"],"clip","confirmed",Value::Null)));
    let confirmed=record_decision(&k,decision_request(&work,&second["media_ref"],"clip","confirmed",Value::Null),"confirm-two");
    assert_eq!(call(&k,"video.decisions.save",json!({"work_ref":work,"preview":first_preview["preview"],"operation_key":"stale-one"}))["error"]["code"],"revision_conflict");
    assert_eq!(call(&k,"video.decisions.preview",decision_request(&work,&first["media_ref"],"clip","withdrawn",confirmed["decision_ref"].clone()))["error"]["code"],"revision_conflict");
    assert_ne!(call(&k,"video.decisions.get",json!({"work_ref":work,"video_episode_id":ep,"purpose":"final","decision_ref":confirmed["decision_ref"]}))["status"],"succeeded");
    let mut wrong=confirmed["decision_ref"].clone();wrong["sha256"]=json!("0".repeat(64));assert_eq!(call(&k,"video.decisions.get",json!({"work_ref":work,"video_episode_id":ep,"purpose":"clip","decision_ref":wrong}))["error"]["code"],"hetu.stale_evidence");
    let delivery=ok(call(&k,"video.delivery.preview",json!({"work_ref":work,"media_refs":[second["media_ref"]]})));assert_eq!(delivery["author_approval"],"confirmed");
    let current=ok(call(&k,"assets.get",json!({"asset_id":asset["asset_id"]})));
    ok(call(&k,"assets.update",json!({"work_ref":work,"asset_id":asset["asset_id"],"expected":{"revision":current["asset"]["revision"],"sha256":current["sha256"]},"title":current["asset"]["title"],"source":current["asset"]["source"],"rights_status":"reference_only","redistribution_allowed":false,"rights_statement":"撤回交付权","operation_key":"rights-revoked"})));
    assert_eq!(call(&k,"video.delivery.preview",json!({"work_ref":work,"media_refs":[second["media_ref"]]}))["error"]["code"],"forbidden");
    assert_eq!(ok(call(&k,"video.media.get",json!({"work_ref":work,"media_ref":second["media_ref"]})))["author_decision"]["state"],"confirmed");
}

#[test]
fn archived_episode_rejects_new_confirmation_but_preserves_history_and_exact_withdrawal() {
    let (_dir,k,work,ep,asset)=setup();let media=ok(call(&k,"video.media.save",save(&work,&ep,&asset,"candidate")));
    let confirmed=record_decision(&k,decision_request(&work,&media["media_ref"],"clip","confirmed",Value::Null),"confirm");
    let episode=ok(call(&k,"video.episodes.get",json!({"video_episode_id":ep})));
    let project=ok(call(&k,"video.projects.get",json!({"video_project_id":work["object_id"]})));
    ok(call(&k,"video.episodes.update",json!({"project_ref":project_ref(&project),"video_episode_id":ep,
        "expected":{"revision":episode["episode"]["revision"],"sha256":episode["sha256"]},
        "title":episode["episode"]["title"],"brief":episode["episode"]["brief"],"archived":true,"operation_key":"archive-episode"})));
    let withdrawn=record_decision(&k,decision_request(&work,&media["media_ref"],"clip","withdrawn",confirmed["decision_ref"].clone()),"withdraw-archived");
    assert_eq!(withdrawn["decision"]["revision"],2);
    assert_eq!(call(&k,"video.decisions.preview",decision_request(&work,&media["media_ref"],"clip","confirmed",withdrawn["decision_ref"].clone()))["error"]["code"],"forbidden");
}

#[test]
fn media_decision_uses_auto_confirm_policy_and_preserves_agent_actor_and_exact_input() {
    use hetu_core::{execution::WorkspaceExecution,local_settings::LocalSettings};
    let (dir,k,work,ep,asset)=setup();let mut input=save(&work,&ep,&asset,"final");input["purpose"]=json!("final");let media=ok(call(&k,"video.media.save",input));
    let workspace=dir.path().join("作品");let settings=dir.path().join("settings");let execution=WorkspaceExecution::open(&settings,"codex").unwrap();
    let command=|action:&str,input:Value|json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input});
    let preview=ok(execution.request_workspace(&workspace,command("video.decisions.preview",decision_request(&work,&media["media_ref"],"final","confirmed",Value::Null))));
    let input=json!({"work_ref":work,"preview":preview["preview"],"operation_key":"agent-confirm-final"});
    let saved=execution.request_workspace(&workspace,command("video.decisions.save",input.clone()));let confirmed=ok(saved.clone());
    assert_eq!(confirmed["decision"]["actor_ref"],"actor_00000000-0000-4000-8000-000000000002");assert_eq!(saved,execution.request_workspace(&workspace,command("video.decisions.save",input)));
    let service=LocalSettings::open(&settings).unwrap();let before=service.host(json!({"method":"get","input":{}})).unwrap();service.host(json!({"method":"update","input":{"expected_revision":before["revision"],"patch":{"execution_mode":"confirm"},"operation_key":"confirm-mode"}})).unwrap();
    let preview=ok(execution.request_workspace(&workspace,command("video.decisions.preview",decision_request(&work,&media["media_ref"],"final","withdrawn",confirmed["decision_ref"].clone()))));
    let save=command("video.decisions.save",json!({"work_ref":work,"preview":preview["preview"],"operation_key":"agent-withdraw-final"}));
    assert_eq!(execution.request_workspace(&workspace,save.clone())["error"]["code"],"hetu.execution_confirmation_required");
    let plan=ok(execution.request(command("execution.prepare",json!({"workspace_path":workspace,"commands":[save],"summary":"隔离验收：撤回展示的样本成片决定","operation_key":"withdraw-plan"}))));let fixed=json!({"plan_id":plan["plan_id"],"sha256":plan["sha256"]});
    assert_eq!(execution.request(command("execution.execute",json!({"plan_ref":fixed})))["error"]["code"],"hetu.execution_confirmation_required");
    ok(execution.request(command("execution.record_confirmation",json!({"plan_ref":fixed,"decision":"confirm","user_instruction":"隔离测试确认撤回这条指定样本记录","operation_key":"approve-withdraw"}))));
    let done=execution.request(command("execution.execute",json!({"plan_ref":fixed})));let result=ok(done.clone());assert_eq!(result["results"][0]["data"]["decision"]["revision"],2);assert_eq!(execution.request(command("execution.execute",json!({"plan_ref":fixed}))),done);
    assert_eq!(ok(call(&k,"video.decisions.get",json!({"work_ref":work,"video_episode_id":ep,"purpose":"final"})))["decision"]["decision"],"withdrawn");
}

#[test]
fn precise_management_prepares_fixed_media_decision_and_revocation_does_not_allow_recovery() {
    let (dir,k,work,ep,asset)=setup();let media=ok(call(&k,"video.media.save",save(&work,&ep,&asset,"candidate")));
    let directory=dir.path().join("connection");let grant=ok(call(&k,"collaboration.authorize_workspace",json!({"work_ref":work,"client_adapter":"codex","collaboration_path":directory,"operation_key":"grant-decision"})))["management_ref"].clone();
    let hub=CollaborationHub::open(&directory,"codex").unwrap();
    let invoke=|action:&str,mut input:Value|{input["management_ref"]=grant.clone();hub.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))};
    let preview=ok(invoke("video.decisions.preview",decision_request(&work,&media["media_ref"],"clip","confirmed",Value::Null)));
    let input=json!({"work_ref":work,"preview":preview["preview"],"operation_key":"managed-save-decision"});
    assert_ne!(invoke("video.decisions.save",input.clone())["status"],"succeeded");
    let proposal=ok(invoke("agent_operations.prepare",json!({"action":"hetu.video.decisions.save","input":input,"summary":"隔离验收：保留作者对指定片段的明确选用","operation_key":"prepare-decision"})));
    ok(invoke("agent_operations.record_decision",json!({"proposal_id":proposal["proposal_id"],"proposal_sha256":proposal["proposal_sha256"],"expected_state_revision":proposal["state_revision"],"decision":"approve","authorization_note":"隔离验收确认这份固定样本方案","operation_key":"approve-decision"})));
    let execute=json!({"proposal_id":proposal["proposal_id"],"proposal_sha256":proposal["proposal_sha256"],"operation_key":"execute-decision"});let done=ok(invoke("agent_operations.execute",execute.clone()));
    assert_eq!(done,ok(invoke("agent_operations.execute",execute.clone())));assert_eq!(done["result"]["decision"]["actor_ref"],"actor_00000000-0000-4000-8000-000000000002");
    let fixed=done["result"]["decision_ref"].clone();assert_eq!(ok(invoke("video.decisions.get",json!({"work_ref":work,"video_episode_id":ep,"purpose":"clip","decision_ref":fixed})))["decision_ref"],fixed);
    ok(call(&k,"collaboration.revoke_management",json!({"grant_id":grant["grant_id"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"revoke-decision"})));
    assert_eq!(invoke("agent_operations.execute",execute)["error"]["code"],"forbidden");assert_eq!(invoke("video.decisions.history",json!({"work_ref":work,"video_episode_id":ep,"purpose":"clip"}))["error"]["code"],"forbidden");
    assert_eq!(ok(call(&k,"video.decisions.get",json!({"work_ref":work,"video_episode_id":ep,"purpose":"clip"})))["decision_ref"],fixed);
}

#[test]
fn decision_history_refuses_other_slot_cursor_and_tampered_history_or_slot() {
    let (dir,k,work,ep,asset)=setup();let media=ok(call(&k,"video.media.save",save(&work,&ep,&asset,"candidate")));
    let first=record_decision(&k,decision_request(&work,&media["media_ref"],"clip","confirmed",Value::Null),"confirm-history");
    let second=record_decision(&k,decision_request(&work,&media["media_ref"],"clip","withdrawn",first["decision_ref"].clone()),"withdraw-history");
    let page=ok(call(&k,"video.decisions.history",json!({"work_ref":work,"video_episode_id":ep,"purpose":"clip","limit":1})));
    assert_eq!(call(&k,"video.decisions.history",json!({"work_ref":work,"video_episode_id":ep,"purpose":"final","limit":1,"cursor":page["next_cursor"]}))["error"]["code"],"hetu.stale_evidence");
    let slot=dir.path().join("作品/packages/video/decision-slots").join(ep.as_str().unwrap()).join("clip.json");
    let original_slot=std::fs::read(&slot).unwrap();let mut bad=second["decision_ref"].clone();bad["sha256"]=json!("0".repeat(64));std::fs::write(&slot,serde_json::to_vec(&bad).unwrap()).unwrap();
    assert_eq!(call(&k,"video.decisions.get",json!({"work_ref":work,"video_episode_id":ep,"purpose":"clip"}))["error"]["code"],"hetu.stale_evidence");
    std::fs::write(&slot,original_slot).unwrap();
    let historical=dir.path().join("作品/packages/video/decisions").join(first["decision_ref"]["decision_id"].as_str().unwrap()).join("revisions/1.json");
    let before=std::fs::read(&historical).unwrap();let mut changed:Value=serde_json::from_slice(&before).unwrap();changed["author_statement"]=json!("被外部改写");std::fs::write(&historical,serde_json::to_vec(&changed).unwrap()).unwrap();
    assert_eq!(call(&k,"video.decisions.get",json!({"work_ref":work,"video_episode_id":ep,"purpose":"clip","decision_ref":first["decision_ref"]}))["error"]["code"],"hetu.integrity_failure");
    assert_eq!(ok(call(&k,"video.media.get",json!({"work_ref":work,"media_ref":media["media_ref"]})))["author_decision"]["state"],"withdrawn");
    std::fs::write(&historical,before).unwrap();assert_eq!(ok(call(&k,"video.decisions.history",json!({"work_ref":work,"video_episode_id":ep,"purpose":"clip"})))["total"],2);
}

fn caption(k: &Kernel, work: &Value, bytes: &[u8], key: &str) -> Value {
    let sha = format!("{:x}", Sha256::digest(bytes));
    ok(call(
        k,
        "assets.import",
        json!({"work_ref":work,
        "inline_source":{"filename":"字幕.vtt","sha256":sha,"base64":STANDARD.encode(bytes)},
        "expected_file":{"sha256":sha,"size_bytes":bytes.len()},"title":key,
        "source":{"source_type":"author_supplied","creator_statement":"字幕隔离样本"},
        "rights_status":"author_owned","redistribution_allowed":true,"rights_statement":"允许交付隔离字幕","operation_key":key}),
    ))
}

#[test]
fn captions_preserve_fixed_bytes_history_owner_and_original_operation() {
    let (dir, k, work, ep, asset) = setup();
    let raw = "\u{feff}WEBVTT\n\n00:00.100 --> 00:01.500\n渡口的灯亮了。🌿\n".as_bytes();
    let c = caption(&k, &work, raw, "caption");
    assert_eq!(c, caption(&k, &work, raw, "caption"));
    assert_eq!(c["asset"]["schema_version"], "3.0.0");
    assert_eq!(c["asset"]["blob"]["validation"], "utf8_webvtt");
    let reference = json!({"asset_id":c["asset"]["asset_id"],"revision":1,"sha256":c["sha256"]});
    let track = json!({"id":"zh","label":"简体中文","language":"zh-CN","asset_ref":reference});
    let old = ok(call(
        &k,
        "video.media.save",
        save(&work, &ep, &asset, "old"),
    ));
    let mut input = save(&work, &ep, &asset, "captioned");
    input["previous_media_ref"] = old["media_ref"].clone();
    input["caption_tracks"] = json!([track]);
    let new = ok(call(&k, "video.media.save", input.clone()));
    assert_eq!(new, ok(call(&k, "video.media.save", input)));
    assert_eq!(new["media"]["schema_version"], "2.0.0");
    let mut bad = save(&work, &ep, &asset, "duplicate");
    bad["caption_tracks"] = json!([track, track]);
    assert_eq!(
        call(&k, "video.media.save", bad)["error"]["code"],
        "invalid_input"
    );
    let mut bad = save(&work, &ep, &asset, "wrong-type");
    bad["caption_tracks"] = json!([{ "id":"zh","label":"中文","language":"zh","asset_ref":asset}]);
    assert_eq!(
        call(&k, "video.media.save", bad)["error"]["code"],
        "invalid_input"
    );
    let mut bad = save(&work, &ep, &asset, "wrong-sha");
    bad["caption_tracks"] = json!([track]);
    bad["caption_tracks"][0]["asset_ref"]["sha256"] = json!("0".repeat(64));
    assert_eq!(
        call(&k, "video.media.save", bad)["error"]["code"],
        "hetu.stale_evidence"
    );
    let other = ok(call(
        &k,
        "video.projects.create",
        json!({"title":"另一字幕作品","brief":"隔离","language_tag":"zh-CN","operation_key":"other-caption-work"}),
    ));
    let foreign = caption(&k, &other["work_ref"], raw, "foreign-caption");
    let mut bad = save(&work, &ep, &asset, "foreign-caption-ref");
    bad["caption_tracks"] = json!([track]);
    bad["caption_tracks"][0]["asset_ref"] =
        json!({"asset_id":foreign["asset"]["asset_id"],"revision":1,"sha256":foreign["sha256"]});
    assert_eq!(
        call(&k, "video.media.save", bad)["error"]["code"],
        "forbidden"
    );
    drop(k);
    let k =
        Kernel::open(json!({"workspace_path":dir.path().join("作品"),"mode":"author"})).unwrap();
    let view = ok(call(
        &k,
        "video.media.get",
        json!({"work_ref":work,"media_ref":new["media_ref"]}),
    ));
    assert_eq!(view["media"]["caption_tracks"], json!([track]));
    assert!(
        ok(call(
            &k,
            "video.media.get",
            json!({"work_ref":work,"media_ref":old["media_ref"]})
        ))["media"]
            .get("caption_tracks")
            .is_none()
    );
    let chunk = ok(call(
        &k,
        "assets.read_blob",
        json!({"work_ref":work,"asset_ref":reference,"offset":0,"length":12000}),
    ));
    assert_eq!(
        STANDARD.decode(chunk["base64"].as_str().unwrap()).unwrap(),
        raw
    );
    let delivery = ok(call(
        &k,
        "video.delivery.preview",
        json!({"work_ref":work,"media_refs":[new["media_ref"]]}),
    ));
    assert_eq!(delivery["items"][0]["caption_files"][0]["track"], track);
    ok(call(
        &k,
        "assets.update",
        json!({"work_ref":work,"asset_id":reference["asset_id"],"expected":{"revision":1,"sha256":c["sha256"]},"title":"字幕","source":c["asset"]["source"],"rights_status":"reference_only","redistribution_allowed":false,"rights_statement":"撤回字幕交付许可","operation_key":"revoke-caption"}),
    ));
    assert_eq!(
        call(
            &k,
            "video.delivery.preview",
            json!({"work_ref":work,"media_refs":[new["media_ref"]]})
        )["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        ok(call(
            &k,
            "video.media.get",
            json!({"work_ref":work,"media_ref":new["media_ref"]})
        ))["media"]["caption_tracks"],
        json!([track])
    );
}

#[test]
fn caption_provenance_reads_original_plugin_revision_without_runtime() {
    let (_dir, k, work, ep, asset) = setup();
    let c = caption(
        &k,
        &work,
        b"WEBVTT\n\n00:00.100 --> 00:01.500\nLight\n",
        "caption-source",
    );
    let owner = "org.hetu.caption-test";
    let context = json!({"plugin_id":owner,"package_sha256":"a".repeat(64),"work_ref":work,
        "types":[{"kind":"caption-project","schema_version":"1","schema":{"type":"object"}}]});
    let source=ok(k.open_plugin_request(json!({"context":context,"request":{"action":"hetu.extensions.objects.save","contract_revision":"1","input":{
        "work_ref":work,"kind":"caption-project","title":"固定字幕依据","schema_version":"1","content":{"track":"zh"},"expected_revision":0,"expected_sha256":"","operation_key":"source"}}})));
    let mut input = save(&work, &ep, &asset, "caption-provenance");
    input["caption_tracks"] = json!([{"id":"en","label":"English","language":"en","asset_ref":{"asset_id":c["asset"]["asset_id"],"revision":1,"sha256":c["sha256"]},
        "source_object_ref":{"owner_plugin_id":owner,"object_id":source["object"]["object_id"],"revision":1,"sha256":source["sha256"]}}]);
    let first = ok(call(&k, "video.media.save", input.clone()));
    assert_eq!(first["media"]["caption_tracks"], input["caption_tracks"]);
    input["operation_key"] = json!("wrong-provenance");
    input["caption_tracks"][0]["source_object_ref"]["sha256"] = json!("0".repeat(64));
    assert_eq!(
        call(&k, "video.media.save", input)["error"]["code"],
        "hetu.stale_evidence"
    );
}

#[test]
fn caption_inspection_checks_complete_utf8_control_characters_and_budget() {
    let (_dir, k, work, _, _) = setup();
    let inspect = |bytes: &[u8]| {
        call(
            &k,
            "assets.inspect",
            json!({"work_ref":work,"inline_source":{"filename":"字幕.vtt","sha256":format!("{:x}",Sha256::digest(bytes)),"base64":STANDARD.encode(bytes)}}),
        )
    };
    for raw in [
        b"WEBVTT\n\n\0".as_slice(),
        b"WEBVTT\n\n\x1b[0m",
        b"WEBVTT wrong --> header\n\n",
        b"WEBVTTx\n\n",
    ] {
        assert_ne!(inspect(raw)["status"], "succeeded");
    }
    let mut raw = b"WEBVTT\n\n".to_vec();
    raw.extend(vec![b'a'; 200]);
    raw.push(0xff);
    assert_eq!(inspect(&raw)["error"]["code"], "hetu.unsupported_media");
    let file = _dir.path().join("invalid.vtt");
    std::fs::write(&file, &raw).unwrap();
    assert_eq!(
        call(&k, "assets.inspect", json!({"file_path":file}))["error"]["code"],
        "hetu.unsupported_media"
    );
    let mut raw = b"WEBVTT\n\n".to_vec();
    raw.resize(1024 * 1024 + 1, b' ');
    assert_eq!(inspect(&raw)["error"]["code"], "hetu.budget_exceeded");
    std::fs::write(&file, &raw).unwrap();
    assert_eq!(
        call(&k, "assets.inspect", json!({"file_path":file}))["error"]["code"],
        "hetu.budget_exceeded"
    );
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
