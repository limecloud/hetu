use super::*;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Policy {
    operation_key: String,
    channels: String,
    max_requests: Option<u64>,
    max_credits: Option<String>,
    #[serde(default)]
    unrestricted: bool,
}

fn policy(value: &Value) -> Result<Policy> {
    let p: Policy = serde_json::from_value(value.clone())?;
    ensure(
        !p.operation_key.is_empty() && p.operation_key.len() <= 128,
        "invalid_input",
        "任务授权须保留固定操作键。",
    )?;
    ensure(
        matches!(p.channels.as_str(), "current" | "configured"),
        "invalid_input",
        "请选择当前渠道或已配置渠道。",
    )?;
    ensure(
        if p.unrestricted {
            p.max_requests.is_none() && p.max_credits.is_none()
        } else {
            p.max_requests.is_some() || p.max_credits.is_some()
        },
        "invalid_input",
        "请提供请求数／Credits上限，或明确完全授权。",
    )?;
    if let Some(count) = p.max_requests {
        ensure(count > 0, "invalid_input", "请求数上限须大于零。")?;
    }
    if let Some(amount) = &p.max_credits {
        ensure(
            amount.len() <= 20
                && !amount.starts_with('0')
                && amount.bytes().all(|c| c.is_ascii_digit())
                && credits(&json!(amount))? > 0,
            "invalid_input",
            "Credits上限须为正整数字符串。",
        )?;
    }
    Ok(p)
}

fn authorization_path(reference: &Value, kind: &str) -> Result<String> {
    ensure(
        matches!(kind, "text" | "image"),
        "invalid_input",
        "模型种类无效。",
    )?;
    Ok(format!(
        ".hetu/tasks/{}/model-authorizations/{kind}.json",
        checked_id(text(reference, "task_id")?, "task")?
    ))
}
fn history_path(reference: &Value, kind: &str, key: &str) -> Result<String> {
    Ok(format!(
        "{}.{}.json",
        authorization_path(reference, kind)?,
        digest(key)
    ))
}

impl Kernel {
    pub(super) fn model_authorization_status(&self, record: &Value) -> Result<Value> {
        let file = authorization_path(&record["plan"]["task_ref"], text(&record["plan"], "kind")?)?;
        if self.store.exists(&file)? {
            self.store.json(&file)
        } else {
            Ok(Value::Null)
        }
    }
    pub(crate) fn prepare_task_model_authorization(
        &self,
        record: &Value,
        limits: Value,
    ) -> Result<Value> {
        let p = policy(&limits)?;
        let kind = text(&record["plan"], "kind")?;
        let service = self.model_service()?;
        let connections = if p.channels == "configured" {
            service.authorization_connections(kind, true)?
        } else {
            vec![plan_connection(&service, &record["plan"])?]
        };
        ensure(
            connections.contains(&record["plan"]["connection"]),
            "revision_conflict",
            "原计划的模型渠道身份已变化，请先核对原计划。",
        )?;
        ensure(
            p.unrestricted
                || p.max_requests.is_some()
                || connections.iter().all(|c| c["channel"] != "custom"),
            "invalid_input",
            "自定义渠道无法核定金额，请提供请求数上限或明确完全授权。",
        )?;
        let mut proposal = json!({"limits":limits,"connections":connections});
        let history = history_path(&record["plan"]["task_ref"], kind, &p.operation_key)?;
        if self.store.exists(&history)? {
            let existing = self.store.json(&history)?;
            ensure(
                existing["limits"] == limits && existing["connections"] == proposal["connections"],
                "idempotency_conflict",
                "原授权键已绑定其他范围，请读取原授权。",
            )?;
            proposal["existing"] = existing;
        }
        Ok(proposal)
    }

    /// 由 MCP 宿主真实用户响应确认一次任务授权；后续计划在此范围内连续执行。
    pub(crate) fn confirm_task_model_authorization(
        &self,
        record: &Value,
        proposal: &Value,
        host: &str,
    ) -> Result<Value> {
        ensure(
            self.task_id.is_some()
                && self
                    .collaboration_grant
                    .as_ref()
                    .is_some_and(|g| g["client_adapter"] == host),
            "forbidden",
            "对话授权必须绑定当前获权任务。",
        )?;
        let _guard = self.store.lock()?;
        self.store.recover()?;
        let mut changes = Changes::new();
        let result = self.save_task_model_authorization(
            record,
            proposal,
            host,
            "mcp_elicitation",
            None,
            &mut changes,
        )?;
        self.stage_workspace_properties(&mut changes)?;
        self.store.transaction(&changes)?;
        Ok(result)
    }

    pub(super) fn register_conversation_model_authorization(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        ensure(
            !text(input, "authorization_note")?.trim().is_empty(),
            "invalid_input",
            "请记录当前对话中实际授权的范围。",
        )?;
        let record = self.model_plan(&input["task_ref"], text(input, "plan_id")?)?;
        let host = self
            .collaboration_grant
            .as_ref()
            .and_then(|g| g["client_adapter"].as_str())
            .ok_or_else(|| Error::new("forbidden", "对话额度登记必须使用当前获权任务连接。"))?;
        let proposal =
            self.prepare_task_model_authorization(&record, input["authorization"].clone())?;
        self.save_task_model_authorization(
            &record,
            &proposal,
            host,
            "agent_conversation",
            Some(text(input, "authorization_note")?),
            changes,
        )
    }

    fn save_task_model_authorization(
        &self,
        record: &Value,
        proposal: &Value,
        host: &str,
        channel: &str,
        note: Option<&str>,
        changes: &mut Changes,
    ) -> Result<Value> {
        let reference = &record["plan"]["task_ref"];
        let mut current = self.model_plan(reference, text(&record["plan"], "plan_id")?)?;
        ensure(
            current["plan_sha256"] == record["plan_sha256"],
            "revision_conflict",
            "确认期间计划已变化。",
        )?;
        let checked = self.prepare_task_model_authorization(record, proposal["limits"].clone())?;
        ensure(
            checked["connections"] == proposal["connections"],
            "revision_conflict",
            "确认期间模型渠道已变化，请在对话中重新确认范围。",
        )?;
        if !checked["existing"].is_null() {
            current["authorization"] = checked["existing"].clone();
            return Ok(current);
        }
        let authorization_id = id("authorization");
        let authorization = json!({
            "authorization_id":authorization_id,"task_ref":reference,"kind":record["plan"]["kind"],
            "limits":proposal["limits"],"connections":proposal["connections"],"requests_reserved":0,"credits_reserved":"0",
            "confirmation_channel":channel,"authorization_note":note,"host":host,"grant_revision":self.collaboration_grant.as_ref().unwrap()["grant_revision"],"created_at":now()
        });
        let operation_id = id("op");
        changes.insert(
            authorization_path(reference, text(&record["plan"], "kind")?)?,
            bytes(&authorization)?,
        );
        changes.insert(
            history_path(
                reference,
                text(&record["plan"], "kind")?,
                text(&proposal["limits"], "operation_key")?,
            )?,
            bytes(&authorization)?,
        );
        changes.insert(format!(".hetu/audit/{operation_id}.json"), bytes(&json!({
            "schema_version":"1.0.0","operation_id":operation_id,"action":"hetu.model_tasks.authorize_task",
            "actor_ref":self.actor(),"authorization":authorization,"status":"succeeded","created_at":now()
        }))?);
        current["authorization"] = authorization;
        Ok(current)
    }

    // 与 submitted 意图同一事务预留额度；未知请求保留预留，不换键重复消费。
    pub(super) fn reserve_model_authorization(
        &self,
        record: &mut Value,
        changes: &mut Changes,
    ) -> Result<()> {
        let retained_plan = record["plan"].clone();
        let plan = &retained_plan;
        let reference = &plan["task_ref"];
        let file = authorization_path(reference, text(plan, "kind")?)?;
        ensure(
            self.store.exists(&file)?,
            "hetu.author_confirmation_required",
            "请在当前 Agent 对话确认任务额度；可一次授权范围内连续生成。",
        )?;
        let mut authorization = self.store.json(&file)?;
        ensure(
            authorization["task_ref"] == *reference
                && authorization["kind"] == plan["kind"]
                && self.collaboration_grant.as_ref().is_some_and(|g| {
                    g["client_adapter"] == authorization["host"]
                        && g["grant_revision"] == authorization["grant_revision"]
                })
                && authorization["connections"]
                    .as_array()
                    .is_some_and(|items| items.contains(&plan["connection"])),
            "hetu.author_confirmation_required",
            "当前任务或渠道超出原对话授权，请在对话中重新确认范围。",
        )?;
        let limits = policy(&authorization["limits"])?;
        let requests = authorization["requests_reserved"]
            .as_u64()
            .ok_or_else(|| Error::new("hetu.integrity_failure", "授权请求计数损坏。"))?
            .checked_add(1)
            .ok_or_else(|| Error::new("hetu.budget_exceeded", "授权请求计数已满。"))?;
        let provider = plan["connection"]["channel"] == "custom";
        let amount = if provider {
            0
        } else {
            credits(&plan["estimated_credits"])?
        };
        let reserved = credits(&authorization["credits_reserved"])?
            .checked_add(amount)
            .ok_or_else(|| Error::new("hetu.budget_exceeded", "授权额度计数已满。"))?;
        ensure(
            limits.max_requests.is_none_or(|cap| requests <= cap)
                && limits
                    .max_credits
                    .as_ref()
                    .is_none_or(|cap| reserved <= cap.parse::<u128>().unwrap()),
            "hetu.model_authorization_exhausted",
            "本任务已达到对话授权额度上限，本次尚未提交；请在当前对话确认追加额度。",
        )?;
        let input = if provider {
            json!({"task_ref":reference,"plan_id":plan["plan_id"],"plan_sha256":record["plan_sha256"],"provider_billing_accepted":true})
        } else {
            json!({"task_ref":reference,"plan_id":plan["plan_id"],"plan_sha256":record["plan_sha256"],"max_credits":plan["estimated_credits"]})
        };
        *record = self.approve_model_plan_record(&input, changes)?;
        record["approval"]["authorization_id"] = authorization["authorization_id"].clone();
        record["approval"]["authorization_key"] = json!(&limits.operation_key);
        record["approval"]["actor_ref"] = json!(self.actor());
        record["approval"]["confirmation_channel"] = authorization["confirmation_channel"].clone();
        record["approval"]["host"] = authorization["host"].clone();
        authorization["requests_reserved"] = json!(requests);
        authorization["credits_reserved"] = json!(reserved.to_string());
        changes.insert(
            history_path(reference, text(plan, "kind")?, &limits.operation_key)?,
            bytes(&authorization)?,
        );
        changes.insert(file, bytes(&authorization)?);
        Ok(())
    }

    pub(super) fn release_model_authorization(
        &self,
        record: &mut Value,
        changes: &mut Changes,
    ) -> Result<()> {
        if record["approval"]["authorization_id"].is_null()
            || record["approval"]["reservation_released"] == true
            || !recovery::can_resume_after_recharge(&record["result"])
        {
            return Ok(());
        }
        let plan = &record["plan"];
        let reference = &plan["task_ref"];
        let history = history_path(
            reference,
            text(plan, "kind")?,
            text(&record["approval"], "authorization_key")?,
        )?;
        let mut authorization = self.store.json(&history)?;
        ensure(
            authorization["authorization_id"] == record["approval"]["authorization_id"],
            "hetu.integrity_failure",
            "原授权预留引用不一致。",
        )?;
        let requests = authorization["requests_reserved"]
            .as_u64()
            .and_then(|n| n.checked_sub(1))
            .ok_or_else(|| Error::new("hetu.integrity_failure", "授权预留请求数不一致。"))?;
        let amount = if plan["connection"]["channel"] == "custom" {
            0
        } else {
            credits(&plan["estimated_credits"])?
        };
        let reserved = credits(&authorization["credits_reserved"])?
            .checked_sub(amount)
            .ok_or_else(|| Error::new("hetu.integrity_failure", "原授权额度预留不一致。"))?;
        authorization["requests_reserved"] = json!(requests);
        authorization["credits_reserved"] = json!(reserved.to_string());
        changes.insert(history, bytes(&authorization)?);
        let current = authorization_path(reference, text(plan, "kind")?)?;
        if self.store.json(&current)?["authorization_id"] == authorization["authorization_id"] {
            changes.insert(current, bytes(&authorization)?);
        }
        record["approval"]["reservation_released"] = json!(true);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_unrestricted_and_finite_limits_are_distinct() {
        for limits in [
            json!({"max_requests":1}),
            json!({"max_credits":"1"}),
            json!({"max_requests":2,"max_credits":"24"}),
            json!({"unrestricted":true}),
        ] {
            let mut input = json!({"channels":"current","operation_key":"budget"});
            input
                .as_object_mut()
                .unwrap()
                .extend(limits.as_object().unwrap().clone());
            assert!(policy(&input).is_ok(), "{input}");
        }
        for limits in [
            json!({}),
            json!({"max_requests":0}),
            json!({"max_requests":-1}),
            json!({"max_requests":1.5}),
            json!({"max_credits":"0"}),
            json!({"max_credits":"01"}),
            json!({"max_credits":"-2"}),
            json!({"unrestricted":true,"max_requests":1}),
            json!({"approved":true}),
            json!({"channels":"arbitrary"}),
            json!({"operation_key":""}),
        ] {
            let mut input = json!({"channels":"current","operation_key":"budget"});
            input
                .as_object_mut()
                .unwrap()
                .extend(limits.as_object().unwrap().clone());
            assert!(policy(&input).is_err(), "{input}");
        }
    }
}
