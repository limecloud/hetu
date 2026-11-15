use super::*;

#[test]
fn late_failure_from_disconnected_account_cannot_release_authorization() {
    let f = conversation_fixture();
    let record = prepare(&f, "text");
    usage(&f, &record, "original-account", 1);
    let service = ModelService::open(f.connection.path()).unwrap();
    let result = f.agent.execute_model_remote_with(
        "hetu.model_tasks.submit",
        &input(&f, &record),
        &service,
        |_, _, _, _| {
            service.author_request("disconnect", &json!({})).unwrap();
            let mut failure = remote(&record, Value::Null);
            failure["operation"]["status"] = json!("failed");
            failure["operation"]["error_code"] = json!("MODELS_CREDITS_INSUFFICIENT");
            failure["operation"]["billing"] = json!({"state":"released"});
            Ok(failure)
        },
        |_, _| panic!(),
    );
    assert!(result.is_err());
    let saved = f
        .agent
        .model_plan(
            &f.task["task_ref"],
            record["plan"]["plan_id"].as_str().unwrap(),
        )
        .unwrap();
    assert!(saved["result"].is_null());
    assert_eq!(
        f.agent.model_authorization_status(&saved).unwrap()["requests_reserved"],
        1
    );
}

#[test]
fn unknown_submit_recovers_with_get_without_holding_workspace_lock() {
    let f = fixture("chapter_draft");
    let r = prepare(&f, "text");
    approve(&f, &r);
    let service = ModelService::open(f.connection.path()).unwrap();
    let posts = Cell::new(0);
    let reads = Cell::new(0);
    let api = |method: &str, _: &str, _: Option<&Value>, _: &Value| {
        let _available = f.author.store.lock().expect("网络调用不占作品锁");
        if method == "POST" {
            posts.set(posts.get() + 1);
            Err(Error::new("hetu.model_service_unavailable", "响应丢失"))
        } else {
            reads.set(reads.get() + 1);
            Ok(remote(&r, json!({"text":"原结果"})))
        }
    };
    assert!(
        f.agent
            .execute_model_remote_with(
                "hetu.model_tasks.submit",
                &input(&f, &r),
                &service,
                api,
                |_, _| panic!()
            )
            .is_err()
    );
    let mut next = input(&f, &r);
    next["operation_key"] = json!("different-key");
    ok(f.agent
        .execute_model_remote_with(
            "hetu.model_tasks.submit",
            &next,
            &service,
            api,
            |_, _| panic!(),
        )
        .unwrap());
    assert_eq!((posts.get(), reads.get()), (1, 1));
    let result = ok(f
        .agent
        .execute_model_remote_with(
            "hetu.model_tasks.collect",
            &next,
            &service,
            api,
            |_, _| panic!(),
        )
        .unwrap());
    assert_eq!(result["content"], "原结果");
    let repeated = ok(f
        .agent
        .execute_model_remote_with(
            "hetu.model_tasks.collect",
            &next,
            &service,
            |_, _, _, _| panic!("重复收集不联网"),
            |_, _| panic!(),
        )
        .unwrap());
    assert_eq!(result, repeated);
    let file = f.root.path().join(format!(
        ".hetu/tasks/{}/inbox/{}",
        f.task["task_ref"]["task_id"].as_str().unwrap(),
        result["file_name"].as_str().unwrap()
    ));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "原结果");
    std::fs::write(file, "外部改坏的候选").unwrap();
    assert_eq!(
        f.agent
            .execute_model_remote_with(
                "hetu.model_tasks.collect",
                &next,
                &service,
                |_, _, _, _| panic!("坏回执不联网"),
                |_, _| panic!()
            )
            .unwrap_err()
            .code,
        "hetu.integrity_failure"
    );
}

#[test]
fn task_and_account_isolation_and_late_disconnect_reject_results() {
    let f = fixture("chapter_draft");
    let r = prepare(&f, "text");
    approve(&f, &r);
    let service = ModelService::open(f.connection.path()).unwrap();
    let mut wrong = input(&f, &r);
    wrong["task_ref"]["scope_ref"]["id"] = json!("workspace_00000000-0000-4000-8000-000000000000");
    assert!(
        f.agent
            .execute_model_remote_with(
                "hetu.model_tasks.submit",
                &wrong,
                &service,
                |_, _, _, _| panic!(),
                |_, _| panic!()
            )
            .is_err()
    );
    let result = f.agent.execute_model_remote_with(
        "hetu.model_tasks.submit",
        &input(&f, &r),
        &service,
        |_, _, _, _| {
            service.author_request("disconnect", &json!({}))?;
            Ok(remote(&r, json!({"text":"晚到结果"})))
        },
        |_, _| panic!(),
    );
    assert!(result.is_err());
    let current = f
        .author
        .model_plan(&f.task["task_ref"], r["plan"]["plan_id"].as_str().unwrap())
        .unwrap();
    assert!(current["result"].is_null());
}

#[test]
fn closed_tasks_and_tampered_plans_do_not_reach_network() {
    let f = fixture("chapter_draft");
    let r = prepare(&f, "text");
    approve(&f, &r);
    let service = ModelService::open(f.connection.path()).unwrap();
    let current = ok(call(
        &f.author,
        "creative_tasks.get",
        json!({"task_ref":f.task["task_ref"]}),
    ));
    ok(call(
        &f.author,
        "creative_tasks.close",
        json!({"task_ref":f.task["task_ref"],"expected":current["expected"],"reason":"作者关闭","operation_key":"close"}),
    ));
    assert!(
        f.agent
            .execute_model_remote_with(
                "hetu.model_tasks.submit",
                &input(&f, &r),
                &service,
                |_, _, _, _| panic!(),
                |_, _| panic!()
            )
            .is_err()
    );
    let f = fixture("chapter_draft");
    let r = prepare(&f, "text");
    let mut bad = r.clone();
    bad["plan"]["payload"]["input"] = json!("外部改动");
    std::fs::write(
        f.root
            .path()
            .join(path(&f.task["task_ref"], r["plan"]["plan_id"].as_str().unwrap()).unwrap()),
        serde_json::to_vec(&bad).unwrap(),
    )
    .unwrap();
    assert_eq!(
        call(
            &f.author,
            "model_tasks.list",
            json!({"task_ref":f.task["task_ref"]})
        )["error"]["code"],
        "hetu.integrity_failure"
    );
}
