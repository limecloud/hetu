use super::*;
use std::cell::Cell;

mod approval;
mod authorization;
mod channels;
mod collection;
mod execution;
mod recovery;

struct Fixture {
    root: tempfile::TempDir,
    connection: tempfile::TempDir,
    author: Kernel,
    agent: Kernel,
    task: Value,
}

fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}

fn ok(value: Value) -> Value {
    assert_eq!(value["status"], "succeeded", "{value}");
    value["data"].clone()
}

fn fixture(kind: &str) -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let connection = tempfile::tempdir().unwrap();
    let mut author=Kernel::open(json!({"workspace_path":root.path(),"mode":"author","create":{"title":"雾港","locale":"zh-CN","operation_key":"init"}})).unwrap();
    ModelService::open(connection.path()).unwrap();
    std::fs::write(connection.path().join("connection.json"),serde_json::to_vec(&json!({"origin":"https://hetu.limeai.run","token":"private-test-token","account_ref":"a".repeat(64),"environment":"sandbox","defaults":{"text":"text-one","image":"image-one"}})).unwrap()).unwrap();
    author.model_service_directory = Some(connection.path().to_owned());
    let preview = ok(call(
        &author,
        "creative_tasks.preview_prompt",
        json!({"scope_ref":{"kind":"workspace","id":author.scope()},"task_kind":kind,"brief":"仅处理当前固定任务。","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN","candidate_limit":2}),
    ));
    let mut input = preview["prepare_input"].clone();
    input["operation_key"] = json!("prepare");
    let task = ok(call(&author, "creative_tasks.prepare", input));
    let mut agent = Kernel::open(
        json!({"workspace_path":root.path(),"mode":"agent","task_id":task["task_ref"]["task_id"]}),
    )
    .unwrap();
    agent.model_service_directory = Some(connection.path().to_owned());
    Fixture {
        root,
        connection,
        author,
        agent,
        task,
    }
}

fn prepare(f: &Fixture, kind: &str) -> Value {
    ok(call(
        &f.agent,
        "model_tasks.prepare",
        json!({"task_ref":f.task["task_ref"],"kind":kind,"artifact_kind":if kind=="text" {"text"} else {"image"},"model_id":format!("{kind}-one"),"prompt":"这是获权内容。","title":"候选方案","billing_policy_version":"p1","estimated_credits":"12","operation_key":"model-prepare"}),
    ))
}

fn approve(f: &Fixture, record: &Value) -> Value {
    ok(call(
        &f.author,
        "model_tasks.approve",
        json!({"task_ref":f.task["task_ref"],"plan_id":record["plan"]["plan_id"],"plan_sha256":record["plan_sha256"],"max_credits":"12","operation_key":"approve"}),
    ))
}

fn input(f: &Fixture, r: &Value) -> Value {
    json!({"task_ref":f.task["task_ref"],"plan_id":r["plan"]["plan_id"],"operation_key":"execute"})
}

fn remote(r: &Value, output: Value) -> Value {
    json!({"operation_key":r["plan"]["plan_id"],"kind":r["plan"]["kind"],"operation":{"id":"generation-1","model_id":r["plan"]["payload"]["model_id"],"status":"succeeded","output":output}})
}

fn conversation_fixture() -> Fixture {
    let mut f = fixture("chapter_draft");
    let directory = f.connection.path().join("collaboration");
    let grant = ok(call(
        &f.author,
        "collaboration.authorize",
        json!({"task_ref":f.task["task_ref"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"grant"}),
    ));
    f.agent.collaboration_grant = Some(
        json!({"directory":directory,"client_adapter":"codex","task_locator":grant["task_locator"],"grant_revision":grant["grant_revision"]}),
    );
    f
}

fn usage(f: &Fixture, record: &Value, key: &str, max_requests: u64) -> Value {
    ok(call(
        &f.agent,
        "model_tasks.authorize_usage",
        json!({"task_ref":f.task["task_ref"],"plan_id":record["plan"]["plan_id"],"authorization":{"operation_key":key,"channels":"current","max_requests":max_requests,"max_credits":(max_requests*12).to_string()},"authorization_note":"作者在当前测试对话中明确授权此额度。","operation_key":format!("register-{key}")}),
    ))
}

fn resume_input(f: &Fixture, record: &Value, key: &str) -> Value {
    json!({"task_ref":f.task["task_ref"],"kind":"text","artifact_kind":"text","model_id":"text-one","prompt":"这是获权内容。","title":"候选方案","billing_policy_version":"p1","estimated_credits":"12","resume_from_plan_id":record["plan"]["plan_id"],"operation_key":key})
}
