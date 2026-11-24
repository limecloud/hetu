use hetu_core::Kernel;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(result: Value) -> Value {
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn setup() -> (tempfile::TempDir, Kernel, Value) {
    let root = tempfile::tempdir().unwrap();
    let k = Kernel::open(json!({"workspace_path":root.path(),"mode":"author","create":{"title":"文稿移动","locale":"zh-CN","operation_key":"initialize"}})).unwrap();
    let work = ok(call(&k, "works.list", json!({})))["works"][0]["work_ref"].clone();
    (root, k, work)
}
fn chapter(k: &Kernel, title: &str, content: &str) -> Value {
    ok(call(
        k,
        "documents.create",
        json!({"kind":"novel_chapter","title":title,"source_format":"markdown","language_tag":"zh-CN","content":content,"operation_key":title}),
    ))
}
fn reference(value: &Value) -> Value {
    json!({"document_id":value["document"]["document_id"],"revision_id":value["revision"]["revision_id"],"sha256":value["revision"]["sha256"]})
}
fn read(k: &Kernel, value: &Value) -> Value {
    ok(call(
        k,
        "documents.get",
        json!({"document_id":value["document"]["document_id"]}),
    ))
}
fn fixed(work: &Value, source: &Value, target: &Value, content: &str, quote: &str) -> Value {
    let start = content.find(quote).unwrap();
    json!({"work_ref":work,"source_ref":reference(source),"target_ref":reference(target),"byte_start":start,"byte_end":start + quote.len(),"quote":quote,"operation_key":"move"})
}

#[test]
fn moves_exact_source_bytes_in_one_operation_and_restores_both_after_reopen() {
    let (root, k, work) = setup();
    let content = "前🌿\r\n\r\n**乙**\n\n第二段。\r\n\r\n后\r";
    let quote = "**乙**\n\n第二段。";
    let source = chapter(&k, "来源", content);
    let target = chapter(&k, "目标", "原文\r\n");
    let input = fixed(&work, &source, &target, content, quote);
    let moved = ok(call(&k, "documents.move_range", input.clone()));
    let record = ok(call(
        &k,
        "documents.get_move",
        json!({"work_ref":work,"move_ref":moved["move_ref"]}),
    ));
    assert_eq!(record["move"]["source_before"], reference(&source));
    assert_eq!(record["move"]["target_after"], reference(&moved["target"]));
    assert_eq!(
        record["move"]["source_range"]["sha256"],
        format!("{:x}", Sha256::digest(quote.as_bytes()))
    );
    assert_eq!(read(&k, &source)["content"], "前🌿\r\n\r\n后\r");
    assert_eq!(
        read(&k, &target)["content"],
        "原文\r\n\r\n**乙**\n\n第二段。"
    );
    assert_eq!(moved["target_range"]["byte_start"], "原文\r\n\r\n".len());
    assert_ne!(
        moved["source"]["revision"]["revision_id"],
        source["revision"]["revision_id"]
    );
    assert_eq!(
        moved["source"]["revision"]["parent_revision_id"],
        source["revision"]["revision_id"]
    );
    assert_eq!(
        moved["target"]["revision"]["parent_revision_id"],
        target["revision"]["revision_id"]
    );
    drop(k);
    let k = Kernel::open(json!({"workspace_path":root.path(),"mode":"author"})).unwrap();
    assert_eq!(ok(call(&k, "documents.move_range", input.clone())), moved);
    let restore = json!({"work_ref":work,"move_ref":moved["move_ref"],"operation_key":"restore"});
    let restored = ok(call(&k, "documents.restore_move", restore.clone()));
    assert_eq!(read(&k, &source)["content"], content);
    assert_eq!(read(&k, &target)["content"], "原文\r\n");
    assert_ne!(
        restored["source"]["revision"]["revision_id"],
        source["revision"]["revision_id"]
    );
    assert_eq!(ok(call(&k, "documents.restore_move", restore)), restored);
    let mut changed = input;
    changed["quote"] = json!("另一句");
    assert_ne!(
        call(&k, "documents.move_range", changed)["status"],
        "succeeded"
    );
    assert_eq!(
        ok(call(&k, "documents.list", json!({})))["documents"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn stale_source_or_target_and_invalid_span_never_write_either_document() {
    let (_root, k, work) = setup();
    let content = "一🌿\r\n\r\n二\r\n尾";
    let source = chapter(&k, "来源", content);
    let target = chapter(&k, "目标", "目标");
    let valid = fixed(&work, &source, &target, content, "二");
    for (name, start, end, quote) in [
        ("utf8", 1, 3, "错"),
        ("partial", 0, 3, "一"),
        ("crlf", 8, 10, "\n\r"),
        ("quote", 11, 14, "错"),
    ] {
        let mut input = valid.clone();
        input["operation_key"] = json!(name);
        input["byte_start"] = json!(start);
        input["byte_end"] = json!(end);
        input["quote"] = json!(quote);
        assert_ne!(
            call(&k, "documents.move_range", input)["status"],
            "succeeded"
        );
        assert_eq!(read(&k, &source)["revision"], source["revision"]);
        assert_eq!(read(&k, &target)["revision"], target["revision"]);
    }
    let mut same = valid.clone();
    same["target_ref"] = reference(&source);
    same["operation_key"] = json!("same");
    assert_ne!(
        call(&k, "documents.move_range", same)["status"],
        "succeeded"
    );
    let newer = ok(call(
        &k,
        "documents.save",
        json!({"document_id":target["document"]["document_id"],"base_revision_id":target["revision"]["revision_id"],"source_format":"markdown","content":"目标新版","operation_key":"concurrent"}),
    ));
    assert_eq!(
        call(&k, "documents.move_range", valid.clone())["error"]["code"],
        "revision_conflict"
    );
    assert_eq!(read(&k, &source)["revision"], source["revision"]);
    let mut bad = valid;
    bad["target_ref"] = reference(&newer);
    bad["source_ref"]["sha256"] = json!("0".repeat(64));
    bad["operation_key"] = json!("digest");
    assert_eq!(
        call(&k, "documents.move_range", bad)["error"]["code"],
        "hetu.integrity_failure"
    );
    assert_eq!(read(&k, &target)["revision"], newer["revision"]);
}

#[test]
fn target_conflict_prevents_both_sides_of_restore_and_bad_record_is_rejected() {
    let (_root, k, work) = setup();
    let source = chapter(&k, "来源", "前\n\n末🌿");
    let target = chapter(&k, "目标", "");
    let moved = ok(call(
        &k,
        "documents.move_range",
        fixed(&work, &source, &target, "前\n\n末🌿", "末🌿"),
    ));
    assert_eq!(read(&k, &source)["content"], "前");
    assert_eq!(read(&k, &target)["content"], "末🌿");
    let restore = json!({"work_ref":work,"move_ref":moved["move_ref"],"operation_key":"restore"});
    let mut bad = restore.clone();
    bad["move_ref"]["sha256"] = json!("0".repeat(64));
    assert_eq!(
        call(&k, "documents.restore_move", bad)["error"]["code"],
        "hetu.integrity_failure"
    );
    let updated = ok(call(
        &k,
        "documents.save",
        json!({"document_id":target["document"]["document_id"],"base_revision_id":moved["target"]["revision"]["revision_id"],"source_format":"markdown","content":"目标的后续改动","operation_key":"edit"}),
    ));
    assert_eq!(
        call(&k, "documents.restore_move", restore)["error"]["code"],
        "revision_conflict"
    );
    assert_eq!(read(&k, &source)["revision"], moved["source"]["revision"]);
    assert_eq!(read(&k, &target)["revision"], updated["revision"]);
}

#[test]
fn foreign_work_and_foreign_document_are_rejected() {
    let (_root, k, work) = setup();
    let source = chapter(&k, "来源", "原文");
    let target = chapter(&k, "目标", "目标");
    let mut input = fixed(&work, &source, &target, "原文", "原文");
    let (_foreign_root, _foreign, foreign_work) = setup();
    input["work_ref"] = foreign_work;
    assert_eq!(
        call(&k, "documents.move_range", input)["error"]["code"],
        "forbidden"
    );
    assert_eq!(read(&k, &source)["content"], "原文");
    assert_eq!(read(&k, &target)["content"], "目标");
}

#[test]
fn oversized_target_rolls_back_already_staged_source_revision() {
    let (_root, k, work) = setup();
    let content = "甲".repeat(2_000_000);
    let source = chapter(&k, "来源", &content);
    let target = chapter(&k, "目标", &"乙".repeat(2_000_000));
    let rejected = call(
        &k,
        "documents.move_range",
        fixed(&work, &source, &target, &content, &content),
    );
    assert_ne!(rejected["status"], "succeeded");
    assert_eq!(read(&k, &source)["revision"], source["revision"]);
    assert_eq!(read(&k, &target)["revision"], target["revision"]);
}

#[test]
fn full_document_and_head_range_preserve_existing_target_separators() {
    for (index, content, quote, destination, remaining, expected) in [
        (0, "完整🌿", "完整🌿", "原\r\n\n", "", "原\r\n\n完整🌿"),
        (1, "首\r\n\r\n末", "首", "原\r", "末", "原\r\r首"),
    ] {
        let (_root, k, work) = setup();
        let source = chapter(&k, &format!("来源{index}"), content);
        let target = chapter(&k, &format!("目标{index}"), destination);
        ok(call(
            &k,
            "documents.move_range",
            fixed(&work, &source, &target, content, quote),
        ));
        assert_eq!(read(&k, &source)["content"], remaining);
        assert_eq!(read(&k, &target)["content"], expected);
    }
}

#[test]
fn drama_moves_fountain_without_changing_directory_plan_or_archived_episode() {
    let (_root, k, novel_work) = setup();
    let project = ok(call(
        &k,
        "drama.projects.create",
        json!({"title":"分集移动","mode":"original","operation_key":"project"}),
    ));
    let project_ref = |v: &Value| json!({"project_id":v["project"]["project_id"],"revision":v["project"]["revision"],"sha256":v["sha256"]});
    let first = ok(call(
        &k,
        "drama.episodes.create",
        json!({"project_ref":project_ref(&project),"title":"第一集","plan":"保留原计划。","language_tag":"zh-CN","operation_key":"first"}),
    ));
    let second = ok(call(
        &k,
        "drama.episodes.create",
        json!({"project_ref":project_ref(&first),"title":"第二集","language_tag":"zh-CN","operation_key":"second"}),
    ));
    let save = |doc: &Value, content: &str, key: &str| {
        ok(call(
            &k,
            "documents.save",
            json!({"document_id":doc["document"]["document_id"],"base_revision_id":doc["document_revision"]["revision_id"],"source_format":"fountain","content":content,"operation_key":key}),
        ))
    };
    let source = save(&first, "INT. 车站 - 夜\r\n\r\n阿青\r\n我回来了。", "source");
    let target = read(&k, &second);
    let work = json!({"workspace_id":k.scope(),"kind":"drama","object_id":project["project"]["project_id"]});
    let input = fixed(
        &work,
        &source,
        &target,
        "INT. 车站 - 夜\r\n\r\n阿青\r\n我回来了。",
        "阿青\r\n我回来了。",
    );
    let novel = chapter(&k, "同根小说", "其他作品");
    let mut foreign = input.clone();
    foreign["target_ref"] = reference(&novel);
    foreign["operation_key"] = json!("foreign-document");
    assert_eq!(
        call(&k, "documents.move_range", foreign)["error"]["code"],
        "forbidden"
    );
    let moved = ok(call(&k, "documents.move_range", input));
    assert_eq!(read(&k, &source)["content"], "INT. 车站 - 夜");
    assert_eq!(read(&k, &target)["content"], "阿青\r\n我回来了。");
    assert_eq!(
        ok(call(
            &k,
            "drama.projects.get",
            json!({"project_id":work["object_id"]})
        ))["project"],
        second["project"]
    );
    let episode = ok(call(
        &k,
        "drama.episodes.get",
        json!({"episode_id":second["episode"]["episode_id"]}),
    ));
    ok(call(
        &k,
        "drama.episodes.update",
        json!({"project_ref":episode["project_ref"],"episode_id":episode["episode"]["episode_id"],
        "expected":{"revision":episode["episode"]["revision"],"sha256":episode["sha256"]},"title":"第二集","plan":"","archived":true,"operation_key":"archive"}),
    ));
    let restore = json!({"work_ref":work,"move_ref":moved["move_ref"],"operation_key":"restore"});
    assert_eq!(
        call(&k, "documents.restore_move", restore)["error"]["code"],
        "forbidden"
    );
    assert_eq!(read(&k, &source)["revision"], moved["source"]["revision"]);
    assert_eq!(read(&k, &novel)["content"], "其他作品");
    assert_eq!(novel_work["kind"], "novel");
}

#[test]
fn moves_to_new_novel_chapter_atomically_and_restores_by_archiving_target() {
    let (_root, k, work) = setup();
    let content = "开头🌿\n\n中段\n\n结尾";
    let source = chapter(&k, "来源", content);
    let novel = ok(call(&k, "novels.get", json!({})));
    let input = json!({
        "work_ref": work,
        "source_ref": reference(&source),
        "expected": {"revision": novel["revision"], "sha256": novel["sha256"]},
        "new_target": {"title":"新章节", "volume_id":null},
        "byte_start": "开头🌿\n\n".len(),
        "byte_end": "开头🌿\n\n中段".len(),
        "quote":"中段",
        "operation_key":"move-new-novel"
    });
    let moved = ok(call(&k, "documents.move_to_new", input.clone()));
    assert_eq!(read(&k, &source)["content"], "开头🌿\n\n结尾");
    let target = read(&k, &moved["target"]);
    assert_eq!(target["content"], "中段");
    assert_eq!(target["document"]["title"], "新章节");
    let record = ok(call(&k, "documents.get_move", json!({"work_ref":work,"move_ref":moved["move_ref"]})));
    assert_eq!(record["move"]["target_created"], true);
    assert_eq!(ok(call(&k, "documents.move_to_new", input)), moved);
    let restored = ok(call(&k, "documents.restore_move", json!({"work_ref":work,"move_ref":moved["move_ref"],"operation_key":"restore-new-novel"})));
    assert_eq!(read(&k, &source)["content"], content);
    assert_eq!(read(&k, &target)["content"], "中段");
    assert_eq!(read(&k, &target)["document"]["archived"], true);
    assert_eq!(ok(call(&k, "documents.list", json!({"work_ref":work})))["documents"].as_array().unwrap().len(), 1);
    assert_eq!(restored["source"]["revision"]["parent_revision_id"], moved["source"]["revision"]["revision_id"]);
}

#[test]
fn moves_to_new_drama_episode_and_restores_project_directory() {
    let (_root, k, _novel_work) = setup();
    let project = ok(call(&k, "drama.projects.create", json!({"title":"新分集移动","mode":"original","operation_key":"new-project"})));
    let project_ref = |v: &Value| json!({"project_id":v["project"]["project_id"],"revision":v["project"]["revision"],"sha256":v["sha256"]});
    let first = ok(call(&k, "drama.episodes.create", json!({"project_ref":project_ref(&project),"title":"来源集","plan":"原计划","language_tag":"zh-CN","operation_key":"new-first"})));
    let source = ok(call(&k, "documents.save", json!({"document_id":first["document"]["document_id"],"base_revision_id":first["document_revision"]["revision_id"],"source_format":"fountain","content":"INT. 房间 - 夜\n\n甲\n移动台词\n\n乙","operation_key":"new-source"})));
    let project_now = ok(call(&k, "drama.projects.get", json!({"project_id":project["project"]["project_id"]})));
    let work = json!({"workspace_id":k.scope(),"kind":"drama","object_id":project["project"]["project_id"]});
    let input = json!({"work_ref":work,"source_ref":reference(&source),"expected":{"revision":project_now["project"]["revision"],"sha256":project_now["sha256"]},"new_target":{"title":"新分集","plan":"新计划"},"byte_start":"INT. 房间 - 夜\n\n甲\n".len(),"byte_end":"INT. 房间 - 夜\n\n甲\n移动台词".len(),"quote":"移动台词","operation_key":"move-new-drama"});
    let moved = ok(call(&k, "documents.move_to_new", input));
    let target = read(&k, &moved["target"]);
    assert_eq!(target["content"], "移动台词");
    assert_eq!(ok(call(&k, "drama.projects.get", json!({"project_id":work["object_id"]}))) ["project"]["episode_refs"].as_array().unwrap().len(), 2);
    let restored = ok(call(&k, "documents.restore_move", json!({"work_ref":work,"move_ref":moved["move_ref"],"operation_key":"restore-new-drama"})));
    assert_eq!(read(&k, &source)["content"], "INT. 房间 - 夜\n\n甲\n移动台词\n\n乙");
    assert_eq!(read(&k, &target)["document"]["archived"], true);
    assert_eq!(ok(call(&k, "drama.projects.get", json!({"project_id":work["object_id"]}))) ["project"]["episode_refs"].as_array().unwrap().len(), 1);
    assert_eq!(restored["source"]["document"]["document_id"], source["document"]["document_id"]);
}
