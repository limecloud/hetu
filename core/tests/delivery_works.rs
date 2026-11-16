use base64::{Engine, engine::general_purpose::STANDARD};
use hetu_core::{Kernel, collaboration::CollaborationHub};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn call(k: &Kernel, action: &str, input: Value) -> Value {
    k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
}
fn ok(v: Value) -> Value {
    assert_eq!(v["status"], "succeeded", "{v}");
    v["data"].clone()
}
fn setup() -> (tempfile::TempDir, Kernel, Value, Value) {
    let root = tempfile::tempdir().unwrap();
    let k = Kernel::open(json!({"workspace_path":root.path().join("作品"),"mode":"author","create":{"title":"原著私有标题","locale":"zh-CN","operation_key":"init"}})).unwrap();
    let novel = ok(call(&k, "works.list", json!({})))["works"][0]["work_ref"].clone();
    let p = ok(call(
        &k,
        "drama.projects.create",
        json!({"title":"独立剧本","mode":"original","operation_key":"drama"}),
    ));
    let drama =
        json!({"workspace_id":k.scope(),"kind":"drama","object_id":p["project"]["project_id"]});
    (root, k, novel, drama)
}
fn grant(k: &Kernel, root: &std::path::Path, w: &Value) -> (CollaborationHub, Value) {
    let dir = root.join("授权");
    let r=ok(call(k,"collaboration.authorize_workspace",json!({"work_ref":w,"client_adapter":"codex","collaboration_path":dir,"operation_key":format!("grant-{}",w["object_id"])})))["management_ref"].clone();
    (CollaborationHub::open(&dir, "codex").unwrap(), r)
}
fn agent(h: &CollaborationHub, g: &Value, a: &str, mut i: Value) -> Value {
    i["management_ref"] = g.clone();
    h.request(json!({"action":format!("hetu.{a}"),"contract_revision":"1","input":i}))
}
fn source(work: &Value) -> Value {
    let text = if work["kind"] == "drama" {
        "INT. 渡口 - DAY\n\n沈砚走进门。\n\n沈砚\n船来了🌿。\n"
    } else {
        "# 第一章\n\n渡口来了一个人🌿。\n"
    };
    json!({"work_ref":work,"inline_source":{"filename":"原稿.txt","base64":STANDARD.encode(text.as_bytes()),"sha256":format!("{:x}",Sha256::digest(text.as_bytes()))},"format":if work["kind"] == "drama" {"fountain"} else {"markdown"},"profile":"source/1"})
}
fn import(k: &Kernel, h: &CollaborationHub, g: &Value, work: &Value, key: &str) -> Value {
    let preview = ok(agent(h, g, "documents.preview_import", source(work)))["preview"].clone();
    let mut i = json!({"work_ref":work,"preview":preview,"kind":if work["kind"] == "drama" {"drama_script"} else {"novel_chapter"},"title":key,"language_tag":"zh-CN","acknowledgement":"核对原稿与转换损失。","operation_key":key});
    if work["kind"] == "drama" {
        let p = ok(call(
            k,
            "drama.projects.get",
            json!({"project_id":work["object_id"]}),
        ));
        i["drama_project_ref"] = json!({"project_id":work["object_id"],"revision":p["project"]["revision"],"sha256":p["sha256"]});
    } else {
        let n = ok(call(k, "novels.get", json!({})));
        i["novel_expected"] = json!({"revision":n["revision"],"sha256":n["sha256"]});
    }
    i
}
fn execute(
    k: &Kernel,
    h: &CollaborationHub,
    g: &Value,
    action: &str,
    input: Value,
    key: &str,
) -> Value {
    let p = ok(agent(
        h,
        g,
        "agent_operations.prepare",
        json!({"action":format!("hetu.{action}"),"input":input,"summary":key,"operation_key":format!("prepare-{key}")}),
    ));
    assert_eq!(
        agent(
            h,
            g,
            "agent_operations.execute",
            json!({"proposal_id":p["proposal_id"],"proposal_sha256":p["proposal_sha256"],"operation_key":format!("premature-{key}")})
        )["error"]["code"],
        "hetu.author_confirmation_required"
    );
    ok(call(
        k,
        "agent_operations.decide",
        json!({"proposal_id":p["proposal_id"],"proposal_sha256":p["proposal_sha256"],"expected_state_revision":1,"decision":"approve","operation_key":format!("approve-{key}")}),
    ));
    let args = json!({"proposal_id":p["proposal_id"],"proposal_sha256":p["proposal_sha256"],"operation_key":format!("execute-{key}")});
    let done = ok(agent(h, g, "agent_operations.execute", args.clone()));
    assert_eq!(ok(agent(h, g, "agent_operations.execute", args)), done);
    assert_eq!(
        ok(agent(
            h,
            g,
            "agent_operations.get",
            json!({"proposal_id":p["proposal_id"]})
        ))["state"],
        "executed"
    );
    done["result"].clone()
}
fn doc_ref(d: &Value) -> Value {
    json!({"document_id":d["document"]["document_id"],"revision_id":d["revision"]["revision_id"],"sha256":d["revision"]["sha256"]})
}

#[test]
fn exact_import_is_reviewed_atomic_and_never_reads_host_paths() {
    let (root, k, novel, drama) = setup();
    let (hub, g) = grant(&k, root.path(), &drama);
    let caps = ok(agent(&hub, &g, "capabilities.get", json!({})));
    let action = caps["actions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["name"] == "hetu.documents.preview_import")
        .unwrap();
    jsonschema::validator_for(&action["input_schema"]).unwrap();
    assert_eq!(
        action["input_schema"]["properties"]["work_ref"]["const"],
        drama
    );
    assert!(
        action["input_schema"]["properties"]
            .get("file_path")
            .is_none()
    );
    assert_eq!(
        agent(
            &hub,
            &g,
            "documents.preview_import",
            json!({"work_ref":drama,"file_path":"/etc/passwd","format":"txt","profile":"source/1"})
        )["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        agent(&hub, &g, "documents.preview_import", source(&novel))["error"]["code"],
        "forbidden"
    );
    let i = import(&k, &hub, &g, &drama, "首集");
    let mut foreign = i.clone();
    foreign["work_ref"] = novel.clone();
    assert_eq!(
        agent(
            &hub,
            &g,
            "agent_operations.prepare",
            json!({"action":"hetu.documents.import","input":foreign,"summary":"错误目标","operation_key":"wrong"})
        )["error"]["code"],
        "forbidden"
    );
    let done = execute(&k, &hub, &g, "documents.import", i, "first");
    assert!(done["document"]["drama_episode_id"].is_string(), "{done}");
    let p = ok(agent(
        &hub,
        &g,
        "drama.projects.get",
        json!({"project_id":drama["object_id"]}),
    ));
    assert_eq!(p["episodes"].as_array().unwrap().len(), 1);
    let read = ok(agent(
        &hub,
        &g,
        "documents.get",
        json!({"document_id":done["document"]["document_id"]}),
    ));
    assert!(read["content"].as_str().unwrap().contains("船来了🌿"));
    assert_eq!(read["revision"]["origin_kind"], "import");
    let (nh, ng) = grant(&k, root.path(), &novel);
    assert_eq!(
        agent(
            &nh,
            &ng,
            "documents.get",
            json!({"document_id":done["document"]["document_id"]})
        )["error"]["code"],
        "forbidden"
    );
    let h = ok(agent(
        &hub,
        &g,
        "handoffs.get",
        json!({"view_kind":"import","object_ref":{"work_ref":drama}}),
    ));
    assert!(
        h["proposal_actions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["name"] == "hetu.documents.import")
    );
}

#[test]
fn novel_import_fixes_catalog_and_batch_scope() {
    let (root, k, novel, drama) = setup();
    let (hub, g) = grant(&k, root.path(), &novel);
    let old = import(&k, &hub, &g, &novel, "旧目录");
    let current = import(&k, &hub, &g, &novel, "第一章");
    execute(&k, &hub, &g, "documents.import", current, "first");
    let result = agent(
        &hub,
        &g,
        "agent_operations.prepare",
        json!({"action":"hetu.documents.import","input":old,"summary":"过期导入","operation_key":"stale"}),
    );
    assert_eq!(result["error"]["code"], "revision_conflict", "{result}");
    let n = ok(agent(&hub, &g, "novels.get", json!({})));
    let batch = json!({"work_ref":novel,"expected":{"revision":n["revision"],"sha256":n["sha256"]},"items":[{"title":"第二章","language_tag":"zh-CN","volume_id":null,"source":source(&novel)},{"title":"同名也不合并","language_tag":"zh-CN","volume_id":null,"source":source(&novel)}],"acknowledgement":"核对全部原稿。","operation_key":"batch"});
    let mut foreign = batch.clone();
    foreign["items"][1]["source"]["work_ref"] = drama;
    assert_eq!(
        agent(
            &hub,
            &g,
            "agent_operations.prepare",
            json!({"action":"hetu.documents.import_batch","input":foreign,"summary":"混入其他作品","operation_key":"bad-batch"})
        )["error"]["code"],
        "forbidden"
    );
    let done = execute(&k, &hub, &g, "documents.import_batch", batch, "batch");
    assert_eq!(done["documents"].as_array().unwrap().len(), 2);
    assert_eq!(
        ok(agent(&hub, &g, "documents.list", json!({"work_ref":novel})))["documents"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn fixed_delivery_and_manifest_do_not_leak_siblings_and_revocation_stops_access() {
    let (root, k, novel, drama) = setup();
    let (hub, g) = grant(&k, root.path(), &drama);
    let i = import(&k, &hub, &g, &drama, "第一集");
    let d = execute(&k, &hub, &g, "documents.import", i, "episode");
    let foreign = ok(call(
        &k,
        "documents.create",
        json!({"kind":"novel_chapter","title":"私有章节","source_format":"markdown","content":"不应外发","operation_key":"private"}),
    ));
    let req = json!({"work_ref":drama,"revision_refs":[doc_ref(&d)],"format":"fountain","profile":"source/1"});
    let mut mixed = req.clone();
    mixed["revision_refs"][0] = doc_ref(&foreign);
    assert_eq!(
        agent(&hub, &g, "documents.preview_export", mixed)["error"]["code"],
        "forbidden"
    );
    let p = ok(agent(&hub, &g, "documents.preview_export", req))["preview"].clone();
    let exported = execute(
        &k,
        &hub,
        &g,
        "documents.export",
        json!({"preview":p,"acknowledgement":"确认格式与固定选集。","operation_key":"document-export"}),
        "export",
    );
    assert!(
        root.path()
            .join("作品")
            .join(exported["path"].as_str().unwrap())
            .is_file()
    );
    let bp = ok(agent(&hub, &g, "blueprints.get", json!({"work_ref":drama})));
    let req = json!({"work_ref":drama,"selection":{"blueprint_ref":{"revision":bp["revision"],"sha256":bp["sha256"]},"document_refs":[doc_ref(&d)]},"profile":"review_delivery","reading_formats":[]});
    let mut legacy_request = req.clone();
    legacy_request.as_object_mut().unwrap().remove("work_ref");
    let mut wrong = req.clone();
    let nb = ok(call(&k, "blueprints.get", json!({"work_ref":novel})));
    wrong["selection"]["blueprint_ref"]["sha256"] = nb["sha256"].clone();
    assert_eq!(
        agent(&hub, &g, "bundles.preview", wrong)["error"]["code"],
        "forbidden"
    );
    let preview = ok(agent(&hub, &g, "bundles.preview", req))["preview"].clone();
    let exported = execute(
        &k,
        &hub,
        &g,
        "bundles.export",
        json!({"preview":preview,"acknowledgement":"仅供审阅。","operation_key":"bundle-export"}),
        "bundle",
    );
    let file = std::fs::File::open(
        root.path()
            .join("作品")
            .join(exported["path"].as_str().unwrap()),
    )
    .unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    let mut manifest = String::new();
    use std::io::Read;
    archive
        .by_name("manifest.json")
        .unwrap()
        .read_to_string(&mut manifest)
        .unwrap();
    let manifest: Value = serde_json::from_str(&manifest).unwrap();
    assert_eq!(manifest["work_ref"], drama);
    assert_eq!(manifest["title"], "独立剧本");
    let verified = ok(agent(
        &hub,
        &g,
        "bundles.verify",
        json!({"work_ref":drama,"bundle_id":exported["bundle_id"]}),
    ));
    assert_eq!(verified["verified"], true);
    let legacy_preview = ok(call(&k, "bundles.preview", legacy_request))["preview"].clone();
    let legacy = ok(call(
        &k,
        "bundles.export",
        json!({"preview":legacy_preview,"acknowledgement":"旧合同审阅包。","operation_key":"legacy-bundle"}),
    ));
    assert_eq!(
        agent(
            &hub,
            &g,
            "bundles.verify",
            json!({"work_ref":drama,"bundle_id":legacy["bundle_id"]})
        )["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        ok(call(
            &k,
            "bundles.verify",
            json!({"bundle_id":legacy["bundle_id"]})
        ))["verified"],
        true
    );
    let (nh, ng) = grant(&k, root.path(), &novel);
    assert_eq!(
        agent(
            &nh,
            &ng,
            "bundles.verify",
            json!({"work_ref":novel,"bundle_id":exported["bundle_id"]})
        )["error"]["code"],
        "forbidden"
    );
    ok(call(
        &k,
        "collaboration.revoke_management",
        json!({"client_adapter":"codex","collaboration_path":root.path().join("授权"),"grant_id":g["grant_id"],"operation_key":"revoke"}),
    ));
    assert_ne!(
        agent(
            &hub,
            &g,
            "documents.preview_export",
            json!({"work_ref":drama,"revision_refs":[doc_ref(&d)],"format":"fountain","profile":"source/1"})
        )["status"],
        "succeeded"
    );
}
