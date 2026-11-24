//! 稳定CLI以Agent身份完成作者会话决定；夹具授权由Core建立，测试不启动桌面。
use hetu_core::{Kernel, application::extensions::PluginSession};
use serde_json::{Value, json};
use std::{
    io::Write,
    process::{Command, Stdio},
};
fn ok(v: Value) -> Value {
    assert_eq!(v["status"], "succeeded", "{v}");
    v["data"].clone()
}
struct Session {
    root: tempfile::TempDir,
    grant: Value,
    work: Value,
}
impl Session {
    fn new() -> Self {
        Self::new_for("novel")
    }
    fn new_for(kind: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let author=Kernel::open(json!({"workspace_path":root.path().join("work"),"mode":"author","create":{"work_type":kind,"title":"无窗口验收","locale":"zh-CN","operation_key":"init"}})).unwrap();
        if kind == "video" {
            ok(author.request(json!({"action":"hetu.video.projects.create","contract_revision":"1","input":{"title":"无窗口视频","brief":"独立项目","language_tag":"zh-CN","operation_key":"project"}})));
        }
        let work = ok(
            author.request(json!({"action":"hetu.works.list","contract_revision":"1","input":{}}))
        )["works"][0]["work_ref"]
            .clone();
        let grant=ok(author.request(json!({"action":"hetu.collaboration.authorize_workspace","contract_revision":"1","input":{"client_adapter":"codex","collaboration_path":root.path().join("hub"),"work_ref":work,"operation_key":"grant"}})))["management_ref"].clone();
        Self { root, grant, work }
    }
    fn call(&self, action: &str, mut input: Value) -> Value {
        input["management_ref"] = self.grant.clone();
        self.invoke(action,input)
    }
    fn invoke(&self, action: &str, input: Value) -> Value {
        let mut child = Command::new(env!("CARGO_BIN_EXE_hetu"))
            .args([
                "--client",
                "codex",
                "--collaboration-dir",
                self.root.path().join("hub").to_str().unwrap(),
                "call",
                &format!("hetu.{action}"),
                "--input",
                "-",
            ])
            .env("HOME", self.root.path())
            .env("HETU_LOCAL_SETTINGS_DIR",self.root.path().join("settings"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&input).unwrap())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.stderr.is_empty(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
    fn apply(&self, action: &str, input: Value, key: &str) -> Value {
        let p=ok(self.call("agent_operations.prepare",json!({"action":format!("hetu.{action}"),"input":input,"summary":"固定会话操作","operation_key":format!("p-{key}")})));
        ok(self.call("agent_operations.record_decision",json!({"proposal_id":p["proposal_id"],"proposal_sha256":p["proposal_sha256"],"expected_state_revision":p["state_revision"],"decision":"approve","authorization_note":"测试用户明确确认所示方案。","operation_key":format!("d-{key}")})));
        ok(self.call("agent_operations.execute",json!({"proposal_id":p["proposal_id"],"proposal_sha256":p["proposal_sha256"],"operation_key":format!("e-{key}")})))["result"].clone()
    }
}
#[test]
fn stable_task_ref_does_not_bypass_confirm_for_a_working_copy_write() {
    let s=Session::new();
    let author=Kernel::open(json!({"workspace_path":s.root.path().join("work"),"mode":"author"})).unwrap();
    let document=ok(author.request(json!({"action":"hetu.documents.create","contract_revision":"1","input":{"kind":"novel_chapter","title":"任务原章","source_format":"markdown","content":"原章","operation_key":"task-source"}})));
    let preview=ok(s.call("creative_tasks.preview_prompt",json!({"scope_ref":{"kind":"workspace","id":s.work["workspace_id"]},"work_ref":s.work,
        "target_ref":{"document_id":document["document"]["document_id"],"revision_id":document["revision"]["revision_id"],"sha256":document["revision"]["sha256"]},
        "task_kind":"chapter_draft","brief":"隔离任务","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN","candidate_limit":1})));
    let mut input=preview["prepare_input"].clone();input["operation_key"]=json!("prepare-task");
    let task=s.apply("creative_tasks.prepare",input,"task-plan");
    let opened=ok(s.invoke("collaboration.open",json!({"task_locator":{"scope_ref":task["task_ref"]["scope_ref"],"task_id":task["task_ref"]["task_id"]}})));
    let settings=hetu_core::local_settings::LocalSettings::open(&s.root.path().join("settings")).unwrap();
    let before=settings.host(json!({"method":"get","input":{}})).unwrap();
    settings.host(json!({"method":"update","input":{"expected_revision":before["revision"],"patch":{"execution_mode":"confirm"},"operation_key":"task-confirm"}})).unwrap();
    ok(s.invoke("creative_tasks.get",json!({"task_ref":opened["task_ref"]})));
    let rejected=s.invoke("working_copies.create",json!({"task_ref":opened["task_ref"],"artifact_kind":"text","source_format":"markdown","title":"未确认参考稿","base_refs":[],"content":"不能直接保存","operation_key":"unconfirmed-working"}));
    assert_eq!(rejected["error"]["code"],"hetu.execution_confirmation_required");
    let copies=ok(s.invoke("working_copies.list",json!({"task_ref":opened["task_ref"]})));
    assert!(copies["working_copies"].as_array().unwrap().is_empty());
}
#[test]
fn stable_managed_confirm_reads_but_rejects_an_unconfirmed_resource_write() {
    let s=Session::new();
    let input=|key:&str|json!({"work_ref":s.work,"title":"执行模式隔离验收","category":"research","body":"固定资料","tags":[],"project_id":null,"entity_refs":[],"source_notes":"隔离测试","operation_key":key});
    ok(s.call("resources.create",input("auto-resource")));
    let settings=hetu_core::local_settings::LocalSettings::open(&s.root.path().join("settings")).unwrap();
    let before=settings.host(json!({"method":"get","input":{}})).unwrap();
    settings.host(json!({"method":"update","input":{"expected_revision":before["revision"],"patch":{"execution_mode":"confirm"},"operation_key":"switch-confirm"}})).unwrap();
    ok(s.call("resources.list",json!({"work_ref":s.work})));
    let rejected=s.call("resources.create",input("confirm-resource"));
    assert_eq!(rejected["error"]["code"],"hetu.execution_confirmation_required");
    let catalog=ok(s.call("agent_operations.catalog",json!({"action":"hetu.resources.create","include_schema":true})));
    let schema=&catalog["actions"][0]["input_schema"];
    assert_eq!(schema["properties"]["work_ref"]["const"],s.work);
    assert!(schema["required"].as_array().unwrap().iter().any(|field|field=="work_ref"));
    let created=s.apply("resources.create",input("confirmed-resource"),"confirmed-resource");
    assert_eq!(created["resource"]["body"],"固定资料");
    assert_eq!(created["resource"]["actor_ref"],"actor_00000000-0000-4000-8000-000000000002");
    let resources=ok(s.call("resources.list",json!({"work_ref":s.work})));
    assert_eq!(resources["resources"].as_array().unwrap().len(),2);
}
#[test]
fn fixed_document_move_and_restore_use_public_cli_proposals() {
    let s = Session::new();
    let author = Kernel::open(json!({"workspace_path":s.root.path().join("work"),"mode":"author"})).unwrap();
    let create = |title: &str, content: &str| ok(author.request(json!({"action":"hetu.documents.create","contract_revision":"1","input":{
        "kind":"novel_chapter","title":title,"source_format":"markdown","content":content,"operation_key":title}})));
    let source = create("来源", "保留\r\n\r\n移动🌿"); let target = create("目标", "目标原文");
    let reference = |v: &Value| json!({"document_id":v["document"]["document_id"],"revision_id":v["revision"]["revision_id"],"sha256":v["revision"]["sha256"]});
    let moved = s.apply("documents.move_range", json!({"work_ref":s.work,"source_ref":reference(&source),"target_ref":reference(&target),
        "byte_start":"保留\r\n\r\n".len(),"byte_end":"保留\r\n\r\n移动🌿".len(),"quote":"移动🌿","operation_key":"move"}), "move");
    let read = |doc: &Value| ok(s.call("documents.get", json!({"document_id":doc["document"]["document_id"]})));
    assert_eq!(read(&source)["content"], "保留");
    assert_eq!(read(&target)["content"], "目标原文\n\n移动🌿");
    s.apply("documents.restore_move", json!({"work_ref":s.work,"move_ref":moved["move_ref"],"operation_key":"restore"}), "restore");
    assert_eq!(read(&source)["content"], "保留\r\n\r\n移动🌿");
    assert_eq!(read(&target)["content"], "目标原文");
    let directory = ok(s.call("novels.get", json!({})));
    let fresh_source = read(&source);
    let moved_new = s.apply("documents.move_to_new", json!({"work_ref":s.work,"source_ref":reference(&fresh_source),
        "expected":{"revision":directory["revision"],"sha256":directory["sha256"]},"new_target":{"title":"新章节","volume_id":null},
        "byte_start":"保留\r\n\r\n".len(),"byte_end":"保留\r\n\r\n移动🌿".len(),"quote":"移动🌿","operation_key":"move-new"}), "move-new");
    let new_target = read(&moved_new["target"]);
    assert_eq!(new_target["content"], "移动🌿");
    s.apply("documents.restore_move", json!({"work_ref":s.work,"move_ref":moved_new["move_ref"],"operation_key":"restore-new"}), "restore-new");
    assert_eq!(read(&source)["content"], "保留\r\n\r\n移动🌿");
    assert_eq!(ok(s.call("documents.list", json!({"work_ref":s.work}))) ["documents"].as_array().unwrap().len(), 2);
}

#[test]
fn fixed_document_copy_uses_public_cli_proposal_and_original_operation() {
    let s = Session::new();
    let author = Kernel::open(json!({"workspace_path":s.root.path().join("work"),"mode":"author"})).unwrap();
    let source = ok(author.request(json!({"action":"hetu.documents.create","contract_revision":"1","input":{"kind":"novel_chapter","title":"原章","source_format":"markdown","content":"原章🌿\r\n\n尾段。","operation_key":"source"}})));
    let directory = ok(s.call("novels.get",json!({})));
    let input = json!({"work_ref":s.work,"source_ref":{"document_id":source["document"]["document_id"],"revision_id":source["revision"]["revision_id"],"sha256":source["revision"]["sha256"]},"expected":{"revision":directory["revision"],"sha256":directory["sha256"]},"title":"原章 副本","operation_key":"copy"});
    let copied = s.apply("documents.duplicate",input,"copy");
    assert_ne!(copied["document"]["document_id"],source["document"]["document_id"]);
    let actual = ok(s.call("documents.get",json!({"document_id":copied["document"]["document_id"]})));
    assert_eq!(actual["content"],"原章🌿\r\n\n尾段。");
    assert_eq!(actual["document"]["copy_source_ref"]["document_ref"]["revision_id"],source["revision"]["revision_id"]);
    let documents = ok(s.call("documents.list",json!({"work_ref":s.work})));
    assert_eq!(documents["documents"].as_array().unwrap().len(),2);
}
#[test]
fn video_episode_metadata_and_order_are_managed_by_public_cli_without_gui() {
    let s = Session::new_for("video");
    let reference = |p: &Value| json!({"video_project_id":p["project"]["video_project_id"],"revision":p["project"]["revision"],"sha256":p["sha256"]});
    let p = ok(s.call(
        "video.projects.get",
        json!({"video_project_id":s.work["object_id"]}),
    ));
    let a = s.apply("video.episodes.create", json!({"project_ref":reference(&p),"title":"第一集","brief":"雨夜旧站","operation_key":"first"}), "first");
    let b = s.apply("video.episodes.create", json!({"project_ref":reference(&a),"title":"第二集","brief":"末班车","operation_key":"second"}), "second");
    let before = ok(s.call(
        "video.episodes.get",
        json!({"video_episode_id":a["episode"]["video_episode_id"]}),
    ));
    let changed = s.apply("video.episodes.update", json!({"project_ref":before["project_ref"],"video_episode_id":a["episode"]["video_episode_id"],"expected":{"revision":before["episode"]["revision"],"sha256":before["sha256"]},"title":"先听见车轮","brief":"只更新制作计划，保留原素材与工程。","archived":false,"operation_key":"metadata"}), "metadata");
    assert_eq!(changed["episode"]["revision"], 2);
    let reordered = s.apply("video.episodes.reorder", json!({"project_ref":reference(&b),"episode_refs":[b["episode"]["video_episode_id"],a["episode"]["video_episode_id"]],"operation_key":"reorder"}), "reorder");
    assert_eq!(
        reordered["project"]["episode_refs"][0],
        b["episode"]["video_episode_id"]
    );
    let read = ok(s.call(
        "video.episodes.get",
        json!({"video_episode_id":a["episode"]["video_episode_id"]}),
    ));
    assert_eq!(read["episode"], changed["episode"]);
    assert_eq!(read["episode_number"], 2);
    let old = ok(s.call(
        "video.episodes.get",
        json!({"video_episode_id":a["episode"]["video_episode_id"],"revision":1}),
    ));
    assert_eq!(old["episode"], a["episode"]);
    assert_eq!(old["is_head"], false);
    for action in ["hetu.video.episodes.update", "hetu.video.episodes.reorder"] {
        let catalog = ok(s.call(
            "agent_operations.catalog",
            json!({"action":action,"include_schema":true}),
        ));
        assert!(
            catalog["actions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a["name"] == action
                    && a["input_schema"]["properties"]["project_ref"].is_object())
        );
    }
}

#[test]
fn version_snapshot_and_plugin_permissions_complete_in_conversation_without_gui() {
    let s = Session::new();
    s.apply("documents.create",json!({"kind":"novel_chapter","title":"测试篇目","content":"","source_format":"markdown","operation_key":"doc"}),"doc");
    s.apply(
        "git.init",
        json!({"work_ref":s.work,"branch":"main","operation_key":"git"}),
        "git",
    );
    let head = ok(s.call("git.status", json!({"work_ref":s.work})))["head"].clone();
    let prepared=s.call("git.snapshot",json!({"work_ref":s.work,"phase":"prepare","expected_head":head,"message":"固定测试文稿","author":{"name":"测试作者","email":"fixture@hetu.test"},"operation_key":"snapshot"}));
    assert_eq!(prepared["status"], "pending", "{prepared}");
    let snapshot = prepared["data"].clone();
    let execute = json!({"work_ref":s.work,"phase":"execute","snapshot_id":snapshot["snapshot"]["snapshot_id"],"operation_key":"execute-snapshot"});
    assert_eq!(
        s.call("git.snapshot", execute.clone())["error"]["code"],
        "hetu.author_confirmation_required"
    );
    let decision = json!({"work_ref":s.work,"snapshot_id":snapshot["snapshot"]["snapshot_id"],"snapshot_sha256":snapshot["snapshot_sha256"],"authorization_note":"测试用户在当前会话确认此文稿版本及提交身份。","operation_key":"version-decision"});
    let receipt = ok(s.call("git.record_snapshot_decision", decision.clone()));
    assert_eq!(
        ok(s.call("git.record_snapshot_decision", decision)),
        receipt
    );
    let committed = ok(s.call("git.snapshot", execute.clone()));
    assert!(committed["commit_id"].is_string());
    assert_eq!(ok(s.call("git.snapshot", execute)), committed);
    let auth = json!({"work_ref":s.work,"plugin_id":"org.hetu.fixture","package_sha256":"a".repeat(64),"permissions":["objects.read","objects.write"],"types":[{"kind":"fixture","schema_version":"1","schema":{"type":"object"}}],"authorization_note":"测试用户明确授权该包在本作品读写专业对象。","operation_key":"plugin-auth"});
    let grant = ok(s.call("plugin_access.authorize", auth.clone()));
    assert_eq!(ok(s.call("plugin_access.authorize", auth)), grant);
    assert_eq!(
        grant["conversation_decision"]["confirmation_channel"],
        "agent_conversation"
    );
    ok(s.call("plugin_access.inspect",json!({"work_ref":s.work,"grant_id":grant["grant_id"],"package_sha256":grant["package_sha256"]})));
    ok(s.call("plugin_access.revoke",json!({"work_ref":s.work,"grant_id":grant["grant_id"],"authorization_note":"测试用户要求撤销插件授权。","operation_key":"revoke"})));
    assert_eq!(s.call("plugin_access.inspect",json!({"work_ref":s.work,"grant_id":grant["grant_id"],"package_sha256":grant["package_sha256"]}))["error"]["code"],"forbidden");
}

#[test]
fn plugin_migration_uses_exact_conversation_decision_and_parent_revocation() {
    let s = Session::new();
    #[cfg(target_os = "macos")]
    let access = s
        .root
        .path()
        .join("Library/Application Support/Hetu/PluginAccess");
    #[cfg(not(target_os = "macos"))]
    let access = s.root.path().join(".local/share/hetu/PluginAccess");
    let grant = |version: &str, sha: &str| {
        ok(s.call(
            "plugin_access.authorize",
            json!({
                "work_ref":s.work,"plugin_id":"org.hetu.migration","package_sha256":sha,
                "permissions":["objects.read","objects.write"],
                "types":[{"kind":"notes","schema_version":version,"schema":{"type":"object"}}],
                "authorization_note":"测试用户授权确切插件包在本作品管理笔记。",
                "operation_key":format!("grant-{version}")
            }),
        ))
    };
    let old = grant("1", &"a".repeat(64));
    let open = |g: &Value| {
        PluginSession::open(
            &s.root.path().join("work"),
            &access,
            g["grant_id"].as_str().unwrap(),
            g["package_sha256"].as_str().unwrap(),
        )
    };
    let call = |g: &Value, action: &str, input: Value| {
        open(g).unwrap().request(json!({
            "action":format!("hetu.extensions.{action}"),"contract_revision":"1","input":input
        }))
    };
    let before = ok(call(
        &old,
        "objects.save",
        json!({"work_ref":s.work,"kind":"notes",
        "schema_version":"1","title":"迁移笔记","content":{"text":"原值"},
        "expected_revision":0,"expected_sha256":"","operation_key":"create"}),
    ));
    let new = grant("2", &"b".repeat(64));
    let plan = ok(call(
        &new,
        "migrations.prepare",
        json!({"work_ref":s.work,
        "object_id":before["object"]["object_id"],"target_schema_version":"2",
        "content":{"body":"原值"},"expected_revision":1,"expected_sha256":before["sha256"],
        "operation_key":"migrate"}),
    ));
    let execute = json!({"work_ref":s.work,"migration_id":plan["plan"]["migration_id"],
        "plan_sha256":plan["plan_sha256"],"operation_key":"migrate"});
    assert_eq!(
        call(&new, "migrations.execute", execute.clone())["error"]["code"],
        "permission_denied"
    );
    let decision = json!({"work_ref":s.work,"grant_id":new["grant_id"],
        "package_sha256":new["package_sha256"],"migration_id":plan["plan"]["migration_id"],
        "plan_sha256":plan["plan_sha256"],"authorization_note":"测试用户确认所示笔记迁移前后差异。",
        "operation_key":"migration-decision"});
    let receipt = ok(s.call("plugin_access.record_migration_decision", decision.clone()));
    assert_eq!(receipt["executed"], false);
    assert_eq!(
        ok(s.call("plugin_access.record_migration_decision", decision)),
        receipt
    );
    let after = call(&new, "migrations.execute", execute.clone());
    assert_eq!(
        ok(after.clone())["object"]["content"],
        json!({"body":"原值"})
    );
    assert_eq!(call(&new, "migrations.execute", execute), after);
    let author =
        Kernel::open(json!({"workspace_path":s.root.path().join("work"),"mode":"author"})).unwrap();
    ok(author.request(
        json!({"action":"hetu.collaboration.revoke_management","contract_revision":"1",
        "input":{"client_adapter":"codex","collaboration_path":s.root.path().join("hub"),
        "grant_id":s.grant["grant_id"],"operation_key":"revoke-parent"}}),
    ));
    assert!(open(&new).is_err());
    // 失效父授权仍允许宿主清理插件，不能卡住全局停用。
    ok(author.extension_host_request_in(
        &access,
        json!({"method":"disable",
        "params":{"plugin_id":"org.hetu.migration","package_sha256":new["package_sha256"]}}),
    ));
}
