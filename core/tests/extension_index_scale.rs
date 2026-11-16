use hetu_core::{Kernel, application::extensions::PluginSession};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Instant,
};

fn ok(value: Value) -> Value {
    assert_eq!(value["status"], "succeeded", "{value}");
    value["data"].clone()
}
fn call(session: &PluginSession, work: &Value, action: &str, mut input: Value) -> Value {
    input["work_ref"] = work.clone();
    session.request(
        json!({"action":format!("hetu.extensions.{action}"),"contract_revision":"1","input":input}),
    )
}
struct Fixture {
    _directory: tempfile::TempDir,
    workspace: PathBuf,
    work: Value,
    session: PluginSession,
    collection: PathBuf,
    seed: Value,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("规模样本");
        let access = directory.path().join("private");
        let kernel = Kernel::open(json!({"workspace_path":workspace,"mode":"author","create":{"title":"索引预算样本","locale":"zh-CN","operation_key":"fixture"}})).unwrap();
        let work = ok(
            kernel.request(json!({"action":"hetu.works.list","contract_revision":"1","input":{}}))
        )["works"][0]["work_ref"]
            .clone();
        let grant = ok(kernel.extension_host_request_in(&access,json!({"method":"authorize","params":{
            "work_ref":work,"plugin_id":"org.test.scale","package_sha256":"a".repeat(64),"permissions":["objects.read","objects.write"],
            "types":[{"kind":"notes","schema_version":"1","schema":{"type":"object"}}],"operation_key":"grant"}})));
        let session = PluginSession::open(
            &workspace,
            &access,
            grant["grant_id"].as_str().unwrap(),
            &"a".repeat(64),
        )
        .unwrap();
        let seed = ok(call(&session,&work,"objects.save",json!({"kind":"notes","title":"起点","schema_version":"1","content":{},"expected_revision":0,"expected_sha256":"","operation_key":"seed"})))["object"].clone();
        let collection = std::fs::read_dir(workspace.join("extensions/objects"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        Self {
            _directory: directory,
            workspace,
            work,
            session,
            collection,
            seed,
        }
    }
    // 大样本夹具复制经Core保存的完整修订格式；不让测试耗时取决于上万次业务事务。
    fn object(&self, number: usize, title: &str, content: Value) {
        let object_id = format!("ext_{number:08x}-0000-4000-8000-000000000000");
        let mut record = self.seed.clone();
        record["object_id"] = json!(object_id);
        record["title"] = json!(title);
        record["content"] = content;
        let bytes = serde_json::to_vec_pretty(&record).unwrap();
        let sha = format!("{:x}", Sha256::digest(&bytes));
        let root = self.collection.join(&object_id);
        std::fs::create_dir_all(root.join("revisions")).unwrap();
        std::fs::write(root.join("revisions/1.json"), bytes).unwrap();
        std::fs::write(
            root.join("head.json"),
            serde_json::to_vec(&json!({"object_id":object_id,"revision":1,"sha256":sha})).unwrap(),
        )
        .unwrap();
    }
    fn cache(&self) -> PathBuf {
        let scopes = self.workspace.join(".hetu/cache/extension-index");
        let scope = std::fs::read_dir(scopes)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        std::fs::read_dir(scope)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path()
    }
}
fn digest(path: &Path) -> String {
    format!("{:x}", Sha256::digest(std::fs::read(path).unwrap()))
}

#[test]
fn ten_thousand_objects_and_cache_budget_do_not_truncate_results_or_replace_valid_cache() {
    let fixture = Fixture::new();
    for number in 1..10_000 {
        fixture.object(
            number,
            if number == 9_999 {
                "边界终点"
            } else {
                "规模成果"
            },
            json!({}),
        );
    }
    let start = Instant::now();
    let result = ok(call(
        &fixture.session,
        &fixture.work,
        "objects.search",
        json!({"query":"边界终点"}),
    ));
    assert_eq!(result["objects"].as_array().unwrap().len(), 1);
    let scan_ms = start.elapsed().as_millis();
    let start = Instant::now();
    assert_eq!(
        ok(call(
            &fixture.session,
            &fixture.work,
            "index.rebuild",
            json!({})
        ))["indexed_objects"],
        10_000
    );
    let rebuild_ms = start.elapsed().as_millis();
    let cache = fixture.cache();
    println!(
        "index_scale_observation {}",
        json!({"objects":10_000,"scan_ms":scan_ms,"rebuild_ms":rebuild_ms,"cache_bytes":std::fs::metadata(&cache).unwrap().len()})
    );
    // 单纯超大的旧缓存按invalid处理，回读权威记录仍找到边界对象。
    std::fs::OpenOptions::new()
        .write(true)
        .open(&cache)
        .unwrap()
        .set_len(8 * 1024 * 1024 + 1)
        .unwrap();
    assert_eq!(
        ok(call(
            &fixture.session,
            &fixture.work,
            "index.status",
            json!({})
        ))["state"],
        "invalid"
    );
    let fallback = ok(call(
        &fixture.session,
        &fixture.work,
        "objects.search",
        json!({"query":"边界终点"}),
    ));
    assert_eq!(fallback["index_state"], "invalid");
    assert_eq!(fallback["objects"].as_array().unwrap().len(), 1);
    ok(call(
        &fixture.session,
        &fixture.work,
        "index.rebuild",
        json!({}),
    ));
    let original = digest(&cache);
    for number in 1..10_000 {
        fixture.object(number, &"界".repeat(240), json!({}));
    }
    assert_eq!(
        call(&fixture.session, &fixture.work, "index.rebuild", json!({}))["error"]["code"],
        "hetu.budget_exceeded"
    );
    assert_eq!(digest(&cache), original, "超出投影预算不能替换已有缓存");
    fixture.object(10_000, "超过对象预算", json!({}));
    for action in ["index.status", "index.rebuild", "objects.search"] {
        let input = if action == "objects.search" {
            json!({"query":""})
        } else {
            json!({})
        };
        assert_eq!(
            call(&fixture.session, &fixture.work, action, input)["error"]["code"],
            "hetu.budget_exceeded"
        );
    }
    assert_eq!(digest(&cache), original);
}

#[test]
fn scan_budget_accepts_bounded_records_and_rejects_larger_sources_without_partial_success() {
    let fixture = Fixture::new();
    let content = json!({"note":"x".repeat(1_020_000)});
    for number in 1..=32 {
        fixture.object(number, "大成果", content.clone());
    }
    assert_eq!(
        ok(call(
            &fixture.session,
            &fixture.work,
            "index.rebuild",
            json!({})
        ))["indexed_objects"],
        33
    );
    let cache = fixture.cache();
    let original = digest(&cache);
    for number in 33..=34 {
        fixture.object(number, "大成果", content.clone());
    }
    for action in ["objects.search", "index.rebuild"] {
        let input = if action == "objects.search" {
            json!({"query":"大成果"})
        } else {
            json!({})
        };
        assert_eq!(
            call(&fixture.session, &fixture.work, action, input)["error"]["code"],
            "hetu.budget_exceeded"
        );
    }
    assert_eq!(digest(&cache), original);
}
