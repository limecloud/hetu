//! 创作对象复用原身份；创作库和来源关系不持有另一份可写正文。
use super::*;

const LINKS: &str = "shared/work-links";

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

    pub(super) fn create_work_link(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let source = &input["source_ref"];
        let target = &input["target_ref"];
        self.fixed_work_record(source)?;
        let target_record = self.fixed_work_record(target)?;
        let target_current = self.work_record(&target["work_ref"], None)?;
        ensure(target_record["revision"] == target_current["revision"], "revision_conflict", "目标已有新修订，请重新准备关联。")?;
        ensure(source["work_ref"] != target["work_ref"], "invalid_input", "创作对象不能关联自身。")?;
        let relation = text(input, "relation")?;
        ensure(match relation {
            "adaptation" => source["work_ref"]["kind"] == "novel" && target["work_ref"]["kind"] == "drama",
            "production" => source["work_ref"]["kind"] == "drama" && target["work_ref"]["kind"] == "video",
            "reference" | "continuation" => true,
            _ => false,
        }, "invalid_input", "关联类型与两端对象不匹配。")?;
        for link_id in self.record_ids(LINKS, "worklink")? {
            let link = self.versioned_record(LINKS, &link_id, "link_id", None)?.0;
            ensure(!(link["source_ref"] == *source && link["target_ref"] == *target && link["relation"] == relation
                && link["archived"] == false), "invalid_input", "相同固定来源已经关联。")?;
        }
        let record = json!({"schema_version":"1.0.0","workspace_id":self.scope(),"link_id":id("worklink"),
            "revision":1,"previous_sha256":null,"source_ref":source,"target_ref":target,"relation":relation,
            "archived":false,"created_at":now(),"updated_at":now(),"actor_ref":self.actor()});
        schema(&record, &definition("work_link"))?;
        let sha = self.stage_versioned_record(LINKS, "link_id", &record, changes)?;
        Ok(json!({"link":record,"sha256":sha}))
    }

    pub(super) fn list_work_links(&self, input: &Value) -> Result<Value> {
        self.work_record(&input["work_ref"], None)?;
        let mut results = Vec::new();
        for link_id in self.record_ids(LINKS, "worklink")? {
            let (link, sha, _) = self.versioned_record(LINKS, &link_id, "link_id", None)?;
            schema(&link, &definition("work_link"))?;
            let related = if link["target_ref"]["work_ref"] == input["work_ref"] {
                Some((&link["source_ref"], "incoming"))
            } else if link["source_ref"]["work_ref"] == input["work_ref"] {
                Some((&link["target_ref"], "outgoing"))
            } else { None };
            if let Some((other, direction)) = related {
                if input["include_archived"] == true || link["archived"] != true {
                    let scoped = self.granted_work()?.is_some();
                    let newer = if scoped { Value::Null } else {
                        json!(self.work_record(&other["work_ref"], None)?["revision"] != other["revision_ref"]["revision"])
                    };
                    results.push(json!({"link":link,"sha256":sha,"direction":direction,
                        "related_has_newer_revision":newer,"related_read_requires_authorization":scoped}));
                }
            }
        }
        self.record_page(input, results, "links")
    }
}
