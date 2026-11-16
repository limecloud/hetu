use hetu_core::{Kernel, application::extensions::PluginSession};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

fn ok(result: Value) -> Value {
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn call(session: &PluginSession, work: &Value, action: &str, mut input: Value) -> Value {
    input["work_ref"] = work.clone();
    session.request(json!({"action":format!("hetu.extensions.{action}"),"contract_revision":"1","input":input}))
}
fn authorize(kernel: &Kernel, access: &Path, work: &Value, owner: &str,
    kinds: &[&str], permissions: Value, key: &str) -> Value {
    ok(kernel.extension_host_request_in(access, json!({"method":"authorize","params":{
        "work_ref":work,"plugin_id":owner,"package_sha256":"a".repeat(64),"permissions":permissions,
        "types":kinds.iter().map(|kind| json!({"kind":kind,"schema_version":"1","schema":{"type":"object"}})).collect::<Vec<_>>(),
        "operation_key":key}})))
}
fn open(workspace: &Path, access: &Path, grant: &Value) -> PluginSession {
    PluginSession::open(workspace, access, grant["grant_id"].as_str().unwrap(), &"a".repeat(64)).unwrap()
}
fn save(session: &PluginSession, work: &Value, kind: &str, title: &str, key: &str) -> Value {
    ok(call(session, work, "objects.save", json!({"kind":kind,"title":title,"schema_version":"1",
        "content":{"note":"这段内容不进入索引"},"expected_revision":0,"expected_sha256":"","operation_key":key})))
}
fn files(root: &Path) -> BTreeMap<String, String> {
    fn walk(root: &Path, at: &Path, out: &mut BTreeMap<String, String>) {
        for entry in std::fs::read_dir(at).unwrap() {
            let path = entry.unwrap().path();
            let name = path.strip_prefix(root).unwrap().to_str().unwrap().replace('\\', "/");
            if name.starts_with(".hetu/cache") { continue; }
            if path.is_dir() { walk(root, &path, out); }
            else { out.insert(name, format!("{:x}", Sha256::digest(std::fs::read(path).unwrap()))); }
        }
    }
    let mut out = BTreeMap::new(); walk(root, root, &mut out); out
}
fn cache_file(workspace: &Path) -> std::path::PathBuf {
    let scope = std::fs::read_dir(workspace.join(".hetu/cache/extension-index")).unwrap().next().unwrap().unwrap().path();
    std::fs::read_dir(scope).unwrap().next().unwrap().unwrap().path()
}

#[test]
fn search_rebuild_corruption_and_snapshot_pagination_preserve_authority() {
    let folder = tempfile::tempdir().unwrap();
    let workspace = folder.path().join("作品"); let access = folder.path().join("private");
    let kernel = Kernel::open(json!({"workspace_path":workspace,"mode":"author","create":{"title":"检索样本","locale":"zh-CN","operation_key":"fixture"}})).unwrap();
    let work = ok(kernel.request(json!({"action":"hetu.works.list","contract_revision":"1","input":{}})))["works"][0]["work_ref"].clone();
    let grant = authorize(&kernel, &access, &work, "org.test.search", &["relationships","timeline"], json!(["objects.read","objects.write"]), "grant");
    let session = open(&workspace, &access, &grant);
    let first = save(&session, &work, "relationships", "雾港人物🌿", "one");
    save(&session, &work, "relationships", "雾港旧友", "two");
    save(&session, &work, "timeline", "Harbor TIMELINE", "three");
    let original = files(&workspace);
    assert_eq!(ok(call(&session,&work,"index.status",json!({})))["state"], "missing");
    let before = ok(call(&session,&work,"objects.search",json!({"query":"雾港","limit":1})));
    assert_eq!(before["index_state"], "missing");
    assert_eq!(before["objects"].as_array().unwrap().len(), 1);
    assert!(before["next_cursor"].is_string());
    assert_eq!(files(&workspace), original, "未构建索引的查询不能写入权威文件");
    let rebuilt = ok(call(&session,&work,"index.rebuild",json!({})));
    assert_eq!(rebuilt["indexed_objects"], 3);
    assert_eq!(rebuilt["authority_changed"], false);
    assert_eq!(files(&workspace), original);
    let cache = cache_file(&workspace);
    let cache_bytes = std::fs::read(&cache).unwrap();
    assert!(!String::from_utf8_lossy(&cache_bytes).contains("这段内容不进入索引"));
    assert!(!String::from_utf8_lossy(&cache_bytes).contains(grant["grant_id"].as_str().unwrap()));
    assert_eq!(ok(call(&session,&work,"index.rebuild",json!({}))), rebuilt);
    assert_eq!(std::fs::read(&cache).unwrap(), cache_bytes);
    assert_eq!(call(&session,&work,"objects.search",json!({"query":"字".repeat(121)}))["error"]["code"], "invalid_input");
    assert_eq!(call(&session,&work,"objects.search",json!({"query":"","limit":101}))["error"]["code"], "invalid_input");
    let after = ok(call(&session,&work,"objects.search",json!({"query":"雾港","limit":1})));
    assert_eq!(after["index_state"], "ready");
    assert_eq!(after["objects"], before["objects"]);
    let second = ok(call(&session,&work,"objects.search",json!({"query":"雾港","limit":1,"cursor":before["next_cursor"]})));
    assert!(second["next_cursor"].is_null());
    assert_ne!(second["objects"][0]["object_id"], after["objects"][0]["object_id"]);
    let english = ok(call(&session,&work,"objects.search",json!({"query":"harbor timeline"})));
    assert_eq!(english["objects"].as_array().unwrap().len(), 1);
    assert_eq!(ok(call(&session,&work,"objects.search",json!({"query":"雾港","kind":"timeline"})))["objects"], json!([]));
    for changed in [json!({"query":"旧友","limit":1}),json!({"query":"雾港","limit":2}),json!({"query":"雾港","limit":1,"kind":"relationships"})] {
        let mut changed = changed; changed["cursor"] = before["next_cursor"].clone();
        assert_eq!(call(&session,&work,"objects.search",changed)["error"]["code"], "hetu.stale_evidence");
    }
    std::fs::write(&cache, b"{broken").unwrap();
    assert_eq!(ok(call(&session,&work,"index.status",json!({})))["state"], "invalid");
    let fallback = ok(call(&session,&work,"objects.search",json!({"query":"雾港","limit":1})));
    assert_eq!(fallback["index_state"], "invalid");
    assert_eq!(fallback["objects"], before["objects"]);
    ok(call(&session,&work,"index.rebuild",json!({})));
    let mut broken: Value = serde_json::from_slice(&cache_bytes).unwrap();
    broken["payload"]["objects"] = json!([]);
    std::fs::write(&cache, serde_json::to_vec(&broken).unwrap()).unwrap();
    assert_eq!(ok(call(&session,&work,"objects.search",json!({"query":"雾港"})))["objects"].as_array().unwrap().len(), 2);
    ok(call(&session,&work,"index.rebuild",json!({})));
    let updated = ok(call(&session,&work,"objects.save",json!({"object_id":first["object"]["object_id"],"kind":"relationships","title":"更新后人物","schema_version":"1","content":{},"expected_revision":1,"expected_sha256":first["sha256"],"operation_key":"update"})));
    assert_eq!(ok(call(&session,&work,"index.status",json!({})))["state"], "stale");
    assert_eq!(call(&session,&work,"objects.search",json!({"query":"雾港","limit":1,"cursor":before["next_cursor"]}))["error"]["code"], "hetu.stale_evidence");
    let current = ok(call(&session,&work,"objects.search",json!({"query":"更新后"})));
    assert_eq!(current["index_state"], "stale");
    assert_eq!(current["objects"][0]["revision"], updated["object"]["revision"]);
    // 已就绪的投影不能替代返回对象的原字节校验。
    ok(call(&session,&work,"index.rebuild",json!({})));
    let record = workspace.join("extensions/objects");
    let scope = std::fs::read_dir(record).unwrap().next().unwrap().unwrap().path();
    std::fs::write(scope.join(first["object"]["object_id"].as_str().unwrap()).join("revisions/2.json"), b"{}").unwrap();
    assert_eq!(call(&session,&work,"objects.search",json!({"query":"更新后"}))["error"]["code"], "hetu.integrity_failure");
    #[cfg(unix)]
    {
        let outside = folder.path().join("不属于作品的文件");
        std::fs::write(&outside, b"outside").unwrap();
        std::fs::rename(&cache, cache.with_extension("preserved")).unwrap();
        std::os::unix::fs::symlink(&outside, &cache).unwrap();
        for (action, input) in [("index.status",json!({})),("index.rebuild",json!({})),("objects.search",json!({"query":""}))] {
            assert_eq!(call(&session,&work,action,input)["error"]["code"], "hetu.unsafe_path");
        }
        assert_eq!(std::fs::read(outside).unwrap(), b"outside");
    }
}

#[test]
fn index_and_cursors_remain_scoped_to_work_plugin_types_and_current_grant() {
    let folder = tempfile::tempdir().unwrap(); let workspace=folder.path().join("作品"); let access=folder.path().join("private");
    let kernel=Kernel::open(json!({"workspace_path":workspace,"mode":"author","create":{"title":"隔离样本","locale":"zh-CN","operation_key":"fixture"}})).unwrap();
    let work=ok(kernel.request(json!({"action":"hetu.works.list","contract_revision":"1","input":{}})))["works"][0]["work_ref"].clone();
    let full=authorize(&kernel,&access,&work,"org.test.search",&["relationships","timeline"],json!(["objects.read","objects.write"]),"full");
    let writer=open(&workspace,&access,&full);
    save(&writer,&work,"relationships","人物甲","one"); save(&writer,&work,"relationships","人物乙","two"); save(&writer,&work,"timeline","未获权时间线","three");
    let restricted=authorize(&kernel,&access,&work,"org.test.search",&["relationships"],json!(["objects.read"]),"restricted");
    let reader=open(&workspace,&access,&restricted);
    assert_eq!(ok(call(&reader,&work,"index.rebuild",json!({})))["indexed_objects"],2);
    assert_eq!(ok(call(&reader,&work,"objects.search",json!({"query":"未获权"})))["objects"],json!([]));
    let page=ok(call(&reader,&work,"objects.search",json!({"query":"人物","limit":1})));
    assert_eq!(call(&writer,&work,"objects.search",json!({"query":"人物","limit":1,"cursor":page["next_cursor"]}))["error"]["code"],"hetu.stale_evidence");
    let other=authorize(&kernel,&access,&work,"org.test.other",&["relationships"],json!(["objects.read"]),"other");
    assert_eq!(ok(call(&open(&workspace,&access,&other),&work,"objects.search",json!({"query":""})))["objects"],json!([]));
    assert_eq!(call(&open(&workspace,&access,&other),&work,"objects.search",json!({"query":"人物","limit":1,"cursor":page["next_cursor"]}))["error"]["code"],"hetu.stale_evidence");
    let project=ok(kernel.request(json!({"action":"hetu.drama.projects.create","contract_revision":"1","input":{"title":"同根剧本","mode":"original","operation_key":"drama"}})));
    let drama=json!({"workspace_id":work["workspace_id"],"kind":"drama","object_id":project["project"]["project_id"]});
    for action in ["objects.search","index.status","index.rebuild"] {
        assert_eq!(call(&reader,&drama,action,json!({"query":"人物"}))["error"]["code"],"forbidden");
    }
    let drama_grant=authorize(&kernel,&access,&drama,"org.test.search",&["relationships"],json!(["objects.read"]),"drama-grant");
    assert_eq!(ok(call(&open(&workspace,&access,&drama_grant),&drama,"objects.search",json!({"query":""})))["objects"],json!([]));
    assert_eq!(call(&open(&workspace,&access,&drama_grant),&drama,"objects.search",json!({"query":"人物","limit":1,"cursor":page["next_cursor"]}))["error"]["code"],"hetu.stale_evidence");
    let write_only=authorize(&kernel,&access,&work,"org.test.search",&["relationships"],json!(["objects.write"]),"write-only");
    let write_only=open(&workspace,&access,&write_only);
    assert!(!write_only.inspect()["data"]["actions"].as_array().unwrap().iter().any(|a|a["name"]=="hetu.extensions.objects.search" || a["name"]=="hetu.extensions.index.rebuild"));
    assert_eq!(call(&write_only,&work,"index.rebuild",json!({}))["error"]["code"],"forbidden");
    ok(kernel.extension_host_request_in(&access,json!({"method":"revoke","params":{"grant_id":restricted["grant_id"]}})));
    assert_eq!(call(&reader,&work,"index.status",json!({}))["error"]["code"],"forbidden");
    let again=authorize(&kernel,&access,&work,"org.test.search",&["relationships"],json!(["objects.read"]),"again");
    let again=open(&workspace,&access,&again);
    assert_eq!(call(&again,&work,"objects.search",json!({"query":"人物","limit":1,"cursor":page["next_cursor"]}))["error"]["code"],"hetu.stale_evidence");
    assert_eq!(ok(call(&again,&work,"index.status",json!({})))["state"],"ready");
    let fallback=ok(kernel.extension_host_request_in(&access,json!({"method":"read","params":{"work_ref":work,"plugin_id":"org.test.search","request":{"action":"hetu.extensions.objects.search","contract_revision":"1","input":{"work_ref":work,"query":"人物"}}}})));
    assert_eq!(fallback["objects"].as_array().unwrap().len(),2);
    let denied=kernel.extension_host_request_in(&access,json!({"method":"read","params":{"work_ref":work,"plugin_id":"org.test.search","request":{"action":"hetu.extensions.index.rebuild","contract_revision":"1","input":{"work_ref":work}}}}));
    assert_eq!(denied["error"]["code"],"forbidden");
}
