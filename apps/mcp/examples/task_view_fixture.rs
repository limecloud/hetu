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
    let source = call(&kernel, "documents.create", json!({"kind":"novel_chapter","title":"书名参考原文","source_format":"markdown","content":"雾港的灯塔在潮水中沉默。🌿","operation_key":"fixture-source"}));
    let initial = call(&kernel, "blueprints.get", json!({}));
    let characters = (0..12).map(|index| json!({"type":"upsert_character","entity":{
        "character_id":format!("character_{index:08x}-1111-4111-8111-111111111111"),"name":format!("雾港人物{index}"),
        "aliases":[],"description":"守护旧灯塔的人。".repeat(100),"traits":[],"facts":[],"archived":false
    }})).collect::<Vec<_>>();
    let bible = call(&kernel, "blueprints.save", json!({"expected":{"revision":initial["revision"],"sha256":initial["sha256"]},"typed_changes":characters,"operation_key":"fixture-bible"}));
    let preview = call(
        &kernel,
        "creative_tasks.preview_prompt",
        json!({"scope_ref":{"kind":kernel.scope_kind(),"id":kernel.scope()},"task_kind":"book_concept","brief":"为一部河港悬疑故事提供两个书名参考。","input_refs":[{"kind":"document","document_id":source["document"]["document_id"],"revision_id":source["revision"]["revision_id"]},{"kind":"blueprint","revision":bible["revision"]}],"client_adapter":"codex","language_tag":"zh-CN"}),
    );
    let mut prepared = preview["prepare_input"].clone();
    prepared["operation_key"] = json!("fixture-prepare");
    let task = call(&kernel, "creative_tasks.prepare", prepared);
    call(
        &kernel,
        "creative_tasks.submit_result",
        json!({"task_ref":task["task_ref"],"request_sha256":task["request_sha256"],"candidates":[{"kind":"title","title":"方案一","source_format":"plain","source_ref_indices":[],"content":"雾港听潮"},{"kind":"title","title":"方案二","source_format":"plain","source_ref_indices":[],"content":"灯塔旧事"}],"complete":true,"missing_items":[],"provenance":{"client":"browser-contract-fixture","skill_version":"1"},"operation_key":"fixture-result"}),
    );
    let mut output = json!({"task_ref":task["task_ref"]});
    if let Some(directory) = std::env::args_os().nth(2) {
        let directory = std::path::PathBuf::from(directory);
        let grant = call(&kernel, "collaboration.authorize_workspace", json!({"client_adapter":"codex","collaboration_path":directory,"operation_key":"fixture-management"}));
        let hub = hetu_core::collaboration::CollaborationHub::open(&directory, "codex").unwrap();
        let novel = call(&kernel,"novels.get",json!({}));
        let proposal = hub.request(json!({"action":"hetu.agent_operations.prepare","contract_revision":"1","input":{"management_ref":grant["management_ref"],"action":"hetu.novels.update","input":{"expected":{"revision":novel["revision"],"sha256":novel["sha256"]},"metadata":{"title":"雾港听潮","author_name":"测试作者","synopsis":"待作者审核的作品资料。","genre":"悬疑","language_tag":"zh-CN","status":"planning"},"operation_key":"fixture-profile"},"summary":"整理作品资料，等待作者确认","operation_key":"fixture-proposal"}}));
        assert_eq!(proposal["status"], "succeeded", "{proposal}");
        output["management_ref"] = grant["management_ref"].clone();
        output["proposal_id"] = proposal["data"]["proposal_id"].clone();
    }
    println!("{output}");
}
