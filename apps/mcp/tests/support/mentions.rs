use super::*;

#[path="structured_mentions.rs"]
mod structured_mentions;

fn succeeded(value: Value) -> Value {
    assert_eq!(value["status"], "succeeded", "{value}");
    value["data"].clone()
}
async fn search(client: &mut Client, query: &str) -> Value {
    let response = client
        .rpc(
            "tools/call",
            json!({"name":"hetu_search_mentions","arguments":{"query":query}}),
        )
        .await;
    assert!(response.get("error").is_none(), "{response}");
    response["result"]["structuredContent"].clone()
}
async fn resource(client: &mut Client, uri: &str) -> Value {
    let response = client.rpc("resources/read", json!({"uri":uri})).await;
    assert!(response.get("error").is_none(), "{response}");
    serde_json::from_str(response["result"]["contents"][0]["text"].as_str().unwrap()).unwrap()
}
fn grant(k: &Kernel, work: &Value, directory: &Path, client: &str) -> Value {
    succeeded(call(
        k,
        "collaboration.authorize_workspace",
        json!({"work_ref":work,"client_adapter":client,
        "collaboration_path":directory,"operation_key":format!("grant-{client}")}),
    ))["management_ref"]
        .clone()
}

#[tokio::test]
async fn mentions_keep_fixed_sources_distinct_and_recheck_client_work_and_revocation() {
    let (root, k) = setup();
    let directory = root.path().join("hub");
    let work = succeeded(call(&k, "works.list", json!({})))["works"][0]["work_ref"].clone();
    let created = document(&k, "mention-document");
    let doc = succeeded(call(
        &k,
        "documents.get",
        json!({"document_id":created["document"]["document_id"]}),
    ));
    let doc_id = &doc["document"]["document_id"];
    let canon = succeeded(call(&k, "blueprints.get", json!({"work_ref":work})));
    let save_canon = |name: &str, base: &Value, key: &str| {
        succeeded(call(
            &k,
            "blueprints.save",
            json!({"work_ref":work,
        "expected":{"blueprint_id":base["blueprint"]["blueprint_id"],"revision":base["revision"],"sha256":base["sha256"]},
        "typed_changes":[{"type":"upsert_character","entity":{"character_id":"character_11111111-1111-4111-8111-111111111111",
        "name":name,"aliases":[],"description":"只属于本作品的人物","traits":[],"facts":[],"archived":false}}],"operation_key":key}),
        ))
    };
    let old_canon = save_canon("第一章 灯塔", &canon, "canon-first");
    std::fs::write(root.path().join("creative-library.json"),serde_json::to_vec(&json!({"schema_version":1,
        "roots":[{"workspace_id":k.scope(),"works":[{"work_ref":work,"title":"不应从登记目录泄露的标题"}]}]})).unwrap()).unwrap();
    let mut client = Client::start_stable(&directory);
    let discovery = client.rpc("server/discover", json!({})).await;
    assert_eq!(
        discovery["result"]["capabilities"]["extensions"]["openai/mentions"]["searchTool"],
        "hetu_search_mentions"
    );
    let tools = client.rpc("tools/list", json!({})).await;
    let tool = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "hetu_search_mentions")
        .unwrap();
    assert_eq!(tool["annotations"]["readOnlyHint"], true);
    assert_eq!(tool["_meta"]["ui"]["visibility"], json!(["app"]));
    assert_eq!(search(&mut client, "").await["items"], json!([]));
    assert_eq!(
        search(&mut client, "不应从登记目录泄露").await["items"],
        json!([])
    );
    let management = grant(&k, &work, &directory, "codex");
    let found = search(&mut client, "灯塔").await;
    assert_eq!(found["items"].as_array().unwrap().len(), 2, "{found}");
    assert_eq!(found["coverage"]["complete"], true, "{found}");
    assert!(
        !found
            .to_string()
            .contains(management["grant_id"].as_str().unwrap())
    );
    assert!(!found.to_string().contains(root.path().to_str().unwrap()));
    let mut fixed_doc = String::new();
    let mut fixed_entity = String::new();
    for item in found["items"].as_array().unwrap() {
        let uri = item["uri"].as_str().unwrap();
        let value = resource(&mut client, uri).await;
        match value["fixed_ref"]["kind"].as_str().unwrap() {
            "document" => {
                assert_eq!(value["content"], doc["content"]);
                fixed_doc = uri.into();
            }
            "entity" => {
                let entity: Value =
                    serde_json::from_str(value["content"].as_str().unwrap()).unwrap();
                assert_eq!(entity["name"], "第一章 灯塔");
                fixed_entity = uri.into();
            }
            other => panic!("unexpected {other}"),
        }
    }
    assert_ne!(fixed_doc, fixed_entity);
    assert!(!fixed_doc.is_empty() && !fixed_entity.is_empty());
    let resource_input = json!({"work_ref":work,"title":"考据资料","category":"research","body":"资料原版",
        "tags":[],"project_id":null,"entity_refs":[],"source_notes":"隔离资料","operation_key":"resource"});
    let saved_resource = succeeded(call(&k, "resources.create", resource_input.clone()));
    let outline = json!({"id":"outline_00000000-0000-4000-8000-000000000001","title":"考据章纲","text":"章纲原版",
        "level":"chapter","target_id":doc_id});
    let saved_outlines = succeeded(call(
        &k,
        "outlines.save",
        json!({"expected":{"revision":0,"sha256":null},"items":[outline],"operation_key":"outlines"}),
    ));
    let other_sources = search(&mut client, "考据").await;
    assert_eq!(
        other_sources["items"].as_array().unwrap().len(),
        2,
        "{other_sources}"
    );
    let mut old_sources = Vec::new();
    for item in other_sources["items"].as_array().unwrap() {
        let uri = item["uri"].as_str().unwrap();
        let value = resource(&mut client, uri).await;
        assert!(value["content"].as_str().unwrap().contains("原版"));
        old_sources.push((uri.to_owned(), value));
    }
    let mut next_resource = resource_input;
    next_resource["resource_id"] = saved_resource["resource"]["resource_id"].clone();
    next_resource["expected"] = json!({"revision":saved_resource["resource"]["revision"],"sha256":saved_resource["sha256"]});
    next_resource["body"] = json!("资料新版");
    next_resource["operation_key"] = json!("resource-next");
    succeeded(call(&k, "resources.update", next_resource));
    let mut next_outline = outline;
    next_outline["text"] = json!("章纲新版");
    succeeded(call(
        &k,
        "outlines.save",
        json!({"expected":{"revision":saved_outlines["revision"],"sha256":saved_outlines["sha256"]},
        "items":[next_outline],"operation_key":"outlines-next"}),
    ));
    for (uri, old) in old_sources {
        assert_eq!(resource(&mut client, &uri).await, old);
    }
    let mutate = |change: fn(&mut Value)| {
        let fields: Vec<_> =
            form_urlencoded::parse(fixed_doc.split_once('?').unwrap().1.as_bytes()).collect();
        let mut reference: Value = serde_json::from_str(&fields[0].1).unwrap();
        change(&mut reference);
        format!(
            "hetu://mention/1?{}",
            form_urlencoded::Serializer::new(String::new())
                .append_pair("ref", &reference.to_string())
                .finish()
        )
    };
    for invalid in [
        mutate(|value| value["source"]["sha256"] = json!("0".repeat(64))),
        mutate(|value| value["source"]["management_ref"] = json!({})),
        mutate(|value| value["offset"] = json!(3)),
        format!("{fixed_doc}&path=/etc/passwd"),
    ] {
        assert!(
            client
                .rpc("resources/read", json!({"uri":invalid}))
                .await
                .get("error")
                .is_some()
        );
    }
    succeeded(call(
        &k,
        "documents.save",
        json!({"document_id":doc_id,"base_revision_id":doc["revision"]["revision_id"],
        "source_format":"markdown","content":"新正文不覆盖旧来源","operation_key":"document-next"}),
    ));
    save_canon("人物已经改名", &old_canon, "canon-next");
    assert_eq!(
        resource(&mut client, &fixed_doc).await["content"],
        doc["content"]
    );
    assert!(
        resource(&mut client, &fixed_entity).await["content"]
            .as_str()
            .unwrap()
            .contains("第一章 灯塔")
    );

    // 公开URI可跨进程恢复，不能跨客户端或跨受管作品获得权限。
    let mut other_command = Command::new(binary());
    other_command
        .arg("--client")
        .arg("claude-code")
        .arg("--collaboration-dir")
        .arg(&directory);
    let mut other = Client::spawn(other_command);
    other.rpc("server/discover", json!({})).await;
    assert!(
        other
            .rpc("resources/read", json!({"uri":fixed_doc}))
            .await
            .get("error")
            .is_some()
    );
    other.close().await;
    let drama = succeeded(call(
        &k,
        "drama.projects.create",
        json!({"title":"未获权同根作品","mode":"original","operation_key":"other-work"}),
    ));
    let other_work =
        json!({"workspace_id":k.scope(),"kind":"drama","object_id":drama["project"]["project_id"]});
    let mut bound_command = Command::new(binary());
    bound_command
        .arg("--client")
        .arg("codex")
        .arg("--collaboration-dir")
        .arg(&directory)
        .arg("--work-ref")
        .arg(other_work.to_string());
    let mut bound = Client::spawn(bound_command);
    bound.rpc("server/discover", json!({})).await;
    assert_eq!(search(&mut bound, "灯塔").await["items"], json!([]));
    assert!(
        bound
            .rpc("resources/read", json!({"uri":fixed_doc}))
            .await
            .get("error")
            .is_some()
    );
    bound.close().await;
    client.close().await;
    let mut resumed = Client::start_stable(&directory);
    resumed.rpc("server/discover", json!({})).await;
    assert_eq!(
        resource(&mut resumed, &fixed_doc).await["content"],
        doc["content"]
    );
    succeeded(call(
        &k,
        "collaboration.revoke_management",
        json!({"grant_id":management["grant_id"],"client_adapter":"codex",
        "collaboration_path":directory,"operation_key":"revoke-mention"}),
    ));
    assert_eq!(search(&mut resumed, "灯塔").await["items"], json!([]));
    assert!(
        resumed
            .rpc("resources/read", json!({"uri":fixed_doc}))
            .await
            .get("error")
            .is_some()
    );
    resumed.close().await;
}

#[tokio::test]
async fn mentions_report_partial_coverage_when_the_host_result_budget_is_full() {
    let (root, k) = setup();
    let mut refs = Vec::new();
    for index in 0..21 {
        let doc = succeeded(call(
            &k,
            "documents.create",
            json!({"kind":"novel_chapter","title":format!("来源{index}"),
            "source_format":"markdown","content":"固定原文","operation_key":format!("source-{index}")}),
        ));
        refs.push(json!({"kind":"document","document_id":doc["document"]["document_id"],"revision_id":doc["revision"]["revision_id"]}));
    }
    let task = creative_task(&k, json!(refs), None);
    let mut client = Client::start_task(
        &root.path().join("河图 离线测试 🌿"),
        false,
        task["task_ref"]["task_id"].as_str().unwrap(),
    );
    client.rpc("server/discover", json!({})).await;
    let found = search(&mut client, "").await;
    assert_eq!(found["items"].as_array().unwrap().len(), 20);
    assert_eq!(found["coverage"]["complete"], false);
    let exact = search(&mut client, "来源20").await;
    assert_eq!(exact["items"].as_array().unwrap().len(), 1);
    assert_eq!(exact["coverage"]["complete"], true);
    client.close().await;
}

#[tokio::test]
async fn official_sdk_reads_a_mention_from_the_native_stable_process() {
    use rmcp::{
        ClientHandler, ClientLifecycleMode, ClientServiceExt,
        model::{CallToolRequestParams, ProtocolVersion, ReadResourceRequestParams},
    };
    struct SdkClient;
    impl ClientHandler for SdkClient {}
    let (root, k) = setup();
    let directory = root.path().join("hub");
    let work = succeeded(call(&k, "works.list", json!({})))["works"][0]["work_ref"].clone();
    let source = document(&k, "sdk-source");
    grant(&k, &work, &directory, "codex");
    let mut child = Command::new(binary())
        .args(["--client", "codex", "--collaboration-dir"])
        .arg(&directory)
        .env("HETU_LOCAL_SETTINGS_DIR", root.path().join("settings"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let transport = (child.stdout.take().unwrap(), child.stdin.take().unwrap());
    let client = SdkClient
        .serve_with_lifecycle(
            transport,
            ClientLifecycleMode::Discover {
                preferred_versions: vec![ProtocolVersion::V_2026_07_28],
            },
        )
        .await
        .unwrap();
    let info = client.peer_info().unwrap();
    assert_eq!(
        serde_json::to_value(&info.capabilities).unwrap()["extensions"]["openai/mentions"]["searchTool"],
        "hetu_search_mentions"
    );
    let result = client
        .call_tool(
            CallToolRequestParams::new("hetu_search_mentions")
                .with_arguments(json!({"query":"灯塔"}).as_object().unwrap().clone()),
        )
        .await
        .unwrap();
    let item = &result.structured_content.as_ref().unwrap()["items"][0];
    assert_eq!(item["type"], "resource_link");
    let content = client
        .read_resource(ReadResourceRequestParams::new(
            item["uri"].as_str().unwrap(),
        ))
        .await
        .unwrap();
    let raw = serde_json::to_value(content).unwrap();
    let fixed: Value = serde_json::from_str(raw["contents"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(
        fixed["fixed_ref"]["document_id"],
        source["document"]["document_id"]
    );
    assert_eq!(fixed["fixed_ref"]["sha256"], source["revision"]["sha256"]);
    client.cancel().await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .await
        .unwrap();
    assert!(stderr.is_empty());
}

#[tokio::test]
async fn mentions_page_utf8_and_task_sources_without_creating_tasks_or_exposing_other_sources() {
    let (root, k) = setup();
    let directory = root.path().join("hub");
    let work = succeeded(call(&k, "works.list", json!({})))["works"][0]["work_ref"].clone();
    let content = "中文🌿\r\n".repeat(5000);
    let doc = succeeded(call(
        &k,
        "documents.create",
        json!({"kind":"novel_chapter","title":"分页验收","source_format":"markdown",
        "content":content,"operation_key":"long-source"}),
    ));
    grant(&k, &work, &directory, "codex");
    let mut client = Client::start_stable(&directory);
    client.rpc("server/discover", json!({})).await;
    let before = call(&k, "creative_tasks.list", json!({"work_ref":work}));
    let found = search(&mut client, "分页验收").await;
    let mut uri = found["items"][0]["uri"]
        .as_str()
        .expect("fixed source")
        .to_owned();
    let mut actual = String::new();
    let mut count = 0;
    loop {
        let page = resource(&mut client, &uri).await;
        count += 1;
        assert_eq!(page["byte_start"], actual.len());
        assert!(page["content"].as_str().unwrap().len() <= 16 * 1024);
        actual.push_str(page["content"].as_str().unwrap());
        if page["complete"] == true {
            break;
        }
        uri = page["next_resource"].as_str().unwrap().into();
        assert!(count < 20);
    }
    assert!(count > 1);
    assert_eq!(actual, content);
    assert_eq!(
        call(&k, "creative_tasks.list", json!({"work_ref":work})),
        before
    );
    for arguments in [
        json!({}),
        json!({"query":"x","management_ref":{}}),
        json!({"query":"x".repeat(201)}),
        json!({"query":"x\n"}),
    ] {
        assert!(
            client
                .rpc(
                    "tools/call",
                    json!({"name":"hetu_search_mentions","arguments":arguments})
                )
                .await
                .get("error")
                .is_some()
        );
    }
    client.close().await;
    let task = creative_task(
        &k,
        json!([{"kind":"document","document_id":doc["document"]["document_id"],"revision_id":doc["revision"]["revision_id"]}]),
        None,
    );
    let mut task_client = Client::start_task(
        &root.path().join("河图 离线测试 🌿"),
        false,
        task["task_ref"]["task_id"].as_str().unwrap(),
    );
    task_client.rpc("server/discover", json!({})).await;
    let found = search(&mut task_client, "").await;
    assert_eq!(found["items"].as_array().unwrap().len(), 1, "{found}");
    let mut uri = found["items"][0]["uri"].as_str().unwrap().to_owned();
    let mut actual = String::new();
    loop {
        let page = resource(&mut task_client, &uri).await;
        actual.push_str(page["content"].as_str().unwrap());
        if page["complete"] == true {
            break;
        }
        uri = page["next_resource"].as_str().unwrap().into();
        assert!(actual.len() <= content.len());
    }
    assert_eq!(actual, content);
    let unrelated = document(&k, "not-task-source");
    assert_eq!(search(&mut task_client, "灯塔").await["items"], json!([]));
    let mut another_connection = Client::start_stable(&directory);
    another_connection.rpc("server/discover", json!({})).await;
    let foreign = search(&mut another_connection, "灯塔").await;
    assert_eq!(foreign["items"].as_array().unwrap().len(), 1);
    assert!(
        task_client
            .rpc("resources/read", json!({"uri":foreign["items"][0]["uri"]}))
            .await
            .get("error")
            .is_some()
    );
    another_connection.close().await;
    assert_eq!(
        call(
            &k,
            "documents.get",
            json!({"document_id":unrelated["document"]["document_id"]})
        )["status"],
        "succeeded"
    );
    task_client.close().await;
}
