use hetu_core::Kernel;
use serde_json::{Value,json};

fn call(k:&Kernel, action:&str, input:Value)->Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":if action=="reviews.decide" {"2"} else {"1"},"input":input}))
}
fn data(value:Value)->Value {
    assert!(matches!(value["status"].as_str(),Some("succeeded"|"partial")),"{value}"); value["data"].clone()
}
fn setup()->(tempfile::TempDir,Kernel) {
    let root=tempfile::tempdir().unwrap();
    let k=Kernel::open(json!({"workspace_path":root.path(),"mode":"author","create":{"title":"独立定稿","locale":"zh-CN","operation_key":"init"}})).unwrap(); (root,k)
}
fn document(k:&Kernel, content:&str)->Value {
    data(call(k,"documents.create",json!({"kind":"novel_chapter","title":"雾港","source_format":"markdown","content":content,"operation_key":"doc"})))
}
fn reference(value:&Value)->Value {
    json!({"document_id":value["document"]["document_id"],"revision_id":value["revision"]["revision_id"],"sha256":value["revision"]["sha256"]})
}
fn prepare_final(k:&Kernel,value:&Value,key:&str)->Value {
    let validated=data(call(k,"documents.validate",json!({"document_ref":reference(value),"plot_options":{},"validation_options":{},"operation_key":format!("check-{key}")})));
    data(call(k,"documents.preview_finalization",json!({"document_ref":reference(value),"expected_finalization_ref":value["document"]["finalization_ref"],"report_refs":[validated["reference"]],"comments":"作者确认此修订。","coverage_acknowledgement":"已人工核对未知人物、语境与覆盖范围。"})))["preview"].clone()
}
fn finalize(k:&Kernel,value:&Value,key:&str)->Value {
    let preview=prepare_final(k,value,key); assert_eq!(preview["eligible"],true,"{preview}");
    data(call(k,"documents.finalize",json!({"preview":preview,"operation_key":key})))
}
fn submit(k:&Kernel,content:&str)->Value {
    data(call(k,"drafts.submit",json!({"package":"novel","source_format":"markdown","title":"参考稿","content":content,"blueprint_revision":1,"operation_key":"draft"})))["draft"].clone()
}
fn range(text:&str,start:usize,end:usize)->Value {json!({"byte_start":start,"byte_end":end,"quote":&text[start..end]})}
fn adoption(k:&Kernel,draft:&Value,target:&Value,source:&str)->Value {
    data(call(k,"drafts.preview_adoption",json!({"draft_ref":{"draft_id":draft["draft_id"],"revision":draft["revision"],"sha256":draft["content_sha256"]},"target_ref":reference(target),"new_document":null,"selected_ranges":[{"source":range(source,0,source.len()),"target":range(target["content"].as_str().unwrap(),0,target["content"].as_str().unwrap().len())}]})))["preview"].clone()
}

#[test]
fn manual_finalization_edit_adoption_new_final_and_withdrawal_are_independent() {
    let (root,k)=setup(); let first=document(&k,"# 手工稿\r\n林舟推开门。🌿\r\n");
    let approved=finalize(&k,&first,"final-first");
    assert_eq!(approved["document"]["approved_revision_id"],first["revision"]["revision_id"]);
    assert!(data(call(&k,"drafts.list",json!({})))["drafts"].as_array().unwrap().is_empty());
    let source="# 参考稿\r\n林舟关上门。🌿\r\n"; let draft=submit(&k,source);
    let current=data(call(&k,"documents.get",json!({"document_id":first["document"]["document_id"]})));
    let preview=adoption(&k,&draft,&current,source);
    let input=json!({"preview":preview,"operation_key":"adopt"}); let committed=call(&k,"drafts.adopt",input.clone());
    let adopted=data(committed.clone());
    assert_eq!(adopted["document"]["approved_revision_id"],first["revision"]["revision_id"]);
    assert_ne!(adopted["document"]["current_revision_id"],first["revision"]["revision_id"]);
    drop(k); let k=Kernel::open(json!({"workspace_path":root.path(),"mode":"author"})).unwrap();
    assert_eq!(call(&k,"drafts.adopt",input.clone()),committed);
    let mut other=input;other["preview"]["sha256"]=json!("0".repeat(64));
    assert_eq!(call(&k,"drafts.adopt",other)["error"]["code"],"idempotency_conflict");
    let new=data(call(&k,"documents.get",json!({"document_id":first["document"]["document_id"]})));
    assert_eq!(new["content"],source);
    assert_eq!(new["revision"]["contribution_refs"][0],adopted["adoption"]["reference"]);
    let edited=data(call(&k,"documents.save",json!({"document_id":first["document"]["document_id"],"base_revision_id":new["revision"]["revision_id"],"source_format":"markdown","content":"作者后续改写。","operation_key":"edit"})));
    assert_eq!(edited["revision"]["contribution_refs"],new["revision"]["contribution_refs"]);
    let edited=data(call(&k,"documents.get",json!({"document_id":first["document"]["document_id"]})));
    let newer=finalize(&k,&edited,"final-new");
    let old=json!({"document_id":first["document"]["document_id"],"expected_finalization_ref":approved["finalization"]["reference"],"reason":"旧撤回","operation_key":"old-withdraw"});
    assert_eq!(call(&k,"documents.withdraw_finalization",old)["error"]["code"],"revision_conflict");
    let withdrawn=data(call(&k,"documents.withdraw_finalization",json!({"document_id":first["document"]["document_id"],"expected_finalization_ref":newer["finalization"]["reference"],"reason":"继续修改","operation_key":"withdraw"})));
    assert!(withdrawn["document"]["approved_revision_id"].is_null());
    let history=data(call(&k,"documents.lifecycle",json!({"document_id":first["document"]["document_id"]})));
    assert_eq!(history["adoptions"].as_array().unwrap().len(),1);
    assert_eq!(history["finalizations"].as_array().unwrap().len(),3);
    assert_eq!(data(call(&k,"documents.get",json!({"document_id":first["document"]["document_id"]})))["content"],"作者后续改写。");
}

#[test]
fn unicode_partial_adoption_checks_ranges_and_rejects_stale_or_forged_previews() {
    let (_root,k)=setup();let old="甲🌿\r\n旧句。";let first=document(&k,old);let source="新句。未选内容。";let draft=submit(&k,source);
    let request=json!({"draft_ref":{"draft_id":draft["draft_id"],"revision":draft["revision"],"sha256":draft["content_sha256"]},"target_ref":reference(&first),"new_document":null,"selected_ranges":[{"source":range(source,0,9),"target":range(old,9,18)}]});
    let planned=data(call(&k,"drafts.preview_adoption",request.clone()));
    assert_eq!(planned["content"],"甲🌿\r\n新句。");
    let mut bad=request.clone();bad["selected_ranges"][0]["source"]["byte_start"]=json!(1);
    assert_eq!(call(&k,"drafts.preview_adoption",bad)["error"]["code"],"hetu.invalid_source_ref");
    let mut overlap=request.clone(); overlap["selected_ranges"].as_array_mut().unwrap().push(request["selected_ranges"][0].clone());
    assert_eq!(call(&k,"drafts.preview_adoption",overlap)["error"]["code"],"hetu.invalid_source_ref");
    let mut forged=planned["preview"].clone();forged["result_sha256"]=json!("a".repeat(64));
    assert_eq!(call(&k,"drafts.adopt",json!({"preview":forged,"operation_key":"forged"}))["error"]["code"],"revision_conflict");
    data(call(&k,"documents.save",json!({"document_id":first["document"]["document_id"],"base_revision_id":first["revision"]["revision_id"],"source_format":"markdown","content":"另一窗口保存。","operation_key":"concurrent"})));
    assert_eq!(call(&k,"drafts.adopt",json!({"preview":planned["preview"],"operation_key":"stale"}))["error"]["code"],"revision_conflict");
    assert!(data(call(&k,"documents.lifecycle",json!({"document_id":first["document"]["document_id"]})))["adoptions"].as_array().unwrap().is_empty());
}

#[test]
fn finalization_rechecks_evidence_and_agent_cannot_gain_author_actions() {
    let (root,k)=setup();let first=document(&k,"林舟来到雾港。");let preview=prepare_final(&k,&first,"first");
    let agent=Kernel::open(json!({"workspace_path":root.path(),"mode":"agent"})).unwrap();
    assert_eq!(call(&agent,"documents.finalize",json!({"preview":preview,"operation_key":"agent"}))["error"]["code"],"forbidden");
    assert_eq!(call(&agent,"documents.lifecycle",json!({"document_id":first["document"]["document_id"]}))["error"]["code"],"forbidden");
    let bp=data(call(&k,"blueprints.get",json!({})));
    data(call(&k,"blueprints.lock",json!({"expected":{"revision":bp["revision"],"sha256":bp["sha256"]},"operation_key":"lock"})));
    assert_eq!(call(&k,"documents.finalize",json!({"preview":preview,"operation_key":"stale"}))["error"]["code"],"hetu.stale_evidence");
    let current=data(call(&k,"documents.get",json!({"document_id":first["document"]["document_id"]})));
    let finalized=finalize(&k,&current,"fresh");
    let record=finalized["finalization"]["reference"]["finalization_id"].as_str().unwrap();
    let path=root.path().join(format!("packages/novel/documents/{}/finalizations/{record}.json",first["document"]["document_id"].as_str().unwrap()));
    std::fs::write(path,b"{}").unwrap();
    assert_eq!(call(&k,"documents.get",json!({"document_id":first["document"]["document_id"]}))["error"]["code"],"hetu.integrity_failure");
}

#[test]
fn legacy_review_contract_cannot_keep_the_automatic_finalization_side_effect() {
    let (_root,k)=setup();
    let result=k.request(json!({"action":"hetu.reviews.decide","contract_revision":"1","input":{}}));
    assert_eq!(result["error"]["code"],"unsupported_version"); assert_eq!(result["contract_revision"],"2");
}

#[test]
fn new_chapter_adoption_rechecks_volume_structure_before_any_document_is_created() {
    let (_root,k)=setup();
    let volume="volume_00000000-0000-4000-8000-000000000001";
    let novel=data(call(&k,"novels.get",json!({})));
    let novel=data(call(&k,"novels.save_structure",json!({"expected":{"revision":novel["revision"],"sha256":novel["sha256"]},"volumes":[{"volume_id":volume,"title":"第一卷 起雾"}],"chapters":[],"operation_key":"volume"})));
    let source="闻溪推开门。🌿\r\n"; let draft=submit(&k,source);
    let mut request=json!({"draft_ref":{"draft_id":draft["draft_id"],"revision":draft["revision"],"sha256":draft["content_sha256"]},"target_ref":null,"new_document":{"title":"第一章 雾起","volume_id":volume,"novel_expected":{"revision":novel["revision"],"sha256":novel["sha256"]}},"selected_ranges":[{"source":range(source,0,source.len()),"target":range("",0,0)}]});
    let preview=data(call(&k,"drafts.preview_adoption",request.clone()));
    let changed=data(call(&k,"novels.save_structure",json!({"expected":{"revision":novel["revision"],"sha256":novel["sha256"]},"volumes":[{"volume_id":volume,"title":"第一卷 港口"}],"chapters":[],"operation_key":"rename-volume"})));
    assert_eq!(call(&k,"drafts.adopt",json!({"preview":preview["preview"],"operation_key":"stale-new"}))["error"]["code"],"revision_conflict");
    assert!(data(call(&k,"documents.list",json!({})))["documents"].as_array().unwrap().is_empty());
    assert_eq!(data(call(&k,"novels.get",json!({}))),changed);
    request["new_document"]["novel_expected"]=json!({"revision":changed["revision"],"sha256":changed["sha256"]});
    let preview=data(call(&k,"drafts.preview_adoption",request));
    let adopted=data(call(&k,"drafts.adopt",json!({"preview":preview["preview"],"operation_key":"fresh-new"})));
    assert!(adopted["document"]["finalization_ref"].is_null());
    let structure=data(call(&k,"novels.get",json!({})));
    assert_eq!(structure["novel"]["chapters"][0]["volume_id"],volume);
    assert_eq!(structure["novel"]["chapters"][0]["document_id"],adopted["document"]["document_id"]);
    assert_eq!(data(call(&k,"documents.get",json!({"document_id":adopted["document"]["document_id"]})))["content"],source);
}

#[test]
fn finalization_checks_latest_dispositions_and_only_accepts_permitted_exceptions() {
    for policy in ["author_review","none"] {
        let (_root,k)=setup(); let first=document(&k,"林舟推开传送门。\r\n");
        let bp=data(call(&k,"blueprints.get",json!({})));
        data(call(&k,"blueprints.save",json!({"expected":{"revision":bp["revision"],"sha256":bp["sha256"]},"typed_changes":[{"type":"upsert_rule","entity":{"rule_id":"rule_11111111-1111-4111-8111-111111111111","revision":1,"type":"forbidden_term","scope":{"packages":["novel"],"document_ids":[first["document"]["document_id"]],"entity_refs":[]},"severity":"error","parameters":{"terms":["传送门"],"case_sensitive":true,"exceptions":[]},"rationale":"世界观没有传送能力。","exception_policy":policy}}],"operation_key":"rule"})));
        let validated=data(call(&k,"documents.validate",json!({"document_ref":reference(&first),"plot_options":{},"validation_options":{},"operation_key":"check"})));
        let finding=&validated["report"]["findings"][0]; assert_eq!(finding["severity"],"error"); assert_eq!(finding["certainty"],"certain");
        let mut input=json!({"document_ref":reference(&first),"expected_finalization_ref":null,"report_refs":[validated["reference"]],"comments":"核对本章。","coverage_acknowledgement":"已人工核对未知语境。"});
        assert_eq!(data(call(&k,"documents.preview_finalization",input.clone()))["preview"]["blocker"]["code"],"hetu.review_conflict");
        let disposition=json!({"report_id":validated["report"]["report_id"],"finding_id":finding["finding_id"],"expected_inputs":validated["report"]["input_snapshot"],"expected_disposition_revision":0,"disposition":"accepted_exception","reason":"作者确认这是人物的假想。","operation_key":"exception"});
        if policy=="none" {
            assert_eq!(call(&k,"findings.disposition",disposition)["error"]["code"],"forbidden");
            continue;
        }
        data(call(&k,"findings.disposition",disposition.clone()));
        let fetched=data(call(&k,"reports.get",json!({"report_id":validated["report"]["report_id"]})));
        assert_eq!(fetched["reference"]["sha256"],validated["reference"]["sha256"]);
        assert_ne!(fetched["reference"]["dispositions_sha256"],validated["reference"]["dispositions_sha256"]);
        assert_eq!(data(call(&k,"documents.preview_finalization",input.clone()))["preview"]["blocker"]["code"],"hetu.stale_evidence");
        input["report_refs"]=json!([fetched["reference"]]);
        let preview=data(call(&k,"documents.preview_finalization",input.clone()))["preview"].clone(); assert_eq!(preview["eligible"],true);
        let mut changed=disposition; changed["expected_disposition_revision"]=json!(1);changed["disposition"]=json!("acknowledged");changed["operation_key"]=json!("reconsider");
        data(call(&k,"findings.disposition",changed));
        assert_eq!(call(&k,"documents.finalize",json!({"preview":preview,"operation_key":"stale-final"}))["error"]["code"],"hetu.stale_evidence");
        assert!(data(call(&k,"documents.lifecycle",json!({"document_id":first["document"]["document_id"]})))["finalizations"].as_array().unwrap().is_empty());
    }
}

#[test]
fn partial_manual_check_requires_explicit_author_acknowledgement() {
    let (_root,k)=setup(); let first=document(&k,"林舟推开门。\n\n闻溪说：“回来。”");
    let report=data(call(&k,"documents.validate",json!({"document_ref":reference(&first),"plot_options":{},"validation_options":{"max_bytes":1},"operation_key":"partial"})));
    assert_eq!(report["report"]["status"],"partial");
    let mut input=json!({"document_ref":reference(&first),"expected_finalization_ref":null,"report_refs":[report["reference"]],"comments":"确认手工稿。","coverage_acknowledgement":""});
    assert_eq!(data(call(&k,"documents.preview_finalization",input.clone()))["preview"]["blocker"]["code"],"hetu.review_coverage_required");
    input["coverage_acknowledgement"]=json!("未检查的段落已逐段人工核对。");
    let preview=data(call(&k,"documents.preview_finalization",input))["preview"].clone(); assert_eq!(preview["eligible"],true);
    let finalized=data(call(&k,"documents.finalize",json!({"preview":preview,"operation_key":"final"})));
    assert_eq!(finalized["document"]["approved_revision_id"],first["revision"]["revision_id"]);
}
