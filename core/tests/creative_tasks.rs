use hetu_core::Kernel;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

fn digest(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(value: Value) -> Value {
    assert_eq!(value["status"], "succeeded", "{value}");
    value["data"].clone()
}
fn expected(value: &Value) -> Value {
    json!({"revision":value["revision"],"sha256":value["sha256"]})
}
fn workspace() -> (tempfile::TempDir, Kernel) {
    let folder = tempfile::tempdir().unwrap();
    let k=Kernel::open(json!({"workspace_path":folder.path(),"mode":"author","create":{"title":"雾港","locale":"zh-CN","operation_key":"book"}})).unwrap();
    (folder, k)
}
fn project() -> (tempfile::TempDir, Kernel) {
    let folder = tempfile::tempdir().unwrap();
    let k=Kernel::open(json!({"creation_project_path":folder.path(),"mode":"author","create_project":{"brief":"一个关于河港的故事，还没有书名。","locale":"zh-CN","operation_key":"project"}})).unwrap();
    (folder, k)
}
fn prepare(k: &Kernel, kind: &str, input_refs: Value, edit: Option<Value>) -> Value {
    let mut input = json!({"scope_ref":{"kind":k.scope_kind(),"id":k.scope()},"task_kind":kind,"brief":"保留我的叙述语气，只改明确指定的部分。","input_refs":input_refs,"client_adapter":"codex","language_tag":"zh-CN","candidate_limit":4});
    if let Some(edit) = edit {
        input["edit_scope"] = edit;
    }
    let preview = ok(call(k, "creative_tasks.preview_prompt", input));
    let mut input = preview["prepare_input"].clone();
    input["operation_key"] = json!(format!(
        "prepare-{}",
        preview["task_ref"]["task_id"].as_str().unwrap()
    ));
    ok(call(k, "creative_tasks.prepare", input))
}
fn agent(path: &Path, project: bool, task: &Value) -> Kernel {
    let mut config = json!({"mode":"agent","task_id":task["task_ref"]["task_id"]});
    config[if project {
        "creation_project_path"
    } else {
        "workspace_path"
    }] = json!(path);
    Kernel::open(config).unwrap()
}
fn submit_input(task: &Value, candidates: Value, key: &str) -> Value {
    json!({"task_ref":task["task_ref"],"request_sha256":task["request_sha256"],"candidates":candidates,"complete":true,"missing_items":[],"provenance":{"client":"test-client","skill_version":"1"},"operation_key":key})
}
fn text_candidate(kind: &str, content: &str) -> Value {
    json!({"kind":kind,"title":"参考方案","source_format":if kind=="text" || kind=="outline" {"markdown"} else {"plain"},"source_ref_indices":[],"content":content})
}
fn get(k: &Kernel, task: &Value) -> Value {
    ok(call(
        k,
        "creative_tasks.get",
        json!({"task_ref":task["task_ref"]}),
    ))
}

#[test]
fn cli_contract_and_persisted_legacy_request_are_both_readable() {
    let (folder, author) = workspace();
    let task = prepare(&author, "chapter_draft", json!([]), None);
    assert_eq!(task["request"]["output_contract"]["submission_mode"], json!(["mcp", "cli", "inbox"]));
    // 模拟上一合同版本已经发布的固定请求；读取不能重写其字节或摘要。
    let task_id = task["task_ref"]["task_id"].as_str().unwrap();
    let request_path = folder.path().join(format!(".hetu/tasks/{task_id}/request.json"));
    let mut legacy = task["request"].clone();
    legacy["schema_version"] = json!("1.0.0");
    legacy.as_object_mut().unwrap().remove("context_manifest_ref");
    legacy["output_contract"]["submission_mode"] = json!(["mcp", "inbox"]);
    let raw = serde_json::to_vec(&legacy).unwrap();
    let sha = digest(&raw);
    fs::write(&request_path, &raw).unwrap();
    fs::write(folder.path().join(format!(".hetu/tasks/{task_id}/request-head.json")),
        serde_json::to_vec(&json!({"task_id":task_id,"request_revision":1,"sha256":sha})).unwrap()).unwrap();
    let reader = agent(folder.path(), false, &task);
    let loaded = get(&reader, &task);
    assert_eq!(loaded["request_sha256"], sha);
    assert_eq!(loaded["request"]["output_contract"]["submission_mode"], json!(["mcp", "inbox"]));
    assert_eq!(fs::read(request_path).unwrap(), raw);
    let mut input = submit_input(&task, json!([text_candidate("text", "旧任务也能继续提交参考稿。")]), "legacy-submit");
    input["request_sha256"] = json!(sha);
    ok(call(&reader, "creative_tasks.submit_result", input));
}

#[test]
fn nameless_preparation_is_separate_and_creation_preserves_sources_and_original_receipt() {
    let (folder, k) = project();
    assert!(!folder.path().join(".heturc.json").exists());
    assert!(!folder.path().join("shared").exists());
    assert!(!folder.path().join("packages").exists());
    let task = prepare(&k, "book_concept", json!([]), None);
    let reader = agent(folder.path(), true, &task);
    let result = ok(call(
        &reader,
        "creative_tasks.submit_result",
        submit_input(
            &task,
            json!([text_candidate("title", "雾港听潮")]),
            "submit",
        ),
    ));
    let candidate = &result["submission"]["candidates"][0];
    let reference = json!({"task_ref":task["task_ref"],"submission_id":result["submission"]["submission_id"],"candidate_id":candidate["candidate_id"]});
    let before = ok(call(
        &k,
        "creation_projects.get",
        json!({"project_id":k.scope()}),
    ));
    assert_eq!(before["project"]["task_refs"].as_array().unwrap().len(), 1);
    let selected = json!({"title":{"value":"雾港听潮","candidate_ref":reference},"author_name":{"value":"听雨","candidate_ref":null}});
    let save_input = json!({"project_id":k.scope(),"expected":expected(&before),"brief":"已选书名","selected_fields":selected,"operation_key":"choose"});
    let saved = ok(call(&k, "creation_projects.save", save_input.clone()));
    assert_eq!(ok(call(&k, "creation_projects.save", save_input)), saved);
    let parent = tempfile::tempdir().unwrap();
    let target = parent.path().join("雾港听潮");
    let metadata = json!({"title":"雾港听潮","author_name":"听雨","synopsis":"一座河港的旧事。","genre":"悬疑","language_tag":"zh-CN","status":"planning"});
    let input = json!({"project_id":k.scope(),"expected":expected(&saved),"metadata":metadata,"target_path":target,"operation_key":"create-novel"});
    let created = ok(call(&k, "creation_projects.create_novel", input.clone()));
    assert_eq!(created["novel"]["metadata"], metadata);
    assert_eq!(
        ok(call(&k, "creation_projects.create_novel", input.clone())),
        created
    );
    let source: Value =
        serde_json::from_slice(&fs::read(target.join(".hetu/creation-source.json")).unwrap())
            .unwrap();
    assert_eq!(source["candidate_snapshots"][0]["content"], "雾港听潮");
    assert_eq!(source["selected_fields"], selected);
    assert_eq!(source["project_id"], k.scope());
    assert_eq!(
        call(&reader, "documents.list", json!({}))["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        call(&reader, "creation_projects.create_novel", input)["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        get(&reader, &task)["submission"]["candidates"][0]["content"],
        "雾港听潮"
    );
    let mut wrong =
        json!({"creation_project_path":folder.path(),"workspace_path":target,"mode":"author"});
    assert!(Kernel::open(wrong.clone()).is_err());
    wrong.as_object_mut().unwrap().remove("workspace_path");
    assert!(Kernel::open(wrong).is_ok());
}

#[test]
fn revision_patches_enforce_utf8_ranges_keep_other_text_and_never_touch_author_document() {
    let (folder, k) = workspace();
    let original = "　　雾港灯亮了。🌿\n\n这段对白保持原样。";
    let doc = ok(call(
        &k,
        "documents.create",
        json!({"kind":"novel_chapter","title":"第一章","source_format":"markdown","content":original,"operation_key":"chapter"}),
    ));
    let doc_id = &doc["document"]["document_id"];
    let rev = &doc["revision"]["revision_id"];
    let start = original.find("灯亮了").unwrap();
    let end = start + "灯亮了".len();
    let range = json!({"byte_start":start,"byte_end":end,"quote":"灯亮了"});
    let task = prepare(
        &k,
        "revision",
        json!([{"kind":"document","document_id":doc_id,"revision_id":rev},{"kind":"blueprint","revision":1}]),
        Some(json!({"document_id":doc_id,"revision_id":rev,"ranges":[range]})),
    );
    let agent = agent(folder.path(), false, &task);
    let patch =
        json!({"byte_start":start,"byte_end":end,"quote":"灯亮了","replacement":"灯影轻晃"});
    let candidate = json!({"kind":"text","title":"局部改稿","source_format":"markdown","source_ref_indices":[0],"patches":[patch]});
    let input = submit_input(&task, json!([candidate.clone()]), "patch");
    let result = ok(call(&agent, "creative_tasks.submit_result", input.clone()));
    assert_eq!(
        ok(call(&agent, "creative_tasks.submit_result", input)),
        result
    );
    let actual = get(&agent, &task);
    assert_eq!(
        actual["submission"]["candidates"][0]["content"],
        original.replacen("灯亮了", "灯影轻晃", 1)
    );
    assert!(actual["submission"]["candidates"][0]["draft_ref"]["draft_id"].is_string());
    let unchanged = ok(call(&k, "documents.get", json!({"document_id":doc_id})));
    assert_eq!(unchanged["content"], original);
    assert_eq!(unchanged["document"]["current_revision_id"], *rev);
    assert!(unchanged["document"]["approved_revision_id"].is_null());
    let mut forbidden = candidate.clone();
    forbidden["patches"][0] =
        json!({"byte_start":0,"byte_end":3,"quote":"　","replacement":"删掉作者开头"});
    assert_eq!(
        call(
            &agent,
            "creative_tasks.submit_result",
            submit_input(&task, json!([forbidden]), "outside")
        )["error"]["code"],
        "forbidden"
    );
    let mut split = candidate.clone();
    split["patches"][0]["byte_start"] = json!(start + 1);
    assert_eq!(
        call(
            &agent,
            "creative_tasks.submit_result",
            submit_input(&task, json!([split]), "split")
        )["error"]["code"],
        "hetu.invalid_source_ref"
    );
    assert_eq!(
        call(
            &agent,
            "creative_tasks.submit_result",
            submit_input(
                &task,
                json!([text_candidate("text", "整章替换")]),
                "replace-all"
            )
        )["error"]["code"],
        "forbidden"
    );
    let current = ok(call(
        &k,
        "documents.save",
        json!({"document_id":doc_id,"base_revision_id":rev,"source_format":"markdown","content":format!("{original}\n作者继续写。"),"operation_key":"author-keeps-writing"}),
    ));
    let late = ok(call(
        &agent,
        "creative_tasks.submit_result",
        submit_input(&task, json!([candidate]), "late"),
    ));
    assert!(late["submission_ref"]["submission_id"].is_string());
    let after = ok(call(&k, "documents.get", json!({"document_id":doc_id})));
    assert_eq!(after["revision"], current["revision"]);
    assert!(after["content"].as_str().unwrap().ends_with("作者继续写。"));
    let op = ok(call(
        &agent,
        "operations.get",
        json!({"action":"hetu.creative_tasks.submit_result","key":"patch"}),
    ));
    assert_eq!(op["original_result"]["data"], result);
}

#[test]
fn task_sessions_do_not_read_other_tasks_or_sources_and_close_revokes_existing_process() {
    let (folder, k) = workspace();
    let one = prepare(&k, "chapter_draft", json!([]), None);
    let two = prepare(&k, "chapter_draft", json!([]), None);
    let a = agent(folder.path(), false, &one);
    let b = agent(folder.path(), false, &two);
    assert_eq!(
        call(
            &a,
            "creative_tasks.get",
            json!({"task_ref":two["task_ref"]})
        )["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        call(&a, "blueprints.get", json!({}))["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        call(&a, "documents.list", json!({}))["error"]["code"],
        "forbidden"
    );
    let ordinary = Kernel::open(json!({"workspace_path":folder.path(),"mode":"agent"})).unwrap();
    assert_eq!(
        call(
            &ordinary,
            "creative_tasks.get",
            json!({"task_ref":one["task_ref"]})
        )["error"]["code"],
        "forbidden"
    );
    let catalog = ok(call(&a, "capabilities.get", json!({})));
    let names: Vec<_> = catalog["actions"].as_array().unwrap().iter().map(|a| a["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"hetu.working_copies.save"));
    assert!(names.contains(&"hetu.task_feedback.list"));
    assert!(!names.contains(&"hetu.documents.save") && !names.contains(&"hetu.drafts.adopt"));
    let submit = ok(call(
        &a,
        "creative_tasks.submit_result",
        submit_input(
            &one,
            json!([text_candidate("text", "一份参考。")]),
            "submit",
        ),
    ));
    // 不同任务可以使用相同操作键，但不能读取彼此回执。
    ok(call(
        &b,
        "creative_tasks.submit_result",
        submit_input(
            &two,
            json!([text_candidate("text", "另一份参考。")]),
            "submit",
        ),
    ));
    assert_eq!(
        call(
            &b,
            "operations.get",
            json!({"operation_id":call(&a,"creative_tasks.submit_result",submit_input(&one,json!([text_candidate("text","一份参考。")]),"submit"))["operation"]["id"]})
        )["error"]["code"],
        "forbidden"
    );
    let reference = json!({"task_ref":one["task_ref"],"submission_id":submit["submission"]["submission_id"],"candidate_id":submit["submission"]["candidates"][0]["candidate_id"]});
    let before = get(&a, &one);
    let selection = ok(call(
        &a,
        "interactions.save_selection",
        json!({"task_ref":one["task_ref"],"expected":before["expected"],"candidate_refs":[reference],"comment":"保留这一段的节奏，暂不采纳。","operation_key":"select"}),
    ));
    assert_eq!(selection["effect"], "preference_only");
    assert_eq!(
        ok(call(&k, "documents.list", json!({})))["documents"],
        json!([])
    );
    let now = get(&k, &one);
    ok(call(
        &k,
        "creative_tasks.close",
        json!({"task_ref":one["task_ref"],"expected":now["expected"],"reason":"本次结束","operation_key":"close"}),
    ));
    assert_eq!(
        call(
            &a,
            "operations.get",
            json!({"action":"hetu.creative_tasks.submit_result","key":"submit"})
        )["error"]["code"],
        "forbidden"
    );
    assert!(Kernel::open(json!({"workspace_path":folder.path(),"mode":"agent","task_id":one["task_ref"]["task_id"]})).is_err());
    assert_eq!(get(&k, &one)["observation"]["state"], "closed");
}

#[test]
fn fixed_request_cas_pagination_and_inbox_manifest_fail_without_mutating_candidates() {
    let (folder, k) = project();
    let input = json!({"scope_ref":{"kind":k.scope_kind(),"id":k.scope()},"task_kind":"book_concept","brief":"想一个书名","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN"});
    let preview = ok(call(&k, "creative_tasks.preview_prompt", input));
    let before = ok(call(
        &k,
        "creation_projects.get",
        json!({"project_id":k.scope()}),
    ));
    ok(call(
        &k,
        "creation_projects.save",
        json!({"project_id":k.scope(),"expected":expected(&before),"brief":"作者改变想法","selected_fields":{},"operation_key":"change"}),
    ));
    let mut prepared = preview["prepare_input"].clone();
    prepared["operation_key"] = json!("stale");
    assert_eq!(
        call(&k, "creative_tasks.prepare", prepared)["error"]["code"],
        "revision_conflict"
    );
    let task = prepare(&k, "book_concept", json!([]), None);
    let inbox = folder.path().join(
        task["request"]["output_contract"]["relative_inbox"]
            .as_str()
            .unwrap(),
    );
    let raw = serde_json::to_vec(&submit_input(
        &task,
        json!([text_candidate("title", "河灯")]),
        "agent-file",
    ))
    .unwrap();
    fs::write(inbox.join("result.json"), &raw).unwrap();
    let digest = digest(&raw);
    let inspect = json!({"task_ref":task["task_ref"],"file_name":"result.json","manifest_sha256":digest,"operation_key":"inspect"});
    let result = ok(call(&k, "creative_tasks.inspect_inbox", inspect.clone()));
    assert_eq!(
        ok(call(&k, "creative_tasks.inspect_inbox", inspect)),
        result
    );
    let outside = json!({"task_ref":task["task_ref"],"file_name":"../request.json","manifest_sha256":digest,"operation_key":"escape"});
    assert_eq!(
        call(&k, "creative_tasks.inspect_inbox", outside)["error"]["code"],
        "invalid_input"
    );
    for _ in 0..2 {
        prepare(&k, "outline", json!([]), None);
    }
    let first = ok(call(&k, "creative_tasks.list", json!({"limit":1})));
    assert!(first["next_cursor"].is_string());
    prepare(&k, "cover", json!([]), None);
    assert_eq!(
        call(
            &k,
            "creative_tasks.list",
            json!({"limit":1,"cursor":first["next_cursor"]})
        )["error"]["code"],
        "cursor_invalid"
    );
}

#[test]
fn image_candidates_are_decoded_and_preserve_aspect_ratio_without_selecting_a_cover() {
    let (folder, k) = project();
    let task = prepare(&k, "cover", json!([]), None);
    let agent = agent(folder.path(), true, &task);
    let inbox = folder.path().join(
        task["request"]["output_contract"]["relative_inbox"]
            .as_str()
            .unwrap(),
    );
    let mut buffer = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(128, 192)
        .write_to(&mut buffer, image::ImageFormat::Png)
        .unwrap();
    fs::write(inbox.join("cover.png"), buffer.get_ref()).unwrap();
    let candidate = json!({"kind":"image","title":"封面一","source_format":"image","source_ref_indices":[],"file_name":"cover.png","sha256":digest(buffer.get_ref())});
    let result = ok(call(
        &agent,
        "creative_tasks.submit_result",
        submit_input(&task, json!([candidate.clone()]), "image"),
    ));
    let saved = &result["submission"]["candidates"][0];
    assert_eq!(saved["width"], 128);
    assert_eq!(saved["height"], 192);
    assert_eq!(saved["validation"], "decoded");
    let view = ok(call(
        &agent,
        "interactions.get",
        json!({"task_ref":task["task_ref"]}),
    ));
    assert_eq!(view["effect"], "preference_only");
    let preview = &view["image_previews"][0];
    assert_eq!(preview["candidate_id"], saved["candidate_id"]);
    assert_eq!(preview["width"], 128);
    assert_eq!(preview["height"], 192);
    assert_eq!(preview["media_type"], "image/jpeg");
    use base64::Engine;
    let jpeg = base64::engine::general_purpose::STANDARD
        .decode(preview["base64"].as_str().unwrap())
        .unwrap();
    assert!(jpeg.len() <= 256 * 1024);
    let decoded = image::load_from_memory(&jpeg).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (128, 192));
    assert!(decoded.to_rgb8().get_pixel(0, 0).0.iter().all(|channel| *channel >= 250));
    assert_eq!(
        fs::read(folder.path().join(saved["relative_path"].as_str().unwrap())).unwrap(),
        *buffer.get_ref()
    );
    fs::write(inbox.join("bad.png"), b"\x89PNG\r\n\x1a\nnot a real image").unwrap();
    let mut bad = candidate.clone();
    bad["file_name"] = json!("bad.png");
    bad["sha256"] = json!(digest(b"\x89PNG\r\n\x1a\nnot a real image"));
    assert_eq!(
        call(
            &agent,
            "creative_tasks.submit_result",
            submit_input(&task, json!([bad]), "broken-image")
        )["error"]["code"],
        "hetu.unsupported_media"
    );
    assert!(!folder.path().join("packages").exists());
    fs::write(
        folder.path().join(saved["relative_path"].as_str().unwrap()),
        b"modified image",
    )
    .unwrap();
    assert_ne!(
        call(
            &agent,
            "creative_tasks.get",
            json!({"task_ref":task["task_ref"]})
        )["status"],
        "succeeded"
    );
    assert_ne!(
        call(
            &agent,
            "interactions.get",
            json!({"task_ref":task["task_ref"]})
        )["status"],
        "succeeded"
    );
}

#[test]
fn artwork_images_have_a_separate_contract_and_cannot_replace_a_cover() {
    let (folder, author) = workspace();
    let task = prepare(&author, "artwork", json!([]), None);
    assert_eq!(task["request"]["skill_ref"]["name"], "hetu-artwork");
    assert_eq!(task["request"]["output_contract"]["artifact_types"], json!(["image"]));
    let reader = agent(folder.path(), false, &task);
    let inbox = folder.path().join(task["request"]["output_contract"]["relative_inbox"].as_str().unwrap());
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(240, 160).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    fs::write(inbox.join("location.png"), bytes.get_ref()).unwrap();
    let result = ok(call(&reader, "creative_tasks.submit_result", submit_input(&task,
        json!([{"kind":"image","title":"青石渡","source_format":"image","source_ref_indices":[],"file_name":"location.png","sha256":digest(bytes.get_ref())}]), "artwork")));
    let candidate = &result["submission"]["candidates"][0];
    let view = ok(call(&reader, "interactions.get", json!({"task_ref":task["task_ref"]})));
    assert_eq!(view["image_previews"][0]["width"], 240);
    assert_eq!(view["image_previews"][0]["height"], 160);
    assert_eq!(candidate["validation"], "decoded");
    // 图片候选不能借用封面选用动作，正文与已选封面都保持原样。
    let selected = call(&author, "covers.select", json!({"source":{"kind":"creative_task","reference":{"task_ref":task["task_ref"],"submission_id":result["submission"]["submission_id"],"candidate_id":candidate["candidate_id"]}},"expected_cover":null,"presentation":{"crop_rect":{"x":0,"y":0,"width":1,"height":1},"title_overlay":"","author_overlay":""},"operation_key":"reject-artwork-cover"}));
    assert_eq!(selected["error"]["code"], "forbidden");
    assert!(!folder.path().join("packages/visual-prompt/covers/cover.json").exists());
    assert!(ok(call(&author, "documents.list", json!({})))["documents"].as_array().unwrap().is_empty());
    let (_, project) = project();
    assert_ne!(call(&project, "creative_tasks.preview_prompt", json!({"scope_ref":{"kind":project.scope_kind(),"id":project.scope()},"task_kind":"artwork","brief":"仅正式作品可创建素材图任务","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN","candidate_limit":1}))["status"], "succeeded");
}

#[test]
fn workspace_agent_can_prepare_only_image_reference_tasks_without_author_powers() {
    let (folder, author) = workspace();
    let entry = Kernel::open(json!({"workspace_path":folder.path(),"mode":"agent"})).unwrap();
    for kind in ["cover", "artwork"] {
        let input = json!({"scope_ref":{"kind":"workspace","id":author.scope()},"task_kind":kind,"brief":"仅准备图片参考，不外发或更改作品。","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN","candidate_limit":1});
        let preview = ok(call(&entry, "image_tasks.preview_prompt", input.clone()));
        let mut prepare = preview["prepare_input"].clone();
        prepare["operation_key"] = json!(format!("machine-{kind}"));
        let saved = ok(call(&entry, "image_tasks.prepare", prepare.clone()));
        assert_eq!(ok(call(&entry, "image_tasks.prepare", prepare.clone())), saved);
        assert_eq!(saved["request"]["task_kind"], kind);
        assert_eq!(saved["request"]["output_contract"]["artifact_types"], json!(["image"]));
        let task = agent(folder.path(), false, &saved);
        assert_eq!(get(&task, &saved)["request_sha256"], saved["request_sha256"]);
        assert_eq!(call(&entry, "creative_tasks.prepare", prepare)["error"]["code"], "forbidden");
        assert_eq!(call(&task, "model_tasks.approve", json!({"task_ref":saved["task_ref"],"plan_id":"model_11111111-1111-4111-8111-111111111111","plan_sha256":"0".repeat(64),"provider_billing_accepted":true,"operation_key":"no-approval"}))["error"]["code"], "forbidden");
        let mut text_task = input.clone();
        text_task["task_kind"] = json!("chapter_draft");
        assert_eq!(call(&entry, "image_tasks.preview_prompt", text_task)["error"]["code"], "invalid_input");
        let mut edit = input.clone();
        edit["edit_scope"] = json!({});
        assert_eq!(call(&entry, "image_tasks.preview_prompt", edit)["error"]["code"], "invalid_input");
        let mut other = input;
        other["scope_ref"]["id"] = json!("workspace_11111111-1111-4111-8111-111111111111");
        assert_ne!(call(&entry, "image_tasks.preview_prompt", other)["status"], "succeeded");
    }
    assert!(ok(call(&author, "documents.list", json!({})))["documents"].as_array().unwrap().is_empty());
}

#[test]
fn insertion_permissions_reject_overlaps_and_context_does_not_grant_edit_rights() {
    let (folder, k) = workspace();
    let original = "桥头。\r\n🌿不改对白。";
    let doc = ok(call(
        &k,
        "documents.create",
        json!({"kind":"novel_chapter","title":"第一章","source_format":"markdown","content":original,"operation_key":"source"}),
    ));
    let other = ok(call(
        &k,
        "documents.create",
        json!({"kind":"novel_chapter","title":"背景章","source_format":"markdown","content":"仅供参考。","operation_key":"context"}),
    ));
    let refs = json!([{"kind":"document","document_id":doc["document"]["document_id"],"revision_id":doc["revision"]["revision_id"]},{"kind":"document","document_id":other["document"]["document_id"],"revision_id":other["revision"]["revision_id"]}]);
    let point = original.len();
    let task = prepare(
        &k,
        "revision",
        refs,
        Some(
            json!({"document_id":doc["document"]["document_id"],"revision_id":doc["revision"]["revision_id"],"ranges":[{"byte_start":point,"byte_end":point,"quote":""}]}),
        ),
    );
    assert_eq!(task["observation"], get(&k, &task)["observation"]);
    let a = agent(folder.path(), false, &task);
    let patch =
        json!({"byte_start":point,"byte_end":point,"quote":"","replacement":"\r\n只在章末添加。"});
    let candidate = json!({"kind":"text","title":"续写参考","source_format":"markdown","source_ref_indices":[0,1],"patches":[patch.clone()]});
    ok(call(
        &a,
        "creative_tasks.submit_result",
        submit_input(&task, json!([candidate.clone()]), "append"),
    ));
    assert_eq!(
        get(&a, &task)["submission"]["candidates"][0]["content"],
        format!("{original}\r\n只在章末添加。")
    );
    let mut duplicate = candidate.clone();
    duplicate["patches"] = json!([patch.clone(), patch]);
    assert_eq!(
        call(
            &a,
            "creative_tasks.submit_result",
            submit_input(&task, json!([duplicate]), "overlap")
        )["error"]["code"],
        "invalid_input"
    );
    let mut nul = candidate;
    nul["patches"][0]["replacement"] = json!("\0");
    assert_ne!(
        call(
            &a,
            "creative_tasks.submit_result",
            submit_input(&task, json!([nul]), "nul")
        )["status"],
        "succeeded"
    );
    assert_eq!(
        call(
            &a,
            "documents.save",
            json!({"document_id":other["document"]["document_id"],"base_revision_id":other["revision"]["revision_id"],"source_format":"markdown","content":"越权修改","operation_key":"edit-context"})
        )["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        ok(call(
            &k,
            "documents.get",
            json!({"document_id":other["document"]["document_id"]})
        ))["content"],
        "仅供参考。"
    );
}
