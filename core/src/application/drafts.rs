use super::*;

pub(super) const DRAFT_LIMIT: usize = 1024 * 1024;
fn frozen(draft: &Value) -> Value {
    let mut value = draft.clone();
    for field in [
        "revision",
        "state",
        "last_review_id",
        "approved_document_id",
        "approved_revision_id",
        "superseded_by",
    ] {
        value.as_object_mut().unwrap().remove(field);
    }
    value
}
impl Kernel {
    pub(super) fn stage_draft(&self, draft: &Value, changes: &mut Changes) -> Result<()> {
        let draft_id = text(draft, "draft_id")?;
        let package = text(draft, "package")?;
        self.store.directory(".hetu/draft-heads")?;
        let content = bytes(draft)?;
        changes.insert(
            format!("packages/{package}/drafts/{draft_id}/draft.json"),
            content.clone(),
        );
        changes.insert(format!(".hetu/draft-heads/{draft_id}.json"), bytes(&json!({"draft_id":draft_id,"revision":draft["revision"],"sha256":digest(&content)}))?);
        Ok(())
    }
    pub(super) fn anchor_draft(&self, draft: &mut Value, changes: &mut Changes) -> Result<()> {
        let id = text(draft, "draft_id")?.to_owned();
        let path = format!(
            "packages/{}/drafts/{id}/submission.json",
            text(draft, "package")?
        );
        ensure(
            !self.store.exists(&path)?,
            "hetu.integrity_failure",
            "草稿提交凭据已存在。",
        )?;
        let doc = domain::id("doc");
        draft["evidence_document_id"] = json!(doc);
        draft["evidence_revision_id"] = json!(domain::id("rev"));
        let (bp, sha) = self.blueprint_revision(Some(integer(draft, "blueprint_revision")?))?;
        stage_blueprint_snapshot(&self.store, &bp, changes)?;
        draft["blueprint_sha256"] = json!(sha);
        if draft.get("language_tag").is_none() {
            draft["language_tag"] = self.config["locale"].clone();
        }
        let content = bytes(&json!({"schema_version":"1.0.0","draft":frozen(draft)}))?;
        let record = json!({"draft_id":id,"document_id":doc,"revision_id":draft["evidence_revision_id"],"path":path,"sha256":digest(&content)});
        for directory in [".hetu/draft-sources", ".hetu/draft-submissions"] {
            self.store.directory(directory)?;
        }
        changes.insert(path, content);
        changes.insert(
            format!(".hetu/draft-submissions/{id}.json"),
            bytes(&record)?,
        );
        changes.insert(format!(".hetu/draft-sources/{doc}.json"), bytes(&record)?);
        Ok(())
    }
    pub(super) fn submit_current(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let current = self.document_content(
            text(input, "document_id")?,
            Some(text(input, "base_revision_id")?),
        )?;
        ensure(
            current["document"]["current_revision_id"] == input["base_revision_id"],
            "revision_conflict",
            "正文已变化，请重新读取后提交审核。",
        )?;
        let mut draft_input = json!({"package":if current["document"]["kind"]=="drama_script" {"drama"} else {"novel"},"title":current["document"]["title"],"source_format":current["document"]["source_format"],"target_document_id":input["document_id"],"base_revision_id":input["base_revision_id"],"content":current["content"],"blueprint_revision":input["blueprint_revision"],"language_tag":current["document"]["language_tag"]});
        if let Some(reference) = input.get("skeleton_ref") {
            draft_input["skeleton_ref"] = reference.clone();
        }
        self.submit_draft(&draft_input, changes)
    }
    pub(super) fn submit_draft(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let bp = self.blueprint()?;
        ensure(
            bp["revision"] == input["blueprint_revision"],
            "revision_conflict",
            "草稿依据的设定集版本已变化。",
        )?;
        let content = text(input, "content")?;
        ensure(
            !content.is_empty() && content.len() <= DRAFT_LIMIT,
            "hetu.budget_exceeded",
            "草稿正文为空或超过 1 MiB 限额。",
        )?;
        if let Some(target) = input.get("target_document_id").and_then(Value::as_str) {
            let existing = self.document_content(target, None)?;
            ensure(
                existing["document"]["draft_source_id"].is_null(),
                "forbidden",
                "草稿证据不能作为正式写回目标。",
            )?;
            ensure(
                existing["document"]["current_revision_id"] == input["base_revision_id"],
                "revision_conflict",
                "目标正文基线已变化。",
            )?;
            ensure(
                existing["document"]["source_format"] == input["source_format"],
                "invalid_input",
                "草稿格式与目标文档不一致。",
            )?;
            ensure(
                input["package"]
                    == if existing["document"]["kind"] == "drama_script" {
                        "drama"
                    } else {
                        "novel"
                    },
                "invalid_input",
                "草稿内容包与目标文档不一致。",
            )?;
            ensure(
                existing["document"]["structure_origin"].is_null()
                    || input.get("skeleton_ref").is_some(),
                "missing_context",
                "改编剧本草稿必须指定骨架修订。",
            )?;
        }
        if let Some(reference) = input.get("skeleton_ref") {
            ensure(
                input["package"] == "drama",
                "invalid_input",
                "骨架引用仅适用于短剧草稿。",
            )?;
            let (skeleton, sha) = self.read_skeleton(
                text(reference, "skeleton_id")?,
                Some(integer(reference, "revision")?),
            )?;
            ensure(
                reference["sha256"] == sha
                    && skeleton.blueprint_revision == integer(input, "blueprint_revision")?,
                "hetu.stale_evidence",
                "骨架与草稿设定集或摘要不一致。",
            )?;
        }
        let draft_id = id("draft");
        if let Some(parent) = input.get("parent_draft_id").and_then(Value::as_str) {
            let mut original = self.draft_content(parent)?["draft"].clone();
            ensure(
                matches!(
                    original["state"].as_str(),
                    Some("changes_requested" | "rejected")
                ),
                "revision_conflict",
                "仅可接替已要求修改或驳回的草稿。",
            )?;
            ensure(
                original["package"] == input["package"]
                    && original["source_format"] == input["source_format"]
                    && original["target_document_id"] == input["target_document_id"],
                "invalid_input",
                "返工稿必须保留原草稿的内容包、格式与目标。",
            )?;
            original["state"] = json!("superseded");
            original["superseded_by"] = json!(draft_id);
            original["revision"] = json!(integer(&original, "revision")? + 1);
            self.stage_draft(&original, changes)?;
        }
        let package = text(input, "package")?;
        let ext = if input["source_format"] == "fountain" {
            "fountain"
        } else {
            "md"
        };
        let path = format!("packages/{package}/drafts/{draft_id}/content.{ext}");
        self.store
            .directory(&format!("packages/{package}/drafts/{draft_id}"))?;
        let mut draft = json!({"schema_version":"1.0.0","draft_id":draft_id,"revision":1,"package":package,"source_format":input["source_format"],"content_path":path,"content_sha256":digest(content),"size_bytes":content.len(),"state":"submitted","actor_ref":self.actor(),"created_at":now(),"blueprint_revision":bp["revision"],"diagnostic_state":"not_requested"});
        for field in [
            "title",
            "target_document_id",
            "base_revision_id",
            "parent_draft_id",
            "skeleton_ref",
            "language_tag",
        ] {
            if let Some(value) = input.get(field) {
                draft[field] = value.clone();
            }
        }
        if draft.get("title").is_none()
            && let Some(target) = draft.get("target_document_id").and_then(Value::as_str)
        {
            draft["title"] = self.document(target)?["title"].clone();
        }
        self.anchor_draft(&mut draft, changes)?;
        self.stage_draft(&draft, changes)?;
        changes.insert(path, content.as_bytes().to_vec());
        Ok(
            json!({"draft":draft,"approval_state":"awaiting_author","diagnostic_state":"not_requested"}),
        )
    }
    pub(super) fn draft_content(&self, draft_id: &str) -> Result<Value> {
        checked_id(draft_id, "draft")?;
        for package in PACKAGES {
            if !self
                .store
                .entries(&format!("packages/{package}/drafts"))?
                .iter()
                .any(|n| n == draft_id)
            {
                continue;
            }
            let root = format!("packages/{package}/drafts/{draft_id}");
            let raw = self.store.read(&format!("{root}/draft.json"))?;
            let draft: Value = serde_json::from_slice(&raw)?;
            ensure(
                draft["draft_id"] == draft_id && draft["package"] == package,
                "hetu.integrity_failure",
                "草稿归属不一致。",
            )?;
            let ext = if draft["source_format"] == "fountain" {
                "fountain"
            } else {
                "md"
            };
            let path = format!("{root}/content.{ext}");
            ensure(
                draft["content_path"] == path,
                "hetu.integrity_failure",
                "草稿路径无效。",
            )?;
            let content = self.store.read(&path)?;
            ensure(
                content.len() <= DRAFT_LIMIT && draft["content_sha256"] == digest(&content),
                "hetu.integrity_failure",
                "已提交草稿被外部修改。",
            )?;
            let anchored = self
                .store
                .entries(".hetu")?
                .iter()
                .any(|n| n == "draft-submissions")
                && self
                    .store
                    .entries(".hetu/draft-submissions")?
                    .iter()
                    .any(|n| n == &format!("{draft_id}.json"));
            if anchored || draft.get("evidence_document_id").is_some() {
                let head = self
                    .store
                    .json(&format!(".hetu/draft-heads/{draft_id}.json"))?;
                ensure(
                    head["draft_id"] == draft_id
                        && head["sha256"] == digest(raw)
                        && head["revision"] == draft["revision"],
                    "hetu.integrity_failure",
                    "草稿状态摘要不一致。",
                )?;
                let record = self
                    .store
                    .json(&format!(".hetu/draft-submissions/{draft_id}.json"))?;
                let source = self.store.json(&format!(
                    ".hetu/draft-sources/{}.json",
                    checked_id(text(&draft, "evidence_document_id")?, "doc")?
                ))?;
                let submission = self.store.read(&format!("{root}/submission.json"))?;
                ensure(
                    record == source
                        && record["draft_id"] == draft_id
                        && record["document_id"] == draft["evidence_document_id"]
                        && record["revision_id"] == draft["evidence_revision_id"]
                        && record["path"] == format!("{root}/submission.json")
                        && record["sha256"] == digest(&submission),
                    "hetu.integrity_failure",
                    "草稿提交凭据不一致。",
                )?;
                let submission: Value = serde_json::from_slice(&submission)?;
                ensure(
                    submission["schema_version"] == "1.0.0"
                        && submission["draft"] == frozen(&draft)
                        && draft["size_bytes"] == content.len(),
                    "hetu.integrity_failure",
                    "草稿提交后的固定属性被改写。",
                )?;
            }
            let content = String::from_utf8(content)
                .map_err(|_| Error::new("hetu.integrity_failure", "草稿不是 UTF-8。"))?;
            return Ok(json!({"draft":draft,"content":content}));
        }
        Err(Error::new("not_found", "草稿不存在。"))
    }
    pub(super) fn draft_source(&self, document_id: &str) -> Result<Option<Value>> {
        checked_id(document_id, "doc")?;
        if !self
            .store
            .entries(".hetu")?
            .iter()
            .any(|n| n == "draft-sources")
            || !self
                .store
                .entries(".hetu/draft-sources")?
                .iter()
                .any(|n| n == &format!("{document_id}.json"))
        {
            return Ok(None);
        }
        let record = self
            .store
            .json(&format!(".hetu/draft-sources/{document_id}.json"))?;
        let value = self.draft_content(text(&record, "draft_id")?)?;
        let draft = &value["draft"];
        ensure(
            draft["evidence_document_id"] == document_id
                && record["revision_id"] == draft["evidence_revision_id"],
            "hetu.integrity_failure",
            "草稿证据身份不一致。",
        )?;
        let title = draft.get("title").cloned().unwrap_or(json!(""));
        let document = json!({"schema_version":"1.0.0","document_id":document_id,"kind":if draft["package"]=="drama" {"drama_script"}else{"novel_chapter"},"title":title,"source_format":draft["source_format"],"language_tag":draft["language_tag"],"current_revision_id":draft["evidence_revision_id"],"created_at":draft["created_at"],"draft_source_id":draft["draft_id"],"target_document_id":draft["target_document_id"],"package":draft["package"]});
        let revision = json!({"schema_version":"1.0.0","document_id":document_id,"revision_id":draft["evidence_revision_id"],"source_format":draft["source_format"],"content_path":draft["content_path"],"sha256":draft["content_sha256"],"size_bytes":draft["size_bytes"],"created_at":draft["created_at"],"actor_ref":draft["actor_ref"]});
        Ok(Some(
            json!({"document":document,"revision":revision,"content":value["content"]}),
        ))
    }
}
