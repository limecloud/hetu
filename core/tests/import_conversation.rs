use base64::{Engine, engine::general_purpose::STANDARD};
use hetu_core::{Kernel, collaboration::CollaborationHub};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn ok(value: Value) -> Value {
    assert_eq!(value["status"], "succeeded", "{value}");
    value["data"].clone()
}
fn request(hub: &CollaborationHub, grant: &Value, action: &str, mut input: Value) -> Value {
    input["management_ref"] = grant.clone();
    hub.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn author(kernel: &Kernel, action: &str, input: Value) -> Value {
    kernel.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
struct Fixture {
    _root: tempfile::TempDir,
    author: Kernel,
    hub: CollaborationHub,
    grant: Value,
    volume: Value,
    units: Vec<Value>,
    originals: Vec<String>,
    work: Value,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let kernel = Kernel::open(json!({"workspace_path":root.path().join("作品"),"mode":"author","create":{"title":"会话导入","locale":"zh-CN","operation_key":"init"}})).unwrap();
        let directory = root.path().join("connection");
        let grant = ok(author(&kernel,"collaboration.authorize_workspace",json!({"client_adapter":"codex","collaboration_path":directory,"operation_key":"grant"})))["management_ref"].clone();
        let hub = CollaborationHub::open(&directory, "codex").unwrap();
        let current = ok(request(&hub, &grant, "novels.get", json!({})));
        let volume =
            json!({"volume_id":"volume_11111111-1111-4111-8111-111111111111","title":"原稿"});
        let originals = vec![
            "第1章 渡口\r\n船未离岸。🌧️\r\n".into(),
            "第1章 重号\n原文*保留*。\n".into(),
            "第2章 结尾\n抵达。\n".into(),
        ];
        let mut start = 0;
        let units = originals.iter().enumerate().map(|(index, content): (usize, &String)| {
            let end = start + content.chars().count();
            let unit = json!({"index":index,"start":start,"end":end,"title":content.lines().next().unwrap(),"volume_id":volume["volume_id"],"content_sha256":sha(content.as_bytes())});
            start = end; unit
        }).collect();
        let work = json!({"workspace_id":grant["scope_ref"]["id"],"kind":"novel","object_id":current["novel"]["novel_id"]});
        Self {
            _root: root,
            author: kernel,
            hub,
            grant,
            volume,
            units,
            originals,
            work,
        }
    }
    fn call(&self, action: &str, input: Value) -> Value {
        request(&self.hub, &self.grant, action, input)
    }
    fn expected(&self) -> Value {
        let n = ok(self.call("novels.get", json!({})));
        json!({"revision":n["revision"],"sha256":n["sha256"]})
    }
    fn registration(&self) -> Value {
        let text = self.originals.concat();
        json!({"work_ref":self.work,"expected":self.expected(),"plan":{"source_name":"原稿.txt","source_sha256":sha(text.as_bytes()),"reading_sha256":sha(text.as_bytes()),"reading_characters":text.chars().count(),"language_tag":"zh-CN","volumes":[self.volume],"units":self.units},"authorization_note":"作者在当前会话明确要求将这份原稿全部导入，保留原文与章号。","operation_key":"register"})
    }
    fn register(&self) -> Value {
        ok(self.call("import_authorizations.register",self.registration()))["import_authorization_ref"].clone()
    }
    fn prepare(&self, action: &str, input: Value, key: &str) -> Value {
        ok(self.call("agent_operations.prepare",json!({"action":format!("hetu.{action}"),"input":input,"summary":"固定原稿导入","operation_key":key})))
    }
    fn volumes(&self) -> Value {
        self.prepare("novels.save_structure",json!({"expected":self.expected(),"volumes":[self.volume],"chapters":[],"operation_key":"volumes"}),"prepare-volumes")
    }
    fn batch(&self, indices: &[usize], key: &str, tamper_title: bool) -> Value {
        let items=indices.iter().map(|i|json!({"title":if tamper_title {json!("擅自改名")} else {self.units[*i]["title"].clone()},"language_tag":"zh-CN","volume_id":self.volume["volume_id"],"source":{"inline_source":{"filename":format!("{i}.txt"),"base64":STANDARD.encode(self.originals[*i].as_bytes()),"sha256":self.units[*i]["content_sha256"]},"format":"txt","profile":"source/1"}})).collect::<Vec<_>>();
        self.prepare("documents.import_batch",json!({"expected":self.expected(),"items":items,"acknowledgement":"原稿导入，不采纳不定稿。","operation_key":key}),&format!("prepare-{key}"))
    }
    fn execute(&self, proposal: &Value, reference: Option<&Value>, key: &str) -> Value {
        let mut input = json!({"proposal_id":proposal["proposal_id"],"proposal_sha256":proposal["proposal_sha256"],"operation_key":key});
        if let Some(reference) = reference {
            input["import_authorization_ref"] = reference.clone();
        }
        self.call("agent_operations.execute", input)
    }
    fn progress(&self, reference: &Value) -> Value {
        ok(self.call(
            "import_authorizations.get",
            json!({"import_authorization_ref":reference}),
        ))
    }
}

#[test]
fn conversation_authorization_imports_fixed_ranges_without_an_author_session_and_replays() {
    let f = Fixture::new();
    let volumes = f.volumes();
    assert_eq!(
        f.execute(&volumes, None, "no-approval")["error"]["code"],
        "hetu.author_confirmation_required"
    );
    let registration = f.registration();
    let reference = f.register();
    assert_eq!(
        ok(f.call("import_authorizations.register", registration))["import_authorization_ref"],
        reference
    );
    assert!(
        ok(f.call("novels.get", json!({})))["novel"]["chapters"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    ok(f.execute(&volumes, Some(&reference), "execute-volumes"));
    assert_eq!(f.progress(&reference)["volumes_ready"], true);
    let wrong = f.batch(&[0], "wrong-title", true);
    assert_eq!(
        f.execute(&wrong, Some(&reference), "execute-wrong")["error"]["code"],
        "forbidden"
    );
    let wrong_order = f.batch(&[1], "wrong-order", false);
    assert_eq!(
        f.execute(&wrong_order, Some(&reference), "execute-order")["error"]["code"],
        "forbidden"
    );
    assert_eq!(f.progress(&reference)["next_index"], 0);
    let first = f.batch(&[0, 1], "first", false);
    let receipt = ok(f.execute(&first, Some(&reference), "execute-first"));
    assert_eq!(
        ok(f.execute(&first, Some(&reference), "execute-first")),
        receipt
    );
    assert_eq!(f.progress(&reference)["next_index"], 2);
    let last = f.batch(&[2], "last", false);
    let final_receipt = ok(f.execute(&last, Some(&reference), "execute-last"));
    assert_eq!(f.progress(&reference)["state"], "complete");
    for (record, text) in receipt["result"]["documents"]
        .as_array()
        .unwrap()
        .iter()
        .chain(final_receipt["result"]["documents"].as_array().unwrap())
        .zip(&f.originals)
    {
        let document=ok(f.call("documents.get",json!({"document_id":record["document"]["document_id"],"revision_id":record["revision"]["revision_id"]})));
        assert_eq!(document["revision"]["origin_kind"], "import");
        assert_eq!(
            document["revision"]["import_ref"]["source_sha256"],
            sha(text.as_bytes())
        );
        assert!(document["document"]["finalization_ref"].is_null());
    }
    assert_eq!(
        f.progress(&reference)["fixed"]["confirmation_channel"],
        "agent_conversation"
    );
    assert_ne!(receipt["state"], "approved");
}

#[test]
fn conversation_import_rejects_forgery_revocation_and_changed_baseline() {
    let f = Fixture::new();
    let mut forged = f.registration();
    forged["approved"] = json!(true);
    assert_eq!(
        f.call("import_authorizations.register", forged)["error"]["code"],
        "invalid_input"
    );
    let reference = f.register();
    let volumes = f.volumes();
    ok(f.call(
        "import_authorizations.revoke",
        json!({"import_authorization_ref":reference,"operation_key":"revoke"}),
    ));
    assert_eq!(
        f.execute(&volumes, Some(&reference), "revoked-execute")["error"]["code"],
        "forbidden"
    );
    let f = Fixture::new();
    let reference = f.register();
    let volumes = f.volumes();
    let mut current = ok(f.call("novels.get", json!({})));
    current["novel"]["metadata"]["title"] = json!("作者继续编辑的新书名");
    ok(author(
        &f.author,
        "novels.update",
        json!({"expected":f.expected(),"metadata":current["novel"]["metadata"],"operation_key":"external-change"}),
    ));
    assert_eq!(
        f.execute(&volumes, Some(&reference), "stale-execute")["error"]["code"],
        "revision_conflict"
    );
    assert_eq!(f.progress(&reference)["next_index"], 0);
}

#[test]
fn conversation_import_checks_whole_reading_digest_before_final_batch_commit() {
    let f = Fixture::new();
    let mut registration = f.registration();
    registration["plan"]["reading_sha256"] = json!("0".repeat(64));
    let reference =
        ok(f.call("import_authorizations.register", registration))["import_authorization_ref"]
            .clone();
    ok(f.execute(&f.volumes(), Some(&reference), "volumes"));
    let proposal = f.batch(&[0, 1, 2], "all", false);
    assert_eq!(
        f.execute(&proposal, Some(&reference), "execute-all")["error"]["code"],
        "hetu.integrity_failure"
    );
    assert_eq!(f.progress(&reference)["next_index"], 0);
    assert_eq!(
        ok(f.call("novels.get", json!({})))["novel"]["chapters"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
}
