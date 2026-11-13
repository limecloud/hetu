use super::*;
use std::collections::BTreeSet;

impl Kernel {
    pub(super) fn begin_review(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let value = self.draft_content(text(input, "draft_id")?)?;
        let mut draft = value["draft"].clone();
        ensure(
            draft["revision"] == input["expected_draft_revision"],
            "revision_conflict",
            "草稿状态已变化，请重新读取。",
        )?;
        ensure(
            matches!(draft["state"].as_str(), Some("submitted" | "in_review")),
            "revision_conflict",
            "该草稿不能进入审核，请查看已有决定或提交返工稿。",
        )?;
        if draft.get("evidence_document_id").is_none() {
            draft["size_bytes"] = json!(text(&value, "content")?.len());
            self.anchor_draft(&mut draft, changes)?;
        }
        if draft["state"] != "in_review" {
            draft["revision"] = json!(integer(&draft, "revision")? + 1);
            draft["state"] = json!("in_review");
        }
        self.stage_draft(&draft, changes)?;
        Ok(json!({"draft":draft}))
    }
    fn review_snapshot(&self, draft: &Value) -> Result<Value> {
        let bp = self.blueprint()?;
        let (_, sha) = self.blueprint_revision(Some(integer(draft, "blueprint_revision")?))?;
        let mut target = Value::Null;
        if let Some(doc) = draft
            .get("target_document_id")
            .or_else(|| draft.get("approved_document_id"))
            .and_then(Value::as_str)
        {
            let current = self.document_content(doc, None)?;
            let base = draft
                .get("base_revision_id")
                .unwrap_or(&draft["approved_revision_id"]);
            let fixed = self.document_content(doc, base.as_str())?;
            target = json!({"document_id":doc,"base_revision_id":base,"base_sha256":fixed["revision"]["sha256"],"current_revision_id":current["revision"]["revision_id"],"approved_revision_id":current["document"]["approved_revision_id"]});
        }
        let mut skeleton = Value::Null;
        if let Some(reference) = draft.get("skeleton_ref") {
            let (fixed, digest) = self.read_skeleton(
                text(reference, "skeleton_id")?,
                Some(integer(reference, "revision")?),
            )?;
            ensure(
                reference["sha256"] == digest,
                "hetu.integrity_failure",
                "草稿固定骨架摘要不一致。",
            )?;
            skeleton = json!({"skeleton_ref":reference,"current_revision":self.skeleton_descriptor(&fixed.skeleton_id,None)?["revision"],"source_state":self.skeleton_result(&fixed,&digest)?});
            // 快照只保存来源当前性，骨架本体由固定引用读取。
            skeleton["source_state"]
                .as_object_mut()
                .unwrap()
                .remove("skeleton");
        }
        let submission_sha = if draft.get("evidence_document_id").is_some() {
            self.store.json(&format!(
                ".hetu/draft-submissions/{}.json",
                text(draft, "draft_id")?
            ))?["sha256"]
                .clone()
        } else {
            Value::Null
        };
        Ok(
            json!({"draft_id":draft["draft_id"],"draft_revision":draft["revision"],"content_sha256":draft["content_sha256"],"submission_sha256":submission_sha,"blueprint_revision":draft["blueprint_revision"],"blueprint_sha256":sha,"current_blueprint_revision":bp["revision"],"target":target,"skeleton":skeleton}),
        )
    }
    fn review_stale(snapshot: &Value, draft: &Value) -> Vec<Value> {
        let mut reasons = Vec::new();
        if snapshot["blueprint_revision"] != snapshot["current_blueprint_revision"] {
            reasons.push(json!({"code":"blueprint_changed"}));
        }
        let expected_target = if draft["state"] == "approved" && draft.get("approved_revision_id").is_some() {
            &draft["approved_revision_id"]
        } else {
            &snapshot["target"]["base_revision_id"]
        };
        if snapshot["target"] != Value::Null
            && *expected_target != snapshot["target"]["current_revision_id"]
        {
            reasons.push(json!({"code":"document_changed"}));
        }
        if snapshot["skeleton"] != Value::Null {
            if snapshot["skeleton"]["skeleton_ref"]["revision"]
                != snapshot["skeleton"]["current_revision"]
            {
                reasons.push(json!({"code":"skeleton_changed"}));
            }
            reasons.extend(
                snapshot["skeleton"]["source_state"]["stale_reasons"]
                    .as_array()
                    .unwrap()
                    .clone(),
            );
        }
        reasons
    }
    fn review_history(&self, draft: &Value) -> Result<Vec<Value>> {
        let mut current = draft
            .get("last_review_id")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let mut expected_sha = None;
        if let Some(review) = &current {
            let head = self.store.json(&format!(
                ".hetu/review-heads/{}.json",
                text(draft, "draft_id")?
            ))?;
            ensure(
                head["review_id"] == *review,
                "hetu.integrity_failure",
                "审核决定 head 不一致。",
            )?;
            expected_sha = head["sha256"].as_str().map(str::to_owned);
        }
        let mut records = Vec::new();
        let mut seen = BTreeSet::new();
        while let Some(review_id) = current {
            checked_id(&review_id, "review")?;
            ensure(
                seen.insert(review_id.clone()) && records.len() < 10000,
                "hetu.integrity_failure",
                "审核决定链循环或超过上限。",
            )?;
            let descriptor = self
                .store
                .json(&format!(".hetu/reviews/{review_id}.json"))?;
            let path = format!(
                "packages/{}/drafts/{}/reviews/{review_id}.json",
                text(draft, "package")?,
                text(draft, "draft_id")?
            );
            ensure(
                descriptor["path"] == path
                    && descriptor["review_id"] == review_id
                    && descriptor["draft_id"] == draft["draft_id"],
                "hetu.integrity_failure",
                "审核决定索引归属不一致。",
            )?;
            let content = self.store.read(&path)?;
            let sha = digest(&content);
            ensure(
                content.len() <= validation::OUTPUT_LIMIT
                    && descriptor["sha256"] == sha
                    && expected_sha.as_deref() == Some(sha.as_str()),
                "hetu.integrity_failure",
                "审核决定摘要链不一致。",
            )?;
            let item: Value = serde_json::from_slice(&content)?;
            ensure(
                matches!(item["schema_version"].as_str(), Some("1.0.0" | "2.0.0"))
                    && item["review_id"] == review_id
                    && item["draft_id"] == draft["draft_id"],
                "hetu.integrity_failure",
                "审核决定身份不一致。",
            )?;
            current = item["previous_review_id"].as_str().map(str::to_owned);
            expected_sha = item["previous_review_sha256"].as_str().map(str::to_owned);
            ensure(
                current.is_some() == expected_sha.is_some(),
                "hetu.integrity_failure",
                "审核父决定引用不完整。",
            )?;
            records.push(item);
        }
        records.reverse();
        Ok(records)
    }
    fn review_report_refs(&self, draft: &Value) -> Result<Vec<Value>> {
        let mut records = Vec::new();
        if draft.get("evidence_document_id").is_none()
            || !self.store.entries(".hetu")?.iter().any(|n| n == "reports")
        {
            return Ok(records);
        }
        for name in self.store.entries(".hetu/reports")? {
            let report_id = name
                .strip_suffix(".json")
                .ok_or_else(|| Error::new("hetu.integrity_failure", "报告索引名称无效。"))?;
            let item = self.report_descriptor(report_id)?;
            if item["input_snapshot"]["source_revisions"]
                .as_array()
                .is_some_and(|sources| {
                    sources.len() == 1 && sources[0]["document_id"] == draft["evidence_document_id"]
                })
            {
                records.push(item);
            }
        }
        records.sort_by(|a, b| {
            b["created_at"]
                .as_str()
                .cmp(&a["created_at"].as_str())
                .then_with(|| b["report_id"].as_str().cmp(&a["report_id"].as_str()))
        });
        Ok(records)
    }
    pub(super) fn get_review(&self, input: &Value) -> Result<Value> {
        let draft_id = if let Some(draft) = input.get("draft_id").and_then(Value::as_str) {
            draft.to_owned()
        } else {
            let review = checked_id(text(input, "review_id")?, "review")?;
            self.store.json(&format!(".hetu/reviews/{review}.json"))?["draft_id"]
                .as_str()
                .ok_or_else(|| Error::new("hetu.integrity_failure", "审核决定索引无效。"))?
                .to_owned()
        };
        let value = self.draft_content(&draft_id)?;
        let draft = &value["draft"];
        let snapshot = self.review_snapshot(draft)?;
        let stale = Self::review_stale(&snapshot, draft);
        let mut history = self.review_history(draft)?;
        if !self.author {
            for item in &mut history {
                item.as_object_mut().unwrap().remove("private_comments");
            }
        }
        if let Some(review) = input.get("review_id") {
            ensure(
                history.iter().any(|r| r["review_id"] == *review),
                "not_found",
                "审核决定不属于该草稿。",
            )?;
        }
        let records = self.review_report_refs(draft)?;
        let fingerprint = digest(bytes(&json!({"draft_id":draft_id,"records":records}))?);
        let start = if let Some(cursor) = input.get("report_cursor").and_then(Value::as_str) {
            let (hash, offset) = cursor
                .split_once(':')
                .ok_or_else(|| Error::new("cursor_invalid", "报告分页游标无效。"))?;
            let offset = offset
                .parse::<usize>()
                .map_err(|_| Error::new("cursor_invalid", "报告分页游标无效。"))?;
            ensure(
                hash == fingerprint && offset > 0 && offset < records.len(),
                "cursor_invalid",
                "报告列表已变化，请重新读取。",
            )?;
            offset
        } else {
            0
        };
        let end = start
            .saturating_add(input["report_limit"].as_u64().unwrap_or(20) as usize)
            .min(records.len());
        let mut reports = Vec::new();
        for record in &records[start..end] {
            let report = self.read_report(text(record, "report_id")?)?;
            let state = self.report_result(&report, true)?;
            reports.push(json!({"reference":{"report_id":report["report_id"],"sha256":record["sha256"],"dispositions_sha256":digest(bytes(&state["dispositions"])? )},"status":report["status"],"created_at":report["created_at"],"counts":report["coverage"]["counts"],"plot_revision_id":report["input_snapshot"]["plot_revision_id"],"stale":state["stale"],"stale_reasons":state["stale_reasons"]}));
        }
        let baseline = if snapshot["target"] != Value::Null {
            self.document_content(
                text(&snapshot["target"], "document_id")?,
                snapshot["target"]["approved_revision_id"]
                    .as_str()
                    .or(snapshot["target"]["base_revision_id"].as_str()),
            )?
        } else {
            Value::Null
        };
        Ok(
            json!({"draft":draft,"content":value["content"],"input_snapshot":snapshot,"stale":!stale.is_empty(),"stale_reasons":stale,"decisions":history,"reports":reports,"reports_next_cursor":(end<records.len()).then(||format!("{fingerprint}:{end}")),"baseline":baseline,"evidence_ready":draft.get("evidence_document_id").is_some()}),
        )
    }
    pub(super) fn list_reviews(&self, input: &Value) -> Result<Value> {
        let mut records = Vec::new();
        for package in PACKAGES {
            for name in self.store.entries(&format!("packages/{package}/drafts"))? {
                let draft = self.draft_content(&name)?["draft"].clone();
                if input.get("state").is_some_and(|s| *s != draft["state"]) {
                    continue;
                }
                records.push(draft);
            }
        }
        records.sort_by(|a, b| {
            b["created_at"]
                .as_str()
                .cmp(&a["created_at"].as_str())
                .then_with(|| b["draft_id"].as_str().cmp(&a["draft_id"].as_str()))
        });
        let fingerprint = digest(bytes(
            &json!({"scope":self.scope(),"state":input["state"],"records":records}),
        )?);
        let start = if let Some(cursor) = input.get("cursor").and_then(Value::as_str) {
            let (hash, offset) = cursor
                .split_once(':')
                .ok_or_else(|| Error::new("cursor_invalid", "审核分页游标无效。"))?;
            let offset = offset
                .parse::<usize>()
                .map_err(|_| Error::new("cursor_invalid", "审核分页游标无效。"))?;
            ensure(
                hash == fingerprint && offset > 0 && offset < records.len(),
                "cursor_invalid",
                "审核列表已变化，请重新读取。",
            )?;
            offset
        } else {
            0
        };
        let end = start
            .saturating_add(input["limit"].as_u64().unwrap_or(50) as usize)
            .min(records.len());
        Ok(
            json!({"reviews":records[start..end],"next_cursor":(end<records.len()).then(||format!("{fingerprint}:{end}"))}),
        )
    }
    pub(super) fn validate_review(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let value = self.draft_content(text(input, "draft_id")?)?;
        let draft = &value["draft"];
        ensure(
            draft["revision"] == input["expected_draft_revision"],
            "revision_conflict",
            "草稿状态已变化。",
        )?;
        ensure(
            draft.get("evidence_document_id").is_some(),
            "missing_context",
            "请先由作者开始审核以绑定草稿证据。",
        )?;
        let snapshot = self.review_snapshot(draft)?;
        let (bp, sha) = self.blueprint_revision(Some(integer(draft, "blueprint_revision")?))?;
        let documents=self.plot_documents(&[json!({"document_id":draft["evidence_document_id"],"revision_id":draft["evidence_revision_id"],"sha256":draft["content_sha256"]})])?;
        let plot = plot::extract(
            &documents,
            &bp,
            &sha,
            serde_json::from_value(input["plot_options"].clone())?,
            self.actor(),
        )?;
        let plot_sha = digest(serde_json::to_vec(&plot)?);
        let report = validation::run(
            &plot,
            &bp,
            &documents,
            &plot_sha,
            serde_json::from_value(input["validation_options"].clone())?,
            self.actor(),
        )?;
        self.stage_plot(&plot, &bp, changes)?;
        self.stage_report(&report, &bp, changes)?;
        let stale = Self::review_stale(&snapshot, draft);
        Ok(
            json!({"report":report,"saved":true,"stale":!stale.is_empty(),"stale_reasons":stale,"dispositions":[]}),
        )
    }
    pub(super) fn approval_evidence(&self, draft: &Value, input: &Value) -> Result<Vec<Value>> {
        let refs = input["report_refs"].as_array().unwrap();
        ensure(
            !refs.is_empty(),
            "hetu.review_evidence_required",
            "通过前必须选择针对确切稿件修订的诊断报告。",
        )?;
        let mut seen = BTreeSet::new();
        let mut exceptions = Vec::new();
        for reference in refs {
            let id = text(reference, "report_id")?;
            ensure(
                seen.insert(id),
                "invalid_input",
                "不能重复选择同一份诊断报告。",
            )?;
            let report = self.read_report(id)?;
            let descriptor = self.report_descriptor(id)?;
            let state = self.report_result(&report, true)?;
            ensure(
                reference["sha256"] == descriptor["sha256"]
                    && reference["dispositions_sha256"] == digest(bytes(&state["dispositions"])?),
                "hetu.stale_evidence",
                "报告或问题处置已有变化，请重新审阅。",
            )?;
            let sources = report["input_snapshot"]["source_revisions"]
                .as_array()
                .unwrap();
            ensure(
                sources.len() == 1
                    && sources[0]["document_id"] == draft["evidence_document_id"]
                    && sources[0]["revision_id"] == draft["evidence_revision_id"]
                    && sources[0]["sha256"] == draft["content_sha256"]
                    && report["input_snapshot"]["blueprint_revision"]
                        == draft["blueprint_revision"]
                    && report["input_snapshot"]["blueprint_sha256"] == draft["blueprint_sha256"]
                    && state["stale"] == false,
                "hetu.stale_evidence",
                "诊断报告没有覆盖当前稿件与设定集固定证据。",
            )?;
            if report["status"] == "partial"
                || report["coverage"]["counts"]["unknown"]
                    .as_u64()
                    .unwrap_or(0)
                    > 0
            {
                ensure(
                    input["coverage_acknowledgement"]
                        .as_str()
                        .is_some_and(|s| !s.trim().is_empty()),
                    "hetu.review_coverage_required",
                    "部分覆盖或未知前提需要作者明确记录审阅理由。",
                )?;
            }
            for finding in report["findings"].as_array().unwrap() {
                if finding["certainty"] != "certain" || finding["severity"] != "error" {
                    continue;
                }
                let disposition = state["dispositions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|d| d["finding_id"] == finding["finding_id"]);
                ensure(
                    finding["exception_policy"] == "author_review"
                        && disposition
                            .is_some_and(|d| d["current"]["disposition"] == "accepted_exception"),
                    "hetu.review_conflict",
                    "该稿件仍有未获允许例外的确定性错误。",
                )?;
                exceptions.push(json!({"report_id":id,"finding_id":finding["finding_id"],"disposition":disposition.unwrap()["current"]}));
            }
        }
        Ok(exceptions)
    }
    pub(super) fn decide_review(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let value = self.draft_content(text(input, "draft_id")?)?;
        let mut draft = value["draft"].clone();
        ensure(
            draft["revision"] == input["expected_draft_revision"],
            "revision_conflict",
            "草稿已经有新状态或决定，请重新读取。",
        )?;
        let snapshot = self.review_snapshot(&draft)?;
        ensure(
            snapshot == input["input_snapshot"],
            "hetu.stale_evidence",
            "审核屏上下文已变化，请重新审阅。",
        )?;
        ensure(
            !text(input, "comments")?.trim().is_empty(),
            "invalid_input",
            "请记录审核决定与理由。",
        )?;
        let decision = text(input, "decision")?;
        if decision != "approved" {
            ensure(
                input["report_refs"].as_array().unwrap().is_empty(),
                "invalid_input",
                "非通过决定不接收报告引用。",
            )?;
        }
        ensure(
            if decision == "withdrawn" {
                draft["state"] == "approved"
            } else {
                draft["state"] == "in_review"
            },
            "revision_conflict",
            "草稿状态不允许此审核决定。",
        )?;
        let history = self.review_history(&draft)?;
        ensure(
            history.len() < 10000,
            "hetu.budget_exceeded",
            "审核历史超过上限。",
        )?;
        let mut exceptions = Vec::new();
        let review_id = id("review");
        if decision == "approved" {
            ensure(
                Self::review_stale(&snapshot, &draft).is_empty(),
                "hetu.stale_evidence",
                "来源或目标已有变化，请提交基于新版本的草稿。",
            )?;
            exceptions = self.approval_evidence(&draft, input)?;
            ensure(
                matches!(draft["package"].as_str(), Some("novel" | "drama")),
                "hetu.capability_unavailable",
                "此内容包的素材定稿应使用对应资产审核能力。",
            )?;
        } else {
            ensure(
                input["report_refs"].as_array().unwrap().is_empty(),
                "invalid_input",
                "非通过决定不接收未经核验的报告引用。",
            )?;
        }
        let previous = history
            .last()
            .map(|r| r["review_id"].clone())
            .unwrap_or(Value::Null);
        let previous_sha = if previous != Value::Null {
            self.store.json(&format!(
                ".hetu/reviews/{}.json",
                previous.as_str().unwrap()
            ))?["sha256"]
                .clone()
        } else {
            Value::Null
        };
        let item = json!({"schema_version":"2.0.0","review_id":review_id,"draft_id":draft["draft_id"],"draft_revision":draft["revision"],"decision":decision,"reviewer_ref":self.actor(),"decided_at":now(),"input_snapshot":snapshot,"report_refs":input["report_refs"],"comments":input["comments"],"private_comments":input.get("private_comments").cloned().unwrap_or(json!("")),"coverage_acknowledgement":input.get("coverage_acknowledgement").cloned().unwrap_or(json!("")),"exceptions":exceptions,"previous_review_id":previous,"previous_review_sha256":previous_sha});
        let content = bytes(&item)?;
        ensure(
            content.len() <= validation::OUTPUT_LIMIT,
            "hetu.budget_exceeded",
            "审核决定超过输出预算。",
        )?;
        let path = format!(
            "packages/{}/drafts/{}/reviews/{review_id}.json",
            text(&draft, "package")?,
            text(&draft, "draft_id")?
        );
        self.store.directory(&format!(
            "packages/{}/drafts/{}/reviews",
            text(&draft, "package")?,
            text(&draft, "draft_id")?
        ))?;
        for directory in [".hetu/reviews", ".hetu/review-heads"] {
            self.store.directory(directory)?;
        }
        let descriptor = json!({"review_id":review_id,"draft_id":draft["draft_id"],"path":path,"sha256":digest(&content)});
        changes.insert(path, content);
        changes.insert(
            format!(".hetu/reviews/{review_id}.json"),
            bytes(&descriptor)?,
        );
        changes.insert(
            format!(".hetu/review-heads/{}.json", text(&draft, "draft_id")?),
            bytes(&descriptor)?,
        );
        draft["state"] = json!(if decision == "withdrawn" {
            "in_review"
        } else {
            decision
        });
        draft["last_review_id"] = json!(review_id);
        draft["revision"] = json!(integer(&draft, "revision")? + 1);
        self.stage_draft(&draft, changes)?;
        Ok(json!({"review":item,"draft":draft}))
    }
}
