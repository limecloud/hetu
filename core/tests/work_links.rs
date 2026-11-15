use hetu_core::{Kernel, collaboration::CollaborationHub};
use serde_json::{Value, json};

fn call(kernel: &Kernel, name: &str, input: Value) -> Value {
    kernel.request(json!({"action":format!("hetu.{name}"),"contract_revision":"1","input":input}))
}
fn ok(value: Value) -> Value {
    assert_eq!(value["status"], "succeeded", "{value}"); value["data"].clone()
}
fn setup(root: &std::path::Path) -> (Kernel, Value, Value, Value) {
    let k = Kernel::open(json!({"workspace_path":root,"mode":"author","create":{"title":"原著旧名","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let works = ok(call(&k, "works.list", json!({})));
    let source = works["works"][0]["fixed_ref"].clone();
    let drama = ok(call(&k, "drama.projects.create", json!({"title":"独立改编","operation_key":"drama"})));
    let target = ok(call(&k, "works.get", json!({"work_ref":{"workspace_id":k.scope(),"kind":"drama","object_id":drama["project"]["project_id"]}})))["summary"]["fixed_ref"].clone();
    let link = ok(call(&k, "work_links.create", json!({"source_ref":source,"target_ref":target,"relation":"adaptation","operation_key":"link"})));
    (k, source, target, link)
}
fn link_ref(link: &Value) -> Value {
    json!({"link_id":link["link"]["link_id"],"revision":link["link"]["revision"],"sha256":link["sha256"]})
}
fn rename(k: &Kernel) -> Value {
    let n = ok(call(k, "novels.get", json!({})));
    let mut metadata = n["novel"]["metadata"].clone(); metadata["title"] = json!("原著新版名"); metadata["synopsis"] = json!("只更新资料，不改旧依据。");
    ok(call(k, "novels.update", json!({"expected":{"revision":n["revision"],"sha256":n["sha256"]},"metadata":metadata,"operation_key":"rename"})));
    ok(call(k, "works.list", json!({"kind":"novel"})))["works"][0]["fixed_ref"].clone()
}

#[test]
fn source_advance_is_explicit_cas_and_old_association_stays_readable() {
    let dir = tempfile::tempdir().unwrap(); let (k, source, target, link) = setup(dir.path());
    let next_source = rename(&k);
    let before = ok(call(&k,"work_links.get",json!({"work_ref":target["work_ref"],"link_id":link["link"]["link_id"]})));
    assert_eq!(before["related_title"], "原著旧名");
    assert_eq!(before["related_work"]["summary"]["fixed_ref"], source);
    assert_eq!(before["related_has_newer_revision"], true);
    let before_target = ok(call(&k,"works.get",json!({"work_ref":target["work_ref"]})));
    let input = json!({"work_ref":target["work_ref"],"link_ref":link_ref(&link),"source_ref":next_source,"target_ref":target,"operation_key":"advance"});
    let response = call(&k,"work_links.update_source",input.clone()); let updated = ok(response.clone());
    assert_eq!(response,call(&k,"work_links.update_source",input.clone()));
    assert_eq!(updated["link"]["revision"],2); assert_eq!(updated["link"]["previous_sha256"],link["sha256"]);
    assert_eq!(updated["link"]["source_title"],"原著新版名");
    let mut stale=input; stale["operation_key"]=json!("stale");
    assert_eq!(call(&k,"work_links.update_source",stale)["error"]["code"],"revision_conflict");
    let old=ok(call(&k,"work_links.get",json!({"work_ref":target["work_ref"],"link_id":link["link"]["link_id"],"revision":1})));
    assert_eq!(old["link"],link["link"]); assert_eq!(old["sha256"],link["sha256"]);
    assert_eq!(old["current_link_ref"],link_ref(&updated));
    assert_eq!(ok(call(&k,"works.get",json!({"work_ref":target["work_ref"]})))["record"],before_target["record"]);
    assert_eq!(ok(call(&k,"work_links.list",json!({"work_ref":source["work_ref"]})))["links"][0]["link"],updated["link"]);
}

#[test]
fn archive_restore_preserve_history_and_cannot_restore_a_duplicate() {
    let dir=tempfile::tempdir().unwrap(); let (k,source,target,link)=setup(dir.path());
    let input=json!({"work_ref":target["work_ref"],"link_ref":link_ref(&link),"archived":true,"operation_key":"archive"});
    let response=call(&k,"work_links.set_archived",input.clone()); let archived=ok(response.clone());
    assert_eq!(response,call(&k,"work_links.set_archived",input));
    assert!(ok(call(&k,"work_links.list",json!({"work_ref":target["work_ref"]})))["links"].as_array().unwrap().is_empty());
    assert_eq!(ok(call(&k,"work_links.list",json!({"work_ref":target["work_ref"],"include_archived":true})))["links"][0]["link"],archived["link"]);
    let restore=json!({"work_ref":target["work_ref"],"link_ref":link_ref(&archived),"archived":false,"operation_key":"restore"});
    let restored=ok(call(&k,"work_links.set_archived",restore)); assert_eq!(restored["link"]["revision"],3);
    let archived=ok(call(&k,"work_links.set_archived",json!({"work_ref":target["work_ref"],"link_ref":link_ref(&restored),"archived":true,"operation_key":"archive-again"})));
    ok(call(&k,"work_links.create",json!({"source_ref":source,"target_ref":target,"relation":"adaptation","operation_key":"second"})));
    assert_eq!(call(&k,"work_links.set_archived",json!({"work_ref":target["work_ref"],"link_ref":link_ref(&archived),"archived":false,"operation_key":"duplicate"}))["error"]["code"],"invalid_input");
    assert_eq!(ok(call(&k,"work_links.get",json!({"work_ref":source["work_ref"],"link_id":link["link"]["link_id"],"revision":1})))["link"],link["link"]);
}

#[test]
fn updating_a_basis_cannot_replace_objects_or_accept_a_stale_target_or_false_digest() {
    let dir=tempfile::tempdir().unwrap(); let (k,source,target,link)=setup(dir.path()); let next_source=rename(&k);
    let base=json!({"work_ref":target["work_ref"],"link_ref":link_ref(&link),"source_ref":next_source,"target_ref":target,"operation_key":"change"});
    let other=ok(call(&k,"drama.projects.create",json!({"title":"另一剧本","operation_key":"other"})));
    let mut wrong=base.clone(); wrong["target_ref"]["work_ref"]["object_id"]=other["project"]["project_id"].clone();
    assert_eq!(call(&k,"work_links.update_source",wrong)["error"]["code"],"invalid_input");
    let mut wrong=base.clone(); wrong["source_ref"]["sha256"]=json!("0".repeat(64));
    assert_eq!(call(&k,"work_links.update_source",wrong)["error"]["code"],"hetu.stale_evidence");
    ok(call(&k,"drama.episodes.create",json!({"project_ref":{"project_id":target["work_ref"]["object_id"],"revision":target["revision_ref"]["revision"],"sha256":target["sha256"]},"title":"第一集","plan":"新的目录","language_tag":"zh-CN","operation_key":"episode"})));
    assert_eq!(call(&k,"work_links.update_source",base)["error"]["code"],"revision_conflict");
    assert_eq!(ok(call(&k,"work_links.get",json!({"work_ref":source["work_ref"],"link_id":link["link"]["link_id"]})))["link"],link["link"]);
}

#[test]
fn related_failure_is_local_and_does_not_turn_into_no_newer_revision() {
    let dir=tempfile::tempdir().unwrap(); let (k,source,target,link)=setup(dir.path());
    let video=ok(call(&k,"video.projects.create",json!({"title":"仍可读取的参考视频","brief":"","language_tag":"zh-CN","operation_key":"video"})));
    let video_ref=ok(call(&k,"works.get",json!({"work_ref":video["work_ref"]})))["summary"]["fixed_ref"].clone();
    ok(call(&k,"work_links.create",json!({"source_ref":video_ref,"target_ref":target,"relation":"reference","operation_key":"second-link"})));
    // 隔离故障注入：来源记录损坏时，关系和其他对象仍可读取，不能伪报当前性。
    let path=dir.path().join("packages/novel/novel.json"); let original=std::fs::read(&path).unwrap();
    std::fs::write(&path,b"{}").unwrap();
    let list=ok(call(&k,"work_links.list",json!({"work_ref":target["work_ref"]})));
    let rows=list["links"].as_array().unwrap(); assert_eq!(rows.len(),2);
    let broken=rows.iter().find(|v|v["link"]["link_id"]==link["link"]["link_id"]).unwrap();
    assert_eq!(broken["related_status"],"unavailable");
    assert!(broken["related_has_newer_revision"].is_null()); assert!(broken["related_error"].is_object());
    assert_eq!(broken["related_title"],"原著旧名");
    assert!(rows.iter().any(|v|v["related_status"]=="available" && v["related_title"]=="仍可读取的参考视频"));
    ok(call(&k,"work_links.set_archived",json!({"work_ref":target["work_ref"],"link_ref":link_ref(&link),"archived":true,"operation_key":"archive-unavailable"})));
    std::fs::write(path,original).unwrap();
    assert_eq!(ok(call(&k,"works.get",json!({"work_ref":source["work_ref"],"revision":1})))["summary"]["fixed_ref"],source);
}

#[test]
fn narrow_target_can_prepare_archive_without_reading_sibling_but_source_cannot_manage_downstream() {
    let dir=tempfile::tempdir().unwrap(); let (k,source,target,link)=setup(&dir.path().join("作品"));
    let directory=dir.path().join("授权"); let hub=CollaborationHub::open(&directory,"codex").unwrap();
    let grant=|reference:&Value,key:&str|ok(call(&k,"collaboration.authorize_workspace",json!({"work_ref":reference,"client_adapter":"codex","collaboration_path":directory,"operation_key":key})))["management_ref"].clone();
    let target_grant=grant(&target["work_ref"],"target"); let source_grant=grant(&source["work_ref"],"source");
    let request=|g:&Value,name:&str,mut input:Value|{input["management_ref"]=g.clone();hub.request(json!({"action":format!("hetu.{name}"),"contract_revision":"1","input":input}))};
    let view=ok(request(&target_grant,"work_links.get",json!({"work_ref":target["work_ref"],"link_id":link["link"]["link_id"]})));
    assert_eq!(view["related_status"],"requires_authorization"); assert!(view["related_work"].is_null()); assert!(view["related_has_newer_revision"].is_null());
    let input=json!({"work_ref":target["work_ref"],"link_ref":link_ref(&link),"archived":true,"operation_key":"archive"});
    let proposal_input=json!({"action":"hetu.work_links.set_archived","input":input,"summary":"解除改编依据，保留旧版","operation_key":"prepare"});
    let proposed=ok(request(&target_grant,"agent_operations.prepare",proposal_input.clone()));
    assert_eq!(proposed["preview"]["link"]["archived"],true);
    assert_eq!(request(&source_grant,"agent_operations.prepare",proposal_input)["error"]["code"],"forbidden");
    assert_eq!(request(&target_grant,"agent_operations.execute",json!({"proposal_id":proposed["proposal_id"],"proposal_sha256":proposed["proposal_sha256"],"operation_key":"execute"}))["error"]["code"],"hetu.author_confirmation_required");
    ok(call(&k,"agent_operations.decide",json!({"proposal_id":proposed["proposal_id"],"proposal_sha256":proposed["proposal_sha256"],"expected_state_revision":1,"decision":"approve","operation_key":"approve"})));
    let executed=ok(request(&target_grant,"agent_operations.execute",json!({"proposal_id":proposed["proposal_id"],"proposal_sha256":proposed["proposal_sha256"],"operation_key":"execute-approved"})));
    assert_eq!(executed["state"],"executed");
    let other=ok(call(&k,"drama.projects.create",json!({"title":"不属于本次的作品","operation_key":"other"})));
    let other_ref=json!({"workspace_id":k.scope(),"kind":"drama","object_id":other["project"]["project_id"]});
    assert_eq!(request(&target_grant,"work_links.get",json!({"work_ref":other_ref,"link_id":link["link"]["link_id"],"revision":1}))["error"]["code"],"forbidden");
    assert_eq!(call(&k,"work_links.get",json!({"work_ref":other_ref,"link_id":link["link"]["link_id"]}))["error"]["code"],"forbidden");
}

#[test]
fn fixed_detail_reports_damaged_history_instead_of_showing_current_profile() {
    let dir=tempfile::tempdir().unwrap(); let (k,_,target,link)=setup(dir.path()); rename(&k);
    let path=dir.path().join(".hetu/novels/1.json");
    std::fs::write(path,b"{}").unwrap();
    let view=ok(call(&k,"work_links.get",json!({"work_ref":target["work_ref"],"link_id":link["link"]["link_id"]})));
    assert_eq!(view["related_title"],"原著旧名");
    assert_eq!(view["related_status"],"unavailable");
    assert_eq!(view["related_error"]["code"],"hetu.integrity_failure");
    assert!(view["related_work"].is_null());
    assert!(view["related_has_newer_revision"].is_null());
}

#[test]
fn fixed_restore_proposal_detects_a_new_duplicate_before_execution() {
    let dir=tempfile::tempdir().unwrap(); let (k,source,target,link)=setup(dir.path());
    let archived=ok(call(&k,"work_links.set_archived",json!({"work_ref":target["work_ref"],"link_ref":link_ref(&link),"archived":true,"operation_key":"archive"})));
    let proposal=ok(call(&k,"agent_operations.prepare",json!({"action":"hetu.work_links.set_archived","input":{"work_ref":target["work_ref"],"link_ref":link_ref(&archived),"archived":false,"operation_key":"restore"},"summary":"恢复固定依据","operation_key":"prepare"})));
    ok(call(&k,"agent_operations.decide",json!({"proposal_id":proposal["proposal_id"],"proposal_sha256":proposal["proposal_sha256"],"expected_state_revision":1,"decision":"approve","operation_key":"approve"})));
    ok(call(&k,"work_links.create",json!({"source_ref":source,"target_ref":target,"relation":"adaptation","operation_key":"duplicate"})));
    assert_eq!(call(&k,"agent_operations.execute",json!({"proposal_id":proposal["proposal_id"],"proposal_sha256":proposal["proposal_sha256"],"operation_key":"execute"}))["error"]["code"],"revision_conflict");
    let view=ok(call(&k,"work_links.get",json!({"work_ref":target["work_ref"],"link_id":link["link"]["link_id"]})));
    assert_eq!(view["link"]["archived"],true);
}
