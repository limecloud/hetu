use super::*;

const DEFAULT_READ_BYTES: usize = 16 * 1024;
const MAX_READ_BYTES: usize = 64 * 1024;

pub(super) fn entries(request: &Value) -> Vec<Value> {
    request["input_snapshot"]["sources"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(index, source)| {
            json!({"context_id":format!("context_{index}"),"kind":source["reference"]["kind"],
                "fixed_ref":source["reference"],"sha256":source["sha256"],
                "allowed_ranges":null,"title":source.get("title").cloned().unwrap_or(json!("")),
                "size_bytes":source.get("size_bytes").cloned().unwrap_or_else(|| {
                    json!(source["content"].as_str().map(str::len).unwrap_or(0))
                }),"summary_ref":null,"source_kind":match source["reference"]["kind"].as_str() {Some("resource")=>"resource",Some("plugin_object")=>"plugin",_=>"author"}})
        })
        .collect()
}

fn before_boundary(content: &str, mut at: usize) -> usize {
    at = at.min(content.len());
    while !content.is_char_boundary(at) {
        at -= 1;
    }
    at
}

fn text_source_ref(entry: &Value, content: &str, start: usize, end: usize) -> Value {
    let mut reference = if entry["kind"] == "resource" {
        entry["fixed_ref"].clone()
    } else {
        json!({"document_id":entry["fixed_ref"]["document_id"],"revision_id":entry["fixed_ref"]["revision_id"]})
    };
    reference["byte_start"] = json!(start);
    reference["byte_end"] = json!(end);
    reference["quote"] = json!(&content[start..end]);
    reference
}

impl Kernel {
    fn read_structured_context(
        &self,
        input: &Value,
        entry: &Value,
        blueprint: &Value,
        budget: usize,
    ) -> Result<Value> {
        ensure(
            input.get("range").is_none(),
            "invalid_input",
            "设定集不接受文本选区。",
        )?;
        ensure(
            (input.get("result_path").is_none() && input.get("offset").is_none())
                || (input["section"].is_string() && input["entity_id"].is_string()),
            "invalid_input",
            "字段分页必须选择固定设定实体。",
        )?;
        let mut result = json!({"context_ref":input["context_ref"],"fixed_ref":entry["fixed_ref"],"sha256":entry["sha256"]});
        let Some(section) = input["section"].as_str() else {
            ensure(
                input.get("entity_id").is_none()
                    && input.get("cursor").is_none()
                    && input.get("limit").is_none(),
                "invalid_input",
                "请先选择设定分类，再读取目录或实体。",
            )?;
            if bytes(blueprint)?.len() <= budget {
                result["blueprint"] = blueprint.clone();
                result["complete"] = json!(true);
            } else {
                let sections = domain::blueprint::SECTIONS.iter().map(|(_, field, _)| {
                        json!({"section":field,"count":blueprint[*field].as_array().unwrap().len()})
                    }).collect::<Vec<_>>();
                ensure(
                    bytes(&json!(sections))?.len() <= budget,
                    "hetu.budget_exceeded",
                    "读取预算不足以返回设定分类目录。",
                )?;
                result["sections"] = json!(sections);
                result["complete"] = json!(false);
            }
            return Ok(result);
        };
        let (_, _, id_field) = domain::blueprint::SECTIONS
            .iter()
            .find(|(_, field, _)| *field == section)
            .ok_or_else(|| Error::new("invalid_input", "设定分类无效。"))?;
        let rows = blueprint[section].as_array().unwrap();
        result["section"] = json!(section);
        if let Some(entity_id) = input["entity_id"].as_str() {
            ensure(
                input.get("cursor").is_none() && input.get("limit").is_none(),
                "invalid_input",
                "实体读取不接受目录分页参数。",
            )?;
            let entity = rows
                .iter()
                .find(|row| row[*id_field] == entity_id)
                .ok_or_else(|| Error::new("not_found", "固定设定集中没有此实体。"))?;
            let raw = bytes(entity)?;
            if input.get("result_path").is_some() {
                result["entity_id"] = json!(entity_id);
                result["entity_sha256"] = json!(digest(&raw));
                result["entity_page"] = crate::machine::value_page(entity, input)?;
                result["complete"] = json!(false);
                return Ok(result);
            }
            ensure(
                raw.len() <= budget,
                "hetu.budget_exceeded",
                "此设定实体超过本次读取预算，请在允许范围内提高 max_bytes。",
            )?;
            result["entity"] = entity.clone();
            result["entity_id"] = json!(entity_id);
            result["entity_sha256"] = json!(digest(&raw));
            result["complete"] = json!(true);
        } else {
            let records = rows.iter().map(|row| {
                let raw = bytes(row)?;
                let title = row.get("name").or_else(|| row.get("title")).or_else(|| row.get("rationale"))
                    .and_then(Value::as_str).map(|title| json!(title.chars().take(200).collect::<String>()))
                    .unwrap_or_else(|| row[*id_field].clone());
                Ok(json!({"entity_id":row[*id_field],"title":title,"size_bytes":raw.len(),"entity_sha256":digest(&raw)}))
            }).collect::<Result<Vec<_>>>()?;
            let mut page_input = input.clone();
            page_input["limit"] = json!(input["limit"].as_u64().unwrap_or(20));
            let page = loop {
                let page = self.ordered_record_page(&page_input, records.clone(), "entities")?;
                if bytes(&page)?.len() <= budget {
                    break page;
                }
                let count = page["entities"].as_array().unwrap().len();
                ensure(
                    count > 1,
                    "hetu.budget_exceeded",
                    "读取预算不足以返回设定实体目录。",
                )?;
                page_input["limit"] = json!(count / 2);
            };
            result["entities"] = page["entities"].clone();
            result["next_cursor"] = page["next_cursor"].clone();
            result["complete"] = json!(page["next_cursor"].is_null());
        }
        Ok(result)
    }

    pub(super) fn stage_context_manifest(
        &self,
        request: &mut Value,
        changes: &mut Changes,
    ) -> Result<()> {
        let manifest_id = id("manifest");
        let manifest = json!({"schema_version":"1.0.0","manifest_id":manifest_id,
            "scope_ref":request["scope_ref"],"task_id":request["task_id"],
            "request_revision":request["request_revision"],"entries":entries(request)});
        record_schema(&manifest, "context_manifest_record")?;
        let folder = root(text(request, "task_id")?)?;
        self.store.directory(&format!("{folder}/context"))?;
        let raw = bytes(&manifest)?;
        request["context_manifest_ref"] = json!({"manifest_id":manifest_id,"sha256":digest(&raw)});
        changes.insert(format!("{folder}/context/{manifest_id}.json"), raw);
        Ok(())
    }

    pub(super) fn verify_context_manifest(&self, request: &Value) -> Result<()> {
        if request["schema_version"] == "1.0.0" {
            return Ok(());
        }
        let manifest_id = checked_id(
            text(&request["context_manifest_ref"], "manifest_id")?,
            "manifest",
        )?;
        let folder = root(text(request, "task_id")?)?;
        let raw = self
            .store
            .read(&format!("{folder}/context/{manifest_id}.json"))?;
        let manifest: Value = serde_json::from_slice(&raw)?;
        record_schema(&manifest, "context_manifest_record")?;
        ensure(
            request["context_manifest_ref"]["sha256"] == digest(&raw)
                && manifest["manifest_id"] == manifest_id
                && manifest["scope_ref"] == request["scope_ref"]
                && manifest["task_id"] == request["task_id"]
                && manifest["request_revision"] == request["request_revision"]
                && manifest["entries"] == json!(entries(request)),
            "hetu.integrity_failure",
            "任务固定资料清单身份或摘要不一致。",
        )
    }

    /// 只回读明确固定的修订，不解析调用方路径，也不跟随作品当前头。
    pub(super) fn fixed_context_source(&self, source: &Value) -> Result<Value> {
        let reference = &source["reference"];
        if reference["kind"] == "document" {
            let document = self.document_content(
                text(reference, "document_id")?,
                Some(text(reference, "revision_id")?),
            )?;
            ensure(
                source["sha256"] == document["revision"]["sha256"],
                "hetu.integrity_failure",
                "固定原文摘要不一致。",
            )?;
            if let Some(old) = source.get("content") {
                ensure(
                    old == &document["content"],
                    "hetu.integrity_failure",
                    "任务原文与固定修订不一致。",
                )?;
            }
            Ok(json!({"content":document["content"]}))
        } else if reference["kind"] == "resource" {
            let (record, sha) = self.source_resource(reference)?;
            ensure(
                source["sha256"] == sha,
                "hetu.integrity_failure",
                "固定资料记录摘要不一致。",
            )?;
            Ok(json!({"content":record["body"]}))
        } else if reference["kind"] == "plugin_object" {
            let (record, sha) = self.fixed_professional_object(reference)?;
            ensure(source["sha256"] == sha, "hetu.integrity_failure", "固定专业来源摘要不一致。")?;
            Ok(json!({"plugin_object":record}))
        } else {
            let (blueprint, sha) = self.source_blueprint(reference)?;
            ensure(
                source["sha256"] == sha,
                "hetu.integrity_failure",
                "固定设定集摘要不一致。",
            )?;
            Ok(json!({"blueprint":blueprint}))
        }
    }

    pub(in crate::application) fn list_task_context(&self, input: &Value) -> Result<Value> {
        let (request, _, _, _) = self.task_for_reference(&input["task_ref"])?;
        let records = entries(&request)
            .into_iter()
            .filter(|entry| input.get("kind").is_none_or(|kind| *kind == entry["kind"]))
            .map(|mut entry| {
                entry["context_ref"] =
                    json!({"context_id":entry["context_id"],"sha256":entry["sha256"]});
                entry
            })
            .collect();
        let mut result = self.ordered_record_page(input, records, "entries")?;
        result["limits"] = json!({"entries":100,"text_bytes_per_entry":TEXT_LIMIT,"default_read_bytes":DEFAULT_READ_BYTES,"max_read_bytes":MAX_READ_BYTES});
        Ok(result)
    }

    pub(in crate::application) fn read_task_context(&self, input: &Value) -> Result<Value> {
        let (request, _, _, _) = self.task_for_reference(&input["task_ref"])?;
        let directory = entries(&request);
        let (index, entry) = directory
            .iter()
            .enumerate()
            .find(|(_, entry)| {
                entry["context_id"] == input["context_ref"]["context_id"]
                    && entry["sha256"] == input["context_ref"]["sha256"]
            })
            .ok_or_else(|| Error::new("forbidden", "本任务未授权这份固定资料。"))?;
        let source = self.fixed_context_source(&request["input_snapshot"]["sources"][index])?;
        let budget = input["max_bytes"]
            .as_u64()
            .unwrap_or(DEFAULT_READ_BYTES as u64) as usize;
        if entry["kind"] == "blueprint" {
            return self.read_structured_context(input, entry, &source["blueprint"], budget);
        }
        if entry["kind"] == "plugin_object" {
            ensure(["range","section","entity_id","cursor","limit"].iter().all(|key|input.get(*key).is_none()),
                "invalid_input","专业对象使用字段投影与字节分页读取。")?;
            let mut page_input=input.clone();
            page_input["max_bytes"]=json!(budget);
            return Ok(json!({"context_ref":input["context_ref"],"fixed_ref":entry["fixed_ref"],
                "sha256":entry["sha256"],"source_kind":"plugin","page":crate::machine::value_page(&source["plugin_object"],&page_input)?}));
        }
        ensure(
            [
                "section",
                "entity_id",
                "cursor",
                "limit",
                "result_path",
                "offset",
            ]
            .iter()
            .all(|key| input.get(*key).is_none()),
            "invalid_input",
            "文本原文不接受设定分类或实体参数。",
        )?;
        let content = text(&source, "content")?;
        let start = input["range"]["byte_start"].as_u64().unwrap_or(0) as usize;
        let requested_end = input["range"]["byte_end"]
            .as_u64()
            .unwrap_or(content.len() as u64) as usize;
        ensure(
            start <= requested_end
                && requested_end <= content.len()
                && content.is_char_boundary(start)
                && content.is_char_boundary(requested_end),
            "hetu.invalid_source_ref",
            "读取范围必须位于固定原文的 UTF-8 字符边界。",
        )?;
        let mut end = before_boundary(content, requested_end.min(start.saturating_add(budget)));
        if input.get("range").is_none() && end < requested_end {
            if let Some(paragraph) = content[start..end].rfind("\n\n") {
                if paragraph >= budget / 2 {
                    end = start + paragraph + 2;
                }
            }
        }
        let quote = &content[start..end];
        let source_ref = text_source_ref(entry, content, start, end);
        Ok(
            json!({"context_ref":input["context_ref"],"fixed_ref":entry["fixed_ref"],"sha256":entry["sha256"],"source_ref":source_ref,"content":quote,
            "range":{"byte_start":start,"byte_end":end},"size_bytes":content.len(),"complete":end == requested_end,
            "next_range":if end < requested_end { json!({"byte_start":end,"byte_end":requested_end}) } else { Value::Null }}),
        )
    }

    pub(in crate::application) fn search_task_context(&self, input: &Value) -> Result<Value> {
        let (request, _, _, _) = self.task_for_reference(&input["task_ref"])?;
        let query = text(input, "query")?;
        let mut matches = Vec::new();
        let mut scanned = 0;
        let mut skipped_structured = 0;
        for (index, entry) in entries(&request).iter().enumerate() {
            if input.get("kind").is_some_and(|kind| *kind != entry["kind"]) {
                continue;
            }
            if entry["kind"] == "blueprint" || entry["kind"] == "plugin_object" {
                skipped_structured += 1;
                continue;
            }
            let source = self.fixed_context_source(&request["input_snapshot"]["sources"][index])?;
            let content = text(&source, "content")?;
            scanned += 1;
            if let Some(at) = content.find(query) {
                let from = before_boundary(content, at.saturating_sub(120));
                let to = before_boundary(content, (at + query.len()).saturating_add(120));
                matches.push(json!({"context_ref":{"context_id":entry["context_id"],"sha256":entry["sha256"]},
                    "title":entry["title"],"fixed_ref":entry["fixed_ref"],"sha256":entry["sha256"],"excerpt":&content[from..to],
                    "source_ref":text_source_ref(entry, content, at, at+query.len())}));
            }
        }
        let mut result = self.ordered_record_page(input, matches, "matches")?;
        result["coverage"] = json!({"scope":"authorized_fixed_texts","scanned_entries":scanned,
            "unsearched_structured_entries":skipped_structured,"match_mode":"first_per_entry","complete":skipped_structured == 0});
        Ok(result)
    }
}
