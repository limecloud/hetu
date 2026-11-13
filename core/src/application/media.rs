use super::*;
use crate::{domain::media, infrastructure::media as files};

fn collection(object: &str) -> &'static str {
    if object == "asset" { "assets" } else { "cues" }
}
fn record_path(root: &str, revision: u64) -> String {
    format!("{root}/revisions/{revision}.json")
}
fn validate_record(record: &Value, object: &str) -> Result<()> {
    static ASSET: OnceLock<jsonschema::Validator> = OnceLock::new();
    static CUE: OnceLock<jsonschema::Validator> = OnceLock::new();
    let validator = if object == "asset" { &ASSET } else { &CUE }.get_or_init(|| {
        jsonschema::validator_for(&media::definition(object)).expect("valid media record schema")
    });
    ensure(
        validator.is_valid(record),
        "hetu.integrity_failure",
        "素材或线索记录不符合数据合同。",
    )?;
    if object == "asset" {
        ensure(
            record["blob"]["path"] == media::blob_path(record)?,
            "hetu.integrity_failure",
            "素材路径不属于此对象。",
        )?;
    }
    media::validate_metadata(record)
        .map_err(|_| Error::new("hetu.integrity_failure", "素材或线索元数据无效。"))
}

impl Kernel {
    pub(super) fn inspect_asset(&self, input: &Value) -> Result<Value> {
        let path = Path::new(text(input, "file_path")?);
        let mut file = files::selected_file(path)?;
        let mut result = files::scan(&mut file, None)?;
        result["original_filename"] = json!(
            path.file_name()
                .and_then(|s| s.to_str())
                .ok_or_else(|| Error::new("invalid_input", "文件名称不是有效 UTF-8。"))?
        );
        Ok(result)
    }
    fn media_root(&self, object: &str, id: &str) -> Result<String> {
        checked_id(id, object)?;
        for package in ["music-cue", "visual-prompt"] {
            let folder = format!("packages/{package}/{}", collection(object));
            if self.store.entries(&folder)?.iter().any(|name| name == id) {
                return Ok(format!("{folder}/{id}"));
            }
        }
        Err(Error::new("not_found", "没有找到此素材或线索。"))
    }
    fn read_media_record(
        &self,
        object: &str,
        id: &str,
        revision: Option<u64>,
    ) -> Result<(Value, String, Value)> {
        let root = self.media_root(object, id)?;
        let head = self.store.json(&format!("{root}/{object}.json"))?;
        let latest = integer(&head, "revision")?;
        let target = revision.unwrap_or(latest);
        ensure(
            target > 0 && target <= latest,
            "not_found",
            "所选素材或线索修订不存在。",
        )?;
        ensure(
            latest - target < 1000,
            "hetu.budget_exceeded",
            "历史链超过单次核验上限。",
        )?;
        let mut expected = text(&head, "sha256")?.to_owned();
        let mut current = Value::Null;
        for number in (target..=latest).rev() {
            let content = self.store.read(&record_path(&root, number))?;
            let sha = digest(&content);
            ensure(
                sha == expected,
                "hetu.integrity_failure",
                "素材或线索历史摘要不一致，不能使用改写的记录。",
            )?;
            let record: Value = serde_json::from_slice(&content)?;
            validate_record(&record, object)?;
            ensure(
                record[format!("{object}_id")] == id
                    && record["revision"] == number
                    && root.starts_with(&format!(
                        "packages/{}/",
                        media::package(text(&record, "kind")?)
                    ))
                    && ((number == 1 && record["previous_sha256"].is_null())
                        || (number > 1 && record["previous_sha256"].is_string())),
                "hetu.integrity_failure",
                "素材或线索的身份、修订链与目录不一致。",
            )?;
            if number == latest {
                ensure(
                    head == json!({format!("{object}_id"):id,"revision":number,"sha256":sha}),
                    "hetu.integrity_failure",
                    "素材或线索当前修订索引无效。",
                )?;
                current = record.clone();
            }
            ensure(
                record["created_at"] == current["created_at"]
                    && record["kind"] == current["kind"]
                    && (object != "asset"
                        || record["blob"] == current["blob"]
                            && record["original_filename"] == current["original_filename"]),
                "hetu.integrity_failure",
                "不可变的素材内容或对象身份被改写。",
            )?;
            if number == target {
                return Ok((record, sha, current));
            }
            expected = text(&record, "previous_sha256")?.to_owned();
        }
        unreachable!("validated media revision range")
    }
    fn stage_media_record(
        &self,
        object: &str,
        record: &Value,
        changes: &mut Changes,
    ) -> Result<String> {
        validate_record(record, object)?;
        let id = text(record, &format!("{object}_id"))?;
        let root = format!(
            "packages/{}/{}/{id}",
            media::package(text(record, "kind")?),
            collection(object)
        );
        self.store.directory(&format!("{root}/revisions"))?;
        let revision = integer(record, "revision")?;
        let path = record_path(&root, revision);
        ensure(
            !self.store.exists(&path)?,
            "hetu.integrity_failure",
            "不能覆盖既有素材或线索修订。",
        )?;
        let content = bytes(record)?;
        let sha = digest(&content);
        changes.insert(path, content);
        changes.insert(
            format!("{root}/{object}.json"),
            bytes(&json!({format!("{object}_id"):id,"revision":revision,"sha256":sha}))?,
        );
        Ok(sha)
    }
    fn asset_metadata(input: &Value, record: &mut Value) {
        for field in [
            "title",
            "source",
            "rights_status",
            "redistribution_allowed",
            "rights_statement",
        ] {
            record[field] = input[field].clone();
        }
    }
    pub(super) fn import_asset(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        media::validate_metadata(input)?;
        let inspection = self.inspect_asset(input)?;
        ensure(
            inspection["sha256"] == input["expected_file"]["sha256"]
                && inspection["size_bytes"] == input["expected_file"]["size_bytes"],
            "revision_conflict",
            "文件已偏离导入预览，请重新检查。",
        )?;
        let asset_id = id("asset");
        let kind = text(&inspection, "kind")?;
        let path = format!(
            "packages/{}/assets/{asset_id}/source.{}",
            media::package(kind),
            text(&inspection, "extension")?
        );
        let mut record = json!({"schema_version":"1.0.0","asset_id":asset_id,"revision":1,"previous_sha256":null,"kind":kind,
            "original_filename":inspection["original_filename"],"blob":{"path":path,"sha256":inspection["sha256"],"size_bytes":inspection["size_bytes"],"media_type":inspection["media_type"],"validation":"signature_only"},
            "created_at":now(),"updated_at":now(),"actor_ref":self.actor()});
        Self::asset_metadata(input, &mut record);
        validate_record(&record, "asset")?;
        let mut source = files::selected_file(Path::new(text(input, "file_path")?))?;
        // 原字节先流式持久化，再通过共同事务公开元数据与回执；未登记对象不出现在列表。
        self.store
            .import_media(&path, &mut source, &input["expected_file"])?;
        let sha = self.stage_media_record("asset", &record, changes)?;
        Ok(
            json!({"asset":record,"sha256":sha,"delivery_eligible":media::delivery_eligible(&record),"media_verified":true}),
        )
    }
    pub(super) fn update_asset(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        media::validate_metadata(input)?;
        let (mut record, sha, _) =
            self.read_media_record("asset", text(input, "asset_id")?, None)?;
        ensure(
            input["expected"] == json!({"revision":record["revision"],"sha256":sha}),
            "revision_conflict",
            "素材元数据已变化，请重新读取后比较。",
        )?;
        self.verify_asset_blob(&record)?;
        record["revision"] = json!(integer(&record, "revision")? + 1);
        record["previous_sha256"] = json!(sha);
        record["updated_at"] = json!(now());
        record["actor_ref"] = json!(self.actor());
        Self::asset_metadata(input, &mut record);
        let sha = self.stage_media_record("asset", &record, changes)?;
        Ok(
            json!({"asset":record,"sha256":sha,"delivery_eligible":media::delivery_eligible(&record),"media_verified":true}),
        )
    }
    fn verify_asset_blob(&self, record: &Value) -> Result<()> {
        let blob = &record["blob"];
        let path = text(blob, "path")?;
        let mut file = self.store.managed_media(path)?;
        let actual = files::scan(&mut file, None)?;
        ensure(
            path == format!(
                "packages/{}/assets/{}/source.{}",
                media::package(text(record, "kind")?),
                text(record, "asset_id")?,
                text(&actual, "extension")?
            ) && actual["sha256"] == blob["sha256"]
                && actual["size_bytes"] == blob["size_bytes"]
                && actual["media_type"] == blob["media_type"]
                && actual["kind"] == record["kind"],
            "hetu.integrity_failure",
            "素材原字节、类型或受管路径被改变，停止使用此材料。",
        )
    }
    pub(super) fn get_asset(&self, input: &Value) -> Result<Value> {
        let (asset, sha, current) = self.read_media_record(
            "asset",
            text(input, "asset_id")?,
            input["revision"].as_u64(),
        )?;
        self.verify_asset_blob(&asset)?;
        Ok(
            json!({"asset":asset,"sha256":sha,"current_revision":current["revision"],"current_rights_status":current["rights_status"],
            "is_head":asset["revision"] == current["revision"],"delivery_eligible":media::delivery_eligible(&asset) && media::delivery_eligible(&current),"media_verified":true}),
        )
    }
    fn cue_sources(&self, cue: &Value) -> Result<Vec<Value>> {
        let mut stale = Vec::new();
        for source in cue["narrative_refs"].as_array().unwrap() {
            let document_id = text(source, "document_id")?;
            self.document_root(document_id)?; // 线索只关联正式内容文档，不提升待审草稿状态。
            let revision_id = text(source, "revision_id")?;
            let fixed = self.document_content(document_id, Some(revision_id))?;
            let content = text(&fixed, "content")?;
            let start = integer(source, "byte_start")? as usize;
            let end = integer(source, "byte_end")? as usize;
            ensure(
                start < end && content.get(start..end) == source["quote"].as_str(),
                "hetu.invalid_source_ref",
                "线索引文必须与固定修订中的完整 UTF-8 范围一致。",
            )?;
            if self.document(document_id)?["current_revision_id"] != revision_id {
                stale.push(json!({"document_id":document_id,"revision_id":revision_id,"code":"document_changed"}));
            }
        }
        Ok(stale)
    }
    fn cue_assets(&self, cue: &Value) -> Result<Vec<Value>> {
        let mut references = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for reference in cue["asset_refs"].as_array().unwrap() {
            let id = text(reference, "asset_id")?;
            ensure(
                seen.insert(id),
                "invalid_input",
                "同一线索不能重复引用同一素材。",
            )?;
            let (asset, sha, current) =
                self.read_media_record("asset", id, Some(integer(reference, "revision")?))?;
            ensure(
                reference["sha256"] == sha && asset["kind"] == cue["kind"],
                "hetu.invalid_source_ref",
                "素材摘要或乐律／视觉分类与线索不一致。",
            )?;
            references.push(json!({"reference":reference,"title":asset["title"],"rights_status":current["rights_status"],"current_revision":current["revision"],
                "metadata_stale":current["revision"] != asset["revision"],"delivery_eligible":current["revision"] == asset["revision"] && media::delivery_eligible(&asset)}));
        }
        Ok(references)
    }
    pub(super) fn save_cue(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        media::validate_metadata(input)?;
        let mut cue = if let Some(id) = input["cue_id"].as_str() {
            let (record, sha, _) = self.read_media_record("cue", id, None)?;
            ensure(
                input["expected"] == json!({"revision":record["revision"],"sha256":sha}),
                "revision_conflict",
                "线索已在其他窗口更新，请重新读取。",
            )?;
            ensure(
                input["kind"] == record["kind"],
                "invalid_input",
                "已有线索不能改变乐律／视觉分类。",
            )?;
            let mut next = record;
            next["revision"] = json!(integer(&next, "revision")? + 1);
            next["previous_sha256"] = json!(sha);
            next
        } else {
            json!({"schema_version":"1.0.0","cue_id":id("cue"),"revision":1,"previous_sha256":null,"created_at":now()})
        };
        for field in [
            "kind",
            "title",
            "description",
            "narrative_refs",
            "asset_refs",
            "archived",
        ] {
            cue[field] = input[field].clone();
        }
        cue["updated_at"] = json!(now());
        cue["actor_ref"] = json!(self.actor());
        let stale = self.cue_sources(&cue)?;
        let assets = self.cue_assets(&cue)?;
        let sha = self.stage_media_record("cue", &cue, changes)?;
        Ok(json!({"cue":cue,"sha256":sha,"stale_sources":stale,"assets":assets,"is_head":true}))
    }
    pub(super) fn get_cue(&self, input: &Value) -> Result<Value> {
        let (cue, sha, current) =
            self.read_media_record("cue", text(input, "cue_id")?, input["revision"].as_u64())?;
        let stale = self.cue_sources(&cue)?;
        let assets = self.cue_assets(&cue)?;
        Ok(
            json!({"cue":cue,"sha256":sha,"stale_sources":stale,"assets":assets,"is_head":cue["revision"] == current["revision"],"current_revision":current["revision"]}),
        )
    }
    pub(super) fn list_media(&self, input: &Value, object: &str) -> Result<Value> {
        let mut records = Vec::new();
        for package in ["music-cue", "visual-prompt"] {
            if input["kind"]
                .as_str()
                .is_some_and(|kind| media::package(kind) != package)
            {
                continue;
            }
            for id in self
                .store
                .entries(&format!("packages/{package}/{}", collection(object)))?
            {
                // 中断导入可能只留下未登记的原字节；不将其冒充登记成功。
                if !id.starts_with(&format!("{object}_")) {
                    continue;
                }
                let head = format!(
                    "packages/{package}/{}/{id}/{object}.json",
                    collection(object)
                );
                if !self.store.exists(&head)? {
                    continue;
                }
                let (record, sha, _) = self.read_media_record(object, &id, None)?;
                ensure(
                    media::package(text(&record, "kind")?) == package,
                    "hetu.integrity_failure",
                    "素材或线索 ID 在不同内容包中重复。",
                )?;
                if object == "cue"
                    && ((input["include_archived"] != true && record["archived"] == true)
                        || input["document_id"].as_str().is_some_and(|id| {
                            !record["narrative_refs"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .any(|r| r["document_id"] == id)
                        }))
                {
                    continue;
                }
                if object == "asset"
                    && input
                        .get("rights_status")
                        .is_some_and(|rights| rights != &record["rights_status"])
                {
                    continue;
                }
                let mut summary = json!({format!("{object}_id"):id,"title":record["title"],"kind":record["kind"],"revision":record["revision"],"sha256":sha,"updated_at":record["updated_at"]});
                if object == "asset" {
                    summary["rights_status"] = record["rights_status"].clone();
                    summary["size_bytes"] = record["blob"]["size_bytes"].clone();
                    summary["media_type"] = record["blob"]["media_type"].clone();
                    summary["media_verified"] = json!(false);
                    summary["delivery_eligible"] = json!(media::delivery_eligible(&record));
                } else {
                    summary["archived"] = record["archived"].clone();
                    summary["source_count"] =
                        json!(record["narrative_refs"].as_array().unwrap().len());
                    summary["asset_count"] = json!(record["asset_refs"].as_array().unwrap().len());
                }
                records.push(summary);
                ensure(
                    records.len() <= 10_000,
                    "hetu.budget_exceeded",
                    "素材或线索列表超过枚举预算。",
                )?;
            }
        }
        records.sort_by(|a, b| {
            b["updated_at"]
                .as_str()
                .cmp(&a["updated_at"].as_str())
                .then_with(|| {
                    a[format!("{object}_id")]
                        .as_str()
                        .cmp(&b[format!("{object}_id")].as_str())
                })
        });
        let fingerprint = digest(bytes(
            &json!({"workspace":self.scope(),"actor":self.actor(),"object":object,"kind":input["kind"],"document_id":input["document_id"],"rights_status":input["rights_status"],"archived":input["include_archived"],"records":records}),
        )?);
        let start = if let Some(cursor) = input["cursor"].as_str() {
            let (hash, offset) = cursor
                .split_once(':')
                .ok_or_else(|| Error::new("cursor_invalid", "分页游标无效。"))?;
            let offset = offset
                .parse::<usize>()
                .map_err(|_| Error::new("cursor_invalid", "分页偏移无效。"))?;
            ensure(
                hash == fingerprint && offset > 0 && offset < records.len(),
                "cursor_invalid",
                "列表或筛选已变化，请重新查询。",
            )?;
            offset
        } else {
            0
        };
        let end = (start + input["limit"].as_u64().unwrap_or(50) as usize).min(records.len());
        Ok(
            json!({collection(object):&records[start..end],"next_cursor":(end < records.len()).then(||format!("{fingerprint}:{end}"))}),
        )
    }
}
