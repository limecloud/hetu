//! 宿主只组合固定交付和专业Owner声明，不执行文学判断或作者决定。
use super::*;

impl Kernel {
    pub(super) fn fixed_professional_object(&self, reference: &Value) -> Result<(Value, String)> {
        self.work_record(&reference["work_ref"], None)?;
        let (record, sha) = self.extension_object(
            &reference["work_ref"],
            text(reference, "owner_plugin_id")?,
            text(reference, "object_id")?,
            Some(integer(reference, "revision")?),
        )?;
        ensure(
            reference["sha256"] == sha,
            "hetu.stale_evidence",
            "专业对象的固定摘要不一致。",
        )?;
        Ok((record, sha))
    }

    pub(in crate::application) fn assess_creative_task(&self, input: &Value) -> Result<Value> {
        let (request, request_sha, state, state_sha) =
            self.task_for_reference(&input["task_ref"])?;
        let work = self.task_work_owner(&request)?;
        let latest = state["submission_refs"]
            .as_array()
            .and_then(|refs| refs.last());
        let submission = latest
            .map(|r| self.read_submission(&request, &state, text(r, "submission_id")?, false))
            .transpose()?
            .unwrap_or(Value::Null);
        let references = input
            .get("candidate_refs")
            .cloned()
            .unwrap_or_else(|| candidate_references(&submission, &input["task_ref"]));
        let mut candidates = Vec::new();
        for reference in references.as_array().unwrap() {
            ensure(
                reference["task_ref"] == input["task_ref"],
                "forbidden",
                "评估候选须属于本次精确任务。",
            )?;
            let candidate = self.task_candidate(reference)?;
            let draft = if let Some(id) = candidate["draft_ref"]["draft_id"].as_str() {
                self.draft_content(id)?["draft"].clone()
            } else {
                Value::Null
            };
            candidates.push(json!({"candidate_ref":reference,"sha256":candidate["sha256"],"size_bytes":candidate["size_bytes"],
                "kind":candidate["kind"],"evidence_source":if draft.is_object() {json!({"kind":"document","document_id":draft["evidence_document_id"],"revision_id":draft["evidence_revision_id"],"sha256":candidate["sha256"]})} else {Value::Null},
                "adoption":if draft.is_null() {"not_applicable"} else if draft["approved_revision_id"].is_null() {"awaiting_author"} else {"recorded"}}));
        }
        let mut reports = Vec::new();
        let professional_refs = input.get("professional_refs").cloned().unwrap_or_else(|| {
            json!(
                request["input_refs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|r| r["kind"] == "plugin_object")
                    .cloned()
                    .collect::<Vec<_>>()
            )
        });
        for reference in professional_refs.as_array().unwrap() {
            ensure(
                work.as_ref() == Some(&reference["work_ref"]),
                "forbidden",
                "专业检查须属于任务的同一作品。",
            )?;
            if !self.author && self.management_grant.is_none() {
                ensure(
                    request["input_refs"]
                        .as_array()
                        .unwrap()
                        .contains(reference),
                    "forbidden",
                    "任务未固定授权这份专业检查；请使用该作品的精确管理授权。",
                )?;
            }
            let (record, _) = self.fixed_professional_object(reference)?;
            let mut report = json!({"reference":reference,"authority":"professional_owner_reported",
                "semantic_correctness":"not_verified_by_host","status":"unsupported_owner","candidate_coverage":[]});
            // 此适配只读取已发布Owner的覆盖合同，规则执行仍由原插件负责。
            if record["owner_plugin_id"] == "org.wordflowlab.novel-review"
                && record["kind"] == "novel_review"
                && record["content"]["format_version"] == 1
                && record["content"]["framework_version"] == "1"
                && record["content"]["checks"].is_array()
                && record["content"]["scope_indices"].is_array()
                && record["content"]["issues"].is_array()
            {
                let content = &record["content"];
                let sources = record["source_refs"].as_array().ok_or_else(|| {
                    Error::new("hetu.integrity_failure", "专业检查缺少固定来源。")
                })?;
                let domains = [
                    "continuity",
                    "characters",
                    "promises",
                    "pacing",
                    "prose",
                    "canon",
                ];
                let mut coverage = Vec::new();
                for candidate in &candidates {
                    let source = &candidate["evidence_source"];
                    let indices = sources
                        .iter()
                        .enumerate()
                        .filter(|(_, s)| {
                            !source.is_null()
                                && s["kind"] == "document"
                                && s["document_id"] == source["document_id"]
                                && s["revision_id"] == source["revision_id"]
                                && s["sha256"] == source["sha256"]
                        })
                        .map(|(i, _)| json!(i))
                        .collect::<Vec<_>>();
                    let covered = indices
                        .iter()
                        .filter(|i| content["scope_indices"].as_array().unwrap().contains(i))
                        .collect::<Vec<_>>();
                    let checks = content["checks"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|check| {
                            check["source_indices"]
                                .as_array()
                                .is_some_and(|refs| covered.iter().any(|i| refs.contains(i)))
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    let missing = domains
                        .iter()
                        .filter(|domain| {
                            !checks.iter().any(|check| {
                                check["domain"] == **domain && check["status"] != "unchecked"
                            })
                        })
                        .map(|s| json!(s))
                        .collect::<Vec<_>>();
                    let issues = content["issues"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|issue| {
                            issue["disposition"] == "open"
                                && issue["evidence"].as_array().is_some_and(|refs| {
                                    refs.iter().any(|r| indices.contains(&r["source_index"]))
                                })
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    let status = if covered.is_empty() {
                        "wrong_target"
                    } else if !issues.is_empty() || checks.iter().any(|c| c["status"] == "finding")
                    {
                        "findings"
                    } else if !missing.is_empty() {
                        "partial"
                    } else if checks.iter().any(|c| c["status"] == "inconclusive") {
                        "inconclusive"
                    } else {
                        "reported_pass"
                    };
                    coverage.push(json!({"candidate_ref":candidate["candidate_ref"],"status":status,"checks":checks,
                        "missing_domains":missing,"counterevidence":issues}));
                }
                report["status"] = json!("owner_report_available");
                report["candidate_coverage"] = json!(coverage);
            }
            reports.push(report);
        }
        let task =
            self.get_creative_task(&json!({"task_ref":input["task_ref"],"detail":"summary"}))?;
        let target = if let Some(id) = self.task_target_document(&request)? {
            let current = self.document_content(&id, None)?;
            let fixed = request
                .get("target_ref")
                .filter(|r| r.is_object())
                .cloned()
                .or_else(|| {
                    request["input_refs"].as_array().and_then(|refs| {
                        refs.iter()
                            .find(|r| r["kind"] == "document" && r["document_id"] == id)
                            .cloned()
                    })
                });
            json!({"fixed_ref":fixed,"current_revision_id":current["revision"]["revision_id"],
                "status":if fixed.as_ref().is_some_and(|r|r["revision_id"]==current["revision"]["revision_id"]) {"current"} else {"stale_target"}})
        } else {
            json!({"status":"no_existing_target"})
        };
        Ok(
            json!({"task_ref":input["task_ref"],"request_sha256":request_sha,"observation":{"revision":state["revision"],"sha256":state_sha},
            "delivery":{"status":if candidates.is_empty(){"missing"}else{"fixed_candidates_verified"},"candidates":candidates,
                "agent_reported_complete":submission["complete"],"agent_reported_missing_items":submission["missing_items"],"target":target},
            "professional":{"status":if reports.is_empty(){"no_checks"}else{"fixed_reports_read"},"reports":reports},
            "author_decision":{"status":if task["decision"].is_null(){"awaiting_author"}else{"preference_recorded"},
                "decision":task["decision"],"effect":"preference_only"},"completion":"requires_layer_review",
            "limits":["candidate_presence_is_not_quality","owner_reports_are_not_host_verified","preference_is_not_adoption_or_finalization"]}),
        )
    }
}
