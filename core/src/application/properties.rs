use super::*;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const PATH: &str = ".hetu/workspace-properties.json";

fn timestamp(value: &Value) -> Option<OffsetDateTime> {
    value.as_str().and_then(|s| OffsetDateTime::parse(s, &Rfc3339).ok())
}

impl Kernel {
    pub(super) fn workspace_properties(&self) -> Result<Value> {
        if self.store.exists(PATH)? {
            let value = self.store.json(PATH)?;
            ensure(
                value["schema_version"] == "1.0.0" && value["workspace_id"] == self.scope()
                    && ["created_at", "updated_at"].iter().all(|key| {
                        value.get(*key).is_some_and(|v| v.is_null() || timestamp(v).is_some())
                    }) && (value["created_at"].is_null() || value["updated_at"].is_null()
                        || timestamp(&value["updated_at"]) >= timestamp(&value["created_at"])),
                "hetu.integrity_failure", "作品时间记录无效。",
            )?;
            return Ok(value);
        }
        // 旧作品只从原始记录恢复时间，不使用文件系统时间或当前打开时间。
        let created = if self.store.exists("shared/blueprint-revisions/1.json")? {
            self.blueprint_revision(Some(1))?.0["lock"]["changed_at"].clone()
        } else { Value::Null };
        let mut updated = Value::Null;
        for name in self.store.entries(".hetu/audit")? {
            if !name.ends_with(".json") { continue; }
            let record = self.store.json(&format!(".hetu/audit/{name}"))?;
            let candidate = &record["created_at"];
            if timestamp(candidate).is_some() && timestamp(candidate) > timestamp(&updated) {
                updated = candidate.clone();
            }
        }
        Ok(json!({"schema_version":"1.0.0","workspace_id":self.scope(),"created_at":created,"updated_at":updated}))
    }

    pub(super) fn stage_workspace_properties(&self, changes: &mut Changes) -> Result<()> {
        if self.is_creation_project() { return Ok(()); }
        let mut value = self.workspace_properties()?;
        let current = json!(now());
        if timestamp(&value["created_at"]) > timestamp(&value["updated_at"]) {
            value["updated_at"] = value["created_at"].clone();
        }
        if timestamp(&current) > timestamp(&value["updated_at"]) {
            value["updated_at"] = current;
        }
        changes.insert(PATH.into(), bytes(&value)?);
        self.stage_work_activity(changes)?;
        Ok(())
    }
}
