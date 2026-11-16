use hetu_core::{Kernel, application::extensions::PluginSession};
use serde_json::{Value, json};

fn call(session: &PluginSession, action: &str, input: Value) -> Value {
    session.request(
        json!({"action":format!("hetu.extensions.{action}"),"contract_revision":"1","input":input}),
    )
}
fn ok(result: Value) -> Value {
    assert_eq!(result["status"], "succeeded", "{result}");
    result["data"].clone()
}
fn grant(kernel: &Kernel, dir: &std::path::Path, work: &Value, version: &str, key: &str) -> Value {
    ok(kernel.extension_host_request_in(dir, json!({"method":"authorize","params":{"work_ref":work,"plugin_id":"org.test.relationships","package_sha256":if version=="1" {"a".repeat(64)} else {"b".repeat(64)},"permissions":["objects.read","objects.write"],"types":[{"kind":"relationships","schema_version":version,"schema":{"type":"object","additionalProperties":false,"required":[if version=="1" {"names"} else {"characters"}],"properties":{if version=="1" {"names"} else {"characters"}:{"type":"array","items":{"type":"string"}}}}}],"operation_key":key}})))
}

#[test]
fn fixed_migration_requires_author_decision_and_survives_headless_retry() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("作品");
    let access = root.path().join("private");
    let kernel = Kernel::open(json!({"workspace_path":workspace,"mode":"author","create":{"title":"迁移样本","locale":"zh-CN","operation_key":"fixture"}})).unwrap();
    let work =
        ok(kernel.request(json!({"action":"hetu.works.list","contract_revision":"1","input":{}})))
            ["works"][0]["work_ref"]
            .clone();
    let first_grant = grant(&kernel, &access, &work, "1", "old-package");
    let old = PluginSession::open(
        &workspace,
        &access,
        first_grant["grant_id"].as_str().unwrap(),
        &"a".repeat(64),
    )
    .unwrap();
    let before = ok(call(
        &old,
        "objects.save",
        json!({"work_ref":work,"kind":"relationships","title":"雾港人物🌿","schema_version":"1","content":{"names":["江岚","叶渡"]},"expected_revision":0,"expected_sha256":"","operation_key":"create"}),
    ));
    let new_grant = grant(&kernel, &access, &work, "2", "new-package");
    let open = || {
        PluginSession::open(
            &workspace,
            &access,
            new_grant["grant_id"].as_str().unwrap(),
            &"b".repeat(64),
        )
        .unwrap()
    };
    let session = open();
    let write_only_grant = ok(kernel.extension_host_request_in(&access, json!({"method":"authorize","params":{"work_ref":work,"plugin_id":"org.test.relationships","package_sha256":"b".repeat(64),"permissions":["objects.write"],"types":new_grant["types"],"operation_key":"write-only"}})));
    let write_only = PluginSession::open(
        &workspace,
        &access,
        write_only_grant["grant_id"].as_str().unwrap(),
        &"b".repeat(64),
    )
    .unwrap();
    assert!(
        !write_only.inspect()["data"]["actions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["name"] == "hetu.extensions.migrations.prepare")
    );
    let id = before["object"]["object_id"].clone();
    ok(call(&session, "index.rebuild", json!({"work_ref":work})));
    assert_eq!(
        ok(call(&session, "index.status", json!({"work_ref":work})))["state"],
        "ready"
    );
    let get = json!({"work_ref":work,"object_id":id});
    assert_eq!(ok(call(&session, "objects.get", get.clone())), before);
    let normal = json!({"work_ref":work,"object_id":id,"kind":"relationships","title":"雾港人物🌿","schema_version":"2","content":{"characters":["江岚","叶渡"]},"expected_revision":1,"expected_sha256":before["sha256"],"operation_key":"implicit-migration"});
    assert_eq!(
        call(&session, "objects.save", normal)["error"]["code"],
        "unsupported_version"
    );
    let input = json!({"work_ref":work,"object_id":id,"target_schema_version":"2","content":{"characters":["江岚","叶渡"]},"expected_revision":1,"expected_sha256":before["sha256"],"operation_key":"migration-main"});
    let prepared = call(&session, "migrations.prepare", input.clone());
    let mut too_large = input.clone();
    too_large["content"] = json!({"characters":["字".repeat(90000)]});
    too_large["operation_key"] = json!("too-large");
    assert_eq!(
        call(&session, "migrations.prepare", too_large)["error"]["code"],
        "hetu.budget_exceeded"
    );
    assert_eq!(
        call(&write_only, "migrations.prepare", input.clone())["error"]["code"],
        "forbidden"
    );
    let plan = ok(prepared.clone());
    assert_eq!(
        prepared["operation"]["recover_action"],
        "hetu.extensions.operations.get"
    );
    assert_eq!(plan["plan"]["before"], before);
    let listed = ok(call(
        &session,
        "migrations.list",
        json!({"work_ref":work,"limit":1}),
    ));
    assert_eq!(
        listed["migrations"][0]["migration_id"],
        plan["plan"]["migration_id"]
    );
    assert_eq!(listed["next_cursor"], Value::Null);
    assert_eq!(
        ok(call(
            &session,
            "migrations.get",
            json!({"work_ref":work,"migration_id":plan["plan"]["migration_id"]})
        ))["plan"],
        plan["plan"]
    );
    let query = ok(call(
        &session,
        "migrations.get",
        json!({"work_ref":work,"migration_id":plan["plan"]["migration_id"]}),
    ));
    assert!(query["result"]["data"].get("plan").is_none());
    assert_eq!(ok(call(&session, "objects.get", get.clone())), before);
    assert_eq!(call(&open(), "migrations.prepare", input.clone()), prepared);
    let mut changed = input.clone();
    changed["content"] = json!({"characters":[]});
    assert_eq!(
        call(&session, "migrations.prepare", changed)["error"]["code"],
        "idempotency_conflict"
    );
    let execution = json!({"work_ref":work,"migration_id":plan["plan"]["migration_id"],"plan_sha256":plan["plan_sha256"],"operation_key":"migration-main"});
    assert_eq!(
        call(&session, "migrations.execute", execution.clone())["error"]["code"],
        "permission_denied"
    );
    let mut forged = execution.clone();
    forged["approved"] = json!(true);
    assert_ne!(
        call(&session, "migrations.execute", forged)["status"],
        "succeeded"
    );
    let approval = json!({"grant_id":new_grant["grant_id"],"package_sha256":"b".repeat(64),"migration_id":plan["plan"]["migration_id"],"plan_sha256":plan["plan_sha256"]});
    let mut changed_types = new_grant["types"].clone();
    changed_types[0]["schema"]["properties"]["characters"]["minItems"] = json!(1);
    let different_schema = ok(kernel.extension_host_request_in(&access, json!({"method":"authorize","params":{"work_ref":work,"plugin_id":"org.test.relationships","package_sha256":"b".repeat(64),"permissions":["objects.read","objects.write"],"types":changed_types,"operation_key":"changed-schema"}})));
    let mut changed_schema_approval = approval.clone();
    changed_schema_approval["grant_id"] = different_schema["grant_id"].clone();
    assert_eq!(
        kernel.extension_host_request_in(
            &access,
            json!({"method":"approve_migration","params":changed_schema_approval})
        )["error"]["code"],
        "hetu.stale_evidence"
    );
    let other_type = ok(kernel.extension_host_request_in(&access, json!({"method":"authorize","params":{"work_ref":work,"plugin_id":"org.test.relationships","package_sha256":"b".repeat(64),"permissions":["objects.read","objects.write"],"types":[{"kind":"other","schema_version":"2","schema":{"type":"object"}}],"operation_key":"other-type"}})));
    let other_session = PluginSession::open(
        &workspace,
        &access,
        other_type["grant_id"].as_str().unwrap(),
        &"b".repeat(64),
    )
    .unwrap();
    assert_eq!(
        call(&other_session, "migrations.prepare", input.clone())["error"]["code"],
        "forbidden"
    );
    assert_eq!(
        call(
            &other_session,
            "migrations.get",
            json!({"work_ref":work,"migration_id":plan["plan"]["migration_id"]})
        )["error"]["code"],
        "forbidden"
    );
    let mut wrong = approval.clone();
    wrong["plan_sha256"] = json!("c".repeat(64));
    assert_eq!(
        kernel.extension_host_request_in(
            &access,
            json!({"method":"approve_migration","params":wrong})
        )["error"]["code"],
        "hetu.stale_evidence"
    );
    let decision = ok(kernel.extension_host_request_in(
        &access,
        json!({"method":"approve_migration","params":approval}),
    ));
    assert_eq!(decision["executed"], false);
    assert_eq!(ok(call(&session, "objects.get", get.clone())), before);
    let executed = call(&open(), "migrations.execute", execution.clone());
    let after = ok(executed.clone());
    assert_eq!(after["object"]["revision"], 2);
    assert_eq!(after["object"]["schema_version"], "2");
    assert_eq!(
        ok(call(&session, "index.status", json!({"work_ref":work})))["state"],
        "stale"
    );
    let search = ok(call(
        &session,
        "objects.search",
        json!({"work_ref":work,"query":"雾港人物"}),
    ));
    assert_eq!(search["objects"][0]["schema_version"], "2");
    assert_eq!(
        after["object"]["source_refs"],
        before["object"]["source_refs"]
    );
    assert_eq!(
        call(&open(), "migrations.execute", execution.clone()),
        executed
    );
    assert_eq!(call(&open(), "migrations.prepare", input), executed);
    assert_eq!(
        call(
            &open(),
            "operations.get",
            json!({"work_ref":work,"operation_key":"migration-main"})
        ),
        executed
    );
    let history = ok(call(
        &session,
        "objects.get",
        json!({"work_ref":work,"object_id":id,"revision":1}),
    ));
    assert_eq!(history, before);
    let old_save = json!({"work_ref":work,"object_id":id,"kind":"relationships","title":"旧包写入","schema_version":"1","content":{"names":[]},"expected_revision":2,"expected_sha256":after["sha256"],"operation_key":"old-write"});
    assert_eq!(
        call(&old, "objects.save", old_save)["error"]["code"],
        "unsupported_version"
    );
    ok(kernel.extension_host_request_in(
        &access,
        json!({"method":"revoke","params":{"grant_id":new_grant["grant_id"]}}),
    ));
    assert_eq!(
        call(&session, "migrations.execute", execution)["error"]["code"],
        "forbidden"
    );
    let fallback = ok(kernel.extension_host_request_in(&access,json!({"method":"read","params":{"work_ref":work,"plugin_id":"org.test.relationships","request":{"action":"hetu.extensions.objects.export","contract_revision":"1","input":{"work_ref":work,"object_id":id,"format":"json"}}}})));
    assert_eq!(fallback["object"]["schema_version"], "2");
}

#[test]
fn migration_rejects_stale_objects_foreign_work_and_reauthorized_decisions() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("作品");
    let access = root.path().join("private");
    let kernel = Kernel::open(json!({"workspace_path":workspace,"mode":"author","create":{"title":"冲突样本","locale":"zh-CN","operation_key":"fixture"}})).unwrap();
    let work =
        ok(kernel.request(json!({"action":"hetu.works.list","contract_revision":"1","input":{}})))
            ["works"][0]["work_ref"]
            .clone();
    let g1 = grant(&kernel, &access, &work, "1", "old");
    let old = PluginSession::open(
        &workspace,
        &access,
        g1["grant_id"].as_str().unwrap(),
        &"a".repeat(64),
    )
    .unwrap();
    let before = ok(call(
        &old,
        "objects.save",
        json!({"work_ref":work,"kind":"relationships","title":"人物","schema_version":"1","content":{"names":["江岚"]},"expected_revision":0,"expected_sha256":"","operation_key":"create"}),
    ));
    let g2 = grant(&kernel, &access, &work, "2", "new");
    let open = |g: &Value| {
        PluginSession::open(
            &workspace,
            &access,
            g["grant_id"].as_str().unwrap(),
            &"b".repeat(64),
        )
        .unwrap()
    };
    let session = open(&g2);
    let mut input = json!({"work_ref":work,"object_id":before["object"]["object_id"],"target_schema_version":"2","content":{"characters":["江岚"]},"expected_revision":1,"expected_sha256":before["sha256"],"operation_key":"upgrade"});
    let mut invalid = input.clone();
    invalid["content"] = json!({"names":[]});
    assert_ne!(
        call(&session, "migrations.prepare", invalid)["status"],
        "succeeded"
    );
    let mut foreign = input.clone();
    foreign["work_ref"]["object_id"] = json!("novel_11111111-1111-4111-8111-111111111111");
    assert_eq!(
        call(&session, "migrations.prepare", foreign)["error"]["code"],
        "forbidden"
    );
    let plan = ok(call(&session, "migrations.prepare", input.clone()));
    let approval = json!({"grant_id":g2["grant_id"],"package_sha256":"b".repeat(64),"migration_id":plan["plan"]["migration_id"],"plan_sha256":plan["plan_sha256"]});
    ok(kernel.extension_host_request_in(
        &access,
        json!({"method":"approve_migration","params":approval.clone()}),
    ));
    let execution = json!({"work_ref":work,"migration_id":plan["plan"]["migration_id"],"plan_sha256":plan["plan_sha256"],"operation_key":"upgrade"});
    let newer = ok(call(
        &old,
        "objects.save",
        json!({"work_ref":work,"object_id":before["object"]["object_id"],"kind":"relationships","title":"新意见","schema_version":"1","content":{"names":["江岚","叶渡"]},"expected_revision":1,"expected_sha256":before["sha256"],"operation_key":"edit"}),
    ));
    assert_eq!(
        call(&session, "migrations.execute", execution)["error"]["code"],
        "revision_conflict"
    );
    assert_eq!(
        kernel.extension_host_request_in(
            &access,
            json!({"method":"approve_migration","params":approval})
        )["error"]["code"],
        "revision_conflict"
    );
    input["expected_revision"] = json!(2);
    input["expected_sha256"] = newer["sha256"].clone();
    input["operation_key"] = json!("upgrade-2");
    let plan = ok(call(&session, "migrations.prepare", input));
    ok(kernel.extension_host_request_in(&access,json!({"method":"approve_migration","params":{"grant_id":g2["grant_id"],"package_sha256":"b".repeat(64),"migration_id":plan["plan"]["migration_id"],"plan_sha256":plan["plan_sha256"]}})));
    ok(kernel.extension_host_request_in(
        &access,
        json!({"method":"revoke","params":{"grant_id":g2["grant_id"]}}),
    ));
    let g3 = grant(&kernel, &access, &work, "2", "reauthorize");
    let execution = json!({"work_ref":work,"migration_id":plan["plan"]["migration_id"],"plan_sha256":plan["plan_sha256"],"operation_key":"upgrade-2"});
    assert_eq!(
        call(&open(&g3), "migrations.execute", execution)["error"]["code"],
        "permission_denied"
    );
}
