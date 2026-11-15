use super::*;

impl Kernel {
    // 额度预留与 submitted 意图在同一事务落盘，任何网络请求都在释放锁后执行。
    fn begin_model_execution(
        &self,
        action: &str,
        input: &Value,
        service: &ModelService,
    ) -> Result<(Value, bool)> {
        let reference = &input["task_ref"];
        let plan_id = text(input, "plan_id")?;
        let _lock = self.store.lock()?;
        self.store.recover()?;
        let mut record = self.model_plan(reference, plan_id)?;
        ensure(
            plan_connection(service, &record["plan"])? == record["plan"]["connection"],
            "forbidden",
            "请连接原计划的账号及环境后恢复。",
        )?;
        if action == "hetu.model_tasks.collect" && !record["collection"].is_null() {
            self.verify_model_collection(reference, &record["collection"])?;
            return Ok((record, false));
        }
        let first_submit = action == "hetu.model_tasks.submit" && record["submitted"] == false;
        let mut changes = Changes::new();
        if first_submit
            && (record["approval"].is_null()
                || record["approval"].get("authorization_id").is_some())
        {
            self.reserve_model_authorization(&mut record, &mut changes)?;
        }
        if action == "hetu.model_tasks.submit" {
            ensure(
                !record["approval"].is_null(),
                "hetu.author_confirmation_required",
                "请在当前 Agent 对话确认本任务的内容与额度授权。",
            )?;
        }
        if first_submit {
            record["submitted"] = json!(true);
            changes.insert(path(reference, plan_id)?, bytes(&record)?);
            self.stage_workspace_properties(&mut changes)?;
            self.store.transaction(&changes)?;
        }
        Ok((record, first_submit))
    }

    pub(in crate::application) fn execute_model_network(
        &self,
        action: &str,
        input: &Value,
    ) -> Result<Value> {
        let service = self.model_service()?;
        if action == "hetu.models.list" {
            {
                let _lock = self.store.read_lock()?;
                self.model_context(&input["task_ref"])?;
            }
            let identity =
                service.identity_for_channel(text(input, "kind")?, input["channel_id"].as_str())?;
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
                    service
                        .identity_for_channel(text(input, "kind")?, input["channel_id"].as_str())?
                        == identity,
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
    pub(super) fn execute_model_remote_with(
        &self,
        action: &str,
        input: &Value,
        service: &ModelService,
        api: impl Fn(&str, &str, Option<&Value>, &Value) -> Result<Value>,
        image: impl Fn(&str, &Value) -> Result<Vec<u8>>,
    ) -> Result<Value> {
        let reference = &input["task_ref"];
        let plan_id = text(input, "plan_id")?;
        let (record, first_submit) = self.begin_model_execution(action, input, service)?;
        if action == "hetu.model_tasks.collect" && !record["collection"].is_null() {
            return Ok(domain::success(
                action,
                self.scope(),
                record["collection"].clone(),
            ));
        }
        if record["result"]["local_rejection"] == true
            && recovery::can_resume_after_recharge(&record["result"])
        {
            // 余额在建单前被拒绝，远端可能没有操作；以本地明确的未扣费回执恢复。
            return self.model_failure_response(action, record);
        }
        if record["submitted"] == false {
            let mut visible = record;
            visible["authorization"] = self.model_authorization_status(&visible)?;
            return Ok(domain::success(action, self.scope(), visible));
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
        let response = api(
            if first_submit { "POST" } else { "GET" },
            &remote_path,
            if first_submit {
                Some(&submission)
            } else {
                None
            },
            &plan["connection"],
        );
        let result = match response {
            Ok(result) => result,
            Err(error) => {
                if error.code == "hetu.credits_insufficient" && first_submit {
                    let operation = json!({"status":"failed","error_code":if plan["connection"]["channel"] == "custom" {"HETU_PROVIDER_BALANCE_INSUFFICIENT"} else {"MODELS_CREDITS_INSUFFICIENT"},"billing":{"state":"not_reserved"},"local_rejection":true});
                    self.record_model_failure(service, &record, &operation)?;
                }
                return Err(error);
            }
        };
        ensure(
            result["operation_key"] == plan_id
                && result["kind"] == plan["kind"]
                && result["operation"]["model_id"] == plan["payload"]["model_id"],
            "hetu.integrity_failure",
            "远端结果未绑定原计划或模型。",
        )?;
        if result["operation"]["status"] == "failed" {
            let current = self.record_model_failure(service, &record, &result["operation"])?;
            return self.model_failure_response(action, current);
        }
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
            plan_connection(service, plan)? == plan["connection"]
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
            current["collection"] = self.collect_model_output(plan, output, media, &mut changes)?;
        }
        changes.insert(path(reference, plan_id)?, bytes(&current)?);
        self.stage_workspace_properties(&mut changes)?;
        self.store.transaction(&changes)?;
        current["authorization"] = self.model_authorization_status(&current)?;
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
}
