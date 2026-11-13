use super::*;
use std::collections::BTreeSet;

impl Kernel {
    pub(super) fn plot_documents(&self, sources: &[Value]) -> Result<Vec<plot::Document>> {
        let mut seen = BTreeSet::new();
        let mut documents = Vec::new();
        for source in sources {
            let document_id = text(source, "document_id")?;
            ensure(
                seen.insert(document_id),
                "invalid_input",
                "一次提取只能选择每篇文档的一个修订。",
            )?;
            let value = self.document_content(document_id, Some(text(source, "revision_id")?))?;
            ensure(
                source["sha256"] == value["revision"]["sha256"],
                "hetu.stale_evidence",
                "原文修订摘要不一致，请重新读取。",
            )?;
            let revision: plot::SourceRevision = serde_json::from_value(json!({
                "document_id": document_id, "revision_id":value["revision"]["revision_id"],
                "sha256":value["revision"]["sha256"], "source_format":value["revision"]["source_format"],
                "size_bytes":value["revision"]["size_bytes"]
            }))?;
            documents.push(plot::Document {
                source: revision,
                content: text(&value, "content")?.into(),
                scope_document_id: value["document"]["target_document_id"]
                    .as_str()
                    .map(str::to_owned),
                package: value["document"]["package"]
                    .as_str()
                    .unwrap_or(if value["document"]["source_format"] == "fountain" {
                        "drama"
                    } else {
                        "novel"
                    })
                    .to_owned(),
            });
        }
        Ok(documents)
    }
    pub(super) fn extract_plot(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let (bp, sha) = self.blueprint_revision(Some(integer(input, "blueprint_revision")?))?;
        let documents = self.plot_documents(input["document_revisions"].as_array().unwrap())?;
        let options = serde_json::from_value(input["options"].clone())?;
        let plot = plot::extract(&documents, &bp, &sha, options, self.actor())?;
        let saved = input["save_result"] == true;
        if saved {
            self.stage_plot(&plot, &bp, changes)?;
        }
        self.plot_result(&plot, saved)
    }
    pub(super) fn correct_plot(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let current = self.read_plot(text(input, "plot_revision_id")?)?;
        let (bp, _) = self.blueprint_revision(Some(current.blueprint_revision))?;
        let sources = serde_json::to_value(&current.source_revisions)?;
        let documents = self.plot_documents(sources.as_array().unwrap())?;
        let next = plot::correct(
            &current,
            input["corrections"].as_array().unwrap(),
            &bp,
            &documents,
            self.actor(),
        )?;
        self.stage_plot(&next, &bp, changes)?;
        self.plot_result(&next, true)
    }
    pub(super) fn stage_plot(
        &self,
        plot: &plot::Plot,
        bp: &Value,
        changes: &mut Changes,
    ) -> Result<()> {
        self.store.directory("packages/novel/plot")?;
        self.store.directory(".hetu/plots")?;
        let path = format!("packages/novel/plot/{}.json", plot.plot_revision_id);
        let record = format!(".hetu/plots/{}.json", plot.plot_revision_id);
        ensure(
            !self.store.exists(&path)? && !self.store.exists(&record)?,
            "hetu.integrity_failure",
            "剧情修订已存在，不能覆盖。",
        )?;
        let content = serde_json::to_vec(plot)?;
        let mut descriptor = plot::summary(plot, &digest(&content));
        descriptor["schema_version"] = json!("1.0.0");
        descriptor["path"] = json!(path);
        stage_blueprint_snapshot(&self.store, bp, changes)?;
        changes.insert(path, content);
        changes.insert(record, bytes(&descriptor)?);
        Ok(())
    }
    pub(super) fn plot_descriptor(&self, revision: &str) -> Result<Value> {
        checked_id(revision, "plotrev")?;
        ensure(
            self.store
                .entries(".hetu")?
                .iter()
                .any(|name| name == "plots"),
            "not_found",
            "没有保存该剧情修订。",
        )?;
        let record = self.store.json(&format!(".hetu/plots/{revision}.json"))?;
        ensure(
            record["schema_version"] == "1.0.0"
                && record["plot_revision_id"] == revision
                && record["path"] == format!("packages/novel/plot/{revision}.json"),
            "hetu.integrity_failure",
            "剧情修订索引的身份或路径不一致。",
        )?;
        Ok(record)
    }
    pub(super) fn read_plot(&self, revision: &str) -> Result<plot::Plot> {
        let record = self.plot_descriptor(revision)?;
        let content = self.store.read(text(&record, "path")?)?;
        ensure(
            content.len() <= plot::OUTPUT_LIMIT && record["sha256"] == digest(&content),
            "hetu.integrity_failure",
            "剧情历史修订已被改写，停止使用此证据。",
        )?;
        let plot = plot::decode(&serde_json::from_slice(&content)?)?;
        let mut expected = plot::summary(&plot, &digest(&content));
        expected["schema_version"] = json!("1.0.0");
        expected["path"] = record["path"].clone();
        ensure(
            record == expected && plot.plot_revision_id == revision,
            "hetu.integrity_failure",
            "剧情索引与内容不一致。",
        )?;
        let (bp, sha) = self.blueprint_revision(Some(plot.blueprint_revision))?;
        ensure(
            sha == plot.blueprint_sha256,
            "hetu.integrity_failure",
            "剧情引用的设定集摘要不一致。",
        )?;
        let sources = serde_json::to_value(&plot.source_revisions)?;
        let documents = self.plot_documents(sources.as_array().unwrap())?;
        plot::validate(&plot, &bp, &documents)?;
        Ok(plot)
    }
    pub(super) fn plot_result(&self, plot: &plot::Plot, saved: bool) -> Result<Value> {
        let current_bp = self.blueprint()?;
        let mut stale_reasons = Vec::new();
        if current_bp["revision"] != plot.blueprint_revision {
            stale_reasons.push(json!({"code":"blueprint_changed","expected_revision":plot.blueprint_revision,"current_revision":current_bp["revision"]}));
        }
        for source in &plot.source_revisions {
            let document = self.document(&source.document_id)?;
            if document["current_revision_id"] != source.revision_id {
                stale_reasons.push(json!({"code":"document_changed","document_id":source.document_id,"expected_revision_id":source.revision_id,"current_revision_id":document["current_revision_id"]}));
            }
        }
        Ok(
            json!({"plot":plot,"saved":saved,"stale":!stale_reasons.is_empty(),"stale_reasons":stale_reasons}),
        )
    }
    pub(super) fn list_plots(&self, input: &Value) -> Result<Value> {
        let filter = input.get("document_id").and_then(Value::as_str);
        if let Some(document_id) = filter {
            self.document(document_id)?;
        }
        let mut records = Vec::new();
        if self
            .store
            .entries(".hetu")?
            .iter()
            .any(|name| name == "plots")
        {
            for name in self.store.entries(".hetu/plots")? {
                let revision = name
                    .strip_suffix(".json")
                    .ok_or_else(|| Error::new("hetu.integrity_failure", "剧情索引名称无效。"))?;
                let record = self.plot_descriptor(revision)?;
                if filter.is_none_or(|doc| {
                    record["source_revisions"]
                        .as_array()
                        .is_some_and(|items| items.iter().any(|item| item["document_id"] == doc))
                }) {
                    records.push(record);
                }
            }
        }
        records.sort_by(|a, b| {
            b["created_at"]
                .as_str()
                .cmp(&a["created_at"].as_str())
                .then_with(|| {
                    b["plot_revision_id"]
                        .as_str()
                        .cmp(&a["plot_revision_id"].as_str())
                })
        });
        let fingerprint = digest(serde_json::to_vec(
            &json!({"scope":self.scope(),"document_id":filter,"records":records}),
        )?);
        let start = if let Some(cursor) = input.get("cursor").and_then(Value::as_str) {
            let (hash, offset) = cursor
                .split_once(':')
                .ok_or_else(|| Error::new("cursor_invalid", "分页游标无效，请重新查询。"))?;
            let offset = offset
                .parse::<usize>()
                .map_err(|_| Error::new("cursor_invalid", "分页游标无效。"))?;
            ensure(
                hash == fingerprint && offset > 0 && offset < records.len(),
                "cursor_invalid",
                "剧情列表已变化或游标不属于本次查询，请重新查询。",
            )?;
            offset
        } else {
            0
        };
        let limit = input["limit"].as_u64().unwrap_or(50) as usize;
        let end = start.saturating_add(limit).min(records.len());
        let next = (end < records.len()).then(|| format!("{fingerprint}:{end}"));
        Ok(json!({"plots":&records[start..end],"next_cursor":next}))
    }
}
