use hetu_core::Kernel;
use serde_json::{Value, json};
use std::path::Path;

fn open(path: &Path, mode: &str, create: bool) -> Kernel {
    let mut config = json!({"workspace_path":path.to_str().unwrap(),"mode":mode});
    if create {
        config["create"] = json!({"title":"长河夜航","locale":"zh-CN","operation_key":"init-001"});
    }
    Kernel::open(config).unwrap()
}
fn call(kernel: &Kernel, name: &str, input: Value) -> Value {
    kernel.request(json!({"action":format!("hetu.{name}"),"contract_revision":"1","input":input}))
}
fn created(kernel: &Kernel) -> Value {
    let result = call(
        kernel,
        "documents.create",
        json!({"kind":"novel_chapter","title":"第一章 雨夜","source_format":"markdown","content":"林舟说：你好，世界。🌧️\n","operation_key":"create-chapter"}),
    );
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn expected(kernel: &Kernel) -> Value {
    let bp = call(kernel, "blueprints.get", json!({}));
    json!({"revision":bp["data"]["revision"],"sha256":bp["data"]["sha256"]})
}

#[test]
fn writer_does_not_block_opening_or_reading_and_editing_recovers_after_release() {
    use rustix::fs::{FlockOperation, flock};
    use std::os::fd::AsFd;
    let root = tempfile::tempdir().unwrap();
    let author = open(root.path(), "author", true);
    let document = created(&author);
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.path().join(".hetu/workspace.lock"))
        .unwrap();
    flock(file.as_fd(), FlockOperation::LockExclusive).unwrap();
    let reader = open(root.path(), "author", false);
    let info = call(&reader, "workspaces.get", json!({}));
    assert_eq!(info["data"]["access"]["write_available"], false);
    let id = &document["document"]["document_id"];
    assert_eq!(
        call(&reader, "documents.get", json!({"document_id":id}))["data"]["content"],
        "林舟说：你好，世界。🌧️\n"
    );
    assert_eq!(
        call(&reader, "documents.list", json!({}))["status"],
        "succeeded"
    );
    assert_eq!(
        call(&reader, "blueprints.get", json!({}))["status"],
        "succeeded"
    );
    let save = json!({"document_id":id,"base_revision_id":document["revision"]["revision_id"],
        "source_format":"markdown","content":"作者恢复编辑。","operation_key":"after-writer"});
    assert_eq!(
        call(&reader, "documents.save", save.clone())["error"]["code"],
        "hetu.workspace_busy"
    );
    drop(file);
    assert_eq!(
        call(&reader, "workspaces.get", json!({}))["data"]["access"]["write_available"],
        true
    );
    assert_eq!(call(&reader, "documents.save", save)["status"], "succeeded");
}

#[test]
fn chinese_workspace_and_immutable_revision_survive_reopen() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("我的 IP 测试");
    let kernel = open(&path, "author", true);
    let data = created(&kernel);
    let doc = data["document"]["document_id"].as_str().unwrap();
    let rev = data["revision"]["revision_id"].as_str().unwrap();
    let save = json!({"document_id":doc,"base_revision_id":rev,"source_format":"markdown","content":"新的一天。\n","operation_key":"save-001"});
    let first = call(&kernel, "documents.save", save.clone());
    assert_eq!(first["status"], "succeeded", "{first}");
    drop(kernel);
    let kernel = open(&path, "author", false);
    assert_eq!(
        call(&kernel, "documents.save", save.clone()),
        first,
        "原键重放必须先于 CAS"
    );
    let mut changed = save;
    changed["content"] = json!("同键不同内容");
    assert_eq!(
        call(&kernel, "documents.save", changed)["error"]["code"],
        "idempotency_conflict"
    );
    let original = call(
        &kernel,
        "documents.get",
        json!({"document_id":doc,"revision_id":rev}),
    );
    assert_eq!(original["data"]["content"], "林舟说：你好，世界。🌧️\n");
    assert!(
        original["data"]["document"]
            .get("approved_revision_id")
            .is_none()
    );
}
#[test]
fn stale_editor_cannot_overwrite_newer_revision() {
    let root = tempfile::tempdir().unwrap();
    let first = open(root.path(), "author", true);
    let second = open(root.path(), "author", false);
    let data = created(&first);
    let mut input = json!({"document_id":data["document"]["document_id"],"base_revision_id":data["revision"]["revision_id"],"source_format":"markdown","content":"窗口一内容","operation_key":"window-1"});
    assert_eq!(
        call(&first, "documents.save", input.clone())["status"],
        "succeeded"
    );
    input["operation_key"] = json!("window-2");
    input["content"] = json!("窗口二内容");
    assert_eq!(
        call(&second, "documents.save", input)["error"]["code"],
        "revision_conflict"
    );
    assert_eq!(
        call(
            &first,
            "documents.get",
            json!({"document_id":data["document"]["document_id"]})
        )["data"]["content"],
        "窗口一内容"
    );
}
#[test]
fn agents_cannot_save_unlock_or_inject_author_identity() {
    let root = tempfile::tempdir().unwrap();
    let author = open(root.path(), "author", true);
    let doc = created(&author);
    let agent = open(root.path(), "agent", false);
    let input = json!({"document_id":doc["document"]["document_id"],"base_revision_id":doc["revision"]["revision_id"],"source_format":"markdown","content":"越权","operation_key":"bad-save"});
    assert_eq!(
        call(&agent, "documents.save", input.clone())["error"]["code"],
        "forbidden"
    );
    let mut injected = input;
    injected["is_author"] = json!(true);
    assert_eq!(
        call(&agent, "documents.save", injected)["error"]["code"],
        "invalid_input"
    );
    let locked = call(
        &author,
        "blueprints.lock",
        json!({"expected":expected(&author),"operation_key":"lock-1"}),
    );
    assert_eq!(locked["status"], "succeeded");
    assert_eq!(
        call(
            &agent,
            "blueprints.unlock",
            json!({"expected":expected(&author),"reason":"Agent 不能解锁","operation_key":"unlock-1"})
        )["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        call(
            &agent,
            "drafts.submit",
            json!({"package":"novel","source_format":"markdown","title":"Agent 草稿","content":"林舟走进雨里。","blueprint_revision":2,"operation_key":"draft-1"})
        )["status"],
        "succeeded"
    );
}
#[test]
fn locked_blueprint_rejects_author_changes_until_explicit_unlock() {
    let root = tempfile::tempdir().unwrap();
    let kernel = open(root.path(), "author", true);
    call(
        &kernel,
        "blueprints.lock",
        json!({"expected":expected(&kernel),"operation_key":"lock"}),
    );
    let change = json!({"type":"upsert_character","entity":{"character_id":"character_11111111-1111-4111-8111-111111111111","name":"林舟","aliases":[],"description":"守夜人","traits":[],"facts":[],"archived":false}});
    let save =
        json!({"expected":expected(&kernel),"typed_changes":[change],"operation_key":"edit"});
    assert_eq!(
        call(&kernel, "blueprints.save", save.clone())["error"]["code"],
        "hetu.blueprint_locked"
    );
    assert_eq!(
        call(
            &kernel,
            "blueprints.unlock",
            json!({"expected":expected(&kernel),"reason":"补充角色","operation_key":"unlock"})
        )["status"],
        "succeeded"
    );
    let mut save = save;
    save["expected"] = expected(&kernel);
    assert_eq!(
        call(&kernel, "blueprints.save", save)["status"],
        "succeeded"
    );
}
#[test]
fn external_revision_changes_are_detected_without_rehashing_history() {
    let root = tempfile::tempdir().unwrap();
    let kernel = open(root.path(), "author", true);
    let doc = created(&kernel);
    let content_path = root
        .path()
        .join(doc["revision"]["content_path"].as_str().unwrap());
    std::fs::write(&content_path, "外部覆盖").unwrap();
    let response = call(
        &kernel,
        "documents.get",
        json!({"document_id":doc["document"]["document_id"]}),
    );
    assert_eq!(response["error"]["code"], "hetu.integrity_failure");
    assert_eq!(std::fs::read_to_string(content_path).unwrap(), "外部覆盖");
}
#[test]
fn workspace_creation_never_adopts_nonempty_directory() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("我的作品.txt"), "保留内容").unwrap();
    assert!(Kernel::open(json!({"workspace_path":root.path(),"mode":"author","create":{"title":"新项目","locale":"zh-CN","operation_key":"new"}})).is_err());
    assert_eq!(
        std::fs::read_to_string(root.path().join("我的作品.txt")).unwrap(),
        "保留内容"
    );
    assert!(!root.path().join(".hetu").exists());
}
#[cfg(unix)]
#[test]
fn symlink_and_hardlink_escape_are_rejected() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let kernel = open(root.path(), "author", true);
    let documents = root.path().join("packages/novel/documents");
    std::fs::rename(&documents, root.path().join("original-documents")).unwrap();
    symlink(outside.path(), &documents).unwrap();
    assert_eq!(
        call(&kernel, "documents.list", json!({}))["error"]["code"],
        "hetu.unsafe_path"
    );
    assert!(std::fs::read_dir(outside.path()).unwrap().next().is_none());
    let second = tempfile::tempdir().unwrap();
    let kernel = open(second.path(), "author", true);
    let doc = created(&kernel);
    std::fs::hard_link(
        second
            .path()
            .join(doc["revision"]["content_path"].as_str().unwrap()),
        outside.path().join("linked.md"),
    )
    .unwrap();
    assert_eq!(
        call(
            &kernel,
            "documents.get",
            json!({"document_id":doc["document"]["document_id"]})
        )["error"]["code"],
        "hetu.unsafe_path"
    );
}
#[test]
fn draft_bodies_remain_immutable_and_operations_are_scope_checked() {
    let root = tempfile::tempdir().unwrap();
    let author = open(root.path(), "author", true);
    let agent = open(root.path(), "agent", false);
    let input = json!({"package":"novel","source_format":"markdown","title":"第一章草稿","content":"外部 Agent 提交的原文。","blueprint_revision":1,"operation_key":"agent-draft"});
    let draft = call(&agent, "drafts.submit", input.clone());
    assert_eq!(draft["status"], "succeeded");
    assert_eq!(call(&agent, "drafts.submit", input), draft);
    let operation = call(
        &agent,
        "operations.get",
        json!({"operation_id":draft["operation"]["id"]}),
    );
    assert_eq!(operation["data"]["original_result"], draft);
    assert_eq!(
        call(
            &author,
            "operations.get",
            json!({"operation_id":draft["operation"]["id"]})
        )["error"]["code"],
        "not_found"
    );
    let loaded = call(
        &author,
        "drafts.get",
        json!({"draft_id":draft["data"]["draft"]["draft_id"]}),
    );
    assert_eq!(loaded["data"]["content"], "外部 Agent 提交的原文。");
    assert_eq!(loaded["data"]["draft"]["state"], "submitted");
    std::fs::write(
        root.path()
            .join(draft["data"]["draft"]["content_path"].as_str().unwrap()),
        "偷偷改写",
    )
    .unwrap();
    assert_eq!(
        call(
            &author,
            "drafts.get",
            json!({"draft_id":draft["data"]["draft"]["draft_id"]})
        )["error"]["code"],
        "hetu.integrity_failure"
    );
}
