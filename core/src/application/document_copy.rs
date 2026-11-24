//! 固定原文的同作品副本；目录与正文在同一事务中创建，不继承作者决定。
use super::*;

impl Kernel {
    pub(super) fn duplicate_document(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let work = &input["work_ref"];
        self.work_record(work, None)?;
        let source_ref = &input["source_ref"];
        let source_id = text(source_ref, "document_id")?;
        let source = self.document_content(source_id, Some(text(source_ref, "revision_id")?))?;
        ensure(
            self.document_in_work(&source["document"], work)?,
            "forbidden",
            "复制来源不属于当前作品。",
        )?;
        ensure(
            source["document"]["draft_source_id"].is_null(),
            "forbidden",
            "参考稿须经过采纳，不能复制为正式文稿。",
        )?;
        ensure(
            source["revision"]["sha256"] == source_ref["sha256"],
            "hetu.integrity_failure",
            "复制来源摘要不符。",
        )?;
        ensure(
            source["document"]["current_revision_id"] == source_ref["revision_id"],
            "revision_conflict",
            "原文已有新修订，请重新读取后复制。",
        )?;
        let title = text(input, "title")?.trim();
        ensure(!title.is_empty(), "invalid_input", "副本名称不能为空。")?;
        let novel = if work["kind"] == "novel" {
            Some(self.expected_novel(&input["expected"])?)
        } else {
            None
        };
        let project = if work["kind"] == "drama" {
            Some(self.expected_drama_project(&json!({"project_id":work["object_id"],"revision":input["expected"]["revision"],"sha256":input["expected"]["sha256"]}))?)
        } else {
            None
        };
        ensure(
            novel.is_some() || project.is_some(),
            "invalid_input",
            "只能复制小说章节或剧本分集。",
        )?;
        ensure(
            source["document"]["kind"]
                == if novel.is_some() {
                    "novel_chapter"
                } else {
                    "drama_script"
                },
            "invalid_input",
            "请选择正式章节或分集。",
        )?;
        let mut created = self.create_document_record(&json!({"kind":source["document"]["kind"],"title":title,
            "source_format":source["revision"]["source_format"],"language_tag":source["document"]["language_tag"],"content":source["content"]}), changes, false)?;
        let document = &mut created["document"];
        document["copy_source_ref"] = json!({"work_ref":work,"document_ref":source_ref});
        let package = if work["kind"] == "novel" {
            "novel"
        } else {
            "drama"
        };
        changes.insert(
            format!(
                "packages/{package}/documents/{}/document.json",
                text(&created["document"], "document_id")?
            ),
            bytes(&created["document"])?,
        );
        if let Some(mut novel) = novel {
            ensure(
                novel["novel_id"] == work["object_id"],
                "forbidden",
                "小说目录不属于当前作品。",
            )?;
            let chapters = novel["chapters"].as_array_mut().unwrap();
            let position = chapters
                .iter()
                .position(|chapter| chapter["document_id"] == source_id)
                .ok_or_else(|| Error::new("forbidden", "来源不在当前章节目录中。"))?;
            chapters.insert(position + 1, json!({"chapter_id":id("chapter"),"document_id":created["document"]["document_id"],"volume_id":chapters[position]["volume_id"]}));
            self.validate_novel_structure(&novel, std::slice::from_ref(&created["document"]))?;
            created["directory"] = self.save_novel(novel, changes)?;
        } else if let Some(project) = project {
            let source_episode_id = text(&source["document"], "drama_episode_id")?;
            let (source_episode, _, _) = self.read_drama_episode(source_episode_id, None)?;
            ensure(
                source_episode["archived"] != true,
                "forbidden",
                "请先恢复已归档的来源分集。",
            )?;
            let added = self.add_episode_document_after(
                project,
                created["document"].clone(),
                title,
                text(&source_episode, "plan")?,
                Some(source_episode_id),
                changes,
            )?;
            created["document"] = added["document"].clone();
            created["directory"] = added;
        }
        Ok(created)
    }
}
