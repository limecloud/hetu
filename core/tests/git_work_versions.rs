use hetu_core::{collaboration::CollaborationHub, Kernel};
use serde_json::{json, Value};

fn call(k: &Kernel, a: &str, i: Value) -> Value {
    k.request(json!({"action":format!("hetu.{a}"),"contract_revision":"1","input":i}))
}
fn ok(v: Value) -> Value {
    assert!(
        matches!(v["status"].as_str(), Some("succeeded" | "pending")),
        "{v}"
    );
    v["data"].clone()
}
fn agent(h: &CollaborationHub, grant: &Value, a: &str, mut i: Value) -> Value {
    i["management_ref"] = grant.clone();
    h.request(json!({"action":format!("hetu.{a}"),"contract_revision":"1","input":i}))
}

#[test]
fn host_private_approvals_stay_isolated_and_connection_rebinding_is_explicit() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("作品");
    let access = root.path().join("连接");
    let first_directory = root.path().join("第一资料/git-authorizations");
    let second_directory = root.path().join("第二资料/git-authorizations");
    let first = Kernel::open(json!({"workspace_path":workspace,"mode":"author","authorization_path":first_directory,
        "create":{"title":"私密版本验收","locale":"zh-CN","operation_key":"create"}})).unwrap();
    let work = ok(call(&first, "works.list", json!({})))["works"][0]["work_ref"].clone();
    let content = "江岚保留原来的决定。🌿\r\n这份正文不随批准位置改变。";
    let document = ok(call(&first, "documents.create", json!({"kind":"novel_chapter","title":"渡口",
        "source_format":"markdown","content":content,"operation_key":"document"})));
    ok(call(&first, "git.init", json!({"work_ref":work,"branch":"main","operation_key":"git"})));
    let connection = json!({"work_ref":work,"client_adapter":"codex","collaboration_path":access});
    let authorize = |kernel: &Kernel, key: &str| {
        let mut input = connection.clone(); input["operation_key"] = json!(key);
        ok(call(kernel, "collaboration.authorize_workspace", input))["management_ref"].clone()
    };
    let first_grant = authorize(&first, "first-grant");
    let hub = CollaborationHub::open(&access, "codex").unwrap();
    let prepare = |grant: &Value, key: &str| {
        let head = ok(agent(&hub, grant, "git.status", json!({"work_ref":work})))["head"].clone();
        ok(agent(&hub, grant, "git.snapshot", json!({"work_ref":work,"phase":"prepare","expected_head":head,
            "message":"保留创作节点","author":{"name":"验收作者","email":"author@hetu.test"},"operation_key":key})))
    };
    let approve = |kernel: &Kernel, snapshot: &Value, key: &str| ok(call(kernel, "git.approve_snapshot",
        json!({"work_ref":work,"snapshot_id":snapshot["snapshot"]["snapshot_id"],"snapshot_sha256":snapshot["snapshot_sha256"],"operation_key":key})));
    let read = |grant: &Value, snapshot: &Value| ok(agent(&hub, grant, "git.get_snapshot",
        json!({"work_ref":work,"snapshot_id":snapshot["snapshot"]["snapshot_id"]})));
    let execution = |snapshot: &Value, key: &str| json!({"work_ref":work,"phase":"execute",
        "snapshot_id":snapshot["snapshot"]["snapshot_id"],"operation_key":key});
    let original = prepare(&first_grant, "first-snapshot");
    approve(&first, &original, "first-approval");
    let approval_file = first_directory.join(original["snapshot"]["repository_instance"].as_str().unwrap())
        .join(format!("{}.json", original["snapshot"]["snapshot_id"].as_str().unwrap()));
    let original_approval = std::fs::read(&approval_file).unwrap();
    assert_eq!(read(&first_grant, &original)["approval_state"], "approved");
    assert_eq!(ok(call(&first, "collaboration.workspace_access", connection.clone()))["git_authorization_current"], true);

    let second = Kernel::open(json!({"workspace_path":workspace,"mode":"author","authorization_path":second_directory})).unwrap();
    let status = ok(call(&second, "collaboration.workspace_access", connection.clone()));
    assert_eq!(status["authorized"], true);
    assert_eq!(status["git_authorization_current"], false);
    assert!(!status.to_string().contains(root.path().to_str().unwrap()));
    assert_eq!(read(&first_grant, &original)["approval_state"], "approved");
    let second_grant = authorize(&second, "second-grant");
    assert_ne!(first_grant, second_grant);
    assert_eq!(ok(call(&second, "collaboration.workspace_access", connection))["git_authorization_current"], true);
    assert_eq!(agent(&hub, &first_grant, "git.snapshot", execution(&original, "old-grant"))["error"]["code"], "forbidden");
    assert_eq!(agent(&hub, &second_grant, "git.snapshot", execution(&original, "old-snapshot"))["error"]["code"], "forbidden");
    let current = prepare(&second_grant, "second-snapshot");
    // 在另一个资料目录批准同一快照，不能成为当前连接的批准。
    approve(&first, &current, "wrong-profile-approval");
    assert_eq!(read(&second_grant, &current)["approval_state"], "pending_approval");
    assert_eq!(agent(&hub, &second_grant, "git.snapshot", execution(&current, "missing-approval"))["error"]["code"], "hetu.author_confirmation_required");
    approve(&second, &current, "current-profile-approval");
    let input = execution(&current, "save-current");
    let done = ok(agent(&hub, &second_grant, "git.snapshot", input.clone()));
    assert_eq!(ok(agent(&hub, &second_grant, "git.snapshot", input)), done);
    assert_eq!(ok(call(&second, "documents.get", json!({"document_id":document["document"]["document_id"]})))["content"], content);
    assert_eq!(std::fs::read(approval_file).unwrap(), original_approval);
}

#[test]
fn long_fixed_versions_page_utf8_without_truncation_or_weakening_scope() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("长篇");
    let k = Kernel::open(json!({"workspace_path":workspace,"mode":"author","authorization_path":root.path().join("批准"),"create":{"title":"长篇版本","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let work = ok(call(&k, "works.list", json!({})))["works"][0]["work_ref"].clone();
    let content = "雾港🌿。\n".repeat(90_000);
    assert!(content.len() > 1024 * 1024);
    let chapter = ok(call(
        &k,
        "documents.create",
        json!({"kind":"novel_chapter","title":"长篇","source_format":"markdown","content":content,"operation_key":"chapter"}),
    ));
    let path = chapter["revision"]["content_path"].as_str().unwrap();
    ok(call(
        &k,
        "git.init",
        json!({"branch":"main","operation_key":"git"}),
    ));
    let head = ok(call(&k, "git.status", json!({"work_ref":work})))["head"].clone();
    let snapshot = ok(call(
        &k,
        "git.snapshot",
        json!({"work_ref":work,"phase":"prepare","expected_head":head,"message":"固定长文","author":{"name":"作者","email":"author@hetu.test"},"operation_key":"prepare"}),
    ));
    let snapshot_id = &snapshot["snapshot"]["snapshot_id"];
    let mut offset = 0;
    let mut restored = String::new();
    loop {
        let page = ok(call(
            &k,
            "git.snapshot_diff",
            json!({"work_ref":work,"snapshot_id":snapshot_id,"path":path,"after_offset_bytes":offset,"before_offset_bytes":0,"max_bytes":65536}),
        ));
        assert_eq!(page["snapshot_sha256"], snapshot["snapshot_sha256"]);
        assert_eq!(page["after_sha256"], chapter["revision"]["sha256"]);
        assert_eq!(page["after_offset_bytes"], offset);
        assert_eq!(page["truncated"], false);
        assert!(page["after"].as_str().unwrap().len() <= 65536);
        restored.push_str(page["after"].as_str().unwrap());
        let Some(next) = page["after_next_offset_bytes"].as_u64() else {
            break;
        };
        assert!(next > offset);
        offset = next;
    }
    assert_eq!(restored, content);
    assert_eq!(
        call(
            &k,
            "git.snapshot_diff",
            json!({"work_ref":work,"snapshot_id":snapshot_id,"path":path,"after_offset_bytes":1,"max_bytes":100})
        )["error"]["code"],
        "invalid_input"
    );
    assert_eq!(
        call(
            &k,
            "git.snapshot_diff",
            json!({"work_ref":work,"snapshot_id":snapshot_id,"path":path,"after_offset_bytes":3})
        )["error"]["code"],
        "invalid_input"
    );
    ok(call(
        &k,
        "git.approve_snapshot",
        json!({"work_ref":work,"snapshot_id":snapshot_id,"snapshot_sha256":snapshot["snapshot_sha256"],"operation_key":"approve"}),
    ));
    let committed = ok(call(
        &k,
        "git.snapshot",
        json!({"work_ref":work,"phase":"execute","snapshot_id":snapshot_id,"operation_key":"execute"}),
    ));
    assert_eq!(
        call(
            &k,
            "git.read_version",
            json!({"work_ref":work,"commit_id":committed["commit_id"],"path":path})
        )["error"]["code"],
        "hetu.budget_exceeded"
    );
    let directory = root.path().join("access");
    let grant = ok(call(&k,"collaboration.authorize_workspace",json!({"work_ref":work,"client_adapter":"codex","collaboration_path":directory,"operation_key":"grant"})))["management_ref"].clone();
    let hub = CollaborationHub::open(&directory, "codex").unwrap();
    offset = 0;
    restored.clear();
    loop {
        let page = ok(agent(
            &hub,
            &grant,
            "git.read_version",
            json!({"work_ref":work,"commit_id":committed["commit_id"],"path":path,"offset_bytes":offset,"max_bytes":262144}),
        ));
        assert_eq!(page["sha256"], chapter["revision"]["sha256"]);
        assert_eq!(page["offset_bytes"], offset);
        restored.push_str(page["content"].as_str().unwrap());
        let Some(next) = page["next_offset_bytes"].as_u64() else {
            break;
        };
        offset = next;
    }
    assert_eq!(restored, content);
    assert_eq!(
        agent(
            &hub,
            &grant,
            "git.read_version",
            json!({"work_ref":work,"commit_id":committed["commit_id"],"path":".hetu/workspace.json","max_bytes":100})
        )["error"]["code"],
        "forbidden"
    );
}

#[test]
fn exact_versions_start_empty_isolate_history_and_preserve_workspace_head_and_index() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("作品");
    let k = Kernel::open(json!({"workspace_path":workspace,"mode":"author","authorization_path":root.path().join("作者批准"),"create":{"title":"同根多作品","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let novel = ok(call(&k, "works.list", json!({})))["works"][0]["work_ref"].clone();
    let chapter = ok(call(
        &k,
        "documents.create",
        json!({"kind":"novel_chapter","title":"渡口","source_format":"markdown","content":"初稿🌿。","operation_key":"chapter"}),
    ));
    let doc_id = chapter["document"]["document_id"].as_str().unwrap();
    let body = chapter["revision"]["content_path"].as_str().unwrap();
    let metadata = format!("packages/novel/documents/{doc_id}/document.json");
    let project = ok(call(
        &k,
        "drama.projects.create",
        json!({"title":"不能透露的剧名","mode":"original","operation_key":"drama"}),
    ));
    let episode = ok(call(
        &k,
        "drama.episodes.create",
        json!({"project_ref":{"project_id":project["project"]["project_id"],"revision":1,"sha256":project["sha256"]},"title":"秘密分集","plan":"不共享正文","language_tag":"zh-CN","operation_key":"episode"}),
    ));
    let foreign = format!(
        "packages/drama/documents/{}/document.json",
        episode["document"]["document_id"].as_str().unwrap()
    );
    ok(call(
        &k,
        "git.init",
        json!({"branch":"秘密工作区分支","operation_key":"git-init"}),
    ));
    let repo = git2::Repository::open(&workspace).unwrap();
    std::fs::write(workspace.join("README.md"), "另一个作品的秘密").unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(std::path::Path::new("README.md")).unwrap();
    index.write().unwrap();
    let tree_id = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    let sig = git2::Signature::now("别人的作者名", "private@hetu.test").unwrap();
    let workspace_commit = repo
        .commit(Some("HEAD"), &sig, &sig, "私密工作区提交说明", &tree, &[])
        .unwrap();
    let before_index = std::fs::read(workspace.join(".git/index")).unwrap();
    let directory = root.path().join("授权");
    let grant = ok(call(&k,"collaboration.authorize_workspace",json!({"work_ref":novel,"client_adapter":"codex","collaboration_path":directory,"operation_key":"grant"})))["management_ref"].clone();
    let hub = CollaborationHub::open(&directory, "codex").unwrap();
    let status = ok(agent(&hub, &grant, "git.status", json!({"work_ref":novel})));
    assert!(status["head"]["commit_id"].is_null());
    assert!(!status.to_string().contains("秘密"));
    assert!(status["changes"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p["path"].as_str().unwrap().contains(doc_id)));
    let handoff = ok(agent(
        &hub,
        &grant,
        "handoffs.get",
        json!({"view_kind":"git","object_ref":{"work_ref":novel}}),
    ));
    let actions: Vec<_> = handoff["direct_actions"]
        .as_array()
        .unwrap()
        .iter()
        .chain(handoff["proposal_actions"].as_array().unwrap())
        .map(|a| a["name"].as_str().unwrap())
        .collect();
    assert!(actions.contains(&"hetu.git.snapshot"));
    assert!(actions.contains(&"hetu.git.init"));
    assert!(!actions.iter().any(|name| matches!(
        *name,
        "hetu.git.references"
            | "hetu.git.merge"
            | "hetu.git.branch_switch"
            | "hetu.git.push"
            | "hetu.git.pull"
            | "hetu.git.fetch"
    )));
    for action in ["git.references", "git.merge_preview"] {
        let input = if action == "git.merge_preview" {
            json!({"target_commit":workspace_commit.to_string()})
        } else {
            json!({})
        };
        assert_eq!(
            agent(&hub, &grant, action, input)["error"]["code"],
            "forbidden",
            "{action}"
        );
    }
    assert_eq!(
        agent(
            &hub,
            &grant,
            "git.diff",
            json!({"work_ref":novel,"path":foreign})
        )["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        agent(
            &hub,
            &grant,
            "git.read_version",
            json!({"work_ref":novel,"commit_id":workspace_commit.to_string(),"path":"README.md"})
        )["error"]["code"],
        "forbidden"
    );
    let prepared = ok(agent(
        &hub,
        &grant,
        "git.snapshot",
        json!({"work_ref":novel,"phase":"prepare","expected_head":status["head"],"message":"保留渡口初稿","author":{"name":"作者","email":"author@hetu.test"},"selected_paths":[body,metadata],"operation_key":"prepare"}),
    ));
    assert_eq!(prepared["snapshot"]["schema_version"], "1.1.0");
    assert_eq!(prepared["snapshot"]["work_ref"], novel);
    assert!(!prepared.to_string().contains("秘密"));
    let execute = json!({"work_ref":novel,"phase":"execute","snapshot_id":prepared["snapshot"]["snapshot_id"],"operation_key":"execute"});
    let other_grant = ok(call(&k, "collaboration.authorize_workspace", json!({"work_ref":novel,"client_adapter":"claude-code","collaboration_path":directory,"operation_key":"other-client"})))["management_ref"].clone();
    let other = CollaborationHub::open(&directory, "claude-code").unwrap();
    assert_eq!(
        agent(&other, &other_grant, "git.snapshot", execute.clone())["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        agent(&hub, &grant, "git.snapshot", execute.clone())["error"]["code"],
        "hetu.author_confirmation_required"
    );
    ok(call(
        &k,
        "git.approve_snapshot",
        json!({"work_ref":novel,"snapshot_id":prepared["snapshot"]["snapshot_id"],"snapshot_sha256":prepared["snapshot_sha256"],"operation_key":"approve"}),
    ));
    let done = ok(agent(&hub, &grant, "git.snapshot", execute.clone()));
    assert_eq!(ok(agent(&hub, &grant, "git.snapshot", execute)), done);
    let first_id = git2::Oid::from_str(done["commit_id"].as_str().unwrap()).unwrap();
    assert_eq!(repo.find_commit(first_id).unwrap().parent_count(), 0);
    assert!(repo
        .find_commit(first_id)
        .unwrap()
        .tree()
        .unwrap()
        .get_path(std::path::Path::new("README.md"))
        .is_err());
    assert_eq!(repo.head().unwrap().target(), Some(workspace_commit));
    assert_eq!(
        std::fs::read(workspace.join(".git/index")).unwrap(),
        before_index
    );
    let log = ok(agent(&hub, &grant, "git.log", json!({"work_ref":novel})));
    assert_eq!(log["commits"].as_array().unwrap().len(), 1);
    assert!(!log.to_string().contains("秘密"));
    assert_eq!(
        ok(agent(
            &hub,
            &grant,
            "git.read_version",
            json!({"work_ref":novel,"commit_id":first_id.to_string(),"path":body})
        ))["content"],
        "初稿🌿。"
    );
    let historical_handoff = ok(agent(
        &hub,
        &grant,
        "handoffs.get",
        json!({"view_kind":"git","object_ref":{"work_ref":novel,"git_commit_id":first_id.to_string(),"git_path":body}}),
    ));
    assert!(historical_handoff["fixed_refs"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["kind"] == "git_commit"
            && r["path"] == body
            && r["sha256"] == chapter["revision"]["sha256"]));
    assert!(!historical_handoff["fixed_refs"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["kind"] == "git_difference"));
    ok(call(
        &k,
        "documents.save",
        json!({"document_id":doc_id,"base_revision_id":chapter["revision"]["revision_id"],"content":"作者新稿","source_format":"markdown","operation_key":"save"}),
    ));
    assert_eq!(
        ok(agent(
            &hub,
            &grant,
            "git.read_version",
            json!({"work_ref":novel,"commit_id":first_id.to_string(),"path":body})
        ))["content"],
        "初稿🌿。"
    );
    let second_status = ok(agent(&hub, &grant, "git.status", json!({"work_ref":novel})));
    let second = ok(agent(
        &hub,
        &grant,
        "git.snapshot",
        json!({"work_ref":novel,"phase":"prepare","expected_head":second_status["head"],"message":"保留作者新稿","author":{"name":"作者","email":"author@hetu.test"},"operation_key":"prepare-second"}),
    ));
    ok(call(
        &k,
        "git.approve_snapshot",
        json!({"work_ref":novel,"snapshot_id":second["snapshot"]["snapshot_id"],"snapshot_sha256":second["snapshot_sha256"],"operation_key":"approve-second"}),
    ));
    let second_done = ok(agent(
        &hub,
        &grant,
        "git.snapshot",
        json!({"work_ref":novel,"phase":"execute","snapshot_id":second["snapshot"]["snapshot_id"],"operation_key":"execute-second"}),
    ));
    assert_eq!(
        repo.find_commit(git2::Oid::from_str(second_done["commit_id"].as_str().unwrap()).unwrap())
            .unwrap()
            .parent_id(0)
            .unwrap(),
        first_id
    );
    assert_eq!(
        ok(agent(
            &hub,
            &grant,
            "git.log",
            json!({"work_ref":novel,"limit":1})
        ))["commits"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // 外部工具把作品引用替换成工作区提交时，不展示其文件或备注。
    repo.reference(
        status["head"]["reference"].as_str().unwrap(),
        workspace_commit,
        true,
        "tampered",
    )
    .unwrap();
    assert_eq!(
        agent(&hub, &grant, "git.log", json!({"work_ref":novel}))["error"]["code"],
        "hetu.integrity_failure"
    );
    assert_eq!(
        ok(call(&k, "documents.get", json!({"document_id":doc_id})))["content"],
        "作者新稿"
    );
}

#[test]
fn independent_drama_versions_reject_revoked_preparations_and_changed_bytes() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("作品");
    let directory = root.path().join("连接");
    let k = Kernel::open(json!({"workspace_path":workspace,"mode":"author","authorization_path":root.path().join("批准"),"create":{"title":"独立剧本版本","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let project = ok(call(
        &k,
        "drama.projects.create",
        json!({"title":"雾港剧本","mode":"original","operation_key":"drama"}),
    ));
    let work = json!({"workspace_id":ok(call(&k, "works.list", json!({})))["works"][0]["work_ref"]["workspace_id"],"kind":"drama","object_id":project["project"]["project_id"]});
    let episode = ok(call(
        &k,
        "drama.episodes.create",
        json!({"project_ref":{"project_id":project["project"]["project_id"],"revision":1,"sha256":project["sha256"]},"title":"渡口重逢","plan":"风雨夜的误会","language_tag":"zh-CN","operation_key":"episode"}),
    ));
    let doc = &episode["document"]["document_id"];
    let first = ok(call(&k, "documents.get", json!({"document_id":doc})));
    let draft = ok(call(
        &k,
        "documents.save",
        json!({"document_id":doc,"base_revision_id":first["revision"]["revision_id"],"source_format":"fountain","content":"INT. 渡口 - 夜\n\n风吹开木门。","operation_key":"draft"}),
    ));
    ok(call(
        &k,
        "git.init",
        json!({"work_ref":work,"branch":"main","operation_key":"git-init"}),
    ));
    let authorize = |key: &str| {
        ok(call(&k,"collaboration.authorize_workspace",json!({"work_ref":work,"client_adapter":"codex","collaboration_path":directory,"operation_key":key})))["management_ref"].clone()
    };
    let grant = authorize("authorize");
    let hub = CollaborationHub::open(&directory, "codex").unwrap();
    let prepare = |grant: &Value, key: &str| {
        let status = ok(agent(&hub, grant, "git.status", json!({"work_ref":work})));
        ok(agent(
            &hub,
            grant,
            "git.snapshot",
            json!({"work_ref":work,"phase":"prepare","expected_head":status["head"],"message":"剧本节点","author":{"name":"作者","email":"author@hetu.test"},"operation_key":key}),
        ))
    };
    let approve = |snapshot: &Value, key: &str| {
        ok(call(
            &k,
            "git.approve_snapshot",
            json!({"work_ref":work,"snapshot_id":snapshot["snapshot"]["snapshot_id"],"snapshot_sha256":snapshot["snapshot_sha256"],"operation_key":key}),
        ))
    };
    let execution = |snapshot: &Value, key: &str| json!({"work_ref":work,"phase":"execute","snapshot_id":snapshot["snapshot"]["snapshot_id"],"operation_key":key});
    let stale = prepare(&grant, "before-revoke");
    approve(&stale, "approve-before-revoke");
    ok(call(
        &k,
        "collaboration.revoke_management",
        json!({"grant_id":grant["grant_id"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"revoke"}),
    ));
    let renewed = authorize("renew");
    assert_ne!(grant, renewed);
    assert_eq!(
        agent(&hub, &grant, "git.snapshot", execution(&stale, "revoked"))["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        agent(
            &hub,
            &renewed,
            "git.snapshot",
            execution(&stale, "renewed-old")
        )["error"]["code"],
        "forbidden"
    );
    let current = prepare(&renewed, "fresh");
    approve(&current, "approve-fresh");
    let saved = ok(agent(
        &hub,
        &renewed,
        "git.snapshot",
        execution(&current, "save-fresh"),
    ));
    let historical = ok(agent(
        &hub,
        &renewed,
        "git.read_version",
        json!({"work_ref":work,"commit_id":saved["commit_id"]}),
    ));
    assert!(historical["files"]
        .as_array()
        .unwrap()
        .iter()
        .all(|f| f["document_id"] == *doc));
    assert!(ok(agent(&hub, &renewed, "git.read_version", json!({"work_ref":work,"commit_id":saved["commit_id"],"path":draft["revision"]["content_path"]})))["content"].as_str().unwrap().contains("风吹开木门"));
    let latest = ok(call(&k, "documents.get", json!({"document_id":doc})));
    let edited = ok(call(
        &k,
        "documents.save",
        json!({"document_id":doc,"base_revision_id":latest["revision"]["revision_id"],"source_format":"fountain","content":"INT. 渡口 - 夜\n\n保留新稿。","operation_key":"edit"}),
    ));
    let changed = prepare(&renewed, "before-edit");
    approve(&changed, "approve-before-edit");
    ok(call(
        &k,
        "documents.save",
        json!({"document_id":doc,"base_revision_id":edited["revision"]["revision_id"],"source_format":"fountain","content":"INT. 渡口 - 夜\n\n作者又有新想法。","operation_key":"edit-again"}),
    ));
    assert_eq!(
        agent(
            &hub,
            &renewed,
            "git.snapshot",
            execution(&changed, "changed")
        )["error"]["code"],
        "revision_conflict"
    );
    assert_eq!(
        ok(call(&k, "documents.get", json!({"document_id":doc})))["content"],
        "INT. 渡口 - 夜\n\n作者又有新想法。"
    );
}
