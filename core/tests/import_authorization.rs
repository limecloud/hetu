use base64::{Engine, engine::general_purpose::STANDARD};
use hetu_core::{Kernel, collaboration::CollaborationHub};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn call(kernel: &Kernel, action: &str, input: Value) -> Value {
    kernel.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(result: Value) -> Value {
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn source(filename: &str, content: &[u8]) -> Value {
    json!({"filename":filename,"base64":STANDARD.encode(content),"sha256":format!("{:x}",Sha256::digest(content))})
}
fn setup() -> (tempfile::TempDir, Kernel, CollaborationHub, Value) {
    let root = tempfile::tempdir().unwrap();
    let author = Kernel::open(json!({"workspace_path":root.path().join("作品"),"mode":"author","create":{"title":"渡口","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let directory = root.path().join("授权");
    let hub = CollaborationHub::open(&directory,"codex").unwrap();
    let grant = ok(call(&author,"collaboration.authorize_workspace",json!({"client_adapter":"codex","collaboration_path":directory,"operation_key":"grant"})));
    (root,author,hub,grant["management_ref"].clone())
}
fn bound(hub: &CollaborationHub, reference: &Value, action: &str, mut input: Value) -> Value {
    input["management_ref"] = reference.clone();
    hub.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn approve(author: &Kernel, proposal: &Value) {
    ok(call(author,"agent_operations.decide",json!({"proposal_id":proposal["proposal_id"],"proposal_sha256":proposal["proposal_sha256"],"expected_state_revision":proposal["state_revision"],"decision":"approve","operation_key":format!("approve-{}",proposal["proposal_id"])})));
}

#[test]
fn management_cannot_read_local_paths_but_inline_document_is_reviewed_fixed_and_replayable() {
    let (root,author,hub,reference) = setup();
    let private = root.path().join("私密配置.txt");
    std::fs::write(&private,"private-sentinel-do-not-return").unwrap();
    for (action,input) in [
        ("documents.preview_import",json!({"file_path":private,"format":"txt","profile":"source/1"})),
        ("assets.inspect",json!({"file_path":private})),
    ] {
        let result = bound(&hub,&reference,action,input);
        assert_eq!(result["error"]["code"],"forbidden","{result}");
        assert!(!result.to_string().contains("private-sentinel"));
    }
    let author_preview = ok(call(&author,"documents.preview_import",json!({"file_path":private,"format":"txt","profile":"source/1"})))["preview"].clone();
    let input = json!({"action":"hetu.documents.import","input":{"preview":author_preview,"kind":"novel_chapter","title":"原稿","language_tag":"zh-CN","acknowledgement":"核对原稿","operation_key":"import"},"summary":"导入原稿","operation_key":"path-proposal"});
    assert_eq!(bound(&hub,&reference,"agent_operations.prepare",input)["error"]["code"],"forbidden");

    let original = "第一章 渡口\r\n\r\n船工没有回头。🌧️\r\n".as_bytes();
    let preview = ok(bound(&hub,&reference,"documents.preview_import",json!({"inline_source":source("原稿.txt",original),"format":"txt","profile":"hetu-novel-zh/1"})))["preview"].clone();
    let proposal = ok(bound(&hub,&reference,"agent_operations.prepare",json!({"action":"hetu.documents.import","input":{"preview":preview,"kind":"novel_chapter","title":"渡口","language_tag":"zh-CN","acknowledgement":"核对原稿与格式损失","operation_key":"import-inline"},"summary":"导入已核对的原稿","operation_key":"prepare-inline"})));
    let execute = json!({"proposal_id":proposal["proposal_id"],"proposal_sha256":proposal["proposal_sha256"],"operation_key":"execute-inline"});
    assert_eq!(bound(&hub,&reference,"agent_operations.execute",execute.clone())["error"]["code"],"hetu.author_confirmation_required");
    approve(&author,&proposal);
    let receipt = ok(bound(&hub,&reference,"agent_operations.execute",execute.clone()));
    assert_eq!(ok(bound(&hub,&reference,"agent_operations.execute",execute)),receipt);
    let id = receipt["result"]["document"]["document_id"].as_str().unwrap();
    assert_eq!(std::fs::read(root.path().join(format!("作品/.hetu/imports/{id}/original"))).unwrap(),original);
    let document = ok(bound(&hub,&reference,"documents.get",json!({"document_id":id})));
    assert!(document["content"].as_str().unwrap().contains("船工没有回头"));
    assert!(document["document"]["finalization_ref"].is_null());
}

#[test]
fn inline_media_checks_digest_budget_name_and_preserves_bytes_after_approval() {
    let (root,author,hub,reference) = setup();
    let content = b"\x89PNG\r\n\x1a\nimage-signature-fixture";
    let inline = source("场景 参考.png",content);
    let mut bad = inline.clone(); bad["sha256"] = json!("0".repeat(64));
    assert_eq!(bound(&hub,&reference,"assets.inspect",json!({"inline_source":bad}))["error"]["code"],"hetu.integrity_failure");
    let mut bad = inline.clone(); bad["filename"] = json!("../私密.png");
    assert_eq!(bound(&hub,&reference,"assets.inspect",json!({"inline_source":bad}))["error"]["code"],"invalid_input");
    let mut bad = inline.clone(); bad["base64"] = json!("A".repeat(11184812));
    assert_eq!(bound(&hub,&reference,"assets.inspect",json!({"inline_source":bad}))["error"]["code"],"hetu.budget_exceeded");
    assert_eq!(bound(&hub,&reference,"assets.inspect",json!({"inline_source":inline,"file_path":"/private/file.png"}))["error"]["code"],"invalid_input");
    let inspection = ok(bound(&hub,&reference,"assets.inspect",json!({"inline_source":inline})));
    let input = json!({"inline_source":inline,"expected_file":{"sha256":inspection["sha256"],"size_bytes":inspection["size_bytes"]},"title":"渡口参考","source":{"source_type":"author_supplied","creator_statement":"隔离测试文件"},"rights_status":"unknown","redistribution_allowed":false,"rights_statement":"","operation_key":"media-import"});
    let proposal = ok(bound(&hub,&reference,"agent_operations.prepare",json!({"action":"hetu.assets.import","input":input,"summary":"导入场景参考","operation_key":"prepare-media"})));
    assert!(proposal["preview"]["metadata"].get("inline_source").is_none());
    approve(&author,&proposal);
    let execute = json!({"proposal_id":proposal["proposal_id"],"proposal_sha256":proposal["proposal_sha256"],"operation_key":"execute-media"});
    let receipt = ok(bound(&hub,&reference,"agent_operations.execute",execute.clone()));
    assert_eq!(ok(bound(&hub,&reference,"agent_operations.execute",execute)),receipt);
    let asset = &receipt["result"]["asset"];
    assert_eq!(asset["original_filename"],"场景 参考.png");
    assert_eq!(std::fs::read(root.path().join("作品").join(asset["blob"]["path"].as_str().unwrap())).unwrap(),content);
    assert_eq!(asset["blob"]["validation"],"signature_only");
    assert_eq!(ok(bound(&hub,&reference,"assets.get",json!({"asset_id":asset["asset_id"]})))["media_verified"],true);
}

#[test]
fn batch_import_commits_every_chapter_and_one_directory_revision_with_fixed_provenance() {
    let (root, author, hub, reference) = setup();
    let before = ok(bound(&hub, &reference, "novels.get", json!({})));
    let originals = ["第1章 渡口\r\n\r\n船未离岸。🌧️\r\n", "第1章 重号应保留\n\n次卷原稿，不按标题合并。\n"];
    let items = originals.iter().enumerate().map(|(n, text)| {
        let preview = ok(bound(&hub,&reference,"documents.preview_import",json!({"inline_source":source(&format!("{n}.txt"),text.as_bytes()),"format":"txt","profile":"source/1"})))["preview"].clone();
        json!({"source":preview["request"],"title":format!("第1章 片段{n}"),"language_tag":"zh-CN","volume_id":null})
    }).collect::<Vec<_>>();
    let request = json!({"action":"hetu.documents.import_batch","input":{"expected":{"revision":before["revision"],"sha256":before["sha256"]},"items":items,"acknowledgement":"保留原稿和重复章号，不作为定稿","operation_key":"batch"},"summary":"导入两章固定原稿","operation_key":"prepare-batch"});
    let proposal = ok(bound(&hub,&reference,"agent_operations.prepare",request.clone()));
    assert_eq!(ok(bound(&hub,&reference,"novels.get",json!({}))),before);
    let execute=json!({"proposal_id":proposal["proposal_id"],"proposal_sha256":proposal["proposal_sha256"],"operation_key":"execute-batch"});
    assert_eq!(bound(&hub,&reference,"agent_operations.execute",execute.clone())["error"]["code"],"hetu.author_confirmation_required");
    approve(&author,&proposal);
    let receipt=ok(bound(&hub,&reference,"agent_operations.execute",execute.clone()));
    assert_eq!(ok(bound(&hub,&reference,"agent_operations.execute",execute)),receipt);
    assert_eq!(ok(bound(&hub,&reference,"agent_operations.prepare",request))["proposal_id"],proposal["proposal_id"]);
    let result=&receipt["result"];
    assert_eq!(result["documents"].as_array().unwrap().len(),2);
    assert_eq!(result["novel"]["chapters"].as_array().unwrap().len(),2);
    assert_eq!(result["revision"],before["revision"].as_u64().unwrap()+1);
    for (n,item) in result["documents"].as_array().unwrap().iter().enumerate() {
        let doc=ok(bound(&hub,&reference,"documents.get",json!({"document_id":item["document"]["document_id"]})));
        assert_eq!(doc["content"],originals[n]);
        assert!(doc["document"]["finalization_ref"].is_null());
        assert_eq!(doc["revision"]["origin_kind"],"import");
        assert_eq!(std::fs::read(root.path().join(format!("作品/.hetu/imports/{}/original",item["document"]["document_id"].as_str().unwrap()))).unwrap(),originals[n].as_bytes());
    }
}

#[test]
fn batch_import_rejects_bad_member_paths_and_stale_directory_without_partial_chapters() {
    let (_root, author, hub, reference)=setup();
    let before=ok(bound(&hub,&reference,"novels.get",json!({})));
    let preview=ok(bound(&hub,&reference,"documents.preview_import",json!({"inline_source":source("原稿.txt",b"chapter"),"format":"txt","profile":"source/1"})))["preview"].clone();
    let item=json!({"source":preview["request"],"title":"第一章","language_tag":"zh-CN","volume_id":null});
    let input=json!({"expected":{"revision":before["revision"],"sha256":before["sha256"]},"items":[item.clone(),item.clone()],"acknowledgement":"固定章节","operation_key":"batch"});
    let prepare=|input:Value,key:&str|bound(&hub,&reference,"agent_operations.prepare",json!({"action":"hetu.documents.import_batch","input":input,"summary":"批量导入","operation_key":key}));
    let mut bad=input.clone();bad["items"][1]["source"]["inline_source"]["sha256"]=json!("0".repeat(64));
    assert_eq!(prepare(bad,"bad-preview")["error"]["code"],"hetu.integrity_failure");
    let mut bad=input.clone();bad["items"][1]["source"]=json!({"file_path":"/private/file.txt","format":"txt","profile":"source/1"});
    assert_eq!(prepare(bad,"bad-path")["error"]["code"],"forbidden");
    let mut bad=input.clone();bad["items"]=json!(vec![item;33]);
    assert_eq!(prepare(bad,"over-count")["error"]["code"],"invalid_input");
    assert!(ok(bound(&hub,&reference,"documents.list",json!({})))["documents"].as_array().unwrap().is_empty());
    let proposal=ok(prepare(input,"valid"));
    approve(&author,&proposal);
    let mut metadata=before["novel"]["metadata"].clone();metadata["synopsis"]=json!("作者已有更新");
    ok(call(&author,"novels.update",json!({"expected":{"revision":before["revision"],"sha256":before["sha256"]},"metadata":metadata,"operation_key":"author-change"})));
    assert_eq!(bound(&hub,&reference,"agent_operations.execute",json!({"proposal_id":proposal["proposal_id"],"proposal_sha256":proposal["proposal_sha256"],"operation_key":"stale"}))["error"]["code"],"revision_conflict");
    assert!(ok(bound(&hub,&reference,"documents.list",json!({})))["documents"].as_array().unwrap().is_empty());
}
