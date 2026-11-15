use super::*;

#[test]
fn task_authorization_continues_within_limits_and_reserves_once() {
    for mode in ["requests", "credits", "unrestricted"] {
        let mut f = fixture("chapter_draft");
        let directory = f.connection.path().join("collaboration");
        let grant = ok(call(
            &f.author,
            "collaboration.authorize",
            json!({"task_ref":f.task["task_ref"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"grant"}),
        ));
        f.agent.collaboration_grant = Some(
            json!({"directory":directory,"client_adapter":"codex","task_locator":grant["task_locator"],"grant_revision":grant["grant_revision"]}),
        );
        let first = prepare(&f, "text");
        let mut limits = json!({"operation_key":"conversation-budget","channels":"current"});
        match mode {
            "requests" => limits["max_requests"] = json!(2),
            "credits" => limits["max_credits"] = json!("24"),
            _ => limits["unrestricted"] = json!(true),
        }
        let proposal = f
            .agent
            .prepare_task_model_authorization(&first, limits)
            .unwrap();
        let confirmed = f
            .agent
            .confirm_task_model_authorization(&first, &proposal, "codex")
            .unwrap();
        assert!(confirmed["approval"].is_null());
        let service = ModelService::open(f.connection.path()).unwrap();
        let posts = Cell::new(0);
        for i in 0..3 {
            let record = if i == 0 {
                first.clone()
            } else {
                ok(call(
                    &f.agent,
                    "model_tasks.prepare",
                    json!({"task_ref":f.task["task_ref"],"kind":"text","artifact_kind":"text","model_id":"text-one","prompt":format!("第{i}个计划，不需要再次确认。"),"title":"连续生成","billing_policy_version":"p1","estimated_credits":"12","operation_key":format!("plan-{i}")}),
                ))
            };
            let api = |method: &str, _: &str, _: Option<&Value>, _: &Value| {
                if method == "POST" {
                    posts.set(posts.get() + 1);
                }
                Ok(remote(&record, json!({"text":"参考结果"})))
            };
            let result = f.agent.execute_model_remote_with(
                "hetu.model_tasks.submit",
                &input(&f, &record),
                &service,
                api,
                |_, _| panic!(),
            );
            if i == 2 && mode != "unrestricted" {
                assert_eq!(
                    result.unwrap_err().code,
                    "hetu.model_authorization_exhausted"
                );
                assert_eq!(posts.get(), 2);
                assert_eq!(
                    f.agent
                        .model_plan(
                            &f.task["task_ref"],
                            record["plan"]["plan_id"].as_str().unwrap()
                        )
                        .unwrap()["submitted"],
                    false
                );
            } else {
                let submitted = ok(result.unwrap());
                assert_eq!(submitted["authorization"]["requests_reserved"], i + 1);
                ok(f.agent
                    .execute_model_remote_with(
                        "hetu.model_tasks.submit",
                        &input(&f, &record),
                        &service,
                        api,
                        |_, _| panic!(),
                    )
                    .unwrap());
                assert_eq!(posts.get(), i + 1, "重放不得重新发送或消费授权额度");
            }
        }
        let replay = f
            .agent
            .confirm_task_model_authorization(&first, &proposal, "codex")
            .unwrap();
        assert_eq!(
            replay["authorization"]["requests_reserved"],
            posts.get(),
            "同一确认键重放不得重置额度"
        );
    }
}

#[test]
fn additional_authorization_resumes_the_original_unsubmitted_plan() {
    let f = conversation_fixture();
    let first = prepare(&f, "text");
    usage(&f, &first, "budget-1", 1);
    let service = ModelService::open(f.connection.path()).unwrap();
    ok(f.agent
        .execute_model_remote_with(
            "hetu.model_tasks.submit",
            &input(&f, &first),
            &service,
            |_, _, _, _| Ok(remote(&first, json!({"text":"第一张"}))),
            |_, _| panic!(),
        )
        .unwrap());
    let mut next_input = resume_input(&f, &first, "second-plan");
    next_input
        .as_object_mut()
        .unwrap()
        .remove("resume_from_plan_id");
    let second = ok(call(&f.agent, "model_tasks.prepare", next_input));
    assert_eq!(
        f.agent
            .execute_model_remote_with(
                "hetu.model_tasks.submit",
                &input(&f, &second),
                &service,
                |_, _, _, _| panic!("超额不得联网"),
                |_, _| panic!()
            )
            .unwrap_err()
            .code,
        "hetu.model_authorization_exhausted"
    );
    usage(&f, &second, "budget-2", 1);
    let resumed = ok(f
        .agent
        .execute_model_remote_with(
            "hetu.model_tasks.submit",
            &input(&f, &second),
            &service,
            |method, _, _, _| {
                assert_eq!(method, "POST");
                Ok(remote(&second, json!({"text":"追加额度后的原计划"})))
            },
            |_, _| panic!(),
        )
        .unwrap());
    assert_eq!(resumed["plan"]["plan_id"], second["plan"]["plan_id"]);
    assert_eq!(resumed["authorization"]["requests_reserved"], 1);
}

#[test]
fn concurrent_plans_cannot_overspend_one_authorized_request() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let f = conversation_fixture();
    let first = prepare(&f, "text");
    usage(&f, &first, "one-request", 1);
    let mut next = resume_input(&f, &first, "parallel-plan");
    next.as_object_mut().unwrap().remove("resume_from_plan_id");
    let second = ok(call(&f.agent, "model_tasks.prepare", next));
    let posts = AtomicUsize::new(0);
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        let handles: Vec<_> = [&first, &second]
            .into_iter()
            .map(|record| {
                let f = &f;
                let posts = &posts;
                let barrier = &barrier;
                scope.spawn(move || {
                    let service = ModelService::open(f.connection.path()).unwrap();
                    barrier.wait();
                    f.agent.execute_model_remote_with(
                        "hetu.model_tasks.submit",
                        &input(f, record),
                        &service,
                        |method, _, _, _| {
                            assert_eq!(method, "POST");
                            posts.fetch_add(1, Ordering::SeqCst);
                            Ok(remote(record, json!({"text":"唯一授权请求的结果"})))
                        },
                        |_, _| panic!(),
                    )
                })
            })
            .collect();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert!(matches!(
            results
                .iter()
                .filter_map(|r| r.as_ref().err())
                .next()
                .unwrap()
                .code,
            "hetu.model_authorization_exhausted" | "hetu.workspace_busy"
        ));
    });
    assert_eq!(posts.load(Ordering::SeqCst), 1);
    let unsubmitted = [&first, &second]
        .into_iter()
        .find(|record| {
            f.agent
                .model_plan(
                    &f.task["task_ref"],
                    record["plan"]["plan_id"].as_str().unwrap(),
                )
                .unwrap()["submitted"]
                == false
        })
        .unwrap();
    let service = ModelService::open(f.connection.path()).unwrap();
    assert_eq!(
        f.agent
            .execute_model_remote_with(
                "hetu.model_tasks.submit",
                &input(&f, unsubmitted),
                &service,
                |_, _, _, _| panic!("并发结束后额度已用尽，不能联网"),
                |_, _| panic!()
            )
            .unwrap_err()
            .code,
        "hetu.model_authorization_exhausted"
    );
}
