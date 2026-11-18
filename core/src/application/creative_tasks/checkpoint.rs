//! 可恢复的任务交接；只核验固定引用，不把Agent说明升级为作品事实。
use super::*;

impl Kernel {
    pub(in crate::application) fn get_task_checkpoint(&self, input: &Value) -> Result<Value> {
        let (_, _, state, _) = self.task_for_reference(&input["task_ref"])?;
        let Some(reference) = state.get("checkpoint_ref") else {
            return Ok(json!({"checkpoint":null,"expected":null,"authority":"agent_notes"}));
        };
        let folder = root(text(&input["task_ref"], "task_id")?)?;
        let revision = integer(reference, "revision")?;
        ensure(
            revision <= 1000,
            "hetu.integrity_failure",
            "接续历史超过上限。",
        )?;
        let mut sha = text(reference, "sha256")?.to_owned();
        let mut head = Value::Null;
        for number in (1..=revision).rev() {
            let raw = self
                .store
                .read(&format!("{folder}/checkpoints/{number}.json"))?;
            let record: Value = serde_json::from_slice(&raw)?;
            record_schema(&record, "checkpoint_record")?;
            ensure(
                digest(&raw) == sha
                    && record["task_ref"] == input["task_ref"]
                    && record["revision"] == number,
                "hetu.integrity_failure",
                "接续记录归属或历史摘要不一致。",
            )?;
            if number == revision {
                head = record.clone();
            }
            if number == 1 {
                ensure(
                    record["previous_sha256"].is_null(),
                    "hetu.integrity_failure",
                    "接续首修订前序无效。",
                )?;
            } else {
                sha = text(&record, "previous_sha256")?.to_owned();
            }
        }
        let checkpoint = head["checkpoint"].clone();
        head.as_object_mut().unwrap().remove("checkpoint");
        Ok(
            json!({"checkpoint":checkpoint,"record_metadata":head,"expected":reference,"authority":"agent_notes",
            "coverage_authority":"agent_reported_ranges_validated","semantic_reading":"agent_reported_not_verified"}),
        )
    }

    pub(in crate::application) fn save_task_checkpoint(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let (request, _, mut state, previous) = self.task_for_reference(&input["task_ref"])?;
        ensure(
            state["state"] != "closed",
            "forbidden",
            "已关闭任务不能保存接续。",
        )?;
        let current = self.get_task_checkpoint(input)?;
        ensure(
            input["expected"] == current["expected"],
            "revision_conflict",
            "接续记录已变化，请保留本次内容并比较。",
        )?;
        let note = &input["checkpoint"];
        ensure(
            bytes(note)?.len() <= 16 * 1024,
            "hetu.budget_exceeded",
            "接续说明超过16KiB，请保留固定引用。",
        )?;
        for reference in note["working_copy_refs"].as_array().unwrap() {
            self.working_revision(&input["task_ref"], reference)?;
        }
        self.check_feedback_refs(&input["task_ref"], &note["feedback_refs"])?;
        let sources = entries(&request);
        let find = |reference: &Value| -> Result<usize> {
            sources
                .iter()
                .position(|s| {
                    s["context_id"] == reference["context_id"] && s["sha256"] == reference["sha256"]
                })
                .ok_or_else(|| Error::new("forbidden", "接续来源不属于本任务固定资料。"))
        };
        for coverage in note["coverage"].as_array().unwrap() {
            let index = find(&coverage["context_ref"])?;
            let source = self.fixed_context_source(&request["input_snapshot"]["sources"][index])?;
            let ranges = coverage["ranges"].as_array().unwrap();
            if coverage["status"] == "unread" {
                ensure(
                    ranges.is_empty(),
                    "invalid_input",
                    "未读资料不能声明阅读范围。",
                )?;
            }
            for range in ranges {
                let content = source["content"]
                    .as_str()
                    .ok_or_else(|| Error::new("invalid_input", "结构化资料不接受文本范围。"))?;
                let start = integer(range, "byte_start")? as usize;
                let end = integer(range, "byte_end")? as usize;
                ensure(
                    start < end && content.get(start..end).is_some(),
                    "invalid_input",
                    "接续阅读范围须位于固定UTF-8文本内。",
                )?;
            }
        }
        for statement in note["statements"].as_array().unwrap() {
            for reference in statement["context_refs"].as_array().unwrap() {
                find(reference)?;
            }
        }
        for operation in note["pending_operations"].as_array().unwrap() {
            ensure(
                TASK_ACTIONS.contains(&text(operation, "action")?),
                "forbidden",
                "待查询操作必须属于本任务动作。",
            )?;
        }
        let revision = current["expected"]["revision"].as_u64().unwrap_or(0) + 1;
        ensure(
            revision <= 1000,
            "hetu.budget_exceeded",
            "接续历史达到上限。",
        )?;
        let record = json!({"schema_version":"1.0.0","task_ref":input["task_ref"],"revision":revision,
            "previous_sha256":current["expected"].get("sha256"),"checkpoint":note,"updated_at":now()});
        record_schema(&record, "checkpoint_record")?;
        let raw = bytes(&record)?;
        let reference = json!({"revision":revision,"sha256":digest(&raw)});
        let folder = format!(
            "{}/checkpoints",
            root(text(&input["task_ref"], "task_id")?)?
        );
        self.store.directory(&folder)?;
        let path = format!("{folder}/{revision}.json");
        ensure(
            !self.store.exists(&path)?,
            "hetu.integrity_failure",
            "不能覆盖接续历史。",
        )?;
        changes.insert(path, raw);
        state["checkpoint_ref"] = reference.clone();
        self.stage_task_state(&mut state, Some(&previous), changes)?;
        Ok(
            json!({"checkpoint":note,"record":record,"expected":reference,"authority":"agent_notes",
            "coverage_authority":"agent_reported_ranges_validated","semantic_reading":"agent_reported_not_verified"}),
        )
    }
}
