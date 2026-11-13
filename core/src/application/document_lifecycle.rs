use super::*;
use std::collections::BTreeSet;

pub(super) fn definition(name: &str) -> Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    let source = SCHEMA.get_or_init(|| serde_json::from_str(include_str!("../../../contracts/schemas/document-lifecycle.schema.json")).expect("embedded lifecycle schema"));
    domain::schema::definition(source, name)
}

fn seal(mut value: Value) -> Result<Value> {
    value["sha256"] = json!(digest(serde_json_canonicalizer::to_vec(&value)?));
    Ok(value)
}

fn span<'a>(content: &'a str, range: &Value) -> Result<&'a str> {
    let start = usize::try_from(integer(range, "byte_start")?).map_err(|_| Error::new("hetu.invalid_source_ref", "选区超出范围。"))?;
    let end = usize::try_from(integer(range, "byte_end")?).map_err(|_| Error::new("hetu.invalid_source_ref", "选区超出范围。"))?;
    let selected = content.get(start..end).ok_or_else(|| Error::new("hetu.invalid_source_ref", "选区必须位于原始 UTF-8 字符边界内。"))?;
    ensure(selected == text(range, "quote")?, "hetu.invalid_source_ref", "选区引文与原始内容不符。")?;
    Ok(selected)
}

impl Kernel {
    fn lifecycle_document(&self, reference: &Value) -> Result<Value> {
        let value = self.document_content(text(reference, "document_id")?, Some(text(reference, "revision_id")?))?;
        ensure(value["document"]["draft_source_id"].is_null(), "forbidden", "参考稿证据不是作者写作稿。")?;
        ensure(value["document"]["current_revision_id"] == reference["revision_id"] && value["revision"]["sha256"] == reference["sha256"], "revision_conflict", "写作稿已变化，请重新读取并预览。")?;
        Ok(value)
    }

    fn lifecycle_history(&self, document: &Value, kind: &str) -> Result<Vec<Value>> {
        let doc_id = text(document, "document_id")?;
        let root = self.document_root(doc_id)?;
        let mut current = document[format!("last_{kind}_ref")].clone();
        let mut seen = BTreeSet::new();
        let mut records = Vec::new();
        while !current.is_null() {
            let record_id = checked_id(text(&current, &format!("{kind}_id"))?, kind)?;
            ensure(seen.insert(record_id.clone()) && records.len() < 1000, "hetu.integrity_failure", "历史记录链循环或超过上限。")?;
            let path = format!("{root}/{kind}s/{record_id}.json");
            let descriptor = self.store.json(&format!(".hetu/{kind}s/{record_id}.json"))?;
            let content = self.store.read(&path)?;
            ensure(content.len() <= validation::OUTPUT_LIMIT && current["sha256"] == digest(&content) && descriptor == json!({"document_id":doc_id,"path":path,"reference":current}), "hetu.integrity_failure", "历史记录与摘要索引不一致。")?;
            let record: Value = serde_json::from_slice(&content)?;
            ensure(record["schema_version"] == "1.0.0" && record["workspace_id"] == self.scope() && record["document_id"] == doc_id && record[format!("{kind}_id")] == record_id, "hetu.integrity_failure", "历史记录归属无效。")?;
            let reference = record["document_ref"].clone();
            ensure(reference["document_id"] == doc_id, "hetu.integrity_failure", "历史记录的正文归属不符。")?;
            let revision_id = checked_id(text(&reference, "revision_id")?, "rev")?;
            let revision = self.store.json(&format!("{root}/revisions/{revision_id}.json"))?;
            let ext = if document["source_format"] == "fountain" { "fountain" } else { "md" };
            let content_path = format!("{root}/revisions/{revision_id}.{ext}");
            ensure(revision["document_id"] == doc_id && revision["revision_id"] == revision_id && revision["content_path"] == content_path && revision["sha256"] == reference["sha256"] && digest(self.store.read(&content_path)?) == reference["sha256"], "hetu.integrity_failure", "历史决定所引用的正文已损坏。")?;
            current = record["previous"].clone();
            records.push(record);
        }
        records.reverse();
        Ok(records)
    }

    pub(super) fn verify_lifecycle_head(&self, document: &Value) -> Result<()> {
        let records = self.lifecycle_history(document, "finalization")?;
        if let Some(latest) = records.last() {
            if latest["decision"] == "confirmed" {
                ensure(document["finalization_ref"] == document["last_finalization_ref"] && document["approved_revision_id"] == latest["document_ref"]["revision_id"], "hetu.integrity_failure", "定稿指针与作者确认历史不符。")?;
            } else {
                ensure(latest["decision"] == "withdrawn" && document["finalization_ref"].is_null() && document["approved_revision_id"].is_null(), "hetu.integrity_failure", "撤回记录与当前定稿指针不符。")?;
            }
        } else {
            ensure(document["finalization_ref"].is_null(), "hetu.integrity_failure", "定稿指针缺少独立确认记录。")?;
        }
        Ok(())
    }

    fn stage_lifecycle(&self, document: &mut Value, kind: &str, mut record: Value, changes: &mut Changes) -> Result<Value> {
        let doc_id = text(document, "document_id")?.to_owned();
        let record_id = text(&record, &format!("{kind}_id"))?.to_owned();
        let root = self.document_root(&doc_id).or_else(|error| {
            if changes.contains_key(&format!("packages/novel/documents/{doc_id}/document.json")) { Ok(format!("packages/novel/documents/{doc_id}")) }
            else if changes.contains_key(&format!("packages/drama/documents/{doc_id}/document.json")) { Ok(format!("packages/drama/documents/{doc_id}")) }
            else { Err(error) }
        })?;
        record["schema_version"] = json!("1.0.0");
        record["document_id"] = json!(doc_id);
        record["workspace_id"] = json!(self.scope());
        record["previous"] = document[format!("last_{kind}_ref")].clone();
        record["actor_ref"] = json!(self.actor());
        record["created_at"] = json!(now());
        let content = bytes(&record)?;
        ensure(content.len() <= validation::OUTPUT_LIMIT, "hetu.budget_exceeded", "历史记录超过预算。")?;
        let reference = json!({format!("{kind}_id"):record_id,"sha256":digest(&content)});
        let path = format!("{root}/{kind}s/{record_id}.json");
        self.store.directory(&format!("{root}/{kind}s"))?;
        self.store.directory(&format!(".hetu/{kind}s"))?;
        ensure(!self.store.exists(&path)?, "hetu.integrity_failure", "历史记录不可覆盖。")?;
        changes.insert(path.clone(), content);
        changes.insert(format!(".hetu/{kind}s/{record_id}.json"), bytes(&json!({"document_id":doc_id,"path":path,"reference":reference}))?);
        document[format!("last_{kind}_ref")] = reference.clone();
        changes.insert(format!("{root}/document.json"), bytes(document)?);
        Ok(json!({"record":record,"reference":reference}))
    }

    fn adoption_plan(&self, input: &Value) -> Result<(Value, String)> {
        let value = self.draft_content(text(&input["draft_ref"], "draft_id")?)?;
        let draft = &value["draft"];
        ensure(draft["revision"] == input["draft_ref"]["revision"] && draft["content_sha256"] == input["draft_ref"]["sha256"], "revision_conflict", "参考稿状态或内容已变化。")?;
        ensure(matches!(draft["state"].as_str(), Some("submitted" | "in_review" | "approved")), "revision_conflict", "已驳回或接替的参考稿不能直接采纳。")?;
        ensure(matches!(draft["package"].as_str(), Some("novel" | "drama")), "invalid_input", "只有文本参考稿可采纳为正文。")?;
        let target = if input["target_ref"].is_null() {
            ensure(!input["new_document"].is_null() && draft["target_document_id"].is_null(), "invalid_input", "新建采纳目标与参考稿目标不符。")?;
            ensure(!text(&input["new_document"], "title")?.trim().is_empty(), "invalid_input", "新稿标题不能为空。")?;
            if draft["package"] == "novel" {
                let novel = self.novel()?.ok_or_else(|| Error::new("hetu.novel_initialization_required", "请先初始化小说目录。"))?;
                ensure(input["new_document"]["novel_expected"] == json!({"revision":novel["revision"],"sha256":digest(bytes(&novel)?)}), "revision_conflict", "卷章目录已变化，请重新选择标题与分卷。")?;
                ensure(input["new_document"]["volume_id"].is_null() || novel["volumes"].as_array().unwrap().iter().any(|v| v["volume_id"] == input["new_document"]["volume_id"]), "invalid_input", "目标分卷不存在。")?;
            } else {
                ensure(input["new_document"]["volume_id"].is_null() && input["new_document"]["novel_expected"].is_null(), "invalid_input", "剧本不使用小说分卷。")?;
            }
            json!({"content":"","document":null,"revision":null})
        } else {
            ensure(input["new_document"].is_null(), "invalid_input", "不能同时新建和修改正文。")?;
            let target = self.lifecycle_document(&input["target_ref"])?;
            ensure(target["document"]["source_format"] == draft["source_format"] && (draft["target_document_id"].is_null() || draft["target_document_id"] == target["document"]["document_id"]) && (draft["package"] == "drama") == (target["document"]["kind"] == "drama_script"), "invalid_input", "候选与目标文档的归属或格式不符。")?;
            self.lifecycle_history(&target["document"], "adoption")?;
            target
        };
        let original = text(&target, "content")?;
        let source = text(&value, "content")?;
        let mut selections = input["selected_ranges"].as_array().unwrap().clone();
        selections.sort_by_key(|s| s["target"]["byte_start"].as_u64().unwrap());
        let mut source_ranges = Vec::new();
        let mut previous_end = None;
        for selected in &selections {
            let extracted = span(source, &selected["source"])?;
            ensure(!extracted.is_empty(), "hetu.invalid_source_ref", "请选择非空参考内容。")?;
            span(original, &selected["target"])?;
            let start = integer(&selected["target"], "byte_start")?;
            let end = integer(&selected["target"], "byte_end")?;
            ensure(previous_end.is_none_or(|(pstart, pend)| start >= pend && start != pstart), "hetu.invalid_source_ref", "目标选区不能重叠或使用相同插入点。")?;
            previous_end = Some((start,end));
            let a = integer(&selected["source"], "byte_start")?;
            let b = integer(&selected["source"], "byte_end")?;
            ensure(!source_ranges.iter().any(|&(c,d)| a < d && c < b), "hetu.invalid_source_ref", "参考稿选区不能重复或重叠。")?;
            source_ranges.push((a,b));
        }
        let mut content = original.to_owned();
        for selected in selections.iter().rev() {
            let replacement = selected.get("replacement").and_then(Value::as_str).unwrap_or(span(source, &selected["source"])?);
            content.replace_range(integer(&selected["target"], "byte_start")? as usize..integer(&selected["target"], "byte_end")? as usize, replacement);
        }
        ensure(content.len() <= 4_000_000, "hetu.budget_exceeded", "采纳后的正文超过大小限制。")?;
        let bp = self.blueprint()?;
        let snapshot = json!({"workspace_id":self.scope(),"draft":draft,"target_document":target["document"],"target_revision":target["revision"],"blueprint_revision":bp["revision"],"blueprint_sha256":digest(bytes(&bp)?)});
        Ok((seal(json!({"request":input,"snapshot":snapshot,"result_sha256":digest(&content)}))?, content))
    }

    pub(super) fn preview_adoption(&self, input: &Value) -> Result<Value> {
        let (preview, content) = self.adoption_plan(input)?;
        let baseline = if let Some(doc) = preview["snapshot"]["draft"]["target_document_id"].as_str() { self.document_content(doc, preview["snapshot"]["draft"]["base_revision_id"].as_str())? } else { Value::Null };
        Ok(json!({"preview":preview,"content":content,"baseline":baseline}))
    }

    pub(super) fn adopt_draft(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let requested = &input["preview"];
        let (preview, content) = self.adoption_plan(&requested["request"])?;
        ensure(preview == *requested, "revision_conflict", "采纳预览已变化，请重新比较。")?;
        let request = &requested["request"];
        let mut result = if request["target_ref"].is_null() {
            let draft = &preview["snapshot"]["draft"];
            self.create_document(&json!({"kind":if draft["package"] == "drama" {"drama_script"} else {"novel_chapter"},"title":request["new_document"]["title"],"volume_id":request["new_document"]["volume_id"],"source_format":draft["source_format"],"language_tag":draft["language_tag"],"content":content}), changes)?
        } else {
            self.save_document(&json!({"document_id":request["target_ref"]["document_id"],"base_revision_id":request["target_ref"]["revision_id"],"source_format":preview["snapshot"]["draft"]["source_format"],"content":content}), changes)?
        };
        let record_input = json!({"adoption_id":id("adoption"),"document_ref":{"document_id":result["revision"]["document_id"],"revision_id":result["revision"]["revision_id"],"sha256":result["revision"]["sha256"]},"draft_ref":request["draft_ref"],"base_revision_id":request["target_ref"]["revision_id"],"selected_ranges":request["selected_ranges"],"input_snapshot":preview["snapshot"]});
        let record = self.stage_lifecycle(&mut result["document"], "adoption", record_input, changes)?;
        let mut contributions = result["revision"]["contribution_refs"].as_array().cloned().unwrap_or_default();
        contributions.push(record["reference"].clone());
        result["revision"]["contribution_refs"] = json!(contributions);
        let path = text(&result["revision"], "content_path")?;
        let metadata = Path::new(path).with_extension("json").to_string_lossy().into_owned();
        changes.insert(metadata, bytes(&result["revision"])?);
        result["adoption"] = record;
        Ok(result)
    }

    pub(super) fn validate_document(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let value = self.lifecycle_document(&input["document_ref"])?;
        let (bp, sha) = self.blueprint_revision(None)?;
        let sources = vec![input["document_ref"].clone()];
        let documents = self.plot_documents(&sources)?;
        let plot = plot::extract(&documents, &bp, &sha, serde_json::from_value(input["plot_options"].clone())?, self.actor())?;
        let plot_sha = digest(serde_json::to_vec(&plot)?);
        let report = validation::run(&plot, &bp, &documents, &plot_sha, serde_json::from_value(input["validation_options"].clone())?, self.actor())?;
        self.stage_plot(&plot, &bp, changes)?;
        self.stage_report(&report, &bp, changes)?;
        Ok(json!({"document_ref":input["document_ref"],"report":report,"reference":{"report_id":report["report_id"],"sha256":digest(serde_json::to_vec(&report)?),"dispositions_sha256":digest(bytes(&json!([]))?)},"saved":true,"stale":false,"dispositions":[],"document":value["document"]}))
    }

    pub(super) fn preview_finalization(&self, input: &Value) -> Result<Value> {
        let value = self.lifecycle_document(&input["document_ref"])?;
        let document = &value["document"];
        ensure(document["finalization_ref"] == input["expected_finalization_ref"], "revision_conflict", "当前定稿指针已变化。")?;
        let bp = self.blueprint()?;
        let evidence = json!({"evidence_document_id":input["document_ref"]["document_id"],"evidence_revision_id":input["document_ref"]["revision_id"],"content_sha256":input["document_ref"]["sha256"],"blueprint_revision":bp["revision"],"blueprint_sha256":digest(bytes(&bp)?)});
        let blocker = match self.approval_evidence(&evidence, input) {
            Ok(_) => Value::Null,
            Err(error) => json!({"code":error.code,"message":error.message}),
        };
        let snapshot = json!({"workspace_id":self.scope(),"document":document,"revision":value["revision"],"blueprint_revision":bp["revision"],"blueprint_sha256":evidence["blueprint_sha256"]});
        Ok(json!({"preview":seal(json!({"request":input,"snapshot":snapshot,"eligible":blocker.is_null(),"blocker":blocker}))?,"content":value["content"]}))
    }

    pub(super) fn finalize_document(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let requested = &input["preview"];
        let prepared = self.preview_finalization(&requested["request"])?;
        ensure(prepared["preview"] == *requested, "hetu.stale_evidence", "定稿预览或证据已变化，请重新审阅。")?;
        ensure(requested["eligible"] == true, "hetu.review_conflict", "仍有定稿阻断，请处理问题或覆盖说明。")?;
        ensure(!text(&requested["request"], "comments")?.trim().is_empty(), "invalid_input", "请记录定稿理由。")?;
        let mut document = requested["snapshot"]["document"].clone();
        let record = self.stage_lifecycle(&mut document, "finalization", json!({"finalization_id":id("finalization"),"decision":"confirmed","document_ref":requested["request"]["document_ref"],"expected_finalization_ref":requested["request"]["expected_finalization_ref"],"input_snapshot":requested["snapshot"],"report_refs":requested["request"]["report_refs"],"comments":requested["request"]["comments"],"coverage_acknowledgement":requested["request"]["coverage_acknowledgement"]}), changes)?;
        document["approved_revision_id"] = requested["request"]["document_ref"]["revision_id"].clone();
        document["finalization_ref"] = record["reference"].clone();
        document.as_object_mut().unwrap().remove("approved_review_id");
        changes.insert(format!("{}/document.json", self.document_root(text(&document, "document_id")?)?), bytes(&document)?);
        Ok(json!({"document":document,"finalization":record}))
    }

    pub(super) fn withdraw_finalization(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let mut document = self.document(text(input, "document_id")?)?;
        self.verify_lifecycle_head(&document)?;
        ensure(!document["finalization_ref"].is_null() && document["finalization_ref"] == input["expected_finalization_ref"], "revision_conflict", "定稿已由其他决定更新，不能撤回旧记录。")?;
        ensure(!text(input, "reason")?.trim().is_empty(), "invalid_input", "请填写撤回理由。")?;
        let history = self.lifecycle_history(&document, "finalization")?;
        let record = self.stage_lifecycle(&mut document, "finalization", json!({"finalization_id":id("finalization"),"decision":"withdrawn","document_ref":history.last().unwrap()["document_ref"],"expected_finalization_ref":input["expected_finalization_ref"],"comments":input["reason"]}), changes)?;
        for field in ["approved_revision_id", "approved_review_id", "finalization_ref"] { document.as_object_mut().unwrap().remove(field); }
        changes.insert(format!("{}/document.json", self.document_root(text(&document, "document_id")?)?), bytes(&document)?);
        Ok(json!({"document":document,"finalization":record}))
    }

    pub(super) fn document_lifecycle(&self, input: &Value) -> Result<Value> {
        let document = self.document_content(text(input, "document_id")?, None)?["document"].clone();
        self.verify_lifecycle_head(&document)?;
        let value = json!({"document":document,"adoptions":self.lifecycle_history(&document,"adoption")?,"finalizations":self.lifecycle_history(&document,"finalization")?});
        ensure(bytes(&value)?.len() <= validation::OUTPUT_LIMIT, "hetu.budget_exceeded", "历史结果超过读取预算。")?;
        Ok(value)
    }
}
