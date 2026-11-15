use super::*;

impl Kernel {
    pub(super) fn task_work_reference(&self, input: &Value) -> Result<Option<Value>> {
        let requested = input.get("work_ref").filter(|value| value.is_object());
        if let Some(reference) = requested { self.work_record(reference, None)?; }
        let target_id = input["target_ref"]["document_id"].as_str()
            .or_else(|| input["edit_scope"]["document_id"].as_str());
        let target = target_id.map(|id| self.document(id)).transpose()?;
        let owner = target.as_ref().map(|document| self.document_work_ref(document)).transpose()?.flatten();
        if let Some(requested) = requested {
            ensure(target_id.is_none() || owner.as_ref() == Some(requested), "forbidden", "创作任务目标不属于所选作品。")?;
            Ok(Some(requested.clone()))
        } else { Ok(owner) }
    }
    pub(super) fn validate_task_target(&self, input: &Value) -> Result<()> {
        let Some(target) = input.get("target_ref") else {
            return Ok(());
        };
        ensure(
            !self.is_creation_project(),
            "invalid_input",
            "筹备任务不能指定作品正文目标。",
        )?;
        let kind = match input["task_kind"].as_str() {
            Some("drama_draft") => "drama_script",
            Some("chapter_draft") => "novel_chapter",
            Some("revision") => "",
            _ => return Err(Error::new("invalid_input", "此类任务不接收正文目标。")),
        };
        let fixed = self.document_content(
            text(target, "document_id")?,
            Some(text(target, "revision_id")?),
        )?;
        ensure(
            fixed["revision"]["sha256"] == target["sha256"],
            "hetu.integrity_failure",
            "目标稿摘要不一致。",
        )?;
        let document = &fixed["document"];
        ensure(
            document["draft_source_id"].is_null() && (kind.is_empty() || document["kind"] == kind),
            "invalid_input",
            "任务目标必须是对应类型的作者稿。",
        )?;
        ensure(
            document["current_revision_id"] == target["revision_id"],
            "revision_conflict",
            "目标稿已有更新，请重新准备任务。",
        )?;
        if input["task_kind"] == "revision" {
            ensure(
                input["edit_scope"]["document_id"] == target["document_id"]
                    && input["edit_scope"]["revision_id"] == target["revision_id"],
                "invalid_input",
                "改稿目标与可改选区必须一致。",
            )?;
        }
        Ok(())
    }

    /// 老请求保留原字节。只接受唯一同类型固定输入，不按题名、序号或最新打开文档猜测。
    pub(super) fn task_target_document(&self, request: &Value) -> Result<Option<String>> {
        if let Some(id) = request["target_ref"]["document_id"]
            .as_str()
            .or_else(|| request["edit_scope"]["document_id"].as_str())
        {
            return Ok(Some(id.to_owned()));
        }
        let kind = match request["task_kind"].as_str() {
            Some("drama_draft") => "drama_script",
            Some("chapter_draft") => "novel_chapter",
            _ => return Ok(None),
        };
        let mut ids = BTreeSet::new();
        for reference in request["input_refs"].as_array().into_iter().flatten() {
            if reference["kind"] == "document" {
                let doc = self.document(text(reference, "document_id")?)?;
                if doc["kind"] == kind && doc["draft_source_id"].is_null() {
                    ids.insert(text(&doc, "document_id")?.to_owned());
                }
            }
        }
        Ok(if ids.len() == 1 {
            ids.into_iter().next()
        } else {
            None
        })
    }

    pub(in crate::application) fn draft_delivery_target(&self, draft: &Value) -> Result<Value> {
        if !draft["target_document_id"].is_null() || draft["creative_task_ref"].is_null() {
            return Ok(Value::Null);
        }
        let (request, _) = self.task_request(text(&draft["creative_task_ref"], "task_id")?)?;
        let Some(id) = self.task_target_document(&request)? else {
            return Ok(Value::Null);
        };
        if !request["target_ref"].is_null() {
            return Ok(request["target_ref"].clone());
        }
        let source = request["input_refs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["document_id"] == id && r["kind"] == "document")
            .ok_or_else(|| Error::new("hetu.integrity_failure", "目标稿缺少固定来源。"))?;
        let fixed = self.document_content(&id, Some(text(source, "revision_id")?))?;
        Ok(
            json!({"document_id":id,"revision_id":source["revision_id"],"sha256":fixed["revision"]["sha256"]}),
        )
    }

    pub(in crate::application) fn document_manuscript(&self, document_id: &str) -> Result<Value> {
        let author = self.document_content(document_id, None)?;
        let mut references = Vec::new();
        if self
            .store
            .entries(".hetu")?
            .iter()
            .any(|name| name == "tasks")
        {
            for task_id in self.store.entries(".hetu/tasks")? {
                let (request, request_sha) = self.task_request(&task_id)?;
                if self.task_target_document(&request)?.as_deref() != Some(document_id) {
                    continue;
                }
                let (state, _) = self.task_state(&task_id)?;
                let task_ref = json!({"scope_ref":self.scope_ref(),"task_id":task_id,"request_revision":request["request_revision"]});
                let mut submitted_working = BTreeSet::new();
                if let Some(head) = state["submission_refs"].as_array().and_then(|r| r.last()) {
                    let submission = self.read_submission(
                        &request,
                        &state,
                        text(head, "submission_id")?,
                        false,
                    )?;
                    for candidate in submission["candidates"].as_array().into_iter().flatten() {
                        if candidate["kind"] != "text" {
                            continue;
                        }
                        if !candidate["working_copy_ref"].is_null() {
                            submitted_working.insert(candidate["working_copy_ref"].to_string());
                        }
                        references.push(json!({"kind":"submitted","task_ref":task_ref,"request_sha256":request_sha,
                            "submission_id":submission["submission_id"],"candidate_id":candidate["candidate_id"],"draft_ref":candidate["draft_ref"],
                            "working_copy_ref":candidate["working_copy_ref"],"title":candidate["title"],"source_format":candidate["source_format"],
                            "sha256":candidate["sha256"],"created_at":submission["received_at"],"task_state":state["state"]}));
                    }
                }
                for r in state["working_copy_refs"].as_array().into_iter().flatten() {
                    let (copy, _, _) = self.working_head(&task_ref, text(r, "working_copy_id")?)?;
                    if copy["artifact_kind"] != "text"
                        || submitted_working.contains(&copy["current_revision_ref"].to_string())
                    {
                        continue;
                    }
                    let saved = self.working_revision(&task_ref, &copy["current_revision_ref"])?;
                    references.push(json!({"kind":"working","task_ref":task_ref,"request_sha256":request_sha,
                        "working_copy_ref":copy["current_revision_ref"],"title":copy["title"],"source_format":copy["source_format"],
                        "sha256":copy["current_revision_ref"]["sha256"],"created_at":saved["revision"]["created_at"],"task_state":state["state"]}));
                }
            }
        }
        references.sort_by(|a, b| {
            b["created_at"]
                .as_str()
                .unwrap_or("")
                .cmp(a["created_at"].as_str().unwrap_or(""))
                .then_with(|| {
                    a["task_ref"]["task_id"]
                        .as_str()
                        .cmp(&b["task_ref"]["task_id"].as_str())
                })
        });
        let has_content = !text(&author, "content")?.trim().is_empty();
        let state = if !author["document"]["finalization_ref"].is_null() {
            "finalized"
        } else if has_content {
            "writing"
        } else {
            "empty"
        };
        Ok(
            json!({"author_ref":{"document_id":document_id,"revision_id":author["revision"]["revision_id"],"sha256":author["revision"]["sha256"]},
            "author_has_content":has_content,"author_state":state,"references":references}),
        )
    }
}
