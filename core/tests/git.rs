use hetu_core::Kernel;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

fn call(k: &Kernel, name: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.git.{name}"),"contract_revision":"1","input":input}))
}
fn success(result: Value) -> Value {
    assert!(
        matches!(result["status"].as_str(), Some("succeeded" | "pending")),
        "{result}"
    );
    result["data"].clone()
}
fn open(root: &Path, mode: &str, create: bool) -> Kernel {
    let mut config = json!({"workspace_path":root.join("河图 版本 🌿"),"mode":mode,"authorization_path":root.join("authorizations")});
    if create {
        config["create"] =
            json!({"title":"长河夜航","locale":"zh-CN","operation_key":"init-workspace"});
    }
    Kernel::open(config).unwrap()
}
fn setup() -> (tempfile::TempDir, Kernel, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let kernel = open(root.path(), "author", true);
    let path = root.path().join("河图 版本 🌿");
    (root, kernel, path)
}
fn init(k: &Kernel) {
    success(call(
        k,
        "init",
        json!({"branch":"main","operation_key":"git-init"}),
    ));
}
fn prepare(k: &Kernel, key: &str, paths: Option<Vec<&str>>) -> Value {
    let status = success(call(k, "status", json!({})));
    let mut input = json!({"phase":"prepare","expected_head":status["head"],"message":"保存雾港 🌿","author":{"name":"河图作者","email":"author@hetu.test"},"operation_key":key});
    if let Some(paths) = paths {
        input["selected_paths"] = json!(paths);
    }
    success(call(k, "snapshot", input))
}
fn approve(k: &Kernel, prepared: &Value, key: &str) -> Value {
    call(
        k,
        "approve_snapshot",
        json!({"snapshot_id":prepared["snapshot"]["snapshot_id"],"snapshot_sha256":prepared["snapshot_sha256"],"operation_key":key}),
    )
}
fn execute(k: &Kernel, prepared: &Value, key: &str) -> Value {
    call(
        k,
        "snapshot",
        json!({"phase":"execute","snapshot_id":prepared["snapshot"]["snapshot_id"],"operation_key":key}),
    )
}
fn commit(k: &Kernel, seq: &str) -> Value {
    let prepared = prepare(k, &format!("prepare-{seq}"), None);
    success(approve(k, &prepared, &format!("approve-{seq}")));
    let result = execute(k, &prepared, &format!("execute-{seq}"));
    success(result.clone());
    result
}

#[test]
fn init_is_explicit_and_does_not_discover_an_ancestor_repository() {
    let (root, k, path) = setup();
    git2::Repository::init(root.path()).unwrap();
    assert_eq!(call(&k, "status", json!({}))["data"]["initialized"], false);
    let agent = open(root.path(), "agent", false);
    assert_eq!(
        call(
            &agent,
            "init",
            json!({"branch":"main","operation_key":"no"})
        )["error"]["code"],
        "forbidden"
    );
    init(&k);
    assert!(path.join(".git").is_dir());
    assert_eq!(
        call(&k, "status", json!({}))["data"]["head"],
        json!({"reference":"refs/heads/main","commit_id":null})
    );
    assert!(
        !path.join(".git/hooks/post-commit").exists(),
        "external templates must not install hooks"
    );
}

#[test]
fn snapshots_preserve_the_real_index_and_only_commit_selected_worktree_bytes() {
    let (_root, k, path) = setup();
    init(&k);
    commit(&k, "initial");
    fs::write(path.join("README.md"), "先前暂存的中文内容\n").unwrap();
    let repo = git2::Repository::open(&path).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new("README.md")).unwrap();
    index.write().unwrap();
    let index_bytes = fs::read(path.join(".git/index")).unwrap();
    fs::write(path.join("README.md"), "本次工作树内容 🌿\n").unwrap();
    fs::write(
        path.join("packages/novel/outlines/未选择.md"),
        "保留未提交内容",
    )
    .unwrap();
    let prepared = prepare(&k, "selected", Some(vec!["README.md"]));
    assert_eq!(prepared["approval_state"], "pending_approval");
    success(approve(&k, &prepared, "approve"));
    let result = execute(&k, &prepared, "execute");
    success(result.clone());
    assert_eq!(
        fs::read(path.join(".git/index")).unwrap(),
        index_bytes,
        "user staging must be unchanged"
    );
    let tree = repo
        .find_commit(git2::Oid::from_str(result["data"]["commit_id"].as_str().unwrap()).unwrap())
        .unwrap()
        .tree()
        .unwrap();
    let entry = tree.get_path(Path::new("README.md")).unwrap();
    assert_eq!(
        repo.find_blob(entry.id()).unwrap().content(),
        "本次工作树内容 🌿\n".as_bytes()
    );
    assert!(
        tree.get_path(Path::new("packages/novel/outlines/未选择.md"))
            .is_err()
    );
    assert_eq!(
        fs::read_to_string(path.join("packages/novel/outlines/未选择.md")).unwrap(),
        "保留未提交内容"
    );
    assert!(
        result["data"]["excluded_changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["path"] == "packages/novel/outlines/未选择.md")
    );
    let status = success(call(&k, "status", json!({})));
    assert!(
        status["changes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["path"] != "README.md"),
        "staging-only differences must not appear as content changes"
    );
}

#[test]
fn agent_prepare_requires_exact_local_author_approval_and_never_executes_hooks() {
    use std::os::unix::fs::PermissionsExt;
    let (root, k, path) = setup();
    init(&k);
    fs::write(
        path.join(".git/hooks/post-commit"),
        format!(
            "#!/bin/sh\nprintf 'unsafe' > '{}'\n",
            root.path().join("hook-ran").display()
        ),
    )
    .unwrap();
    fs::set_permissions(
        path.join(".git/hooks/post-commit"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    let agent = open(root.path(), "agent", false);
    let p = prepare(&agent, "agent-prepare", None);
    assert_eq!(
        execute(&agent, &p, "agent-execute")["error"]["code"],
        "hetu.author_confirmation_required"
    );
    assert_eq!(
        approve(&agent, &p, "forged-approval")["error"]["code"],
        "forbidden"
    );
    success(approve(&k, &p, "real-approval"));
    let result = execute(&agent, &p, "agent-execute");
    success(result.clone());
    assert_eq!(execute(&agent, &p, "agent-execute"), result);
    assert!(!root.path().join("hook-ran").exists());
    let repository = git2::Repository::open(&path).unwrap();
    let commit = repository.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(commit.author().name(), Some("河图作者"));
    assert!(
        commit
            .tree()
            .unwrap()
            .get_path(Path::new(".hetu/git"))
            .is_err()
    );
    assert!(root.path().join("authorizations").is_dir());
}

#[test]
fn file_or_head_changes_invalidate_preview_and_approval() {
    let (_root, k, path) = setup();
    init(&k);
    commit(&k, "initial");
    fs::write(path.join("README.md"), "版本二").unwrap();
    let p = prepare(&k, "prepare", None);
    success(approve(&k, &p, "approve"));
    fs::write(path.join("README.md"), "作者继续修改").unwrap();
    assert_eq!(
        execute(&k, &p, "execute")["error"]["code"],
        "revision_conflict"
    );
    assert_eq!(
        approve(&k, &p, "approve-stale")["error"]["code"],
        "revision_conflict"
    );
    let fresh = prepare(&k, "fresh", None);
    success(approve(&k, &fresh, "approve-fresh"));
    commit(&k, "concurrent");
    assert_eq!(
        execute(&k, &fresh, "execute-stale-head")["error"]["code"],
        "revision_conflict"
    );
}

#[test]
fn recovery_reuses_exact_commit_and_receipt_after_publication_even_after_approval_expiry() {
    let (root, k, path) = setup();
    init(&k);
    let prepared = prepare(&k, "prepare", None);
    success(approve(&k, &prepared, "approve"));
    let result = execute(&k, &prepared, "execute");
    success(result.clone());
    let operation = result["operation"]["id"].as_str().unwrap();
    for entry in fs::read_dir(path.join(".hetu/operations")).unwrap() {
        let path = entry.unwrap().path();
        let value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        if value["operation_id"] == operation {
            fs::remove_file(path).unwrap();
        }
    }
    for folder in fs::read_dir(root.path().join("authorizations")).unwrap() {
        for entry in fs::read_dir(folder.unwrap().path()).unwrap() {
            let path = entry.unwrap().path();
            let mut v: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            v["expires_at"] = json!(0);
            fs::write(path, serde_json::to_vec(&v).unwrap()).unwrap();
        }
    }
    drop(k);
    let reopened = open(root.path(), "author", false);
    assert_eq!(execute(&reopened, &prepared, "execute"), result);
    assert_eq!(
        call(&reopened, "log", json!({}))["data"]["commits"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn diff_log_and_snapshot_pagination_do_not_mutate_content_or_staging() {
    let (_root, k, path) = setup();
    init(&k);
    let first = commit(&k, "initial");
    fs::write(path.join("README.md"), "中文 🌿\r\n").unwrap();
    let diff = success(call(&k, "diff", json!({"path":"README.md"})));
    assert_eq!(diff["after"], "中文 🌿\r\n");
    assert!(diff["before"].is_null());
    commit(&k, "two");
    let page = success(call(&k, "log", json!({"limit":1})));
    let cursor = page["next_cursor"].clone();
    let older = success(call(&k, "log", json!({"limit":1,"cursor":cursor})));
    assert_eq!(older["commits"][0]["commit_id"], first["data"]["commit_id"]);
    fs::write(path.join("README.md"), "版本三").unwrap();
    commit(&k, "three");
    assert_eq!(
        call(&k, "log", json!({"limit":1,"cursor":cursor}))["error"]["code"],
        "cursor_invalid"
    );
}

#[test]
fn sensitive_fields_symlinks_and_snapshot_tampering_are_rejected() {
    let (_root, k, path) = setup();
    init(&k);
    fs::write(
        path.join("packages/novel/credentials.json"),
        br#"{"api_key":"private-credential"}"#,
    )
    .unwrap();
    let status = success(call(&k, "status", json!({})));
    let input = json!({"phase":"prepare","expected_head":status["head"],"message":"test","author":{"name":"作者","email":"a@hetu.test"},"operation_key":"secret"});
    assert_eq!(
        call(&k, "snapshot", input)["error"]["code"],
        "hetu.secret_detected"
    );
    assert_eq!(
        call(
            &k,
            "diff",
            json!({"path":"packages/novel/credentials.json"})
        )["error"]["code"],
        "hetu.secret_detected"
    );
    fs::remove_file(path.join("packages/novel/credentials.json")).unwrap();
    std::os::unix::fs::symlink("/etc/passwd", path.join("packages/novel/link.md")).unwrap();
    assert_eq!(
        call(&k, "diff", json!({"path":"packages/novel/link.md"}))["error"]["code"],
        "hetu.unsafe_path"
    );
    fs::remove_file(path.join("packages/novel/link.md")).unwrap();
    let p = prepare(&k, "prepare", None);
    let file = path.join(format!(
        ".hetu/git/snapshots/{}.json",
        p["snapshot"]["snapshot_id"].as_str().unwrap()
    ));
    let mut value = p["snapshot"].clone();
    value["message"] = json!("被外部替换");
    fs::write(file, serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!(
        approve(&k, &p, "approve")["error"]["code"],
        "revision_conflict"
    );
}

#[test]
fn cloned_content_reopens_without_machine_local_receipts_and_approvals() {
    let (_root, k, path) = setup();
    init(&k);
    commit(&k, "initial");
    let destination = tempfile::tempdir().unwrap();
    let clone_path = destination.path().join("clone");
    git2::build::RepoBuilder::new()
        .clone_local(git2::build::CloneLocal::None)
        .clone(path.to_str().unwrap(), &clone_path)
        .unwrap();
    assert!(!clone_path.join(".hetu/operations").exists());
    let reopened=Kernel::open(json!({"workspace_path":clone_path,"mode":"agent","authorization_path":destination.path().join("authorizations")})).unwrap();
    assert_eq!(call(&reopened, "status", json!({}))["status"], "succeeded");
    assert_eq!(
        reopened
            .request(json!({"action":"hetu.documents.list","contract_revision":"1","input":{}}))["status"],
        "succeeded"
    );
}

#[test]
fn fixed_previews_survive_reopen_and_detect_changed_bytes_and_page_membership() {
    let (root, k, path) = setup();
    init(&k);
    assert!(
        success(call(&k, "list_snapshots", json!({})))["snapshots"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    fs::write(path.join("README.md"), "待确认的版本 🌿\n").unwrap();
    let first = prepare(&k, "first", Some(vec!["README.md"]));
    let request = json!({"snapshot_id":first["snapshot"]["snapshot_id"]});
    assert_eq!(
        success(call(&k, "get_snapshot", request.clone()))["snapshot_sha256"],
        first["snapshot_sha256"]
    );
    let second = prepare(&k, "second", Some(vec!["README.md"]));
    let page = success(call(&k, "list_snapshots", json!({"limit":1})));
    assert!(page["next_cursor"].is_string());
    assert_eq!(
        success(call(
            &k,
            "list_snapshots",
            json!({"limit":1,"cursor":page["next_cursor"]})
        ))["snapshots"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    prepare(&k, "third", Some(vec!["README.md"]));
    assert_eq!(
        call(&k, "list_snapshots", json!({"cursor":page["next_cursor"]}))["error"]["code"],
        "cursor_invalid"
    );
    drop(k);
    let reopened = open(root.path(), "author", false);
    let fixed = json!({"snapshot_id":first["snapshot"]["snapshot_id"],"path":"README.md"});
    assert_eq!(
        success(call(&reopened, "snapshot_diff", fixed.clone()))["after"],
        "待确认的版本 🌿\n"
    );
    fs::write(path.join("README.md"), "继续改写").unwrap();
    assert_eq!(
        success(call(&reopened, "get_snapshot", request))["approval_state"],
        "stale"
    );
    assert_eq!(
        call(&reopened, "snapshot_diff", fixed)["error"]["code"],
        "revision_conflict"
    );
    assert_eq!(
        approve(&reopened, &second, "stale")["error"]["code"],
        "revision_conflict"
    );
}

#[test]
fn delivery_runtime_records_never_enter_snapshots_even_if_externally_staged() {
    let (_root, k, path) = setup();
    assert!(
        fs::read_to_string(path.join(".gitignore"))
            .unwrap()
            .contains(".hetu/deliveries/")
    );
    // 模拟旧作品未更新忽略规则，以及外部工具把本机控制记录加入暂存区。
    fs::write(path.join(".gitignore"), "exports/\n").unwrap();
    init(&k);
    let delivery = ".hetu/deliveries/delivery_11111111-1111-4111-8111-111111111111";
    fs::create_dir_all(path.join(delivery)).unwrap();
    let repo = git2::Repository::open(&path).unwrap();
    let mut index = repo.index().unwrap();
    for name in [
        "intent.json",
        "ready.json",
        "receipt.json",
        "artifact.tmp",
        "export.lock",
    ] {
        let relative = format!("{delivery}/{name}");
        fs::write(path.join(&relative), "本机交付运行记录").unwrap();
        index.add_path(Path::new(&relative)).unwrap();
        assert_eq!(
            call(&k, "diff", json!({"path":relative}))["error"]["code"],
            "hetu.unsafe_path"
        );
    }
    index.write().unwrap();
    let index_bytes = fs::read(path.join(".git/index")).unwrap();
    fs::create_dir_all(path.join(".hetu/imports/source")).unwrap();
    fs::write(
        path.join(".hetu/imports/source/original"),
        "可追溯的导入原稿",
    )
    .unwrap();
    let status = success(call(&k, "status", json!({})));
    let paths: Vec<_> = status["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["path"].as_str().unwrap())
        .collect();
    assert!(paths.iter().all(|p| !p.starts_with(".hetu/deliveries/")));
    assert!(paths.contains(&".hetu/imports/source/original"));
    let result = commit(&k, "without-delivery-runtime");
    let tree = repo
        .find_commit(git2::Oid::from_str(result["data"]["commit_id"].as_str().unwrap()).unwrap())
        .unwrap()
        .tree()
        .unwrap();
    assert!(tree.get_path(Path::new(".hetu/deliveries")).is_err());
    assert!(
        tree.get_path(Path::new(".hetu/imports/source/original"))
            .is_ok()
    );
    assert_eq!(fs::read(path.join(".git/index")).unwrap(), index_bytes);
}

#[test]
fn ignored_files_are_not_selected_and_binary_deletion_and_modes_preserve_raw_content() {
    use std::os::unix::fs::PermissionsExt;
    let (_root, k, path) = setup();
    init(&k);
    fs::write(path.join(".gitignore"), "packages/novel/private.md\n").unwrap();
    fs::write(path.join("packages/novel/private.md"), "作者私稿").unwrap();
    fs::write(path.join("packages/novel/payload.bin"), [0, 1, 255, 2]).unwrap();
    fs::write(path.join("README.md"), "待删除").unwrap();
    assert!(
        success(call(&k, "status", json!({})))["changes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["path"] != "packages/novel/private.md")
    );
    commit(&k, "initial");
    assert!(
        success(call(&k, "status", json!({})))["changes"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    fs::remove_file(path.join("README.md")).unwrap();
    fs::write(path.join("packages/novel/payload.bin"), [4, 0, 255, 3]).unwrap();
    fs::set_permissions(
        path.join("packages/novel/payload.bin"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    assert_eq!(
        success(call(
            &k,
            "diff",
            json!({"path":"packages/novel/payload.bin"})
        ))["binary"],
        true
    );
    let result = commit(&k, "binary-delete");
    let repo = git2::Repository::open(&path).unwrap();
    let tree = repo
        .find_commit(git2::Oid::from_str(result["data"]["commit_id"].as_str().unwrap()).unwrap())
        .unwrap()
        .tree()
        .unwrap();
    assert!(tree.get_path(Path::new("README.md")).is_err());
    assert!(
        tree.get_path(Path::new("packages/novel/private.md"))
            .is_err()
    );
    let binary = tree
        .get_path(Path::new("packages/novel/payload.bin"))
        .unwrap();
    assert_eq!(binary.filemode(), 0o100755);
    assert_eq!(
        repo.find_blob(binary.id()).unwrap().content(),
        [4, 0, 255, 3]
    );
    assert!(
        success(call(&k, "status", json!({})))["changes"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn expired_approval_cannot_publish_a_new_commit() {
    let (root, k, path) = setup();
    init(&k);
    let p = prepare(&k, "prepare", None);
    success(approve(&k, &p, "approve"));
    for folder in fs::read_dir(root.path().join("authorizations")).unwrap() {
        for entry in fs::read_dir(folder.unwrap().path()).unwrap() {
            let file = entry.unwrap().path();
            let mut approval: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
            approval["expires_at"] = json!(0);
            fs::write(file, serde_json::to_vec(&approval).unwrap()).unwrap();
        }
    }
    assert_eq!(
        execute(&k, &p, "expired")["error"]["code"],
        "hetu.author_confirmation_required"
    );
    assert!(git2::Repository::open(path).unwrap().head().is_err());
}

#[test]
fn raw_git_differences_never_bypass_private_review_projection() {
    let (root, k, path) = setup();
    init(&k);
    fs::create_dir(path.join(".hetu/reviews")).unwrap();
    fs::write(
        path.join(".hetu/reviews/private.json"),
        br#"{"private_comments":"Author-only notes"}"#,
    )
    .unwrap();
    let input = json!({"path":".hetu/reviews/private.json"});
    assert_eq!(call(&k, "diff", input.clone())["status"], "succeeded");
    let agent = open(root.path(), "agent", false);
    let result = call(&agent, "diff", input);
    assert_eq!(result["error"]["code"], "forbidden");
    assert!(!result.to_string().contains("Author-only notes"));
    let p = prepare(&agent, "private-preview", None);
    assert_eq!(
        call(
            &agent,
            "snapshot_diff",
            json!({"snapshot_id":p["snapshot"]["snapshot_id"],"path":".hetu/reviews/private.json"})
        )["error"]["code"],
        "forbidden"
    );
}

#[test]
fn completed_previews_use_real_git_evidence_and_reject_altered_execution_receipts() {
    let (_root, k, path) = setup();
    init(&k);
    let p = prepare(&k, "prepare", None);
    success(approve(&k, &p, "approve"));
    let result = execute(&k, &p, "execute");
    success(result.clone());
    let input = json!({"snapshot_id":p["snapshot"]["snapshot_id"]});
    let completed = success(call(&k, "get_snapshot", input.clone()));
    assert_eq!(completed["approval_state"], "executed");
    assert_eq!(
        completed["execution"]["commit_id"],
        result["data"]["commit_id"]
    );
    let file = fs::read_dir(path.join(".hetu/git/executions"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let mut journal: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    journal["published"] = json!(false);
    fs::write(&file, serde_json::to_vec(&journal).unwrap()).unwrap();
    assert_eq!(
        success(call(&k, "get_snapshot", input.clone()))["approval_state"],
        "executed",
        "a progress flag cannot override Git publication evidence"
    );
    journal["result"]["data"]["selected_paths"] = json!([]);
    fs::write(&file, serde_json::to_vec(&journal).unwrap()).unwrap();
    assert_eq!(
        call(&k, "get_snapshot", input)["error"]["code"],
        "hetu.integrity_failure"
    );
    for entry in fs::read_dir(path.join(".hetu/operations")).unwrap() {
        let receipt = entry.unwrap().path();
        let record: Value = serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
        if record["operation_id"] == result["operation"]["id"] {
            fs::remove_file(receipt).unwrap();
        }
    }
    assert_eq!(
        execute(&k, &p, "execute")["error"]["code"],
        "hetu.integrity_failure"
    );
}
