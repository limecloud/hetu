use hetu_core::Kernel;
use rmcp::model::ServerJsonRpcMessage;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, process::Stdio, sync::OnceLock, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

#[test]
fn tool_catalog_has_unique_names_across_connection_profiles() {
    let catalog: Value =
        serde_json::from_str(include_str!("../../../contracts/tools/catalog.json")).unwrap();
    let mut names = std::collections::BTreeSet::new();
    for tool in catalog["tools"].as_array().unwrap() {
        assert!(
            names.insert(tool["name"].as_str().unwrap()),
            "duplicate MCP tool: {}",
            tool["name"]
        );
    }
    let preview = catalog["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "hetu_preview_creative_task")
        .unwrap();
    for profile in ["workspace", "stable"] {
        assert!(
            preview["profiles"]
                .as_array()
                .unwrap()
                .contains(&json!(profile))
        );
    }
}

#[test]
fn result_envelope_accepts_registered_action_names_and_rejects_invalid_names() {
    let schema: Value = serde_json::from_str(include_str!(
        "../../../contracts/schemas/result.schema.json"
    ))
    .unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();
    let catalog: Value =
        serde_json::from_str(include_str!("../../../contracts/actions.json")).unwrap();
    let mut result = json!({"spec_version":"0.2.1","kind":"result","contract_revision":"1",
        "status":"succeeded","context":{"scope_id":"collaboration"},"data":{}});
    for action in catalog["actions"].as_array().unwrap() {
        assert_eq!(action["result_provenance"]["instruction_authority"],"none");
        assert_eq!(action["result_provenance"]["authorization_effect"],"none");
        assert!(action["result_provenance"]["data_roles"].as_array().is_some_and(|roles|!roles.is_empty()));
        result["action"] = action["name"].clone();
        validator
            .validate(&result)
            .unwrap_or_else(|error| panic!("{}: {error}", action["name"]));
    }
    for name in [
        "hetu.read",
        "hetu.video..create",
        "other.video.create",
        "hetu.video.Create",
        "hetu.video.projects.create-extra",
    ] {
        result["action"] = json!(name);
        assert!(
            validator.validate(&result).is_err(),
            "invalid action name: {name}"
        );
    }
}

struct Client {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next_id: u64,
    deferred: BTreeMap<u64, Value>,
    apps: bool,
    legacy: bool,
    last_request: String,
}

#[tokio::test]
async fn result_provenance_comes_from_the_same_contract_in_both_adapters() {
    let (root,k)=setup();
    let task=creative_task(&k,json!([]),None);
    let directory=root.path().join("provenance-connection");
    let grant=call(&k,"collaboration.authorize",json!({"task_ref":task["task_ref"],"client_adapter":"codex",
        "collaboration_path":directory,"operation_key":"provenance-grant"}));
    assert_eq!(grant["status"],"succeeded","{grant}");
    let mut stable=Client::start_stable(&directory);
    let opened=stable.tool("hetu_open_collaboration_task",json!({"task_locator":{"scope_ref":task["task_ref"]["scope_ref"],"task_id":task["task_ref"]["task_id"]}})).await;
    let mut legacy=Client::start_task(&root.path().join("河图 离线测试 🌿"),false,task["task_ref"]["task_id"].as_str().unwrap());
    let mut observed=Vec::new();
    for (client,reference) in [(&mut stable,opened["data"]["task_ref"].clone()),(&mut legacy,task["task_ref"].clone())] {
        let response=client.rpc("tools/call",json!({"name":"hetu_get_task_checkpoint","arguments":{"task_ref":reference}})).await;
        let result=&response["result"];
        assert_eq!(result["structuredContent"]["status"],"succeeded","{response}");
        assert_eq!(result["_meta"]["provenance"]["instruction_authority"],"none");
        assert_eq!(result["_meta"]["provenance"]["authorization_effect"],"none");
        assert_eq!(result["_meta"]["provenance"]["action"],result["structuredContent"]["action"]);
        assert!(serde_json::to_vec(result).unwrap().len()<=65536);
        observed.push(result["_meta"]["provenance"].clone());
    }
    assert_eq!(observed[0],observed[1]);
    let response=stable.rpc("tools/call",json!({"name":"hetu_call_action","arguments":{
        "action":"hetu.methods.list","input":{}}})).await;
    assert!(response["result"]["_meta"]["provenance"]["data_roles"].as_array().unwrap().contains(&json!("public_method")));
    stable.close().await;legacy.close().await;
}

#[tokio::test]
async fn compact_catalog_dispatches_discovered_actions_without_tool_list_refresh() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("absent");
    let mut command = Command::new(binary());
    command
        .args(["--client", "codex", "--collaboration-dir"])
        .arg(&directory);
    let mut client = Client::spawn(command);
    let listed = client.rpc("tools/list", json!({})).await;
    let tools = listed["result"]["tools"].as_array().unwrap();
    assert!(tools.iter().filter(|tool| tool["_meta"]["ui"]["visibility"] != json!(["app"])).count() <= 13, "{listed}");
    assert_eq!(tools.iter().find(|tool| tool["name"] == "hetu_app_request").unwrap()["_meta"]["ui"]["visibility"], json!(["app"]));
    assert!(tools.iter().any(|t| t["name"] == "hetu_call_action"));
    let discovered = client
        .tool(
            "hetu_inspect_collaboration",
            json!({"action":"hetu.runtime.inspect","include_schema":true}),
        )
        .await;
    assert_eq!(discovered["data"]["total"], 1);
    let actual = client
        .tool(
            "hetu_call_action",
            json!({"action":"hetu.runtime.inspect","input":{"observed_skill_version":"old"}}),
        )
        .await;
    assert_eq!(actual["action"], "hetu.runtime.inspect");
    assert_eq!(actual["data"]["session_skill_loading"], "unknown");
    let denied = client
        .tool(
            "hetu_call_action",
            json!({"action":"hetu.documents.save","input":{"mode":"author"}}),
        )
        .await;
    assert!(denied.get("error").is_some());
    assert!(!directory.exists());
    client.close().await;
    let mut command = Command::new(binary());
    command
        .args(["--client", "codex", "--all-tools", "--collaboration-dir"])
        .arg(&directory);
    let mut full = Client::spawn(command);
    let listed = full.rpc("tools/list", json!({})).await;
    assert!(listed["result"]["tools"].as_array().unwrap().len() > 100);
    full.close().await;
}

#[tokio::test]
async fn oversized_checkpoint_keeps_persisted_operation_and_can_be_browsed_after_reopen() {
    let (root, k) = setup();
    let task = creative_task(&k, json!([]), None);
    let directory = root.path().join("bounded-connection");
    let grant = call(
        &k,
        "collaboration.authorize",
        json!({"task_ref":task["task_ref"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"bounded-grant"}),
    );
    assert_eq!(grant["status"], "succeeded", "{grant}");
    let mut client = Client::start_stable(&directory);
    let opened=client.tool("hetu_open_collaboration_task",json!({"task_locator":{"scope_ref":task["task_ref"]["scope_ref"],"task_id":task["task_ref"]["task_id"]}})).await;
    let reference = &opened["data"]["task_ref"];
    let mut note = json!({"phase":"传输预算测试","working_copy_refs":[],"feedback_refs":[],"coverage":[],"statements":[],"next_actions":[],"pending_operations":[]});
    for _ in 0..8 {
        note["statements"]
            .as_array_mut()
            .unwrap()
            .push(json!({"kind":"question","text":"a".repeat(1900),"context_refs":[]}));
    }
    let remaining = 16200 - serde_json::to_vec_pretty(&note).unwrap().len();
    note["next_actions"] = json!(["b".repeat(remaining.saturating_sub(4))]);
    assert!(serde_json::to_vec_pretty(&note).unwrap().len() <= 16 * 1024);
    let input = json!({"task_ref":reference,"expected":null,"checkpoint":note,"operation_key":"bounded-checkpoint"});
    let saved = client
        .tool("hetu_save_task_checkpoint", input.clone())
        .await;
    assert_eq!(saved["status"], "succeeded", "{saved}");
    assert_eq!(saved["data"]["response"]["retained"], true, "{saved}");
    assert_eq!(saved, client.tool("hetu_save_task_checkpoint", input).await);
    let recover = saved["data"]["recovery"]["input"].clone();
    client.close().await;
    let mut client = Client::start_stable(&directory);
    let summary = client
        .tool("hetu_read_task_operation", recover.clone())
        .await;
    assert_eq!(summary["data"]["original_status"], "succeeded", "{summary}");
    let mut read = recover;
    read["result_path"] = json!("/data/checkpoint/statements/0/text");
    read["max_bytes"] = json!(256);
    let part = client.tool("hetu_read_task_operation", read).await;
    assert_eq!(part["data"]["page"]["content"], "a".repeat(256));
    assert_eq!(part["data"]["page"]["complete"], false);
    let checkpoint = client
        .tool("hetu_get_task_checkpoint", json!({"task_ref":reference}))
        .await;
    assert_eq!(checkpoint["data"]["checkpoint"], note);
    client.close().await;
}

#[tokio::test]
async fn stable_capability_map_and_fixed_conversation_decision_work_without_desktop() {
    let (root, author) = setup();
    let directory = root.path().join("会话机器入口");
    let work = call(&author, "works.list", json!({}))["data"]["works"][0]["work_ref"].clone();
    let authorized = call(
        &author,
        "collaboration.authorize_workspace",
        json!({"client_adapter":"codex","collaboration_path":directory,"work_ref":work,"operation_key":"conversation-grant"}),
    );
    assert_eq!(authorized["status"], "succeeded", "{authorized}");
    let grant = authorized["data"]["management_ref"].clone();
    let mut client = Client::start_stable(&directory);
    client.rpc("server/discover", json!({})).await;
    let map = client
        .tool(
            "hetu_get_capability_map",
            json!({"action":"hetu.novels.update"}),
        )
        .await;
    assert_eq!(map["status"], "succeeded", "{map}");
    assert_eq!(
        map["data"]["actions"][0]["proposal_target"],
        "hetu.novels.update"
    );
    let current = client
        .tool("hetu_get_novel", json!({"management_ref":grant}))
        .await;
    assert_eq!(current["status"], "succeeded", "{current}");
    let mut metadata = current["data"]["novel"]["metadata"].clone();
    metadata["synopsis"] = json!("作者在当前会话要求的新简介。");
    let prepared=client.tool("hetu_prepare_management_operation",json!({"management_ref":grant,"action":"hetu.novels.update","input":{"expected":{"revision":current["data"]["revision"],"sha256":current["data"]["sha256"]},"metadata":metadata,"operation_key":"metadata"},"summary":"更新简介","operation_key":"prepare-metadata"})).await;
    assert_eq!(prepared["status"], "succeeded", "{prepared}");
    let p = &prepared["data"];
    let decision = json!({"management_ref":grant,"proposal_id":p["proposal_id"],"proposal_sha256":p["proposal_sha256"],"expected_state_revision":p["state_revision"],"decision":"approve","authorization_note":"测试用户在当前会话明确要求保存展示的新简介。","operation_key":"record-metadata"});
    let recorded = client
        .tool("hetu_record_management_decision", decision.clone())
        .await;
    assert_eq!(recorded["status"], "succeeded", "{recorded}");
    assert_eq!(
        recorded,
        client
            .tool("hetu_record_management_decision", decision)
            .await
    );
    let unchanged = client
        .tool("hetu_get_novel", json!({"management_ref":grant}))
        .await;
    assert_eq!(unchanged, current);
    let execute = json!({"management_ref":grant,"proposal_id":p["proposal_id"],"proposal_sha256":p["proposal_sha256"],"operation_key":"execute-metadata"});
    let result = client
        .tool("hetu_execute_management_operation", execute.clone())
        .await;
    assert_eq!(result["status"], "succeeded", "{result}");
    assert_eq!(
        result,
        client
            .tool("hetu_execute_management_operation", execute)
            .await
    );
    let updated = client
        .tool("hetu_get_novel", json!({"management_ref":grant}))
        .await;
    assert_eq!(updated["data"]["novel"]["metadata"], metadata);
    client.close().await;
}

#[tokio::test]
async fn stable_conversation_import_uses_fixed_scope_without_gui_author_approval() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let root = tempfile::tempdir().unwrap();
    let mut client = Client::start_stable(&root.path().join("会话导入"));
    client.rpc("server/discover", json!({})).await;
    let tools = client.rpc("tools/list", json!({})).await;
    assert!(
        tools["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "hetu_register_import_authorization")
    );
    let created = client
        .tool(
            "hetu_begin_creation",
            json!({"brief":"导入指定原稿。","locale":"zh-CN","operation_key":"begin-import"}),
        )
        .await;
    let start = &created["data"];
    let work = client.tool("hetu_create_novel_from_project",json!({"management_ref":start["management_ref"],"project_id":start["project"]["project_id"],"expected":{"revision":start["revision"],"sha256":start["sha256"]},"target_path":start["target_path"],"metadata":{"title":"原稿","author_name":"作者","synopsis":"原稿保留。","genre":"","language_tag":"zh-CN","status":"writing"},"operation_key":"create-import-work"})).await;
    assert_eq!(work["status"], "succeeded", "{work}");
    let grant = work["data"]["workspace_management_ref"].clone();
    let current = client
        .tool("hetu_get_novel", json!({"management_ref":grant}))
        .await;
    assert_eq!(current["status"], "succeeded", "{current}");
    let expected =
        json!({"revision":current["data"]["revision"],"sha256":current["data"]["sha256"]});
    let volume = json!({"volume_id":"volume_11111111-1111-4111-8111-111111111111","title":"原稿"});
    let text = "第1章 渡口\r\n原稿🌿。\r\n";
    let sha = format!("{:x}", Sha256::digest(text.as_bytes()));
    let registration = json!({"management_ref":grant,"work_ref":{"workspace_id":grant["scope_ref"]["id"],"kind":"novel","object_id":work["data"]["novel"]["novel_id"]},"expected":expected,"plan":{"source_name":"原稿.txt","source_sha256":sha,"reading_sha256":sha,"reading_characters":text.chars().count(),"language_tag":"zh-CN","volumes":[volume],"units":[{"index":0,"start":0,"end":text.chars().count(),"title":"第1章 渡口","volume_id":volume["volume_id"],"content_sha256":sha}]},"authorization_note":"作者在当前对话明确要求将这份指定原稿导入。","operation_key":"register-import"});
    let registered = client
        .tool("hetu_register_import_authorization", registration.clone())
        .await;
    assert_eq!(registered["status"], "succeeded", "{registered}");
    assert_eq!(
        registered,
        client
            .tool("hetu_register_import_authorization", registration)
            .await
    );
    let reference = registered["data"]["import_authorization_ref"].clone();
    let proposal = client.tool("hetu_prepare_management_operation",json!({"management_ref":grant,"action":"hetu.novels.save_structure","input":{"expected":expected,"volumes":[volume],"chapters":[],"operation_key":"volumes"},"summary":"按原稿固定分卷","operation_key":"prepare-volumes"})).await;
    let execute = json!({"management_ref":grant,"proposal_id":proposal["data"]["proposal_id"],"proposal_sha256":proposal["data"]["proposal_sha256"],"import_authorization_ref":reference,"operation_key":"execute-volumes"});
    let result = client
        .tool("hetu_execute_management_operation", execute)
        .await;
    assert_eq!(result["status"], "succeeded", "{result}");
    let next = &result["data"]["result"];
    let batch = client.tool("hetu_prepare_management_operation",json!({"management_ref":grant,"action":"hetu.documents.import_batch","input":{"expected":{"revision":next["revision"],"sha256":next["sha256"]},"items":[{"title":"第1章 渡口","language_tag":"zh-CN","volume_id":volume["volume_id"],"source":{"format":"txt","profile":"source/1","inline_source":{"filename":"000001.txt","base64":STANDARD.encode(text),"sha256":sha}}}],"acknowledgement":"保留原稿，不定稿。","operation_key":"import-one"},"summary":"导入固定原稿","operation_key":"prepare-import-one"})).await;
    assert_eq!(batch["status"], "succeeded", "{batch}");
    let execute = json!({"management_ref":grant,"proposal_id":batch["data"]["proposal_id"],"proposal_sha256":batch["data"]["proposal_sha256"],"import_authorization_ref":reference,"operation_key":"execute-import-one"});
    let imported = client
        .tool("hetu_execute_management_operation", execute.clone())
        .await;
    assert_eq!(imported["status"], "succeeded", "{imported}");
    assert_eq!(
        imported,
        client
            .tool("hetu_execute_management_operation", execute)
            .await
    );
    let progress = client
        .tool(
            "hetu_get_import_authorization",
            json!({"management_ref":grant,"import_authorization_ref":reference}),
        )
        .await;
    assert_eq!(progress["data"]["state"], "complete");
    assert_eq!(progress["data"]["next_index"], 1);
    client.close().await;
}

#[tokio::test]
async fn stable_bootstrap_creates_new_work_and_first_task_without_gui_or_author_seed() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("从零接入");
    let mut client = Client::start_stable(&directory);
    client.rpc("server/discover", json!({})).await;
    let input =
        json!({"brief":"雨夜旧站的第一张车票。","locale":"zh-CN","operation_key":"bootstrap"});
    let created = client.tool("hetu_begin_creation", input.clone()).await;
    assert_eq!(created["status"], "succeeded", "{created}");
    assert_eq!(created, client.tool("hetu_begin_creation", input).await);
    let start = &created["data"];
    let work = client.tool("hetu_create_novel_from_project", json!({"management_ref":start["management_ref"],"project_id":start["project"]["project_id"],"expected":{"revision":start["revision"],"sha256":start["sha256"]},"target_path":start["target_path"],"metadata":{"title":"末班车之后","author_name":"测试作者","synopsis":"未来的车票。","genre":"悬疑","language_tag":"zh-CN","status":"planning"},"operation_key":"create-novel"})).await;
    assert_eq!(work["status"], "succeeded", "{work}");
    let reference = &work["data"]["workspace_management_ref"];
    let works = client
        .tool("hetu_list_works", json!({"management_ref":reference}))
        .await;
    assert_eq!(works["status"], "succeeded", "{works}");
    let novel_ref = &works["data"]["works"][0]["work_ref"];
    let novel_canon = client
        .tool(
            "hetu_read_blueprint",
            json!({"management_ref":reference,"work_ref":novel_ref}),
        )
        .await;
    assert_eq!(novel_canon["status"], "succeeded", "{novel_canon}");
    let drama = client.tool("hetu_create_drama_project", json!({"management_ref":reference,"title":"末班车剧本","operation_key":"same-root-drama"})).await;
    assert_eq!(drama["status"], "succeeded", "{drama}");
    let drama_ref = json!({"workspace_id":novel_ref["workspace_id"],"kind":"drama","object_id":drama["data"]["project"]["project_id"]});
    let drama_canon = client
        .tool(
            "hetu_read_blueprint",
            json!({"management_ref":reference,"work_ref":drama_ref}),
        )
        .await;
    assert_eq!(drama_canon["status"], "succeeded", "{drama_canon}");
    assert_ne!(
        novel_canon["data"]["blueprint"]["blueprint_id"],
        drama_canon["data"]["blueprint"]["blueprint_id"]
    );
    let fixed = client
        .tool(
            "hetu_read_blueprint",
            json!({"management_ref":reference,"revision":1,"sha256":drama_canon["data"]["sha256"]}),
        )
        .await;
    assert_eq!(fixed["status"], "succeeded", "{fixed}");
    assert_eq!(fixed["data"]["blueprint"], drama_canon["data"]["blueprint"]);
    let wrong_owner = client.tool("hetu_read_blueprint", json!({"management_ref":reference,"work_ref":novel_ref,"revision":1,"sha256":drama_canon["data"]["sha256"]})).await;
    assert_eq!(wrong_owner["error"]["code"], "hetu.integrity_failure");
    assert_eq!(
        novel_canon,
        client
            .tool(
                "hetu_read_blueprint",
                json!({"management_ref":reference,"work_ref":novel_ref})
            )
            .await
    );
    let preview = client.tool("hetu_preview_creative_task", json!({"management_ref":reference,"scope_ref":reference["scope_ref"],"task_kind":"chapter_draft","brief":"写车站开场。","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN"})).await;
    assert_eq!(preview["status"], "succeeded", "{preview}");
    let mut prepared = preview["data"]["prepare_input"].clone();
    prepared["management_ref"] = reference.clone();
    prepared["operation_key"] = json!("first-task");
    let task = client.tool("hetu_prepare_creative_task", prepared).await;
    assert_eq!(task["status"], "succeeded", "{task}");
    let opened = client
        .tool(
            "hetu_open_collaboration_task",
            json!({"task_locator":task["data"]["task_locator"]}),
        )
        .await;
    assert_eq!(opened["status"], "succeeded", "{opened}");
    assert_eq!(
        opened["data"]["task_ref"]["sha256"],
        task["data"]["request_sha256"]
    );
    let tools = client.rpc("tools/list", json!({})).await;
    assert!(
        !tools["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| matches!(
                t["name"].as_str(),
                Some(
                    "hetu_adopt_draft" | "hetu_finalize_document" | "hetu_authorize_collaboration"
                )
            ))
    );
    client.close().await;
}

#[tokio::test]
async fn stable_original_drama_revises_fountain_and_resumes_without_adoption_or_gui() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("原创剧本接入");
    let mut client = Client::start_stable(&directory);
    client.rpc("server/discover", json!({})).await;
    let tools = client.rpc("tools/list", json!({})).await;
    for name in [
        "hetu_begin_creation",
        "hetu_create_drama_from_project",
        "hetu_read_drama_episode",
        "hetu_save_working_copy",
    ] {
        assert!(
            tools["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["name"] == name),
            "{name}"
        );
    }
    let created = client.tool("hetu_begin_creation", json!({"brief":"雨夜渡口，两个人为最后一班船争执。","locale":"zh-CN","operation_key":"drama-begin"})).await;
    assert_eq!(created["status"], "succeeded", "{created}");
    let start = &created["data"];
    let saved = client.tool("hetu_save_creation_project", json!({"management_ref":start["management_ref"],"project_id":start["project"]["project_id"],"expected":{"revision":start["revision"],"sha256":start["sha256"]},"brief":"先写一集两场的原创剧本参考稿，不采纳。","selected_fields":{"title":{"value":"最后一班船","candidate_ref":null}},"work_profile":{"work_type":"drama","language_tag":"zh-CN","drama_mode":"original"},"operation_key":"drama-profile"})).await;
    assert_eq!(saved["status"], "succeeded", "{saved}");
    let work = client.tool("hetu_create_drama_from_project", json!({"management_ref":start["management_ref"],"project_id":start["project"]["project_id"],"expected":{"revision":saved["data"]["revision"],"sha256":saved["data"]["sha256"]},"target_path":start["target_path"],"profile":{"title":"最后一班船","description":"全剧方向：陌生人以各自的代价换来一次同行。","mode":"original","language_tag":"zh-CN"},"operation_key":"drama-create"})).await;
    assert_eq!(work["status"], "succeeded", "{work}");
    let grant = &work["data"]["workspace_management_ref"];
    let project_id = &work["data"]["created_workspace_ref"]["drama_project_id"];
    let before = client
        .tool(
            "hetu_read_drama_project",
            json!({"management_ref":grant,"project_id":project_id}),
        )
        .await;
    assert_eq!(before["status"], "succeeded", "{before}");
    let episode = client.tool("hetu_create_drama_episode", json!({"management_ref":grant,"project_ref":{"project_id":project_id,"revision":before["data"]["project"]["revision"],"sha256":before["data"]["sha256"]},"title":"第一集 留船","plan":"两场：渡口争船；候船亭交换秘密。收束为两人共同留下，而非独自逃离。","language_tag":"zh-CN","operation_key":"drama-episode"})).await;
    assert_eq!(episode["status"], "succeeded", "{episode}");
    let episode_id = &episode["data"]["episode"]["episode_id"];
    let reading = client
        .tool(
            "hetu_read_drama_episode",
            json!({"management_ref":grant,"episode_id":episode_id}),
        )
        .await;
    assert_eq!(reading["status"], "succeeded", "{reading}");
    let original_author = &reading["data"]["manuscript"]["author_ref"];
    let directory_before = client
        .tool(
            "hetu_read_drama_project",
            json!({"management_ref":grant,"project_id":project_id}),
        )
        .await;
    let preview = client.tool("hetu_preview_creative_task", json!({"management_ref":grant,"scope_ref":grant["scope_ref"],"task_kind":"drama_draft","brief":"按全剧方向与本集计划写两场Fountain参考稿：争船、交换秘密，结尾共同留下。","input_refs":[],"target_ref":original_author,"client_adapter":"codex","language_tag":"zh-CN"})).await;
    assert_eq!(preview["status"], "succeeded", "{preview}");
    let mut input = preview["data"]["prepare_input"].clone();
    input["management_ref"] = grant.clone();
    input["operation_key"] = json!("drama-task");
    let task = client.tool("hetu_prepare_creative_task", input).await;
    assert_eq!(task["status"], "succeeded", "{task}");
    let opened = client
        .tool(
            "hetu_open_collaboration_task",
            json!({"task_locator":task["data"]["task_locator"]}),
        )
        .await;
    assert_eq!(opened["status"], "succeeded", "{opened}");
    let r = &opened["data"]["task_ref"];
    let v1 = ".EXT. 渡口 - 夜\n\n林溪攥住缆绳。\n\n@林溪\n等我一分钟。\n\n.INT. 候船亭 - 夜\n\n陈舟把退票放在桌上。\n\n@陈舟\n这次一起留下。\n";
    let first = client.tool("hetu_create_working_copy", json!({"task_ref":r,"artifact_kind":"text","source_format":"fountain","title":"第一集参考稿","base_refs":[],"content":v1,"operation_key":"drama-v1"})).await;
    assert_eq!(first["status"], "succeeded", "{first}");
    let w1 = &first["data"]["working_copy_ref"];
    let feedback = client.tool("hetu_save_task_feedback", json!({"task_ref":r,"expected_feedback_head":null,"target_refs":[{"kind":"working_copy","working_copy_ref":w1}],"intent":"request_changes","public_comment":"Agent自查：共同留下的决定缺少行动代价，补上退票撕毁，保留两场与结尾。","selected_refs":[],"operation_key":"drama-feedback"})).await;
    assert_eq!(feedback["status"], "succeeded", "{feedback}");
    let f = &feedback["data"]["feedback_ref"];
    let v2 = v1.replace(
        "陈舟把退票放在桌上。",
        "陈舟把退票放在桌上，撕成两半。林溪松开缆绳，走进亭内。",
    );
    let revise_input = json!({"task_ref":r,"working_copy_id":w1["working_copy_id"],"expected":w1,"content":v2,"feedback_refs":[f],"operation_key":"drama-v2"});
    let revised = client
        .tool("hetu_save_working_copy", revise_input.clone())
        .await;
    assert_eq!(revised["status"], "succeeded", "{revised}");
    let mut conflict = revise_input.clone();
    conflict["operation_key"] = json!("drama-stale");
    assert_eq!(
        client.tool("hetu_save_working_copy", conflict).await["error"]["code"],
        "revision_conflict"
    );
    let submit_input = json!({"task_ref":r,"request_sha256":task["data"]["request_sha256"],"working_copy_refs":[revised["data"]["working_copy_ref"]],"feedback_refs":[f],"complete":true,"missing_items":[],"provenance":{"client":"stdio-test","skill_version":"drama-workflow"},"operation_key":"drama-submit"});
    let submitted = client
        .tool("hetu_submit_creative_result", submit_input.clone())
        .await;
    assert_eq!(submitted["status"], "succeeded", "{submitted}");
    client.close().await;

    let mut resumed = Client::start_stable(&directory);
    resumed.rpc("server/discover", json!({})).await;
    let reopened = resumed
        .tool(
            "hetu_open_collaboration_task",
            json!({"task_locator":task["data"]["task_locator"]}),
        )
        .await;
    assert_eq!(reopened["status"], "succeeded", "{reopened}");
    assert_eq!(reopened["data"]["task_ref"], *r);
    let recovered = resumed
        .tool(
            "hetu_read_task_operation",
            json!({"task_ref":r,"action":"hetu.working_copies.save","key":"drama-v2"}),
        )
        .await;
    assert_eq!(recovered["status"], "succeeded", "{recovered}");
    assert_eq!(
        recovered["data"]["original_result"]["data"]["working_copy_ref"],
        revised["data"]["working_copy_ref"]
    );
    assert_eq!(
        recovered["data"]["original_result"]["data"]["revision"],
        revised["data"]["revision"]
    );
    assert_eq!(
        submitted,
        resumed
            .tool("hetu_submit_creative_result", submit_input)
            .await
    );
    let old = resumed
        .tool(
            "hetu_read_working_copy",
            json!({"task_ref":r,"working_copy_ref":w1}),
        )
        .await;
    assert_eq!(old["data"]["revision"]["content"], v1);
    let new = resumed
        .tool(
            "hetu_read_working_copy",
            json!({"task_ref":r,"working_copy_ref":revised["data"]["working_copy_ref"]}),
        )
        .await;
    assert_eq!(new["data"]["revision"]["content"], v2);
    let final_reading = resumed
        .tool(
            "hetu_read_drama_episode",
            json!({"management_ref":grant,"episode_id":episode_id}),
        )
        .await;
    let manuscript = &final_reading["data"]["manuscript"];
    assert_eq!(manuscript["author_state"], "empty");
    assert_eq!(manuscript["author_ref"], *original_author);
    assert_eq!(manuscript["references"].as_array().unwrap().len(), 1);
    assert_eq!(manuscript["references"][0]["kind"], "submitted");
    assert_eq!(
        manuscript["references"][0]["working_copy_ref"],
        revised["data"]["working_copy_ref"]
    );
    assert_eq!(manuscript["references"][0]["source_format"], "fountain");
    let final_project = resumed
        .tool(
            "hetu_read_drama_project",
            json!({"management_ref":grant,"project_id":project_id}),
        )
        .await;
    assert_eq!(
        final_project["data"]["project"],
        directory_before["data"]["project"]
    );
    let works = resumed
        .tool("hetu_list_works", json!({"management_ref":grant}))
        .await;
    assert_eq!(works["status"], "succeeded", "{works}");
    assert_eq!(works["data"]["works"].as_array().unwrap().len(), 1);
    assert_eq!(works["data"]["works"][0]["work_ref"]["kind"], "drama");
    resumed.close().await;
}

#[tokio::test]
async fn stable_video_bootstrap_and_episode_resume_without_upstream_or_gui() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("独立视频接入");
    let mut client = Client::start_stable(&directory);
    client.rpc("server/discover", json!({})).await;
    let tools = client.rpc("tools/list", json!({})).await;
    for name in [
        "hetu_create_video_from_project",
        "hetu_list_works",
        "hetu_create_video_episode",
        "hetu_read_video_episode",
    ] {
        assert!(
            tools["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"] == name)
        );
    }
    let start = client.tool("hetu_begin_creation", json!({"brief":"旧站视频，不创建小说或剧本。","locale":"zh-CN","operation_key":"start-video"})).await;
    assert_eq!(start["status"], "succeeded", "{start}");
    let start = &start["data"];
    let saved = client.tool("hetu_save_creation_project", json!({"management_ref":start["management_ref"],"project_id":start["project"]["project_id"],
        "expected":{"revision":start["revision"],"sha256":start["sha256"]},"brief":"独立视频。","selected_fields":{},
        "work_profile":{"work_type":"video","language_tag":"zh-CN","drama_mode":null},"operation_key":"video-profile"})).await;
    assert_eq!(saved["status"], "succeeded", "{saved}");
    let create = json!({"management_ref":start["management_ref"],"project_id":start["project"]["project_id"],
        "expected":{"revision":saved["data"]["revision"],"sha256":saved["data"]["sha256"]},
        "profile":{"title":"旧站","brief":"先听见车轮声。","language_tag":"zh-CN"},"target_path":start["target_path"],"operation_key":"create-video"});
    let created = client
        .tool("hetu_create_video_from_project", create.clone())
        .await;
    assert_eq!(created["status"], "succeeded", "{created}");
    let data = &created["data"];
    let reference = data["workspace_management_ref"].clone();
    let video = &data["video_project"];
    let list = client
        .tool("hetu_list_works", json!({"management_ref":reference}))
        .await;
    assert_eq!(list["status"], "succeeded", "{list}");
    assert_eq!(list["data"]["works"].as_array().unwrap().len(), 1);
    assert_eq!(list["data"]["works"][0]["work_ref"], video["work_ref"]);
    let episode_input = json!({"management_ref":reference,"project_ref":{"video_project_id":video["project"]["video_project_id"],
        "revision":video["project"]["revision"],"sha256":video["sha256"]},"title":"第一集","brief":"末班车经过旧站。","operation_key":"episode"});
    let episode = client
        .tool("hetu_create_video_episode", episode_input.clone())
        .await;
    assert_eq!(episode["status"], "succeeded", "{episode}");
    let read = client.tool("hetu_read_video_episode", json!({"management_ref":reference,"video_episode_id":episode["data"]["episode"]["video_episode_id"]})).await;
    assert_eq!(read["status"], "succeeded", "{read}");
    assert_eq!(read["data"]["episode"], episode["data"]["episode"]);
    let novel = client
        .tool("hetu_get_novel", json!({"management_ref":reference}))
        .await;
    assert_eq!(novel["status"], "succeeded", "{novel}");
    assert_eq!(novel["data"]["initialized"], false);
    let drama = client
        .tool(
            "hetu_list_drama_projects",
            json!({"management_ref":reference}),
        )
        .await;
    assert_eq!(drama["status"], "succeeded", "{drama}");
    assert_eq!(drama["data"]["projects"], json!([]));
    client.close().await;

    // 新服务进程保持同一范围与原键，不重复建立项目或分集。
    let mut resumed = Client::start_stable(&directory);
    resumed.rpc("server/discover", json!({})).await;
    assert_eq!(
        resumed.tool("hetu_create_video_from_project", create).await,
        created
    );
    assert_eq!(
        resumed
            .tool("hetu_create_video_episode", episode_input)
            .await,
        episode
    );
    resumed.close().await;
}

#[tokio::test]
async fn stable_video_episode_changes_use_exact_scope_fixed_decision_and_original_receipt() {
    let (root, author) = setup();
    let p = call(
        &author,
        "video.projects.create",
        json!({"title":"渡口制作","brief":"两集短剧","language_tag":"zh-CN","operation_key":"video-plan"}),
    );
    assert_eq!(p["status"], "succeeded", "{p}");
    let project_id = &p["data"]["project"]["video_project_id"];
    let project_ref = |value: &Value| json!({"video_project_id":value["project"]["video_project_id"],"revision":value["project"]["revision"],"sha256":value["sha256"]});
    let a = call(
        &author,
        "video.episodes.create",
        json!({"project_ref":project_ref(&p["data"]),"title":"第一集","brief":"争船","operation_key":"first"}),
    );
    assert_eq!(a["status"], "succeeded", "{a}");
    let b = call(
        &author,
        "video.episodes.create",
        json!({"project_ref":project_ref(&a["data"]),"title":"第二集","brief":"离岸","operation_key":"second"}),
    );
    assert_eq!(b["status"], "succeeded", "{b}");
    let foreign = call(
        &author,
        "video.projects.create",
        json!({"title":"另一个视频","brief":"不可借授权管理","language_tag":"zh-CN","operation_key":"foreign"}),
    );
    assert_eq!(foreign["status"], "succeeded", "{foreign}");
    let directory = root.path().join("视频精确范围");
    let grant = call(
        &author,
        "collaboration.authorize_workspace",
        json!({"client_adapter":"codex","collaboration_path":directory,"work_ref":p["data"]["work_ref"],"operation_key":"video-grant"}),
    );
    assert_eq!(grant["status"], "succeeded", "{grant}");
    let grant = &grant["data"]["management_ref"];
    let mut client = Client::start_stable(&directory);
    client.rpc("server/discover", json!({})).await;
    for action in ["hetu.video.episodes.update", "hetu.video.episodes.reorder"] {
        let catalog = client
            .tool(
                "hetu_list_management_actions",
                json!({"management_ref":grant,"action":action}),
            )
            .await;
        assert_eq!(catalog["status"], "succeeded", "{catalog}");
        assert!(
            catalog["data"]["actions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a["name"] == action)
        );
    }
    let read_input =
        json!({"management_ref":grant,"video_episode_id":a["data"]["episode"]["video_episode_id"]});
    let before = client
        .tool("hetu_read_video_episode", read_input.clone())
        .await;
    assert_eq!(before["status"], "succeeded", "{before}");
    let update = json!({"project_ref":before["data"]["project_ref"],"video_episode_id":a["data"]["episode"]["video_episode_id"],"expected":{"revision":before["data"]["episode"]["revision"],"sha256":before["data"]["sha256"]},"title":"等待汽笛","brief":"先听见脚步，再切门口；保留已选片段。","archived":false,"operation_key":"video-update"});
    let prepared = client.tool("hetu_prepare_management_operation", json!({"management_ref":grant,"action":"hetu.video.episodes.update","input":update,"summary":"更新第一集制作说明","operation_key":"prepare-video-update"})).await;
    assert_eq!(prepared["status"], "succeeded", "{prepared}");
    let fixed = &prepared["data"];
    let execute = json!({"management_ref":grant,"proposal_id":fixed["proposal_id"],"proposal_sha256":fixed["proposal_sha256"],"operation_key":"execute-video-update"});
    assert_eq!(
        client
            .tool("hetu_execute_management_operation", execute.clone())
            .await["error"]["code"],
        "hetu.author_confirmation_required"
    );
    let approved = client.tool("hetu_record_management_decision", json!({"management_ref":grant,"proposal_id":fixed["proposal_id"],"proposal_sha256":fixed["proposal_sha256"],"expected_state_revision":fixed["state_revision"],"decision":"approve","authorization_note":"隔离验收中的测试作者明确决定更新第一集制作说明。","operation_key":"decide-video-update"})).await;
    assert_eq!(approved["status"], "succeeded", "{approved}");
    assert_eq!(
        client
            .tool("hetu_read_video_episode", read_input.clone())
            .await,
        before
    );
    let executed = client
        .tool("hetu_execute_management_operation", execute.clone())
        .await;
    assert_eq!(executed["status"], "succeeded", "{executed}");
    let after = client
        .tool("hetu_read_video_episode", read_input.clone())
        .await;
    assert_eq!(after["data"]["episode"]["title"], "等待汽笛");
    assert_eq!(after["data"]["episode"]["revision"], 2);
    let mut wrong = update.clone();
    wrong["project_ref"] = project_ref(&foreign["data"]);
    wrong["operation_key"] = json!("wrong-scope");
    let denied = client.tool("hetu_prepare_management_operation", json!({"management_ref":grant,"action":"hetu.video.episodes.update","input":wrong,"summary":"不能管理其他视频","operation_key":"prepare-foreign"})).await;
    assert_eq!(denied["error"]["code"], "forbidden");
    let reorder = client.tool("hetu_prepare_management_operation", json!({"management_ref":grant,"action":"hetu.video.episodes.reorder","input":{"project_ref":after["data"]["project_ref"],"episode_refs":[b["data"]["episode"]["video_episode_id"],a["data"]["episode"]["video_episode_id"]],"operation_key":"video-reorder"},"summary":"第二集移到前面","operation_key":"prepare-video-reorder"})).await;
    assert_eq!(reorder["status"], "succeeded", "{reorder}");
    let fixed = &reorder["data"];
    let approved = client.tool("hetu_record_management_decision", json!({"management_ref":grant,"proposal_id":fixed["proposal_id"],"proposal_sha256":fixed["proposal_sha256"],"expected_state_revision":fixed["state_revision"],"decision":"approve","authorization_note":"测试作者明确决定重排两集目录。","operation_key":"decide-video-reorder"})).await;
    assert_eq!(approved["status"], "succeeded", "{approved}");
    let reorder_execute = json!({"management_ref":grant,"proposal_id":fixed["proposal_id"],"proposal_sha256":fixed["proposal_sha256"],"operation_key":"execute-video-reorder"});
    let ordered = client
        .tool("hetu_execute_management_operation", reorder_execute.clone())
        .await;
    assert_eq!(ordered["status"], "succeeded", "{ordered}");
    client.close().await;
    let mut resumed = Client::start_stable(&directory);
    resumed.rpc("server/discover", json!({})).await;
    assert_eq!(
        resumed
            .tool("hetu_execute_management_operation", execute)
            .await,
        executed
    );
    assert_eq!(
        resumed
            .tool("hetu_execute_management_operation", reorder_execute)
            .await,
        ordered
    );
    let current = resumed.tool("hetu_read_video_episode", read_input).await;
    assert_eq!(current["data"]["episode"], after["data"]["episode"]);
    assert_eq!(current["data"]["episode_number"], 2);
    let history = resumed.tool("hetu_read_video_episode", json!({"management_ref":grant,"video_episode_id":a["data"]["episode"]["video_episode_id"],"revision":1})).await;
    assert_eq!(history["data"]["episode"], a["data"]["episode"]);
    assert_eq!(history["data"]["is_head"], false);
    let read_project = resumed
        .tool(
            "hetu_read_video_project",
            json!({"management_ref":grant,"video_project_id":project_id}),
        )
        .await;
    assert_eq!(read_project["status"], "succeeded", "{read_project}");
    assert_eq!(
        read_project["data"]["episodes"][0]["episode"]["video_episode_id"],
        b["data"]["episode"]["video_episode_id"]
    );
    resumed.close().await;
}

fn binary() -> std::ffi::OsString {
    std::env::var_os("HETU_MCP_TEST_BINARY")
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_hetu-mcp").into())
}
fn meta() -> Value {
    json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"hetu-stdio-contract-test","version":"1"}})
}

#[tokio::test]
async fn stable_link_details_keep_scope_and_prepare_archive_without_gui() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("关联作品");
    let kernel = Kernel::open(json!({"workspace_path":workspace,"mode":"author","create":{"title":"原著固定名","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let author = |name: &str, input: Value| {
        let result = kernel.request(
            json!({"action":format!("hetu.{name}"),"contract_revision":"1","input":input}),
        );
        assert_eq!(result["status"], "succeeded", "{result}");
        result["data"].clone()
    };
    let source = author("works.list", json!({}))["works"][0]["fixed_ref"].clone();
    let drama = author(
        "drama.projects.create",
        json!({"title":"改编剧本","operation_key":"drama"}),
    );
    let reference = json!({"workspace_id":kernel.scope(),"kind":"drama","object_id":drama["project"]["project_id"]});
    let target = author("works.get", json!({"work_ref":reference}))["summary"]["fixed_ref"].clone();
    let link = author(
        "work_links.create",
        json!({"source_ref":source,"target_ref":target,"relation":"adaptation","operation_key":"link"}),
    );
    let directory = root.path().join("隔离授权");
    let grant = author("collaboration.authorize_workspace",json!({"work_ref":reference,"client_adapter":"codex","collaboration_path":directory,"operation_key":"grant"}))["management_ref"].clone();
    let mut client = Client::start_stable(&directory);
    client.rpc("server/discover", json!({})).await;
    let read = client.tool("hetu_read_work_link",json!({"management_ref":grant,"work_ref":reference,"link_id":link["link"]["link_id"],"revision":1})).await;
    assert_eq!(read["status"], "succeeded", "{read}");
    assert_eq!(read["data"]["related_status"], "requires_authorization");
    assert_eq!(read["data"]["related_title"], "原著固定名");
    assert!(read["data"]["related_work"].is_null());
    let related_grant = author("collaboration.authorize_workspace",json!({"work_ref":source["work_ref"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"related-grant"}))["management_ref"].clone();
    let both = client
        .tool(
            "hetu_read_work_link",
            json!({"management_ref":grant,"related_management_ref":related_grant,
        "work_ref":reference,"link_id":link["link"]["link_id"],"revision":1}),
        )
        .await;
    assert_eq!(both["status"], "succeeded", "{both}");
    assert_eq!(both["data"]["related_work"]["summary"]["fixed_ref"], source);
    let wrong_endpoint = client
        .tool(
            "hetu_read_work_link",
            json!({"management_ref":grant,"related_management_ref":grant,
        "work_ref":reference,"link_id":link["link"]["link_id"]}),
        )
        .await;
    assert_eq!(wrong_endpoint["error"]["code"], "forbidden");
    let proposal = client.tool("hetu_prepare_management_operation",json!({"management_ref":grant,"action":"hetu.work_links.set_archived", "input":{
        "work_ref":reference,"link_ref":{"link_id":link["link"]["link_id"],"revision":1,"sha256":link["sha256"]},"archived":true,"operation_key":"archive"},
        "summary":"解除当前关联并保留历史","operation_key":"prepare"})).await;
    assert_eq!(proposal["status"], "succeeded", "{proposal}");
    assert_eq!(proposal["data"]["preview"]["link"]["archived"], true);
    let denied = client.tool("hetu_execute_management_operation",json!({"management_ref":grant,"proposal_id":proposal["data"]["proposal_id"],"proposal_sha256":proposal["data"]["proposal_sha256"],"operation_key":"unapproved"})).await;
    assert_eq!(denied["error"]["code"], "hetu.author_confirmation_required");
    let forged = client.tool("hetu_read_work_link",json!({"management_ref":grant,"work_ref":source["work_ref"],"link_id":link["link"]["link_id"]})).await;
    assert_eq!(forged["error"]["code"], "forbidden");
    client.close().await;
}

#[tokio::test]
async fn exact_work_reads_documents_and_resumes_existing_task_over_stable_stdio() {
    let root = tempfile::tempdir().unwrap();
    let kernel = Kernel::open(
        json!({"workspace_path":root.path().join("作品"),"mode":"author",
        "create":{"title":"末班车","locale":"zh-CN","operation_key":"init"}}),
    )
    .unwrap();
    let author = |name: &str, input: Value| {
        let result = kernel.request(
            json!({"action":format!("hetu.{name}"),"contract_revision":"1","input":input}),
        );
        assert_eq!(result["status"], "succeeded", "{result}");
        result["data"].clone()
    };
    let reference = author("works.list", json!({}))["works"][0]["work_ref"].clone();
    let first = author(
        "documents.create",
        json!({"kind":"novel_chapter","title":"雨夜","source_format":"markdown",
        "content":"旧车票上写着明天。\r\n","operation_key":"first"}),
    );
    author(
        "documents.create",
        json!({"kind":"novel_chapter","title":"雨夜","source_format":"markdown","content":"第二章同名，不合并。","operation_key":"second"}),
    );
    let directory = root.path().join("授权");
    let grant = author(
        "collaboration.authorize_workspace",
        json!({"work_ref":reference,"client_adapter":"codex",
        "collaboration_path":directory,"operation_key":"grant"}),
    )["management_ref"]
        .clone();
    let preview = author(
        "creative_tasks.preview_prompt",
        json!({"scope_ref":{"kind":"workspace","id":kernel.scope()},"work_ref":reference,
        "task_kind":"chapter_draft","brief":"沿已有任务继续。","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN",
        "target_ref":{"document_id":first["document"]["document_id"],"revision_id":first["revision"]["revision_id"],"sha256":first["revision"]["sha256"]}}),
    );
    let mut arguments = preview["prepare_input"].clone();
    arguments["operation_key"] = json!("original-task");
    let task = author("creative_tasks.prepare", arguments);
    let mut client = Client::start_stable(&directory);
    client.rpc("server/discover", json!({})).await;
    let page = client
        .tool(
            "hetu_list_documents",
            json!({"management_ref":grant,"work_ref":reference,"limit":1}),
        )
        .await;
    assert_eq!(page["status"], "succeeded", "{page}");
    let next = client.tool("hetu_list_documents", json!({"management_ref":grant,"work_ref":reference,"limit":1,"cursor":page["data"]["next_cursor"]})).await;
    assert_eq!(next["status"], "succeeded", "{next}");
    assert_ne!(
        page["data"]["documents"][0]["document_id"],
        next["data"]["documents"][0]["document_id"]
    );
    assert!(next["data"]["next_cursor"].is_null());
    let fixed = client
        .tool(
            "hetu_get_document",
            json!({"management_ref":grant,"document_id":first["document"]["document_id"],
        "revision_id":first["revision"]["revision_id"]}),
        )
        .await;
    assert_eq!(fixed["data"]["content"], "旧车票上写着明天。\r\n");
    let history = client
        .tool(
            "hetu_managed_documents_history",
            json!({"management_ref":grant,"document_id":first["document"]["document_id"]}),
        )
        .await;
    assert_eq!(
        history["data"]["revisions"][0]["revision_id"],
        first["revision"]["revision_id"]
    );
    let tasks = client.tool("hetu_list_creative_tasks", json!({"management_ref":grant,"work_ref":reference,"target_document_id":first["document"]["document_id"]})).await;
    assert_eq!(tasks["status"], "succeeded", "{tasks}");
    assert_eq!(tasks["data"]["tasks"].as_array().unwrap().len(), 1);
    let locator = &tasks["data"]["tasks"][0]["task_locator"];
    let denied = client
        .tool(
            "hetu_open_collaboration_task",
            json!({"task_locator":locator}),
        )
        .await;
    assert_eq!(denied["error"]["code"], "forbidden");
    author(
        "collaboration.authorize",
        json!({"task_ref":task["task_ref"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"task-grant"}),
    );
    let opened = client
        .tool(
            "hetu_open_collaboration_task",
            json!({"task_locator":locator}),
        )
        .await;
    assert_eq!(opened["status"], "succeeded", "{opened}");
    let reference = &opened["data"]["task_ref"];
    let draft = client.tool("hetu_create_working_copy", json!({"task_ref":reference,"artifact_kind":"text","source_format":"markdown",
        "title":"雨夜参考稿","base_refs":[],"content":"阿青把车票翻过来，背面只有一道未干的墨迹。","operation_key":"working"})).await;
    assert_eq!(draft["status"], "succeeded", "{draft}");
    let read = client
        .tool(
            "hetu_read_working_copy",
            json!({"task_ref":reference,"working_copy_ref":draft["data"]["working_copy_ref"]}),
        )
        .await;
    assert_eq!(
        read["data"]["revision"]["content"],
        "阿青把车票翻过来，背面只有一道未干的墨迹。"
    );
    assert_eq!(
        author(
            "documents.get",
            json!({"document_id":first["document"]["document_id"]})
        )["content"],
        "旧车票上写着明天。\r\n"
    );
    client.close().await;
}

impl Client {
    fn start(path: &Path) -> Self {
        Self::start_with_home(path, None)
    }
    fn start_with_home(path: &Path, home: Option<&Path>) -> Self {
        Self::start_config(path, home, "--workspace", None)
    }
    fn start_task(path: &Path, creation: bool, task: &str) -> Self {
        Self::start_config(
            path,
            None,
            if creation {
                "--creation-project"
            } else {
                "--workspace"
            },
            Some(task),
        )
    }
    fn start_stable(directory: &Path) -> Self {
        Self::start_stable_with_home(directory, None)
    }
    fn start_stable_with_home(directory: &Path, home: Option<&Path>) -> Self {
        let mut command = Command::new(binary());
        command.env("HETU_LOCAL_SETTINGS_DIR", directory.join("local-settings"));
        if let Some(home) = home {
            command.env("HOME", home);
        }
        command
            .arg("--client")
            .arg("codex")
            .arg("--collaboration-dir")
            .arg(directory)
            .arg("--all-tools");
        Self::spawn(command)
    }
    fn start_config(path: &Path, home: Option<&Path>, scope: &str, task: Option<&str>) -> Self {
        let mut command = Command::new(binary());
        if let Some(home) = home {
            command.env("HOME", home);
        }
        command.arg(scope).arg(path);
        if let Some(task) = task {
            command.arg("--task").arg(task);
        }
        Self::spawn(command)
    }
    fn spawn(mut command: Command) -> Self {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        Self {
            input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()),
            child,
            next_id: 1,
            deferred: BTreeMap::new(),
            apps: false,
            legacy: false,
            last_request: String::new(),
        }
    }
    async fn send(&mut self, method: &str, mut params: Value, metadata: bool) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.last_request = format!(
            "{id} {method} {}",
            params["name"]
                .as_str()
                .or(params["uri"].as_str())
                .unwrap_or("")
        );
        if metadata {
            let mut metadata = meta();
            if self.apps {
                metadata["io.modelcontextprotocol/clientCapabilities"] = json!({"extensions":{"io.modelcontextprotocol/ui":{"mimeTypes":["text/html;profile=mcp-app"]}}});
            }
            params["_meta"] = metadata;
        }
        let value = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        self.raw(&value.to_string()).await;
        id
    }
    async fn raw(&mut self, value: &str) {
        self.input.write_all(value.as_bytes()).await.unwrap();
        self.input.write_all(b"\n").await.unwrap();
        self.input.flush().await.unwrap();
    }
    async fn receive(&mut self) -> Value {
        let mut line = String::new();
        let bytes = tokio::time::timeout(Duration::from_secs(10), self.output.read_line(&mut line))
            .await
            .unwrap_or_else(|_| panic!("MCP response timeout: {}", self.last_request))
            .unwrap();
        assert!(bytes > 0, "server closed stdout unexpectedly");
        let response: Value =
            serde_json::from_str(&line).expect("stdout must contain only JSON-RPC");
        serde_json::from_value::<ServerJsonRpcMessage>(response.clone())
            .expect("official SDK must deserialize server response");
        // legacy 报文由官方 SDK 反序列化；新版 Schema 不包含 initialize 响应。
        if !self.legacy {
            validate_protocol(&response);
        }
        response
    }
    async fn response(&mut self, id: u64) -> Value {
        if let Some(value) = self.deferred.remove(&id) {
            return value;
        }
        loop {
            let value = self.receive().await;
            let response_id = value["id"].as_u64().expect("response ID");
            if response_id == id {
                return value;
            }
            self.deferred.insert(response_id, value);
        }
    }
    async fn rpc(&mut self, method: &str, params: Value) -> Value {
        let id = self.send(method, params, !self.legacy).await;
        let response = self.response(id).await;
        if !self.legacy && response.get("result").is_some() {
            let name = match method {
                "server/discover" => "DiscoverResult",
                "tools/list" => "ListToolsResult",
                "tools/call" => "CallToolResult",
                "resources/list" => "ListResourcesResult",
                "resources/templates/list" => "ListResourceTemplatesResult",
                "resources/read" => "ReadResourceResult",
                _ => return response,
            };
            validate_schema(name, &response["result"]);
        }
        response
    }
    async fn tool(&mut self, name: &str, args: Value) -> Value {
        let response = self
            .rpc("tools/call", json!({"name":name,"arguments":args}))
            .await;
        assert!(response.get("error").is_none(), "{response}");
        let result = &response["result"];
        let text: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(
            text, result["structuredContent"],
            "text and structured content must agree"
        );
        let schema: Value = serde_json::from_str(include_str!(
            "../../../contracts/schemas/result.schema.json"
        ))
        .unwrap();
        jsonschema::validate(&schema, &text).unwrap();
        assert_eq!(result["isError"], text.get("error").is_some());
        text
    }
    async fn resource(&mut self, uri: &str) -> Value {
        let response = self.rpc("resources/read", json!({"uri":uri})).await;
        assert!(response.get("error").is_none(), "{response}");
        assert_eq!(response["result"]["contents"][0]["uri"], uri);
        serde_json::from_str(response["result"]["contents"][0]["text"].as_str().unwrap()).unwrap()
    }
    async fn close(mut self) {
        self.input.shutdown().await.unwrap();
        drop(self.input);
        let status = tokio::time::timeout(Duration::from_secs(10), self.child.wait())
            .await
            .expect("EOF must end server")
            .unwrap();
        let mut stderr = String::new();
        self.child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .await
            .unwrap();
        assert!(status.success(), "{status}: {stderr}");
        assert!(
            stderr.is_empty(),
            "normal protocol traffic must not log content: {stderr}"
        );
    }
}

#[tokio::test]
async fn stable_local_settings_need_exact_author_decision_and_survive_mcp_restart() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("collaboration");
    let mut client = Client::start_stable(&directory);
    client.rpc("server/discover", json!({})).await;
    let before = client.tool("hetu_local_settings_get", json!({})).await;
    assert_eq!(before["status"], "succeeded", "{before}");
    assert!(before["data"].get("categories").is_none());
    let mut read = before["data"]["response"]["read"]["input"].clone();
    read["view"]["result_path"] = json!("/categories");
    read["view"]["limit"] = json!(2);
    let categories = client.tool("hetu_call_action", read.clone()).await;
    assert_eq!(
        categories["data"]["view"]["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(categories["data"]["view"]["next_offset"], 2);
    let input = json!({"kind":"preferences","patch":{"font_size":23,"appearance":"dark"},"summary":"设置阅读偏好","operation_key":"prepare"});
    let created = client
        .tool("hetu_local_settings_prepare", input.clone())
        .await;
    assert_eq!(created["status"], "succeeded", "{created}");
    let plan = &created["data"];
    assert_eq!(
        client.tool("hetu_local_settings_prepare", input).await,
        created
    );
    let execute = json!({"operation_id":plan["operation_id"],"sha256":plan["sha256"],"operation_key":"execute"});
    assert_eq!(
        client
            .tool("hetu_local_settings_execute", execute.clone())
            .await["error"]["code"],
        "hetu.author_confirmation_required"
    );
    let listed = client.rpc("tools/list", json!({})).await;
    assert!(
        !listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "hetu_local_settings_decide")
    );
    let service =
        hetu_core::local_settings::LocalSettings::open(&directory.join("local-settings")).unwrap();
    service.host(json!({"method":"decide","input":{"operation_id":plan["operation_id"],"sha256":plan["sha256"],"revision":1,"approve":true,"operation_key":"author"}})).unwrap();
    let executed = client
        .tool("hetu_local_settings_execute", execute.clone())
        .await;
    assert_eq!(executed["status"], "succeeded", "{executed}");
    let stale = client.tool("hetu_call_action", read).await;
    assert_eq!(stale["error"]["code"], "hetu.stale_evidence");
    client.close().await;
    let mut client = Client::start_stable(&directory);
    client.rpc("server/discover", json!({})).await;
    assert_eq!(
        client.tool("hetu_local_settings_execute", execute).await,
        executed
    );
    assert_eq!(
        client.tool("hetu_local_settings_get", json!({})).await["data"]["preferences"]["font_size"],
        23
    );
    assert_eq!(
        client
            .tool(
                "hetu_local_settings_get_operation",
                json!({"operation_id":plan["operation_id"]})
            )
            .await["data"]["state"],
        "executed"
    );
    client.close().await;
}

#[tokio::test]
async fn stable_connection_discovers_without_workspace_and_routes_explicit_authorized_tasks() {
    let (root, first) = setup();
    let second=Kernel::open(json!({"workspace_path":root.path().join("另一部作品"),"mode":"author","create":{"title":"另一部作品","locale":"zh-CN","operation_key":"second"}})).unwrap();
    let directory = root.path().join("授权目录");
    let tasks = [
        creative_task(&first, json!([]), None),
        creative_task(&second, json!([]), None),
    ];
    let mut client = Client::start_stable(&directory);
    client.rpc("server/discover", json!({})).await;
    let tools = client.rpc("tools/list", json!({})).await;
    let tools = tools["result"]["tools"].as_array().unwrap();
    assert!(
        tools
            .iter()
            .any(|t| t["name"] == "hetu_open_collaboration_task")
    );
    assert!(!tools.iter().any(|t| t["name"] == "hetu_write_draft"));
    for (name, network) in [
        ("hetu_list_models", true),
        ("hetu_list_model_plans", false),
        ("hetu_prepare_model_task", false),
        ("hetu_get_model_task", true),
        ("hetu_submit_model_task", true),
        ("hetu_collect_model_task", true),
    ] {
        let tool = tools.iter().find(|t| t["name"] == name).unwrap();
        assert_eq!(tool["annotations"]["openWorldHint"], network);
        jsonschema::validator_for(&tool["inputSchema"]).unwrap();
    }
    assert!(
        !tools
            .iter()
            .any(|t| t["name"].as_str().unwrap().contains("approve"))
    );
    client.apps = true;
    let apps = client.rpc("tools/list", json!({})).await;
    let operation = apps["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "hetu_get_management_operation")
        .unwrap();
    assert_eq!(
        operation["_meta"]["ui"]["resourceUri"],
        "ui://hetu/operation-view/1"
    );
    let resource = client
        .rpc(
            "resources/read",
            json!({"uri":"ui://hetu/operation-view/1"}),
        )
        .await;
    assert_eq!(
        resource["result"]["contents"][0]["mimeType"],
        "text/html;profile=mcp-app"
    );
    assert_eq!(
        resource["result"]["contents"][0]["_meta"]["ui"]["csp"]["connectDomains"],
        json!([])
    );
    client.apps = false;
    assert_eq!(
        client.tool("hetu_inspect_collaboration", json!({})).await["status"],
        "succeeded"
    );
    assert!(!directory.exists());
    for (author, task) in [&first, &second].into_iter().zip(tasks.iter()) {
        let locator = json!({"scope_ref":task["task_ref"]["scope_ref"],"task_id":task["task_ref"]["task_id"]});
        assert_eq!(
            client
                .tool(
                    "hetu_open_collaboration_task",
                    json!({"task_locator":locator})
                )
                .await["error"]["code"],
            "forbidden"
        );
        assert_eq!(
            call(
                author,
                "collaboration.authorize",
                json!({"task_ref":task["task_ref"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"grant"})
            )["status"],
            "succeeded"
        );
        let opened = client
            .tool(
                "hetu_open_collaboration_task",
                json!({"task_locator":locator}),
            )
            .await;
        assert_eq!(opened["status"], "succeeded", "{opened}");
        let reference = &opened["data"]["task_ref"];
        assert_eq!(reference["sha256"], task["request_sha256"]);
        let plans = client
            .tool("hetu_list_model_plans", json!({"task_ref":reference}))
            .await;
        assert_eq!(plans["status"], "succeeded", "{plans}");
        assert_eq!(plans["data"]["plans"], json!([]));
        let read = client
            .tool("hetu_read_creative_task", json!({"task_ref":reference}))
            .await;
        assert_eq!(
            read["data"]["request"]["scope_ref"],
            task["request"]["scope_ref"]
        );
        let args = json!({"task_ref":reference,"request_sha256":task["request_sha256"],"candidates":[{"kind":"title","title":"书名候选","source_format":"plain","content":"风过河湾","source_ref_indices":[]}],"complete":true,"missing_items":[],"provenance":{"client":"stdio-test","skill_version":"1"},"operation_key":"same-key"});
        let saved = client
            .tool("hetu_submit_creative_result", args.clone())
            .await;
        assert_eq!(saved["status"], "succeeded", "{saved}");
        assert_eq!(
            saved,
            client.tool("hetu_submit_creative_result", args).await
        );
        client.apps = true;
        let view = client
            .tool("hetu_open_task_view", json!({"task_ref":reference}))
            .await;
        assert_eq!(view["data"]["task_ref"], *reference);
        let selection = json!({"task_ref":reference,"expected":view["data"]["expected"],"candidate_refs":[{"task_ref":reference,"submission_id":saved["data"]["submission"]["submission_id"],"candidate_id":saved["data"]["submission"]["candidates"][0]["candidate_id"]}],"comment":"保留这个方向","operation_key":"choose"});
        let chosen = client.tool("hetu_save_task_selection", selection).await;
        assert_eq!(chosen["status"], "succeeded", "{chosen}");
        let original=client.tool("hetu_read_task_operation",json!({"task_ref":reference,"action":"hetu.interactions.save_selection","key":"choose"})).await;
        assert_eq!(
            original["data"]["original_result"]["operation"],
            chosen["operation"]
        );
        assert_eq!(
            client.rpc("resources/list", json!({})).await["result"]["resources"][0]["uri"],
            "ui://hetu/task-view/1"
        );
        assert_eq!(
            call(
                author,
                "collaboration.revoke",
                json!({"task_ref":task["task_ref"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"revoke"})
            )["status"],
            "succeeded"
        );
        assert_eq!(
            client
                .tool("hetu_read_creative_task", json!({"task_ref":reference}))
                .await["error"]["code"],
            "forbidden"
        );
    }
    client.close().await;
}

#[tokio::test]
async fn apps_resources_negotiate_per_request_and_keep_authority_bound_to_the_task() {
    let (root, k) = setup();
    let path = root.path().join("河图 离线测试 🌿");
    let task = creative_task(&k, json!([]), None);
    let mut client =
        Client::start_task(&path, false, task["task_ref"]["task_id"].as_str().unwrap());
    let listed = client.rpc("tools/list", json!({})).await;
    assert!(listed["result"]["tools"][2].get("_meta").is_none());
    client.apps = true;
    let listed = client.rpc("tools/list", json!({})).await;
    let resource_uri = listed["result"]["tools"][2]["_meta"]["ui"]["resourceUri"]
        .as_str()
        .unwrap();
    assert_eq!(resource_uri, "ui://hetu/task-view/1");
    let resource = client
        .rpc("resources/read", json!({"uri":resource_uri}))
        .await;
    assert!(resource.get("error").is_none(), "{resource}");
    let content = &resource["result"]["contents"][0];
    assert_eq!(content["mimeType"], "text/html;profile=mcp-app");
    assert_eq!(content["_meta"]["ui"]["csp"]["connectDomains"], json!([]));
    assert!(
        content["text"]
            .as_str()
            .unwrap()
            .starts_with("<!doctype html>")
    );
    assert!(
        !content["text"]
            .as_str()
            .unwrap()
            .contains(task["task_ref"]["task_id"].as_str().unwrap())
    );
    let manifest: Value =
        serde_json::from_str(include_str!("../resources/task-view.manifest.json")).unwrap();
    assert_eq!(
        manifest["sha256"],
        format!(
            "{:x}",
            Sha256::digest(content["text"].as_str().unwrap().as_bytes())
        )
    );
    let resources = client.rpc("resources/list", json!({})).await;
    assert_eq!(
        resources["result"]["resources"].as_array().unwrap().len(),
        4
    );
    client.apps = false;
    assert!(
        client
            .rpc("resources/read", json!({"uri":resource_uri}))
            .await
            .get("error")
            .is_some()
    );
    let view = client
        .tool("hetu_open_task_view", json!({"task_ref":task["task_ref"]}))
        .await;
    assert_eq!(view["data"]["effect"], "preference_only");
    let result = client.tool("hetu_save_task_selection", json!({"task_ref":task["task_ref"],"expected":view["data"]["expected"],"candidate_refs":[],"comment":"保留悬念，不自动采纳。","operation_key":"app-feedback"})).await;
    assert_eq!(result["status"], "succeeded", "{result}");
    assert_eq!(result["data"]["effect"], "preference_only");
    assert_eq!(
        call(&k, "documents.list", json!({}))["data"]["documents"],
        json!([])
    );
    let current = call(
        &k,
        "creative_tasks.get",
        json!({"task_ref":task["task_ref"]}),
    );
    let closed = call(
        &k,
        "creative_tasks.close",
        json!({"task_ref":task["task_ref"],"expected":current["data"]["expected"],"reason":"测试撤权","operation_key":"close-app"}),
    );
    assert_eq!(closed["status"], "succeeded", "{closed}");
    client.apps = true;
    assert!(
        client
            .rpc("resources/read", json!({"uri":resource_uri}))
            .await
            .get("error")
            .is_some()
    );
    client.close().await;
    let mut ordinary = Client::start(&path);
    ordinary.apps = true;
    let listed = ordinary.rpc("tools/list", json!({})).await;
    assert!(
        listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|tool| tool.get("_meta").is_none())
    );
    assert!(
        ordinary
            .rpc("resources/read", json!({"uri":resource_uri}))
            .await
            .get("error")
            .is_some()
    );
    ordinary.close().await;
}

fn creative_task(k: &Kernel, refs: Value, edit: Option<Value>) -> Value {
    let mut input = json!({"scope_ref":{"kind":k.scope_kind(),"id":k.scope()},"task_kind":if edit.is_some() {"revision"} else {"book_concept"},"brief":"只改允许的段落，保留我的表达。","input_refs":refs,"client_adapter":"codex","language_tag":"zh-CN"});
    if let Some(edit) = edit {
        input["edit_scope"] = edit;
    }
    let preview = call(k, "creative_tasks.preview_prompt", input);
    assert_eq!(preview["status"], "succeeded", "{preview}");
    let mut prepared = preview["data"]["prepare_input"].clone();
    prepared["operation_key"] = json!(format!(
        "prepare-{}",
        preview["data"]["task_ref"]["task_id"].as_str().unwrap()
    ));
    let result = call(k, "creative_tasks.prepare", prepared);
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}

#[tokio::test]
async fn task_connection_exposes_only_fixed_task_and_rejects_overwrite_and_revoked_access() {
    let (_root, k) = setup();
    let created = document(&k, "task-source");
    let doc = call(
        &k,
        "documents.get",
        json!({"document_id":created["document"]["document_id"]}),
    )["data"]
        .clone();
    let original = doc["content"].as_str().unwrap();
    let doc_id = &doc["document"]["document_id"];
    let rev = &doc["revision"]["revision_id"];
    let point = original.len();
    let task = creative_task(
        &k,
        json!([{"kind":"document","document_id":doc_id,"revision_id":rev}]),
        Some(
            json!({"document_id":doc_id,"revision_id":rev,"ranges":[{"byte_start":point,"byte_end":point,"quote":""}]}),
        ),
    );
    let another = creative_task(&k, json!([]), None);
    let path = _root.path().join("河图 离线测试 🌿");
    let mut client =
        Client::start_task(&path, false, task["task_ref"]["task_id"].as_str().unwrap());
    client.rpc("server/discover", json!({})).await;
    let tools = client.rpc("tools/list", json!({})).await;
    let names: Vec<_> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        vec![
            "hetu_read_creative_task",
            "hetu_submit_creative_result",
            "hetu_open_task_view",
            "hetu_save_task_selection",
            "hetu_create_working_copy",
            "hetu_read_working_copy",
            "hetu_list_working_copies",
            "hetu_save_working_copy",
            "hetu_save_task_feedback",
            "hetu_list_task_feedback",
            "hetu_list_task_context",
            "hetu_read_task_context",
            "hetu_search_task_context",
            "hetu_list_models",
            "hetu_list_model_plans",
            "hetu_prepare_model_task",
            "hetu_get_model_task",
            "hetu_authorize_model_usage",
            "hetu_submit_model_task",
            "hetu_collect_model_task",
            "hetu_get_task_checkpoint",
            "hetu_save_task_checkpoint",
            "hetu_read_task_candidate"
        ]
    );
    assert!(
        client
            .rpc(
                "tools/call",
                json!({"name":"hetu_write_draft","arguments":draft_args("bypass")})
            )
            .await
            .get("error")
            .is_some()
    );
    let loaded = client
        .tool(
            "hetu_read_creative_task",
            json!({"task_ref":task["task_ref"]}),
        )
        .await;
    assert_eq!(loaded["data"]["request"], task["request"]);
    let context = client
        .tool(
            "hetu_list_task_context",
            json!({"task_ref":task["task_ref"]}),
        )
        .await;
    assert_eq!(context["status"], "succeeded", "{context}");
    let read = client.tool("hetu_read_task_context", json!({"task_ref":task["task_ref"],"context_ref":context["data"]["entries"][0]["context_ref"]})).await;
    assert_eq!(read["data"]["content"], original);
    assert_eq!(read["data"]["source_ref"]["revision_id"], *rev);
    assert_eq!(
        client
            .tool(
                "hetu_read_creative_task",
                json!({"task_ref":another["task_ref"]})
            )
            .await["error"]["code"],
        "forbidden"
    );
    let input = json!({"task_ref":task["task_ref"],"request_sha256":task["request_sha256"],"candidates":[{"kind":"text","title":"续写参考","source_format":"markdown","source_ref_indices":[0],"patches":[{"byte_start":point,"byte_end":point,"quote":"","replacement":"只有这一句。"}]}],"complete":true,"missing_items":[],"provenance":{"client":"stdio-test","skill_version":"1"},"operation_key":"submit"});
    let result = client
        .tool("hetu_submit_creative_result", input.clone())
        .await;
    assert_eq!(result["status"], "succeeded", "{result}");
    assert_eq!(
        client.tool("hetu_submit_creative_result", input).await,
        result
    );
    let directory = client.rpc("resources/list", json!({})).await;
    assert_eq!(
        directory["result"]["resources"].as_array().unwrap().len(),
        3
    );
    let task_root = format!(
        "hetu://task/workspace/{}/{}/",
        k.scope(),
        task["task_ref"]["task_id"].as_str().unwrap()
    );
    let restored = client
        .resource(&format!(
            "{task_root}operations/by-key?action=hetu.creative_tasks.submit_result&key=submit"
        ))
        .await;
    assert_eq!(restored["data"]["original_result"], result);
    assert!(
        client
            .rpc("resources/read", json!({"uri":uri(&k,"documents")}))
            .await
            .get("error")
            .is_some()
    );
    assert_eq!(
        call(&k, "documents.get", json!({"document_id":doc_id}))["data"]["content"],
        original
    );
    let current = call(
        &k,
        "creative_tasks.get",
        json!({"task_ref":task["task_ref"]}),
    );
    assert_eq!(
        call(
            &k,
            "creative_tasks.close",
            json!({"task_ref":task["task_ref"],"expected":current["data"]["expected"],"reason":"结束本次改稿","operation_key":"close"})
        )["status"],
        "succeeded"
    );
    assert_eq!(
        client.resource(&format!("{task_root}request")).await["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        client
            .resource(&format!(
                "{task_root}operations/by-key?action=hetu.creative_tasks.submit_result&key=submit"
            ))
            .await["error"]["code"],
        "forbidden"
    );
    client.close().await;
}

#[tokio::test]
async fn nameless_creation_task_has_no_workspace_resources_or_author_tools() {
    let root = tempfile::tempdir().unwrap();
    let k=Kernel::open(json!({"creation_project_path":root.path(),"mode":"author","create_project":{"brief":"还没有书名","locale":"zh-CN","operation_key":"project"}})).unwrap();
    let task = creative_task(&k, json!([]), None);
    let mut client = Client::start_task(
        root.path(),
        true,
        task["task_ref"]["task_id"].as_str().unwrap(),
    );
    client.rpc("server/discover", json!({})).await;
    let loaded = client
        .tool(
            "hetu_read_creative_task",
            json!({"task_ref":task["task_ref"]}),
        )
        .await;
    assert_eq!(
        loaded["data"]["request"]["scope_ref"]["kind"],
        "creation_project"
    );
    let tools = client.rpc("tools/list", json!({})).await;
    let tools = tools["result"]["tools"].as_array().unwrap();
    assert!(tools.iter().any(|t| t["name"] == "hetu_save_working_copy"));
    assert!(tools.iter().any(|t| t["name"] == "hetu_list_task_feedback"));
    assert!(!tools.iter().any(|t| t["name"] == "hetu_write_draft"));
    assert!(!root.path().join(".heturc.json").exists());
    assert!(!root.path().join("packages").exists());
    client.close().await;
}
fn validate_protocol(response: &Value) {
    let name = if response.get("error").is_some() {
        "JSONRPCErrorResponse"
    } else {
        "JSONRPCResponse"
    };
    validate_schema(name, response);
}
fn validate_schema(name: &str, response: &Value) {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    static VALIDATORS: OnceLock<BTreeMap<&'static str, jsonschema::Validator>> = OnceLock::new();
    let schema = SCHEMA.get_or_init(|| {
        let text = include_str!("../../../tests/mcp/schema-2026-07-28.json");
        let sources: Value =
            serde_json::from_str(include_str!("../../../docs/research/sources.json")).unwrap();
        let source = sources["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == "mcp-schema-2026-07-28")
            .unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(text.as_bytes())),
            source["sha256"]
        );
        serde_json::from_str(text).unwrap()
    });
    let validators = VALIDATORS.get_or_init(|| {
        [
            "JSONRPCErrorResponse",
            "JSONRPCResponse",
            "DiscoverResult",
            "ListToolsResult",
            "CallToolResult",
            "ListResourcesResult",
            "ListResourceTemplatesResult",
            "ReadResourceResult",
        ]
        .into_iter()
        .map(|name| {
            let mut root = schema.clone();
            root["$ref"] = json!(format!("#/$defs/{name}"));
            (name, jsonschema::validator_for(&root).unwrap())
        })
        .collect()
    });
    if let Some(error) = validators[name].iter_errors(response).next() {
        panic!("official MCP schema: {error}; {response}");
    }
}
fn setup() -> (tempfile::TempDir, Kernel) {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("河图 离线测试 🌿");
    let kernel = Kernel::open(json!({"workspace_path":path,"mode":"author","create":{"title":"雾港来信","locale":"zh-CN","operation_key":"init"}})).unwrap();
    (root, kernel)
}
fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":if action == "reviews.decide" {"2"} else {"1"},"input":input}))
}
fn document(k: &Kernel, key: &str) -> Value {
    let result = call(
        k,
        "documents.create",
        json!({"kind":"novel_chapter","title":"第一章 灯塔","source_format":"markdown","content":"# 雨夜\n\n林舟推开门。🌿\n\n“灯还亮着。”\n","operation_key":key}),
    );
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn draft_args(key: &str) -> Value {
    json!({"package":"novel","source_format":"markdown","title":"待审雾港","content":"林舟走向灯塔。🌿\n","blueprint_revision":1,"operation_key":key})
}
fn uri(k: &Kernel, path: &str) -> String {
    format!("hetu://workspace/{}/{path}", k.scope())
}

#[tokio::test]
async fn mcp_workbench_entry_is_discoverable_before_ui_negotiation_and_keeps_app_only_tools_scoped() {
    let folder = tempfile::tempdir().unwrap();
    let directory = folder.path().join("no-authorizations");
    let mut command = Command::new(binary());
    command.args(["--client", "codex", "--collaboration-dir"]).arg(&directory);
    let mut client = Client::spawn(command);
    let ordinary = client.rpc("tools/list", json!({})).await;
    assert!(ordinary["result"]["tools"].as_array().unwrap().iter().any(|t| t["name"] == "hetu_open_app"));
    let ordinary_tools = ordinary["result"]["tools"].as_array().unwrap();
    assert!(ordinary_tools.iter().filter(|tool| tool["_meta"]["ui"]["visibility"] != json!(["app"])).count() <= 13);
    assert_eq!(ordinary_tools.iter().find(|tool| tool["name"] == "hetu_app_request").unwrap()["_meta"]["ui"]["visibility"], json!(["app"]));
    let empty = client.tool("hetu_open_app", json!({})).await;
    assert_eq!(empty["data"]["app"]["route"], "library");
    assert_eq!(empty["data"]["works"], json!([]));
    let resources = client.rpc("resources/list", json!({})).await;
    assert_eq!(resources["result"]["resources"].as_array().unwrap().len(), 1);
    assert_eq!(resources["result"]["resources"][0]["uri"], "ui://hetu/workbench/2");
    let static_ui = client.rpc("resources/read", json!({"uri":"ui://hetu/workbench/2"})).await;
    assert_eq!(static_ui["result"]["contents"][0]["mimeType"], "text/html;profile=mcp-app");
    client.apps = true;
    let listed = client.rpc("tools/list", json!({})).await;
    let tools = listed["result"]["tools"].as_array().unwrap();
    let app = tools.iter().find(|t| t["name"] == "hetu_open_app").unwrap();
    assert_eq!(app["_meta"]["openai/ui"]["entrypoints"], json!([{"type":"global"},{"type":"thread"}]));
    assert_eq!(app["_meta"]["ui"]["resourceUri"], "ui://hetu/workbench/2");
    let feedback = tools.iter().find(|t| t["name"] == "hetu_save_task_feedback").unwrap();
    assert_eq!(feedback["_meta"]["ui"]["visibility"], json!(["app"]));
    let operation = tools.iter().find(|t| t["name"] == "hetu_get_management_operation").unwrap();
    assert_eq!(operation["_meta"]["ui"]["resourceUri"], "ui://hetu/operation-view/1");
    assert_eq!(operation["_meta"]["ui"]["visibility"], json!(["app"]));
    let home = client.tool("hetu_open_app", json!({})).await;
    assert_eq!(home["data"]["app"]["route"], "library");
    assert_eq!(home["data"]["works"], json!([]));
    assert!(!directory.exists(), "empty entry must not create or enumerate authorizations");
    let resource = client.rpc("resources/read", json!({"uri":"ui://hetu/workbench/2"})).await;
    assert_eq!(resource["result"]["contents"][0]["mimeType"], "text/html;profile=mcp-app");
    assert!(resource["result"]["contents"][0]["text"].as_str().unwrap().contains("media-src blob:"));
    client.close().await;
}

#[tokio::test]
async fn legacy_workbench_discovery_does_not_require_ui_and_normalizes_capability_fields() {
    let ui = json!({"mimeTypes":["text/html;profile=mcp-app"]});
    for (capabilities, enhanced) in [
        (json!({}), false),
        (json!({"experimental":{"io.modelcontextprotocol/ui":ui}}), true),
        (json!({"extensions":{"io.modelcontextprotocol/ui":ui}}), true),
        (json!({"extensions":{"io.modelcontextprotocol/ui":{}},"experimental":{"io.modelcontextprotocol/ui":ui}}), false),
    ] {
        let folder = tempfile::tempdir().unwrap();
        let directory = folder.path().join("no-grants");
        let mut command = Command::new(binary());
        command.args(["--client", "codex", "--collaboration-dir"]).arg(&directory);
        let mut client = Client::spawn(command);
        client.legacy = true;
        let initialized = client.rpc("initialize", json!({"protocolVersion":"2025-06-18", "capabilities":capabilities,
            "clientInfo":{"name":"codex-global-catalog-regression","version":"1"}})).await;
        assert_eq!(initialized["result"]["protocolVersion"], "2025-06-18");
        client.raw(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).await;
        let listed = client.rpc("tools/list", json!({})).await;
        let tools = listed["result"]["tools"].as_array().unwrap();
        let entry = tools.iter().find(|tool| tool["name"] == "hetu_open_app").unwrap();
        assert_eq!(entry["_meta"]["openai/ui"]["entrypoints"], json!([{"type":"global"},{"type":"thread"}]));
        assert_eq!(tools.len() > 100, enhanced, "{capabilities}");
        let home=client.tool("hetu_open_app", json!({})).await;
        assert_eq!(home["data"]["app"]["route"], "library");
        assert_eq!(home["data"]["works"], json!([]));
        let resource = client.rpc("resources/read", json!({"uri":"ui://hetu/workbench/2"})).await;
        assert_eq!(resource["result"]["contents"][0]["mimeType"], "text/html;profile=mcp-app");
        assert!(!directory.exists(), "目录探测不得创建作品或授权");
        client.close().await;
    }
}

#[tokio::test]
async fn global_app_reads_the_desktop_catalog_without_turning_catalog_visibility_into_content_access() {
    let (folder,author)=setup();
    let directory=folder.path().join("Collaboration");
    let listed=call(&author,"works.list",json!({}));
    let work=listed["data"]["works"][0]["work_ref"].clone();
    let record=json!({"schema_version":1,"roots":[{"path":folder.path().join("河图 离线测试 🌿"),"workspace_id":author.scope(),
        "works":[{"work_ref":work,"title":"雾港来信","content":"私密正文不能进入目录"}]}]});
    std::fs::write(folder.path().join("creative-library.json"),serde_json::to_vec(&record).unwrap()).unwrap();
    let mut client=Client::start_stable(&directory);client.apps=true;
    let catalog=client.tool("hetu_open_app",json!({})).await;
    assert_eq!(catalog["status"],"succeeded","{catalog}");
    assert_eq!(catalog["data"]["app"]["route"],"library");
    assert_eq!(catalog["data"]["works"][0]["title"],"雾港来信");
    assert_eq!(catalog["data"]["works"][0]["authorized"],false);
    assert!(!catalog.to_string().contains("私密正文不能进入目录"));
    assert!(!catalog.to_string().contains(folder.path().to_str().unwrap()));
    assert!(!directory.exists());
    let grant=call(&author,"collaboration.authorize_workspace",json!({"client_adapter":"codex","collaboration_path":directory,"work_ref":work,"operation_key":"library-grant"}));
    assert_eq!(grant["status"],"succeeded","{grant}");
    let refreshed=client.tool("hetu_open_app",json!({})).await;
    assert_eq!(refreshed["data"]["works"][0]["authorized"],true,"{refreshed}");
    assert_eq!(refreshed["data"]["works"][0]["management_ref"],grant["data"]["management_ref"]);
    client.close().await;
}

#[tokio::test]
async fn mcp_workbench_uses_exact_management_and_task_grants_and_rechecks_revocation() {
    let (folder, author) = setup();
    let directory = folder.path().join("workbench-access");
    let grant = call(&author, "collaboration.authorize_workspace", json!({"client_adapter":"codex","collaboration_path":directory,"operation_key":"app-work"}));
    assert_eq!(grant["status"], "succeeded", "{grant}");
    let task = creative_task(&author, json!([]), None);
    let task_grant = call(&author, "collaboration.authorize", json!({"task_ref":task["task_ref"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"app-task"}));
    assert_eq!(task_grant["status"], "succeeded", "{task_grant}");
    let mut client = Client::start_stable(&directory); client.apps = true;
    let work = client.tool("hetu_open_app", json!({"management_ref":grant["data"]["management_ref"]})).await;
    assert_eq!(work["status"], "succeeded", "{work}");
    assert_eq!(work["data"]["app"]["route"], "works");
    assert!(work["data"]["works"].is_array());
    let locator = json!({"scope_ref":task["task_ref"]["scope_ref"],"task_id":task["task_ref"]["task_id"]});
    let view = client.tool("hetu_open_app", json!({"task_locator":locator})).await;
    assert_eq!(view["status"], "succeeded", "{view}");
    assert_eq!(view["data"]["app"]["route"], "task");
    assert!(view["data"]["task_ref"]["sha256"].is_string());
    let denied = call(&author,"collaboration.revoke",json!({"task_ref":task["task_ref"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"revoke-app-task"}));
    assert_eq!(denied["status"], "succeeded", "{denied}");
    let revoked = client.tool("hetu_open_app", json!({"task_locator":locator})).await;
    assert_eq!(revoked["status"], "blocked", "{revoked}");
    client.close().await;
}

#[tokio::test]
async fn workspace_management_proposal_requires_exact_author_decision_over_real_stdio() {
    let (root, author) = setup();
    let mut client = Client::start(&root.path().join("河图 离线测试 🌿"));
    client.rpc("server/discover", json!({})).await;
    let handoff = client
        .tool("hetu_get_page_handoff", json!({"view_kind":"novel"}))
        .await;
    assert_eq!(handoff["status"], "succeeded", "{handoff}");
    let prepared=client.tool("hetu_prepare_management_operation",json!({"action":"hetu.documents.create","input":{"kind":"novel_chapter","title":"第二章 渡口","source_format":"markdown","content":"","operation_key":"new-chapter"},"summary":"建立第二章空稿","operation_key":"prepare"})).await;
    assert_eq!(prepared["status"], "succeeded", "{prepared}");
    let p = &prepared["data"];
    let args = json!({"proposal_id":p["proposal_id"],"proposal_sha256":p["proposal_sha256"],"operation_key":"execute"});
    assert_eq!(
        client
            .tool("hetu_execute_management_operation", args.clone())
            .await["error"]["code"],
        "hetu.author_confirmation_required"
    );
    assert_eq!(
        call(
            &author,
            "agent_operations.decide",
            json!({"proposal_id":p["proposal_id"],"proposal_sha256":p["proposal_sha256"],"expected_state_revision":1,"decision":"approve","operation_key":"author-decision"})
        )["status"],
        "succeeded"
    );
    let result = client
        .tool("hetu_execute_management_operation", args.clone())
        .await;
    assert_eq!(result["data"]["state"], "executed", "{result}");
    assert_eq!(
        result["data"]["result"]["document"]["document_id"],
        p["preview"]["document"]["document_id"]
    );
    assert_eq!(
        client.tool("hetu_execute_management_operation", args).await["data"]["result"],
        result["data"]["result"]
    );
    assert_eq!(
        call(&author, "documents.list", json!({}))["data"]["documents"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    client.close().await;
}

#[tokio::test]
async fn model_confirmation_uses_real_host_response_and_never_submits_generation() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join(if cfg!(target_os = "macos") {
        "Library/Application Support/Hetu/Collaboration"
    } else {
        ".local/share/hetu/collaboration"
    });
    let service = hetu_core::model_service::ModelService::open(
        &directory.parent().unwrap().join("ModelService"),
    )
    .unwrap();
    let channel = service.author_request("custom_save", &json!({"name":"本机测试","base_url":"https://provider.test","api_key":"fixture-key","models":{"text":[],"image":["image-one"]}})).unwrap();
    service
        .author_request(
            "channel_select",
            &json!({"kind":"image","channel_id":channel["channel_id"]}),
        )
        .unwrap();
    let mut client = Client::start_stable_with_home(&directory, Some(root.path()));
    client.legacy = true;
    client.rpc("initialize", json!({"protocolVersion":"2025-06-18","capabilities":{"elicitation":{}},"clientInfo":{"name":"host-confirmation-test","version":"1"}})).await;
    client
        .raw(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}).to_string())
        .await;
    let tools = client.rpc("tools/list", json!({})).await;
    let tool = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "hetu_request_model_confirmation")
        .unwrap();
    assert_eq!(tool["annotations"]["readOnlyHint"], false);
    let created = client
        .tool(
            "hetu_begin_creation",
            json!({"brief":"宿主图片确认测试。","locale":"zh-CN","operation_key":"begin"}),
        )
        .await;
    let start = &created["data"];
    let work = client.tool("hetu_create_novel_from_project", json!({"management_ref":start["management_ref"],"project_id":start["project"]["project_id"],"expected":{"revision":start["revision"],"sha256":start["sha256"]},"target_path":start["target_path"],"metadata":{"title":"宿主确认","author_name":"测试作者","synopsis":"仅测试。","genre":"测试","language_tag":"zh-CN","status":"planning"},"operation_key":"create"})).await;
    let management = &work["data"]["workspace_management_ref"];
    let preview = client.tool("hetu_preview_creative_task", json!({"management_ref":management,"scope_ref":management["scope_ref"],"task_kind":"artwork","brief":"渡口灯笼。","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN"})).await;
    let mut input = preview["data"]["prepare_input"].clone();
    input["management_ref"] = management.clone();
    input["operation_key"] = json!("task");
    let prepared = client.tool("hetu_prepare_creative_task", input).await;
    let opened = client
        .tool(
            "hetu_open_collaboration_task",
            json!({"task_locator":prepared["data"]["task_locator"]}),
        )
        .await;
    let task_ref = opened["data"]["task_ref"].clone();
    let plan = client.tool("hetu_prepare_model_task", json!({"task_ref":task_ref,"kind":"image","artifact_kind":"image","model_id":"image-one","prompt":"完整固定输入：雨夜渡口灯笼。","title":"测试图","billing_mode":"provider","operation_key":"model"})).await;
    assert_eq!(plan["status"], "succeeded", "{plan}");
    let args = json!({"task_ref":task_ref,"plan_id":plan["data"]["plan"]["plan_id"]});
    let mut forged = args.clone();
    forged["approved"] = json!(true);
    assert_eq!(
        client.tool("hetu_request_model_confirmation", forged).await["error"]["code"],
        "invalid_input"
    );
    for answer in [
        json!({"action":"decline"}),
        json!({"action":"cancel"}),
        json!({"action":"accept","content":{"confirm":false}}),
        json!({"action":"accept","content":{"confirm":true}}),
    ] {
        let id = client
            .send(
                "tools/call",
                json!({"name":"hetu_request_model_confirmation","arguments":args}),
                false,
            )
            .await;
        let question = client.receive().await;
        assert_eq!(question["method"], "elicitation/create", "{question}");
        let message = question["params"]["message"].as_str().unwrap();
        assert!(
            message.contains("完整固定输入：雨夜渡口灯笼。")
                && message.contains("https://provider.test")
                && message.contains("次数：1")
                && message.contains(plan["data"]["plan_sha256"].as_str().unwrap())
        );
        assert!(!message.contains("fixture-key"));
        client
            .raw(&json!({"jsonrpc":"2.0","id":question["id"],"result":answer}).to_string())
            .await;
        let result = client.response(id).await;
        assert!(result.get("error").is_none(), "{result}");
        let record = &result["result"]["structuredContent"]["data"];
        assert_eq!(
            !record["approval"].is_null(),
            answer["content"]["confirm"] == true,
            "{result}"
        );
        assert_eq!(record["submitted"], false);
    }
    let replay = client
        .tool("hetu_request_model_confirmation", args.clone())
        .await;
    assert_eq!(
        replay["data"]["approval"]["confirmation_channel"],
        "mcp_elicitation"
    );
    assert_eq!(replay["data"]["approval"]["host"], "codex");
    assert_eq!(
        replay,
        client.tool("hetu_request_model_confirmation", args).await
    );
    let registered = client.tool("hetu_authorize_model_usage", json!({"task_ref":task_ref,"plan_id":plan["data"]["plan"]["plan_id"],"authorization":{"operation_key":"budget-v1","channels":"current","max_requests":2},"authorization_note":"作者在当前测试对话授权两次请求。","operation_key":"register-budget"})).await;
    assert_eq!(registered["status"], "succeeded", "{registered}");
    assert_eq!(
        registered["data"]["authorization"]["confirmation_channel"],
        "agent_conversation"
    );
    assert_eq!(registered["data"]["authorization"]["requests_reserved"], 0);

    client.close().await;
}
#[tokio::test]
async fn codex_legacy_initialize_lists_and_calls_both_connection_profiles() {
    let (root, _) = setup();
    let workspace = root.path().join("河图 离线测试 🌿");
    let directory = root.path().join("legacy-collaboration");
    for stable in [false, true] {
        let mut client = if stable {
            Client::start_stable(&directory)
        } else {
            Client::start(&workspace)
        };
        client.legacy = true;
        // 与 Codex 的真实 stdio 客户端一致，不附加新版请求元数据。
        let id = client
            .send(
                "initialize",
                json!({
                    "protocolVersion":"2025-06-18",
                    "capabilities":{},
                    "clientInfo":{"name":"codex-legacy-contract-test","version":"1"}
                }),
                false,
            )
            .await;
        let initialized = client.response(id).await;
        assert_eq!(
            initialized["result"]["protocolVersion"], "2025-06-18",
            "{initialized}"
        );
        client
            .raw(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}).to_string())
            .await;
        let id = client.send("tools/list", json!({}), false).await;
        let listed = client.response(id).await;
        assert!(listed["result"].get("resultType").is_none(), "{listed}");
        let tool = if stable {
            "hetu_inspect_collaboration"
        } else {
            "hetu_read_blueprint"
        };
        assert!(
            listed["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["name"] == tool)
        );
        let id = client
            .send("tools/call", json!({"name":tool,"arguments":{}}), false)
            .await;
        let called = client.response(id).await;
        assert!(called.get("error").is_none(), "{called}");
        assert_eq!(called["result"]["isError"], false, "{called}");
        assert_eq!(
            called["result"]["structuredContent"]["status"], "succeeded",
            "{called}"
        );
        assert!(called["result"].get("resultType").is_none(), "{called}");
        if stable {
            // 工作台会内嵌任务审核；纯静态页面不能因Codex未协商UI扩展而被拒绝。
            for uri in [
                "ui://hetu/workbench/2",
                "ui://hetu/task-view/1",
                "ui://hetu/operation-view/1",
            ] {
                let id = client
                    .send("resources/read", json!({"uri":uri}), false)
                    .await;
                let resource = client.response(id).await;
                assert!(resource.get("error").is_none(), "{resource}");
                let content = &resource["result"]["contents"][0];
                assert_eq!(content["mimeType"], "text/html;profile=mcp-app");
                assert!(
                    content["text"]
                        .as_str()
                        .unwrap()
                        .starts_with("<!doctype html>")
                );
            }
            let id = client
                .send(
                    "resources/read",
                    json!({"uri":"hetu://task/workspace/unknown"}),
                    false,
                )
                .await;
            assert!(client.response(id).await.get("error").is_some());
        }
        client.close().await;
    }
}

#[tokio::test]
async fn discovery_and_metadata_are_checked_on_every_request() {
    let (root, k) = setup();
    let mut client = Client::start(&root.path().join("河图 离线测试 🌿"));
    let discovery = client.rpc("server/discover", json!({})).await;
    assert_eq!(
        discovery["result"]["supportedVersions"],
        json!(["2026-07-28", "2025-06-18"])
    );
    assert_eq!(discovery["result"]["resultType"], "complete");
    assert_eq!(
        discovery["result"]["capabilities"],
        json!({"tools":{},"resources":{}})
    );
    let id = client.send("tools/list", json!({}), false).await;
    assert_eq!(client.response(id).await["error"]["code"], -32602);
    let tools = client.rpc("tools/list", json!({})).await;
    let tools = tools["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 27);
    assert!(
        tools
            .iter()
            .any(|tool| tool["name"] == "hetu_prepare_management_operation")
    );
    assert!(
        tools
            .iter()
            .any(|tool| tool["name"] == "hetu_get_page_handoff")
    );
    assert!(
        !tools
            .iter()
            .any(|tool| tool["name"] == "hetu_approve_management_operation")
    );
    assert!(
        tools
            .iter()
            .any(|tool| tool["name"] == "hetu_preview_image_task")
    );
    assert!(
        tools
            .iter()
            .any(|tool| tool["name"] == "hetu_prepare_image_task")
    );
    assert!(tools.iter().any(|t| t["name"] == "hetu_read_resource"));
    assert!(tools.iter().any(|t| t["name"] == "hetu_read_drama_project"));
    assert!(!tools.iter().any(|t| t["name"] == "hetu_create_resource"));
    assert!(
        tools
            .iter()
            .all(|t| !t["name"].as_str().unwrap().contains("approve"))
    );
    for tool in tools {
        jsonschema::validator_for(&tool["inputSchema"]).unwrap();
        jsonschema::validator_for(&tool["outputSchema"]).unwrap();
        assert_eq!(
            tool["annotations"]["openWorldHint"],
            matches!(
                tool["name"].as_str(),
                Some("hetu_prepare_management_operation" | "hetu_execute_management_operation")
            )
        );
    }
    let bad=client.send("tools/list",json!({"_meta":{"io.modelcontextprotocol/protocolVersion":"2025-11-25","io.modelcontextprotocol/clientCapabilities":{}}}),false).await;
    assert_eq!(client.response(bad).await["error"]["code"], -32022);
    let missing = client.send("tools/list", json!({}), false).await;
    assert_eq!(client.response(missing).await["error"]["code"], -32602);
    assert_eq!(
        client.rpc("unknown/method", json!({})).await["error"]["code"],
        -32601
    );
    let caps = client.resource(&uri(&k, "capabilities")).await;
    assert_eq!(caps["data"]["entry_mode"], "agent");
    assert!(
        caps["data"]["actions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|a| a["author_only"] == false)
    );
    client.close().await;
}

#[tokio::test]
async fn fixed_source_pipeline_and_public_review_feedback_work_through_stdio() {
    let (root, k) = setup();
    let source = document(&k, "chapter");
    let mut client = Client::start(&root.path().join("河图 离线测试 🌿"));
    let bible = client.tool("hetu_read_blueprint", json!({})).await;
    assert_eq!(bible["data"]["revision"], 1);
    let sources = json!([{"document_id":source["document"]["document_id"],"revision_id":source["revision"]["revision_id"],"sha256":source["revision"]["sha256"]}]);
    let plot=client.tool("hetu_extract_plot",json!({"document_revisions":sources,"blueprint_revision":1,"options":{},"save_result":true,"operation_key":"extract"})).await;
    assert_eq!(plot["status"], "succeeded", "{plot}");
    assert!(
        plot["data"]["plot"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|n| n["verification"] == "needs_author_review")
    );
    let limited=client.tool("hetu_extract_plot",json!({"document_revisions":sources,"blueprint_revision":1,"options":{"max_nodes":1},"save_result":false})).await;
    assert_eq!(
        limited["status"], "partial",
        "limited coverage must remain partial: {limited}"
    );
    let plot_id = &plot["data"]["plot"]["plot_revision_id"];
    let skeleton=client.tool("hetu_build_drama_skeleton",json!({"plot_revision_id":plot_id,"blueprint_revision":1,"episode_options":{},"operation_key":"skeleton"})).await;
    assert!(skeleton.get("error").is_none(), "{skeleton}");
    let report=client.tool("hetu_validate_blueprint",json!({"plot_revision_id":plot_id,"rule_set_version":"1","options":{},"save_report":true,"operation_key":"report"})).await;
    assert!(report.get("error").is_none(), "{report}");
    let submitted = client.tool("hetu_write_draft", draft_args("draft")).await;
    assert_eq!(submitted["data"]["diagnostic_state"], "not_requested");
    let draft = &submitted["data"]["draft"];
    let checked=client.tool("hetu_validate_draft",json!({"draft_id":draft["draft_id"],"expected_draft_revision":draft["revision"],"plot_options":{},"validation_options":{},"operation_key":"check-draft"})).await;
    assert!(checked.get("error").is_none(), "{checked}");
    let began = call(
        &k,
        "reviews.begin",
        json!({"draft_id":draft["draft_id"],"expected_draft_revision":draft["revision"],"operation_key":"begin"}),
    );
    assert_eq!(began["status"], "succeeded", "{began}");
    let view = call(&k, "reviews.get", json!({"draft_id":draft["draft_id"]}));
    let decided = call(
        &k,
        "reviews.decide",
        json!({"draft_id":draft["draft_id"],"expected_draft_revision":view["data"]["draft"]["revision"],"input_snapshot":view["data"]["input_snapshot"],"report_refs":[],"decision":"changes_requested","comments":"请保留林舟的身份。","private_comments":"下一章结局仅作者可见。","operation_key":"return"}),
    );
    assert_eq!(decided["status"], "succeeded", "{decided}");
    let review = client
        .resource(&uri(
            &k,
            &format!("reviews/{}", draft["draft_id"].as_str().unwrap()),
        ))
        .await;
    assert_eq!(
        review["data"]["decisions"][0]["comments"],
        "请保留林舟的身份。"
    );
    assert!(
        review["data"]["decisions"][0]
            .get("private_comments")
            .is_none()
    );
    assert!(!review.to_string().contains("下一章结局"));
    let source_uri = uri(
        &k,
        &format!(
            "documents/{}/revisions/{}",
            source["document"]["document_id"].as_str().unwrap(),
            source["revision"]["revision_id"].as_str().unwrap()
        ),
    );
    assert_eq!(
        client.resource(&source_uri).await["data"]["content"],
        "# 雨夜\n\n林舟推开门。🌿\n\n“灯还亮着。”\n"
    );
    client.close().await;
}

#[tokio::test]
async fn restart_replays_original_write_and_recovers_unicode_operation_key() {
    let (root, k) = setup();
    let path = root.path().join("河图 离线测试 🌿");
    let key = "雾港 key + & ? 🌿";
    let mut first = Client::start(&path);
    let result = first.tool("hetu_write_draft", draft_args(key)).await;
    assert_eq!(result["status"], "succeeded", "{result}");
    first.close().await;
    let mut second = Client::start(&path);
    assert_eq!(
        second.tool("hetu_write_draft", draft_args(key)).await,
        result
    );
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("action", "hetu.drafts.submit")
        .append_pair("key", key)
        .finish();
    let recovered = second
        .resource(&uri(&k, &format!("operations/by-key?{query}")))
        .await;
    assert_eq!(recovered["data"]["original_result"], result);
    let by_id = second
        .resource(&uri(
            &k,
            &format!("operations/{}", result["operation"]["id"].as_str().unwrap()),
        ))
        .await;
    assert_eq!(by_id["data"]["original_result"], result);
    let mut changed = draft_args(key);
    changed["content"] = json!("同键不同参数");
    assert_eq!(
        second.tool("hetu_write_draft", changed).await["error"]["code"],
        "idempotency_conflict"
    );
    let queue = second.resource(&uri(&k, "reviews")).await;
    assert_eq!(queue["data"]["reviews"].as_array().unwrap().len(), 1);
    second.close().await;
}

#[tokio::test]
async fn paths_queries_and_author_identity_cannot_escape_agent_scope() {
    let (root, k) = setup();
    let mut client = Client::start(&root.path().join("河图 离线测试 🌿"));
    for name in [
        "hetu_unlock_blueprint",
        "hetu_approve_draft",
        "hetu.documents.save",
        "execute",
    ] {
        assert_eq!(
            client
                .rpc("tools/call", json!({"name":name,"arguments":{}}))
                .await["error"]["code"],
            -32601
        );
    }
    let mut args = draft_args("impersonation");
    args["mode"] = json!("author");
    assert_eq!(
        client.tool("hetu_write_draft", args).await["error"]["code"],
        "invalid_input"
    );
    assert_eq!(
        client
            .tool("hetu_read_blueprint", json!({"revision":-1}))
            .await["error"]["code"],
        "invalid_input"
    );
    for path in [
        "../.heturc.json",
        "documents/%2e%2e/secret",
        "documents/a%2fb",
        "documents?limit=1&limit=2",
        "blueprint?path=/etc/passwd",
        "reviews?author=true",
        "documents?limit=9999",
        "capabilities#secret",
    ] {
        assert_eq!(
            client
                .rpc("resources/read", json!({"uri":uri(&k,path)}))
                .await["error"]["code"],
            -32602,
            "{path}"
        );
    }
    for path in [
        "file:///etc/passwd",
        "hetu://workspace/workspace_00000000-0000-4000-8000-000000000000/blueprint",
    ] {
        assert_eq!(
            client.rpc("resources/read", json!({"uri":path})).await["error"]["code"],
            -32602
        );
    }
    assert_eq!(
        client.resource(&uri(&k, "reviews")).await["data"]["reviews"],
        json!([])
    );
    client.close().await;
}

#[tokio::test]
async fn document_pagination_is_snapshot_bound_and_resources_are_discoverable() {
    let (root, k) = setup();
    document(&k, "one");
    document(&k, "two");
    document(&k, "three");
    let mut client = Client::start(&root.path().join("河图 离线测试 🌿"));
    let directory = client.rpc("resources/list", json!({})).await;
    assert_eq!(
        directory["result"]["resources"].as_array().unwrap().len(),
        11
    );
    let templates = client.rpc("resources/templates/list", json!({})).await;
    assert!(
        templates["result"]["resourceTemplates"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["uriTemplate"]
                .as_str()
                .unwrap()
                .contains("operations/by-key"))
    );
    let first = client.resource(&uri(&k, "documents?limit=1")).await;
    assert_eq!(first["data"]["documents"].as_array().unwrap().len(), 1);
    assert_eq!(first["data"]["mcp_resources"].as_array().unwrap().len(), 1);
    let next = first["data"]["mcp_next_page_uri"].as_str().unwrap();
    let second = client.resource(next).await;
    assert_ne!(
        first["data"]["documents"][0]["document_id"],
        second["data"]["documents"][0]["document_id"]
    );
    let fixed = first["data"]["mcp_resources"][0]["uri"].as_str().unwrap();
    assert!(client.resource(fixed).await["data"]["content"].is_string());
    document(&k, "four");
    assert_eq!(
        client.rpc("resources/read", json!({"uri":next})).await["error"]["code"],
        -32602
    );
    client.close().await;
}

#[tokio::test]
async fn malformed_and_oversized_lines_are_rejected_without_breaking_the_stream() {
    let (root, _) = setup();
    let mut client = Client::start(&root.path().join("河图 离线测试 🌿"));
    client.raw("{invalid-json").await;
    client
        .raw(&" ".repeat(hetu_mcp::MAX_MESSAGE_BYTES + 1))
        .await;
    assert!(client.rpc("tools/list", json!({})).await["result"]["tools"].is_array());
    client.close().await;
    Client::start(&root.path().join("河图 离线测试 🌿"))
        .close()
        .await;
}

#[tokio::test]
async fn explicit_workspace_is_required_and_identity_flags_are_rejected() {
    for args in [
        vec![],
        vec!["--workspace", "relative"],
        vec!["--workspace", "/missing/hetu"],
        vec!["--workspace", "/tmp", "--mode", "author"],
    ] {
        let output = Command::new(binary()).args(args).output().await.unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(!output.stderr.is_empty());
    }
}

#[tokio::test]
async fn cancellation_and_eof_recover_with_the_original_key_without_duplicate_drafts() {
    let (root, k) = setup();
    let path = root.path().join("河图 离线测试 🌿");
    let mut args = draft_args("cancel-and-recover");
    args["content"] = json!("林舟走向灯塔。🌿\n".repeat(30000));
    let mut first = Client::start(&path);
    let id = first
        .send(
            "tools/call",
            json!({"name":"hetu_write_draft","arguments":args}),
            true,
        )
        .await;
    first.raw(&json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":id,"reason":"author cancelled waiting"}}).to_string()).await;
    assert!(first.rpc("tools/list", json!({})).await["result"]["tools"].is_array());
    first.close().await;
    let mut second = Client::start(&path);
    let result = second.tool("hetu_write_draft", args.clone()).await;
    assert_eq!(result["status"], "succeeded", "{result}");
    assert_eq!(second.tool("hetu_write_draft", args).await, result);
    let queue = second.resource(&uri(&k, "reviews")).await;
    assert_eq!(queue["data"]["reviews"].as_array().unwrap().len(), 1);
    let operation = second
        .resource(&uri(
            &k,
            &format!("operations/{}", result["operation"]["id"].as_str().unwrap()),
        ))
        .await;
    assert_eq!(operation["data"]["original_result"], result);
    second.close().await;
}

#[tokio::test]
async fn official_sdk_client_discovers_calls_and_reads_the_native_process() {
    use rmcp::{
        ClientHandler, ClientLifecycleMode, ClientServiceExt,
        model::{CallToolRequestParams, ProtocolVersion, ReadResourceRequestParams},
    };
    struct SdkClient;
    impl ClientHandler for SdkClient {}
    let (root, k) = setup();
    let mut child = Command::new(binary())
        .arg("--workspace")
        .arg(root.path().join("河图 离线测试 🌿"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let transport = (child.stdout.take().unwrap(), child.stdin.take().unwrap());
    let client = tokio::time::timeout(
        Duration::from_secs(10),
        SdkClient.serve_with_lifecycle(
            transport,
            ClientLifecycleMode::Discover {
                preferred_versions: vec![ProtocolVersion::V_2026_07_28],
            },
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(client.list_tools(None).await.unwrap().tools.len(), 27);
    let result = client
        .call_tool(CallToolRequestParams::new("hetu_read_blueprint"))
        .await
        .unwrap();
    assert_eq!(
        result.structured_content.as_ref().unwrap()["data"]["revision"],
        1
    );
    assert_eq!(result.is_error, Some(false));
    let resource = client
        .read_resource(ReadResourceRequestParams::new(uri(&k, "workspace")))
        .await
        .unwrap();
    assert_eq!(resource.contents.len(), 1);
    client.cancel().await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
}

#[tokio::test]
async fn git_snapshot_requires_author_approval_and_recovers_across_server_restart() {
    let (root, _) = setup();
    let path = root.path().join("河图 离线测试 🌿");
    let author = Kernel::open(json!({"workspace_path":path,"mode":"author","authorization_path":root.path().join("Library/Application Support/Hetu/Authorizations")})).unwrap();
    assert_eq!(
        call(
            &author,
            "git.init",
            json!({"branch":"main","operation_key":"git-init"})
        )["status"],
        "succeeded"
    );
    let mut client = Client::start_with_home(&path, Some(root.path()));
    let status = client.resource(&uri(&author, "git/status")).await;
    let input = json!({"phase":"prepare","expected_head":status["data"]["head"],"message":"MCP 保存雾港 🌿","author":{"name":"河图作者","email":"author@hetu.test"},"operation_key":"mcp-git-prepare"});
    let prepared = client.tool("hetu_commit_snapshot", input.clone()).await;
    assert_eq!(prepared["status"], "pending");
    let snapshot = &prepared["data"]["snapshot"];
    let id = snapshot["snapshot_id"].as_str().unwrap();
    let fixed = client
        .resource(&uri(&author, &format!("git/snapshots/{id}")))
        .await;
    assert_eq!(fixed["data"]["snapshot"], *snapshot);
    let list = client
        .resource(&uri(&author, "git/snapshots?limit=1"))
        .await;
    assert_eq!(list["data"]["snapshots"][0]["snapshot_id"], id);
    assert_eq!(
        list["data"]["mcp_resources"][0]["uri"],
        uri(&author, &format!("git/snapshots/{id}"))
    );
    let execute = json!({"phase":"execute","snapshot_id":id,"operation_key":"mcp-git-execute"});
    assert_eq!(
        client.tool("hetu_commit_snapshot", execute.clone()).await["error"]["code"],
        "hetu.author_confirmation_required"
    );
    assert_eq!(
        client
            .rpc(
                "tools/call",
                json!({"name":"hetu.git.approve_snapshot","arguments":{}})
            )
            .await["error"]["code"],
        -32601
    );
    let approved = call(
        &author,
        "git.approve_snapshot",
        json!({"snapshot_id":id,"snapshot_sha256":prepared["data"]["snapshot_sha256"],"operation_key":"author-approve"}),
    );
    assert_eq!(approved["status"], "succeeded", "{approved}");
    let result = client.tool("hetu_commit_snapshot", execute.clone()).await;
    assert_eq!(result["status"], "succeeded", "{result}");
    client.close().await;
    let mut restarted = Client::start_with_home(&path, Some(root.path()));
    assert_eq!(
        restarted.tool("hetu_commit_snapshot", execute).await,
        result
    );
    assert_eq!(
        restarted.tool("hetu_commit_snapshot", input).await,
        prepared
    );
    let history = restarted.resource(&uri(&author, "git/log?limit=1")).await;
    assert_eq!(
        history["data"]["commits"][0]["commit_id"],
        result["data"]["commit_id"]
    );
    assert_eq!(
        restarted.resource(&uri(&author, "git/status")).await["data"]["changes"],
        json!([])
    );
    restarted.close().await;
}

#[tokio::test]
async fn reference_task_discovers_narrow_tools_and_replays_writes_without_touching_author_text() {
    let (root, k) = setup();
    let manuscript = document(&k, "reference-test");
    let manuscript_before = call(
        &k,
        "documents.get",
        json!({"document_id":manuscript["document"]["document_id"]}),
    );
    assert_eq!(
        manuscript_before["status"], "succeeded",
        "{manuscript_before}"
    );
    let preview = call(
        &k,
        "creative_tasks.preview_prompt",
        json!({"scope_ref":{"kind":"workspace","id":k.scope()},"task_kind":"resource_organize","brief":"整理渡口考据","input_refs":[],"resource_scope":{"resource_refs":[],"editable_resource_ids":[],"allow_create":true},"client_adapter":"codex","language_tag":"zh-CN"}),
    );
    assert_eq!(preview["status"], "succeeded", "{preview}");
    let mut input = preview["data"]["prepare_input"].clone();
    input["operation_key"] = json!("reference-task");
    let task = call(&k, "creative_tasks.prepare", input);
    assert_eq!(task["status"], "succeeded", "{task}");
    let task = &task["data"];
    let mut client = Client::start_task(
        &root.path().join("河图 离线测试 🌿"),
        false,
        task["task_ref"]["task_id"].as_str().unwrap(),
    );
    client.rpc("server/discover", json!({})).await;
    let list = client.rpc("tools/list", json!({})).await;
    let names: Vec<_> = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"hetu_create_resource") && names.contains(&"hetu_update_resource"));
    assert!(
        !names.contains(&"hetu_submit_creative_result") && !names.contains(&"hetu_write_draft")
    );
    let fields = json!({"title":"渡口考据","category":"research","body":"风向与船只停泊🌿","tags":[],"project_id":null,"entity_refs":[],"source_notes":"测试资料","operation_key":"reference"});
    let created = client.tool("hetu_create_resource", fields.clone()).await;
    assert_eq!(created["status"], "succeeded", "{created}");
    assert_eq!(
        created,
        client.tool("hetu_create_resource", fields.clone()).await
    );
    let record = &created["data"]["resource"];
    let read = client
        .tool(
            "hetu_read_resource",
            json!({"resource_id":record["resource_id"]}),
        )
        .await;
    assert_eq!(read["data"]["resource"], *record);
    assert_eq!(
        call(
            &k,
            "documents.get",
            json!({"document_id":manuscript["document"]["document_id"]})
        )["data"],
        manuscript_before["data"]
    );
    let observed = call(
        &k,
        "creative_tasks.get",
        json!({"task_ref":task["task_ref"]}),
    );
    assert_eq!(
        call(
            &k,
            "creative_tasks.close",
            json!({"task_ref":task["task_ref"],"expected":observed["data"]["expected"],"reason":"完成","operation_key":"close-reference"})
        )["status"],
        "succeeded"
    );
    assert_eq!(
        client.tool("hetu_create_resource", fields).await["error"]["code"],
        "forbidden"
    );
    client.close().await;
}

#[tokio::test]
async fn working_references_and_feedback_round_trip_over_stdio_without_author_document_writes() {
    let (root, k) = setup();
    let manuscript = document(&k, "working-source");
    let doc_id = &manuscript["document"]["document_id"];
    let before = call(&k, "documents.get", json!({"document_id":doc_id}));
    let preview = call(
        &k,
        "creative_tasks.preview_prompt",
        json!({"scope_ref":{"kind":"workspace","id":k.scope()},"task_kind":"chapter_draft","brief":"雾港的一次争执","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN"}),
    );
    let mut input = preview["data"]["prepare_input"].clone();
    input["operation_key"] = json!("working-task");
    let task = call(&k, "creative_tasks.prepare", input);
    assert_eq!(task["status"], "succeeded", "{task}");
    let task = &task["data"];
    let r = &task["task_ref"];
    let mut client = Client::start_task(
        &root.path().join("河图 离线测试 🌿"),
        false,
        r["task_id"].as_str().unwrap(),
    );
    let first = client.tool("hetu_create_working_copy",json!({"task_ref":r,"artifact_kind":"text","source_format":"markdown","title":"第一章参考稿","base_refs":[],"content":"灯下争执。\n\n结尾保留。","operation_key":"create"})).await;
    assert_eq!(first["status"], "succeeded", "{first}");
    let w = &first["data"]["working_copy_ref"];
    let feedback = client.tool("hetu_save_task_feedback",json!({"task_ref":r,"expected_feedback_head":null,"target_refs":[{"kind":"working_copy","working_copy_ref":w}],"intent":"request_changes","public_comment":"保留结尾，重写争执。","selected_refs":[],"operation_key":"feedback"})).await;
    assert_eq!(feedback["status"], "succeeded", "{feedback}");
    let f = &feedback["data"]["feedback_ref"];
    let saved = client.tool("hetu_save_working_copy",json!({"task_ref":r,"working_copy_id":w["working_copy_id"],"expected":w,"content":"不解释动机的争执。\n\n结尾保留。","feedback_refs":[f],"operation_key":"revise"})).await;
    assert_eq!(saved["status"], "succeeded", "{saved}");
    let result = client.tool("hetu_submit_creative_result",json!({"task_ref":r,"request_sha256":task["request_sha256"],"working_copy_refs":[saved["data"]["working_copy_ref"]],"feedback_refs":[f],"complete":true,"missing_items":[],"provenance":{"client":"stdio-test","skill_version":"1"},"operation_key":"submit"})).await;
    assert_eq!(result["status"], "succeeded", "{result}");
    let opinions = client
        .tool("hetu_list_task_feedback", json!({"task_ref":r}))
        .await;
    assert_eq!(
        opinions["data"]["feedback"][0]["reported_result_refs"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let old = client
        .tool(
            "hetu_read_working_copy",
            json!({"task_ref":r,"working_copy_ref":w}),
        )
        .await;
    assert_eq!(
        old["data"]["revision"]["content"],
        "灯下争执。\n\n结尾保留。"
    );
    assert_eq!(
        call(&k, "documents.get", json!({"document_id":doc_id}))["data"],
        before["data"]
    );
    client.close().await;
}
