use super::*;

impl Kernel {
    pub(super) fn approve_model_plan_record(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let reference = &input["task_ref"];
        let mut record = self.model_plan(reference, text(input, "plan_id")?)?;
        ensure(
            record["plan_sha256"] == input["plan_sha256"] && record["submitted"] == false,
            "revision_conflict",
            "计划已变化或已提交，请查看原记录。",
        )?;
        let provider = record["plan"]["connection"]["channel"] == "custom";
        if provider {
            ensure(
                input["provider_billing_accepted"] == true && input.get("max_credits").is_none(),
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
            plan_connection(&self.model_service()?, &record["plan"])?
                == record["plan"]["connection"],
            "forbidden",
            "计划属于其他模型服务账号或环境。",
        )?;
        record["approval"] =
            json!({"plan_sha256":record["plan_sha256"],"approved_at":now(),"actor_ref":AUTHOR});
        if provider {
            record["approval"]["provider_billing_accepted"] = json!(true);
        } else {
            record["approval"]["max_credits"] = input["max_credits"].clone();
        }
        changes.insert(path(reference, text(input, "plan_id")?)?, bytes(&record)?);
        Ok(record)
    }
    /// 仅供持有真实宿主交互结果的本机适配器调用，不是 AXI／CLI 业务动作。
    pub(crate) fn confirm_model_plan_from_host(&self, record: &Value, host: &str) -> Result<Value> {
        ensure(
            self.task_id.is_some()
                && self
                    .collaboration_grant
                    .as_ref()
                    .is_some_and(|g| g["client_adapter"] == host),
            "forbidden",
            "宿主确认必须绑定本机获权任务。",
        )?;
        let _guard = self.store.lock()?;
        self.store.recover()?;
        let reference = &record["plan"]["task_ref"];
        // 等待用户期间可能撤权、关闭任务或切换渠道；落盘前全部重新校验。
        let current = self.model_plan(reference, text(&record["plan"], "plan_id")?)?;
        ensure(
            current["plan_sha256"] == record["plan_sha256"],
            "revision_conflict",
            "用户确认的计划已变化。",
        )?;
        if !current["approval"].is_null() {
            return Ok(current);
        }
        let mut input = json!({"task_ref":reference,"plan_id":record["plan"]["plan_id"],"plan_sha256":record["plan_sha256"]});
        if record["plan"]["billing_mode"] == "provider" {
            input["provider_billing_accepted"] = json!(true);
        } else {
            input["max_credits"] = record["plan"]["estimated_credits"].clone();
        }
        let mut changes = Changes::new();
        let mut confirmed = self.approve_model_plan_record(&input, &mut changes)?;
        confirmed["approval"]["confirmation_channel"] = json!("mcp_elicitation");
        confirmed["approval"]["host"] = json!(host);
        let operation_id = id("op");
        confirmed["approval"]["operation_id"] = json!(operation_id);
        changes.insert(
            path(reference, text(&record["plan"], "plan_id")?)?,
            bytes(&confirmed)?,
        );
        changes.insert(format!(".hetu/audit/{operation_id}.json"), bytes(&json!({
            "schema_version":"1.0.0","operation_id":operation_id,"action":"hetu.model_tasks.approve",
            "actor_ref":AUTHOR,"confirmation_channel":"mcp_elicitation","host":host,
            "plan_id":record["plan"]["plan_id"],"plan_sha256":record["plan_sha256"],"created_at":now(),"status":"succeeded"
        }))?);
        self.stage_workspace_properties(&mut changes)?;
        self.store.transaction(&changes)?;
        Ok(confirmed)
    }
}
