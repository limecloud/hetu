//! 跨领域会话操作：固定结果、真实用户决定、Agent执行、无桌面及越权拒绝。
use hetu_core::{Kernel, collaboration::CollaborationHub};
use serde_json::{Value, json};
fn ok(v: Value) -> Value {
    assert_eq!(v["status"], "succeeded", "{v}");
    v["data"].clone()
}
struct Session {
    _root: tempfile::TempDir,
    hub: CollaborationHub,
    grant: Value,
    work: Value,
    author: Kernel,
}
impl Session {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let author=Kernel::open(json!({"workspace_path":root.path().join("work"),"mode":"author","create":{"title":"会话操作","locale":"zh-CN","operation_key":"init"}})).unwrap();
        let current =
            ok(author
                .request(json!({"action":"hetu.novels.get","contract_revision":"1","input":{}})));
        let work = json!({"workspace_id":author.scope(),"kind":"novel","object_id":current["novel"]["novel_id"]});
        let directory = root.path().join("connection");
        let grant=ok(author.request(json!({"action":"hetu.collaboration.authorize_workspace","contract_revision":"1","input":{"client_adapter":"codex","collaboration_path":directory,"work_ref":work,"operation_key":"grant"}})))["management_ref"].clone();
        let hub = CollaborationHub::open(&directory, "codex").unwrap();
        Self {
            _root: root,
            hub,
            grant,
            work,
            author,
        }
    }
    fn call(&self, action: &str, mut input: Value) -> Value {
        input["management_ref"] = self.grant.clone();
        self.hub.request(
            json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}),
        )
    }
    fn prepare(&self, action: &str, input: Value, key: &str) -> Value {
        ok(self.call("agent_operations.prepare",json!({"action":format!("hetu.{action}"),"input":input,"summary":"当前会话的固定操作","operation_key":format!("prepare-{key}")})))
    }
    fn decision(&self, p: &Value, key: &str) -> Value {
        json!({"proposal_id":p["proposal_id"],"proposal_sha256":p["proposal_sha256"],"expected_state_revision":p["state_revision"],"decision":"approve","authorization_note":"测试用户在当前会话明确要求执行已展示的确切方案。","operation_key":format!("decide-{key}")})
    }
    fn execute(&self, p: &Value, key: &str) -> Value {
        self.call("agent_operations.execute",json!({"proposal_id":p["proposal_id"],"proposal_sha256":p["proposal_sha256"],"operation_key":format!("execute-{key}")}))
    }
    fn apply(&self, action: &str, input: Value, key: &str) -> Value {
        let p = self.prepare(action, input, key);
        assert_eq!(
            self.execute(&p, key)["error"]["code"],
            "hetu.author_confirmation_required"
        );
        let decision = self.decision(&p, key);
        let receipt = self.call("agent_operations.record_decision", decision.clone());
        ok(receipt.clone());
        assert_eq!(
            receipt,
            self.call("agent_operations.record_decision", decision)
        );
        let applied = self.execute(&p, key);
        let result = ok(applied.clone());
        assert_eq!(applied, self.execute(&p, key));
        assert_eq!(
            result["conversation_decision"]["confirmation_channel"],
            "agent_conversation"
        );
        result["result"].clone()
    }
}
#[test]
fn metadata_structure_text_validation_and_finalization_run_without_gui() {
    let s = Session::new();
    let catalog = ok(s.call(
        "agent_operations.catalog",
        json!({"limit":50,"include_schema":true}),
    ));
    for action in [
        "hetu.novels.update",
        "hetu.documents.save",
        "hetu.drafts.adopt",
        "hetu.documents.finalize",
        "hetu.blueprints.unlock",
        "hetu.documents.export",
    ] {
        assert!(
            catalog["actions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a["name"] == action)
        );
    }
    let current = ok(s.call("novels.get", json!({})));
    let mut metadata = current["novel"]["metadata"].clone();
    metadata["synopsis"] = json!("会话中更新的简介。");
    let result=s.apply("novels.update",json!({"expected":{"revision":current["revision"],"sha256":current["sha256"]},"metadata":metadata,"operation_key":"metadata"}),"metadata");
    assert_eq!(result["novel"]["metadata"], metadata);
    let document=s.apply("documents.create",json!({"kind":"novel_chapter","title":"第一章","source_format":"markdown","content":"","operation_key":"document"}),"document");
    let document=s.apply("documents.save",json!({"document_id":document["document"]["document_id"],"base_revision_id":document["revision"]["revision_id"],"source_format":"markdown","content":"雨落在河面。🌿","operation_key":"save"}),"save");
    assert!(
        document["revision"]["actor_ref"]
            .as_str()
            .unwrap()
            .ends_with("000002")
    );
    let reference = json!({"document_id":document["document"]["document_id"],"revision_id":document["revision"]["revision_id"],"sha256":document["revision"]["sha256"]});
    let validated=s.apply("documents.validate",json!({"document_ref":reference,"plot_options":{},"validation_options":{},"operation_key":"validate"}),"validate");
    let preview=ok(s.call("documents.preview_finalization",json!({"document_ref":reference,"expected_finalization_ref":null,"report_refs":[validated["reference"]],"comments":"用户明确决定此版本定稿。","coverage_acknowledgement":"测试用户确认覆盖范围。"})))["preview"].clone();
    assert_eq!(preview["eligible"], true, "{preview}");
    let finalized = s.apply(
        "documents.finalize",
        json!({"preview":preview,"operation_key":"finalize"}),
        "finalize",
    );
    assert_eq!(
        finalized["document"]["approved_revision_id"],
        reference["revision_id"]
    );
    let lifecycle = ok(s.call(
        "documents.lifecycle",
        json!({"document_id":reference["document_id"]}),
    ));
    assert_eq!(lifecycle["finalizations"].as_array().unwrap().len(), 1);
}
#[test]
fn decisions_require_exact_binding_revision_input_and_do_not_modify_domain_state() {
    let s = Session::new();
    let current = ok(s.call("novels.get", json!({})));
    let mut metadata = current["novel"]["metadata"].clone();
    metadata["title"] = json!("新书名");
    let p=s.prepare("novels.update",json!({"expected":{"revision":current["revision"],"sha256":current["sha256"]},"metadata":metadata,"operation_key":"change"}),"change");
    let mut d = s.decision(&p, "change");
    d["proposal_sha256"] = json!("0".repeat(64));
    assert_eq!(
        s.call("agent_operations.record_decision", d)["error"]["code"],
        "hetu.stale_evidence"
    );
    let mut d = s.decision(&p, "change");
    d["authorization_note"] = json!("   ");
    assert_eq!(
        s.call("agent_operations.record_decision", d)["error"]["code"],
        "forbidden"
    );
    ok(s.call("agent_operations.record_decision", s.decision(&p, "change")));
    assert_eq!(ok(s.call("novels.get", json!({}))), current);
    let directory = s._root.path().join("connection");
    let other=ok(s.author.request(json!({"action":"hetu.collaboration.authorize_workspace","contract_revision":"1","input":{"client_adapter":"claude-code","collaboration_path":directory,"work_ref":s.work,"operation_key":"other"}})))["management_ref"].clone();
    let hub = CollaborationHub::open(&directory, "claude-code").unwrap();
    let mut input = s.decision(&p, "other");
    input["management_ref"] = other;
    assert_eq!(hub.request(json!({"action":"hetu.agent_operations.record_decision","contract_revision":"1","input":input}))["error"]["code"],"forbidden");
    let mut stale = s.decision(&p, "stale");
    stale["expected_state_revision"] = json!(999);
    assert_eq!(
        s.call("agent_operations.record_decision", stale)["error"]["code"],
        "revision_conflict"
    );
}
