use super::*;

impl Kernel {
    pub(super) fn model_service(&self) -> Result<ModelService> {
        #[cfg(test)]
        if let Some(directory) = &self.model_service_directory {
            return ModelService::open(directory);
        }
        ModelService::open_default()
    }
    pub(super) fn model_context(&self, reference: &Value) -> Result<(Value, String)> {
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
    pub(super) fn model_plan(&self, reference: &Value, plan_id: &str) -> Result<Value> {
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
    pub(super) fn list_model_plans(&self, reference: &Value) -> Result<Value> {
        let directory = folder(reference)?;
        let mut plans = Vec::new();
        let entries = self.store.entries(&directory).or_else(|error| {
            if error.code == "not_found" {
                Ok(Vec::new())
            } else {
                Err(error)
            }
        })?;
        for entry in entries {
            let plan_id = entry
                .strip_suffix(".json")
                .ok_or_else(|| Error::new("hetu.integrity_failure", "模型计划目录含未知记录。"))?;
            plans.push(self.model_plan(reference, plan_id)?);
            ensure(
                plans.len() <= 100,
                "hetu.budget_exceeded",
                "模型计划超过任务预算。",
            )?;
        }
        Ok(json!({"plans":plans}))
    }
    pub(super) fn prepare_model_plan(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let reference = &input["task_ref"];
        let (task, request_sha) = self.model_context(reference)?;
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
            input
                .get("instructions")
                .is_none_or(|v| kind == "text" && v.as_str().is_some_and(|s| s.len() <= 8192)),
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
        let connection = service.identity_for_channel(MediaKind::from_str(kind)?, input["channel_id"].as_str())?;
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
            let catalog = service.api("GET", &format!("/models/{kind}"), None, &connection)?;
            ensure(
                catalog["items"].as_array().is_some_and(|items| {
                    items.iter().any(|model| model["id"] == input["model_id"])
                }),
                "invalid_input",
                "模型不属于此渠道。",
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
        let mut plan = json!({"plan_id":plan_id,"task_ref":reference,"request_sha256":request_sha,"connection":connection,"kind":kind,"artifact_kind":artifact,"title":input["title"],"payload":payload,"billing_mode":if provider {"provider"} else {"credits"},"estimated_credits":input["estimated_credits"],"max_requests":1,"created_at":now()});
        if let Some(channel) = input.get("channel_id") {
            plan["channel_id"] = channel.clone();
        }
        if let Some(parent_id) = input.get("resume_from_plan_id").and_then(Value::as_str) {
            self.link_model_recharge_plan(&mut plan, parent_id, changes)?;
        }
        let record = json!({"plan_sha256":plan_digest(&plan)?,"plan":plan,"approval":null,"submitted":false,"result":null,"collection":null});
        changes.insert(path(reference, &plan_id)?, bytes(&record)?);
        Ok(record)
    }
}
