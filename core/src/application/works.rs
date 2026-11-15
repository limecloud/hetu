//! 创作对象复用原身份；创作库和来源关系不持有另一份可写正文。
use super::*;

pub(super) fn bundle_reference(mut input: Value) -> Value {
    if input.to_string().contains("https://hetu.limeai.run/schemas/work.schema.json") {
        input["$defs"]["work_resource"] = json!({"$id":"https://hetu.limeai.run/schemas/work.schema.json",
            "$defs":{"work_ref":definition("work_ref")}});
    }
    input
}

pub(super) fn definition(name: &str) -> Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    let source = SCHEMA.get_or_init(|| serde_json::from_str(include_str!(
        "../../../contracts/schemas/work.schema.json"
    )).expect("embedded work schema"));
    domain::schema::definition(source, name)
}

impl Kernel {
    pub(super) fn work_ref(&self, kind: &str, object_id: &Value) -> Value {
        json!({"workspace_id":self.scope(),"kind":kind,"object_id":object_id})
    }

    pub(super) fn check_work_ref(&self, reference: &Value) -> Result<()> {
        schema(reference, &definition("work_ref"))?;
        ensure(reference["workspace_id"] == self.scope(), "forbidden", "创作对象不属于当前工作区。")?;
        let prefix = match text(reference, "kind")? {
            "novel" => "novel",
            "drama" => "drama",
            "video" => "video",
            _ => return Err(Error::new("invalid_input", "创作对象类型无效。")),
        };
        checked_id(text(reference, "object_id")?, prefix)?;
        Ok(())
    }

    // 小说目录继续使用已有历史；不能为登记新入口改写旧文件或摘要。
    fn work_novel_revision(&self, revision: Option<u64>) -> Result<Value> {
        let current = self.novel()?.ok_or_else(|| Error::new("not_found", "当前工作区没有小说。"))?;
        let latest = integer(&current, "revision")?;
        let target = revision.unwrap_or(latest);
        ensure(target > 0 && target <= latest, "not_found", "小说资料修订不存在。")?;
        ensure(latest - target < 1000, "hetu.budget_exceeded", "小说历史核验超过单次预算。")?;
        let mut expected = digest(bytes(&current)?);
        for number in (target..=latest).rev() {
            let content = self.store.read(&format!(".hetu/novels/{number}.json"))?;
            ensure(digest(&content) == expected, "hetu.integrity_failure", "小说历史摘要不一致。")?;
            let record: Value = serde_json::from_slice(&content)?;
            schema(&record, &domain::novel::definition("novel"))?;
            ensure(record["novel_id"] == current["novel_id"] && record["workspace_id"] == self.scope()
                && record["revision"] == number && record["created_at"] == current["created_at"],
                "hetu.integrity_failure", "小说历史身份或修订不一致。")?;
            if number == target { return Ok(record); }
            expected = text(&record, "previous_sha256")?.to_owned();
        }
        unreachable!("validated novel revision range")
    }

    pub(crate) fn work_record(&self, reference: &Value, revision: Option<u64>) -> Result<Value> {
        self.check_work_ref(reference)?;
        if let Some(granted) = self.granted_work()? {
            ensure(granted == *reference, "forbidden", "关联不授予读取其他创作对象的权限。")?;
        }
        let object_id = text(reference, "object_id")?;
        let record = match text(reference, "kind")? {
            "novel" => {
                let record = self.work_novel_revision(revision)?;
                ensure(record["novel_id"] == object_id, "not_found", "小说身份不匹配。")?;
                record
            },
            "drama" => self.versioned_record("packages/drama/projects", object_id, "project_id", revision)?.0,
            "video" => self.video_project(object_id, revision)?,
            _ => return Err(Error::new("invalid_input", "创作对象类型无效。")),
        };
        if reference["kind"] == "drama" {
            schema(&record, &serde_json::from_str(include_str!("../../../contracts/schemas/drama-project.schema.json"))?)?;
        }
        Ok(record)
    }

    pub(super) fn fixed_work_record(&self, reference: &Value) -> Result<Value> {
        schema(reference, &definition("work_revision_ref"))?;
        let record = self.work_record(&reference["work_ref"], Some(integer(&reference["revision_ref"], "revision")?))?;
        ensure(reference["sha256"] == digest(bytes(&record)?), "hetu.stale_evidence", "创作对象固定修订与摘要不一致。")?;
        Ok(record)
    }

    pub(super) fn work_revision_ref(&self, reference: &Value, record: &Value) -> Result<Value> {
        Ok(json!({"work_ref":reference,"revision_ref":{"revision":record["revision"]},"sha256":digest(bytes(record)?)}))
    }

    fn work_summary(&self, reference: Value, record: &Value) -> Result<Value> {
        Ok(json!({"work_ref":reference,"fixed_ref":self.work_revision_ref(&reference, record)?,
            "title":if reference["kind"] == "novel" { &record["metadata"]["title"] } else { &record["title"] },
            "created_at":record["created_at"],"updated_at":self.work_updated_at(&reference, record)?,
            "archived":record["archived"] == true || record["metadata"]["status"] == "archived"}))
    }

    pub(super) fn get_work(&self, input: &Value) -> Result<Value> {
        let reference = &input["work_ref"];
        let record = self.work_record(reference, input["revision"].as_u64())?;
        let mut summary = self.work_summary(reference.clone(), &record)?;
        if input["revision"].is_number() { summary["updated_at"] = record["updated_at"].clone(); }
        Ok(json!({"summary":summary,"record":record,
            "access_scope":if self.granted_work()?.is_some() { "work" } else if self.management_grant.is_some() { "workspace" } else { "author" }}))
    }

    pub(super) fn list_works(&self, input: &Value) -> Result<Value> {
        if let Some(reference) = self.granted_work()? {
            let record = self.work_record(&reference, None)?;
            let summary = self.work_summary(reference.clone(), &record)?;
            let results = if (input["kind"].is_null() || input["kind"] == reference["kind"])
                && (input["include_archived"] == true || summary["archived"] != true) { vec![summary] } else { vec![] };
            return self.record_page(input, results, "works");
        }
        let mut results = Vec::new();
        if input["kind"].is_null() || input["kind"] == "novel" {
            if let Some(novel) = self.novel()? {
                if input["include_archived"] == true || novel["metadata"]["status"] != "archived" {
                    results.push(self.work_summary(self.work_ref("novel", &novel["novel_id"]), &novel)?);
                }
            }
        }
        if input["kind"].is_null() || input["kind"] == "drama" {
            for object_id in self.record_ids("packages/drama/projects", "drama")? {
                let project = self.drama_project(&object_id)?;
                if input["include_archived"] == true || project["archived"] != true {
                    results.push(self.work_summary(self.work_ref("drama", &project["project_id"]), &project)?);
                }
            }
        }
        if input["kind"].is_null() || input["kind"] == "video" {
            for object_id in self.record_ids("packages/video/projects", "video")? {
                let project = self.video_project(&object_id, None)?;
                if input["include_archived"] == true || project["archived"] != true {
                    results.push(self.work_summary(self.work_ref("video", &project["video_project_id"]), &project)?);
                }
            }
        }
        // 顺序只影响本机索引投影，不把“最近打开”写进创作记录。
        results.sort_by(|a, b| a["work_ref"].to_string().cmp(&b["work_ref"].to_string()));
        self.record_page(input, results, "works")
    }

}
