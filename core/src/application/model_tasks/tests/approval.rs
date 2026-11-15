use super::*;

#[test]
fn author_approval_is_required_and_bound_to_exact_plan() {
    let f = fixture("chapter_draft");
    let r = prepare(&f, "text");
    let service = ModelService::open(f.connection.path()).unwrap();
    let result = f.agent.execute_model_remote_with(
        "hetu.model_tasks.submit",
        &input(&f, &r),
        &service,
        |_, _, _, _| panic!("未批准不得联网"),
        |_, _| panic!(),
    );
    assert_eq!(
        result.unwrap_err().code,
        "hetu.author_confirmation_required"
    );
    let approval = json!({"task_ref":f.task["task_ref"],"plan_id":r["plan"]["plan_id"],"plan_sha256":r["plan_sha256"],"max_credits":"12","operation_key":"forged-author"});
    assert_eq!(
        call(&f.agent, "model_tasks.approve", approval.clone())["error"]["code"],
        "forbidden"
    );
    let mut stale = approval.clone();
    stale["plan_sha256"] = json!("b".repeat(64));
    assert_eq!(
        call(&f.author, "model_tasks.approve", stale)["error"]["code"],
        "revision_conflict"
    );
    let mut small = approval;
    small["max_credits"] = json!("11");
    assert_eq!(
        call(&f.author, "model_tasks.approve", small)["error"]["code"],
        "hetu.budget_exceeded"
    );
    approve(&f, &r);
    assert!(
        !serde_json::to_string(&r)
            .unwrap()
            .contains("private-test-token")
    );
}

#[test]
fn host_confirmation_rechecks_changes_while_waiting_for_user() {
    for change in ["revoked", "renewed", "closed", "channel", "plan"] {
        let mut f = fixture("chapter_draft");
        let directory = f.connection.path().join("collaboration");
        let grant_input = json!({"task_ref":f.task["task_ref"],"client_adapter":"codex","collaboration_path":directory,"operation_key":"grant"});
        let grant = ok(call(
            &f.author,
            "collaboration.authorize",
            grant_input.clone(),
        ));
        f.agent.collaboration_grant = Some(
            json!({"directory":directory,"client_adapter":"codex","task_locator":grant["task_locator"],"grant_revision":grant["grant_revision"]}),
        );
        let record = prepare(&f, "text");
        match change {
            "revoked" | "renewed" => {
                let mut input = grant_input;
                input["operation_key"] = json!("changed-grant");
                ok(call(
                    &f.author,
                    if change == "revoked" {
                        "collaboration.revoke"
                    } else {
                        "collaboration.authorize"
                    },
                    input,
                ));
            }
            "closed" => {
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
            }
            "channel" => {
                let service = ModelService::open(f.connection.path()).unwrap();
                let channel = service.author_request("custom_save", &json!({"name":"另一个渠道","base_url":"https://other.test","api_key":"fixture-key","models":{"text":["text-one"],"image":[]}})).unwrap();
                service
                    .author_request(
                        "channel_select",
                        &json!({"kind":"text","channel_id":channel["channel_id"]}),
                    )
                    .unwrap();
            }
            "plan" => {
                let mut changed = record.clone();
                changed["plan"]["payload"]["input"] = json!("等待期间改变输入");
                changed["plan_sha256"] = json!(plan_digest(&changed["plan"]).unwrap());
                std::fs::write(
                    f.root.path().join(
                        path(
                            &f.task["task_ref"],
                            record["plan"]["plan_id"].as_str().unwrap(),
                        )
                        .unwrap(),
                    ),
                    bytes(&changed).unwrap(),
                )
                .unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            f.agent
                .confirm_model_plan_from_host(&record, "codex")
                .is_err(),
            "{change}"
        );
        let saved = f
            .author
            .store
            .json(
                &path(
                    &f.task["task_ref"],
                    record["plan"]["plan_id"].as_str().unwrap(),
                )
                .unwrap(),
            )
            .unwrap();
        assert!(saved["approval"].is_null(), "{change}");
        assert_eq!(saved["submitted"], false, "{change}");
    }
}
