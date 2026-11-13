use super::*;
use crate::domain::{drama, script};

impl Kernel {
    pub(super) fn create_script(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let reference = &input["skeleton_ref"];
        let (skeleton, sha) = self.read_skeleton(
            text(reference, "skeleton_id")?,
            Some(integer(reference, "revision")?),
        )?;
        ensure(
            reference["sha256"] == sha,
            "hetu.stale_evidence",
            "骨架固定修订摘要不一致。",
        )?;
        let (bp, _) = self.blueprint_revision(Some(skeleton.blueprint_revision))?;
        let rendered = script::render(
            &skeleton,
            &bp,
            text(input, "title")?,
            text(input, "language_tag")?,
        )?;
        let mut result = self.create_document(&json!({"kind":"drama_script","title":input["title"],"source_format":"fountain","language_tag":input["language_tag"],"content":rendered.content}), changes)?;
        let doc_id = text(&result["document"], "document_id")?.to_string();
        let mapping = json!({"schema_version":"1.0.0","renderer_version":script::RENDERER_VERSION,"document_id":doc_id,"revision_id":result["revision"]["revision_id"],"content_sha256":result["revision"]["sha256"],"skeleton_ref":reference,"language_tag":input["language_tag"],"title":input["title"],"coverage_status":skeleton.status,"scenes":rendered.scenes});
        let path = format!("packages/drama/mappings/{doc_id}.json");
        self.store.directory("packages/drama/mappings")?;
        self.store.directory(".hetu/script-mappings")?;
        let content = bytes(&mapping)?;
        ensure(
            content.len() <= drama::OUTPUT_LIMIT,
            "hetu.budget_exceeded",
            "结构映射超过输出预算。",
        )?;
        let origin = json!({"mapping_path":path,"mapping_sha256":digest(&content),"revision_id":result["revision"]["revision_id"]});
        result["document"]["structure_origin"] = origin.clone();
        changes.insert(
            format!("packages/drama/documents/{doc_id}/document.json"),
            bytes(&result["document"])?,
        );
        changes.insert(path, content);
        changes.insert(
            format!(".hetu/script-mappings/{doc_id}.json"),
            bytes(&origin)?,
        );
        let state = self.script_state(&mapping, &skeleton)?;
        result["mapping"] = mapping;
        result["stale"] = state["stale"].clone();
        result["stale_reasons"] = state["stale_reasons"].clone();
        Ok(result)
    }

    pub(super) fn get_script_mapping(&self, input: &Value) -> Result<Value> {
        let doc_id = checked_id(text(input, "document_id")?, "doc")?;
        let current = self.document_content(&doc_id, None)?;
        let origin = &current["document"]["structure_origin"];
        ensure(!origin.is_null(), "not_found", "该文档没有骨架结构映射。")?;
        let path = format!("packages/drama/mappings/{doc_id}.json");
        let record = self
            .store
            .json(&format!(".hetu/script-mappings/{doc_id}.json"))?;
        ensure(
            record == *origin && origin["mapping_path"] == path,
            "hetu.integrity_failure",
            "剧本结构映射索引不一致。",
        )?;
        let content = self.store.read(&path)?;
        ensure(
            content.len() <= drama::OUTPUT_LIMIT && origin["mapping_sha256"] == digest(&content),
            "hetu.integrity_failure",
            "剧本结构映射已被修改。",
        )?;
        let mapping: Value = serde_json::from_slice(&content)?;
        schema(
            &mapping,
            &serde_json::from_str(include_str!(
                "../../../contracts/schemas/drama-script-mapping.schema.json"
            ))?,
        )
        .map_err(|_| Error::new("hetu.integrity_failure", "剧本结构映射不符合合同。"))?;
        ensure(
            mapping["document_id"] == doc_id
                && mapping["revision_id"] == origin["revision_id"]
                && mapping["renderer_version"] == script::RENDERER_VERSION,
            "hetu.integrity_failure",
            "剧本结构映射身份或版本不一致。",
        )?;
        let reference = &mapping["skeleton_ref"];
        let (skeleton, sha) = self.read_skeleton(
            text(reference, "skeleton_id")?,
            Some(integer(reference, "revision")?),
        )?;
        ensure(
            reference["sha256"] == sha,
            "hetu.integrity_failure",
            "映射固定骨架摘要不一致。",
        )?;
        let fixed = self.document_content(&doc_id, Some(text(&mapping, "revision_id")?))?;
        let (bp, _) = self.blueprint_revision(Some(skeleton.blueprint_revision))?;
        let rendered = script::render(
            &skeleton,
            &bp,
            text(&mapping, "title")?,
            text(&mapping, "language_tag")?,
        )?;
        ensure(
            fixed["content"] == rendered.content
                && fixed["revision"]["sha256"] == mapping["content_sha256"]
                && mapping["scenes"] == json!(rendered.scenes)
                && mapping["coverage_status"] == skeleton.status,
            "hetu.integrity_failure",
            "结构映射与固定剧本或骨架不一致。",
        )?;
        let mut state = self.script_state(&mapping, &skeleton)?;
        if current["revision"]["revision_id"] != mapping["revision_id"] {
            state["stale_reasons"].as_array_mut().unwrap().push(json!({"code":"script_changed","current_revision_id":current["revision"]["revision_id"]}));
        }
        state["stale"] = json!(!state["stale_reasons"].as_array().unwrap().is_empty());
        state["mapping"] = mapping;
        state["current_revision_id"] = current["revision"]["revision_id"].clone();
        Ok(state)
    }

    fn script_state(&self, mapping: &Value, skeleton: &drama::Skeleton) -> Result<Value> {
        let state = self.skeleton_result(skeleton, text(&mapping["skeleton_ref"], "sha256")?)?;
        let mut reasons = state["stale_reasons"].as_array().unwrap().clone();
        if self.skeleton_descriptor(&skeleton.skeleton_id, None)?["revision"] != skeleton.revision {
            reasons.push(json!({"code":"skeleton_changed"}));
        }
        Ok(json!({"stale":!reasons.is_empty(),"stale_reasons":reasons}))
    }
}
