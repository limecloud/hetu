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
        let evidence = |item: &Value| -> Result<()> {
            match text(item, "kind")? {
                "context" => {
                    find(&item["reference"])?;
                }
                "working_copy" => {
                    self.working_revision(&input["task_ref"], &item["reference"])?;
                }
                "feedback" => {
                    self.check_feedback_refs(&input["task_ref"], &json!([item["reference"]]))?;
                }
                _ => return Err(Error::new("invalid_input", "接续依据类型无效。")),
            }
            Ok(())
        };
        let statements = note["statements"].as_array().unwrap();
        let mut identifiers = BTreeSet::new();
        for statement in statements {
            if let Some(identifier) = statement["statement_id"].as_str() {
                checked_id(identifier, "statement")?;
                ensure(
                    identifiers.insert(identifier),
                    "invalid_input",
                    "接续说明标识重复。",
                )?;
            }
            for key in ["supporting", "contradicting"] {
                for item in statement[key].as_array().into_iter().flatten() {
                    evidence(item)?;
                }
            }
            let opposed = statement["supporting"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|item| {
                    statement["contradicting"]
                        .as_array()
                        .is_some_and(|items| items.contains(item))
                });
            ensure(
                !opposed,
                "invalid_input",
                "同一依据不能同时列为支持和反证。",
            )?;
            if statement.get("supporting").is_some() || statement.get("contradicting").is_some() {
                ensure(
                    statement["statement_id"].is_string(),
                    "invalid_input",
                    "正反依据必须绑定稳定说明标识。",
                )?;
                if statement["kind"] == "hypothesis"
                    && matches!(statement["status"].as_str(), Some("supported" | "refuted"))
                {
                    let key = if statement["status"] == "supported" {
                        "supporting"
                    } else {
                        "contradicting"
                    };
                    ensure(
                        statement[key]
                            .as_array()
                            .is_some_and(|items| !items.is_empty()),
                        "invalid_input",
                        "假设状态须有对应方向的固定依据。",
                    )?;
                }
            }
        }
        for old in current["checkpoint"]["statements"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if old["statement_id"].is_string() {
                let updated = statements
                    .iter()
                    .find(|s| s["statement_id"] == old["statement_id"])
                    .ok_or_else(|| {
                        Error::new(
                            "hetu.stale_schema",
                            "不能裁掉已有稳定说明；请保留其标识并更新状态。",
                        )
                    })?;
                ensure(
                    updated["kind"] == old["kind"],
                    "invalid_input",
                    "稳定说明不能更换种类。",
                )?;
                for key in ["supporting", "contradicting"] {
                    ensure(
                        old.get(key).is_none() || updated.get(key).is_some(),
                        "hetu.stale_schema",
                        "不能裁掉已有正反依据结构。",
                    )?;
                }
                if updated["prediction"] != old["prediction"]
                    && matches!(updated["status"].as_str(), Some("supported" | "refuted"))
                {
                    ensure(
                        updated["supporting"] != old["supporting"]
                            || updated["contradicting"] != old["contradicting"],
                        "invalid_input",
                        "预测变化后应重新检验或提交新的方向依据。",
                    )?;
                }
            }
        }
        let mut issue_ids = BTreeSet::new();
        for issue in note["issues"].as_array().into_iter().flatten() {
            let identifier = checked_id(text(issue, "issue_id")?, "issue")?;
            ensure(
                issue_ids.insert(identifier),
                "invalid_input",
                "未决问题标识重复。",
            )?;
            for identifier in issue["statement_ids"].as_array().unwrap() {
                ensure(
                    identifier
                        .as_str()
                        .is_some_and(|id| identifiers.contains(id)),
                    "invalid_input",
                    "问题引用的稳定说明不存在。",
                )?;
            }
            for item in issue["resolution"].as_array().unwrap() {
                evidence(item)?;
            }
            if issue["scope"] == "professional" {
                let index = find(&issue["owner_context_ref"])?;
                ensure(
                    sources[index]["kind"] == "plugin_object",
                    "invalid_input",
                    "专业问题须指回本任务固定的原Owner对象。",
                )?;
                let fixed =
                    self.fixed_context_source(&request["input_snapshot"]["sources"][index])?;
                let owner = &fixed["plugin_object"];
                ensure(
                    owner["owner_plugin_id"] == "org.wordflowlab.novel-review"
                        && owner["kind"] == "novel_review",
                    "hetu.capability_unavailable",
                    "此专业Owner的问题引用尚无宿主适配，请沿原插件继续。",
                )?;
                ensure(
                    owner["content"]["issues"].as_array().is_some_and(|rows| {
                        rows.iter().any(|row| row["id"] == issue["owner_item_id"])
                    }),
                    "not_found",
                    "原Owner的固定修订中不存在此问题标识。",
                )?;
            }
        }
        ensure(
            current["checkpoint"].get("issues").is_none() || note.get("issues").is_some(),
            "hetu.stale_schema",
            "不能裁掉未决问题结构。",
        )?;
        for old in current["checkpoint"]["issues"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let updated = note["issues"]
                .as_array()
                .unwrap()
                .iter()
                .find(|i| i["issue_id"] == old["issue_id"])
                .ok_or_else(|| {
                    Error::new(
                        "hetu.stale_schema",
                        "不能删除已有问题标识；请明确解决、放弃或接续原Owner。",
                    )
                })?;
            ensure(
                updated["scope"] == old["scope"],
                "invalid_input",
                "问题不能改变专业归属。",
            )?;
            if old["scope"] == "professional" {
                ensure(
                    updated["owner_item_id"] == old["owner_item_id"],
                    "forbidden",
                    "专业接续不能替换原问题标识。",
                )?;
                let before = find(&old["owner_context_ref"])?;
                let after = find(&updated["owner_context_ref"])?;
                for key in ["owner_plugin_id", "object_id", "work_ref"] {
                    ensure(
                        sources[before]["fixed_ref"][key] == sources[after]["fixed_ref"][key],
                        "forbidden",
                        "专业问题必须接续原Owner对象。",
                    )?;
                }
            }
        }
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
            if let Some(references) = statement["working_copy_refs"].as_array() {
                for reference in references {
                    self.working_revision(&input["task_ref"], reference)?;
                }
            }
            if statement.get("feedback_refs").is_some() {
                self.check_feedback_refs(&input["task_ref"], &statement["feedback_refs"])?;
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
