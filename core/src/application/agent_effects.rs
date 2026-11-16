//! 有独立副作用的固定方案。准备只读取，执行意图先落盘，恢复沿同一领域操作键继续。
use super::*;

impl Kernel {
    pub(super) fn preview_proposal_effect(&self, action: &str, input: &Value) -> Result<Value> {
        match action {
            "hetu.documents.export" | "hetu.bundles.export" => {
                self.validate_delivery_proposal(action, input)
            }
            "hetu.assets.import" => {
                domain::media::validate_metadata(input)?;
                let inspected = self.inspect_asset(input)?;
                ensure(
                    inspected["sha256"] == input["expected_file"]["sha256"]
                        && inspected["size_bytes"] == input["expected_file"]["size_bytes"],
                    "revision_conflict",
                    "素材文件已偏离检查结果。",
                )?;
                let mut metadata = input.clone();
                // 方案输入已固定原字节，预览不重复传输同一二进制内容。
                metadata.as_object_mut().unwrap().remove("inline_source");
                Ok(json!({"inspection":inspected,"metadata":metadata}))
            }
            "hetu.git.init" => {
                ensure(
                    git2::Reference::is_valid_name(&format!(
                        "refs/heads/{}",
                        text(input, "branch")?
                    )),
                    "invalid_input",
                    "分支名称无效。",
                )?;
                Ok(json!({"repository":self.git_status(input)?,"branch":input["branch"]}))
            }
            action if action.starts_with("hetu.git.") => {
                self.preview_git_collaboration(action, input)
            }
            _ => Err(Error::new(
                "hetu.capability_unavailable",
                "未开放此方案副作用。",
            )),
        }
    }

    pub(super) fn execute_proposal_effect(
        &self,
        input: &Value,
        metadata: &Value,
    ) -> Result<Option<Value>> {
        let action = "hetu.agent_operations.execute";
        let lock = self.store.lock()?;
        self.store.recover()?;
        self.check_task_session()?;
        ensure(
            digest(self.store.read(self.config_path())?) == self.config_sha,
            "revision_conflict",
            "作品配置已变化，请重新打开。",
        )?;
        let (proposal, mut state) = self.read_proposal(input)?;
        if proposal["fixed"]["effect"] != "deferred" {
            return Ok(None);
        }
        let key = text(input, "operation_key")?;
        let input_digest = Self::input_digest(input)?;
        let op_path = self.operation_record_path(action, key);
        if self.store.exists(&op_path)? {
            let previous = self.store.json(&op_path)?;
            ensure(
                previous["input_digest"] == input_digest,
                "idempotency_conflict",
                "原操作键已绑定其他方案。",
            )?;
            return Ok(Some(previous["result"].clone()));
        }
        let state_path = format!(
            ".hetu/agent-proposals/{}.state.json",
            checked_id(text(input, "proposal_id")?, "proposal")?
        );
        let target = text(&proposal["fixed"], "action")?;
        let arguments = &proposal["fixed"]["input"];
        if state["state"] == "approved" {
            let view = self.proposal_view(&proposal, &state)?;
            ensure(
                view["is_current"] == true,
                "revision_conflict",
                "作品基线已有变化，请重新准备方案。",
            )?;
            ensure(
                view["is_expired"] == false,
                "forbidden",
                "方案已过期，请重新准备。",
            )?;
            ensure(
                self.preview_proposal_effect(target, arguments)? == proposal["fixed"]["preview"],
                "revision_conflict",
                "方案依据已变化，请重新准备。",
            )?;
            state["state"] = json!("executing");
            state["revision"] = json!(
                integer(&state, "revision")?
                    .checked_add(1)
                    .ok_or_else(|| Error::new("hetu.budget_exceeded", "方案修订超过支持上限。"))?
            );
            self.store
                .transaction(&BTreeMap::from([(state_path.clone(), bytes(&state)?)]))?;
        }
        ensure(
            state["state"] == "executing" || state["state"] == "executed",
            "hetu.author_confirmation_required",
            "方案尚未批准或已拒绝。",
        )?;
        let mut changes = Changes::new();
        if state["state"] != "executed" {
            let result = if matches!(target, "hetu.documents.export" | "hetu.bundles.export") {
                drop(lock);
                let target_metadata = catalog()["actions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|item| item["name"] == target)
                    .unwrap();
                let response = self.execute_delivery(target, arguments, target_metadata)?;
                ensure(
                    response["status"] == "succeeded",
                    "result_unknown",
                    "交付仍在恢复中，请沿原方案与操作键继续。",
                )?;
                // 长事务不占用方案锁；完成后再次核对状态和授权。
                let _lock = self.store.lock()?;
                self.store.recover()?;
                self.check_task_session()?;
                let (_, latest) = self.read_proposal(input)?;
                ensure(
                    latest["state"] == "executing" || latest["state"] == "executed",
                    "hetu.integrity_failure",
                    "方案执行意图已变化。",
                )?;
                state = latest;
                state["result"] = response["data"].clone();
                return self
                    .complete_proposal_effect(
                        action,
                        input,
                        metadata,
                        &proposal,
                        state,
                        changes,
                        &op_path,
                        &input_digest,
                    )
                    .map(Some);
            } else if target.starts_with("hetu.git.") && target != "hetu.git.init" {
                self.execute_git_collaboration(
                    target,
                    arguments,
                    &proposal["fixed"]["preview"],
                    integer(&proposal["fixed"], "expires_at")? as i64 - 86400,
                )?
            } else {
                // 本地素材先持久化原字节，元数据和执行记录在同一事务公开。
                self.dispatch(target, arguments, &mut changes)?
            };
            state["result"] = result;
        }
        self.complete_proposal_effect(
            action,
            input,
            metadata,
            &proposal,
            state,
            changes,
            &op_path,
            &input_digest,
        )
        .map(Some)
    }

    fn complete_proposal_effect(
        &self,
        action: &str,
        input: &Value,
        metadata: &Value,
        proposal: &Value,
        mut state: Value,
        mut changes: Changes,
        op_path: &str,
        input_digest: &str,
    ) -> Result<Value> {
        if state["state"] != "executed" {
            state["state"] = json!("executed");
            state["revision"] = json!(
                integer(&state, "revision")?
                    .checked_add(1)
                    .ok_or_else(|| Error::new("hetu.budget_exceeded", "方案修订超过支持上限。"))?
            );
            state["executed_by"] = json!(self.actor());
            state["executed_at"] = json!(now());
        }
        let path = format!(
            ".hetu/agent-proposals/{}.state.json",
            text(input, "proposal_id")?
        );
        changes.insert(path, bytes(&state)?);
        let mut output =
            domain::success(action, self.scope(), self.proposal_view(proposal, &state)?);
        output["contract_revision"] = metadata["contract_revision"].clone();
        let operation = Self::operation(text(input, "operation_key")?, input_digest);
        output["operation"] = operation.clone();
        changes.insert(op_path.to_owned(), bytes(&json!({"operation_id":operation["id"],"action":action,"key":input["operation_key"],
            "input_digest":input_digest,"actor_scope":if self.author { "author" } else { "agent" },"result":output}))?);
        changes.insert(format!(".hetu/audit/{}.json",text(&operation,"id")?), bytes(&json!({"schema_version":"1.0.0","operation_id":operation["id"],"action":action,
            "actor_ref":self.actor(),"input_digest":input_digest,"created_at":now(),"status":"succeeded"}))?);
        self.stage_workspace_properties(&mut changes)?;
        self.store.transaction(&changes)?;
        Ok(output)
    }
}
