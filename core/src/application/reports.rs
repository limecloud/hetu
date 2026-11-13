use super::*;

impl Kernel {
    pub(super) fn run_validation(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let plot = self.read_plot(text(input, "plot_revision_id")?)?;
        let descriptor = self.plot_descriptor(&plot.plot_revision_id)?;
        let (bp, _) = self.blueprint_revision(Some(plot.blueprint_revision))?;
        let sources = serde_json::to_value(&plot.source_revisions)?;
        let documents = self.plot_documents(sources.as_array().unwrap())?;
        let report = validation::run(
            &plot,
            &bp,
            &documents,
            text(&descriptor, "sha256")?,
            serde_json::from_value(input["options"].clone())?,
            self.actor(),
        )?;
        let saved = input["save_report"] == true;
        if saved {
            self.stage_report(&report, &bp, changes)?;
        }
        self.report_result(&report, saved)
    }
    pub(super) fn stage_report(
        &self,
        report: &Value,
        bp: &Value,
        changes: &mut Changes,
    ) -> Result<()> {
        self.store.directory("packages/drama/reports")?;
        self.store.directory(".hetu/reports")?;
        let path = format!("packages/drama/reports/{}.json", text(report, "report_id")?);
        let record_path = format!(".hetu/reports/{}.json", text(report, "report_id")?);
        ensure(
            !self.store.exists(&path)? && !self.store.exists(&record_path)?,
            "hetu.integrity_failure",
            "诊断报告已存在，不能覆盖。",
        )?;
        let content = serde_json::to_vec(&report)?;
        let descriptor = Self::report_summary(report, &path, &digest(&content));
        stage_blueprint_snapshot(&self.store, bp, changes)?;
        changes.insert(path, content);
        changes.insert(record_path, bytes(&descriptor)?);
        Ok(())
    }
    fn report_summary(report: &Value, path: &str, sha: &str) -> Value {
        json!({"schema_version":"1.0.0","report_id":report["report_id"],"input_snapshot":report["input_snapshot"],"status":report["status"],"created_at":report["created_at"],"finding_count":report["findings"].as_array().unwrap().len(),"counts":report["coverage"]["counts"],"path":path,"sha256":sha})
    }
    pub(super) fn report_descriptor(&self, report_id: &str) -> Result<Value> {
        checked_id(report_id, "report")?;
        ensure(
            self.store.entries(".hetu")?.iter().any(|n| n == "reports"),
            "not_found",
            "没有保存该诊断报告。",
        )?;
        let record = self
            .store
            .json(&format!(".hetu/reports/{report_id}.json"))?;
        ensure(
            record["schema_version"] == "1.0.0"
                && record["report_id"] == report_id
                && record["path"] == format!("packages/drama/reports/{report_id}.json"),
            "hetu.integrity_failure",
            "诊断报告索引身份或路径不一致。",
        )?;
        Ok(record)
    }
    pub(super) fn read_report(&self, report_id: &str) -> Result<Value> {
        let descriptor = self.report_descriptor(report_id)?;
        let content = self.store.read(text(&descriptor, "path")?)?;
        ensure(
            content.len() <= validation::OUTPUT_LIMIT && descriptor["sha256"] == digest(&content),
            "hetu.integrity_failure",
            "诊断历史报告已被改写，停止使用该证据。",
        )?;
        let report: Value = serde_json::from_slice(&content)?;
        validation::validate(&report)?;
        ensure(
            descriptor
                == Self::report_summary(&report, text(&descriptor, "path")?, &digest(&content)),
            "hetu.integrity_failure",
            "诊断索引与报告不一致。",
        )?;
        let snapshot = &report["input_snapshot"];
        let plot = self.read_plot(text(snapshot, "plot_revision_id")?)?;
        let plot_record = self.plot_descriptor(&plot.plot_revision_id)?;
        ensure(
            snapshot["plot_sha256"] == plot_record["sha256"]
                && snapshot["blueprint_revision"] == plot.blueprint_revision
                && snapshot["blueprint_sha256"] == plot.blueprint_sha256
                && snapshot["source_revisions"] == serde_json::to_value(&plot.source_revisions)?,
            "hetu.integrity_failure",
            "诊断报告的固定输入与原始证据不一致。",
        )?;
        Ok(report)
    }
    pub(super) fn report_result(&self, report: &Value, saved: bool) -> Result<Value> {
        let plot = self.read_plot(text(&report["input_snapshot"], "plot_revision_id")?)?;
        let state = self.plot_result(&plot, true)?;
        let mut reasons = state["stale_reasons"].as_array().unwrap().clone();
        for name in self.store.entries(".hetu/plots")? {
            let revision = name
                .strip_suffix(".json")
                .ok_or_else(|| Error::new("hetu.integrity_failure", "剧情索引名称无效。"))?;
            let item = self.plot_descriptor(revision)?;
            if item["parent_plot_revision_id"] == plot.plot_revision_id {
                reasons.push(json!({"code":"plot_corrected","plot_revision_id":plot.plot_revision_id,"new_plot_revision_id":revision}));
                break;
            }
        }
        let mut dispositions = Vec::new();
        if saved {
            for finding in report["findings"].as_array().unwrap() {
                let records = self.disposition_history(
                    text(report, "report_id")?,
                    text(finding, "finding_id")?,
                )?;
                if let Some(latest) = records.last() {
                    dispositions.push(json!({"finding_id":finding["finding_id"],"current":latest,"history":records}));
                }
            }
        }
        let reference = if saved {
            json!({"report_id":report["report_id"],"sha256":digest(serde_json::to_vec(report)?),"dispositions_sha256":digest(bytes(&json!(dispositions))?)})
        } else {
            Value::Null
        };
        Ok(json!({"report":report,"reference":reference,"saved":saved,"stale":!reasons.is_empty(),"stale_reasons":reasons,"dispositions":dispositions}))
    }
    pub(super) fn list_reports(&self, input: &Value) -> Result<Value> {
        let filter = input.get("plot_revision_id").and_then(Value::as_str);
        if let Some(revision) = filter {
            self.plot_descriptor(revision)?;
        }
        let mut records = Vec::new();
        if self.store.entries(".hetu")?.iter().any(|n| n == "reports") {
            for name in self.store.entries(".hetu/reports")? {
                let id = name
                    .strip_suffix(".json")
                    .ok_or_else(|| Error::new("hetu.integrity_failure", "报告索引名称无效。"))?;
                let record = self.report_descriptor(id)?;
                if filter.is_none_or(|p| record["input_snapshot"]["plot_revision_id"] == p) {
                    records.push(record);
                }
            }
        }
        records.sort_by(|a, b| {
            b["created_at"]
                .as_str()
                .cmp(&a["created_at"].as_str())
                .then_with(|| b["report_id"].as_str().cmp(&a["report_id"].as_str()))
        });
        let fingerprint = digest(serde_json::to_vec(
            &json!({"scope":self.scope(),"plot_revision_id":filter,"records":records}),
        )?);
        let start = if let Some(cursor) = input.get("cursor").and_then(Value::as_str) {
            let (hash, offset) = cursor
                .split_once(':')
                .ok_or_else(|| Error::new("cursor_invalid", "分页游标无效。"))?;
            let offset = offset
                .parse::<usize>()
                .map_err(|_| Error::new("cursor_invalid", "分页游标无效。"))?;
            ensure(
                hash == fingerprint && offset > 0 && offset < records.len(),
                "cursor_invalid",
                "报告列表已变化，请重新查询。",
            )?;
            offset
        } else {
            0
        };
        let end = start
            .saturating_add(input["limit"].as_u64().unwrap_or(50) as usize)
            .min(records.len());
        Ok(
            json!({"reports":&records[start..end],"next_cursor":(end < records.len()).then(||format!("{fingerprint}:{end}"))}),
        )
    }
    fn disposition_history(&self, report_id: &str, finding_id: &str) -> Result<Vec<Value>> {
        checked_id(finding_id, "finding")?;
        let index = format!(".hetu/finding-dispositions/{finding_id}.json");
        if !self
            .store
            .entries(".hetu")?
            .iter()
            .any(|n| n == "finding-dispositions")
            || !self.store.exists(&index)?
        {
            return Ok(vec![]);
        }
        let head = self.store.json(&index)?;
        ensure(
            head["report_id"] == report_id && head["finding_id"] == finding_id,
            "hetu.integrity_failure",
            "问题处置的归属不一致。",
        )?;
        let revision = integer(&head, "revision")?;
        ensure(
            revision > 0 && revision <= 10000,
            "hetu.integrity_failure",
            "问题处置修订无效。",
        )?;
        let mut history = Vec::new();
        let mut previous_sha = Value::Null;
        for number in 1..=revision {
            let path = format!("packages/drama/reports/dispositions/{finding_id}.{number}.json");
            let content = self.store.read(&path)?;
            let item: Value = serde_json::from_slice(&content)?;
            ensure(
                item["schema_version"] == "1.0.0"
                    && item["report_id"] == report_id
                    && item["finding_id"] == finding_id
                    && item["revision"] == number
                    && item["previous_sha256"] == previous_sha,
                "hetu.integrity_failure",
                "问题处置历史链不完整。",
            )?;
            previous_sha = json!(digest(&content));
            history.push(item);
        }
        ensure(
            head["sha256"] == previous_sha,
            "hetu.integrity_failure",
            "问题处置历史摘要不一致。",
        )?;
        Ok(history)
    }
    pub(super) fn disposition(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let report_id = text(input, "report_id")?;
        let finding_id = text(input, "finding_id")?;
        let report = self.read_report(report_id)?;
        let finding = report["findings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["finding_id"] == finding_id)
            .ok_or_else(|| Error::new("not_found", "问题不属于指定报告。"))?;
        ensure(
            report["input_snapshot"] == input["expected_inputs"],
            "hetu.stale_evidence",
            "处置依据与报告固定输入不一致。",
        )?;
        ensure(
            !text(input, "reason")?.trim().is_empty(),
            "invalid_input",
            "请填写问题处置理由。",
        )?;
        ensure(
            input["disposition"] != "accepted_exception"
                || finding["exception_policy"] == "author_review",
            "forbidden",
            "该规则不允许作者接受例外。",
        )?;
        let history = self.disposition_history(report_id, finding_id)?;
        ensure(
            history.len() as u64 == integer(input, "expected_disposition_revision")?,
            "revision_conflict",
            "问题处置已被更新，请重新读取。",
        )?;
        ensure(
            history.len() < 10000,
            "hetu.budget_exceeded",
            "问题处置历史超过上限。",
        )?;
        let revision = history.len() + 1;
        let previous_sha = if history.is_empty() {
            Value::Null
        } else {
            self.store
                .json(&format!(".hetu/finding-dispositions/{finding_id}.json"))?["sha256"]
                .clone()
        };
        let item = json!({"schema_version":"1.0.0","report_id":report_id,"finding_id":finding_id,"revision":revision,"expected_inputs":report["input_snapshot"],"disposition":input["disposition"],"reason":input["reason"],"actor_ref":self.actor(),"created_at":now(),"previous_sha256":previous_sha});
        let content = bytes(&item)?;
        let path = format!("packages/drama/reports/dispositions/{finding_id}.{revision}.json");
        self.store
            .directory("packages/drama/reports/dispositions")?;
        self.store.directory(".hetu/finding-dispositions")?;
        ensure(
            !self.store.exists(&path)?,
            "hetu.integrity_failure",
            "问题处置修订已存在。",
        )?;
        let head = json!({"report_id":report_id,"finding_id":finding_id,"revision":revision,"sha256":digest(&content)});
        changes.insert(path, content);
        changes.insert(
            format!(".hetu/finding-dispositions/{finding_id}.json"),
            bytes(&head)?,
        );
        Ok(json!({"disposition_record":item}))
    }
}
