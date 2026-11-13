use super::*;
use crate::domain::{drama, drama_comparison};

impl Kernel {
    pub(super) fn build_skeleton(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let plot = self.read_plot(text(input, "plot_revision_id")?)?;
        ensure(
            input["blueprint_revision"] == plot.blueprint_revision,
            "hetu.stale_evidence",
            "骨架必须使用固定剧情对应的设定集修订。",
        )?;
        let (bp, _) = self.blueprint_revision(Some(plot.blueprint_revision))?;
        let record = self.plot_descriptor(&plot.plot_revision_id)?;
        let skeleton = drama::build(
            &plot,
            text(&record, "sha256")?,
            &bp,
            serde_json::from_value(input["episode_options"].clone())?,
            self.actor(),
        )?;
        let sha = self.stage_skeleton(&skeleton, changes)?;
        self.skeleton_result(&skeleton, &sha)
    }
    fn stage_skeleton(&self, skeleton: &drama::Skeleton, changes: &mut Changes) -> Result<String> {
        let folder = format!("packages/drama/skeletons/{}", skeleton.skeleton_id);
        let index_folder = format!(".hetu/skeletons/{}", skeleton.skeleton_id);
        self.store.directory(&folder)?;
        self.store.directory(&index_folder)?;
        let path = format!("{folder}/{}.json", skeleton.revision);
        let index = format!("{index_folder}/{}.json", skeleton.revision);
        ensure(
            !self.store.exists(&path)? && !self.store.exists(&index)?,
            "hetu.integrity_failure",
            "骨架历史修订已存在，不能覆盖。",
        )?;
        let content = serde_json::to_vec(skeleton)?;
        let sha = digest(&content);
        let mut descriptor = drama::summary(skeleton, &sha);
        descriptor["path"] = json!(path);
        changes.insert(path, content);
        changes.insert(index, bytes(&descriptor)?);
        changes.insert(format!("{index_folder}/head.json"), bytes(&descriptor)?);
        Ok(sha)
    }
    pub(super) fn skeleton_descriptor(
        &self,
        skeleton_id: &str,
        revision: Option<u64>,
    ) -> Result<Value> {
        drama::check_identity(skeleton_id)?;
        ensure(
            self.store
                .entries(".hetu")?
                .iter()
                .any(|n| n == "skeletons"),
            "not_found",
            "短剧骨架不存在。",
        )?;
        ensure(
            self.store
                .entries(".hetu/skeletons")?
                .iter()
                .any(|n| n == skeleton_id),
            "not_found",
            "短剧骨架不存在。",
        )?;
        ensure(
            self.store
                .exists(&format!(".hetu/skeletons/{skeleton_id}/head.json"))?,
            "not_found",
            "短剧骨架不存在。",
        )?;
        let file = revision
            .map(|n| n.to_string())
            .unwrap_or_else(|| "head".into());
        let record = self
            .store
            .json(&format!(".hetu/skeletons/{skeleton_id}/{file}.json"))?;
        let number = integer(&record, "revision")?;
        ensure(
            record["schema_version"] == "1.0.0"
                && record["skeleton_id"] == skeleton_id
                && revision.is_none_or(|r| r == number)
                && number > 0
                && record["path"]
                    == format!("packages/drama/skeletons/{skeleton_id}/{number}.json"),
            "hetu.integrity_failure",
            "骨架索引身份、修订或路径不一致。",
        )?;
        Ok(record)
    }
    pub(super) fn read_skeleton(
        &self,
        skeleton_id: &str,
        revision: Option<u64>,
    ) -> Result<(drama::Skeleton, String)> {
        let descriptor = self.skeleton_descriptor(skeleton_id, revision)?;
        let content = self.store.read(text(&descriptor, "path")?)?;
        let sha = digest(&content);
        ensure(
            content.len() <= drama::OUTPUT_LIMIT && descriptor["sha256"] == sha,
            "hetu.integrity_failure",
            "骨架历史修订已被改写。",
        )?;
        let skeleton = drama::decode(&serde_json::from_slice(&content)?)?;
        let mut expected = drama::summary(&skeleton, &sha);
        expected["path"] = descriptor["path"].clone();
        ensure(
            descriptor == expected,
            "hetu.integrity_failure",
            "骨架内容与索引不一致。",
        )?;
        let numbered = self.skeleton_descriptor(skeleton_id, Some(skeleton.revision))?;
        ensure(
            numbered == descriptor,
            "hetu.integrity_failure",
            "骨架 head 与固定修订不一致。",
        )?;
        if skeleton.revision > 1 {
            let previous = self.skeleton_descriptor(skeleton_id, Some(skeleton.revision - 1))?;
            let previous_content = self.store.read(text(&previous, "path")?)?;
            ensure(
                skeleton.previous_sha256.as_deref() == previous["sha256"].as_str()
                    && previous["sha256"] == digest(previous_content),
                "hetu.integrity_failure",
                "骨架父修订摘要不一致。",
            )?;
        }
        let plot = self.read_plot(&skeleton.plot_revision_id)?;
        let plot_record = self.plot_descriptor(&skeleton.plot_revision_id)?;
        ensure(
            skeleton.plot_sha256 == text(&plot_record, "sha256")?,
            "hetu.integrity_failure",
            "骨架固定剧情摘要不一致。",
        )?;
        let (bp, _) = self.blueprint_revision(Some(skeleton.blueprint_revision))?;
        drama::validate(&skeleton, &plot, &bp)?;
        Ok((skeleton, sha))
    }
    pub(super) fn get_skeleton(&self, input: &Value) -> Result<Value> {
        let (skeleton, sha) =
            self.read_skeleton(text(input, "skeleton_id")?, input["revision"].as_u64())?;
        let mut result = self.skeleton_result(&skeleton, &sha)?;
        result["is_head"] = json!(
            self.skeleton_descriptor(&skeleton.skeleton_id, None)?["revision"] == skeleton.revision
        );
        Ok(result)
    }
    pub(super) fn edit_skeleton(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let (current, sha) = self.read_skeleton(text(input, "skeleton_id")?, None)?;
        ensure(
            input["expected"]["revision"] == current.revision && input["expected"]["sha256"] == sha,
            "revision_conflict",
            "骨架已被其他窗口修改，请先重新读取并比较。",
        )?;
        let plot = self.read_plot(&current.plot_revision_id)?;
        let (bp, _) = self.blueprint_revision(Some(current.blueprint_revision))?;
        let next = drama::edit(
            &current,
            &sha,
            input["typed_changes"].as_array().unwrap(),
            &plot,
            &bp,
            self.actor(),
        )?;
        let sha = self.stage_skeleton(&next, changes)?;
        self.skeleton_result(&next, &sha)
    }
    pub(super) fn skeleton_result(&self, skeleton: &drama::Skeleton, sha: &str) -> Result<Value> {
        let plot = self.read_plot(&skeleton.plot_revision_id)?;
        let state = self.plot_result(&plot, true)?;
        let mut reasons = state["stale_reasons"].as_array().unwrap().clone();
        for name in self.store.entries(".hetu/plots")? {
            let revision = name
                .strip_suffix(".json")
                .ok_or_else(|| Error::new("hetu.integrity_failure", "剧情索引名无效。"))?;
            if self.plot_descriptor(revision)?["parent_plot_revision_id"] == plot.plot_revision_id {
                reasons.push(json!({"code":"plot_corrected","plot_revision_id":revision}));
            }
        }
        Ok(
            json!({"skeleton":skeleton,"sha256":sha,"stale":!reasons.is_empty(),"stale_reasons":reasons}),
        )
    }
    pub(super) fn list_skeletons(&self, input: &Value) -> Result<Value> {
        let mut records = Vec::new();
        if self
            .store
            .entries(".hetu")?
            .iter()
            .any(|n| n == "skeletons")
        {
            for skeleton_id in self.store.entries(".hetu/skeletons")? {
                drama::check_identity(&skeleton_id)?;
                for name in self
                    .store
                    .entries(&format!(".hetu/skeletons/{skeleton_id}"))?
                {
                    if name == "head.json" {
                        continue;
                    }
                    let revision = name
                        .strip_suffix(".json")
                        .and_then(|s| s.parse::<u64>().ok())
                        .filter(|n| *n > 0)
                        .ok_or_else(|| {
                            Error::new("hetu.integrity_failure", "骨架修订索引名无效。")
                        })?;
                    ensure(
                        name == format!("{revision}.json"),
                        "hetu.integrity_failure",
                        "骨架索引修订不是规范格式。",
                    )?;
                    let record = self.skeleton_descriptor(&skeleton_id, Some(revision))?;
                    if input
                        .get("plot_revision_id")
                        .is_none_or(|r| *r == record["plot_revision_id"])
                    {
                        records.push(record);
                    }
                }
            }
        }
        self.record_page(input, records, "skeletons")
    }
    pub(super) fn compare_drama(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
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
        let documents = self.plot_documents(input["source_revisions"].as_array().unwrap())?;
        let sources: Vec<_> = documents.iter().map(|d| d.source.clone()).collect();
        ensure(
            serde_json::to_value(&sources)? == input["source_revisions"],
            "hetu.stale_evidence",
            "对比原著修订的格式或大小不一致。",
        )?;
        let plot = self.read_plot(&skeleton.plot_revision_id)?;
        let (bp, _) = self.blueprint_revision(Some(skeleton.blueprint_revision))?;
        let report =
            drama_comparison::compare(&skeleton, &sha, &plot, &bp, &sources, self.actor())?;
        let saved = input["save_result"] == true;
        if saved {
            self.store.directory(".hetu/comparisons")?;
            self.store.directory("packages/drama/comparisons")?;
            let comparison_id = text(&report, "comparison_id")?;
            let path = format!("packages/drama/comparisons/{comparison_id}.json");
            let record_path = format!(".hetu/comparisons/{comparison_id}.json");
            ensure(
                !self.store.exists(&path)? && !self.store.exists(&record_path)?,
                "hetu.integrity_failure",
                "差异报告已存在，不能覆盖。",
            )?;
            let content = serde_json::to_vec(&report)?;
            let descriptor = Self::comparison_summary(&report, &path, &digest(&content));
            changes.insert(path, content);
            changes.insert(record_path, bytes(&descriptor)?);
        }
        self.comparison_result(&report, saved)
    }
    fn comparison_summary(report: &Value, path: &str, sha: &str) -> Value {
        json!({"schema_version":"1.0.0","comparison_id":report["comparison_id"],"skeleton_ref":report["skeleton_ref"],"source_revisions":report["source_revisions"],"created_at":report["created_at"],"status":report["status"],"item_count":report["items"].as_array().unwrap().len(),"path":path,"sha256":sha})
    }
    fn comparison_descriptor(&self, comparison_id: &str) -> Result<Value> {
        checked_id(comparison_id, "comparison")?;
        ensure(
            self.store
                .entries(".hetu")?
                .iter()
                .any(|n| n == "comparisons"),
            "not_found",
            "差异报告不存在。",
        )?;
        ensure(
            self.store
                .exists(&format!(".hetu/comparisons/{comparison_id}.json"))?,
            "not_found",
            "差异报告不存在。",
        )?;
        let record = self
            .store
            .json(&format!(".hetu/comparisons/{comparison_id}.json"))?;
        ensure(
            record["schema_version"] == "1.0.0"
                && record["comparison_id"] == comparison_id
                && record["path"] == format!("packages/drama/comparisons/{comparison_id}.json"),
            "hetu.integrity_failure",
            "差异报告索引不一致。",
        )?;
        Ok(record)
    }
    pub(super) fn get_comparison(&self, input: &Value) -> Result<Value> {
        let record = self.comparison_descriptor(text(input, "comparison_id")?)?;
        let content = self.store.read(text(&record, "path")?)?;
        ensure(
            content.len() <= drama::OUTPUT_LIMIT && record["sha256"] == digest(&content),
            "hetu.integrity_failure",
            "差异报告历史被改写。",
        )?;
        let report: Value = serde_json::from_slice(&content)?;
        drama_comparison::validate(&report)?;
        ensure(
            record == Self::comparison_summary(&report, text(&record, "path")?, &digest(&content)),
            "hetu.integrity_failure",
            "差异报告内容与索引不一致。",
        )?;
        let reference = &report["skeleton_ref"];
        let (skeleton, sha) = self.read_skeleton(
            text(reference, "skeleton_id")?,
            Some(integer(reference, "revision")?),
        )?;
        ensure(
            reference["sha256"] == sha,
            "hetu.integrity_failure",
            "差异报告的骨架摘要不一致。",
        )?;
        let documents = self.plot_documents(report["source_revisions"].as_array().unwrap())?;
        let sources: Vec<_> = documents.iter().map(|d| d.source.clone()).collect();
        ensure(
            serde_json::to_value(&sources)? == report["source_revisions"],
            "hetu.integrity_failure",
            "差异报告的原著修订不一致。",
        )?;
        let plot = self.read_plot(&skeleton.plot_revision_id)?;
        let (bp, _) = self.blueprint_revision(Some(skeleton.blueprint_revision))?;
        let expected = drama_comparison::compare(
            &skeleton,
            &sha,
            &plot,
            &bp,
            &sources,
            text(&report, "actor_ref")?,
        )?;
        ensure(
            expected["items"] == report["items"] && expected["status"] == report["status"],
            "hetu.integrity_failure",
            "差异报告与固定证据的计算结果不一致。",
        )?;
        self.comparison_result(&report, true)
    }
    fn comparison_result(&self, report: &Value, saved: bool) -> Result<Value> {
        let reference = &report["skeleton_ref"];
        let (skeleton, sha) = self.read_skeleton(
            text(reference, "skeleton_id")?,
            Some(integer(reference, "revision")?),
        )?;
        let state = self.skeleton_result(&skeleton, &sha)?;
        let mut reasons = state["stale_reasons"].as_array().unwrap().clone();
        let head = self.skeleton_descriptor(&skeleton.skeleton_id, None)?;
        if head["revision"] != skeleton.revision {
            reasons.push(json!({"code":"skeleton_changed","current_revision":head["revision"]}));
        }
        for source in report["source_revisions"].as_array().unwrap() {
            let document = self.document(text(source, "document_id")?)?;
            if document["current_revision_id"] != source["revision_id"] {
                reasons.push(
                    json!({"code":"comparison_source_changed","document_id":source["document_id"]}),
                );
            }
        }
        Ok(
            json!({"comparison":report,"saved":saved,"stale":!reasons.is_empty(),"stale_reasons":reasons}),
        )
    }
    pub(super) fn list_comparisons(&self, input: &Value) -> Result<Value> {
        self.skeleton_descriptor(text(input, "skeleton_id")?, None)?;
        let mut records = Vec::new();
        if self
            .store
            .entries(".hetu")?
            .iter()
            .any(|n| n == "comparisons")
        {
            for name in self.store.entries(".hetu/comparisons")? {
                let comparison_id = name
                    .strip_suffix(".json")
                    .ok_or_else(|| Error::new("hetu.integrity_failure", "差异索引名称无效。"))?;
                let record = self.comparison_descriptor(comparison_id)?;
                if record["skeleton_ref"]["skeleton_id"] == input["skeleton_id"] {
                    records.push(record);
                }
            }
        }
        self.record_page(input, records, "comparisons")
    }
}
