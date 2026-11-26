use super::*;

fn decode_uri(uri: &str) -> Value {
    let pairs: Vec<_> = form_urlencoded::parse(uri.split_once('?').unwrap().1.as_bytes()).collect();
    serde_json::from_str(&pairs[0].1).unwrap()
}
fn encode_uri(value: &Value) -> String {
    format!(
        "hetu://mention/1?{}",
        form_urlencoded::Serializer::new(String::new())
            .append_pair("ref", &value.to_string())
            .finish()
    )
}
fn native_work_client(directory: &Path, work: &Value) -> Client {
    let mut command = Command::new(binary());
    command
        .args(["--client", "codex", "--collaboration-dir"])
        .arg(directory)
        .arg("--work-ref")
        .arg(work.to_string())
        .env("HETU_LOCAL_SETTINGS_DIR", directory.join("settings"));
    Client::spawn(command)
}
fn plugin_save(
    kernel: &Kernel,
    work: &Value,
    owner: &str,
    previous: Option<&Value>,
    note: &str,
    key: &str,
) -> Value {
    let context = json!({"plugin_id":owner,"package_sha256":"a".repeat(64),"work_ref":work,"types":[{"kind":"notes","schema_version":"1","schema":{"type":"object"}}]});
    let mut input = json!({"work_ref":work,"kind":"notes","title":"雨夜专业方案","schema_version":"1","content":{"note":note},
        "expected_revision":previous.map_or(0,|value|value["object"]["revision"].as_u64().unwrap()),
        "expected_sha256":previous.map_or(json!(""),|value|value["sha256"].clone()),"operation_key":key});
    if let Some(previous) = previous {
        input["object_id"] = previous["object"]["object_id"].clone();
    }
    succeeded(kernel.open_plugin_request(json!({"context":context,"request":{"action":"hetu.extensions.objects.save","contract_revision":"1","input":input}})))
}

#[tokio::test]
async fn structured_mentions_keep_scene_bytes_and_multi_owner_results_after_updates_and_disable() {
    let (root, k) = setup();
    let directory = root.path().join("hub");
    let project = succeeded(call(
        &k,
        "drama.projects.create",
        json!({"title":"独立剧本","mode":"original","operation_key":"drama"}),
    ));
    let work = json!({"workspace_id":k.scope(),"kind":"drama","object_id":project["project"]["project_id"]});
    let episode = succeeded(call(
        &k,
        "drama.episodes.create",
        json!({"project_ref":{"project_id":work["object_id"],"revision":project["project"]["revision"],"sha256":project["sha256"]},"title":"第一集","language_tag":"zh-CN","operation_key":"episode"}),
    ));
    let source = format!(
        "Title: 原稿\r\n\r\nINT. 旧站 - NIGHT #一#\r\n\r\n{}\r\n\r\n.尾声\r\n\r\n结束。",
        "雨夜🌿\r\n".repeat(3000)
    );
    let saved = succeeded(call(
        &k,
        "documents.save",
        json!({"document_id":episode["document"]["document_id"],"base_revision_id":episode["document"]["current_revision_id"],
        "source_format":"fountain","content":source,"operation_key":"save"}),
    ));
    let a = plugin_save(&k, &work, "org.hetu.owner-a", None, "A原版", "a");
    let b = plugin_save(&k, &work, "org.hetu.owner-b", None, "B原版", "b");
    let management = grant(&k, &work, &directory, "codex");
    let mut client = native_work_client(&directory, &work);
    client.rpc("server/discover", json!({})).await;
    let found = search(&mut client, "旧站").await;
    assert_eq!(found["coverage"]["complete"], true, "{found}");
    assert_eq!(found["items"].as_array().unwrap().len(), 1, "{found}");
    let uri = found["items"][0]["uri"].as_str().unwrap();
    let reference = decode_uri(uri);
    assert_eq!(reference["source"]["kind"], "scene");
    let mut next = uri.to_owned();
    let mut content = String::new();
    let mut pages = 0;
    loop {
        let page = resource(&mut client, &next).await;
        pages += 1;
        assert_eq!(
            page["document_ref"]["revision_id"],
            saved["revision"]["revision_id"]
        );
        content.push_str(page["content"].as_str().unwrap());
        if page["complete"] == true {
            break;
        }
        next = page["next_resource"].as_str().unwrap().into();
        assert!(pages < 20);
    }
    assert!(pages > 1);
    let fixed = &reference["source"];
    assert_eq!(
        content,
        &source[fixed["byte_start"].as_u64().unwrap() as usize
            ..fixed["byte_end"].as_u64().unwrap() as usize]
    );
    assert!(!content.contains(".尾声"));
    let first = resource(&mut client, uri).await;
    succeeded(call(
        &k,
        "documents.save",
        json!({"document_id":episode["document"]["document_id"],"base_revision_id":saved["revision"]["revision_id"],
        "source_format":"fountain","content":".新的开头\n\n保留旧来源。","operation_key":"new-source"}),
    ));
    assert_eq!(resource(&mut client, uri).await, first);
    let mut invalid = reference.clone();
    invalid["source"]["byte_start"] = json!(fixed["byte_start"].as_u64().unwrap() + 1);
    assert!(
        client
            .rpc("resources/read", json!({"uri":encode_uri(&invalid)}))
            .await
            .get("error")
            .is_some()
    );
    let results = search(&mut client, "雨夜专业方案").await;
    assert_eq!(results["items"].as_array().unwrap().len(), 2, "{results}");
    assert_ne!(
        results["items"][0]["description"],
        results["items"][1]["description"]
    );
    let old_results = results["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["uri"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let mut snapshots = Vec::new();
    for uri in &old_results {
        snapshots.push(resource(&mut client, uri).await);
    }
    plugin_save(&k, &work, "org.hetu.owner-a", Some(&a), "A新版", "a-next");
    plugin_save(&k, &work, "org.hetu.owner-b", Some(&b), "B新版", "b-next");
    for owner in ["org.hetu.owner-a", "org.hetu.owner-b"] {
        succeeded(k.extension_host_request_in(&root.path().join("plugin-access"),json!({"method":"disable","params":{"plugin_id":owner,"package_sha256":"a".repeat(64)}})));
    }
    client.close().await;
    let mut resumed = native_work_client(&directory, &work);
    resumed.rpc("server/discover", json!({})).await;
    for (index, uri) in old_results.iter().enumerate() {
        assert_eq!(resource(&mut resumed, uri).await, snapshots[index]);
    }
    let mut invalid = decode_uri(&old_results[0]);
    invalid["source"]["owner_plugin_id"] = json!("org.hetu.missing");
    assert!(
        resumed
            .rpc("resources/read", json!({"uri":encode_uri(&invalid)}))
            .await
            .get("error")
            .is_some()
    );
    assert_eq!(
        search(&mut resumed, "雨夜专业方案").await["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    // 未安装包的保留记录损坏必须给出失败，不冒充没有匹配来源。
    let record_path = std::fs::read_dir(root.path().join("河图 离线测试 🌿/extensions/objects"))
        .unwrap()
        .map(|entry| {
            entry
                .unwrap()
                .path()
                .join(a["object"]["object_id"].as_str().unwrap())
                .join("head.json")
        })
        .find(|path| path.is_file())
        .unwrap();
    let original = std::fs::read(&record_path).unwrap();
    std::fs::write(&record_path, b"broken").unwrap();
    let failure = resumed
        .rpc(
            "tools/call",
            json!({"name":"hetu_search_mentions","arguments":{"query":"雨夜专业方案"}}),
        )
        .await;
    std::fs::write(&record_path, original).unwrap();
    assert_eq!(failure["result"]["isError"], true, "{failure}");
    assert_eq!(
        failure["result"]["structuredContent"]["error"]["code"],
        "source_search_incomplete"
    );
    succeeded(call(
        &k,
        "collaboration.revoke_management",
        json!({"grant_id":management["grant_id"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"revoke"}),
    ));
    for uri in old_results.iter().chain(std::iter::once(&uri.to_owned())) {
        assert!(
            resumed
                .rpc("resources/read", json!({"uri":uri}))
                .await
                .get("error")
                .is_some()
        );
    }
    resumed.close().await;
}

#[tokio::test]
async fn structured_mentions_use_independent_video_episodes_and_fixed_media_without_mutable_decisions()
 {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let (root, k) = setup();
    let directory = root.path().join("hub");
    let project = succeeded(call(
        &k,
        "video.projects.create",
        json!({"title":"独立视频","brief":"来源验收","language_tag":"zh-CN","operation_key":"video"}),
    ));
    let work = &project["work_ref"];
    let episode = succeeded(call(
        &k,
        "video.episodes.create",
        json!({"project_ref":{"video_project_id":work["object_id"],"revision":project["project"]["revision"],"sha256":project["sha256"]},"title":"雨夜分集","brief":"原分集内容","operation_key":"episode"}),
    ));
    let bytes = include_bytes!("../../../desktop/tests/fixtures/preview.mp4");
    let sha = format!("{:x}", Sha256::digest(bytes));
    let inline = json!({"filename":"雨夜.mp4","sha256":sha,"base64":STANDARD.encode(bytes)});
    let inspected = succeeded(call(&k, "assets.inspect", json!({"inline_source":inline})));
    let asset = succeeded(call(
        &k,
        "assets.import",
        json!({"work_ref":work,"inline_source":inline,"expected_file":{"sha256":inspected["sha256"],"size_bytes":inspected["size_bytes"]},"title":"雨夜样本","source":{"source_type":"author_supplied","creator_statement":"隔离样本"},"rights_status":"author_owned","redistribution_allowed":true,"rights_statement":"隔离测试样本","operation_key":"asset"}),
    ));
    let save_media = |key: &str, previous: Value| {
        succeeded(call(
            &k,
            "video.media.save",
            json!({"work_ref":work,"video_episode_id":episode["episode"]["video_episode_id"],
        "asset_ref":{"asset_id":asset["asset"]["asset_id"],"revision":1,"sha256":asset["sha256"]},"title":"雨夜成片","purpose":"final","stream_index":0,
        "time_base":{"numerator":1,"denominator":1000},"duration_ticks":2000,"previous_media_ref":previous,"operation_key":key}),
        ))
    };
    let media = save_media("first", Value::Null);
    let management = grant(&k, work, &directory, "codex");
    let mut client = native_work_client(&directory, work);
    client.rpc("server/discover", json!({})).await;
    let found = search(&mut client, "雨夜").await;
    assert_eq!(found["coverage"]["complete"], true, "{found}");
    assert_eq!(found["items"].as_array().unwrap().len(), 2, "{found}");
    let mut fixed_media = None;
    let mut fixed_episode = None;
    for item in found["items"].as_array().unwrap() {
        let uri = item["uri"].as_str().unwrap();
        let reference = decode_uri(uri);
        let snapshot = resource(&mut client, uri).await;
        match reference["source"]["kind"].as_str().unwrap() {
            "video_media" => {
                assert_eq!(reference["source"]["media_ref"], media["media_ref"]);
                fixed_media = Some((uri.to_owned(), snapshot));
            }
            "video_episode" => {
                fixed_episode = Some((uri.to_owned(), snapshot));
            }
            other => panic!("unexpected {other}"),
        }
    }
    let (media_uri, media_snapshot) = fixed_media.unwrap();
    let (episode_uri, episode_snapshot) = fixed_episode.unwrap();
    let preview = succeeded(call(
        &k,
        "video.decisions.preview",
        json!({"work_ref":work,"media_ref":media["media_ref"],"purpose":"final","decision":"confirmed","expected_decision_ref":null,
        "author_statement":"QA仅验证固定决定，不代表创作品质认可。"}),
    ));
    succeeded(call(
        &k,
        "video.decisions.save",
        json!({"work_ref":work,"preview":preview["preview"],"operation_key":"decision"}),
    ));
    save_media("new", media["media_ref"].clone());
    succeeded(call(
        &k,
        "video.episodes.update",
        json!({"project_ref":{"video_project_id":work["object_id"],"revision":episode["project"]["revision"],"sha256":episode["sha256"]},
        "video_episode_id":episode["episode"]["video_episode_id"],"expected":{"revision":episode["episode"]["revision"],"sha256":episode["episode_sha256"]},
        "title":"后来改名","brief":"后来内容","archived":false,"operation_key":"episode-next"}),
    ));
    assert_eq!(resource(&mut client, &media_uri).await, media_snapshot);
    assert_eq!(resource(&mut client, &episode_uri).await, episode_snapshot);
    assert!(!media_snapshot.to_string().contains("author_decision"));
    assert!(!media_snapshot.to_string().contains("blob"));
    let mut invalid = decode_uri(&media_uri);
    invalid["source"]["media_ref"]["sha256"] = json!("0".repeat(64));
    assert!(
        client
            .rpc("resources/read", json!({"uri":encode_uri(&invalid)}))
            .await
            .get("error")
            .is_some()
    );
    succeeded(call(
        &k,
        "collaboration.revoke_management",
        json!({"grant_id":management["grant_id"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"revoke"}),
    ));
    for uri in [media_uri, episode_uri] {
        assert!(
            client
                .rpc("resources/read", json!({"uri":uri}))
                .await
                .get("error")
                .is_some()
        );
    }
    client.close().await;
}
