use serde_json::{Value, json};
use std::{
    io::Write,
    path::Path,
    process::{Command, Output, Stdio},
};

fn run(args: &[&str], bytes: &[u8], home: Option<&Path>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_hetu"));
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(home) = home {
        command.env("HOME", home);
    }
    let mut child = command.spawn().unwrap();
    if let Err(error) = child.stdin.take().unwrap().write_all(bytes) {
        assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
    }
    child.wait_with_output().unwrap()
}
fn value(output: Output, code: i32) -> Value {
    assert_eq!(
        output.status.code(),
        Some(code),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["spec_version"], "0.2.1");
    assert!(output.stdout.ends_with(b"\n"));
    result
}
fn call(directory: &Path, action: &str, input: Value, code: i32) -> Value {
    value(
        run(
            &[
                "--client",
                "codex",
                "--collaboration-dir",
                directory.to_str().unwrap(),
                "call",
                action,
                "--input",
                "-",
                "--json",
            ],
            &serde_json::to_vec(&input).unwrap(),
            None,
        ),
        code,
    )
}
fn ok(result: Value) -> Value {
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn managed(directory: &Path, grant: &Value, action: &str, mut input: Value, code: i32) -> Value {
    input["management_ref"] = grant.clone();
    call(directory, action, input, code)
}

#[test]
fn help_locale_and_version_work_without_author_or_user_context() {
    for (args, expected) in [
        (vec!["--help"], "河图洛书命令行"),
        (vec!["--locale", "en", "--help"], "Hetu Luoshu command line"),
    ] {
        let out = run(&args, b"", None);
        assert!(out.status.success() && out.stderr.is_empty());
        assert!(String::from_utf8(out.stdout).unwrap().contains(expected));
    }
    let out = Command::new(env!("CARGO_BIN_EXE_hetu"))
        .arg("--version")
        .env_remove("HOME")
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(
        String::from_utf8(out.stdout).unwrap(),
        format!("hetu {}\n", env!("CARGO_PKG_VERSION"))
    );
    assert_eq!(
        value(run(&["--locale", "fr", "--help"], b"", None), 2)["error"]["code"],
        "invalid_input"
    );
}

#[test]
fn cold_discovery_selects_contracts_and_reads_methods_without_workspace_state() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("未创建的发现连接");
    let doctor = ok(call(&directory, "hetu.runtime.inspect", json!({}), 0));
    assert!(
        doctor["schema_materialization"]["materialized"]
            .as_u64()
            .unwrap()
            <= 2
    );
    assert!(doctor["schema_materialization"]["total"].as_u64().unwrap() > 100);
    let found = ok(call(
        &directory,
        "hetu.collaboration.inspect",
        json!({"query":"TASK_CHECKPOINT CAS","limit":1}),
        0,
    ));
    assert_eq!(found["total"], 1);
    let action = &found["actions"][0];
    assert_eq!(action["name"], "hetu.task_checkpoint.save");
    assert!(action.get("input_schema").is_none());
    assert_eq!(
        action["prerequisites"]["reference_alternatives"],
        json!([["task_ref"]])
    );
    assert_eq!(action["readiness"]["status"], "not_checked");
    assert_eq!(
        call(
            &directory,
            "hetu.collaboration.inspect",
            json!({"query":"feedback", "expected_selection_sha256":found["selection_sha256"]}),
            4
        )["error"]["code"],
        "hetu.stale_evidence"
    );
    let exact = ok(call(
        &directory,
        "hetu.collaboration.inspect",
        json!({"action":action["name"],"include_schema":true,"expected_catalog_sha256":found["catalog_sha256"]}),
        0,
    ));
    assert!(exact["actions"][0]["input_schema"].is_object());
    let methods = ok(call(
        &directory,
        "hetu.methods.list",
        json!({"skill":"hetu-setup"}),
        0,
    ));
    assert_eq!(methods["total"], 1);
    let method = &methods["resources"][0];
    let read = ok(call(
        &directory,
        "hetu.methods.read",
        json!({"path":method["path"],"expected_sha256":method["sha256"],"max_bytes":16384}),
        0,
    ));
    assert_eq!(read["page"]["sha256"], method["sha256"]);
    assert!(
        read["page"]["content"]
            .as_str()
            .unwrap()
            .contains("hetu-setup")
    );
    assert_eq!(
        call(
            &directory,
            "hetu.methods.read",
            json!({"path":method["path"],"expected_sha256":"0".repeat(64)}),
            4
        )["error"]["code"],
        "hetu.stale_evidence"
    );
    assert_eq!(
        call(
            &directory,
            "hetu.methods.read",
            json!({"path":"../../private.md","expected_sha256":"0".repeat(64)}),
            5
        )["error"]["code"],
        "not_found"
    );
    assert!(!directory.exists());
}

#[test]
fn malformed_or_oversized_inputs_have_one_private_axi_error() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("独立授权");
    let args = [
        "--client",
        "codex",
        "--collaboration-dir",
        directory.to_str().unwrap(),
        "call",
        "hetu.creation_projects.create",
        "--input",
        "-",
    ];
    for bytes in [
        b"[1]".as_slice(),
        b"{} {}",
        b"\xff",
        b"{\"secret\":\"not-for-output\"",
        b"",
    ] {
        let result = value(run(&args, bytes, None), 2);
        assert_eq!(result["error"]["code"], "invalid_input");
        assert!(!result.to_string().contains("not-for-output"));
    }
    let too_large = vec![b' '; 16 * 1024 * 1024 + 1];
    assert_eq!(
        value(run(&args, &too_large, None), 2)["error"]["code"],
        "invalid_input"
    );
    assert!(!directory.exists());
}

#[test]
fn identity_overrides_relative_roots_and_missing_task_do_not_create_state() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("未创建");
    let path = directory.to_str().unwrap();
    for args in [
        vec!["--author"],
        vec!["--workspace", path, "--author", "capabilities"],
        vec![
            "--client",
            "codex",
            "--collaboration-dir",
            path,
            "--yes",
            "capabilities",
        ],
        vec![
            "--client",
            "codex",
            "--collaboration-dir",
            "relative",
            "capabilities",
        ],
        vec!["--creation-project", path, "capabilities"],
        vec!["--workspace", "relative", "capabilities"],
    ] {
        assert_eq!(
            value(run(&args, b"", None), 2)["error"]["code"],
            "invalid_input"
        );
    }
    assert!(!directory.exists());
}

#[test]
fn stable_discovery_is_read_only_and_file_input_matches_stdin() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("中文 空格接入");
    let inspected = value(
        run(
            &[
                "--client",
                "codex",
                "--collaboration-dir",
                directory.to_str().unwrap(),
                "collaboration",
                "inspect",
            ],
            b"",
            None,
        ),
        0,
    );
    assert!(!directory.exists());
    let file = root.path().join("输入 中文.json");
    std::fs::write(&file, b"\xef\xbb\xbf{}").unwrap();
    let from_file = value(
        run(
            &[
                "--client",
                "codex",
                "--collaboration-dir",
                directory.to_str().unwrap(),
                "call",
                "hetu.collaboration.inspect",
                "--input",
                file.to_str().unwrap(),
            ],
            b"",
            None,
        ),
        0,
    );
    assert_eq!(inspected, from_file);
    assert_eq!(
        inspected,
        call(&directory, "hetu.collaboration.inspect", json!({}), 0)
    );
    assert!(!directory.exists());
    assert_eq!(
        call(&directory, "hetu.this_action_does_not_exist", json!({}), 8)["error"]["code"],
        "hetu.capability_unavailable"
    );
    assert_eq!(
        call(&directory, "hetu.working_copies.list", json!({}), 2)["error"]["code"],
        "invalid_input"
    );
}

#[test]
fn doctor_reports_runtime_and_unknown_session_without_creating_a_connection() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("not-created");
    let receipt = value(
        run(
            &[
                "--client",
                "codex",
                "--collaboration-dir",
                directory.to_str().unwrap(),
                "doctor",
            ],
            b"",
            None,
        ),
        0,
    );
    assert_eq!(
        receipt["data"]["runtime_version"],
        env!("CARGO_PKG_VERSION")
    );
    assert_eq!(receipt["data"]["session_skill_loading"], "unknown");
    assert_eq!(receipt["data"]["repairs_performed"], false);
    assert!(!directory.exists());
}

#[test]
fn bootstrap_task_replay_fixed_submission_and_legacy_read_share_core_state() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("接入");
    let start_input = json!({"brief":"旧站车票悬疑。","locale":"zh-CN","operation_key":"start"});
    let start_result = call(
        &directory,
        "hetu.creation_projects.create",
        start_input.clone(),
        0,
    );
    let start = ok(start_result.clone());
    assert_eq!(
        call(&directory, "hetu.creation_projects.create", start_input, 0),
        start_result
    );
    assert_eq!(
        call(
            &directory,
            "hetu.creation_projects.create",
            json!({"brief":"异参","locale":"zh-CN","operation_key":"start"}),
            4
        )["error"]["code"],
        "idempotency_conflict"
    );
    let work = ok(managed(
        &directory,
        &start["management_ref"],
        "hetu.creation_projects.create_novel",
        json!({
        "project_id":start["project"]["project_id"],"expected":{"revision":start["revision"],"sha256":start["sha256"]},
        "target_path":start["target_path"],"metadata":{"title":"末班车之后","author_name":"验收","synopsis":"一张明天的车票。","genre":"悬疑","language_tag":"zh-CN","status":"planning"},"operation_key":"book"}),
        0,
    ));
    let grant = &work["workspace_management_ref"];
    let document = ok(managed(
        &directory,
        grant,
        "hetu.documents.create",
        json!({"kind":"novel_chapter","title":"雨夜","source_format":"markdown","content":"","operation_key":"empty"}),
        0,
    ));
    let preview = ok(managed(
        &directory,
        grant,
        "hetu.creative_tasks.preview_prompt",
        json!({"scope_ref":grant["scope_ref"],"task_kind":"chapter_draft",
        "brief":"只写参考稿。","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN"}),
        0,
    ));
    let mut prepare = preview["prepare_input"].clone();
    prepare["operation_key"] = json!("task");
    let task = ok(managed(
        &directory,
        grant,
        "hetu.creative_tasks.prepare",
        prepare,
        0,
    ));
    let opened = ok(value(
        run(
            &[
                "--client",
                "codex",
                "--collaboration-dir",
                directory.to_str().unwrap(),
                "collaboration",
                "open",
                "--input",
                "-",
            ],
            &serde_json::to_vec(&json!({"task_locator":task["task_locator"]})).unwrap(),
            None,
        ),
        0,
    ));
    let reference = &opened["task_ref"];
    let first = ok(call(
        &directory,
        "hetu.working_copies.create",
        json!({"task_ref":reference,"artifact_kind":"text","source_format":"markdown",
        "title":"雨夜参考稿","base_refs":[],"content":"阿青收下一张未来车票。\r\n","operation_key":"first"}),
        0,
    ));
    let save_input = json!({"task_ref":reference,"working_copy_id":first["working_copy_ref"]["working_copy_id"],"expected":first["working_copy_ref"],
        "content":"雨水洇开了车票背面的日期。\r\n","feedback_refs":[],"operation_key":"second"});
    let saved = call(
        &directory,
        "hetu.working_copies.save",
        save_input.clone(),
        0,
    );
    let second = ok(saved.clone());
    assert_eq!(
        call(&directory, "hetu.working_copies.save", save_input, 0),
        saved
    );
    assert_eq!(
        ok(call(
            &directory,
            "hetu.working_copies.get",
            json!({"task_ref":reference,"working_copy_ref":first["working_copy_ref"]}),
            0
        ))["revision"]["content"],
        "阿青收下一张未来车票。\r\n"
    );
    let submitted = ok(call(
        &directory,
        "hetu.creative_tasks.submit_result",
        json!({"task_ref":reference,"request_sha256":reference["sha256"],"working_copy_refs":[second["working_copy_ref"]],
        "feedback_refs":[],"complete":true,"missing_items":[],"provenance":{"client":"rust-cli-test","skill_version":"0.3.2"},"operation_key":"submit"}),
        0,
    ));
    assert_eq!(
        submitted["submission"]["candidates"][0]["working_copy_ref"],
        second["working_copy_ref"]
    );
    let read = ok(managed(
        &directory,
        grant,
        "hetu.documents.get",
        json!({"document_id":document["document"]["document_id"]}),
        0,
    ));
    assert_eq!(read["content"], "");
    let path = work["target_path"].as_str().unwrap();
    let legacy = value(
        run(
            &[
                "--workspace",
                path,
                "call",
                "hetu.documents.get",
                "--input",
                "-",
            ],
            &serde_json::to_vec(&json!({"document_id":document["document"]["document_id"]}))
                .unwrap(),
            None,
        ),
        0,
    );
    for field in ["document", "revision", "content"] {
        assert_eq!(legacy["data"][field], read[field]);
    }
    assert_eq!(value(run(&["--workspace",path,"call","hetu.documents.save","--input","-"],&serde_json::to_vec(&json!({
        "document_id":document["document"]["document_id"],"base_revision_id":document["revision"]["revision_id"],"source_format":"markdown","content":"不得覆盖","operation_key":"deny"})).unwrap(),None),3)["error"]["code"],"forbidden");
}

#[test]
fn local_settings_share_core_without_a_window_or_recursive_cli() {
    let root = tempfile::tempdir().unwrap();
    let started = std::time::Instant::now();
    let path = root.path().join("settings");
    let run_local = |prefix: &[&str], action: &str, input: Value, code| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_hetu"));
        command
            .args(prefix)
            .args(["call", action, "--input", "-"])
            .env("HETU_LOCAL_SETTINGS_DIR", &path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&input).unwrap())
            .unwrap();
        value(child.wait_with_output().unwrap(), code)
    };
    let plan=run_local(&["--client","codex"],"hetu.local_settings.prepare",json!({"kind":"preferences","patch":{"font_size":21},"summary":"设置字号","operation_key":"prepare"}),0)["data"].clone();
    let service = hetu_core::local_settings::LocalSettings::open(&path).unwrap();
    assert_eq!(
        run_local(
            &["--local", "--client", "codex"],
            "hetu.local_settings.execute",
            json!({"operation_id":plan["operation_id"],"sha256":plan["sha256"],"operation_key":"execute"}),
            3
        )["error"]["code"],
        "hetu.author_confirmation_required"
    );
    service.host(json!({"method":"decide","input":{"operation_id":plan["operation_id"],"sha256":plan["sha256"],"revision":1,"approve":true,"operation_key":"decide"}})).unwrap();
    let applied = run_local(
        &["--client", "codex"],
        "hetu.local_settings.execute",
        json!({"operation_id":plan["operation_id"],"sha256":plan["sha256"],"operation_key":"execute"}),
        0,
    );
    assert_eq!(applied["data"]["result"]["font_size"], 21);
    assert_eq!(
        run_local(
            &["--local", "--client", "codex"],
            "hetu.local_settings.get",
            json!({}),
            0
        )["data"]["preferences"]["font_size"],
        21
    );
    assert!(started.elapsed().as_secs() < 10);
}

#[test]
fn model_status_exposes_only_connection_projection_and_never_configuration() {
    let root = tempfile::tempdir().unwrap();
    let result = value(
        run(
            &["model-service", "status", "--json"],
            b"",
            Some(root.path()),
        ),
        0,
    );
    assert_eq!(result["action"], "hetu.model_service.settings");
    assert_eq!(result["data"]["connection_state"], "disconnected");
    assert!(
        result["data"]
            .as_object()
            .unwrap()
            .keys()
            .all(|key| matches!(
                key.as_str(),
                "connected"
                    | "origin"
                    | "account_ref"
                    | "expires_at"
                    | "connection_state"
                    | "next_action"
            ))
    );
    for command in ["custom_save", "select", "disconnect", "approve"] {
        assert_eq!(
            value(run(&["model-service", command], b"", Some(root.path())), 2)["error"]["code"],
            "invalid_input"
        );
    }
}

#[test]
fn workspace_auto_and_stable_confirm_use_one_setting_without_management_or_task_grants() {
    let directory = tempfile::tempdir().unwrap(); let settings = directory.path().join("settings"); let workspace = directory.path().join("work");
    let _author = hetu_core::Kernel::open(json!({"mode":"author","workspace_path":workspace,"create":{"title":"CLI模式","locale":"zh-CN","operation_key":"create"}})).unwrap();
    let invoke = |stable: bool, action: &str, input: Value| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_hetu")); command.env("HETU_LOCAL_SETTINGS_DIR",&settings);
        if stable {command.args(["--client","generic"]);} else {command.arg("--workspace").arg(&workspace);}
        command.args(["call",action,"--input","-"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child=command.spawn().unwrap(); child.stdin.take().unwrap().write_all(&serde_json::to_vec(&input).unwrap()).unwrap();
        let result=child.wait_with_output().unwrap(); assert!(result.stderr.is_empty(),"{}",String::from_utf8_lossy(&result.stderr));
        serde_json::from_slice::<Value>(&result.stdout).unwrap()
    };
    let created=invoke(false,"hetu.documents.create",json!({"kind":"novel_chapter","title":"直接新建","source_format":"markdown","content":"Agent原文🌿","operation_key":"create"}));
    assert_eq!(created["status"],"succeeded","{created}");
    assert_eq!(created["data"]["revision"]["origin_kind"],"agent");
    assert_eq!(invoke(true,"hetu.execution.get_mode",json!({}))["data"]["execution_mode"],"auto");
    let service=hetu_core::local_settings::LocalSettings::open(&settings).unwrap();
    service.host(json!({"method":"update","input":{"expected_revision":1,"patch":{"execution_mode":"confirm"},"operation_key":"confirm"}})).unwrap();
    let document=created["data"]["document"]["document_id"].clone();
    assert_eq!(invoke(false,"hetu.documents.get",json!({"document_id":document}))["status"],"succeeded");
    let fixed=json!({"action":"hetu.documents.rename","contract_revision":"1","input":{"document_id":document,"base_revision_id":created["data"]["revision"]["revision_id"],"title":"集中改名","operation_key":"rename"}});
    assert_eq!(invoke(false,"hetu.documents.rename",fixed["input"].clone())["error"]["code"],"hetu.execution_confirmation_required");
    let plan=invoke(true,"hetu.execution.prepare",json!({"workspace_path":workspace,"commands":[fixed],"summary":"本次改名","operation_key":"batch"}));
    assert_eq!(plan["status"],"succeeded","{plan}"); let reference=json!({"plan_id":plan["data"]["plan_id"],"sha256":plan["data"]["sha256"]});
    assert_eq!(invoke(false,"hetu.execution.record_confirmation",json!({"plan_ref":reference,"decision":"confirm","user_instruction":"确认本次章节改名","operation_key":"decision"}))["status"],"succeeded");
    let executed=invoke(true,"hetu.execution.execute",json!({"plan_ref":reference})); assert_eq!(executed["data"]["state"],"completed","{executed}");
    assert_eq!(invoke(false,"hetu.documents.get",json!({"document_id":document}))["data"]["content"],"Agent原文🌿");
}
