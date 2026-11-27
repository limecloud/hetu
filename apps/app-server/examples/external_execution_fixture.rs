//! 只准备隔离作者样本；后续验证经公开CLI/MCP以真实Agent身份执行。
use hetu_core::Kernel;
use serde_json::{Value, json};

fn call(kernel: &Kernel, action: &str, input: Value) -> Value {
    let result = kernel.request(json!({"action":action,"contract_revision":"1","input":input}));
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    assert_eq!(arguments.len(), 2);
    let kernel=Kernel::open(json!({"workspace_path":arguments[0],"mode":"author","create":{"title":"外部执行隔离小说","locale":"zh-CN","operation_key":"fixture-create"}})).unwrap();
    let work = call(&kernel, "hetu.works.list", json!({}))["works"][0]["work_ref"].clone();
    let document = call(
        &kernel,
        "hetu.documents.create",
        json!({"kind":"novel_chapter","title":"第一章 灯塔","source_format":"markdown","content":"隔离样本：灯塔亮了。🌿","operation_key":"fixture-document"}),
    );
    let connection = call(
        &kernel,
        "hetu.collaboration.authorize_workspace",
        json!({"client_adapter":"generic","collaboration_path":arguments[1],"work_ref":work,"operation_key":"fixture-connect"}),
    );
    println!(
        "{}",
        json!({"work_ref":work,"document":document["document"],"connection":connection})
    );
}
