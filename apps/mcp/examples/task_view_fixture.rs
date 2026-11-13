//! 浏览器集成测试的作者侧夹具，只对测试提供的临时目录创建内容。
use hetu_core::Kernel;
use serde_json::{Value, json};

fn call(kernel: &Kernel, action: &str, input: Value) -> Value {
    let result = kernel
        .request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}));
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}

fn main() {
    let path = std::path::PathBuf::from(std::env::args_os()
        .nth(1)
        .expect("isolated fixture directory"));
    let kernel = Kernel::open(json!({"workspace_path":path,"mode":"author","create":{"title":"测试书库中的独立小说","locale":"zh-CN","operation_key":"fixture-book"}})).unwrap();
    let preview = call(
        &kernel,
        "creative_tasks.preview_prompt",
        json!({"scope_ref":{"kind":kernel.scope_kind(),"id":kernel.scope()},"task_kind":"book_concept","brief":"为一部河港悬疑故事提供两个书名参考。","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN"}),
    );
    let mut prepared = preview["prepare_input"].clone();
    prepared["operation_key"] = json!("fixture-prepare");
    let task = call(&kernel, "creative_tasks.prepare", prepared);
    call(
        &kernel,
        "creative_tasks.submit_result",
        json!({"task_ref":task["task_ref"],"request_sha256":task["request_sha256"],"candidates":[{"kind":"title","title":"方案一","source_format":"plain","source_ref_indices":[],"content":"雾港听潮"},{"kind":"title","title":"方案二","source_format":"plain","source_ref_indices":[],"content":"灯塔旧事"}],"complete":true,"missing_items":[],"provenance":{"client":"browser-contract-fixture","skill_version":"1"},"operation_key":"fixture-result"}),
    );
    println!("{}", json!({"task_ref":task["task_ref"]}));
}
