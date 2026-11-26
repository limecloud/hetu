use super::*;

// 作者笔记单独修订；保存笔记既不改正文，也不改变定稿。
impl Kernel {
    fn authoring_path(&self, kind: &str, document: Option<&str>) -> Result<(String, String)> {
        match kind {
            "annotations" => {
                let id = checked_id(document.unwrap_or(""), "doc")?;
                self.document(&id)?;
                Ok((
                    format!("packages/novel/annotations/{id}.json"),
                    format!("annotations-{id}"),
                ))
            }
            "outlines" => Ok(("packages/novel/outlines.json".into(), "outlines".into())),
            _ => Err(Error::new("invalid_input", "未知笔记类型。")),
        }
    }

    pub(super) fn authoring_get(&self, kind: &str, input: &Value) -> Result<Value> {
        let (path, key) = self.authoring_path(kind, input["document_id"].as_str())?;
        if !self.store.exists(&path)? {
            ensure(input.get("revision").is_none() && input.get("outline_id").is_none(),
                "not_found", "尚未保存这份大纲修订或条目。")?;
            return Ok(json!({"revision":0,"sha256":null,"items":[]}));
        }
        let mut content = self.store.read(&path)?;
        let mut value: Value = serde_json::from_slice(&content)?;
        ensure(
            value["workspace_id"] == self.scope(),
            "hetu.integrity_failure",
            "笔记所属作品不一致。",
        )?;
        let head = integer(&value, "revision")?;
        ensure(
            self.store
                .read(&format!(".hetu/authoring/{key}/{head}.json"))?
                == content,
            "hetu.integrity_failure",
            "笔记与历史记录不一致，请保留文件并检查。",
        )?;
        let revision = input["revision"].as_u64().unwrap_or(head);
        ensure(revision <= head, "not_found", "没有这份大纲修订。")?;
        if revision != head {
            content = self.store.read(&format!(".hetu/authoring/{key}/{revision}.json"))?;
            value = serde_json::from_slice(&content)?;
            ensure(value["workspace_id"] == self.scope() && value["revision"] == revision,
                "hetu.integrity_failure", "大纲历史身份或所属作品不一致。")?;
            let next = self.store.json(&format!(".hetu/authoring/{key}/{}.json", revision + 1))?;
            ensure(next["workspace_id"] == self.scope() && next["revision"] == revision + 1
                && next["previous_sha256"] == digest(&content),
                "hetu.integrity_failure", "大纲历史链与固定修订不一致。")?;
        }
        let sha = digest(&content);
        ensure(input.get("sha256").is_none_or(|expected| *expected == sha),
            "hetu.integrity_failure", "大纲固定修订的摘要不一致。")?;
        let mut items = value["items"].as_array()
            .ok_or_else(|| Error::new("hetu.integrity_failure", "笔记条目列表损坏。"))?.clone();
        if kind == "outlines" {
            let definitions = catalog();
            let item_schema = &definitions["actions"].as_array().unwrap().iter()
                .find(|action| action["name"] == "hetu.outlines.save").unwrap()["input_schema"]["properties"]["items"];
            schema(&json!(items), item_schema)?;
        }
        let total = items.len();
        if let Some(id) = input["outline_id"].as_str() {
            items.retain(|item| item["id"] == id);
            ensure(items.len() == 1, "not_found", "固定大纲修订中没有此条目。")?;
        }
        if let Some(query) = input["query"].as_str() {
            let query = query.to_lowercase();
            items.retain(|item| item["title"].as_str().unwrap_or("").to_lowercase().contains(&query)
                || item["text"].as_str().unwrap_or("").to_lowercase().contains(&query));
        }
        if input["detail"] == "summary" {
            items = items.into_iter().map(|item| json!({"id":item["id"],"title":item["title"],
                "level":item["level"],"target_id":item["target_id"],"excerpt":item["text"].as_str().unwrap_or("").chars().take(100).collect::<String>(),
                "size_bytes":item["text"].as_str().unwrap_or("").len()})).collect();
        }
        let mut result = if input.get("limit").is_some() || input.get("cursor").is_some() {
            let mut page_input = input.clone();
            page_input["revision"] = json!(revision); page_input["sha256"] = json!(sha);
            self.ordered_record_page(&page_input, items, "items")?
        } else { json!({"items":items}) };
        result["revision"] = json!(revision); result["sha256"] = json!(sha);
        if input.get("outline_id").is_some() || input["detail"] == "summary" || input.get("query").is_some() {
            result["coverage"] = json!({"total_items":total,"returned_items":result["items"].as_array().unwrap().len(),
                "outline_id":input["outline_id"],"detail":input.get("detail").cloned().unwrap_or(json!("full"))});
        }
        Ok(result)
    }

    pub(super) fn fixed_outline_source(&self, reference: &Value) -> Result<(Value, String)> {
        ensure(reference["work_ref"]["kind"] == "novel", "forbidden", "正式大纲来源须属于小说作品。")?;
        self.work_record(&reference["work_ref"], None)?;
        let value = self.authoring_get("outlines", &json!({"revision":reference["revision"],
            "sha256":reference["sha256"],"outline_id":reference["outline_id"]}))?;
        Ok((value["items"][0].clone(), text(&value,"sha256")?.to_owned()))
    }

    pub(super) fn authoring_save(
        &self,
        kind: &str,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let current = self.authoring_get(kind, input)?;
        ensure(
            input["expected"]["revision"] == current["revision"]
                && input["expected"]["sha256"] == current["sha256"],
            "revision_conflict",
            "笔记已有更新，请刷新并比较，当前输入仍可保留。",
        )?;
        let items = input["items"]
            .as_array()
            .ok_or_else(|| Error::new("invalid_input", "笔记列表无效。"))?;
        let mut ids = std::collections::BTreeSet::new();
        for item in items {
            let item_id = checked_id(
                text(item, "id")?,
                if kind == "annotations" {
                    "note"
                } else {
                    "outline"
                },
            )?;
            ensure(ids.insert(item_id), "invalid_input", "笔记标识不能重复。")?;
            ensure(
                !text(item, "text")?.trim().is_empty(),
                "invalid_input",
                "请填写笔记内容。",
            )?;
            if kind == "annotations" {
                let source = &item["source_ref"];
                ensure(
                    source["document_id"] == input["document_id"],
                    "invalid_input",
                    "批注必须属于当前文档。",
                )?;
                let fixed = self.document_content(
                    text(source, "document_id")?,
                    Some(text(source, "revision_id")?),
                )?;
                let body = text(&fixed, "content")?;
                let start = integer(source, "byte_start")? as usize;
                let end = integer(source, "byte_end")? as usize;
                ensure(
                    start < end && body.get(start..end) == source["quote"].as_str(),
                    "hetu.invalid_source_ref",
                    "批注引文与原稿不符。",
                )?;
            } else {
                let novel = self
                    .novel()?
                    .ok_or_else(|| Error::new("not_found", "请先初始化作品资料。"))?;
                let target = &item["target_id"];
                let valid = match text(item, "level")? {
                    "book" => target.is_null(),
                    "volume" => novel["volumes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|v| v["volume_id"] == *target),
                    "chapter" => novel["chapters"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|c| c["document_id"] == *target),
                    _ => false,
                };
                ensure(valid, "invalid_input", "大纲关联的卷或章节不存在。")?;
            }
        }
        let (path, key) = self.authoring_path(kind, input["document_id"].as_str())?;
        let revision = integer(&current, "revision")?
            .checked_add(1)
            .ok_or_else(|| Error::new("hetu.budget_exceeded", "笔记修订已达上限。"))?;
        let value = json!({"schema_version":"1.0.0","workspace_id":self.scope(),"revision":revision,"previous_sha256":current["sha256"],"items":items,"updated_at":now()});
        let content = bytes(&value)?;
        ensure(
            content.len() <= 4 * 1024 * 1024,
            "hetu.budget_exceeded",
            "本次笔记超过保存上限。",
        )?;
        self.store.directory(".hetu/authoring")?;
        self.store.directory(&format!(".hetu/authoring/{key}"))?;
        changes.insert(
            format!(".hetu/authoring/{key}/{revision}.json"),
            content.clone(),
        );
        changes.insert(path, content.clone());
        Ok(json!({"revision":revision,"sha256":digest(&content),"items":items}))
    }

    pub(super) fn document_history(&self, input: &Value) -> Result<Value> {
        let doc_id = text(input, "document_id")?;
        let document = self.document(doc_id)?;
        let mut revision = Some(text(&document, "current_revision_id")?.to_owned());
        let mut items = Vec::new();
        let root = self.document_root(doc_id)?;
        let mut seen = std::collections::BTreeSet::new();
        while let Some(id) = revision {
            ensure(
                seen.insert(id.clone()),
                "hetu.integrity_failure",
                "正文历史引用成环。",
            )?;
            checked_id(&id, "rev")?;
            let item = self.store.json(&format!("{root}/revisions/{id}.json"))?;
            ensure(
                item["document_id"] == doc_id && item["revision_id"] == id,
                "hetu.integrity_failure",
                "正文历史归属不一致。",
            )?;
            revision = item["parent_revision_id"].as_str().map(str::to_owned);
            items.push(item);
            ensure(
                items.len() <= 100_000,
                "hetu.budget_exceeded",
                "正文历史超过读取预算。",
            )?;
        }
        self.record_page(input, items, "revisions")
    }
}
