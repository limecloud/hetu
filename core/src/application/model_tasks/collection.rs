use super::*;

impl Kernel {
    // 调用方持有作品锁，并已重新验证任务、计划与渠道身份。
    pub(super) fn collect_model_output(
        &self,
        plan: &Value,
        output: &Value,
        media: Option<Vec<u8>>,
        changes: &mut Changes,
    ) -> Result<Value> {
        let reference = &plan["task_ref"];
        let plan_id = text(plan, "plan_id")?;
        let (content, extension, media_type) = if let Some(bytes) = media {
            ensure(
                digest(&bytes) == output["sha256"] && output["size"] == bytes.len(),
                "hetu.integrity_failure",
                "下载图片与远端摘要不一致。",
            )?;
            let decoded = crate::infrastructure::media::decode_image_bytes(&bytes)?;
            ensure(
                decoded.scan["media_type"] == output["mime_type"]
                    && output["width"] == decoded.decoded.width()
                    && output["height"] == decoded.decoded.height(),
                "hetu.integrity_failure",
                "实际图片格式或尺寸与声明不一致。",
            )?;
            (
                bytes,
                text(&decoded.scan, "extension")?.to_owned(),
                text(&decoded.scan, "media_type")?.to_owned(),
            )
        } else {
            let text = text(output, "text")?;
            ensure(
                !text.trim().is_empty() && text.len() <= 65536 && !text.contains('\0'),
                "hetu.integrity_failure",
                "模型输出文字为空或超过预算。",
            )?;
            (text.as_bytes().to_vec(), "txt".into(), "text/plain".into())
        };
        let filename = format!("{plan_id}.{extension}");
        let inbox = format!(
            ".hetu/tasks/{}/inbox/{filename}",
            text(reference, "task_id")?
        );
        let collection = json!({"plan_id":plan_id,"file_name":filename,"sha256":digest(&content),"size_bytes":content.len(),"media_type":media_type,"artifact_kind":plan["artifact_kind"],"title":plan["title"],"content":if plan["kind"]=="text" {output["text"].clone()} else {Value::Null},"approval_state":"awaiting_author","next_action":"hetu.creative_tasks.submit_result"});
        if plan["kind"] == "image" {
            if self.store.exists(&inbox)? {
                let mut file = self.store.managed_media(&inbox)?;
                ensure(
                    crate::infrastructure::media::scan(&mut file, None)?["sha256"]
                        == collection["sha256"],
                    "hetu.integrity_failure",
                    "已有图片候选摘要不同，不能覆盖。",
                )?;
            } else {
                self.store
                    .import_media_bytes(&inbox, &content, &collection)?;
            }
        } else {
            changes.insert(inbox, content);
        }
        Ok(collection)
    }

    pub(super) fn verify_model_collection(
        &self,
        reference: &Value,
        collection: &Value,
    ) -> Result<()> {
        let filename = text(collection, "file_name")?;
        ensure(
            !filename.contains('/') && !filename.contains('\\'),
            "hetu.integrity_failure",
            "候选文件名无效。",
        )?;
        let path = format!(
            ".hetu/tasks/{}/inbox/{filename}",
            checked_id(text(reference, "task_id")?, "task")?
        );
        if collection["artifact_kind"] != "image" {
            let content = self.store.read(&path)?;
            return ensure(
                digest(&content) == collection["sha256"]
                    && content.len() == collection["size_bytes"],
                "hetu.integrity_failure",
                "已收集文字候选发生变化，请保留原文件并检查。",
            );
        }
        let mut file = self.store.managed_media(&path)?;
        let scan = crate::infrastructure::media::scan(&mut file, None)?;
        ensure(
            scan["sha256"] == collection["sha256"]
                && scan["size_bytes"] == collection["size_bytes"],
            "hetu.integrity_failure",
            "已收集候选发生变化，请保留原文件并检查。",
        )
    }
}
