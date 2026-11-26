//! 文稿目录与固定场次投影共用正文Owner，不持久化另一套文本或场次身份。
use super::*;

impl Kernel {
    fn document_records(&self, input: &Value) -> Result<Vec<Value>> {
        if input["work_ref"].is_object() {
            self.work_record(&input["work_ref"], None)?;
        }
        let query = input["query"].as_str().unwrap_or("").trim().to_lowercase();
        let mut documents = Vec::new();
        for package in ["novel", "drama"] {
            for name in self
                .store
                .entries(&format!("packages/{package}/documents"))?
            {
                checked_id(&name, "doc")?;
                let doc = self.document(&name)?;
                if input["work_ref"].is_object()
                    && !self.document_in_work(&doc, &input["work_ref"])?
                {
                    continue;
                }
                if !doc["title"]
                    .as_str()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains(&query)
                {
                    continue;
                }
                if input.get("kind").is_none_or(|kind| *kind == doc["kind"]) {
                    documents.push(doc);
                }
            }
        }
        documents.sort_by(|a, b| {
            a["created_at"]
                .as_str()
                .cmp(&b["created_at"].as_str())
                .then_with(|| a["document_id"].as_str().cmp(&b["document_id"].as_str()))
        });
        Ok(documents)
    }
    pub(super) fn list_documents(&self, input: &Value) -> Result<Value> {
        let documents = self.document_records(input)?;
        let mut page = if self.granted_work()?.is_some()
            || input["limit"].is_number()
            || input["cursor"].is_string()
        {
            self.ordered_record_page(input, documents, "documents")?
        } else {
            json!({"documents":documents,"next_cursor":null})
        };
        if input["include_revision_ref"] == true {
            for document in page["documents"].as_array_mut().unwrap() {
                let value = self.document_content(
                    text(document, "document_id")?,
                    Some(text(document, "current_revision_id")?),
                )?;
                document["current_revision_ref"] = json!({"revision_id":value["revision"]["revision_id"],
                    "sha256":value["revision"]["sha256"],"size_bytes":value["revision"]["size_bytes"]});
            }
        }
        Ok(page)
    }

    pub(super) fn document_scene_index(&self, input: &Value) -> Result<Value> {
        let work = &input["work_ref"];
        self.work_record(work, None)?;
        ensure(
            work["kind"] == "drama",
            "forbidden",
            "场次目录需要确切剧本作品。",
        )?;
        let project = self.drama_project(text(work, "object_id")?)?;
        let episode_numbers: BTreeMap<_, _> = project["episode_refs"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .filter_map(|(index, id)| id.as_str().map(|id| (id, index + 1)))
            .collect();
        let documents = if let Some(id) = input["document_id"].as_str() {
            vec![self.document(id)?]
        } else {
            self.document_records(&json!({"work_ref":work,"kind":"drama_script"}))?
        };
        let query = input["query"].as_str().unwrap_or("").trim().to_lowercase();
        let mut scanned = 0usize;
        let mut rows = Vec::new();
        for document in documents {
            ensure(
                self.document_in_work(&document, work)? && document["draft_source_id"].is_null(),
                "forbidden",
                "场次原稿不属于当前作品。",
            )?;
            if document["archived"] == true && input["document_id"].is_null() {
                continue;
            }
            let value = self.document_content(
                text(&document, "document_id")?,
                input["revision_id"].as_str(),
            )?;
            if value["revision"]["source_format"] != "fountain" {
                ensure(
                    input["document_id"].is_null(),
                    "hetu.format_unsupported",
                    "场次目录只读取Fountain剧本。",
                )?;
                continue;
            }
            let content = text(&value, "content")?;
            scanned = scanned.saturating_add(content.len());
            ensure(
                scanned <= 32 * 1024 * 1024,
                "hetu.budget_exceeded",
                "场次检索超过32MiB预算，请指定分集原稿。",
            )?;
            ensure(
                input
                    .get("sha256")
                    .is_none_or(|sha| *sha == value["revision"]["sha256"]),
                "hetu.stale_evidence",
                "场次原稿摘要不一致。",
            )?;
            let document_ref = json!({"document_id":document["document_id"],"revision_id":value["revision"]["revision_id"],"sha256":value["revision"]["sha256"]});
            for (index, scene) in domain::fountain::scenes(content).iter().enumerate() {
                let range = json!({"byte_start":scene.byte_start,"byte_end":scene.byte_end});
                let mut row = json!({"work_ref":work,"document_ref":document_ref,"document_title":document["title"],"scene_number":index+1,
                    "episode_number":document["drama_episode_id"].as_str().and_then(|id|episode_numbers.get(id)),
                    "heading":scene.heading.chars().take(200).collect::<String>(),"number":scene.number,"range":range,
                    "heading_range":{"byte_start":scene.heading_start,"byte_end":scene.heading_end}});
                if input["scene_range"].is_object() {
                    if input["scene_range"] != range {
                        continue;
                    }
                    row.as_object_mut().unwrap().remove("document_title");
                    row.as_object_mut().unwrap().remove("episode_number");
                    let offset = input["offset"].as_u64().unwrap_or(0) as usize;
                    let total = scene.byte_end - scene.byte_start;
                    ensure(
                        offset <= total && content.is_char_boundary(scene.byte_start + offset),
                        "hetu.invalid_source_ref",
                        "场次分页必须位于原文UTF-8边界。",
                    )?;
                    let start = scene.byte_start + offset;
                    let mut end = start
                        .saturating_add(input["max_bytes"].as_u64().unwrap_or(16384) as usize)
                        .min(scene.byte_end);
                    while !content.is_char_boundary(end) {
                        end -= 1;
                    }
                    return Ok(
                        json!({"work_ref":work,"document_ref":document_ref,"scene":row,"source_format":"fountain",
                        "content":&content[start..end],"offset":offset,"size_bytes":total,
                        "read_range":{"byte_start":start,"byte_end":end},"complete":end==scene.byte_end,
                        "next_offset":if end<scene.byte_end{json!(end-scene.byte_start)}else{Value::Null}}),
                    );
                }
                if scene.heading.to_lowercase().contains(&query)
                    || document["title"]
                        .as_str()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&query)
                {
                    rows.push(row);
                }
            }
        }
        ensure(
            input["scene_range"].is_null(),
            "hetu.invalid_source_ref",
            "该范围不是固定原稿中的完整场次。",
        )?;
        let mut page = self.ordered_record_page(input, rows, "scenes")?;
        page["projection_version"] = json!("hetu-fountain-scenes/1");
        Ok(page)
    }
}
