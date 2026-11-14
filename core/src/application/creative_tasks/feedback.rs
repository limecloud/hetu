use super::*;

impl Kernel {
    pub(super) fn read_task_feedback(&self, task_ref: &Value, reference: &Value) -> Result<Value> {
        let (_, request_sha, state, _) = self.task_for_reference(task_ref)?;
        let refs = state["feedback_refs"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let index = refs
            .iter()
            .position(|r| r == reference)
            .ok_or_else(|| Error::new("not_found", "本任务没有指定的公开意见。"))?;
        let feedback_id = checked_id(text(reference, "feedback_id")?, "feedback")?;
        let raw = self.store.read(&format!(
            "{}/feedback/{feedback_id}.json",
            root(text(task_ref, "task_id")?)?
        ))?;
        ensure(
            reference["sha256"] == digest(&raw),
            "hetu.integrity_failure",
            "公开意见摘要不一致。",
        )?;
        let record: Value = serde_json::from_slice(&raw)?;
        record_schema(&record, "feedback_record")?;
        ensure(
            record["feedback_id"] == feedback_id
                && record["task_ref"] == *task_ref
                && record["request_sha256"] == request_sha
                && record["sequence"] == index + 1
                && record["previous_ref"]
                    == index
                        .checked_sub(1)
                        .map(|n| refs[n].clone())
                        .unwrap_or(Value::Null),
            "hetu.integrity_failure",
            "公开意见归属或前序不一致。",
        )?;
        Ok(record)
    }
    pub(super) fn check_feedback_refs(&self, task_ref: &Value, refs: &Value) -> Result<()> {
        for reference in refs.as_array().into_iter().flatten() {
            self.read_task_feedback(task_ref, reference)?;
        }
        Ok(())
    }
    fn check_feedback_target(&self, task_ref: &Value, target: &Value) -> Result<()> {
        match target["kind"].as_str() {
            Some("candidate") => {
                ensure(
                    target["candidate_ref"]["task_ref"] == *task_ref,
                    "forbidden",
                    "意见只能指向本任务的固定成果。",
                )?;
                self.task_candidate(&target["candidate_ref"])?;
            }
            Some("working_copy") => {
                self.working_revision(task_ref, &target["working_copy_ref"])?;
            }
            _ => return Err(Error::new("invalid_input", "意见目标类型无效。")),
        }
        Ok(())
    }
    pub(in crate::application) fn save_task_feedback(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let (task, sha, mut state, previous) = self.task_for_reference(&input["task_ref"])?;
        ensure(
            state["state"] != "closed",
            "forbidden",
            "已关闭任务不能追加意见。",
        )?;
        if !state["feedback_refs"].is_array() {
            state["feedback_refs"] = json!([]);
        }
        let refs = state["feedback_refs"].as_array().unwrap();
        let head = refs.last().cloned().unwrap_or(Value::Null);
        ensure(
            input["expected_feedback_head"] == head,
            "revision_conflict",
            "已有新的公开意见，请先读取。",
        )?;
        ensure(
            refs.len() < 100,
            "hetu.budget_exceeded",
            "任务公开意见达到上限。",
        )?;
        ensure(
            !text(input, "public_comment")?.trim().is_empty()
                && !text(input, "public_comment")?.contains('\0'),
            "invalid_input",
            "请填写有效的修改意见。",
        )?;
        for target in input["target_refs"].as_array().unwrap() {
            self.check_feedback_target(&input["task_ref"], target)?;
        }
        for selected in input["selected_refs"].as_array().unwrap() {
            ensure(
                input["target_refs"].as_array().unwrap().contains(selected),
                "invalid_input",
                "偏好必须属于本次意见的目标成果。",
            )?;
        }
        let decision = input
            .get("interaction_decision_ref")
            .cloned()
            .unwrap_or(Value::Null);
        if !decision.is_null() {
            let decision_id = checked_id(text(&decision, "decision_id")?, "decision")?;
            let raw = self.store.read(&format!(
                "{}/decisions/{decision_id}.json",
                root(text(&task, "task_id")?)?
            ))?;
            ensure(
                decision["sha256"] == digest(&raw),
                "hetu.integrity_failure",
                "局部选择摘要不一致。",
            )?;
            let record: Value = serde_json::from_slice(&raw)?;
            record_schema(&record, "decision_record")?;
            ensure(
                record["task_ref"] == input["task_ref"] && record["decision_id"] == decision_id,
                "forbidden",
                "局部选择不属于本任务。",
            )?;
        }
        let record = json!({"schema_version":"1.0.0","feedback_id":id("feedback"),"task_ref":input["task_ref"],"request_sha256":sha,"sequence":refs.len()+1,"previous_ref":head,"target_refs":input["target_refs"],"intent":input["intent"],"public_comment":input["public_comment"],"selected_refs":input["selected_refs"],"interaction_decision_ref":decision,"origin":if self.author {"native_author"} else {"task_interaction"},"created_at":now()});
        record_schema(&record, "feedback_record")?;
        let raw = bytes(&record)?;
        let reference = json!({"feedback_id":record["feedback_id"],"sha256":digest(&raw)});
        changes.insert(
            format!(
                "{}/feedback/{}.json",
                root(text(&task, "task_id")?)?,
                text(&record, "feedback_id")?
            ),
            raw,
        );
        state["feedback_refs"]
            .as_array_mut()
            .unwrap()
            .push(reference.clone());
        self.stage_task_state(&mut state, Some(&previous), changes)?;
        Ok(
            json!({"feedback":record,"feedback_ref":reference,"feedback_head":reference,"effect":"feedback_only","delivery_state":"not_requested"}),
        )
    }
    pub(in crate::application) fn list_task_feedback(&self, input: &Value) -> Result<Value> {
        let (task, _, state, _) = self.task_for_reference(&input["task_ref"])?;
        let mut handlings: Vec<(Value, Value)> = Vec::new();
        for reference in state["working_copy_refs"].as_array().into_iter().flatten() {
            let (copy, _, _) =
                self.working_head(&input["task_ref"], text(reference, "working_copy_id")?)?;
            let saved = self.working_revision(&input["task_ref"], &copy["current_revision_ref"])?;
            for revision in saved["history"].as_array().unwrap() {
                for feedback in revision["feedback_refs"].as_array().unwrap() {
                    handlings.push((feedback.clone(),json!({"kind":"working_copy","working_copy_ref":revision["working_copy_ref"]})));
                }
            }
        }
        for r in state["submission_refs"].as_array().unwrap() {
            let submission =
                self.read_submission(&task, &state, text(r, "submission_id")?, false)?;
            for feedback in submission["feedback_refs"].as_array().into_iter().flatten() {
                handlings.push((
                    feedback.clone(),
                    json!({"kind":"submission","submission_ref":r}),
                ));
            }
        }
        let mut records = Vec::new();
        for r in state["feedback_refs"].as_array().into_iter().flatten() {
            let record = self.read_task_feedback(&input["task_ref"], r)?;
            let results: Vec<_> = handlings
                .iter()
                .filter(|(f, _)| f == r)
                .map(|(_, result)| result.clone())
                .collect();
            records.push(json!({"feedback":record,"feedback_ref":r,"reported_result_refs":results,"author_acceptance":"not_implied"}));
        }
        // 通用游标绑定主体、完整输入和快照；反馈按 sequence 的生成顺序返回。
        let mut page_input = input.clone();
        if let Some(cursor) = page_input.as_object_mut().unwrap().remove("after_cursor") {
            page_input["cursor"] = cursor;
        }
        if page_input.get("limit").is_none() {
            page_input["limit"] = json!(20);
        }
        let mut result = self.ordered_record_page(&page_input, records, "feedback")?;
        result["feedback_head"] = state["feedback_refs"]
            .as_array()
            .and_then(|r| r.last())
            .cloned()
            .unwrap_or(Value::Null);
        Ok(result)
    }
}
