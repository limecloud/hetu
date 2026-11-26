use hetu_core::{Kernel, collaboration::CollaborationHub, execution::WorkspaceExecution, local_settings::LocalSettings};
use serde_json::{Value, json};

fn request(action: &str, input: Value) -> Value {json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input})}
fn ok(result: Value) -> Value {assert_eq!(result["status"],"succeeded","{result}"); result["data"].clone()}
fn command(action: &str, input: Value) -> Value {request(action,input)}
fn setup(root: &std::path::Path) -> (Kernel, std::path::PathBuf, std::path::PathBuf, WorkspaceExecution) {
    let work = root.join("work"); let settings = root.join("settings");
    let author = Kernel::open(json!({"workspace_path":work,"mode":"author","create":{"title":"执行测试","locale":"zh-CN","operation_key":"create"}})).unwrap();
    let execution = WorkspaceExecution::open(&settings,"generic").unwrap(); (author,work,settings,execution)
}
fn create(execution: &WorkspaceExecution, work: &std::path::Path, title: &str) -> Value {
    ok(execution.request_workspace(work,command("documents.create",json!({"kind":"novel_chapter","title":title,"source_format":"markdown","content":"原文🌿\r\n末段","operation_key":title}))))
}
fn mode(settings: &std::path::Path, value: &str, key: &str) {
    let service = LocalSettings::open(settings).unwrap(); let before = service.host(json!({"method":"get","input":{}})).unwrap();
    service.host(json!({"method":"update","input":{"expected_revision":before["revision"],"patch":{"execution_mode":value},"operation_key":key}})).unwrap();
}
fn plan(execution: &WorkspaceExecution, work: &std::path::Path, commands: Value, key: &str) -> Value {
    let value = ok(execution.request(request("execution.prepare",json!({"workspace_path":work,"commands":commands,"summary":"本次固定修改","operation_key":key}))));
    json!({"plan_id":value["plan_id"],"sha256":value["sha256"]})
}
fn confirm(execution: &WorkspaceExecution, reference: &Value) -> Value {
    execution.request(request("execution.record_confirmation",json!({"plan_ref":reference,"decision":"confirm","user_instruction":"确认所展示的本次固定修改","operation_key":"confirm"})))
}
#[test]
fn default_auto_writes_without_task_or_management_grant_and_keeps_agent_identity() {
    let folder = tempfile::tempdir().unwrap(); let (_,work,_,execution) = setup(folder.path());
    let policy = ok(execution.request(request("execution.get_mode",json!({})))); assert_eq!(policy["execution_mode"],"auto");
    let document = create(&execution,&work,"新章节");
    assert_eq!(document["revision"]["actor_ref"],"actor_00000000-0000-4000-8000-000000000002");
    let input = json!({"document_id":document["document"]["document_id"],"base_revision_id":document["revision"]["revision_id"],"content":"直接修改\r\n🌿","source_format":"markdown","operation_key":"edit"});
    let saved = execution.request_workspace(&work,command("documents.save",input.clone())); ok(saved.clone());
    assert_eq!(execution.request_workspace(&work,command("documents.save",input.clone())),saved);
    let mut different = input; different["content"] = json!("不能复用键");
    assert_eq!(execution.request_workspace(&work,command("documents.save",different))["error"]["code"],"idempotency_conflict");
}
#[test]
fn current_workspace_execution_closes_fixed_task_without_author_identity() {
    let folder=tempfile::tempdir().unwrap();let(author,work,_,execution)=setup(folder.path());
    let preview=ok(author.request(command("creative_tasks.preview_prompt",json!({"scope_ref":{"kind":"workspace","id":author.scope()},"task_kind":"chapter_draft","brief":"固定任务关闭","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN","candidate_limit":1}))));
    let mut input=preview["prepare_input"].clone();input["operation_key"]=json!("prepare-close");
    let task=ok(author.request(command("creative_tasks.prepare",input)));
    let before=ok(author.request(command("creative_tasks.get",json!({"task_ref":task["task_ref"]}))));
    let closed=ok(execution.request(request("execution.invoke",json!({"workspace_path":work,"command":command("creative_tasks.close",json!({"task_ref":task["task_ref"],"expected":before["expected"],"reason":"本次完成","operation_key":"close-agent"}))}))));
    assert_eq!(ok(closed["result"].clone())["state"],"closed");
    assert!(Kernel::open(json!({"workspace_path":work,"mode":"agent","task_id":task["task_ref"]["task_id"]})).is_err());
}
#[test]
fn confirm_reads_directly_and_one_fixed_confirmation_executes_two_writes_once() {
    let folder = tempfile::tempdir().unwrap(); let (author,work,settings,execution) = setup(folder.path());
    let first = create(&execution,&work,"第一章"); let second = create(&execution,&work,"第二章"); mode(&settings,"confirm","mode");
    let read = command("documents.get",json!({"document_id":first["document"]["document_id"]})); ok(execution.request_workspace(&work,read));
    let change = |document: &Value,key:&str| command("documents.save",json!({"document_id":document["document"]["document_id"],"base_revision_id":document["revision"]["revision_id"],"source_format":"markdown","content":key,"operation_key":key}));
    let one = change(&first,"改一"); let two = change(&second,"改二");
    assert_eq!(execution.request_workspace(&work,one.clone())["error"]["code"],"hetu.execution_confirmation_required");
    let reference = plan(&execution,&work,json!([one,two]),"batch");
    assert_eq!(execution.request(request("execution.execute",json!({"plan_ref":reference})))["error"]["code"],"hetu.execution_confirmation_required");
    ok(confirm(&execution,&reference));
    let done = execution.request(request("execution.execute",json!({"plan_ref":reference}))); let data = ok(done.clone());
    assert_eq!(data["state"],"completed"); assert_eq!(data["results"].as_array().unwrap().len(),2);
    assert_eq!(execution.request(request("execution.execute",json!({"plan_ref":reference}))),done);
    assert_eq!(ok(author.request(command("documents.get",json!({"document_id":first["document"]["document_id"]}))))["content"],"改一");
}
#[test]
fn policy_switch_does_not_revive_prior_confirmation_and_font_changes_do_not_revoke_it() {
    let folder = tempfile::tempdir().unwrap(); let (_,work,settings,execution) = setup(folder.path()); let document = create(&execution,&work,"章节"); mode(&settings,"confirm","mode");
    let change = command("documents.rename",json!({"document_id":document["document"]["document_id"],"base_revision_id":document["revision"]["revision_id"],"title":"新名称","operation_key":"rename"}));
    let reference = plan(&execution,&work,json!([change]),"fixed"); ok(confirm(&execution,&reference));
    let service = LocalSettings::open(&settings).unwrap(); let before = service.host(json!({"method":"get","input":{}})).unwrap();
    service.host(json!({"method":"update","input":{"expected_revision":before["revision"],"patch":{"appearance":"dark"},"operation_key":"theme"}})).unwrap();
    assert_eq!(ok(execution.request(request("execution.get_mode",json!({}))))["policy_revision"],before["execution_policy_revision"]);
    mode(&settings,"auto","auto"); mode(&settings,"confirm","back");
    assert_eq!(execution.request(request("execution.execute",json!({"plan_ref":reference})))["error"]["code"],"revision_conflict");
}
#[test]
fn partial_batch_preserves_receipts_and_resumes_original_key_after_transport_reopen() {
    let folder = tempfile::tempdir().unwrap(); let (_,work,settings,execution) = setup(folder.path()); let document = create(&execution,&work,"章节");
    let rename = command("documents.rename",json!({"document_id":document["document"]["document_id"],"base_revision_id":document["revision"]["revision_id"],"title":"第一步成功","operation_key":"rename"}));
    let stale = command("documents.save",json!({"document_id":document["document"]["document_id"],"base_revision_id":document["revision"]["revision_id"],"source_format":"markdown","content":"过期写入","operation_key":"save"}));
    let reference = plan(&execution,&work,json!([rename,stale]),"fixed");
    let result = execution.request(request("execution.execute",json!({"plan_ref":reference})));
    assert_eq!(result["status"],"blocked"); assert_eq!(result["error"]["code"],"revision_conflict");
    let progress=ok(execution.request(request("execution.get_plan",json!({"plan_ref":reference}))));
    assert_eq!(progress["results"].as_array().unwrap().len(),1);
    assert_eq!(result["error"]["resolution"]["input"]["plan_ref"],reference);
    drop(execution); let reopened = WorkspaceExecution::open(&settings,"generic").unwrap();
    let resumed = reopened.request(request("execution.execute",json!({"plan_ref":reference}))); assert_eq!(resumed,result);
    let mut changed = reference.clone(); changed["sha256"] = json!("0".repeat(64));
    assert_eq!(reopened.request(request("execution.get_plan",json!({"plan_ref":changed})))["error"]["code"],"forbidden");
}
#[test]
fn auto_initialization_uses_same_policy_and_replays_original_creation() {
    let folder = tempfile::tempdir().unwrap(); let settings = folder.path().join("settings"); let work = folder.path().join("new"); let execution = WorkspaceExecution::open(&settings,"generic").unwrap();
    let input = json!({"workspace_path":work,"create":{"title":"独立剧本","locale":"zh-CN","work_type":"drama","operation_key":"create"}});
    let result = execution.request(request("execution.initialize",input.clone())); let data = ok(result.clone()); assert_eq!(data["result"]["status"],"succeeded");
    assert_eq!(execution.request(request("execution.initialize",input)),result);
    assert_eq!(ok(execution.request(request("execution.get_mode",json!({}))))["execution_mode"],"auto");
}

#[test]
fn execution_creation_is_discoverable_without_reviving_a_revoked_registration() {
    let folder = tempfile::tempdir().unwrap();
    let work = folder.path().join("new"); let settings = folder.path().join("settings"); let directory = folder.path().join("connection");
    let execution = WorkspaceExecution::open(&settings,"codex").unwrap().with_collaboration_directory(&directory);
    let hub = CollaborationHub::open(&directory,"codex").unwrap();
    let initialization = request("execution.initialize",json!({"workspace_path":work,"create":{"title":"新建发现","locale":"zh-CN","work_type":"novel","operation_key":"create"}}));
    let first = execution.request(initialization.clone()); ok(first.clone());
    assert_eq!(execution.request(initialization.clone()),first);
    let works = ok(hub.request(request("collaboration.created_works",json!({}))));
    assert_eq!(works["works"].as_array().unwrap().len(),1);
    let created = &works["works"][0];
    assert_eq!(created["path"],json!(work.canonicalize().unwrap())); assert_eq!(created["work_ref"]["kind"],"novel");
    let author = Kernel::open(json!({"workspace_path":work,"mode":"author"})).unwrap();
    let reference = &created["management_ref"];
    ok(hub.request(request("documents.list",json!({"management_ref":reference,"work_ref":created["work_ref"]}))));
    let other = CollaborationHub::open(&directory,"claude-code").unwrap();
    assert!(ok(other.request(request("collaboration.created_works",json!({}))))["works"].as_array().unwrap().is_empty());
    assert_eq!(other.request(request("documents.list",json!({"management_ref":reference,"work_ref":created["work_ref"]})))["error"]["code"],"forbidden");
    ok(author.request(request("collaboration.revoke_management",json!({"grant_id":reference["grant_id"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"revoke"}))));
    ok(execution.request(initialization));
    assert!(ok(hub.request(request("collaboration.created_works",json!({}))))["works"].as_array().unwrap().is_empty());
    assert_eq!(hub.request(request("documents.list",json!({"management_ref":reference,"work_ref":created["work_ref"]})))["error"]["code"],"forbidden");
}

#[test]
fn execution_prepared_task_opens_in_stable_connection_and_replay_does_not_reauthorize() {
    let folder = tempfile::tempdir().unwrap(); let (author,work,settings,_) = setup(folder.path()); let directory = folder.path().join("connection");
    let execution = WorkspaceExecution::open(&settings,"codex").unwrap().with_collaboration_directory(&directory);
    let hub = CollaborationHub::open(&directory,"codex").unwrap();
    let preview = ok(execution.request_workspace(&work,request("creative_tasks.preview_prompt",json!({"scope_ref":{"kind":"workspace","id":author.scope()},"task_kind":"chapter_draft","brief":"统一执行任务接续","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN","candidate_limit":1}))));
    let mut input = preview["prepare_input"].clone(); input["operation_key"] = json!("prepare-stable");
    let prepare = request("creative_tasks.prepare",input);
    let first = execution.request_workspace(&work,prepare.clone()); let prepared = ok(first.clone());
    assert!(prepared["task_locator"].is_object()); assert_eq!(execution.request_workspace(&work,prepare.clone()),first);
    let opened = ok(hub.request(request("collaboration.open",json!({"task_locator":prepared["task_locator"]}))));
    ok(hub.request(request("creative_tasks.get",json!({"task_ref":opened["task_ref"]}))));
    let other = CollaborationHub::open(&directory,"claude-code").unwrap();
    assert_eq!(other.request(request("collaboration.open",json!({"task_locator":prepared["task_locator"]})))["error"]["code"],"forbidden");
    assert!(ok(hub.request(request("collaboration.created_works",json!({}))))["works"].as_array().unwrap().is_empty(),"打开已有工作区和准备任务不冒充新建");
    ok(author.request(request("collaboration.revoke",json!({"task_ref":prepared["task_ref"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"revoke-task"}))));
    ok(execution.request_workspace(&work,prepare));
    assert_eq!(hub.request(request("collaboration.open",json!({"task_locator":prepared["task_locator"]})))["error"]["code"],"forbidden");
}

#[test]
fn confirm_preparation_registers_only_after_the_fixed_plan_executes() {
    let folder = tempfile::tempdir().unwrap(); let (author,work,settings,_) = setup(folder.path()); let directory = folder.path().join("connection");
    let execution = WorkspaceExecution::open(&settings,"codex").unwrap().with_collaboration_directory(&directory);
    let preview = ok(author.request(request("creative_tasks.preview_prompt",json!({"scope_ref":{"kind":"workspace","id":author.scope()},"task_kind":"chapter_draft","brief":"集中计划任务接续","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN"}))));
    let mut input = preview["prepare_input"].clone(); input["operation_key"] = json!("prepare-confirm"); let prepare = request("creative_tasks.prepare",input);
    mode(&settings,"confirm","confirm-mode");
    assert_eq!(execution.request_workspace(&work,prepare.clone())["error"]["code"],"hetu.execution_confirmation_required");
    assert!(!directory.exists());
    let reference = plan(&execution,&work,json!([prepare]),"prepare-plan"); assert!(!directory.exists()); ok(confirm(&execution,&reference));
    let done = ok(execution.request(request("execution.execute",json!({"plan_ref":reference}))));
    let prepared = ok(done["results"][0].clone()); assert!(prepared["task_locator"].is_object());
    let hub = CollaborationHub::open(&directory,"codex").unwrap(); ok(hub.request(request("collaboration.open",json!({"task_locator":prepared["task_locator"]}))));
}

#[test]
fn same_path_with_a_different_workspace_identity_cannot_receive_an_old_plan() {
    let folder = tempfile::tempdir().unwrap(); let (_,work,_,execution) = setup(folder.path());
    let reference = plan(&execution,&work,json!([command("documents.create",json!({"kind":"novel_chapter","title":"旧工作区章节","source_format":"markdown","content":"不能写入替换作品","operation_key":"new"}))]),"fixed");
    std::fs::rename(&work,folder.path().join("original-work")).unwrap();
    let replacement = Kernel::open(json!({"workspace_path":work,"mode":"author","create":{"title":"替换工作区","locale":"zh-CN","operation_key":"create"}})).unwrap();
    let before = replacement.request(command("documents.list",json!({})));
    let result = execution.request(request("execution.execute",json!({"plan_ref":reference})));
    assert_eq!(result["error"]["code"],"revision_conflict","{result}");
    assert_eq!(replacement.request(command("documents.list",json!({}))),before);
    assert!(ok(execution.request(request("execution.get_plan",json!({"plan_ref":reference}))))["results"].as_array().unwrap().is_empty());
}
