use super::*;

pub(super) fn is_credit_failure(operation: &Value) -> bool {
    operation["status"] == "failed"
        && matches!(
            operation["error_code"].as_str(),
            Some("MODELS_CREDITS_INSUFFICIENT" | "HETU_PROVIDER_BALANCE_INSUFFICIENT")
        )
}

pub(super) fn can_resume_after_recharge(operation: &Value) -> bool {
    is_credit_failure(operation)
        && matches!(
            operation["billing"]["state"].as_str(),
            Some("released" | "not_reserved")
        )
}

impl Kernel {
    pub(super) fn link_model_recharge_plan(
        &self,
        plan: &mut Value,
        parent_id: &str,
        changes: &mut Changes,
    ) -> Result<()> {
        let reference = plan["task_ref"].clone();
        let mut parent = self.model_plan(&reference, parent_id)?;
        ensure(
            can_resume_after_recharge(&parent["result"]),
            "hetu.model_outcome_unknown",
            "原请求尚未确认因余额不足而未扣费，不能创建替代请求；请先查询原计划。",
        )?;
        ensure(
            parent["replacement_plan_id"].is_null(),
            "hetu.model_retry_exists",
            "原请求已有恢复计划，请读取原计划的replacement_plan_id继续，不要重复创建。",
        )?;
        ensure(
            parent["plan"]["payload"] == plan["payload"]
                && parent["plan"]["connection"] == plan["connection"]
                && parent["plan"]["artifact_kind"] == plan["artifact_kind"],
            "revision_conflict",
            "充值恢复必须保留原模型、输入、计费政策和渠道；变化时先在对话说明新计划。",
        )?;
        plan["resumes_plan_id"] = json!(parent_id);
        parent["replacement_plan_id"] = plan["plan_id"].clone();
        changes.insert(path(&reference, parent_id)?, bytes(&parent)?);
        Ok(())
    }

    pub(super) fn record_model_failure(
        &self,
        service: &ModelService,
        record: &Value,
        operation: &Value,
    ) -> Result<Value> {
        let _lock = self.store.lock()?;
        self.store.recover()?;
        let plan = &record["plan"];
        let reference = &plan["task_ref"];
        let plan_id = text(plan, "plan_id")?;
        let mut current = self.model_plan(reference, plan_id)?;
        ensure(
            plan_connection(service, plan)? == plan["connection"]
                && current["plan_sha256"] == record["plan_sha256"],
            "forbidden",
            "任务或模型连接已变化，不能接收晚到失败结果。",
        )?;
        current["result"] = operation.clone();
        let mut changes = Changes::new();
        self.release_model_authorization(&mut current, &mut changes)?;
        changes.insert(path(reference, plan_id)?, bytes(&current)?);
        self.stage_workspace_properties(&mut changes)?;
        self.store.transaction(&changes)?;
        Ok(current)
    }

    pub(super) fn model_failure_response(&self, action: &str, mut record: Value) -> Result<Value> {
        let credit_failure = is_credit_failure(&record["result"]);
        let resumable = can_resume_after_recharge(&record["result"]);
        if action == "hetu.model_tasks.get" {
            record["authorization"] = self.model_authorization_status(&record)?;
            record["recovery"] = json!({
                "kind":if credit_failure {"recharge"} else {"failed"},
                "resume_allowed":resumable,
                "replacement_plan_id":record["replacement_plan_id"]
            });
            if resumable {
                record["recovery"]["next_action"] = json!("hetu.model_tasks.prepare");
                record["recovery"]["resume_from_plan_id"] = record["plan"]["plan_id"].clone();
            }
            return Ok(domain::success(action, self.scope(), record));
        }
        Err(if credit_failure {
            let message = if record["plan"]["connection"]["channel"] == "custom" {
                "供应商账户余额不足，请在当前Agent对话提示为原渠道充值。充值后先查询原计划，确认未扣费后在原任务授权额度内恢复。"
            } else {
                "河图平台余额不足，请在当前Agent对话提示充值：https://hetu.limeai.run/console/ 。充值后先查询原计划，确认未扣费后在原任务授权额度内恢复。"
            };
            Error::new("hetu.credits_insufficient", message)
        } else {
            Error::new(
                "hetu.model_generation_failed",
                "原模型操作已明确失败；请在当前对话说明原因并保留原计划，不把失败当成等待中。",
            )
        })
    }
}
