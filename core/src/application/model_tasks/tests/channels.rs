use super::*;

#[test]
fn explicit_channel_does_not_change_global_defaults_or_follow_another_channel() {
    let f = conversation_fixture();
    let mut args = json!({"task_ref":f.task["task_ref"],"channel_id":"cloud","kind":"text","artifact_kind":"text","model_id":"text-one","prompt":"固定Cloud输入","title":"渠道选择","billing_policy_version":"p1","estimated_credits":"12","operation_key":"explicit-cloud"});
    let record = ok(call(&f.agent, "model_tasks.prepare", args.clone()));
    usage(&f, &record, "cloud-budget", 1);
    let service = ModelService::open(f.connection.path()).unwrap();
    let custom = service.author_request("custom_save", &json!({"name":"另一渠道","base_url":"https://other.test","api_key":"fixture-key","models":{"text":["text-one"],"image":[]}})).unwrap();
    service
        .author_request(
            "channel_select",
            &json!({"kind":"text","channel_id":custom["channel_id"]}),
        )
        .unwrap();
    let submitted = ok(f
        .agent
        .execute_model_remote_with(
            "hetu.model_tasks.submit",
            &input(&f, &record),
            &service,
            |_, _, _, connection| {
                assert_eq!(connection["origin"], "https://hetu.limeai.run");
                Ok(remote(&record, json!({"text":"原指定渠道结果"})))
            },
            |_, _| panic!(),
        )
        .unwrap());
    assert_eq!(submitted["plan"]["channel_id"], "cloud");
    assert_eq!(
        service.author_request("inspect", &json!({})).unwrap()["channels"]["text"],
        custom["channel_id"],
        "显式渠道不改全局默认设置"
    );
    args["channel_id"] = json!("channel_11111111-1111-4111-8111-111111111111");
    args["operation_key"] = json!("unconfigured-channel");
    assert_eq!(
        call(&f.agent, "model_tasks.prepare", args)["error"]["code"],
        "hetu.model_connection_required"
    );
}

#[test]
fn custom_channel_requires_distinct_billing_approval_and_keeps_candidates_in_original_task() {
    let f = fixture("cover");
    let service = ModelService::open(f.connection.path()).unwrap();
    let channel=service.author_request("custom_save",&json!({"name":"作者渠道","base_url":"https://provider.test","api_key":"private-provider-key","models":{"text":[],"image":["image-one"]}})).unwrap();
    service
        .author_request(
            "channel_select",
            &json!({"kind":"image","channel_id":channel["channel_id"]}),
        )
        .unwrap();
    let mut prepare_input = json!({"task_ref":f.task["task_ref"],"kind":"image","artifact_kind":"image","model_id":"image-one","prompt":"获权封面提示","title":"自定义渠道候选","billing_mode":"provider","operation_key":"custom-plan"});
    let mut unavailable = prepare_input.clone();
    unavailable["model_id"] = json!("image-unconfigured");
    unavailable["operation_key"] = json!("unconfigured-custom-model");
    assert_eq!(
        call(&f.agent, "model_tasks.prepare", unavailable)["error"]["code"],
        "invalid_input"
    );
    assert_eq!(
        ok(call(
            &f.agent,
            "model_tasks.list",
            json!({"task_ref":f.task["task_ref"]})
        ))["plans"],
        json!([])
    );
    let r = ok(call(&f.agent, "model_tasks.prepare", prepare_input.clone()));
    assert!(r["plan"]["estimated_credits"].is_null());
    assert!(!r.to_string().contains("private-provider-key"));
    prepare_input["operation_key"] = json!("fake-zero");
    prepare_input["estimated_credits"] = json!("0");
    assert_eq!(
        call(&f.agent, "model_tasks.prepare", prepare_input)["error"]["code"],
        "invalid_input"
    );
    let mut approval = json!({"task_ref":f.task["task_ref"],"plan_id":r["plan"]["plan_id"],"plan_sha256":r["plan_sha256"],"max_credits":"0","operation_key":"wrong-billing"});
    assert_eq!(
        call(&f.author, "model_tasks.approve", approval.clone())["error"]["code"],
        "hetu.author_confirmation_required"
    );
    approval.as_object_mut().unwrap().remove("max_credits");
    approval["provider_billing_accepted"] = json!(true);
    approval["operation_key"] = json!("provider-approve");
    assert_eq!(
        call(&f.agent, "model_tasks.approve", approval.clone())["error"]["code"],
        "forbidden"
    );
    ok(call(&f.author, "model_tasks.approve", approval));
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::RgbImage::new(64, 64)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    let bytes = bytes.into_inner();
    let output = json!({"sha256":digest(&bytes),"size":bytes.len(),"mime_type":"image/png","width":64,"height":64});
    let posts = Cell::new(0);
    let api = |method: &str, _: &str, body: Option<&Value>, _: &Value| {
        if method == "POST" {
            posts.set(posts.get() + 1);
            assert_eq!(body.unwrap()["provider_billing_accepted"], true);
            assert!(body.unwrap().get("max_credits").is_none());
        }
        Ok(remote(&r, output.clone()))
    };
    ok(f.agent
        .execute_model_remote_with(
            "hetu.model_tasks.submit",
            &input(&f, &r),
            &service,
            api,
            |_, _| panic!(),
        )
        .unwrap());
    let result = ok(f
        .agent
        .execute_model_remote_with(
            "hetu.model_tasks.collect",
            &input(&f, &r),
            &service,
            api,
            |_, _| Ok(bytes.clone()),
        )
        .unwrap());
    assert_eq!(posts.get(), 1);
    assert_eq!(result["sha256"], digest(bytes));
    assert_eq!(result["approval_state"], "awaiting_author");
}
