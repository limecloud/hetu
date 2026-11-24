use hetu_core::Kernel;
use serde_json::{Value, json};

fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(result: Value) -> Value {
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn setup() -> (tempfile::TempDir, Kernel) {
    let root = tempfile::tempdir().unwrap();
    let k = Kernel::open(json!({"workspace_path":root.path(),"mode":"author","create":{"title":"副本测试","locale":"zh-CN","operation_key":"initialize"}})).unwrap();
    (root, k)
}
fn chapter(k: &Kernel, title: &str) -> Value {
    ok(call(
        k,
        "documents.create",
        json!({"kind":"novel_chapter","title":title,"source_format":"markdown","language_tag":"zh-CN","content":"**雨夜** 🌿\r\n\r\n第二段。\n尾段。\r","operation_key":title}),
    ))
}
fn fixed(k: &Kernel, source: &Value) -> Value {
    let work = ok(call(k, "works.list", json!({})))["works"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["work_ref"]["kind"] == "novel")
        .unwrap()["work_ref"]
        .clone();
    let directory = ok(call(k, "novels.get", json!({})));
    json!({"work_ref":work,"source_ref":{"document_id":source["document"]["document_id"],"revision_id":source["revision"]["revision_id"],"sha256":source["revision"]["sha256"]},"expected":{"revision":directory["revision"],"sha256":directory["sha256"]},"title":"雨夜 副本","operation_key":"copy"})
}

#[test]
fn novel_copy_is_adjacent_independent_byte_exact_and_replays_after_reopen() {
    let (root, k) = setup();
    let a = chapter(&k, "第一章");
    let b = chapter(&k, "第二章");
    let directory = ok(call(&k, "novels.get", json!({})));
    let volume_id = "volume_00000000-0000-4000-8000-000000000001";
    let mut chapters = directory["novel"]["chapters"].clone();
    for chapter in chapters.as_array_mut().unwrap() {
        chapter["volume_id"] = json!(volume_id);
    }
    ok(call(
        &k,
        "novels.save_structure",
        json!({"expected":{"revision":directory["revision"],"sha256":directory["sha256"]},"volumes":[{"volume_id":volume_id,"title":"第一卷"}],"chapters":chapters,"operation_key":"group"}),
    ));

    let before = ok(call(
        &k,
        "documents.get",
        json!({"document_id":a["document"]["document_id"]}),
    ));
    let input = fixed(&k, &a);
    let copied = ok(call(&k, "documents.duplicate", input.clone()));
    assert_ne!(
        copied["document"]["document_id"],
        a["document"]["document_id"]
    );
    assert_ne!(
        copied["revision"]["revision_id"],
        a["revision"]["revision_id"]
    );
    assert_eq!(copied["revision"]["sha256"], a["revision"]["sha256"]);
    assert_eq!(copied["document"]["language_tag"], "zh-CN");
    assert!(copied["revision"]["parent_revision_id"].is_null());
    assert!(copied["document"]["finalization_ref"].is_null());
    assert_eq!(
        copied["document"]["copy_source_ref"],
        json!({"work_ref":input["work_ref"],"document_ref":input["source_ref"]})
    );
    let read = ok(call(
        &k,
        "documents.get",
        json!({"document_id":copied["document"]["document_id"]}),
    ));
    assert_eq!(read["content"], before["content"]);
    let chapters = &copied["directory"]["novel"]["chapters"];
    assert_eq!(chapters[0]["document_id"], a["document"]["document_id"]);
    assert_eq!(
        chapters[1]["document_id"],
        copied["document"]["document_id"]
    );
    assert_eq!(chapters[1]["volume_id"], volume_id);
    assert_eq!(chapters[2]["document_id"], b["document"]["document_id"]);
    assert_eq!(
        ok(call(
            &k,
            "documents.get",
            json!({"document_id":a["document"]["document_id"]})
        )),
        before
    );
    drop(k);
    let k = Kernel::open(json!({"workspace_path":root.path(),"mode":"author"})).unwrap();
    assert_eq!(ok(call(&k, "documents.duplicate", input.clone())), copied);
    let mut changed = input;
    changed["title"] = json!("另一个副本");
    assert_ne!(
        call(&k, "documents.duplicate", changed)["status"],
        "succeeded"
    );
    assert_eq!(
        ok(call(&k, "novels.get", json!({})))["novel"]["chapters"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn rejects_stale_source_stale_directory_bad_digest_and_other_workspace_without_writes() {
    let (_root, k) = setup();
    let a = chapter(&k, "第一章");
    let input = fixed(&k, &a);
    let mut bad = input.clone();
    bad["source_ref"]["sha256"] = json!("0".repeat(64));
    bad["operation_key"] = json!("digest");
    assert_eq!(
        call(&k, "documents.duplicate", bad)["error"]["code"],
        "hetu.integrity_failure"
    );
    let (_other_root, other) = setup();
    let foreign = chapter(&other, "他书");
    let mut bad = input.clone();
    bad["work_ref"] = fixed(&other, &foreign)["work_ref"].clone();
    bad["operation_key"] = json!("foreign");
    assert_eq!(
        call(&k, "documents.duplicate", bad)["error"]["code"],
        "forbidden"
    );
    let sibling = ok(call(&k, "drama.projects.create", json!({"title":"同根其他作品","mode":"original","operation_key":"sibling"})));
    let mut bad = input.clone();
    bad["work_ref"] = json!({"workspace_id":k.scope(),"kind":"drama","object_id":sibling["project"]["project_id"]});
    bad["operation_key"] = json!("sibling-copy");
    assert_eq!(call(&k, "documents.duplicate", bad)["error"]["code"], "forbidden");
    chapter(&k, "第二章");
    assert_eq!(
        call(&k, "documents.duplicate", input.clone())["error"]["code"],
        "revision_conflict"
    );
    let mut latest = fixed(&k, &a);
    latest["operation_key"] = json!("source-conflict");
    ok(call(
        &k,
        "documents.save",
        json!({"document_id":a["document"]["document_id"],"base_revision_id":a["revision"]["revision_id"],"source_format":"markdown","content":"新版","operation_key":"change"}),
    ));
    assert_eq!(
        call(&k, "documents.duplicate", latest)["error"]["code"],
        "revision_conflict"
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
fn drama_copy_preserves_plan_and_fountain_but_gets_independent_episode_and_order() {
    let (_root, k) = setup();
    let project = ok(call(
        &k,
        "drama.projects.create",
        json!({"title":"雨夜","mode":"original","operation_key":"drama"}),
    ));
    let project_ref = |v: &Value| json!({"project_id":v["project"]["project_id"],"revision":v["project"]["revision"],"sha256":v["sha256"]});
    let first = ok(call(
        &k,
        "drama.episodes.create",
        json!({"project_ref":project_ref(&project),"title":"第一集","plan":"桥上相认。","language_tag":"zh-CN","operation_key":"first"}),
    ));
    let second = ok(call(
        &k,
        "drama.episodes.create",
        json!({"project_ref":project_ref(&first),"title":"第二集","plan":"","language_tag":"zh-CN","operation_key":"second"}),
    ));
    let source = ok(call(
        &k,
        "documents.save",
        json!({"document_id":first["document"]["document_id"],"base_revision_id":first["document_revision"]["revision_id"],"source_format":"fountain","content":"INT. 车站 - 夜\r\n\r\n阿青\r\n我回来了。\r\n","operation_key":"fountain"}),
    ));
    let work = json!({"workspace_id":k.scope(),"kind":"drama","object_id":project["project"]["project_id"]});
    let input = json!({"work_ref":work,"source_ref":{"document_id":source["document"]["document_id"],"revision_id":source["revision"]["revision_id"],"sha256":source["revision"]["sha256"]},"expected":{"revision":second["project"]["revision"],"sha256":second["sha256"]},"title":"第一集 副本","operation_key":"copy-episode"});
    let copied = ok(call(&k, "documents.duplicate", input.clone()));
    let episode = &copied["directory"]["episode"];
    assert_ne!(episode["episode_id"], first["episode"]["episode_id"]);
    assert_eq!(episode["plan"], "桥上相认。");
    assert_eq!(
        copied["directory"]["project"]["episode_refs"],
        json!([
            first["episode"]["episode_id"],
            episode["episode_id"],
            second["episode"]["episode_id"]
        ])
    );
    assert_eq!(
        ok(call(
            &k,
            "documents.get",
            json!({"document_id":copied["document"]["document_id"]})
        ))["content"],
        "INT. 车站 - 夜\r\n\r\n阿青\r\n我回来了。\r\n"
    );
    assert_eq!(ok(call(&k, "documents.duplicate", input)), copied);
}
