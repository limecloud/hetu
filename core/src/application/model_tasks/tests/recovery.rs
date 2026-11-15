use super::*;

#[test]
fn recharge_resumes_one_unbilled_failure_under_original_authorization() {
    let f = conversation_fixture();
    let first = prepare(&f, "text");
    let authorization = usage(&f, &first, "first-budget", 1);
    let service = ModelService::open(f.connection.path()).unwrap();
    let failed = f.agent.execute_model_remote_with(
        "hetu.model_tasks.submit",
        &input(&f, &first),
        &service,
        |_, _, _, _| {
            let mut result = remote(&first, Value::Null);
            result["operation"]["status"] = json!("failed");
            result["operation"]["error_code"] = json!("MODELS_CREDITS_INSUFFICIENT");
            result["operation"]["billing"] = json!({"state":"released"});
            Ok(result)
        },
        |_, _| panic!(),
    );
    assert_eq!(failed.unwrap_err().code, "hetu.credits_insufficient");
    let saved = f
        .agent
        .model_plan(
            &f.task["task_ref"],
            first["plan"]["plan_id"].as_str().unwrap(),
        )
        .unwrap();
    assert_eq!(saved["approval"]["reservation_released"], true);
    assert_eq!(
        f.agent.model_authorization_status(&saved).unwrap()["requests_reserved"],
        0
    );
    for _ in 0..2 {
        let recovered = ok(f
            .agent
            .execute_model_remote_with(
                "hetu.model_tasks.get",
                &input(&f, &first),
                &service,
                |method, _, _, _| {
                    assert_eq!(method, "GET");
                    let mut failure = remote(&first, Value::Null);
                    failure["operation"]["status"] = json!("failed");
                    failure["operation"]["error_code"] = json!("MODELS_CREDITS_INSUFFICIENT");
                    failure["operation"]["billing"] = json!({"state":"released"});
                    Ok(failure)
                },
                |_, _| panic!(),
            )
            .unwrap());
        assert_eq!(
            recovered["authorization"]["requests_reserved"], 0,
            "重复查询不能重复释放预留"
        );
        assert_eq!(recovered["recovery"]["resume_allowed"], true);
    }
    let retry_input = resume_input(&f, &first, "after-recharge");
    let retry = ok(call(&f.agent, "model_tasks.prepare", retry_input.clone()));
    assert_eq!(
        retry,
        ok(call(&f.agent, "model_tasks.prepare", retry_input))
    );
    assert_eq!(retry["plan"]["resumes_plan_id"], first["plan"]["plan_id"]);
    assert_eq!(
        call(
            &f.agent,
            "model_tasks.prepare",
            resume_input(&f, &first, "duplicate-resume")
        )["error"]["code"],
        "hetu.model_retry_exists"
    );
    let posts = Cell::new(0);
    let result = ok(f
        .agent
        .execute_model_remote_with(
            "hetu.model_tasks.submit",
            &input(&f, &retry),
            &service,
            |method, _, _, _| {
                assert_eq!(method, "POST");
                posts.set(posts.get() + 1);
                Ok(remote(&retry, json!({"text":"充值后生成的原任务结果"})))
            },
            |_, _| panic!(),
        )
        .unwrap());
    assert_eq!(posts.get(), 1);
    assert_eq!(
        result["authorization"]["authorization_id"],
        authorization["authorization"]["authorization_id"]
    );
    assert_eq!(result["authorization"]["requests_reserved"], 1);
    assert_eq!(result["authorization"]["credits_reserved"], "12");
    assert_eq!(
        result["approval"]["confirmation_channel"],
        "agent_conversation"
    );
}

#[test]
fn rejected_before_remote_creation_recovers_without_a_remote_operation() {
    let f = conversation_fixture();
    let record = prepare(&f, "text");
    usage(&f, &record, "one-request", 1);
    let service = ModelService::open(f.connection.path()).unwrap();
    assert_eq!(
        f.agent
            .execute_model_remote_with(
                "hetu.model_tasks.submit",
                &input(&f, &record),
                &service,
                |_, _, _, _| Err(Error::new(
                    "hetu.credits_insufficient",
                    "建单前余额检查失败"
                )),
                |_, _| panic!(),
            )
            .unwrap_err()
            .code,
        "hetu.credits_insufficient"
    );
    for action in ["get", "get", "submit", "collect"] {
        let result = f.agent.execute_model_remote_with(
            &format!("hetu.model_tasks.{action}"),
            &input(&f, &record),
            &service,
            |_, _, _, _| panic!("明确的本地未扣费回执不依赖远端存在操作"),
            |_, _| panic!(),
        );
        if action == "get" {
            let visible = ok(result.unwrap());
            assert_eq!(visible["recovery"]["resume_allowed"], true);
            assert_eq!(visible["authorization"]["requests_reserved"], 0);
        } else {
            assert_eq!(result.unwrap_err().code, "hetu.credits_insufficient");
        }
    }
    let retry = ok(call(
        &f.agent,
        "model_tasks.prepare",
        resume_input(&f, &record, "after-payment"),
    ));
    assert_eq!(retry["plan"]["resumes_plan_id"], record["plan"]["plan_id"]);
}

#[test]
fn non_recharge_failures_cannot_create_retries_or_release_budget() {
    for (code, billing) in [
        ("MODELS_CREDITS_INSUFFICIENT", "charged"),
        ("MODELS_CREDITS_INSUFFICIENT", "reserved"),
        ("UNRECOGNIZED_FAILURE", "released"),
    ] {
        let f = conversation_fixture();
        let record = prepare(&f, "text");
        usage(&f, &record, "original-budget", 1);
        let service = ModelService::open(f.connection.path()).unwrap();
        let failure = || {
            let mut result = remote(&record, Value::Null);
            result["operation"]["status"] = json!("failed");
            result["operation"]["error_code"] = json!(code);
            result["operation"]["billing"] = json!({"state":billing});
            result
        };
        assert!(
            f.agent
                .execute_model_remote_with(
                    "hetu.model_tasks.submit",
                    &input(&f, &record),
                    &service,
                    |_, _, _, _| Ok(failure()),
                    |_, _| panic!(),
                )
                .is_err()
        );
        let visible = ok(f
            .agent
            .execute_model_remote_with(
                "hetu.model_tasks.get",
                &input(&f, &record),
                &service,
                |method, _, _, _| {
                    assert_eq!(method, "GET");
                    Ok(failure())
                },
                |_, _| panic!(),
            )
            .unwrap());
        assert_eq!(visible["recovery"]["resume_allowed"], false);
        assert!(visible["recovery"]["next_action"].is_null());
        assert_eq!(visible["authorization"]["requests_reserved"], 1);
        assert_eq!(visible["authorization"]["credits_reserved"], "12");
        assert_eq!(
            call(
                &f.agent,
                "model_tasks.prepare",
                resume_input(&f, &record, "unsafe-retry")
            )["error"]["code"],
            "hetu.model_outcome_unknown"
        );
    }
}

#[test]
fn recharge_not_yet_available_keeps_original_budget_and_unique_retry_chain() {
    let f = conversation_fixture();
    let mut record = prepare(&f, "text");
    let original_authorization = usage(&f, &record, "one-request-budget", 1);
    let service = ModelService::open(f.connection.path()).unwrap();
    for attempt in 0..2 {
        assert_eq!(
            f.agent
                .execute_model_remote_with(
                    "hetu.model_tasks.submit",
                    &input(&f, &record),
                    &service,
                    |_, _, _, _| Err(Error::new("hetu.credits_insufficient", "充值未到账")),
                    |_, _| panic!()
                )
                .unwrap_err()
                .code,
            "hetu.credits_insufficient"
        );
        let budget = f.agent.model_authorization_status(&record).unwrap();
        assert_eq!(
            budget["authorization_id"],
            original_authorization["authorization"]["authorization_id"]
        );
        assert_eq!(budget["requests_reserved"], 0);
        assert_eq!(budget["credits_reserved"], "0");
        record = ok(call(
            &f.agent,
            "model_tasks.prepare",
            resume_input(&f, &record, &format!("recharge-confirmed-{attempt}")),
        ));
    }
    let completed = ok(f
        .agent
        .execute_model_remote_with(
            "hetu.model_tasks.submit",
            &input(&f, &record),
            &service,
            |_, _, _, _| Ok(remote(&record, json!({"text":"到账后继续原授权任务"}))),
            |_, _| panic!(),
        )
        .unwrap());
    assert_eq!(completed["authorization"]["requests_reserved"], 1);
    assert_eq!(completed["authorization"]["credits_reserved"], "12");
}

#[test]
fn recharge_does_not_retry_an_unknown_request_or_reset_its_reservation() {
    let f = conversation_fixture();
    let first = prepare(&f, "text");
    usage(&f, &first, "budget", 1);
    let service = ModelService::open(f.connection.path()).unwrap();
    assert!(
        f.agent
            .execute_model_remote_with(
                "hetu.model_tasks.submit",
                &input(&f, &first),
                &service,
                |_, _, _, _| Err(Error::new("hetu.model_outcome_unknown", "响应丢失")),
                |_, _| panic!()
            )
            .is_err()
    );
    assert_eq!(
        call(
            &f.agent,
            "model_tasks.prepare",
            resume_input(&f, &first, "unsafe-recharge-retry")
        )["error"]["code"],
        "hetu.model_outcome_unknown"
    );
    let recovered = ok(f
        .agent
        .execute_model_remote_with(
            "hetu.model_tasks.submit",
            &input(&f, &first),
            &service,
            |method, _, _, _| {
                assert_eq!(method, "GET", "充值不得把未知请求重新发出");
                Ok(remote(&first, json!({"text":"原请求的迟到结果"})))
            },
            |_, _| panic!(),
        )
        .unwrap());
    assert_eq!(recovered["authorization"]["requests_reserved"], 1);
    assert_eq!(recovered["authorization"]["credits_reserved"], "12");
}
