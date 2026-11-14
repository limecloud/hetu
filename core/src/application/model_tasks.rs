use super::*;
use crate::model_service::{ModelService, plan_digest};

pub(super) fn definition(name: &str) -> Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    let source = SCHEMA.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../contracts/schemas/model-service.schema.json"
        ))
        .expect("embedded model service schema")
    });
    domain::schema::definition(source, name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    struct Fixture {
        root: tempfile::TempDir,
        connection: tempfile::TempDir,
        author: Kernel,
        agent: Kernel,
        task: Value,
    }
    fn call(k: &Kernel, action: &str, input: Value) -> Value {
        k.request(json!({"action":format!("hetu.{action}"),"contract_revision":"1","input":input}))
    }
    fn ok(value: Value) -> Value {
        assert_eq!(value["status"], "succeeded", "{value}");
        value["data"].clone()
    }
    fn fixture(kind: &str) -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let connection = tempfile::tempdir().unwrap();
        let mut author=Kernel::open(json!({"workspace_path":root.path(),"mode":"author","create":{"title":"雾港","locale":"zh-CN","operation_key":"init"}})).unwrap();
        ModelService::open(connection.path()).unwrap();
        std::fs::write(connection.path().join("connection.json"),serde_json::to_vec(&json!({"origin":"https://hetu.limeai.run","token":"private-test-token","account_ref":"a".repeat(64),"environment":"sandbox","defaults":{"text":"text-one","image":"image-one"}})).unwrap()).unwrap();
        author.model_service_directory = Some(connection.path().to_owned());
        let preview = ok(call(
            &author,
            "creative_tasks.preview_prompt",
            json!({"scope_ref":{"kind":"workspace","id":author.scope()},"task_kind":kind,"brief":"仅处理当前固定任务。","input_refs":[],"client_adapter":"codex","language_tag":"zh-CN","candidate_limit":2}),
        ));
        let mut input = preview["prepare_input"].clone();
        input["operation_key"] = json!("prepare");
        let task = ok(call(&author, "creative_tasks.prepare", input));
        let mut agent=Kernel::open(json!({"workspace_path":root.path(),"mode":"agent","task_id":task["task_ref"]["task_id"]})).unwrap();
        agent.model_service_directory = Some(connection.path().to_owned());
        Fixture {
            root,
            connection,
            author,
            agent,
            task,
        }
    }
    fn prepare(f: &Fixture, kind: &str) -> Value {
        ok(call(
            &f.agent,
            "model_tasks.prepare",
            json!({"task_ref":f.task["task_ref"],"kind":kind,"artifact_kind":if kind=="text" {"text"} else {"image"},"model_id":format!("{kind}-one"),"prompt":"这是获权内容。","title":"候选方案","billing_policy_version":"p1","estimated_credits":"12","operation_key":"model-prepare"}),
        ))
    }
    fn approve(f: &Fixture, record: &Value) -> Value {
        ok(call(
            &f.author,
            "model_tasks.approve",
            json!({"task_ref":f.task["task_ref"],"plan_id":record["plan"]["plan_id"],"plan_sha256":record["plan_sha256"],"max_credits":"12","operation_key":"approve"}),
        ))
    }
    fn input(f: &Fixture, r: &Value) -> Value {
        json!({"task_ref":f.task["task_ref"],"plan_id":r["plan"]["plan_id"],"operation_key":"execute"})
    }
    fn remote(r: &Value, output: Value) -> Value {
        json!({"operation_key":r["plan"]["plan_id"],"kind":r["plan"]["kind"],"operation":{"id":"generation-1","model_id":r["plan"]["payload"]["model_id"],"status":"succeeded","output":output}})
    }
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
        wrong["task_ref"]["scope_ref"]["id"] =
            json!("workspace_00000000-0000-4000-8000-000000000000");
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
    fn image_collection_requires_complete_decode_and_keeps_original_file() {
        let f = fixture("cover");
        let r = prepare(&f, "image");
        approve(&f, &r);
        let service = ModelService::open(f.connection.path()).unwrap();
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::RgbImage::new(64, 64)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let bytes = bytes.into_inner();
        let output = json!({"sha256":digest(&bytes),"size":bytes.len(),"mime_type":"image/png","width":64,"height":64});
        ok(f.agent
            .execute_model_remote_with(
                "hetu.model_tasks.submit",
                &input(&f, &r),
                &service,
                |_, _, _, _| Ok(remote(&r, output.clone())),
                |_, _| panic!(),
            )
            .unwrap());
        let result = ok(f
            .agent
            .execute_model_remote_with(
                "hetu.model_tasks.collect",
                &input(&f, &r),
                &service,
                |_, _, _, _| Ok(remote(&r, output.clone())),
                |_, _| Ok(bytes.clone()),
            )
            .unwrap());
        assert_eq!(result["sha256"], digest(&bytes));
        assert_eq!(result["media_type"], "image/png");
        let submitted = ok(call(
            &f.agent,
            "creative_tasks.submit_result",
            json!({"task_ref":f.task["task_ref"],"request_sha256":f.task["request_sha256"],"candidates":[{"kind":"image","title":"模型封面候选","source_format":"image","source_ref_indices":[],"file_name":result["file_name"],"sha256":result["sha256"]}],"complete":true,"missing_items":[],"provenance":{"client":"test","skill_version":"1"},"operation_key":"submit-candidate"}),
        ));
        let selection = json!({"source":{"kind":"creative_task","reference":{"task_ref":f.task["task_ref"],"submission_id":submitted["submission"]["submission_id"],"candidate_id":submitted["submission"]["candidates"][0]["candidate_id"]}},"expected_cover":null,"presentation":{"crop_rect":{"x":0,"y":0,"width":1,"height":1},"title_overlay":"","author_overlay":""},"operation_key":"choose-cover"});
        assert_eq!(
            call(&f.agent, "covers.select", selection.clone())["error"]["code"],
            "forbidden"
        );
        let chosen = ok(call(&f.author, "covers.select", selection));
        assert_eq!(chosen["cover"]["source_ref"]["kind"], "creative_task");
        assert_eq!(
            chosen["cover"]["source_ref"]["candidate"]["sha256"],
            result["sha256"]
        );
        assert_eq!(
            chosen["cover"]["source_ref"]["request_sha256"],
            f.task["request_sha256"]
        );
        ok(call(&f.author, "covers.get", json!({})));
        let truncated = &bytes[..bytes.len() / 2];
        assert!(crate::infrastructure::media::decode_image_bytes(truncated).is_err());
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
}
fn folder(reference: &Value) -> Result<String> {
    Ok(format!(
        ".hetu/tasks/{}/models",
        checked_id(text(reference, "task_id")?, "task")?
    ))
}
fn path(reference: &Value, plan_id: &str) -> Result<String> {
    Ok(format!(
        "{}/{}.json",
        folder(reference)?,
        checked_id(plan_id, "model")?
    ))
}
fn credits(value: &Value) -> Result<u128> {
    value
        .as_str()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| Error::new("invalid_input", "额度必须为非负整数字符串。"))
}
impl Kernel {
    fn model_service(&self) -> Result<ModelService> {
        #[cfg(test)]
        if let Some(directory) = &self.model_service_directory {
            return ModelService::open(directory);
        }
        ModelService::open_default()
    }
    fn model_context(&self, reference: &Value) -> Result<(Value, String)> {
        ensure(
            digest(self.store.read(self.config_path())?) == self.config_sha,
            "revision_conflict",
            "作品配置已变化，请重新打开。",
        )?;
        self.check_task_session()?;
        let (task, sha, state, _) = self.task_for_reference(reference)?;
        ensure(
            state["state"] != "closed",
            "forbidden",
            "任务已关闭，不能使用模型服务。",
        )?;
        Ok((task, sha))
    }
    fn model_plan(&self, reference: &Value, plan_id: &str) -> Result<Value> {
        let (_, request_sha) = self.model_context(reference)?;
        let record = self.store.json(&path(reference, plan_id)?)?;
        ensure(
            record["plan"]["task_ref"] == *reference
                && record["plan"]["request_sha256"] == request_sha
                && record["plan"]["plan_id"] == plan_id
                && record["plan_sha256"] == plan_digest(&record["plan"])?
                && (record["approval"].is_null()
                    || record["approval"]["plan_sha256"] == record["plan_sha256"]),
            "hetu.integrity_failure",
            "模型计划、批准或固定任务摘要不一致。",
        )?;
        Ok(record)
    }
    pub(super) fn dispatch_model_local(
        &self,
        action: &str,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let reference = &input["task_ref"];
        let (task, request_sha) = self.model_context(reference)?;
        match action {
            "hetu.model_tasks.list" => {
                let directory = folder(reference)?;
                let mut plans = Vec::new();
                let entries = self.store.entries(&directory).or_else(|error| {
                    if error.code == "not_found" {
                        Ok(Vec::new())
                    } else {
                        Err(error)
                    }
                })?;
                {
                    for entry in entries {
                        let plan_id = entry.strip_suffix(".json").ok_or_else(|| {
                            Error::new("hetu.integrity_failure", "模型计划目录含未知记录。")
                        })?;
                        plans.push(self.model_plan(reference, plan_id)?);
                        ensure(
                            plans.len() <= 100,
                            "hetu.budget_exceeded",
                            "模型计划超过任务预算。",
                        )?;
                    }
                }
                Ok(json!({"plans":plans}))
            }
            "hetu.model_tasks.prepare" => {
                let kind = text(input, "kind")?;
                let artifact = text(input, "artifact_kind")?;
                ensure(
                    (kind == "image") == (artifact == "image")
                        && task["output_contract"]["artifact_types"]
                            .as_array()
                            .is_some_and(|types| types.contains(&input["artifact_kind"])),
                    "forbidden",
                    "模型输出类型不属于当前任务。",
                )?;
                ensure(
                    text(input, "prompt")?.len() <= if kind == "text" { 32768 } else { 16384 },
                    "hetu.budget_exceeded",
                    "固定模型输入超过字节预算。",
                )?;
                ensure(
                    input.get("instructions").is_none_or(|v| {
                        kind == "text" && v.as_str().is_some_and(|s| s.len() <= 8192)
                    }),
                    "invalid_input",
                    "图片任务不接受文字指令字段。",
                )?;
                let directory = folder(reference)?;
                self.store.directory(&directory)?;
                ensure(
                    self.store.entries(&directory)?.len() < 100,
                    "hetu.budget_exceeded",
                    "模型计划达到任务上限。",
                )?;
                let service = self.model_service()?;
                let connection = service.identity_for(kind)?;
                let provider = connection["channel"] == "custom";
                ensure(
                    provider == (input["billing_mode"] == "provider"),
                    "invalid_input",
                    "自定义渠道须显式使用供应商计费，Cloud渠道须使用Credits报价。",
                )?;
                if !provider {
                    text(input, "billing_policy_version")?;
                    credits(&input["estimated_credits"])?;
                } else {
                    ensure(
                        input.get("estimated_credits").is_none()
                            && input.get("billing_policy_version").is_none(),
                        "invalid_input",
                        "供应商计费不能冒充Cloud报价或零Credits。",
                    )?;
                }
                let plan_id = id("model");
                let mut payload = json!({"model_id":input["model_id"]});
                if !provider {
                    payload["billing_policy_version"] = input["billing_policy_version"].clone();
                }
                if kind == "text" {
                    payload["input"] = input["prompt"].clone();
                    payload["output_schema"] = json!({"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false});
                    if let Some(value) = input.get("instructions") {
                        payload["instructions"] = value.clone();
                    }
                } else {
                    payload["prompt"] = input["prompt"].clone();
                }
                let plan = json!({"plan_id":plan_id,"task_ref":reference,"request_sha256":request_sha,"connection":connection,"kind":kind,"artifact_kind":artifact,"title":input["title"],"payload":payload,"billing_mode":if provider {"provider"} else {"credits"},"estimated_credits":input["estimated_credits"],"max_requests":1,"created_at":now()});
                let record = json!({"plan_sha256":plan_digest(&plan)?,"plan":plan,"approval":null,"submitted":false,"result":null,"collection":null});
                changes.insert(path(reference, &plan_id)?, bytes(&record)?);
                Ok(record)
            }
            "hetu.model_tasks.approve" => {
                ensure(self.author, "forbidden", "只有作者可以批准内容外发和费用。")?;
                let mut record = self.model_plan(reference, text(input, "plan_id")?)?;
                ensure(
                    record["plan_sha256"] == input["plan_sha256"] && record["submitted"] == false,
                    "revision_conflict",
                    "计划已变化或已提交，请查看原记录。",
                )?;
                let provider = record["plan"]["connection"]["channel"] == "custom";
                if provider {
                    ensure(
                        input["provider_billing_accepted"] == true
                            && input.get("max_credits").is_none(),
                        "hetu.author_confirmation_required",
                        "请明确批准供应商单次计费；本渠道没有Cloud Credits报价。",
                    )?;
                } else {
                    ensure(
                        input.get("provider_billing_accepted").is_none()
                            && credits(&input["max_credits"])?
                                >= credits(&record["plan"]["estimated_credits"])?,
                        "hetu.budget_exceeded",
                        "本次费用上限小于计划报价。",
                    )?;
                }
                ensure(
                    self.model_service()?
                        .identity_for(text(&record["plan"], "kind")?)?
                        == record["plan"]["connection"],
                    "forbidden",
                    "计划属于其他模型服务账号或环境。",
                )?;
                record["approval"] = json!({"plan_sha256":record["plan_sha256"],"approved_at":now(),"actor_ref":AUTHOR});
                if provider {
                    record["approval"]["provider_billing_accepted"] = json!(true);
                } else {
                    record["approval"]["max_credits"] = input["max_credits"].clone();
                }
                changes.insert(path(reference, text(input, "plan_id")?)?, bytes(&record)?);
                Ok(record)
            }
            _ => Err(Error::new("invalid_input", "模型计划动作无效。")),
        }
    }
    pub(super) fn execute_model_network(&self, action: &str, input: &Value) -> Result<Value> {
        let service = self.model_service()?;
        if action == "hetu.models.list" {
            {
                let _lock = self.store.read_lock()?;
                self.model_context(&input["task_ref"])?;
            }
            let identity = service.identity_for(text(input, "kind")?)?;
            let mut data = service.api(
                "GET",
                &format!("/models/{}", text(input, "kind")?),
                None,
                &identity,
            )?;
            data["default_model_id"] = service.author_request("inspect", &json!({}))?["defaults"]
                [text(input, "kind")?]
            .clone();
            {
                let _lock = self.store.read_lock()?;
                self.model_context(&input["task_ref"])?;
                ensure(
                    service.identity_for(text(input, "kind")?)? == identity,
                    "forbidden",
                    "模型账号已切换，请重新读取目录。",
                )?;
            }
            return Ok(domain::success(action, self.scope(), data));
        }
        self.execute_model_remote_with(
            action,
            input,
            &service,
            |method, path, body, identity| service.api(method, path, body, identity),
            |key, identity| service.image(key, identity),
        )
    }
    fn execute_model_remote_with(
        &self,
        action: &str,
        input: &Value,
        service: &ModelService,
        api: impl Fn(&str, &str, Option<&Value>, &Value) -> Result<Value>,
        image: impl Fn(&str, &Value) -> Result<Vec<u8>>,
    ) -> Result<Value> {
        let reference = &input["task_ref"];
        let plan_id = text(input, "plan_id")?;
        let (record, first_submit) = {
            let _lock = self.store.lock()?;
            self.store.recover()?;
            let mut record = self.model_plan(reference, plan_id)?;
            ensure(
                service.identity_for(text(&record["plan"], "kind")?)?
                    == record["plan"]["connection"],
                "forbidden",
                "请连接原计划的账号及环境后恢复。",
            )?;
            if action == "hetu.model_tasks.collect" && !record["collection"].is_null() {
                self.verify_model_collection(reference, &record["collection"])?;
                return Ok(domain::success(
                    action,
                    self.scope(),
                    record["collection"].clone(),
                ));
            }
            let first_submit = action == "hetu.model_tasks.submit" && record["submitted"] == false;
            if action == "hetu.model_tasks.submit" {
                ensure(
                    !record["approval"].is_null(),
                    "hetu.author_confirmation_required",
                    "请作者在河图任务中审阅并批准固定输入外发和本次费用。",
                )?;
            }
            if first_submit {
                record["submitted"] = json!(true);
                let mut changes = BTreeMap::from([(path(reference, plan_id)?, bytes(&record)?)]);
                self.stage_workspace_properties(&mut changes)?;
                self.store.transaction(&changes)?;
            }
            (record, first_submit)
        };
        if record["submitted"] == false {
            return Ok(domain::success(action, self.scope(), record));
        }
        let plan = &record["plan"];
        let remote_path = format!("/operations/{plan_id}");
        let mut submission = json!({"kind":plan["kind"],"task_sha256":plan["request_sha256"],"payload":plan["payload"]});
        if plan["connection"]["channel"] == "custom" {
            submission["provider_billing_accepted"] =
                record["approval"]["provider_billing_accepted"].clone();
        } else {
            submission["max_credits"] = record["approval"]["max_credits"].clone();
        }
        // 此处不持有作品锁。已经标记提交的计划永远只用 GET，换 operation_key 也不会重下单。
        let result = api(
            if first_submit { "POST" } else { "GET" },
            &remote_path,
            if first_submit {
                Some(&submission)
            } else {
                None
            },
            &plan["connection"],
        )?;
        ensure(
            result["operation_key"] == plan_id
                && result["kind"] == plan["kind"]
                && result["operation"]["model_id"] == plan["payload"]["model_id"],
            "hetu.integrity_failure",
            "远端结果未绑定原计划或模型。",
        )?;
        let output = &result["operation"]["output"];
        let media = if action == "hetu.model_tasks.collect" {
            ensure(
                result["operation"]["status"] == "succeeded",
                "hetu.model_result_pending",
                "原模型操作尚未成功，请保留计划继续查询。",
            )?;
            if plan["kind"] == "image" {
                Some(image(plan_id, &plan["connection"])?)
            } else {
                None
            }
        } else {
            None
        };
        let _lock = self.store.lock()?;
        self.store.recover()?;
        let mut current = self.model_plan(reference, plan_id)?;
        ensure(
            service.identity_for(text(plan, "kind")?)? == plan["connection"]
                && current["plan_sha256"] == record["plan_sha256"],
            "forbidden",
            "任务或模型连接已变化，不能收集晚到结果。",
        )?;
        let mut changes = Changes::new();
        current["result"] = result["operation"].clone();
        if action == "hetu.model_tasks.collect" {
            if !current["collection"].is_null() {
                self.verify_model_collection(reference, &current["collection"])?;
                return Ok(domain::success(
                    action,
                    self.scope(),
                    current["collection"].clone(),
                ));
            }
            let (content, extension, media_type) = if let Some(bytes) = media {
                ensure(
                    digest(&bytes) == output["sha256"] && output["size"] == bytes.len(),
                    "hetu.integrity_failure",
                    "下载图片与远端摘要不一致。",
                )?;
                let decoded = crate::infrastructure::media::decode_image_bytes(&bytes)?;
                ensure(
                    decoded.scan["media_type"] == output["mime_type"]
                        && output["width"] == decoded.decoded.width()
                        && output["height"] == decoded.decoded.height(),
                    "hetu.integrity_failure",
                    "实际图片格式或尺寸与声明不一致。",
                )?;
                (
                    bytes,
                    text(&decoded.scan, "extension")?.to_owned(),
                    text(&decoded.scan, "media_type")?.to_owned(),
                )
            } else {
                let text = text(output, "text")?;
                ensure(
                    !text.trim().is_empty() && text.len() <= 65536 && !text.contains('\0'),
                    "hetu.integrity_failure",
                    "模型输出文字为空或超过预算。",
                )?;
                (text.as_bytes().to_vec(), "txt".into(), "text/plain".into())
            };
            let filename = format!("{plan_id}.{extension}");
            let inbox = format!(
                ".hetu/tasks/{}/inbox/{filename}",
                text(reference, "task_id")?
            );
            let collection = json!({"plan_id":plan_id,"file_name":filename,"sha256":digest(&content),"size_bytes":content.len(),"media_type":media_type,"artifact_kind":plan["artifact_kind"],"title":plan["title"],"content":if plan["kind"]=="text" {output["text"].clone()} else {Value::Null},"approval_state":"awaiting_author","next_action":"hetu.creative_tasks.submit_result"});
            if plan["kind"] == "image" {
                if self.store.exists(&inbox)? {
                    let mut file = self.store.managed_media(&inbox)?;
                    ensure(
                        crate::infrastructure::media::scan(&mut file, None)?["sha256"]
                            == collection["sha256"],
                        "hetu.integrity_failure",
                        "已有图片候选摘要不同，不能覆盖。",
                    )?;
                } else {
                    self.store
                        .import_media_bytes(&inbox, &content, &collection)?;
                }
            } else {
                changes.insert(inbox, content);
            }
            current["collection"] = collection;
        }
        changes.insert(path(reference, plan_id)?, bytes(&current)?);
        self.stage_workspace_properties(&mut changes)?;
        self.store.transaction(&changes)?;
        Ok(domain::success(
            action,
            self.scope(),
            if action == "hetu.model_tasks.collect" {
                current["collection"].clone()
            } else {
                current
            },
        ))
    }
    fn verify_model_collection(&self, reference: &Value, collection: &Value) -> Result<()> {
        let filename = text(collection, "file_name")?;
        ensure(
            !filename.contains('/') && !filename.contains('\\'),
            "hetu.integrity_failure",
            "候选文件名无效。",
        )?;
        let path = format!(
            ".hetu/tasks/{}/inbox/{filename}",
            checked_id(text(reference, "task_id")?, "task")?
        );
        if collection["artifact_kind"] != "image" {
            let content = self.store.read(&path)?;
            return ensure(
                digest(&content) == collection["sha256"]
                    && content.len() == collection["size_bytes"],
                "hetu.integrity_failure",
                "已收集文字候选发生变化，请保留原文件并检查。",
            );
        }
        let mut file = self.store.managed_media(&path)?;
        let scan = crate::infrastructure::media::scan(&mut file, None)?;
        ensure(
            scan["sha256"] == collection["sha256"]
                && scan["size_bytes"] == collection["size_bytes"],
            "hetu.integrity_failure",
            "已收集候选发生变化，请保留原文件并检查。",
        )
    }
}
