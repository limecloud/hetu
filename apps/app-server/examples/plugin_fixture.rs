//! 仅用于隔离集成测试的可信作者夹具。
use hetu_core::Kernel;
use serde_json::{Value, json};
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    assert!((4..=8).contains(&args.len()));
    let manifest: Value = serde_json::from_slice(&std::fs::read(&args[2]).unwrap()).unwrap();
    let kernel=Kernel::open(json!({"workspace_path":args[0],"mode":"author","create":{"title":"插件集成测试","locale":"zh-CN","operation_key":"fixture"}})).unwrap();
    let works =
        kernel.request(json!({"action":"hetu.works.list","contract_revision":"1","input":{}}));
    let work = works["data"]["works"][0]["work_ref"].clone();
    let doc=kernel.request(json!({"action":"hetu.documents.create","contract_revision":"1","input":{"kind":"novel_chapter","title":"第一章 雾港","source_format":"markdown","content":"灯塔在黎明前亮起。\n江岚合上旧日记。🌿","operation_key":"fixture-chapter"}}));
    assert_eq!(doc["status"], "succeeded", "{doc}");
    let extra_chapters: usize = args.get(4).map(|value| value.parse().unwrap()).unwrap_or(0);
    assert!(extra_chapters <= 150);
    for number in 1..=extra_chapters {
        let chapter = kernel.request(json!({"action":"hetu.documents.create","contract_revision":"1","input":{
            "kind":"novel_chapter","title":format!("目录试读第{number:03}章"),"source_format":"markdown","content":format!("江岚在第{number}个清晨抵达雾港。"),"operation_key":format!("fixture-chapter-{number}")}}));
        assert_eq!(chapter["status"], "succeeded", "{chapter}");
    }
    if extra_chapters > 0 {
        let novel =
            kernel.request(json!({"action":"hetu.novels.get","contract_revision":"1","input":{}}));
        assert_eq!(novel["status"], "succeeded", "{novel}");
        let mut chapters = novel["data"]["novel"]["chapters"]
            .as_array()
            .unwrap()
            .clone();
        chapters.reverse();
        let volume = "volume_11111111-1111-4111-8111-111111111111";
        let ungrouped = chapters.len().saturating_sub(50);
        for chapter in chapters.iter_mut().skip(ungrouped) {
            chapter["volume_id"] = json!(volume);
        }
        let saved = kernel.request(json!({"action":"hetu.novels.save_structure","contract_revision":"1","input":{
            "expected":{"revision":novel["data"]["revision"],"sha256":novel["data"]["sha256"]},"volumes":[{"volume_id":volume,"title":"第一卷 海上"}],"chapters":chapters,"operation_key":"fixture-structure"}}));
        assert_eq!(saved["status"], "succeeded", "{saved}");
    }
    let preview = kernel.request(json!({"action":"hetu.creative_tasks.preview_prompt","contract_revision":"1","input":{
        "scope_ref":{"kind":kernel.scope_kind(),"id":kernel.scope()},"work_ref":work,
        "target_ref":{"document_id":doc["data"]["document"]["document_id"],"revision_id":doc["data"]["revision"]["revision_id"],"sha256":doc["data"]["revision"]["sha256"]},
        "task_kind":"chapter_draft","brief":"比较雾港开篇的两个叙事方案","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN","candidate_limit":4}}));
    assert_eq!(preview["status"], "succeeded", "{preview}");
    let mut prepare = preview["data"]["prepare_input"].clone();
    prepare["operation_key"] = json!("fixture-task");
    let task = kernel.request(
        json!({"action":"hetu.creative_tasks.prepare","contract_revision":"1","input":prepare}),
    );
    assert_eq!(task["status"], "succeeded", "{task}");
    let agent = Kernel::open(json!({"workspace_path":args[0],"mode":"agent","task_id":task["data"]["task_ref"]["task_id"]})).unwrap();
    let submission = agent.request(json!({"action":"hetu.creative_tasks.submit_result","contract_revision":"1","input":{
        "task_ref":task["data"]["task_ref"],"request_sha256":task["data"]["request_sha256"],
        "candidates":[
            {"kind":"text","title":"从灯塔开始","source_format":"markdown","source_ref_indices":[],"content":"灯塔亮起时，江岚打开了那封信。"},
            {"kind":"text","title":"从旧日记开始","source_format":"markdown","source_ref_indices":[],"content":"旧日记里夹着一张通往雾港的船票。"}],
        "complete":true,"missing_items":[],"provenance":{"client":"test-client","skill_version":"1"},"operation_key":"fixture-submission"}}));
    assert_eq!(submission["status"], "succeeded", "{submission}");
    let drama = kernel.request(json!({"action":"hetu.drama.projects.create","contract_revision":"1","input":{"title":"独立剧本","mode":"original","operation_key":"fixture-drama"}}));
    assert_eq!(drama["status"], "succeeded", "{drama}");
    let episode = kernel.request(json!({"action":"hetu.drama.episodes.create","contract_revision":"1","input":{
        "project_ref":{"project_id":drama["data"]["project"]["project_id"],"revision":1,"sha256":drama["data"]["sha256"]},
        "title":"第一集","plan":"与小说保持独立。","language_tag":"zh-CN","operation_key":"fixture-episode"}}));
    assert_eq!(episode["status"], "succeeded", "{episode}");
    let mut new_adoptions = json!({});
    if args.get(5).is_some_and(|flag| flag == "--new-targets") {
        for (kind, reference, title, content, format) in [
            (
                "novel",
                work.clone(),
                "潮汐来信",
                "江岚在潮声中读完了那封信。🌿",
                "markdown",
            ),
            (
                "drama",
                json!({"workspace_id":kernel.scope(),"kind":"drama","object_id":drama["data"]["project"]["project_id"]}),
                "第二集 潮汐",
                "INT. 灯塔 - NIGHT\n\n江岚\n信是你写的？\n",
                "fountain",
            ),
        ] {
            let prompt = kernel.request(json!({"action":"hetu.creative_tasks.preview_prompt","contract_revision":"1","input":{
                "scope_ref":{"kind":kernel.scope_kind(),"id":kernel.scope()},"work_ref":reference,
                "task_kind":if kind == "novel" {"chapter_draft"} else {"drama_draft"},"brief":format!("准备{title}的新稿"),
                "input_refs":[],"client_adapter":"codex","language_tag":"zh-CN","candidate_limit":2}}));
            assert_eq!(prompt["status"], "succeeded", "{prompt}");
            let mut prepare = prompt["data"]["prepare_input"].clone();
            prepare["operation_key"] = json!(format!("new-{kind}"));
            let task = kernel.request(json!({"action":"hetu.creative_tasks.prepare","contract_revision":"1","input":prepare}));
            assert_eq!(task["status"], "succeeded", "{task}");
            let submit_input = json!({"task_ref":task["data"]["task_ref"],"request_sha256":task["data"]["request_sha256"],
                "candidates":[{"kind":"text","title":title,"source_format":format,"source_ref_indices":[],"content":content}],
                "complete":true,"missing_items":[],"provenance":{"client":"test","skill_version":"1"},"operation_key":format!("new-submit-{kind}")});
            let agent = Kernel::open(json!({"workspace_path":args[0],"mode":"agent","task_id":task["data"]["task_ref"]["task_id"]})).unwrap();
            let submitted = agent.request(json!({"action":"hetu.creative_tasks.submit_result","contract_revision":"1","input":submit_input}));
            assert_eq!(submitted["status"], "succeeded", "{submitted}");
            new_adoptions[kind] = json!({"work_ref":reference,"task_ref":task["data"]["task_ref"],"submit_input":submit_input,
                "candidate":submitted["data"]["submission"]["candidates"][0]});
        }
    }
    let mut artwork = Value::Null;
    if args.get(5).is_some_and(|flag| flag == "--artwork") {
        assert_eq!(args.len(), 8);
        let character = "character_11111111-1111-4111-8111-111111111111";
        let old = kernel.request(json!({"action":"hetu.blueprints.get","contract_revision":"1","input":{"work_ref":work}}));
        let saved = kernel.request(json!({"action":"hetu.blueprints.save","contract_revision":"1","input":{"work_ref":work,"expected":{"blueprint_id":old["data"]["blueprint"]["blueprint_id"],"revision":old["data"]["revision"],"sha256":old["data"]["sha256"]},"typed_changes":[{"type":"upsert_character","entity":{"character_id":character,"name":"江岚","aliases":[],"description":"雾港的来客","traits":[],"facts":[],"archived":false}}],"operation_key":"fixture-character"}}));
        assert_eq!(saved["status"], "succeeded", "{saved}");
        let blueprint = json!({"kind":"blueprint","work_ref":work,"blueprint_id":saved["data"]["blueprint"]["blueprint_id"],"revision":saved["data"]["revision"],"sha256":saved["data"]["sha256"]});
        let document = json!({"kind":"document","document_id":doc["data"]["document"]["document_id"],"revision_id":doc["data"]["revision"]["revision_id"]});
        let preview = kernel.request(json!({"action":"hetu.image_tasks.preview_prompt","contract_revision":"1","input":{"scope_ref":{"kind":kernel.scope_kind(),"id":kernel.scope()},"work_ref":work,"task_kind":"artwork","brief":"为雾港人物和第一章准备不同用途的图片","input_refs":[blueprint,document],"client_adapter":"codex","language_tag":"zh-CN","candidate_limit":4}}));
        assert_eq!(preview["status"], "succeeded", "{preview}");
        let mut input = preview["data"]["prepare_input"].clone();
        input["operation_key"] = json!("fixture-images");
        let images = kernel.request(
            json!({"action":"hetu.image_tasks.prepare","contract_revision":"1","input":input}),
        );
        assert_eq!(images["status"], "succeeded", "{images}");
        let inbox = std::path::Path::new(&args[0]).join(
            images["data"]["request"]["output_contract"]["relative_inbox"]
                .as_str()
                .unwrap(),
        );
        std::fs::copy(&args[6], inbox.join("sample.png")).unwrap();
        let entity = json!({"kind":"entity","entity_ref":character,"work_ref":work,"blueprint_id":blueprint["blueprint_id"],"blueprint_revision":blueprint["revision"]});
        let candidates = json!([
            {"kind":"image","title":"雾中的旅人","source_format":"image","source_ref_indices":[0],"file_name":"sample.png","sha256":args[7],"image_category":"character","image_view":"front","subject_refs":[entity]},
            {"kind":"image","title":"旧外套的侧面","source_format":"image","source_ref_indices":[0],"file_name":"sample.png","sha256":args[7],"image_category":"costume","image_view":"side","subject_refs":[entity]},
            {"kind":"image","title":"黎明前的灯塔","source_format":"image","source_ref_indices":[1],"file_name":"sample.png","sha256":args[7],"image_category":"illustration","subject_refs":[document]}
        ]);
        let input = json!({"task_ref":images["data"]["task_ref"],"request_sha256":images["data"]["request_sha256"],"candidates":candidates,"complete":true,"missing_items":[],"provenance":{"client":"test-client","skill_version":"1"},"operation_key":"fixture-image-submission"});
        let image_agent = Kernel::open(json!({"workspace_path":args[0],"mode":"agent","task_id":images["data"]["task_ref"]["task_id"]})).unwrap();
        let result = image_agent.request(json!({"action":"hetu.creative_tasks.submit_result","contract_revision":"1","input":input}));
        assert_eq!(result["status"], "succeeded", "{result}");
        artwork = json!({"task_ref":images["data"]["task_ref"],"submission_id":result["data"]["submission"]["submission_id"],"submit_input":input,"character_id":character});
    } else if args.get(5).is_some_and(|flag| flag == "--link-history") {
        let source = kernel.request(
            json!({"action":"hetu.works.get","contract_revision":"1","input":{"work_ref":work}}),
        )["data"]["summary"]["fixed_ref"]
            .clone();
        let target_work = json!({"workspace_id":kernel.scope(),"kind":"drama","object_id":drama["data"]["project"]["project_id"]});
        let target = kernel.request(json!({"action":"hetu.works.get","contract_revision":"1","input":{"work_ref":target_work}}))["data"]["summary"]["fixed_ref"].clone();
        let link = kernel.request(json!({"action":"hetu.work_links.create","contract_revision":"1","input":{"source_ref":source,"target_ref":target,"relation":"adaptation","operation_key":"fixture-link"}}));
        assert_eq!(link["status"], "succeeded", "{link}");
        for (number, title) in ["雾港新版资料", "雾港第三版资料"].iter().enumerate() {
            let novel = kernel
                .request(json!({"action":"hetu.novels.get","contract_revision":"1","input":{}}));
            let mut metadata = novel["data"]["novel"]["metadata"].clone();
            metadata["title"] = json!(title);
            metadata["synopsis"] = json!(format!("固定资料：{title}。"));
            let updated = kernel.request(json!({"action":"hetu.novels.update","contract_revision":"1","input":{"expected":{"revision":novel["data"]["revision"],"sha256":novel["data"]["sha256"]},"metadata":metadata,"operation_key":format!("fixture-profile-{number}")}}));
            assert_eq!(updated["status"], "succeeded", "{updated}");
            if number == 0 {
                let source = kernel.request(json!({"action":"hetu.works.get","contract_revision":"1","input":{"work_ref":work}}))["data"]["summary"]["fixed_ref"].clone();
                let advanced = kernel.request(json!({"action":"hetu.work_links.update_source","contract_revision":"1","input":{"work_ref":target_work,"link_ref":{"link_id":link["data"]["link"]["link_id"],"revision":1,"sha256":link["data"]["sha256"]},"source_ref":source,"target_ref":target,"operation_key":"fixture-advance-link"}}));
                assert_eq!(advanced["status"], "succeeded", "{advanced}");
            }
        }
    }
    let result=kernel.extension_host_request_in(std::path::Path::new(&args[1]),json!({"method":"authorize","params":{"work_ref":work,"plugin_id":manifest["id"],"package_sha256":args[3],"permissions":manifest.get("permissions").cloned().unwrap_or(json!([])),"types":manifest["contributions"]["data"],"operation_key":"fixture-plugin"}}));
    assert_eq!(result["status"], "succeeded", "{result}");
    let mut plugin_objects = Vec::new();
    if args.get(5).is_some_and(|flag| flag == "--plugin-results") {
        let session = hetu_core::application::extensions::PluginSession::open(
            std::path::Path::new(&args[0]), std::path::Path::new(&args[1]),
            result["data"]["grant_id"].as_str().unwrap(), &args[3],
        ).unwrap();
        for number in 1..=22 {
            let saved = session.request(json!({"action":"hetu.extensions.objects.save","contract_revision":"1","input":{
                "work_ref":work,"kind":"relationships","title":format!("雾港成果{number:02}"),"schema_version":"1",
                "content":{"nodes":[],"edges":[]},"expected_revision":0,"expected_sha256":"","operation_key":format!("fixture-result-{number}")}}));
            assert_eq!(saved["status"],"succeeded","{saved}");
            plugin_objects.push(saved["data"].clone());
        }
    }
    println!(
        "{}",
        json!({"work_ref":work,"grant_id":result["data"]["grant_id"],"document":doc["data"]["document"],"source_refs":[{"kind":"document","work_ref":work,"document_id":doc["data"]["document"]["document_id"],"revision_id":doc["data"]["revision"]["revision_id"],"sha256":doc["data"]["revision"]["sha256"]}],"task_ref":task["data"]["task_ref"],"other_document":episode["data"]["episode"]["document_id"],"artwork":artwork,"new_adoptions":new_adoptions,"plugin_objects":plugin_objects})
    );
}
