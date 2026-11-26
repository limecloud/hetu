use hetu_core::Kernel;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn call(kernel: &Kernel, action: &str, input: Value) -> Value {
    kernel.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(value: Value) -> Value {
    assert_eq!(value["status"], "succeeded", "{value}");
    value["data"].clone()
}
fn setup() -> (tempfile::TempDir, Kernel, Value, Value, Value) {
    let folder = tempfile::tempdir().unwrap();
    let kernel = Kernel::open(json!({"workspace_path":folder.path(),"mode":"author","create":{"title":"固定位置意见","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let work = ok(call(&kernel, "works.list", json!({})))["works"][0]["work_ref"].clone();
    let created = ok(call(
        &kernel,
        "documents.create",
        json!({"kind":"novel_chapter","title":"雾港","source_format":"markdown","content":"开篇🌿\r\n来信保留悬念。","operation_key":"document"}),
    ));
    let document = ok(call(
        &kernel,
        "documents.get",
        json!({"document_id":created["document"]["document_id"]}),
    ));
    let preview = ok(call(
        &kernel,
        "creative_tasks.preview_prompt",
        json!({"scope_ref":{"kind":"workspace","id":kernel.scope()},"work_ref":work,"task_kind":"chapter_draft","brief":"保留原资料，按意见完善参考稿。","input_refs":[{"kind":"document","document_id":document["document"]["document_id"],"revision_id":document["revision"]["revision_id"]}],"client_adapter":"codex","language_tag":"zh-CN"}),
    ));
    let mut input = preview["prepare_input"].clone();
    input["operation_key"] = json!("prepare");
    let task = ok(call(&kernel, "creative_tasks.prepare", input));
    (folder, kernel, work, document, task)
}
fn feedback(task: &Value, target: Value, head: Value, key: &str) -> Value {
    json!({"task_ref":task["task_ref"],"target_refs":[target],"expected_feedback_head":head,"intent":"request_changes","public_comment":"依据这处来信返工，保留结尾。","selected_refs":[],"operation_key":key})
}
fn range(content: &str) -> Value {
    let start = content.find("来信").unwrap();
    json!({"byte_start":start,"byte_end":start+"来信".len(),"quote":"来信"})
}

#[test]
fn long_review_keeps_fixed_submission_and_pages_original_candidate_without_body_transfer() {
    let (folder, author, _, _, task) = setup();
    let agent = Kernel::open(json!({"workspace_path":folder.path(),"mode":"agent","task_id":task["task_ref"]["task_id"]})).unwrap();
    let content = "江岚核对来信🌿，保留原著措辞。\r\n".repeat(5000);
    let submit = json!({"task_ref":task["task_ref"],"request_sha256":task["request_sha256"],"candidates":[{"kind":"text","title":"长参考稿","source_format":"markdown","source_ref_indices":[],"content":content}],"complete":true,"missing_items":[],"provenance":{"client":"long-review-test","skill_version":"1"},"operation_key":"long-review-first"});
    let first = ok(call(&agent, "creative_tasks.submit_result", submit.clone()));
    let mut next = submit;
    next["operation_key"] = json!("long-review-newer");
    next["candidates"][0]["content"] = json!("新版不能代替原批次。");
    ok(call(&agent, "creative_tasks.submit_result", next));
    let input = json!({"task_ref":task["task_ref"],"submission_id":first["submission"]["submission_id"],"detail":"review"});
    let review = ok(call(&agent, "interactions.get", input.clone()));
    assert!(serde_json::to_vec(&review).unwrap().len() < 16 * 1024);
    assert_eq!(
        review["submission_ref"]["submission_id"],
        first["submission"]["submission_id"]
    );
    assert_eq!(
        review["submission"]["candidates"][0]["sha256"],
        format!("{:x}", Sha256::digest(content.as_bytes()))
    );
    assert_eq!(
        review["submission"]["candidates"][0]["content_read_action"],
        "hetu.creative_tasks.read_candidate"
    );
    assert!(
        review["submission"]["candidates"][0]
            .get("content")
            .is_none()
    );
    assert!(review["request"].get("prompt").is_none());
    assert!(
        review["request"]["input_snapshot"]["sources"][0]
            .get("content")
            .is_none()
    );
    let mut automatic = input.clone();
    automatic.as_object_mut().unwrap().remove("detail");
    assert_eq!(
        ok(call(&agent, "interactions.get", automatic))["detail"],
        "review"
    );
    let paged = ok(call(
        &agent,
        "creative_tasks.read_candidate",
        json!({"task_ref":task["task_ref"],"candidate_ref":first["candidate_refs"][0],"range":{"byte_start":"江岚核对来信🌿，保留原著措辞。\r\n".len(),"byte_end":content.len()},"max_bytes":1024}),
    ));
    assert_eq!(
        paged["page"]["sha256"],
        review["submission"]["candidates"][0]["sha256"]
    );
    assert_eq!(
        paged["page"]["content"],
        &content["江岚核对来信🌿，保留原著措辞。\r\n".len()
            ..paged["page"]["range"]["byte_end"].as_u64().unwrap() as usize]
    );
    let mut projected = input;
    projected["result_path"] = json!("/submission_ref");
    projected["max_bytes"] = json!(1024);
    let fixed = ok(call(&agent, "interactions.get", projected.clone()));
    assert_eq!(fixed["task_page"]["value"], review["submission_ref"]);
    projected["expected_result_sha256"] = fixed["task_page_sha256"].clone();
    ok(call(
        &author,
        "task_feedback.save",
        feedback(
            &task,
            json!({"kind":"candidate","candidate_ref":first["candidate_refs"][0]}),
            Value::Null,
            "long-review-feedback",
        ),
    ));
    assert_eq!(
        call(&agent, "interactions.get", projected)["error"]["code"],
        "hetu.stale_evidence"
    );
}

#[test]
fn feedback_field_pages_keep_long_utf8_quotes_and_reject_changed_history() {
    let (folder, author, _, _, task) = setup();
    let agent = Kernel::open(json!({"workspace_path":folder.path(),"mode":"agent","task_id":task["task_ref"]["task_id"]})).unwrap();
    let content = "江🌿\r\n".repeat(2400);
    let working = ok(call(
        &agent,
        "working_copies.create",
        json!({"task_ref":task["task_ref"],"artifact_kind":"text","source_format":"markdown","title":"长意见原文","base_refs":[],"content":content,"operation_key":"history-working"}),
    ));
    let quote = "江🌿\r\n".repeat(1500);
    let targets:Vec<_>=(0..16).map(|index|json!({"kind":"working_copy","working_copy_ref":working["working_copy_ref"],"range":{"byte_start":index*9,"byte_end":index*9+quote.len(),"quote":quote}})).collect();
    let mut input = feedback(&task, targets[0].clone(), Value::Null, "history-large");
    input["target_refs"] = json!(targets);
    let saved = ok(call(&author, "task_feedback.save", input));
    let plain = ok(call(
        &agent,
        "task_feedback.list",
        json!({"task_ref":task["task_ref"],"limit":1}),
    ));
    assert!(serde_json::to_vec(&plain).unwrap().len() > 128 * 1024);
    let first = ok(call(
        &agent,
        "task_feedback.list",
        json!({"task_ref":task["task_ref"],"limit":1,"result_path":"","max_bytes":64}),
    ));
    let sha = first["feedback_page_sha256"].clone();
    let mut offset = 0;
    let mut actual = String::new();
    loop {
        let page = ok(call(
            &agent,
            "task_feedback.list",
            json!({"task_ref":task["task_ref"],"limit":1,"result_path":"/feedback/0/feedback/target_refs/0/range/quote","offset":offset,"max_bytes":64,"expected_result_sha256":sha}),
        ));
        let text = &page["feedback_page"]["page"];
        assert_eq!(text["range"]["byte_start"], offset);
        actual.push_str(text["content"].as_str().unwrap());
        if text["complete"] == true {
            break;
        }
        let next = text["next_range"]["byte_start"].as_u64().unwrap();
        assert!(next > offset);
        offset = next;
    }
    assert_eq!(actual, quote);
    let fixed = ok(call(
        &agent,
        "task_feedback.list",
        json!({"task_ref":task["task_ref"],"feedback_ref":saved["feedback_ref"],"result_path":"/feedback/0/feedback_ref","max_bytes":1024}),
    ));
    assert_eq!(fixed["feedback_page"]["value"], saved["feedback_ref"]);
    assert!(serde_json::to_vec(&fixed).unwrap().len() < 2048);
    let mut wrong = saved["feedback_ref"].clone();
    wrong["sha256"] = json!("0".repeat(64));
    assert_eq!(
        call(
            &agent,
            "task_feedback.list",
            json!({"task_ref":task["task_ref"],"feedback_ref":wrong})
        )["error"]["code"],
        "not_found"
    );
    ok(call(
        &author,
        "task_feedback.save",
        feedback(
            &task,
            targets[1].clone(),
            saved["feedback_ref"].clone(),
            "history-next",
        ),
    ));
    let changed = call(
        &agent,
        "task_feedback.list",
        json!({"task_ref":task["task_ref"],"limit":1,"result_path":"/feedback","max_bytes":64,"expected_result_sha256":sha}),
    );
    assert_eq!(changed["error"]["code"], "hetu.stale_evidence");
    assert_eq!(
        ok(call(
            &author,
            "task_feedback.list",
            json!({"task_ref":task["task_ref"]})
        ))["feedback"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn feedback_field_projection_preserves_original_list_cursor() {
    let (_folder, author, _, _, task) = setup();
    let target = json!({"kind":"context","context_ref":{"context_id":"context_0","sha256":task["request"]["input_snapshot"]["sources"][0]["sha256"]},"range":range("开篇🌿\r\n来信保留悬念。")});
    let mut head = Value::Null;
    for index in 0..3 {
        head = ok(call(
            &author,
            "task_feedback.save",
            feedback(&task, target.clone(), head, &format!("cursor-{index}")),
        ))["feedback_ref"]
            .clone();
    }
    let first = ok(call(
        &author,
        "task_feedback.list",
        json!({"task_ref":task["task_ref"],"limit":1}),
    ));
    let second = ok(call(
        &author,
        "task_feedback.list",
        json!({"task_ref":task["task_ref"],"limit":1,"after_cursor":first["next_cursor"],"result_path":"","max_bytes":8192}),
    ));
    assert_eq!(
        second["feedback_page"]["value"]["feedback"][0]["feedback"]["sequence"],
        2
    );
    let before = second["feedback_page_sha256"].clone();
    ok(call(
        &author,
        "task_feedback.save",
        feedback(&task, target, head, "cursor-appended"),
    ));
    assert_eq!(
        call(
            &author,
            "task_feedback.list",
            json!({"task_ref":task["task_ref"],"limit":1,"after_cursor":first["next_cursor"],"result_path":"","expected_result_sha256":before})
        )["error"]["code"],
        "cursor_invalid"
    );
}

fn image_task(author: &Kernel, folder: &std::path::Path, work: &Value) -> (Value, Kernel, Value) {
    let preview = ok(call(
        author,
        "creative_tasks.preview_prompt",
        json!({"scope_ref":{"kind":"workspace","id":author.scope()},"work_ref":work,"task_kind":"cover","brief":"固定图片区域意见","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN"}),
    ));
    let mut prepared = preview["prepare_input"].clone();
    prepared["operation_key"] = json!("image-prepare");
    let task = ok(call(author, "creative_tasks.prepare", prepared));
    let agent = Kernel::open(
        json!({"workspace_path":folder,"mode":"agent","task_id":task["task_ref"]["task_id"]}),
    )
    .unwrap();
    let mut image = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(128, 192)
        .write_to(&mut image, image::ImageFormat::Png)
        .unwrap();
    std::fs::write(
        folder
            .join(
                task["request"]["output_contract"]["relative_inbox"]
                    .as_str()
                    .unwrap(),
            )
            .join("region.png"),
        image.get_ref(),
    )
    .unwrap();
    let input = json!({"task_ref":task["task_ref"],"request_sha256":task["request_sha256"],"candidates":[{"kind":"image","title":"人物原图","source_format":"image","source_ref_indices":[],"file_name":"region.png","sha256":format!("{:x}",Sha256::digest(image.get_ref()))}],"complete":true,"missing_items":[],"provenance":{"client":"image-region-test","skill_version":"1"},"operation_key":"image-first"});
    (task, agent, input)
}

#[test]
fn candidate_feedback_history_filters_original_references_without_renumbering() {
    let (folder, author, work, _, other_task) = setup();
    let (task, agent, submit) = image_task(&author, folder.path(), &work);
    let first = ok(call(&agent, "creative_tasks.submit_result", submit.clone()));
    let mut revised = submit;
    revised["operation_key"] = json!("filter-second-batch");
    let second = ok(call(&agent, "creative_tasks.submit_result", revised));
    let original = first["candidate_refs"][0].clone();
    let newer = second["candidate_refs"][0].clone();
    let mut head = Value::Null;
    for (index, candidate) in [&original, &newer, &original].into_iter().enumerate() {
        head = ok(call(
            &author,
            "task_feedback.save",
            feedback(
                &task,
                json!({"kind":"candidate","candidate_ref":candidate}),
                head,
                &format!("filter-{index}"),
            ),
        ))["feedback_ref"]
            .clone();
    }
    let page = ok(call(
        &agent,
        "task_feedback.list",
        json!({"task_ref":task["task_ref"],"candidate_ref":original,"limit":1}),
    ));
    assert_eq!(page["feedback"][0]["feedback"]["sequence"], 1);
    let fixed_ref = page["feedback"][0]["feedback_ref"].clone();
    let fixed = ok(call(
        &agent,
        "task_feedback.list",
        json!({"task_ref":task["task_ref"],"feedback_ref":fixed_ref,"candidate_ref":original}),
    ));
    assert_eq!(fixed["feedback"].as_array().unwrap().len(), 1);
    assert_eq!(fixed["feedback"][0]["feedback"]["sequence"], 1);
    assert_eq!(
        ok(call(
            &agent,
            "task_feedback.list",
            json!({"task_ref":task["task_ref"],"feedback_ref":fixed_ref,"candidate_ref":newer})
        ))["feedback"],
        json!([])
    );
    assert_eq!(
        call(
            &author,
            "task_feedback.list",
            json!({"task_ref":other_task["task_ref"],"feedback_ref":fixed_ref})
        )["error"]["code"],
        "not_found"
    );
    assert_eq!(
        call(
            &agent,
            "task_feedback.list",
            json!({"task_ref":task["task_ref"],"candidate_ref":original,"feedback_ref":fixed_ref,"after_cursor":page["next_cursor"]})
        )["error"]["code"],
        "cursor_invalid"
    );
    let last = ok(call(
        &agent,
        "task_feedback.list",
        json!({"task_ref":task["task_ref"],"candidate_ref":original,"limit":1,"after_cursor":page["next_cursor"],"result_path":"","max_bytes":8192}),
    ));
    assert_eq!(
        last["feedback_page"]["value"]["feedback"][0]["feedback"]["sequence"],
        3
    );
    assert_eq!(
        ok(call(
            &agent,
            "task_feedback.list",
            json!({"task_ref":task["task_ref"],"candidate_ref":newer})
        ))["feedback"][0]["feedback"]["sequence"],
        2
    );
    assert_eq!(
        call(
            &agent,
            "task_feedback.list",
            json!({"task_ref":task["task_ref"],"candidate_ref":newer,"after_cursor":page["next_cursor"]})
        )["error"]["code"],
        "cursor_invalid"
    );
    let mut foreign = original;
    foreign["task_ref"] = other_task["task_ref"].clone();
    assert_eq!(
        call(
            &agent,
            "task_feedback.list",
            json!({"task_ref":task["task_ref"],"candidate_ref":foreign})
        )["error"]["code"],
        "forbidden"
    );
    // 回看公开意见只核对固定清单，不重新读取原图字节。
    std::fs::remove_file(
        folder.path().join(
            first["submission"]["candidates"][0]["relative_path"]
                .as_str()
                .unwrap(),
        ),
    )
    .unwrap();
    let preserved = ok(call(
        &agent,
        "task_feedback.list",
        json!({"task_ref":task["task_ref"],"candidate_ref":first["candidate_refs"][0]}),
    ));
    assert_eq!(preserved["feedback"].as_array().unwrap().len(), 2);
}

#[test]
fn image_region_feedback_keeps_original_pixels_and_continues_original_task() {
    let (folder, author, work, document, _) = setup();
    let (task, agent, submit) = image_task(&author, folder.path(), &work);
    let first = ok(call(&agent, "creative_tasks.submit_result", submit.clone()));
    let target = json!({"kind":"candidate","candidate_ref":first["candidate_refs"][0]});
    let whole = ok(call(
        &author,
        "task_feedback.save",
        feedback(&task, target.clone(), Value::Null, "whole-image"),
    ));
    assert_eq!(whole["feedback"]["schema_version"], "1.0.0");
    let mut region = target;
    region["image_region"] = json!({"x":12,"y":48,"width":40,"height":64});
    let input = feedback(
        &task,
        region.clone(),
        whole["feedback_ref"].clone(),
        "image-region",
    );
    let saved = ok(call(&author, "task_feedback.save", input.clone()));
    assert_eq!(saved["feedback"]["schema_version"], "1.2.0");
    assert_eq!(saved["feedback"]["target_refs"], json!([region]));
    assert_eq!(
        ok(call(&author, "task_feedback.save", input.clone())),
        saved
    );
    let mut changed = input;
    changed["target_refs"][0]["image_region"]["x"] = json!(13);
    assert_ne!(
        call(&author, "task_feedback.save", changed)["status"],
        "succeeded"
    );
    let mut revised = submit;
    revised["operation_key"] = json!("image-revised");
    revised["feedback_refs"] = json!([saved["feedback_ref"]]);
    let next = ok(call(&agent, "creative_tasks.submit_result", revised));
    assert_ne!(next["candidate_refs"][0], first["candidate_refs"][0]);
    drop(agent);
    let reopened=Kernel::open(json!({"workspace_path":folder.path(),"mode":"agent","task_id":task["task_ref"]["task_id"]})).unwrap();
    let history = ok(call(
        &reopened,
        "task_feedback.list",
        json!({"task_ref":task["task_ref"]}),
    ));
    assert_eq!(history["feedback"].as_array().unwrap().len(), 2);
    assert_eq!(
        history["feedback"][1]["feedback"]["target_refs"],
        json!([region])
    );
    assert!(
        !history["feedback"][1]["reported_result_refs"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        ok(call(
            &author,
            "documents.get",
            json!({"document_id":document["document"]["document_id"]})
        ))["revision"],
        document["revision"]
    );
    let old = ok(call(
        &author,
        "interactions.get",
        json!({"task_ref":task["task_ref"],"submission_id":first["submission"]["submission_id"]}),
    ));
    assert_eq!(old["submission"], first["submission"]);
}

#[test]
fn invalid_image_regions_and_text_targets_do_not_append_feedback() {
    let (folder, author, work, _, text_task) = setup();
    let (task, agent, submit) = image_task(&author, folder.path(), &work);
    let submitted = ok(call(&agent, "creative_tasks.submit_result", submit));
    let target = json!({"kind":"candidate","candidate_ref":submitted["candidate_refs"][0]});
    for (index, region) in [
        json!({"x":-1,"y":0,"width":1,"height":1}),
        json!({"x":0.5,"y":0,"width":1,"height":1}),
        json!({"x":0,"y":0,"width":0,"height":1}),
        json!({"x":127,"y":0,"width":2,"height":1}),
        json!({"x":0,"y":191,"width":1,"height":2}),
        json!({"x":0,"y":0,"width":129,"height":192}),
    ]
    .into_iter()
    .enumerate()
    {
        let mut bad = target.clone();
        bad["image_region"] = region;
        assert_ne!(
            call(
                &author,
                "task_feedback.save",
                feedback(&task, bad, Value::Null, &format!("bad-image-{index}"))
            )["status"],
            "succeeded"
        );
    }
    let mut both = target.clone();
    both["image_region"] = json!({"x":0,"y":0,"width":1,"height":1});
    both["range"] = json!({"byte_start":0,"byte_end":3,"quote":"字"});
    assert_ne!(
        call(
            &author,
            "task_feedback.save",
            feedback(&task, both, Value::Null, "both-ranges")
        )["status"],
        "succeeded"
    );
    let text_agent=Kernel::open(json!({"workspace_path":folder.path(),"mode":"agent","task_id":text_task["task_ref"]["task_id"]})).unwrap();
    let text = ok(call(
        &text_agent,
        "creative_tasks.submit_result",
        json!({"task_ref":text_task["task_ref"],"request_sha256":text_task["request_sha256"],"candidates":[{"kind":"text","title":"原文","source_format":"markdown","source_ref_indices":[],"content":"原文不接受图片坐标。"}],"complete":true,"missing_items":[],"provenance":{"client":"range-test","skill_version":"1"},"operation_key":"text-submit"}),
    ));
    let wrong = json!({"kind":"candidate","candidate_ref":text["candidate_refs"][0],"image_region":{"x":0,"y":0,"width":1,"height":1}});
    assert_ne!(
        call(
            &author,
            "task_feedback.save",
            feedback(&text_task, wrong, Value::Null, "text-image")
        )["status"],
        "succeeded"
    );
    let mut valid = target;
    valid["image_region"] = json!({"x":0,"y":0,"width":128,"height":192});
    let saved = ok(call(
        &author,
        "task_feedback.save",
        feedback(&task, valid.clone(), Value::Null, "valid-edge"),
    ));
    assert_eq!(saved["feedback"]["sequence"], 1);
    assert_ne!(
        call(
            &author,
            "task_feedback.save",
            feedback(&task, valid, Value::Null, "stale-image")
        )["status"],
        "succeeded"
    );
    assert_eq!(
        ok(call(
            &author,
            "task_feedback.list",
            json!({"task_ref":task["task_ref"]})
        ))["feedback"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn source_working_and_candidate_ranges_keep_original_bytes_and_continue_one_task() {
    let (folder, author, _, document, task) = setup();
    let agent = Kernel::open(json!({"workspace_path":folder.path(),"mode":"agent","task_id":task["task_ref"]["task_id"]})).unwrap();
    let source_target = json!({"kind":"context","context_ref":{"context_id":"context_0","sha256":task["request"]["input_snapshot"]["sources"][0]["sha256"]},"range":range(document["content"].as_str().unwrap())});
    let first = ok(call(
        &author,
        "task_feedback.save",
        feedback(&task, source_target.clone(), Value::Null, "source-feedback"),
    ));
    assert_eq!(first["feedback"]["schema_version"], "1.1.0");
    assert_eq!(first["feedback"]["target_refs"], json!([source_target]));
    let advanced = ok(call(
        &author,
        "documents.save",
        json!({"document_id":document["document"]["document_id"],"base_revision_id":document["revision"]["revision_id"],"source_format":"markdown","content":"新稿不把旧位置套来。","operation_key":"advance-source"}),
    ));
    let content = "起笔🌿\r\n来信仍有悬念。";
    let working = ok(call(
        &agent,
        "working_copies.create",
        json!({"task_ref":task["task_ref"],"artifact_kind":"text","source_format":"markdown","title":"原参考稿","base_refs":[],"feedback_refs":[first["feedback_ref"]],"content":content,"operation_key":"working"}),
    ));
    let working_target = json!({"kind":"working_copy","working_copy_ref":working["working_copy_ref"],"range":range(content)});
    let second = ok(call(
        &author,
        "task_feedback.save",
        feedback(
            &task,
            working_target.clone(),
            first["feedback_ref"].clone(),
            "working-feedback",
        ),
    ));
    let submission = ok(call(
        &agent,
        "creative_tasks.submit_result",
        json!({"task_ref":task["task_ref"],"request_sha256":task["request_sha256"],"working_copy_refs":[working["working_copy_ref"]],"feedback_refs":[first["feedback_ref"]],"complete":true,"missing_items":[],"provenance":{"client":"range-test","skill_version":"1"},"operation_key":"submit"}),
    ));
    let candidate_target = json!({"kind":"candidate","candidate_ref":submission["candidate_refs"][0],"range":range(content)});
    let input = feedback(
        &task,
        candidate_target.clone(),
        second["feedback_ref"].clone(),
        "candidate-feedback",
    );
    let third = ok(call(&author, "task_feedback.save", input.clone()));
    assert_eq!(ok(call(&author, "task_feedback.save", input)), third);
    let revised = ok(call(
        &agent,
        "working_copies.save",
        json!({"task_ref":task["task_ref"],"working_copy_id":working["working_copy_ref"]["working_copy_id"],"expected":working["working_copy_ref"],"content":"来信依旧难辨真伪。","feedback_refs":[second["feedback_ref"],third["feedback_ref"]],"operation_key":"revise"}),
    ));
    assert_ne!(revised["working_copy_ref"], working["working_copy_ref"]);
    drop(agent);
    let reopened = Kernel::open(json!({"workspace_path":folder.path(),"mode":"agent","task_id":task["task_ref"]["task_id"]})).unwrap();
    let history = ok(call(
        &reopened,
        "task_feedback.list",
        json!({"task_ref":task["task_ref"]}),
    ));
    assert_eq!(history["feedback"].as_array().unwrap().len(), 3);
    assert_eq!(
        history["feedback"][0]["feedback"]["target_refs"],
        json!([source_target])
    );
    assert_eq!(
        history["feedback"][1]["feedback"]["target_refs"],
        json!([working_target])
    );
    assert_eq!(
        history["feedback"][2]["feedback"]["target_refs"],
        json!([candidate_target])
    );
    assert_eq!(
        ok(call(
            &author,
            "documents.get",
            json!({"document_id":document["document"]["document_id"]})
        ))["revision"],
        advanced["revision"]
    );
}

#[test]
fn invalid_text_positions_and_contexts_do_not_append_feedback_or_expand_reading() {
    let (_folder, author, _, document, task) = setup();
    let target = json!({"kind":"context","context_ref":{"context_id":"context_0","sha256":task["request"]["input_snapshot"]["sources"][0]["sha256"]},"range":range(document["content"].as_str().unwrap())});
    for (index, patch) in [
        json!({"range":{"byte_start":0,"byte_end":0,"quote":""}}),
        json!({"range":{"byte_start":7,"byte_end":10,"quote":"🌿"}}),
        json!({"range":{"byte_start":0,"byte_end":6,"quote":"其他"}}),
        json!({"range":{"byte_start":0,"byte_end":9999999,"quote":"越界"}}),
        json!({"range":{"byte_start":0,"byte_end":20000,"quote":"超预算"}}),
        json!({"context_ref":{"context_id":"context_9","sha256":target["context_ref"]["sha256"]}}),
        json!({"context_ref":{"context_id":"context_0","sha256":"0".repeat(64)}}),
    ]
    .into_iter()
    .enumerate()
    {
        let mut changed = target.clone();
        for (key, value) in patch.as_object().unwrap() {
            changed[key] = value.clone();
        }
        assert_ne!(
            call(
                &author,
                "task_feedback.save",
                feedback(&task, changed, Value::Null, &format!("bad-{index}"))
            )["status"],
            "succeeded"
        );
    }
    let first = ok(call(
        &author,
        "task_feedback.save",
        feedback(&task, target.clone(), Value::Null, "valid"),
    ));
    let conflict = call(
        &author,
        "task_feedback.save",
        feedback(&task, target, Value::Null, "stale-head"),
    );
    assert_eq!(conflict["error"]["code"], "revision_conflict");
    let history = ok(call(
        &author,
        "task_feedback.list",
        json!({"task_ref":task["task_ref"]}),
    ));
    assert_eq!(history["feedback"].as_array().unwrap().len(), 1);
    assert_eq!(history["feedback_head"], first["feedback_ref"]);
}

#[test]
fn candidate_and_working_ranges_reject_wrong_quotes_boundaries_and_oversized_passages() {
    let (folder, author, _, _, task) = setup();
    let agent = Kernel::open(json!({"workspace_path":folder.path(),"mode":"agent","task_id":task["task_ref"]["task_id"]})).unwrap();
    let content = format!("来信🌿\r\n{}", "字".repeat(6000));
    let working = ok(call(
        &agent,
        "working_copies.create",
        json!({"task_ref":task["task_ref"],"artifact_kind":"text","source_format":"markdown","title":"长参考稿","base_refs":[],"content":content,"operation_key":"long-working"}),
    ));
    let submission = ok(call(
        &agent,
        "creative_tasks.submit_result",
        json!({"task_ref":task["task_ref"],"request_sha256":task["request_sha256"],"working_copy_refs":[working["working_copy_ref"]],"feedback_refs":[],"complete":true,"missing_items":[],"provenance":{"client":"range-test","skill_version":"1"},"operation_key":"long-submit"}),
    ));
    for (index, base) in [
        json!({"kind":"working_copy","working_copy_ref":working["working_copy_ref"]}),
        json!({"kind":"candidate","candidate_ref":submission["candidate_refs"][0]}),
    ]
    .into_iter()
    .enumerate()
    {
        for (case, range) in [
            json!({"byte_start":0,"byte_end":0,"quote":""}),
            json!({"byte_start":7,"byte_end":10,"quote":"🌿"}),
            json!({"byte_start":0,"byte_end":6,"quote":"不同"}),
            json!({"byte_start":12,"byte_end":18012,"quote":"字".repeat(6000)}),
        ]
        .into_iter()
        .enumerate()
        {
            let mut target = base.clone();
            target["range"] = range;
            assert_ne!(
                call(
                    &author,
                    "task_feedback.save",
                    feedback(
                        &task,
                        target,
                        Value::Null,
                        &format!("bad-target-{index}-{case}")
                    )
                )["status"],
                "succeeded"
            );
        }
    }
    assert_eq!(
        ok(call(
            &author,
            "task_feedback.list",
            json!({"task_ref":task["task_ref"]})
        ))["feedback"],
        json!([])
    );
}
