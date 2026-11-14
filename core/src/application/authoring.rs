use super::*;

// 作者笔记单独修订；保存笔记既不改正文，也不改变定稿。
impl Kernel {
    fn authoring_path(&self, kind: &str, document: Option<&str>) -> Result<(String, String)> {
        match kind {
            "annotations" => {
                let id = checked_id(document.unwrap_or(""), "doc")?;
                self.document(&id)?;
                Ok((format!("packages/novel/annotations/{id}.json"), format!("annotations-{id}")))
            }
            "outlines" => Ok(("packages/novel/outlines.json".into(), "outlines".into())),
            _ => Err(Error::new("invalid_input", "未知笔记类型。")),
        }
    }

    pub(super) fn authoring_get(&self, kind: &str, input: &Value) -> Result<Value> {
        let (path, key) = self.authoring_path(kind, input["document_id"].as_str())?;
        if !self.store.exists(&path)? {
            return Ok(json!({"revision":0,"sha256":null,"items":[]}));
        }
        let content = self.store.read(&path)?;
        let value: Value = serde_json::from_slice(&content)?;
        ensure(value["workspace_id"] == self.scope(), "hetu.integrity_failure", "笔记所属作品不一致。")?;
        let revision = integer(&value, "revision")?;
        ensure(self.store.read(&format!(".hetu/authoring/{key}/{revision}.json"))? == content,
            "hetu.integrity_failure", "笔记与历史记录不一致，请保留文件并检查。")?;
        Ok(json!({"revision":revision,"sha256":digest(&content),"items":value["items"]}))
    }

    pub(super) fn authoring_save(&self, kind: &str, input: &Value, changes: &mut Changes) -> Result<Value> {
        let current = self.authoring_get(kind, input)?;
        ensure(input["expected"]["revision"] == current["revision"] && input["expected"]["sha256"] == current["sha256"],
            "revision_conflict", "笔记已有更新，请刷新并比较，当前输入仍可保留。")?;
        let items = input["items"].as_array().ok_or_else(|| Error::new("invalid_input", "笔记列表无效。"))?;
        let mut ids = std::collections::BTreeSet::new();
        for item in items {
            let item_id = checked_id(text(item, "id")?, if kind == "annotations" { "note" } else { "outline" })?;
            ensure(ids.insert(item_id), "invalid_input", "笔记标识不能重复。")?;
            ensure(!text(item, "text")?.trim().is_empty(), "invalid_input", "请填写笔记内容。")?;
            if kind == "annotations" {
                let source = &item["source_ref"];
                ensure(source["document_id"] == input["document_id"], "invalid_input", "批注必须属于当前文档。")?;
                let fixed = self.document_content(text(source,"document_id")?, Some(text(source,"revision_id")?))?;
                let body = text(&fixed, "content")?;
                let start = integer(source,"byte_start")? as usize;
                let end = integer(source,"byte_end")? as usize;
                ensure(start < end && body.get(start..end) == source["quote"].as_str(), "hetu.invalid_source_ref", "批注引文与原稿不符。")?;
            } else {
                let novel = self.novel()?.ok_or_else(|| Error::new("not_found", "请先初始化作品资料。"))?;
                let target = &item["target_id"];
                let valid = match text(item,"level")? {
                    "book" => target.is_null(),
                    "volume" => novel["volumes"].as_array().unwrap().iter().any(|v| v["volume_id"] == *target),
                    "chapter" => novel["chapters"].as_array().unwrap().iter().any(|c| c["document_id"] == *target),
                    _ => false,
                };
                ensure(valid, "invalid_input", "大纲关联的卷或章节不存在。")?;
            }
        }
        let (path, key) = self.authoring_path(kind, input["document_id"].as_str())?;
        let revision = integer(&current,"revision")?.checked_add(1).ok_or_else(|| Error::new("hetu.budget_exceeded", "笔记修订已达上限。"))?;
        let value = json!({"schema_version":"1.0.0","workspace_id":self.scope(),"revision":revision,"previous_sha256":current["sha256"],"items":items,"updated_at":now()});
        let content = bytes(&value)?;
        ensure(content.len() <= 4 * 1024 * 1024, "hetu.budget_exceeded", "本次笔记超过保存上限。")?;
        self.store.directory(".hetu/authoring")?;
        self.store.directory(&format!(".hetu/authoring/{key}"))?;
        changes.insert(format!(".hetu/authoring/{key}/{revision}.json"), content.clone());
        changes.insert(path, content.clone());
        Ok(json!({"revision":revision,"sha256":digest(&content),"items":items}))
    }

    pub(super) fn document_history(&self, input: &Value) -> Result<Value> {
        let doc_id = text(input,"document_id")?;
        let document = self.document(doc_id)?;
        let mut revision = Some(text(&document,"current_revision_id")?.to_owned());
        let mut items = Vec::new();
        let root = self.document_root(doc_id)?;
        let mut seen = std::collections::BTreeSet::new();
        while let Some(id) = revision {
            ensure(seen.insert(id.clone()), "hetu.integrity_failure", "正文历史引用成环。")?;
            checked_id(&id,"rev")?;
            let item = self.store.json(&format!("{root}/revisions/{id}.json"))?;
            ensure(item["document_id"] == doc_id && item["revision_id"] == id, "hetu.integrity_failure", "正文历史归属不一致。")?;
            revision = item["parent_revision_id"].as_str().map(str::to_owned);
            items.push(item);
            ensure(items.len() <= 100_000, "hetu.budget_exceeded", "正文历史超过读取预算。")?;
        }
        self.record_page(input, items, "revisions")
    }
}
