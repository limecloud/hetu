use hetu_core::collaboration::CollaborationHub;
use serde_json::{Value, json};

fn call(hub: &CollaborationHub, name: &str, input: Value) -> Value {
    hub.request(json!({"action":format!("hetu.{name}"),"contract_revision":"1","input":input}))
}
fn ok(value: Value) -> Value {
    assert_eq!(value["status"], "succeeded", "{value}");
    value["data"].clone()
}
fn bound(hub: &CollaborationHub, name: &str, reference: &Value, mut input: Value) -> Value {
    input["management_ref"] = reference.clone();
    call(hub, name, input)
}

#[test]
fn zero_to_novel_and_original_drama_without_author_driver() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("授权");
    let hub = CollaborationHub::open(&directory, "codex").unwrap();
    ok(call(&hub, "collaboration.inspect", json!({})));
    assert!(!directory.exists());
    for (key, drama) in [("novel", false), ("drama", true)] {
        let start = json!({"brief":"旧站雨夜，失物窗口收到明天的车票。","locale":"zh-CN","operation_key":key});
        let created = call(&hub, "creation_projects.create", start.clone());
        let initial = ok(created.clone());
        assert_eq!(
            created,
            call(&hub, "creation_projects.create", start.clone())
        );
        let mut different = start;
        different["brief"] = json!("异参不能沿原键创建");
        assert_eq!(
            call(&hub, "creation_projects.create", different)["error"]["code"],
            "idempotency_conflict"
        );
        let reference = &initial["management_ref"];
        let project = &initial["project"]["project_id"];
        let saved = ok(bound(
            &hub,
            "creation_projects.save",
            reference,
            json!({"project_id":project,"expected":{"revision":initial["revision"],"sha256":initial["sha256"]},"brief":"由 Agent 整理的创作目标。","selected_fields":{"title":{"value":"末班车之后","candidate_ref":null}},"work_profile":if drama {json!({"work_type":"drama","language_tag":"zh-CN","drama_mode":"original"})} else {json!({"work_type":"novel","language_tag":"zh-CN","drama_mode":null})},"operation_key":"save"}),
        ));
        let mut input = json!({"project_id":project,"expected":{"revision":saved["revision"],"sha256":saved["sha256"]},"target_path":initial["target_path"],"operation_key":"create-work"});
        let action = if drama {
            input["profile"] = json!({"title":"末班车之后","description":"失物员与一张未来车票。","mode":"original","language_tag":"zh-CN"});
            "creation_projects.create_drama"
        } else {
            input["metadata"] = json!({"title":"末班车之后","author_name":"演示作者","synopsis":"失物员与一张未来车票。","genre":"悬疑","language_tag":"zh-CN","status":"planning"});
            "creation_projects.create_novel"
        };
        let mut escape = input.clone();
        escape["target_path"] = json!(temp.path().join("已有目录"));
        assert_eq!(
            bound(&hub, action, reference, escape)["error"]["code"],
            "forbidden"
        );
        let result = bound(&hub, action, reference, input.clone());
        let work = ok(result.clone());
        assert_eq!(result, bound(&hub, action, reference, input));
        let work_ref = &work["workspace_management_ref"];
        let admissions = ok(call(
            &hub,
            "collaboration.created_works",
            json!({"limit":100}),
        ));
        assert!(
            admissions["works"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["management_ref"] == *work_ref)
        );
        let recovered = ok(bound(
            &hub,
            "operations.get",
            reference,
            json!({"action":format!("hetu.{action}"),"key":"create-work"}),
        ));
        assert_eq!(
            recovered["original_result"]["data"]["workspace"],
            work["workspace"]
        );
        let workspace = ok(bound(&hub, "workspaces.get", work_ref, json!({})));
        assert_eq!(
            workspace["workspace"]["work_type"],
            if drama { "drama" } else { "novel" }
        );
        let empty = ok(bound(
            &hub,
            "documents.create",
            work_ref,
            json!({"kind":if drama {"drama_script"} else {"novel_chapter"},"title":"首章或首集","source_format":if drama {"fountain"} else {"markdown"},"content":"","operation_key":"empty-document"}),
        ));
        assert_eq!(empty["revision"]["origin_kind"], "agent");
        assert_eq!(empty["revision"]["size_bytes"], 0);
        let read = ok(bound(
            &hub,
            "documents.get",
            work_ref,
            json!({"document_id":empty["document"]["document_id"]}),
        ));
        assert_eq!(read["content"], "");
        if drama {
            assert!(
                !std::path::Path::new(work["target_path"].as_str().unwrap())
                    .join("packages/novel/novel.json")
                    .exists()
            );
        }
        // 从首任务准备派生本客户端的 TaskGrant，没有通用作者身份。
        let preview = ok(bound(
            &hub,
            "creative_tasks.preview_prompt",
            work_ref,
            json!({"scope_ref":work_ref["scope_ref"],"task_kind":if drama {"drama_draft"} else {"chapter_draft"},"brief":"写开场参考稿，不采纳或定稿。","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN"}),
        ));
        let mut prepare = preview["prepare_input"].clone();
        prepare["operation_key"] = json!("first-task");
        let task = ok(bound(&hub, "creative_tasks.prepare", work_ref, prepare));
        let opened = ok(call(
            &hub,
            "collaboration.open",
            json!({"task_locator":task["task_locator"]}),
        ));
        assert_eq!(opened["task_ref"]["sha256"], task["request_sha256"]);
        // 串客户端、串作品及管理升级全部拒绝。
        let other = CollaborationHub::open(&directory, "claude-code").unwrap();
        assert_ne!(
            bound(&other, "workspaces.get", work_ref, json!({}))["status"],
            "succeeded"
        );
        let mut forged = work_ref.clone();
        forged["scope_ref"]["id"] = json!("workspace_00000000-0000-4000-8000-000000000000");
        assert_eq!(
            bound(&hub, "workspaces.get", &forged, json!({}))["error"]["code"],
            "forbidden"
        );
        assert_ne!(
            bound(
                &hub,
                "documents.create",
                work_ref,
                json!({"kind":"novel_chapter","title":"不能直接写正文","source_format":"markdown","content":"越权写入","operation_key":"write"})
            )["status"],
            "succeeded"
        );
        let mut other_client = preview["prepare_input"].clone();
        other_client["operation_key"] = json!("other-client");
        other_client["client_adapter"] = json!("claude-code");
        assert_eq!(
            bound(&hub, "creative_tasks.prepare", work_ref, other_client)["error"]["code"],
            "forbidden"
        );
        // 可信作者只承担撤权决定，不参与此前任何筹备、建书与任务操作。
        let author =
            hetu_core::Kernel::open(json!({"workspace_path":work["target_path"],"mode":"author"}))
                .unwrap();
        let revoke = json!({"action":"hetu.collaboration.revoke_management","contract_revision":"1","input":{"grant_id":work_ref["grant_id"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"revoke-management"}});
        let revoked = author.request(revoke.clone());
        ok(revoked.clone());
        assert_eq!(revoked, author.request(revoke));
        assert_ne!(
            bound(&hub, "workspaces.get", work_ref, json!({}))["status"],
            "succeeded"
        );
        assert_ne!(
            call(
                &hub,
                "creative_tasks.get",
                json!({"task_ref":opened["task_ref"]})
            )["status"],
            "succeeded"
        );
    }
}

#[test]
fn reserved_target_rejects_nonempty_directory_and_symlink_without_creating_work() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("接入");
    let hub = CollaborationHub::open(&directory, "codex").unwrap();
    for link in [false, true] {
        let start = ok(call(
            &hub,
            "creation_projects.create",
            json!({"brief":"新建边界测试","locale":"zh-CN","operation_key":if link {"link"} else {"nonempty"}}),
        ));
        let target = std::path::Path::new(start["target_path"].as_str().unwrap());
        if link {
            let outside = temp.path().join("作者既有文件");
            std::fs::create_dir(&outside).unwrap();
            std::fs::write(outside.join("保留.txt"), "不能覆盖").unwrap();
            #[cfg(unix)]
            std::os::unix::fs::symlink(&outside, target).unwrap();
        } else {
            std::fs::create_dir(target).unwrap();
            std::fs::write(target.join("保留.txt"), "不能覆盖").unwrap();
        }
        let result = bound(
            &hub,
            "creation_projects.create_novel",
            &start["management_ref"],
            json!({"project_id":start["project"]["project_id"],"expected":{"revision":start["revision"],"sha256":start["sha256"]},"target_path":target,"metadata":{"title":"边界","author_name":"","synopsis":"","genre":"","language_tag":"zh-CN","status":"planning"},"operation_key":"create"}),
        );
        assert_ne!(result["status"], "succeeded", "{result}");
        assert!(!target.join(".heturc.json").exists());
        assert_eq!(
            std::fs::read_to_string(target.join("保留.txt")).unwrap(),
            "不能覆盖"
        );
    }
}

#[test]
fn generic_adapter_keeps_scoped_discovery_and_can_prepare_its_own_task() {
    let temp = tempfile::tempdir().unwrap();
    let hub = CollaborationHub::open(&temp.path().join("接入"), "generic").unwrap();
    let start = ok(call(
        &hub,
        "creation_projects.create",
        json!({"brief":"筹备故事","locale":"zh-CN","operation_key":"begin"}),
    ));
    let reference = &start["management_ref"];
    let capabilities = ok(bound(&hub, "capabilities.get", reference, json!({})));
    assert_eq!(capabilities["entry_mode"], "agent");
    let actions = capabilities["actions"].as_array().unwrap();
    assert!(!actions.iter().any(|a| a["name"] == "hetu.drafts.adopt"));
    assert!(actions.iter().all(|a| {
        a["input_schema"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("management_ref"))
    }));
    let preview = ok(bound(
        &hub,
        "creative_tasks.preview_prompt",
        reference,
        json!({"scope_ref":reference["scope_ref"],"task_kind":"book_concept","brief":"构思一个方向。","input_refs":[],"client_adapter":"other","language_tag":"zh-CN"}),
    ));
    let mut input = preview["prepare_input"].clone();
    input["operation_key"] = json!("prepare");
    let task = ok(bound(&hub, "creative_tasks.prepare", reference, input));
    ok(call(
        &hub,
        "collaboration.open",
        json!({"task_locator":task["task_locator"]}),
    ));
}
