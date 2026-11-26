use hetu_core::Kernel;
use serde_json::{Value,json};

fn call(kernel:&Kernel,action:&str,input:Value)->Value{
    kernel.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(result:Value)->Value{assert_eq!(result["status"],"succeeded","{result}");result["data"].clone()}
fn setup()->(tempfile::TempDir,Kernel,Value,Value){
    let folder=tempfile::tempdir().unwrap();
    let kernel=Kernel::open(json!({"workspace_path":folder.path(),"mode":"author","create":{"title":"雾港","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let work=ok(call(&kernel,"works.list",json!({})))["works"][0]["work_ref"].clone();
    let document=ok(call(&kernel,"documents.create",json!({"kind":"novel_chapter","title":"雾港🌿","source_format":"markdown","content":"灯塔与来信。","operation_key":"chapter"})));
    (folder,kernel,work,document)
}
fn prepare(kernel:&Kernel,work:&Value,sources:Value,key:&str)->Value{
    let preview=ok(call(kernel,"creative_tasks.preview_prompt",json!({"scope_ref":{"kind":"workspace","id":kernel.scope()},"work_ref":work,
        "task_kind":"chapter_draft","brief":"只读固定来源并保存参考稿，不改变正式头。","input_refs":sources,"client_adapter":"codex","language_tag":"zh-CN"})));
    let mut input=preview["prepare_input"].clone();input["operation_key"]=json!(key);
    ok(call(kernel,"creative_tasks.prepare",input))
}

#[test]
fn formal_outline_is_a_fixed_lazy_source_and_old_catalogs_never_follow_new_heads(){
    let (folder,kernel,work,document)=setup();
    let first=json!({"id":"outline_00000000-0000-4000-8000-000000000001","title":"同名章纲","text":format!("开篇🌿\r\n{}结尾甲。","保留灯塔。".repeat(1000)),"level":"chapter","target_id":document["document"]["document_id"]});
    let second=json!({"id":"outline_00000000-0000-4000-8000-000000000002","title":"同名章纲","text":"另一条明确的章纲。","level":"chapter","target_id":document["document"]["document_id"]});
    let saved=ok(call(&kernel,"outlines.save",json!({"expected":{"revision":0,"sha256":null},"items":[first,second],"operation_key":"outline-first"})));
    let source=json!({"kind":"outline","work_ref":work,"outline_id":first["id"],"revision":saved["revision"],"sha256":saved["sha256"]});
    let page=ok(call(&kernel,"outlines.get",json!({"detail":"summary","limit":1})));
    assert_eq!(page["items"][0]["id"],first["id"]);assert!(page["items"][0].get("text").is_none());
    assert!(page["items"][0]["excerpt"].as_str().unwrap().chars().count()<=100);
    assert_eq!(ok(call(&kernel,"outlines.get",json!({"detail":"summary","limit":1,"cursor":page["next_cursor"]})))["items"][0]["id"],second["id"]);
    let task=prepare(&kernel,&work,json!([source]),"task");
    let agent=Kernel::open(json!({"workspace_path":folder.path(),"mode":"agent","task_id":task["task_ref"]["task_id"]})).unwrap();
    let directory=ok(call(&agent,"task_context.list",json!({"task_ref":task["task_ref"],"kind":"outline"})));
    let context=&directory["entries"][0]["context_ref"];
    let mut changed=first.clone();changed["text"]=json!(first["text"].as_str().unwrap().replace("结尾甲","结尾乙"));
    ok(call(&kernel,"outlines.save",json!({"expected":{"revision":saved["revision"],"sha256":saved["sha256"]},"items":[changed,second],"operation_key":"outline-second"})));
    assert_eq!(call(&kernel,"outlines.get",json!({"detail":"summary","limit":1,"cursor":page["next_cursor"]}))["error"]["code"],"cursor_invalid");
    let old=ok(call(&kernel,"outlines.get",json!({"revision":saved["revision"],"sha256":saved["sha256"],"outline_id":first["id"]})));
    assert_eq!(old["items"],json!([first]));assert_eq!(old["coverage"]["returned_items"],1);
    let mut text=String::new();let mut range=json!({"byte_start":0});
    loop{
        let part=ok(call(&agent,"task_context.read",json!({"task_ref":task["task_ref"],"context_ref":context,"range":range,"max_bytes":1024})));
        assert_eq!(part["source_ref"]["outline_id"],first["id"]);assert_eq!(part["source_ref"]["revision"],1);
        text.push_str(part["content"].as_str().unwrap());if part["complete"]==true{break;}range=part["next_range"].clone();
    }
    assert_eq!(text,first["text"].as_str().unwrap());
    assert_eq!(call(&agent,"task_context.read",json!({"task_ref":task["task_ref"],"context_ref":context,"range":{"byte_start":1}}))["error"]["code"],"hetu.invalid_source_ref");
    let hit=ok(call(&agent,"task_context.search",json!({"task_ref":task["task_ref"],"kind":"outline","query":"开篇🌿"})));
    assert_eq!(hit["matches"][0]["source_ref"]["outline_id"],first["id"]);assert_eq!(hit["coverage"]["scanned_entries"],1);
    assert_eq!(call(&agent,"outlines.get",json!({"revision":1,"outline_id":second["id"]}))["error"]["code"],"forbidden");
    let handoff=ok(call(&kernel,"handoffs.get",json!({"view_kind":"structure","object_ref":{"work_ref":work,"outline_id":first["id"],"outline_revision":1,"outline_sha256":saved["sha256"]}})));
    assert!(handoff["fixed_refs"].as_array().unwrap().contains(&source));
    assert!(!handoff["fixed_refs"].as_array().unwrap().iter().any(|value|value["kind"]=="novel"));
    for input in [json!({"revision":1,"sha256":"0".repeat(64)}),json!({"revision":1,"outline_id":"outline_00000000-0000-4000-8000-000000000099"}),json!({"revision":99})]{
        assert_ne!(call(&kernel,"outlines.get",input)["status"],"succeeded");
    }
    let snapshot=folder.path().join(".hetu/authoring/outlines/1.json");
    let mut corrupted:Value=serde_json::from_slice(&std::fs::read(&snapshot).unwrap()).unwrap();corrupted["items"][0]["text"]=json!("损坏的历史");
    std::fs::write(snapshot,serde_json::to_vec(&corrupted).unwrap()).unwrap();
    assert_eq!(call(&kernel,"outlines.get",json!({"revision":1}))["error"]["code"],"hetu.integrity_failure");
}

#[test]
fn selected_entity_is_not_a_whole_bible_and_plugins_read_the_same_fixed_sources(){
    let (folder,kernel,work,_)=setup();
    let original=ok(call(&kernel,"blueprints.get",json!({"work_ref":work})));
    let person=|index:u8,name:&str|json!({"character_id":format!("character_00000000-0000-4000-8000-{index:012}"),"name":name,"description":"固定旧人物","aliases":[],"traits":[],"facts":[],"archived":false});
    let (first,second)=(person(1,"江岚"),person(2,"江岚"));
    let saved=ok(call(&kernel,"blueprints.save",json!({"work_ref":work,"expected":{"blueprint_id":original["blueprint"]["blueprint_id"],"revision":original["revision"],"sha256":original["sha256"]},
        "typed_changes":[{"type":"upsert_character","entity":first},{"type":"upsert_character","entity":second}],"operation_key":"characters"})));
    let source=json!({"kind":"blueprint","work_ref":work,"blueprint_id":saved["blueprint"]["blueprint_id"],"revision":saved["revision"],"sha256":saved["sha256"],"entity_ref":first["character_id"]});
    let task=prepare(&kernel,&work,json!([source]),"entity-task");
    let agent=Kernel::open(json!({"workspace_path":folder.path(),"mode":"agent","task_id":task["task_ref"]["task_id"]})).unwrap();
    let entries=ok(call(&agent,"task_context.list",json!({"task_ref":task["task_ref"]})));
    let context=&entries["entries"][0]["context_ref"];
    let read=|input:Value|{let mut request=json!({"task_ref":task["task_ref"],"context_ref":context});request.as_object_mut().unwrap().extend(input.as_object().unwrap().clone());call(&agent,"task_context.read",request)};
    let selected=ok(read(json!({})));assert_eq!(selected["entity"],first);assert!(selected.get("blueprint").is_none());assert_eq!(selected["coverage"]["kind"],"entity");
    assert_eq!(read(json!({"section":"characters","entity_id":second["character_id"]}))["error"]["code"],"forbidden");
    assert_eq!(read(json!({"section":"locations"}))["error"]["code"],"forbidden");
    assert_eq!(call(&kernel,"handoffs.get",json!({"view_kind":"entity","object_ref":{"work_ref":work,"entity_ref":"江岚"}}))["error"]["code"],"not_found");
    let context=json!({"plugin_id":"org.hetu.sources-test","package_sha256":"a".repeat(64),"work_ref":work,"types":[]});
    let inspect=|reference:Value,extra:Value|{let mut input=json!({"source_ref":reference});input.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());kernel.open_plugin_request(json!({"context":context,"request":{"action":"hetu.extensions.sources.inspect","contract_revision":"1","input":input}}))};
    assert_eq!(ok(inspect(source.clone(),json!({})))["entity"],first);
    assert_eq!(inspect(source.clone(),json!({"entity_ref":second["character_id"]}))["error"]["code"],"forbidden");
    let outline=json!({"id":"outline_00000000-0000-4000-8000-000000000001","title":"总纲","text":"先保留故事悬念。","level":"book","target_id":null});
    let outlines=ok(call(&kernel,"outlines.save",json!({"expected":{"revision":0,"sha256":null},"items":[outline],"operation_key":"outline"})));
    let outline_source=json!({"kind":"outline","work_ref":work,"outline_id":outline["id"],"revision":outlines["revision"],"sha256":outlines["sha256"]});
    assert_eq!(ok(inspect(outline_source.clone(),json!({})))["outline"],outline);
    let drama=ok(call(&kernel,"drama.projects.create",json!({"title":"同根剧本","mode":"original","operation_key":"drama"})));
    let mut foreign=outline_source.clone();foreign["work_ref"]=json!({"workspace_id":work["workspace_id"],"kind":"drama","object_id":drama["project"]["project_id"]});
    assert_eq!(inspect(foreign.clone(),json!({}))["error"]["code"],"forbidden");
    assert_eq!(call(&kernel,"creative_tasks.preview_prompt",json!({"scope_ref":{"kind":"workspace","id":kernel.scope()},"work_ref":work,"task_kind":"chapter_draft","brief":"拒绝异作来源","input_refs":[foreign],"client_adapter":"codex","language_tag":"zh-CN"}))["error"]["code"],"forbidden");
}
