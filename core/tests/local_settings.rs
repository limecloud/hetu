use hetu_core::local_settings::LocalSettings;
use serde_json::{Value, json};

fn call(service: &LocalSettings, client: &str, action: &str, input: Value) -> Value {
    let result = service.request(client,json!({"action":format!("hetu.local_settings.{action}"),"contract_revision":"1","input":input}));
    let schema: Value =
        serde_json::from_str(include_str!("../../contracts/schemas/result.schema.json")).unwrap();
    jsonschema::validator_for(&schema)
        .unwrap()
        .validate(&result)
        .unwrap();
    result
}
fn data(result: Value) -> Value {
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn prepare(service: &LocalSettings, key: &str, patch: Value) -> Value {
    data(call(
        service,
        "codex",
        "prepare",
        json!({"kind":"preferences","patch":patch,"summary":"阅读偏好","operation_key":key}),
    ))
}
fn decide(_service: &LocalSettings, plan: &Value, key: &str) -> Value {
    json!({"method":"decide","input":{"operation_id":plan["operation_id"],"sha256":plan["sha256"],"revision":plan["revision"],"approve":true,"operation_key":key}})
}
fn execute(service: &LocalSettings, plan: &Value, key: &str) -> Value {
    call(
        service,
        "codex",
        "execute",
        json!({"operation_id":plan["operation_id"],"sha256":plan["sha256"],"operation_key":key}),
    )
}
#[test]
fn fixed_settings_require_author_decision_and_replay_the_original_transaction() {
    let folder = tempfile::tempdir().unwrap();
    let service = LocalSettings::open(folder.path()).unwrap();
    assert_eq!(
        data(call(&service, "codex", "get", json!({})))["preferences"]["font_size"],
        18
    );
    let plan = prepare(
        &service,
        "first",
        json!({"font_size":22,"appearance":"dark"}),
    );
    assert_eq!(
        prepare(
            &service,
            "first",
            json!({"appearance":"dark","font_size":22})
        )["operation_id"],
        plan["operation_id"]
    );
    assert_eq!(
        call(
            &service,
            "codex",
            "prepare",
            json!({"kind":"preferences","patch":{"font_size":23},"summary":"阅读偏好","operation_key":"first"})
        )["error"]["code"],
        "idempotency_conflict"
    );
    assert_eq!(
        execute(&service, &plan, "apply")["error"]["code"],
        "hetu.author_confirmation_required"
    );
    assert_eq!(
        call(&service, "codex", "decide", json!({}))["error"]["code"],
        "hetu.capability_unavailable"
    );
    assert_eq!(
        call(
            &service,
            "claude-code",
            "get_operation",
            json!({"operation_id":plan["operation_id"]})
        )["error"]["code"],
        "forbidden"
    );
    let decision = decide(&service, &plan, "author-decision");
    let approved = service.host(decision.clone()).unwrap();
    assert_eq!(approved["state"], "approved");
    assert_eq!(
        data(call(&service, "codex", "get", json!({})))["preferences"]["font_size"],
        18
    );
    let applied = data(execute(&service, &plan, "apply"));
    assert_eq!(applied["state"], "executed");
    assert_eq!(applied["result"]["font_size"], 22);
    drop(service);
    let service = LocalSettings::open(folder.path()).unwrap();
    assert_eq!(data(execute(&service, &plan, "apply")), applied);
    assert_eq!(
        execute(&service, &plan, "different-key")["error"]["code"],
        "idempotency_conflict"
    );
    assert_eq!(service.host(decision).unwrap(), approved);
    assert_eq!(
        service.host(json!({"method":"get","input":{}})).unwrap()["revision"],
        2
    );
    assert!(service.host(json!({"method":"decide","input":{"operation_id":plan["operation_id"],"sha256":plan["sha256"],"revision":2,"approve":false,"operation_key":"author-decision"}})).is_err());
    for patch in [
        json!({"api_key":"secret"}),
        json!({"font_size":100}),
        json!({"appearance":"blue"}),
        json!({"git_author_name":"x\ny"}),
    ] {
        assert_eq!(
            call(
                &service,
                "codex",
                "prepare",
                json!({"kind":"preferences","patch":patch,"summary":"不得写入","operation_key":"invalid"})
            )["status"],
            "blocked"
        );
    }
    let mut forged = json!({"kind":"preferences","patch":{"font_size":19},"summary":"伪造","operation_key":"forged","approved":true});
    assert_eq!(
        call(&service, "codex", "prepare", forged.clone())["status"],
        "blocked"
    );
    forged.as_object_mut().unwrap().remove("approved");
    forged["workspace_id"] = json!("workspace_00000000-0000-4000-8000-000000000000");
    assert_eq!(
        call(&service, "codex", "prepare", forged)["status"],
        "blocked"
    );
}

#[test]
fn concurrent_manual_changes_invalidate_old_plans_without_overwriting_preferences() {
    let folder = tempfile::tempdir().unwrap();
    let service = LocalSettings::open(folder.path()).unwrap();
    let stale = prepare(&service, "stale", json!({"font_size":20}));
    service
        .host(decide(&service, &stale, "approve-stale"))
        .unwrap();
    let manual = json!({"method":"update","input":{"expected_revision":1,"patch":{"font_size":24},"operation_key":"manual"}});
    let changed = service.host(manual.clone()).unwrap();
    assert_eq!(service.host(manual).unwrap(), changed);
    assert_eq!(
        execute(&service, &stale, "stale-execute")["error"]["code"],
        "revision_conflict"
    );
    assert!(
        service
            .host(decide(&service, &stale, "another-approval"))
            .is_err()
    );
    assert_eq!(
        data(call(
            &service,
            "codex",
            "get_operation",
            json!({"operation_id":stale["operation_id"]})
        ))["is_current"],
        false
    );
    let second = prepare(&service, "second", json!({"line_spacing":8}));
    service
        .host(decide(&service, &second, "second-approval"))
        .unwrap();
    data(execute(&service, &second, "second-execute"));
    let state = service.host(json!({"method":"get","input":{}})).unwrap();
    assert_eq!(state["preferences"]["font_size"], 24);
    assert_eq!(state["preferences"]["line_spacing"], 8);
    let first = service
        .host(json!({"method":"list","input":{"limit":1}}))
        .unwrap();
    let next = service
        .host(json!({"method":"list","input":{"limit":1,"cursor":first["next_cursor"]}}))
        .unwrap();
    assert_ne!(
        first["operations"][0]["operation_id"],
        next["operations"][0]["operation_id"]
    );
    assert!(next["next_cursor"].is_null());
}

#[test]
fn work_associations_are_exact_replayable_and_do_not_change_defaults_or_siblings() {
    let folder = tempfile::tempdir().unwrap();
    let service = LocalSettings::open(folder.path()).unwrap();
    let work = json!({"workspace_id":"workspace_11111111-1111-4111-8111-111111111111","kind":"novel","object_id":"novel_first"});
    let sibling =
        json!({"workspace_id":work["workspace_id"],"kind":"novel","object_id":"novel_second"});
    let original = data(call(&service, "codex", "get", json!({})));
    let selection = json!({"method":"associate","input":{"expected_revision":1,"work_ref":work,"agent_client":"codex","suite_id":"historical-brainstorm","operation_key":"choose-work"}});
    let changed = service.host(selection.clone()).unwrap();
    assert_eq!(changed["revision"], 2);
    assert_eq!(service.host(selection).unwrap(), changed);
    assert_eq!(
        data(call(&service, "codex", "get", json!({"work_ref":work})))["association"]["suite"],
        "historical-brainstorm"
    );
    assert!(
        data(call(&service, "codex", "get", json!({"work_ref":sibling})))["association"]["suite"]
            .is_null()
    );
    assert!(
        data(call(
            &service,
            "codex",
            "get",
            json!({"workspace_id":work["workspace_id"]})
        ))["association"]["suite"]
            .is_null()
    );
    assert_eq!(
        data(call(&service, "codex", "get", json!({})))["preferences"],
        original["preferences"]
    );
    assert!(service.host(json!({"method":"associate","input":{"expected_revision":1,"work_ref":sibling,"agent_client":"workbuddy","suite_id":"general","operation_key":"stale"}})).is_err());
    assert_eq!(
        call(
            &service,
            "codex",
            "get",
            json!({"work_ref":work,"workspace_id":work["workspace_id"]})
        )["status"],
        "blocked"
    );
    assert_eq!(
        call(
            &service,
            "codex",
            "inspect_suite",
            json!({"agent_client":"none","suite_id":"general","directory":"/arbitrary"})
        )["status"],
        "blocked"
    );
    let inspection = data(call(
        &service,
        "codex",
        "inspect_suite",
        json!({"agent_client":"none","suite_id":"general"}),
    ));
    assert_eq!(inspection["session"], "unverified");
    assert_eq!(inspection["state"], "manual");
    assert_eq!(
        data(call(&service, "codex", "get", json!({})))["skills"]
            .as_array()
            .unwrap()
            .len(),
        13
    );
    let plan = data(call(
        &service,
        "codex",
        "prepare",
        json!({"kind":"agent_suite","work_ref":sibling,"agent_client":"workbuddy","suite_id":"general","install":false,"summary":"为同根另一作品选择套件","operation_key":"sibling-plan"}),
    ));
    service
        .host(decide(&service, &plan, "sibling-approve"))
        .unwrap();
    data(execute(&service, &plan, "sibling-execute"));
    assert_eq!(
        data(call(&service, "codex", "get", json!({"work_ref":sibling})))["association"]["client"],
        "workbuddy"
    );
    assert_eq!(
        data(call(&service, "codex", "get", json!({"work_ref":work})))["association"]["client"],
        "codex"
    );
    assert_eq!(
        data(call(&service, "codex", "get", json!({})))["preferences"],
        original["preferences"]
    );
}

#[test]
fn default_association_replays_without_overwriting_exact_work_choices() {
    let folder = tempfile::tempdir().unwrap();
    let service = LocalSettings::open(folder.path()).unwrap();
    let work = json!({"workspace_id":"workspace_11111111-1111-4111-8111-111111111111","kind":"novel","object_id":"novel_first"});
    service.host(json!({"method":"associate","input":{"expected_revision":1,"work_ref":work,"agent_client":"codex","suite_id":"historical-brainstorm","operation_key":"work-choice"}})).unwrap();
    let selection = json!({"method":"associate","input":{"expected_revision":2,"agent_client":"workbuddy","suite_id":"military","operation_key":"default-choice"}});
    let result = service.host(selection.clone()).unwrap();
    assert_eq!(result["revision"], 3);
    assert_eq!(result["preferences"]["agent_client"], "workbuddy");
    let reopened = LocalSettings::open(folder.path()).unwrap();
    assert_eq!(reopened.host(selection.clone()).unwrap(), result);
    assert_eq!(
        data(call(&reopened, "codex", "get", json!({})))["association"]["suite"],
        "military"
    );
    assert_eq!(
        data(call(&reopened, "codex", "get", json!({"work_ref":work})))["association"]["suite"],
        "historical-brainstorm"
    );
    let mut changed = selection.clone();
    changed["input"]["suite_id"] = json!("general");
    assert!(reopened.host(changed).is_err());
    let mut stale = selection;
    stale["input"]["operation_key"] = json!("stale-default");
    assert!(reopened.host(stale).is_err());
    assert_eq!(
        call(&reopened, "codex", "associate", json!({}))["error"]["code"],
        "hetu.capability_unavailable"
    );
    let directory = json!({"method":"package_directory","input":{"expected_revision":3,"agent_client":"workbuddy","suite_id":"military","directory":null,"operation_key":"default-auto-detect"}});
    let selected = reopened.host(directory.clone()).unwrap();
    assert_eq!(selected["revision"], 4);
    assert_eq!(reopened.host(directory).unwrap(), selected);
}

#[cfg(unix)]
fn suite_child(test: &str) -> bool {
    use std::{os::unix::fs::PermissionsExt, process::Command};
    if std::env::var_os("HETU_SETTINGS_SUITE_CHILD").is_none() {
        let folder = tempfile::tempdir().unwrap();
        fn copy_directory(from: &std::path::Path, to: &std::path::Path) {
            std::fs::create_dir_all(to).unwrap();
            for entry in std::fs::read_dir(from).unwrap() {
                let entry = entry.unwrap();
                let target = to.join(entry.file_name());
                if entry.file_type().unwrap().is_dir() {
                    copy_directory(&entry.path(), &target);
                } else {
                    std::fs::copy(entry.path(), target).unwrap();
                }
            }
        }
        let integrations = folder.path().join("integrations");
        for name in ["hetu", "hetu-military"] {
            copy_directory(
                &std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../integrations/codex")
                    .join(name),
                &integrations.join("codex").join(name),
            );
        }
        let executable = folder.path().join("codex-test");
        std::fs::write(&executable, include_str!("fixtures/codex-settings.py")).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test, "--nocapture"])
            .env("HETU_SETTINGS_SUITE_CHILD", "1")
            .env("HETU_INTEGRATIONS_DIR", &integrations)
            .env("HETU_LOCAL_SETTINGS_DIR", folder.path().join("settings"))
            .env("HETU_CODEX_BINARY", executable)
            .env("CODEX_HOME", folder.path().join("codex"))
            .env("WORKBUDDY_CONFIG_DIR", folder.path().join("workbuddy"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return false;
    }
    true
}

#[cfg(unix)]
fn suite_fixture() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var_os("CODEX_HOME").unwrap())
}

#[cfg(unix)]
fn suite_version(version: &str) -> std::path::PathBuf {
    use sha2::{Digest, Sha256};
    let source = std::path::PathBuf::from(std::env::var_os("HETU_INTEGRATIONS_DIR").unwrap())
        .join("codex/hetu");
    let manifest_path = source.join("references/method-manifest.json");
    let mut methods: Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    for name in ["plugin.json", ".codex-plugin/plugin.json"] {
        let path = source.join(name);
        let mut manifest: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        manifest["version"] = json!(version);
        let bytes = serde_json::to_vec(&manifest).unwrap();
        methods["files"][name] = json!(format!("{:x}", Sha256::digest(&bytes)));
        std::fs::write(path, bytes).unwrap();
    }
    methods["version"] = json!(version);
    std::fs::write(manifest_path, serde_json::to_vec(&methods).unwrap()).unwrap();
    source
}

#[cfg(unix)]
#[test]
fn suite_empty_market_conflict_is_not_replayed() {
    if !suite_child("suite_empty_market_conflict_is_not_replayed") {
        return;
    }
    let service = LocalSettings::open_default().unwrap();
    let plan = data(call(
        &service,
        "codex",
        "prepare",
        json!({"kind":"agent_suite","agent_client":"codex","suite_id":"general","install":true,"summary":"核对同名市场冲突","operation_key":"market-conflict"}),
    ));
    service
        .host(decide(&service, &plan, "approve-market-conflict"))
        .unwrap();
    let root = suite_fixture();
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("market-add-conflict"), b"").unwrap();
    assert_eq!(
        execute(&service, &plan, "market-execute")["status"],
        "unknown"
    );
    std::fs::remove_file(root.join("market-add-conflict")).unwrap();
    // 空目录不证明官方add未发生；即使故障消失也不得重发。
    assert_eq!(
        execute(&service, &plan, "market-execute")["status"],
        "unknown"
    );
    let log = std::fs::read_to_string(root.join("calls.log")).unwrap();
    assert_eq!(
        log.lines()
            .filter(|l| l.starts_with("plugin marketplace add "))
            .count(),
        1
    );
    assert_eq!(
        log.lines().filter(|l| l.starts_with("plugin add ")).count(),
        0
    );
}

#[cfg(unix)]
#[test]
fn suite_upgrade_checks_sources_and_caches_before_mutation() {
    if !suite_child("suite_upgrade_checks_sources_and_caches_before_mutation") {
        return;
    }
    let service = LocalSettings::open_default().unwrap();
    let prepare_suite = |key: &str| {
        data(call(
            &service,
            "codex",
            "prepare",
            json!({"kind":"agent_suite","agent_client":"codex","suite_id":"general","install":true,"summary":"所选套件升级","operation_key":key}),
        ))
    };
    let first = prepare_suite("first");
    service
        .host(decide(&service, &first, "approve-first"))
        .unwrap();
    let installed = data(execute(&service, &first, "first-execute"));
    let cache = std::path::PathBuf::from(installed["installation"]["directory"].as_str().unwrap());
    let old_manifest = std::fs::read(cache.join("plugin.json")).unwrap();
    let source = suite_version("9.9.1");
    let upgrade = prepare_suite("upgrade");
    assert_ne!(
        upgrade["fixed"]["suite"]["package_sha256"],
        first["fixed"]["suite"]["package_sha256"]
    );
    assert_eq!(
        call(
            &service,
            "codex",
            "prepare",
            json!({"kind":"agent_suite","agent_client":"codex","suite_id":"military","install":true,"summary":"所选套件升级","operation_key":"upgrade"})
        )["error"]["code"],
        "idempotency_conflict"
    );
    service
        .host(decide(&service, &upgrade, "approve-upgrade"))
        .unwrap();
    let root = suite_fixture();
    for fault in ["foreign-source", "duplicate-record"] {
        std::fs::write(root.join(fault), b"").unwrap();
        assert_eq!(
            execute(&service, &upgrade, "upgrade-execute")["error"]["code"],
            "revision_conflict"
        );
        assert_eq!(
            data(call(
                &service,
                "codex",
                "get_operation",
                json!({"operation_id":upgrade["operation_id"]})
            ))["state"],
            "approved"
        );
        std::fs::remove_file(root.join(fault)).unwrap();
    }
    std::fs::write(cache.join("plugin.json"), b"author modified cache").unwrap();
    assert_eq!(
        execute(&service, &upgrade, "upgrade-execute")["error"]["code"],
        "revision_conflict"
    );
    assert_eq!(
        std::fs::read(cache.join("plugin.json")).unwrap(),
        b"author modified cache"
    );
    std::fs::write(cache.join("plugin.json"), &old_manifest).unwrap();
    let target = cache.parent().unwrap().join("9.9.1");
    std::fs::create_dir(&target).unwrap();
    std::fs::write(target.join("plugin.json"), b"different target").unwrap();
    assert_eq!(
        execute(&service, &upgrade, "upgrade-execute")["error"]["code"],
        "revision_conflict"
    );
    std::fs::remove_file(target.join("plugin.json")).unwrap();
    std::fs::remove_dir(&target).unwrap();
    std::os::unix::fs::symlink(root.join("missing-target"), &target).unwrap();
    assert_eq!(
        execute(&service, &upgrade, "upgrade-execute")["error"]["code"],
        "hetu.unsafe_path"
    );
    assert!(
        std::fs::symlink_metadata(&target)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    std::fs::remove_file(&target).unwrap();
    let upgraded = data(execute(&service, &upgrade, "upgrade-execute"));
    assert_eq!(upgraded["installation"]["version"], "9.9.1");
    assert_eq!(upgraded["installation"]["session_loaded"], false);
    assert_eq!(
        std::fs::read(cache.join("plugin.json")).unwrap(),
        old_manifest
    );
    let changed = prepare_suite("changed-bundle");
    service
        .host(decide(&service, &changed, "approve-changed"))
        .unwrap();
    std::fs::write(
        source.join("skills/hetu-manage/SKILL.md"),
        b"changed after review",
    )
    .unwrap();
    assert_eq!(
        execute(&service, &changed, "changed-execute")["error"]["code"],
        "hetu.integrity_failure"
    );
    let log = std::fs::read_to_string(root.join("calls.log")).unwrap();
    assert_eq!(
        log.lines().filter(|l| l.starts_with("plugin add ")).count(),
        2
    );
    assert!(!log.contains("plugin marketplace list"));
}

#[cfg(unix)]
#[test]
fn suite_installation_recovers_registered_bytes_without_repeating_external_install() {
    if !suite_child(
        "suite_installation_recovers_registered_bytes_without_repeating_external_install",
    ) {
        return;
    }
    let service = LocalSettings::open_default().unwrap();
    let catalog = data(call(&service, "codex", "get", json!({})));
    assert!(catalog["suites"].as_array().unwrap().len() > 1);
    let plan = data(call(
        &service,
        "codex",
        "prepare",
        json!({"kind":"agent_suite","agent_client":"codex","suite_id":"general","install":true,"summary":"安装单套件","operation_key":"suite"}),
    ));
    service
        .host(decide(&service, &plan, "suite-approval"))
        .unwrap();
    let root = suite_fixture();
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("fail-list"), b"").unwrap();
    assert_eq!(
        execute(&service, &plan, "suite-execute")["error"]["code"],
        "hetu.capability_unavailable"
    );
    assert_eq!(
        data(call(
            &service,
            "codex",
            "get_operation",
            json!({"operation_id":plan["operation_id"]})
        ))["state"],
        "approved"
    );
    std::fs::remove_file(root.join("fail-list")).unwrap();
    std::fs::write(root.join("drop-receipt"), b"").unwrap();
    // 夹具完成官方登记后故意丢失第一次安装回执。
    assert_eq!(
        execute(&service, &plan, "suite-execute")["status"],
        "unknown"
    );
    let executing = data(call(
        &service,
        "codex",
        "get_operation",
        json!({"operation_id":plan["operation_id"]}),
    ));
    assert_eq!(executing["state"], "executing");
    assert_eq!(
        execute(&service, &plan, "different-execute-key")["error"]["code"],
        "idempotency_conflict"
    );
    let source = std::path::PathBuf::from(std::env::var_os("HETU_INTEGRATIONS_DIR").unwrap())
        .join("codex/hetu");
    let method = source.join("skills/hetu-manage/SKILL.md");
    let original = std::fs::read(&method).unwrap();
    // 随包升级不能阻止旧方案只读核对；缓存损坏仍保留未知，不重新安装。
    std::fs::write(&method, b"new bundle after external install").unwrap();
    let cache_method = root
        .join("plugins/cache/hetu-luoshu-general/hetu")
        .join(plan["fixed"]["suite"]["version"].as_str().unwrap())
        .join("skills/hetu-manage/SKILL.md");
    std::fs::write(&cache_method, b"damaged fixed cache").unwrap();
    assert_eq!(
        execute(&service, &plan, "suite-execute")["status"],
        "unknown"
    );
    std::fs::write(&cache_method, &original).unwrap();
    drop(service);
    let service = LocalSettings::open_default().unwrap();
    let recovered = data(execute(&service, &plan, "suite-execute"));
    assert_eq!(recovered["installation"]["state"], "registered");
    assert_eq!(recovered["installation"]["session_loaded"], false);
    std::fs::write(&method, original).unwrap();
    let log = std::fs::read_to_string(
        std::path::PathBuf::from(std::env::var_os("CODEX_HOME").unwrap()).join("calls.log"),
    )
    .unwrap();
    assert_eq!(
        log.lines().filter(|l| l.starts_with("plugin add ")).count(),
        1
    );
    assert!(!log.contains("plugin marketplace list"));
    let workbuddy = data(call(
        &service,
        "codex",
        "prepare",
        json!({"kind":"agent_suite","agent_client":"workbuddy","suite_id":"military","install":true,"summary":"安装WorkBuddy单套件","operation_key":"workbuddy"}),
    ));
    service
        .host(decide(&service, &workbuddy, "workbuddy-approval"))
        .unwrap();
    let installed = data(execute(&service, &workbuddy, "workbuddy-execute"));
    assert_eq!(installed["installation"]["state"], "files_installed");
    let directory =
        std::path::PathBuf::from(installed["installation"]["directory"].as_str().unwrap());
    assert!(
        std::fs::read_to_string(directory.join("skills/hetu-manage/SKILL.md"))
            .unwrap()
            .contains("\nname: hetu-military-manage\n")
    );
    assert_eq!(
        std::fs::read_dir(directory.parent().unwrap())
            .unwrap()
            .count(),
        1
    );
    let unsupported = call(
        &service,
        "codex",
        "prepare",
        json!({"kind":"agent_suite","agent_client":"claudeCode","suite_id":"general","install":true,"summary":"不支持的自动安装","operation_key":"unsupported"}),
    );
    assert_eq!(unsupported["error"]["code"], "hetu.capability_unavailable");
    let selection = data(call(
        &service,
        "codex",
        "prepare",
        json!({"kind":"agent_suite","agent_client":"claudeCode","suite_id":"general","install":false,"summary":"仅选择套件","operation_key":"selection"}),
    ));
    service
        .host(decide(&service, &selection, "selection-approval"))
        .unwrap();
    data(execute(&service, &selection, "selection-execute"));
    assert_eq!(
        data(call(&service, "codex", "get", json!({})))["association"]["client"],
        "claudeCode"
    );
    let fixed = data(call(
        &service,
        "codex",
        "prepare",
        json!({"kind":"agent_suite","agent_client":"workbuddy","suite_id":"general","install":true,"summary":"核对固定资源","operation_key":"fixed-package"}),
    ));
    service
        .host(decide(&service, &fixed, "approve-fixed"))
        .unwrap();
    let source = std::path::PathBuf::from(std::env::var_os("HETU_INTEGRATIONS_DIR").unwrap())
        .join("codex/hetu");
    let method = source.join("skills/hetu-manage/SKILL.md");
    let original = std::fs::read(&method).unwrap();
    std::fs::write(&method, b"changed after review").unwrap();
    assert_eq!(
        execute(&service, &fixed, "changed-package")["error"]["code"],
        "hetu.integrity_failure"
    );
    std::fs::write(&method, original).unwrap();
    std::os::unix::fs::symlink(&method, source.join("unexpected-link")).unwrap();
    assert_eq!(
        call(
            &service,
            "codex",
            "prepare",
            json!({"kind":"agent_suite","agent_client":"workbuddy","suite_id":"general","install":true,"summary":"拒绝链接资源","operation_key":"symlink-package"})
        )["status"],
        "blocked"
    );
}

#[test]
fn conversation_settings_decision_is_fixed_to_client_and_does_not_execute() {
    let folder = tempfile::tempdir().unwrap();
    let service = LocalSettings::open(folder.path()).unwrap();
    let plan = prepare(
        &service,
        "conversation",
        json!({"font_size":21,"appearance":"dark"}),
    );
    let input = json!({"operation_id":plan["operation_id"],"sha256":plan["sha256"],"revision":plan["revision"],"decision":"approve","authorization_note":"测试用户要求将阅读字号改为21并使用深色。","operation_key":"conversation-decision"});
    assert_eq!(
        call(&service, "claude-code", "record_decision", input.clone())["error"]["code"],
        "forbidden"
    );
    let decision = data(call(&service, "codex", "record_decision", input.clone()));
    assert_eq!(decision["state"], "approved");
    assert_eq!(
        data(call(&service, "codex", "record_decision", input.clone())),
        decision
    );
    assert_eq!(
        data(call(&service, "codex", "get", json!({})))["preferences"]["font_size"],
        18
    );
    let mut changed = input.clone();
    changed["authorization_note"] = json!("不同的用户指令");
    assert_eq!(
        call(&service, "codex", "record_decision", changed)["error"]["code"],
        "idempotency_conflict"
    );
    let result = data(execute(&service, &plan, "conversation-execute"));
    assert_eq!(result["result"]["font_size"], 21);
    assert_eq!(
        result["conversation_decision"]["confirmation_channel"],
        "agent_conversation"
    );
}
