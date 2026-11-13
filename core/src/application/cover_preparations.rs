use super::*;
use crate::infrastructure::media as files;
use std::fs::File;

const ROOT: &str = "packages/visual-prompt/covers/preparations";

fn record_schema(record: &Value, name: &str) -> Result<()> {
    static VALIDATORS: OnceLock<BTreeMap<&str, OnceLock<jsonschema::Validator>>> = OnceLock::new();
    let validators = VALIDATORS.get_or_init(|| {
        [
            "creative_creation_source",
            "preparation_source",
            "preparation_record",
            "preparation_ref",
        ]
        .into_iter()
        .map(|name| (name, OnceLock::new()))
        .collect()
    });
    let validator = validators[name].get_or_init(|| {
        jsonschema::validator_for(&covers::definition(name))
            .expect("embedded cover preparation schema")
    });
    ensure(
        validator.is_valid(record),
        "hetu.integrity_failure",
        "筹备封面记录不符合持久化合同。",
    )
}

fn import_id(reference: &Value) -> Result<String> {
    Ok(format!(
        "cover_preparation_{}",
        digest(serde_json_canonicalizer::to_vec(reference)?)
    ))
}

impl Kernel {
    fn cover_preparation_names(&self) -> Result<Vec<String>> {
        if !self
            .store
            .entries("packages/visual-prompt")?
            .iter()
            .any(|n| n == "covers")
            || !self
                .store
                .entries("packages/visual-prompt/covers")?
                .iter()
                .any(|n| n == "preparations")
        {
            return Ok(Vec::new());
        }
        let names = self.store.entries(ROOT)?;
        ensure(
            names.len() <= 1000,
            "hetu.budget_exceeded",
            "筹备封面超过单次枚举上限。",
        )?;
        Ok(names)
    }

    pub(super) fn cover_creation_source(&self) -> Result<Option<Value>> {
        if !self.store.exists(".hetu/creation-source.json")? {
            return Ok(None);
        }
        let source = self.store.json(".hetu/creation-source.json")?;
        record_schema(&source, "creative_creation_source")?;
        Ok(Some(source))
    }

    pub(super) fn validate_preparation_source(&self, source: &Value) -> Result<()> {
        record_schema(source, "preparation_source")?;
        let creation = &source["creation_source"];
        let project = &source["completed_project"];
        let reference = &source["reference"];
        let task_ref = &reference["task_ref"];
        let request = &source["request"];
        let submission = &source["submission"];
        ensure(
            self.cover_creation_source()?.as_ref() == Some(creation)
                && project["project_id"] == creation["project_id"]
                && integer(project, "revision")? == integer(creation, "project_revision")? + 1
                && project["previous_sha256"] == creation["project_sha256"]
                && source["completed_project_sha256"] == digest(bytes(project)?)
                && project["created_workspace_ref"]["workspace_id"] == self.scope()
                && project["created_workspace_ref"]["novel_id"]
                    == self.get_novel()?["novel"]["novel_id"]
                && task_ref["scope_ref"]
                    == json!({"kind":"creation_project","id":creation["project_id"]})
                && project["task_refs"].as_array().unwrap().contains(task_ref)
                && request["scope_ref"] == task_ref["scope_ref"]
                && request["task_id"] == task_ref["task_id"]
                && request["request_revision"] == task_ref["request_revision"]
                && request["task_kind"] == "cover"
                && source["request_sha256"] == digest(bytes(request)?)
                && submission["submission_id"] == reference["submission_id"]
                && submission["task_ref"] == *task_ref
                && submission["request_sha256"] == source["request_sha256"]
                && source["submission_sha256"] == digest(bytes(submission)?)
                && submission["candidates"]
                    .as_array()
                    .unwrap()
                    .contains(&source["candidate"])
                && source["candidate"]["candidate_id"] == reference["candidate_id"]
                && source["candidate"]["kind"] == "image",
            "hetu.integrity_failure",
            "筹备封面的作品归属、任务或固定来源不一致。",
        )
    }

    pub(super) fn preparation_cover_source(
        &self,
        reference: &Value,
    ) -> Result<(File, Value, Value, Option<Value>)> {
        let record = self.read_cover_preparation(reference)?;
        self.preparation_cover_file(&record)
    }

    fn preparation_cover_file(
        &self,
        record: &Value,
    ) -> Result<(File, Value, Value, Option<Value>)> {
        let asset = self.get_asset(&json!({
            "asset_id":record["asset_ref"]["asset_id"],
            "revision":record["asset_ref"]["revision"]
        }))?;
        ensure(
            asset["sha256"] == record["asset_ref"]["sha256"]
                && asset["asset"]["blob"]["sha256"] == record["source_ref"]["candidate"]["sha256"]
                && asset["asset"]["blob"]["size_bytes"]
                    == record["source_ref"]["candidate"]["size_bytes"],
            "hetu.integrity_failure",
            "筹备封面的受管素材与来源不一致。",
        )?;
        Ok((
            self.store
                .managed_media(text(&asset["asset"]["blob"], "path")?)?,
            record["source_ref"]["candidate"].clone(),
            record["source_ref"].clone(),
            Some(record["asset_ref"].clone()),
        ))
    }

    fn read_cover_preparation(&self, reference: &Value) -> Result<Value> {
        record_schema(reference, "preparation_ref")?;
        let import_id = text(reference, "import_id")?;
        let raw = self.store.read(&format!("{ROOT}/{import_id}.json"))?;
        let record: Value = serde_json::from_slice(&raw)?;
        record_schema(&record, "preparation_record")?;
        ensure(
            record["workspace_id"] == self.scope()
                && record["import_id"] == import_id
                && reference["sha256"] == digest(raw)
                && import_id == self::import_id(&record["source_ref"]["reference"])?
                && record["width"] == record["source_ref"]["candidate"]["width"]
                && record["height"] == record["source_ref"]["candidate"]["height"],
            "hetu.integrity_failure",
            "筹备封面导入记录或摘要不一致。",
        )?;
        self.validate_preparation_source(&record["source_ref"])?;
        Ok(record)
    }

    pub(super) fn cover_preparation(&self, reference: &Value) -> Result<Value> {
        let record = self.read_cover_preparation(reference)?;
        let (mut file, candidate, _, _) = self.preparation_cover_file(&record)?;
        let image = files::decode_image(&mut file)?;
        ensure(
            image.scan["sha256"] == candidate["sha256"]
                && image.decoded.width() == record["width"]
                && image.decoded.height() == record["height"],
            "hetu.integrity_failure",
            "筹备封面原件已变化。",
        )?;
        let metadata = self.get_novel()?["novel"]["metadata"].clone();
        let fields =
            &record["source_ref"]["request"]["input_snapshot"]["scope_context"]["selected_fields"];
        Ok(json!({"record":record,"reference":reference,
            "preview":files::image_preview(&image.decoded)?,
            "book_changed":fields["title"]["value"] != metadata["title"]
                || fields["author_name"]["value"] != metadata["author_name"]}))
    }

    pub(super) fn import_cover_preparation(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let creation = self
            .cover_creation_source()?
            .ok_or_else(|| Error::new("forbidden", "此作品没有对应的建书筹备。"))?;
        let reference = &input["candidate_ref"];
        let import_id = self::import_id(reference)?;
        // 新操作键也复用同一候选，避免重复复制原图；原键由通用回执优先恢复。
        let names = self.cover_preparation_names()?;
        if names.contains(&format!("{import_id}.json")) {
            let raw = self.store.read(&format!("{ROOT}/{import_id}.json"))?;
            return self.cover_preparation(&json!({"import_id":import_id,"sha256":digest(raw)}));
        }
        ensure(
            names.len() < 1000,
            "hetu.budget_exceeded",
            "本书转入的筹备封面已达到上限。",
        )?;
        let path = Path::new(text(input, "project_path")?);
        ensure(
            path.is_absolute(),
            "hetu.unsafe_path",
            "请通过本机文件面板选择筹备目录。",
        )?;
        let source = Kernel::open(json!({"creation_project_path":path,"mode":"author"}))?;
        let _source_lock = source.store.lock()?;
        source.store.recover()?;
        let (project, project_sha) = source.creation_project(None)?;
        let (_, original_sha) =
            source.creation_project(Some(integer(&creation, "project_revision")?))?;
        ensure(
            source.scope() == creation["project_id"]
                && original_sha == creation["project_sha256"]
                && project["created_workspace_ref"]["workspace_id"] == self.scope()
                && project["task_refs"]
                    .as_array()
                    .unwrap()
                    .contains(&reference["task_ref"]),
            "forbidden",
            "只能转入本书建书筹备中的封面。",
        )?;
        let candidate = source.task_candidate(reference)?;
        ensure(
            candidate["kind"] == "image",
            "invalid_input",
            "只能将图片候选转入封面。",
        )?;
        let task = source.get_creative_task(
            &json!({"task_ref":reference["task_ref"],"submission_id":reference["submission_id"]}),
        )?;
        let provenance = json!({"kind":"creation_preparation","reference":reference,
            "creation_source":creation,"completed_project":project,"completed_project_sha256":project_sha,
            "request":task["request"],"request_sha256":task["request_sha256"],
            "submission":task["submission"],"submission_sha256":digest(bytes(&task["submission"])?),"candidate":candidate});
        self.validate_preparation_source(&provenance)?;
        let mut file = source
            .store
            .managed_media(text(&candidate, "relative_path")?)?;
        let image = files::decode_image(&mut file)?;
        ensure(
            image.scan["sha256"] == candidate["sha256"]
                && image.scan["size_bytes"] == candidate["size_bytes"]
                && image.scan["media_type"] == candidate["media_type"]
                && image.decoded.width() == candidate["width"]
                && image.decoded.height() == candidate["height"],
            "hetu.integrity_failure",
            "筹备封面图片与固定提交不一致。",
        )?;
        let asset_id = id("asset");
        let extension = text(&image.scan, "extension")?;
        let asset_path = format!("packages/visual-prompt/assets/{asset_id}/source.{extension}");
        self.store
            .import_media(&asset_path, &mut file, &image.scan)?;
        let timestamp = now();
        let asset = json!({"schema_version":"1.0.0","asset_id":asset_id,"revision":1,"previous_sha256":null,
            "kind":"visual","original_filename":format!("preparation-cover.{extension}"),
            "blob":{"path":asset_path,"sha256":image.scan["sha256"],"size_bytes":image.scan["size_bytes"],"media_type":image.scan["media_type"],"validation":"signature_only"},
            "title":candidate["title"],"source":{"source_type":"external_agent","creator_statement":"建书筹备封面，来源见导入记录；权利未经验证。"},
            "rights_status":"unknown","redistribution_allowed":false,"rights_statement":"","created_at":timestamp,"updated_at":timestamp,"actor_ref":self.actor()});
        let asset_sha = self.stage_media_record("asset", &asset, changes)?;
        let record = json!({"schema_version":"1.0.0","workspace_id":self.scope(),"import_id":import_id,
            "asset_ref":{"asset_id":asset_id,"revision":1,"sha256":asset_sha},"source_ref":provenance,
            "width":image.decoded.width(),"height":image.decoded.height(),"actor_ref":self.actor(),"created_at":timestamp});
        record_schema(&record, "preparation_record")?;
        let raw = bytes(&record)?;
        let reference = json!({"import_id":import_id,"sha256":digest(&raw)});
        self.store.directory(ROOT)?;
        changes.insert(format!("{ROOT}/{import_id}.json"), raw);
        Ok(
            json!({"record":record,"reference":reference,"preview":files::image_preview(&image.decoded)?}),
        )
    }

    pub(super) fn list_cover_preparations(&self, input: &Value) -> Result<Value> {
        let names = self.cover_preparation_names()?;
        let mut references = Vec::new();
        for name in names {
            let import_id = name.strip_suffix(".json").ok_or_else(|| {
                Error::new("hetu.integrity_failure", "筹备封面目录包含未知文件。")
            })?;
            if import_id <= input["cursor"].as_str().unwrap_or("") {
                continue;
            }
            let sha = digest(self.store.read(&format!("{ROOT}/{name}"))?);
            references.push(json!({"import_id":import_id,"sha256":sha}));
        }
        let limit = input["limit"].as_u64().unwrap_or(20) as usize;
        let next = if references.len() > limit {
            references[limit - 1]["import_id"].clone()
        } else {
            Value::Null
        };
        let imports = references
            .iter()
            .take(limit)
            .map(|r| self.cover_preparation(r))
            .collect::<Result<Vec<_>>>()?;
        Ok(json!({"imports":imports,"next_cursor":next}))
    }
}
