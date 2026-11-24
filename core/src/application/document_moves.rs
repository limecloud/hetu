//! 双端文稿移动与确切回执恢复；正文及移动记录在同一事务中落盘。
use super::*;

fn reference(value: &Value) -> Value {
    json!({"document_id":value["document"]["document_id"],"revision_id":value["revision"]["revision_id"],"sha256":value["revision"]["sha256"]})
}

fn newline_length(bytes: &[u8], at: usize) -> usize {
    match bytes.get(at) {
        Some(b'\r') if bytes.get(at + 1) == Some(&b'\n') => 2,
        Some(b'\r' | b'\n') => 1,
        _ => 0,
    }
}

fn previous_newline(bytes: &[u8], at: usize) -> usize {
    if at >= 2 && &bytes[at - 2..at] == b"\r\n" {
        2
    } else if at > 0 && matches!(bytes[at - 1], b'\r' | b'\n') {
        1
    } else {
        0
    }
}

impl Kernel {
    fn document_move_record(&self, input: &Value) -> Result<Value> {
        let work = &input["work_ref"];
        self.work_record(work, None)?;
        let move_id = checked_id(text(&input["move_ref"], "move_id")?, "move")?;
        let encoded = self
            .store
            .read(&format!(".hetu/document-moves/{move_id}.json"))?;
        ensure(
            input["move_ref"]["sha256"] == digest(&encoded),
            "hetu.integrity_failure",
            "移动记录摘要不符。",
        )?;
        let record: Value = serde_json::from_slice(&encoded)?;
        ensure(
            record["move_id"] == move_id && record["work_ref"] == *work,
            "forbidden",
            "移动记录不属于当前作品。",
        )?;
        Ok(record)
    }

    pub(super) fn get_document_move(&self, input: &Value) -> Result<Value> {
        Ok(json!({"move":self.document_move_record(input)?}))
    }

    fn move_document(&self, work: &Value, fixed: &Value, current: bool) -> Result<Value> {
        let value = self.document_content(
            text(fixed, "document_id")?,
            Some(text(fixed, "revision_id")?),
        )?;
        ensure(
            self.document_in_work(&value["document"], work)?
                && value["document"]["draft_source_id"].is_null(),
            "forbidden",
            "移动文稿必须属于当前作品，且不能是参考稿。",
        )?;
        ensure(
            value["revision"]["sha256"] == fixed["sha256"],
            "hetu.integrity_failure",
            "移动文稿摘要不符。",
        )?;
        if current {
            ensure(
                value["document"]["current_revision_id"] == fixed["revision_id"],
                "revision_conflict",
                "移动涉及的正文已有新修订，请重新读取。",
            )?;
        }
        if let Some(episode) = value["document"]["drama_episode_id"].as_str() {
            ensure(
                self.read_drama_episode(episode, None)?.0["archived"] != true,
                "forbidden",
                "请先恢复已归档的分集。",
            )?;
        }
        Ok(value)
    }

    fn save_moved_content(
        &self,
        current: &Value,
        content: &str,
        changes: &mut Changes,
    ) -> Result<Value> {
        let input = json!({"document_id":current["document"]["document_id"],"base_revision_id":current["document"]["current_revision_id"],
            "source_format":current["revision"]["source_format"],"content":content,"operation_key":"move-transaction"});
        validate_action_input("hetu.documents.save", &input)?;
        self.save_document(&input, changes)
    }

    fn selected_move(
        &self,
        source: &Value,
        input: &Value,
    ) -> Result<(String, String, usize, usize)> {
        let content = text(source, "content")?;
        let start = usize::try_from(integer(input, "byte_start")?)
            .map_err(|_| Error::new("hetu.invalid_source_ref", "移动范围超出上限。"))?;
        let end = usize::try_from(integer(input, "byte_end")?)
            .map_err(|_| Error::new("hetu.invalid_source_ref", "移动范围超出上限。"))?;
        let selected = content.get(start..end).ok_or_else(|| {
            Error::new(
                "hetu.invalid_source_ref",
                "移动范围须处于完整UTF-8字符边界。",
            )
        })?;
        ensure(
            start < end && selected == text(input, "quote")?,
            "hetu.invalid_source_ref",
            "移动引句与原文不符，或范围为空。",
        )?;
        let raw = content.as_bytes();
        let split_crlf =
            |at| at > 0 && raw.get(at - 1) == Some(&b'\r') && raw.get(at) == Some(&b'\n');
        ensure(
            (start == 0 || matches!(raw[start - 1], b'\r' | b'\n'))
                && (end == raw.len() || newline_length(raw, end) > 0)
                && !split_crlf(start)
                && !split_crlf(end),
            "hetu.invalid_source_ref",
            "移至须选中完整行，不能截断换行或段落文字。",
        )?;
        // 优先带走后续空行分隔；尾段则带走前面的分隔，其余原文保持原字节。
        let (mut from, mut to) = (start, end);
        for _ in 0..2 {
            to += newline_length(raw, to);
        }
        if to == end {
            for _ in 0..2 {
                from -= previous_newline(raw, from);
            }
        }
        Ok((
            format!("{}{}", &content[..from], &content[to..]),
            selected.to_owned(),
            start,
            end,
        ))
    }

    pub(super) fn move_document_range(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let work = &input["work_ref"];
        self.work_record(work, None)?;
        let source = self.move_document(work, &input["source_ref"], true)?;
        let target = self.move_document(work, &input["target_ref"], true)?;
        ensure(
            source["document"]["document_id"] != target["document"]["document_id"],
            "invalid_input",
            "请选择另一篇文稿。",
        )?;
        ensure(
            source["revision"]["source_format"] == target["revision"]["source_format"],
            "invalid_input",
            "移动两端的正文格式必须相同。",
        )?;
        let (remaining, selected, start, end) = self.selected_move(&source, input)?;
        let destination = text(&target, "content")?;
        let mut appended = destination.to_owned();
        if !destination.is_empty() {
            let newline = destination
                .as_bytes()
                .iter()
                .position(|b| matches!(b, b'\r' | b'\n'))
                .map(|at| &destination[at..at + newline_length(destination.as_bytes(), at)])
                .unwrap_or("\n");
            let mut at = destination.len();
            let mut count = 0;
            while count < 2 {
                let length = previous_newline(destination.as_bytes(), at);
                if length == 0 {
                    break;
                }
                at -= length;
                count += 1;
            }
            for _ in count..2 {
                appended.push_str(newline);
            }
        }
        let inserted_start = appended.len();
        appended.push_str(&selected);
        let saved_source = self.save_moved_content(&source, &remaining, changes)?;
        let saved_target = self.save_moved_content(&target, &appended, changes)?;
        let move_id = id("move");
        let record = json!({"schema_version":"1.0.0","move_id":move_id,"work_ref":work,
            "source_before":reference(&source),"target_before":reference(&target),"source_after":reference(&saved_source),"target_after":reference(&saved_target),
            "source_range":{"byte_start":start,"byte_end":end,"sha256":digest(selected)},
            "target_range":{"byte_start":inserted_start,"byte_end":appended.len()},"operation_key":input["operation_key"],"created_at":now()});
        let encoded = bytes(&record)?;
        let move_ref = json!({"move_id":move_id,"sha256":digest(&encoded)});
        changes.insert(format!(".hetu/document-moves/{move_id}.json"), encoded);
        Ok(
            json!({"source":saved_source,"target":saved_target,"move_ref":move_ref,"target_range":record["target_range"]}),
        )
    }

    pub(super) fn move_document_to_new(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let work = &input["work_ref"];
        self.work_record(work, None)?;
        let source = self.move_document(work, &input["source_ref"], true)?;
        ensure(
            matches!(source["document"]["kind"].as_str(), Some("novel_chapter" | "drama_script")),
            "invalid_input",
            "只有小说章节或剧本分集可以移至新文稿。",
        )?;
        let target = &input["new_target"];
        let title = text(target, "title")?.trim();
        ensure(!title.is_empty(), "invalid_input", "新文稿标题不能为空。")?;
        let (remaining, selected, start, end) = self.selected_move(&source, input)?;
        let expected = input.get("expected").cloned().unwrap_or(Value::Null);
        let mut created = self.create_document_record(
            &json!({
                "kind": source["document"]["kind"],
                "title": title,
                "source_format": source["revision"]["source_format"],
                "language_tag": source["document"]["language_tag"],
                "content": selected,
            }),
            changes,
            false,
        )?;
        let (created_document, directory_before, directory_after, target_directory) = if work["kind"] == "novel" {
            let mut created_document = created["document"].clone();
            ensure(
                source["document"]["kind"] == "novel_chapter",
                "invalid_input",
                "小说只能建立新的章节。",
            )?;
            ensure(
                target.get("plan").is_none_or(Value::is_null),
                "invalid_input",
                "小说章节不使用分集计划。",
            )?;
            let novel = self.expected_novel(&expected)?;
            ensure(
                novel["novel_id"] == work["object_id"],
                "forbidden",
                "小说目录不属于当前作品。",
            )?;
            let volume = target.get("volume_id").cloned().unwrap_or(Value::Null);
            created_document["move_source_ref"] = json!({"work_ref":work,"document_ref":input["source_ref"]});
            changes.insert(
                format!("packages/novel/documents/{}/document.json", text(&created_document, "document_id")?),
                bytes(&created_document)?,
            );
            let before_sha = digest(bytes(&novel)?);
            let directory_before = json!({"kind":"novel","revision":novel["revision"],"sha256":before_sha});
            let saved = self.append_novel_chapter_to(novel, &created_document, Some(&volume), changes)?;
            let directory_after = json!({"kind":"novel","revision":saved["revision"],"sha256":saved["sha256"]});
            created["document"] = created_document.clone();
            (created_document, directory_before, directory_after, saved)
        } else {
            let mut created_document = created["document"].clone();
            ensure(
                work["kind"] == "drama" && source["document"]["kind"] == "drama_script",
                "invalid_input",
                "剧本只能建立新的分集。",
            )?;
            ensure(
                target.get("volume_id").is_none_or(Value::is_null),
                "invalid_input",
                "剧本不使用小说分卷。",
            )?;
            let project = self.expected_drama_project(&json!({
                "project_id": work["object_id"],
                "revision": expected["revision"],
                "sha256": expected["sha256"],
            }))?;
            let source_episode_id = text(&source["document"], "drama_episode_id")?;
            let (source_episode, _, _) = self.read_drama_episode(source_episode_id, None)?;
            ensure(
                source_episode["project_id"] == work["object_id"] && source_episode["archived"] != true,
                "forbidden",
                "来源分集不属于当前剧本或已归档。",
            )?;
            created_document["move_source_ref"] = json!({"work_ref":work,"document_ref":input["source_ref"]});
            changes.insert(
                format!("packages/drama/documents/{}/document.json", text(&created_document, "document_id")?),
                bytes(&created_document)?,
            );
            let before_sha = digest(bytes(&project)?);
            let directory_before = json!({"kind":"drama","revision":project["revision"],"sha256":before_sha,"project_id":project["project_id"]});
            let added = self.add_episode_document_after(
                project,
                created_document.clone(),
                title,
                target.get("plan").and_then(Value::as_str).unwrap_or(""),
                Some(source_episode_id),
                changes,
            )?;
            created_document = added["document"].clone();
            created["document"] = created_document.clone();
            let directory_after = json!({"kind":"drama","revision":added["project"]["revision"],"sha256":added["sha256"],"project_id":work["object_id"],"episode_id":added["episode"]["episode_id"],"episode_sha256":added["episode_sha256"]});
            (created_document, directory_before, directory_after, added)
        };
        let saved_source = self.save_moved_content(&source, &remaining, changes)?;
        let target_ref = reference(&json!({"document":created_document,"revision":created["revision"]}));
        let move_id = id("move");
        let record = json!({"schema_version":"1.0.0","move_id":move_id,"work_ref":work,
            "source_before":reference(&source),"target_before":null,"source_after":reference(&saved_source),"target_after":target_ref,
            "target_created":true,"directory_before":directory_before,"directory_after":directory_after,
            "source_range":{"byte_start":start,"byte_end":end,"sha256":digest(&selected)},"target_range":{"byte_start":0,"byte_end":selected.len()},"operation_key":input["operation_key"],"created_at":now()});
        let encoded = bytes(&record)?;
        let move_ref = json!({"move_id":move_id,"sha256":digest(&encoded)});
        changes.insert(format!(".hetu/document-moves/{move_id}.json"), encoded);
        Ok(json!({"source":saved_source,"target":{"document":created_document,"revision":created["revision"],"directory":target_directory},"target_created":true,"move_ref":move_ref,"target_range":record["target_range"]}))
    }

    pub(super) fn restore_document_move(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let work = &input["work_ref"];
        let record = self.document_move_record(input)?;
        let current_source = self.move_document(work, &record["source_after"], true)?;
        let current_target = self.move_document(work, &record["target_after"], true)?;
        let source = self.move_document(work, &record["source_before"], false)?;
        let target = if record["target_created"] == true {
            current_target.clone()
        } else {
            self.move_document(work, &record["target_before"], false)?
        };
        let saved_source =
            self.save_moved_content(&current_source, text(&source, "content")?, changes)?;
        let mut saved_target =
            self.save_moved_content(&current_target, text(&target, "content")?, changes)?;
        if record["target_created"] == true {
            let target_id = text(&current_target["document"], "document_id")?;
            let package = if work["kind"] == "novel" { "novel" } else { "drama" };
            let mut archived_document = current_target["document"].clone();
            archived_document["archived"] = json!(true);
            changes.insert(format!("packages/{package}/documents/{target_id}/document.json"), bytes(&archived_document)?);
            saved_target["document"] = archived_document.clone();
            if work["kind"] == "novel" {
                let mut novel = self.expected_novel(&json!({"revision":record["directory_after"]["revision"],"sha256":record["directory_after"]["sha256"]}))?;
                let chapters = novel["chapters"].as_array_mut().unwrap();
                let before = chapters.len();
                chapters.retain(|chapter| chapter["document_id"] != target_id);
                ensure(chapters.len() + 1 == before, "hetu.integrity_failure", "待恢复的新章节不在当前目录中。")?;
                self.validate_novel_structure(&novel, std::slice::from_ref(&archived_document))?;
                self.save_novel(novel, changes)?;
            } else {
                let mut project = self.expected_drama_project(&json!({"project_id":work["object_id"],"revision":record["directory_after"]["revision"],"sha256":record["directory_after"]["sha256"]}))?;
                let episode_id = text(&current_target["document"], "drama_episode_id")?;
                let refs = project["episode_refs"].as_array_mut().unwrap();
                let before = refs.len();
                refs.retain(|id| id.as_str() != Some(episode_id));
                ensure(refs.len() + 1 == before, "hetu.integrity_failure", "待恢复的新分集不在当前目录中。")?;
                let (mut episode, episode_sha, _) = self.read_drama_episode(episode_id, None)?;
                self.advance_record(&mut episode, &episode_sha)?;
                episode["archived"] = json!(true);
                self.stage_versioned_record("packages/drama/episodes", "episode_id", &episode, changes)?;
                self.advance_project(&mut project)?;
                self.stage_drama_project(&project, changes)?;
            }
        }
        Ok(
            json!({"source":saved_source,"target":saved_target,"restored_move_ref":input["move_ref"]}),
        )
    }
}
