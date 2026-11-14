use hetu_core::Kernel;
use serde_json::{Value, json};

fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(value: Value) -> Value { assert_eq!(value["status"], "succeeded", "{value}"); value["data"].clone() }
fn setup() -> (tempfile::TempDir, Kernel, Value) {
    let dir = tempfile::tempdir().unwrap();
    let k = Kernel::open(json!({"workspace_path":dir.path(),"mode":"author","create":{"title":"长河","locale":"zh-CN","operation_key":"create"}})).unwrap();
    let doc = ok(call(&k,"documents.create",json!({"kind":"novel_chapter","title":"第一章","source_format":"markdown","content":"雾港🌿\r\n第二段","operation_key":"chapter"})));
    (dir,k,doc)
}

#[test]
fn annotations_preserve_source_and_reject_stale_writes_and_invalid_unicode() {
    let (dir,k,doc) = setup();
    let id = &doc["document"]["document_id"];
    let before = ok(call(&k,"documents.get",json!({"document_id":id})));
    let empty = ok(call(&k,"annotations.list",json!({"document_id":id})));
    let note = json!({"id":"note_00000000-0000-4000-8000-000000000001","text":"保留作者用词","resolved":false,"source_ref":{"document_id":id,"revision_id":doc["revision"]["revision_id"],"byte_start":6,"byte_end":10,"quote":"🌿"}});
    let input = json!({"document_id":id,"expected":{"revision":empty["revision"],"sha256":empty["sha256"]},"items":[note],"operation_key":"notes"});
    let saved = ok(call(&k,"annotations.save",input.clone()));
    assert_eq!(ok(call(&k,"annotations.save",input.clone())),saved);
    let mut stale=input.clone(); stale["operation_key"]=json!("stale");
    assert_eq!(call(&k,"annotations.save",stale)["error"]["code"],"revision_conflict");
    let mut invalid=input.clone(); invalid["expected"]=json!({"revision":saved["revision"],"sha256":saved["sha256"]}); invalid["operation_key"]=json!("invalid"); invalid["items"][0]["source_ref"]["byte_start"]=json!(7);
    assert_eq!(call(&k,"annotations.save",invalid)["error"]["code"],"hetu.invalid_source_ref");
    assert_eq!(ok(call(&k,"documents.get",json!({"document_id":id}))),before);
    let agent = Kernel::open(json!({"workspace_path":dir.path(),"mode":"agent"})).unwrap();
    assert_eq!(call(&agent,"annotations.list",json!({"document_id":id}))["error"]["code"],"forbidden");
}

#[test]
fn outlines_check_book_ownership_and_history_retains_exact_text() {
    let (_dir,k,doc)=setup();
    let id=&doc["document"]["document_id"];
    let entry=json!({"id":"outline_00000000-0000-4000-8000-000000000001","title":"章纲","text":"以渡口冲突开场","level":"chapter","target_id":id});
    let saved=ok(call(&k,"outlines.save",json!({"expected":{"revision":0,"sha256":null},"items":[entry],"operation_key":"outline"})));
    let mut invalid=entry.clone();invalid["target_id"]=json!("doc_00000000-0000-4000-8000-000000000099");
    assert_eq!(call(&k,"outlines.save",json!({"expected":{"revision":saved["revision"],"sha256":saved["sha256"]},"items":[invalid],"operation_key":"other"}))["error"]["code"],"invalid_input");
    ok(call(&k,"documents.save",json!({"document_id":id,"base_revision_id":doc["revision"]["revision_id"],"source_format":"markdown","content":"手工改写","operation_key":"edit"})));
    let history=ok(call(&k,"documents.history",json!({"document_id":id})));
    assert_eq!(history["revisions"].as_array().unwrap().len(),2);
    let old=ok(call(&k,"documents.get",json!({"document_id":id,"revision_id":doc["revision"]["revision_id"]})));
    assert_eq!(old["content"],"雾港🌿\r\n第二段");
}
