use super::*;

fn check_text_range(content: &str, range: &Value) -> Result<()> {
    let start = range["byte_start"]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok());
    let end = range["byte_end"]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok());
    let quote = range["quote"].as_str();
    ensure(
        start
            .zip(end)
            .zip(quote)
            .is_some_and(|((start, end), quote)| {
                end > start
                    && end - start <= 16 * 1024
                    && quote.len() == end - start
                    && content.get(start..end) == Some(quote)
            }),
        "hetu.invalid_source_ref",
        "意见选区必须位于原文UTF-8边界，与原句一致且不超过16 KiB。",
    )
}

fn check_image_region(candidate: &Value, region: &Value) -> Result<()> {
    ensure(
        candidate["kind"] == "image",
        "hetu.invalid_source_ref",
        "图片区域只能指向固定图片候选。",
    )?;
    let x = region["x"].as_u64();
    let y = region["y"].as_u64();
    let width = region["width"].as_u64();
    let height = region["height"].as_u64();
    ensure(
        x.zip(y)
            .zip(width.zip(height))
            .is_some_and(|((x, y), (width, height))| {
                width > 0
                    && height > 0
                    && x.checked_add(width)
                        .zip(candidate["width"].as_u64())
                        .is_some_and(|(end, limit)| end <= limit)
                    && y.checked_add(height)
                        .zip(candidate["height"].as_u64())
                        .is_some_and(|(end, limit)| end <= limit)
            }),
        "hetu.invalid_source_ref",
        "图片区域必须位于原图像素边界内，且宽高为正整数。",
    )
}

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
                let candidate = self.task_candidate(&target["candidate_ref"])?;
                if let Some(region) = target.get("image_region") {
                    check_image_region(&candidate, region)?;
                }
                if let Some(range) = target.get("range") {
                    check_text_range(text(&candidate, "content")?, range)?;
                }
            }
            Some("working_copy") => {
                let revision = self.working_revision(task_ref, &target["working_copy_ref"])?;
                if let Some(range) = target.get("range") {
                    check_text_range(text(&revision["revision"], "content")?, range)?;
                }
            }
            Some("context") => {
                let range = &target["range"];
                let quote = text(range, "quote")?;
                ensure(
                    !quote.is_empty() && quote.len() <= 16 * 1024,
                    "hetu.budget_exceeded",
                    "意见原句不能为空或超过16 KiB。",
                )?;
                let source = self.read_task_context(&json!({"task_ref":task_ref,"context_ref":target["context_ref"],
                    "range":{"byte_start":range["byte_start"],"byte_end":range["byte_end"]},"max_bytes":16*1024}))?;
                ensure(
                    source["complete"] == true && source["content"] == quote,
                    "hetu.invalid_source_ref",
                    "意见选区与本任务固定的文本来源不一致。",
                )?;
                let start = range["byte_start"].as_u64().unwrap_or(u64::MAX);
                let end = range["byte_end"].as_u64().unwrap_or(0);
                ensure(
                    end > start && end - start == quote.len() as u64,
                    "hetu.invalid_source_ref",
                    "意见选区与原句的UTF-8长度不一致。",
                )?;
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
        let targets = input["target_refs"].as_array().unwrap();
        let version = if targets
            .iter()
            .any(|target| target.get("image_region").is_some())
        {
            "1.2.0"
        } else if input["target_refs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|target| target.get("range").is_some())
        {
            "1.1.0"
        } else {
            "1.0.0"
        };
        let record = json!({"schema_version":version,"feedback_id":id("feedback"),"task_ref":input["task_ref"],"request_sha256":sha,"sequence":refs.len()+1,"previous_ref":head,"target_refs":input["target_refs"],"intent":input["intent"],"public_comment":input["public_comment"],"selected_refs":input["selected_refs"],"interaction_decision_ref":decision,"origin":if self.author {"native_author"} else {"task_interaction"},"created_at":now()});
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
        if let Some(reference) = input.get("feedback_ref") {
            self.read_task_feedback(&input["task_ref"], reference)?;
        }
        if let Some(candidate) = input.get("candidate_ref") {
            ensure(
                candidate["task_ref"] == input["task_ref"],
                "forbidden",
                "意见筛选只能读取本任务的固定候选。",
            )?;
            let submission =
                self.read_submission(&task, &state, text(candidate, "submission_id")?, false)?;
            ensure(
                submission["candidates"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|item| item["candidate_id"] == candidate["candidate_id"]),
                "not_found",
                "此批次没有指定的意见候选。",
            )?;
        }
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
            if input
                .get("feedback_ref")
                .is_some_and(|reference| reference != r)
            {
                continue;
            }
            let record = self.read_task_feedback(&input["task_ref"], r)?;
            if let Some(candidate) = input.get("candidate_ref")
                && !record["target_refs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|target| {
                        target["kind"] == "candidate" && target["candidate_ref"] == *candidate
                    })
            {
                continue;
            }
            let results: Vec<_> = handlings
                .iter()
                .filter(|(f, _)| f == r)
                .map(|(_, result)| result.clone())
                .collect();
            records.push(json!({"feedback":record,"feedback_ref":r,"reported_result_refs":results,"author_acceptance":"not_implied"}));
        }
        // 通用游标绑定主体、完整输入和快照；反馈按 sequence 的生成顺序返回。
        let mut page_input = input.clone();
        for field in [
            "result_path",
            "offset",
            "max_bytes",
            "expected_result_sha256",
        ] {
            page_input.as_object_mut().unwrap().remove(field);
        }
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
        if input.get("result_path").is_some() {
            let sha = digest(bytes(&result)?);
            ensure(
                input
                    .get("expected_result_sha256")
                    .is_none_or(|expected| expected == &sha),
                "hetu.stale_evidence",
                "意见或返稿已变化，请重新读取，不拼接不同快照。",
            )?;
            let page = crate::machine::value_page(&result, input)?;
            return Ok(json!({"feedback_page":page,"feedback_page_sha256":sha}));
        }
        Ok(result)
    }
}
