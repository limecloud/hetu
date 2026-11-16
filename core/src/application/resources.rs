use super::*;
use std::collections::BTreeSet;

const ITEMS: &str = "resources/items";
const USAGES: &str = "resources/usages";

pub(super) fn definition(name: &str) -> Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    let source = SCHEMA.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../contracts/schemas/resources.schema.json"
        ))
        .expect("resource schema")
    });
    domain::schema::definition(source, name)
}

impl Kernel {
    pub(super) fn read_resource(
        &self,
        resource_id: &str,
        revision: Option<u64>,
    ) -> Result<(Value, String, Value)> {
        checked_id(resource_id, "resource")?;
        let result = self.versioned_record(ITEMS, resource_id, "resource_id", revision)?;
        schema(&result.0, &definition("record"))
            .map_err(|_| Error::new("hetu.integrity_failure", "资料记录不符合合同。"))?;
        Ok(result)
    }
    fn resource_task_owner(&self) -> Result<Option<Value>> {
        let Some(id) = self.task_id.as_deref() else {
            return Ok(None);
        };
        let request = self.task_request(id)?.0;
        // 旧任务没有显式作品身份，继续沿原来的固定资料授权解释。
        let reference = &request["input_snapshot"]["scope_context"]["work_ref"];
        Ok(reference.is_object().then(|| reference.clone()))
    }
    pub(super) fn resource_in_work(
        &self,
        id: &str,
        revision: Option<u64>,
        work: &Value,
    ) -> Result<bool> {
        Ok(self.read_resource(id, revision)?.0["work_ref"] == *work)
    }
    fn check_resource_task_owner(&self, record: &Value) -> Result<()> {
        if let Some(owner) = self.resource_task_owner()? {
            ensure(
                record["work_ref"] == owner,
                "forbidden",
                "资料不属于此任务固定的作品。",
            )?;
        }
        Ok(())
    }
    fn validate_resource_fields(&self, input: &Value, owner: Option<&Value>) -> Result<()> {
        ensure(
            !text(input, "title")?.trim().is_empty(),
            "invalid_input",
            "请填写资料名称。",
        )?;
        if let Some(project) = input["project_id"].as_str() {
            self.drama_project(project)?;
            if let Some(owner) = owner {
                ensure(
                    owner["kind"] == "drama" && owner["object_id"] == project,
                    "forbidden",
                    "资料的剧本引用与所属作品不一致。",
                )?;
            }
        }
        for reference in input["entity_refs"].as_array().unwrap() {
            let (bp, sha) = if let Some(owner) = owner {
                ensure(
                    reference["work_ref"] == *owner,
                    "forbidden",
                    "资料只能关联所属作品的设定。",
                )?;
                self.source_blueprint(
                    &json!({"work_ref":owner,"blueprint_id":reference["blueprint_id"],
                    "revision":reference["blueprint_revision"]}),
                )?
            } else {
                ensure(
                    reference["work_ref"].is_null() && reference["blueprint_id"].is_null(),
                    "invalid_input",
                    "未归属历史资料不能添加新的作品设定引用。",
                )?;
                self.blueprint_for_snapshot(
                    integer(reference, "blueprint_revision")?,
                    text(reference, "blueprint_sha256")?,
                )?
            };
            ensure(
                reference["blueprint_sha256"] == sha,
                "hetu.stale_evidence",
                "设定引用摘要不一致。",
            )?;
            let (collection, field) = match text(reference, "kind")? {
                "character" => ("characters", "character_id"),
                "location" => ("locations", "location_id"),
                "faction" => ("factions", "faction_id"),
                "event" => ("timeline", "event_id"),
                _ => ("world", "entry_id"),
            };
            ensure(
                bp[collection]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|e| e[field] == reference["entity_id"]),
                "invalid_input",
                "设定引用不在固定修订中。",
            )?;
        }
        Ok(())
    }
    fn copy_resource_fields(input: &Value, record: &mut Value) {
        for field in [
            "title",
            "category",
            "body",
            "tags",
            "project_id",
            "entity_refs",
            "source_notes",
        ] {
            record[field] = input[field].clone();
        }
    }
    fn resource_write_access(&self, record: Option<&Value>) -> Result<()> {
        if self.author {
            return Ok(());
        }
        let access = self.resource_task_access()?;
        if let Some(record) = record {
            self.check_resource_task_owner(record)?;
            let own = record["owner_task_id"].as_str() == self.task_id.as_deref();
            let allowed = access["editable_resource_ids"]
                .as_array()
                .unwrap()
                .contains(&record["resource_id"]);
            ensure(
                record["state"] == "draft" && (own || allowed),
                "forbidden",
                "此任务只能维护获权且尚未采用的资料草稿。",
            )?;
        } else {
            ensure(
                access["allow_create"] == true,
                "forbidden",
                "此任务未获权新增资料。",
            )?;
        }
        Ok(())
    }
    fn resource_for_read(&self, input: &Value) -> Result<(Value, String, Value)> {
        let resource_id = text(input, "resource_id")?;
        let mut revision = input["revision"].as_u64();
        if !self.author && self.task_id.is_some() {
            let access = self.resource_task_access()?;
            let (current, _, _) = self.read_resource(resource_id, None)?;
            self.check_resource_task_owner(&current)?;
            let own = current["owner_task_id"].as_str() == self.task_id.as_deref();
            let editable = access["editable_resource_ids"]
                .as_array()
                .unwrap()
                .contains(&json!(resource_id));
            if current["state"] != "draft" || (!own && !editable) {
                let reference = access["resource_refs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|r| r["resource_id"] == resource_id)
                    .ok_or_else(|| Error::new("forbidden", "资料不在当前任务读取范围。"))?;
                let allowed = integer(reference, "revision")?;
                ensure(
                    revision.is_none() || revision == Some(allowed),
                    "forbidden",
                    "任务只能读取获权的固定资料修订。",
                )?;
                revision = Some(allowed);
                let result = self.read_resource(resource_id, revision)?;
                ensure(
                    reference["sha256"] == result.1,
                    "hetu.integrity_failure",
                    "任务资料摘要不一致。",
                )?;
                return Ok(result);
            }
        }
        let result = self.read_resource(resource_id, revision)?;
        self.check_resource_task_owner(&result.0)?;
        Ok(result)
    }
    pub(super) fn get_resource(&self, input: &Value) -> Result<Value> {
        let (resource, sha, current) = self.resource_for_read(input)?;
        Ok(
            json!({"resource":resource,"sha256":sha,"is_head":resource["revision"]==current["revision"],"current_revision":current["revision"]}),
        )
    }
    pub(super) fn list_resources(&self, input: &Value) -> Result<Value> {
        if let Some(work) = input.get("work_ref") {
            self.work_record(work, None)?;
        }
        let task_owner = self.resource_task_owner()?;
        let access = if !self.author && self.task_id.is_some() {
            Some(self.resource_task_access()?)
        } else {
            None
        };
        let mut records = Vec::new();
        for name in self.record_ids(ITEMS, "resource")? {
            let (current, _, _) = self.read_resource(&name, None)?;
            if input
                .get("work_ref")
                .is_some_and(|work| current["work_ref"] != *work)
            {
                continue;
            }
            if let Some(owner) = &task_owner {
                if current["work_ref"] != *owner {
                    continue;
                }
            }
            if let Some(access) = &access {
                let permitted = (current["state"] == "draft"
                    && (current["owner_task_id"].as_str() == self.task_id.as_deref()
                        || access["editable_resource_ids"]
                            .as_array()
                            .unwrap()
                            .contains(&current["resource_id"])))
                    || access["resource_refs"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|r| r["resource_id"] == name);
                if !permitted {
                    continue;
                }
            }
            let (record, sha, latest) = self.resource_for_read(&json!({"resource_id":name}))?;
            if ["category", "state", "project_id"]
                .iter()
                .any(|field| input.get(*field).is_some_and(|v| *v != record[*field]))
            {
                continue;
            }
            if input
                .get("tag")
                .is_some_and(|tag| !record["tags"].as_array().unwrap().contains(tag))
            {
                continue;
            }
            if input.get("state").is_none() && record["state"] == "archived" {
                continue;
            }
            records.push(json!({"resource_id":record["resource_id"],"work_ref":record["work_ref"],"title":record["title"],"category":record["category"],"state":record["state"],"tags":record["tags"],"project_id":record["project_id"],"revision":record["revision"],"sha256":sha,"is_head":record["revision"]==latest["revision"],"updated_at":record["updated_at"]}));
            ensure(
                records.len() <= 10000,
                "hetu.budget_exceeded",
                "资料数量超过单次索引预算。",
            )?;
        }
        self.record_page(input, records, "resources")
    }
    pub(super) fn create_resource(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        self.resource_write_access(None)?;
        let task_owner = self.resource_task_owner()?;
        ensure(
            self.author
                || self.task_id.is_none()
                || task_owner.is_some()
                || input.get("work_ref").is_none(),
            "forbidden",
            "旧任务不能自行增加作品范围；请准备明确作品的新任务。",
        )?;
        let owner = input
            .get("work_ref")
            .cloned()
            .or_else(|| task_owner.clone());
        if let Some(task_owner) = task_owner {
            ensure(
                owner.as_ref() == Some(&task_owner),
                "forbidden",
                "不能替其他作品创建资料。",
            )?;
        }
        if let Some(owner) = &owner {
            self.work_record(owner, None)?;
        }
        self.validate_resource_fields(input, owner.as_ref())?;
        let mut record = json!({"schema_version":"1.0.0","workspace_id":self.scope(),"resource_id":id("resource"),"revision":1,"previous_sha256":null,"state":"draft","owner_task_id":self.task_id,"created_at":now(),"updated_at":now(),"actor_ref":self.actor()});
        if let Some(owner) = owner {
            record["schema_version"] = json!("2.0.0");
            record["work_ref"] = owner;
        }
        Self::copy_resource_fields(input, &mut record);
        schema(&record, &definition("record"))?;
        let sha = self.stage_versioned_record(ITEMS, "resource_id", &record, changes)?;
        Ok(json!({"resource":record,"sha256":sha,"is_head":true,"current_revision":1}))
    }
    pub(super) fn update_resource(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let (mut record, sha, _) = self.read_resource(text(input, "resource_id")?, None)?;
        self.resource_write_access(Some(&record))?;
        ensure(
            input["expected"] == json!({"revision":record["revision"],"sha256":sha}),
            "revision_conflict",
            "资料已有更新，请重新读取并比较。",
        )?;
        ensure(
            input
                .get("work_ref")
                .is_none_or(|owner| *owner == record["work_ref"]),
            "forbidden",
            "资料归属不可修改；跨作品请另建独立资料。",
        )?;
        self.validate_resource_fields(input, record.get("work_ref"))?;
        self.advance_record(&mut record, &sha)?;
        Self::copy_resource_fields(input, &mut record);
        schema(&record, &definition("record"))?;
        let sha = self.stage_versioned_record(ITEMS, "resource_id", &record, changes)?;
        Ok(
            json!({"resource":record,"sha256":sha,"is_head":true,"current_revision":record["revision"]}),
        )
    }
    pub(super) fn change_resource_state(
        &self,
        input: &Value,
        state: &str,
        changes: &mut Changes,
    ) -> Result<Value> {
        let (mut record, sha, _) = self.read_resource(text(input, "resource_id")?, None)?;
        ensure(
            input["expected"] == json!({"revision":record["revision"],"sha256":sha}),
            "revision_conflict",
            "资料已有更新，请重新读取并比较。",
        )?;
        ensure(
            state == "archived" || record["state"] != "archived",
            "invalid_input",
            "已归档资料不能直接采用。",
        )?;
        self.advance_record(&mut record, &sha)?;
        record["state"] = json!(state);
        let sha = self.stage_versioned_record(ITEMS, "resource_id", &record, changes)?;
        Ok(
            json!({"resource":record,"sha256":sha,"is_head":true,"current_revision":record["revision"]}),
        )
    }
    fn validate_resource_usage(&self, input: &Value) -> Result<()> {
        let reference = &input["resource_ref"];
        let (resource, sha, _) = self.read_resource(
            text(reference, "resource_id")?,
            Some(integer(reference, "revision")?),
        )?;
        ensure(
            reference["sha256"] == sha,
            "hetu.stale_evidence",
            "资料固定修订摘要不一致。",
        )?;
        let target = &input["target_ref"];
        let fixed = self.document_content(
            text(target, "document_id")?,
            Some(text(target, "revision_id")?),
        )?;
        ensure(
            fixed["document"]["draft_source_id"].is_null(),
            "invalid_input",
            "请关联作者正文的固定位置。",
        )?;
        if let Some(owner) = resource.get("work_ref") {
            ensure(
                self.document_work_ref(&fixed["document"])?.as_ref() == Some(owner),
                "forbidden",
                "资料使用位置必须属于同一作品。",
            )?;
        }
        let content = text(&fixed, "content")?;
        let start = usize::try_from(integer(target, "byte_start")?)
            .map_err(|_| Error::new("hetu.invalid_source_ref", "原文位置超限。"))?;
        let end = usize::try_from(integer(target, "byte_end")?)
            .map_err(|_| Error::new("hetu.invalid_source_ref", "原文位置超限。"))?;
        ensure(
            start <= end && content.get(start..end) == target["quote"].as_str(),
            "hetu.invalid_source_ref",
            "使用位置与固定原文不符。",
        )?;
        ensure(
            !text(input, "role")?.trim().is_empty(),
            "invalid_input",
            "请填写资料用途。",
        )
    }
    pub(super) fn save_resource_usage(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        self.validate_resource_usage(input)?;
        let mut record = if let Some(usage_id) = input["usage_id"].as_str() {
            checked_id(usage_id, "usage")?;
            let (mut record, sha, _) = self.versioned_record(USAGES, usage_id, "usage_id", None)?;
            self.validate_resource_usage(&record)?;
            let previous = self
                .read_resource(
                    text(&record["resource_ref"], "resource_id")?,
                    Some(integer(&record["resource_ref"], "revision")?),
                )?
                .0;
            let next = self
                .read_resource(
                    text(&input["resource_ref"], "resource_id")?,
                    Some(integer(&input["resource_ref"], "revision")?),
                )?
                .0;
            ensure(
                previous["work_ref"] == next["work_ref"],
                "forbidden",
                "使用记录不能转移所属作品。",
            )?;
            ensure(
                input["expected"] == json!({"revision":record["revision"],"sha256":sha}),
                "revision_conflict",
                "使用记录已有更新。",
            )?;
            self.advance_record(&mut record, &sha)?;
            record
        } else {
            ensure(
                input.get("expected").is_none(),
                "invalid_input",
                "新增使用记录不接收旧修订。",
            )?;
            json!({"schema_version":"1.0.0","workspace_id":self.scope(),"usage_id":id("usage"),"revision":1,"previous_sha256":null,"created_at":now(),"updated_at":now(),"actor_ref":self.actor()})
        };
        for field in ["resource_ref", "target_ref", "role", "archived"] {
            record[field] = input[field].clone();
        }
        schema(&record, &definition("usage_record"))?;
        let sha = self.stage_versioned_record(USAGES, "usage_id", &record, changes)?;
        Ok(json!({"usage":record,"sha256":sha}))
    }
    pub(super) fn list_resource_usages(&self, input: &Value) -> Result<Value> {
        let (_, _, resource) = self.resource_for_read(input)?;
        let mut records = Vec::new();
        for name in self.record_ids(USAGES, "usage")? {
            checked_id(&name, "usage")?;
            let (record, sha, _) = self.versioned_record(USAGES, &name, "usage_id", None)?;
            schema(&record, &definition("usage_record"))?;
            if record["resource_ref"]["resource_id"] != input["resource_id"] {
                continue;
            }
            self.validate_resource_usage(&record)?;
            let doc = self.document(text(&record["target_ref"], "document_id")?)?;
            records.push(json!({"usage":record,"sha256":sha,"target_title":doc["title"],"stale_resource":record["resource_ref"]["revision"]!=resource["revision"],"stale_source":record["target_ref"]["revision_id"]!=doc["current_revision_id"]}));
        }
        self.record_page(input, records, "usages")
    }
    pub(super) fn validate_resource_scope(
        &self,
        scope: &Value,
        owner: Option<&Value>,
    ) -> Result<Vec<Value>> {
        let editable: BTreeSet<_> = scope["editable_resource_ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap())
            .collect();
        let mut readable = BTreeSet::new();
        let mut resources = Vec::new();
        for reference in scope["resource_refs"].as_array().unwrap() {
            let id = text(reference, "resource_id")?;
            ensure(
                readable.insert(id),
                "invalid_input",
                "资料读取授权不能重复。",
            )?;
            let (record, sha, current) =
                self.read_resource(id, Some(integer(reference, "revision")?))?;
            if let Some(owner) = owner {
                ensure(
                    record["work_ref"] == *owner,
                    "forbidden",
                    "任务资料不属于所选作品。",
                )?;
            }
            ensure(
                reference["sha256"] == sha,
                "hetu.stale_evidence",
                "资料授权摘要不一致。",
            )?;
            if editable.contains(id) {
                ensure(
                    record["revision"] == current["revision"] && current["state"] == "draft",
                    "revision_conflict",
                    "只能授权修改当前尚未采用的资料草稿。",
                )?;
            }
            resources.push(json!({"resource":record,"sha256":sha}));
        }
        ensure(
            editable.is_subset(&readable),
            "invalid_input",
            "可改资料必须同时列为固定参考。",
        )?;
        Ok(resources)
    }
}
