//! 电脑副作用先持久化意图；未知结果只回读，固定窗口被围栏，原输入不落操作记录。
use crate::{Error, Result, external_execution::record_digest, infrastructure::store::Store};
use serde_json::{Value, json};
use std::path::Path;

pub struct ComputerOperations {
    store: Store,
    client: String,
}
impl ComputerOperations {
    pub fn open(directory: &Path, client: &str) -> Result<Self> {
        if !directory.is_absolute()
            || !matches!(client, "codex" | "claude-code" | "workbuddy" | "generic")
        {
            return Err(Error::new("invalid_input", "电脑操作目录或客户端无效。"));
        }
        let root = directory.join("computer/actions");
        crate::external_execution::private_dir(&root)?;
        let store = Store::open(&root)?;
        store.directory(".hetu/transactions")?;
        store.directory("operations")?;
        Ok(Self {
            store,
            client: client.into(),
        })
    }
    fn file(&self, session: &str, key: &str) -> Result<String> {
        Ok(format!(
            "operations/{}.json",
            record_digest(&json!([self.client, session, key]))?
        ))
    }
    fn read(&self, file: &str) -> Result<Option<Value>> {
        if !self.store.exists(file)? {
            return Ok(None);
        }
        let bytes = self.store.read(file)?;
        if bytes.len() > 65536 {
            return Err(Error::new("operation_invalid", "电脑操作记录超过预算。"));
        }
        let mut record: Value = serde_json::from_slice(&bytes)?;
        let digest = record
            .as_object_mut()
            .ok_or_else(|| Error::new("invalid_input", "电脑操作记录无效。"))?
            .remove("record_sha256");
        if digest != Some(json!(record_digest(&record)?))
            || record["version"] != 1
            || !matches!(
                record["state"].as_str(),
                Some("dispatching" | "succeeded" | "rejected" | "unknown")
            )
        {
            return Err(Error::new(
                "operation_invalid",
                "电脑操作记录完整性或状态无效，请保留记录。",
            ));
        }
        Ok(Some(record))
    }
    fn write(&self, file: &str, record: &Value) -> Result<()> {
        let mut saved = record.clone();
        saved["record_sha256"] = json!(record_digest(record)?);
        let bytes = serde_json::to_vec(&saved)?;
        if bytes.len() > 65536 {
            return Err(Error::new(
                "operation_budget_exceeded",
                "电脑操作回执超过预算。",
            ));
        }
        self.store.install(file, &bytes, false)
    }
    pub fn operation(&self, session: &str, key: &str) -> Result<Value> {
        let _lock = self.store.lock()?;
        let Some(mut record) = self.read(&self.file(session, key)?)? else {
            return Ok(json!({"state":"not_found","operation_key":key}));
        };
        self.check_owner(&record, session, key)?;
        if record["state"] == "dispatching" {
            record["state"] = json!("unknown");
        }
        Ok(record)
    }
    pub fn existing(&self, input: &Value) -> Result<Option<Value>> {
        let original = self.operation(
            input["session_id"].as_str().unwrap(),
            input["operation_key"].as_str().unwrap(),
        )?;
        if original["state"] == "not_found" {
            return Ok(None);
        }
        if original["request_sha256"] != record_digest(input)? {
            return Err(Error::new(
                "operation_conflict",
                "同一电脑operation_key不能更换输入。",
            ));
        }
        Ok(Some(original))
    }
    fn check_owner(&self, record: &Value, session: &str, key: &str) -> Result<()> {
        if record["client"] != self.client
            || record["session_id"] != session
            || record["operation_key"] != key
        {
            return Err(Error::new("forbidden", "原电脑操作不属于此客户端与会话。"));
        }
        Ok(())
    }
    #[cfg(test)]
    pub fn execute(
        &self,
        input: &Value,
        now: u64,
        target: &Value,
        run: impl FnOnce() -> Value,
    ) -> Result<Value> {
        self.execute_with_basis(input, now, target, None, run)
    }
    pub fn execute_with_basis(
        &self,
        input: &Value,
        now: u64,
        target: &Value,
        basis_time: Option<u64>,
        run: impl FnOnce() -> Value,
    ) -> Result<Value> {
        let session = input["session_id"].as_str().unwrap();
        let key = input["operation_key"].as_str().unwrap();
        let digest = record_digest(input)?;
        let file = self.file(session, key)?;
        // 跨客户端共用写锁，动作从持久意图到终态只允许一次派发。
        let _lock = self.store.lock()?;
        if let Some(mut original) = self.read(&file)? {
            self.check_owner(&original, session, key)?;
            if original["request_sha256"] != digest {
                return Err(Error::new(
                    "operation_conflict",
                    "同一电脑operation_key不能更换输入。",
                ));
            }
            if original["state"] == "dispatching" {
                original["state"] = json!("unknown");
            }
            return Ok(original);
        }
        let target_digest = record_digest(target)?;
        let controls = self.controls()?;
        if let Some(control) = controls.get(&target_digest) {
            if control["state"] == "taken_over" {
                return Err(Error::new(
                    "computer_taken_over",
                    "此窗口已交给作者，机器输入已冻结。",
                ));
            }
            if let Some(resumed) = control["resumed_at_ms"].as_u64() {
                crate::domain::ensure(
                    basis_time.is_some_and(|created| created > resumed),
                    "snapshot_stale",
                    "接管后请重新观察；旧快照不能恢复动作资格。",
                )?;
            }
        }
        let entries = self.store.entries("operations")?;
        if entries.len() >= 4096 {
            return Err(Error::new(
                "operation_budget_exceeded",
                "电脑操作账本达到预算，请保留原回执后维护。",
            ));
        }
        for leaf in entries {
            if !leaf.ends_with(".json") {
                continue;
            }
            if let Some(record) = self.read(&format!("operations/{leaf}"))?
                && record["target_sha256"] == target_digest
                && matches!(record["state"].as_str(), Some("unknown" | "dispatching"))
            {
                return Err(Error::new(
                    "target_outcome_unknown",
                    "原窗口存在未明确完成的电脑动作；只查询原操作，不换键继续输入。",
                ));
            }
        }
        let mut record = json!({"version":1,"client":self.client,"session_id":session,"operation_key":key,"request_sha256":digest,"target_sha256":target_digest,"target":target,"created_at_ms":now,"state":"dispatching"});
        self.write(&file, &record)?;
        let outcome = run();
        record["state"] = outcome["state"].clone();
        record["result"] = outcome["result"].clone();
        record["error"] = outcome["error"].clone();
        self.write(&file, &record).map_err(|_| {
            Error::new(
                "hetu.outcome_unknown",
                "电脑动作已派发但终态未能落盘；只查询原operation_key，不重发动作。",
            )
        })?;
        Ok(record)
    }
    fn controls(&self) -> Result<Value> {
        if !self.store.exists("controls.json")? {
            return Ok(json!({}));
        }
        let record = self.store.json("controls.json")?;
        crate::domain::ensure(
            record.is_object() && record.as_object().unwrap().len() <= 4096,
            "hetu.integrity_failure",
            "电脑输入权记录无效。",
        )?;
        Ok(record)
    }
    pub fn state(&self, target: &Value, session: &str) -> Result<Value> {
        let _lock = self.store.read_lock()?;
        let controls = self.controls()?;
        let record = &controls[record_digest(target)?];
        if record.is_null() {
            return Ok(json!({"state":"active","owned":false,"revision":0}));
        }
        Ok(
            json!({"state":record["state"],"revision":record["revision"],"owned":record["client"]==self.client&&record["session_id"]==session}),
        )
    }
    pub fn control(
        &self,
        input: &Value,
        target: &Value,
        basis_time: u64,
        now: u64,
    ) -> Result<Value> {
        let _lock = self.store.lock()?;
        self.store.recover()?;
        let session = input["session_id"].as_str().unwrap();
        let key = input["operation_key"].as_str().unwrap();
        let file = self.file(session, key)?;
        if let Some(record) = self.read(&file)? {
            self.check_owner(&record, session, key)?;
            crate::domain::ensure(
                record["request_sha256"] == record_digest(input)?,
                "operation_conflict",
                "原电脑操作键不能更换输入。",
            )?;
            return Ok(record);
        }
        let target_digest = record_digest(target)?;
        let mut controls = self.controls()?;
        let prior = &controls[&target_digest];
        let revision = prior["revision"]
            .as_u64()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| Error::new("hetu.budget_exceeded", "电脑控制代次已达上限。"))?;
        let result = if input["method"] == "takeover" {
            crate::domain::ensure(
                prior.is_null()
                    || prior["state"] != "taken_over"
                    || prior["client"] == self.client && prior["session_id"] == session,
                "forbidden",
                "窗口已由另一客户端接管。",
            )?;
            json!({"state":"taken_over","client":self.client,"session_id":session,"revision":revision,"taken_over_at_ms":now})
        } else {
            crate::domain::ensure(
                prior["state"] == "taken_over"
                    && prior["client"] == self.client
                    && prior["session_id"] == session,
                "forbidden",
                "恢复需要原接管会话。",
            )?;
            crate::domain::ensure(
                basis_time > prior["taken_over_at_ms"].as_u64().unwrap_or(now),
                "snapshot_stale",
                "恢复前请重新观察原窗口。",
            )?;
            json!({"state":"active","client":self.client,"session_id":session,"revision":revision,"resumed_at_ms":now})
        };
        controls[&target_digest] = result.clone();
        let record = json!({"version":1,"client":self.client,"session_id":session,"operation_key":key,"request_sha256":record_digest(input)?,"target_sha256":target_digest,"target":target,"created_at_ms":now,"state":"succeeded","result":result});
        let mut saved = record.clone();
        saved["record_sha256"] = json!(record_digest(&record)?);
        self.store.transaction(&std::collections::BTreeMap::from([
            ("controls.json".into(), serde_json::to_vec(&controls)?),
            (file, serde_json::to_vec(&saved)?),
        ]))?;
        Ok(record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn takeover_fences_other_clients_and_resume_needs_new_observation() {
        let directory = tempfile::tempdir().unwrap();
        let owner = ComputerOperations::open(directory.path(), "generic").unwrap();
        let other = ComputerOperations::open(directory.path(), "codex").unwrap();
        let target = json!({"pid":123,"launched_at_ms":1,"window_id":456});
        let take = json!({"method":"takeover","session_id":"test","operation_key":"take"});
        owner.control(&take, &target, 10, 20).unwrap();
        let action = json!({"method":"act","session_id":"other","operation_key":"action"});
        assert_eq!(
            other
                .execute_with_basis(&action, 25, &target, Some(24), || panic!(
                    "frozen window dispatched"
                ))
                .unwrap_err()
                .code,
            "computer_taken_over"
        );
        let resume = json!({"method":"resume","session_id":"test","operation_key":"resume"});
        assert_eq!(
            owner.control(&resume, &target, 10, 30).unwrap_err().code,
            "snapshot_stale"
        );
        owner.control(&resume, &target, 21, 30).unwrap();
        assert_eq!(
            other
                .execute_with_basis(&action, 35, &target, Some(21), || panic!(
                    "old observation dispatched"
                ))
                .unwrap_err()
                .code,
            "snapshot_stale"
        );
        let result = other
            .execute_with_basis(
                &action,
                35,
                &target,
                Some(31),
                || json!({"state":"succeeded","result":{"delivery":"fixture"}}),
            )
            .unwrap();
        assert_eq!(result["state"], "succeeded");
    }
    #[test]
    fn delivered_action_with_failed_final_persistence_remains_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let ops = ComputerOperations::open(dir.path(), "generic").unwrap();
        let root = dir.path().join("computer/actions");
        let directory = root.join("operations");
        let saved = root.join("saved-operations");
        let input = json!({"session_id":"s","operation_key":"one"});
        let error = ops
            .execute(&input, 1, &json!({"pid":7}), || {
                std::fs::rename(&directory, &saved).unwrap();
                std::fs::write(&directory, b"owned failure injection").unwrap();
                json!({"state":"succeeded","result":{"delivery":"event_posted"}})
            })
            .unwrap_err();
        assert_eq!(error.code, "hetu.outcome_unknown");
        std::fs::remove_file(&directory).unwrap();
        std::fs::rename(saved, directory).unwrap();
        assert_eq!(ops.operation("s", "one").unwrap()["state"], "unknown");
        assert_eq!(
            ops.execute(&input, 2, &json!({"pid":7}), || panic!("不得重发"))
                .unwrap()["state"],
            "unknown"
        );
    }
    #[test]
    fn once_only_unknown_target_fence_and_client_session_operation_identity() {
        let dir = tempfile::tempdir().unwrap();
        let ops = ComputerOperations::open(dir.path(), "generic").unwrap();
        let input =
            json!({"session_id":"s","operation_key":"one","text":"RAW_SECRET_NOT_TO_PERSIST"});
        let target = json!({"pid":7,"start":1,"window":3});
        let record = ops
            .execute(
                &input,
                1,
                &target,
                || json!({"state":"succeeded","result":{"delivery":"event_posted"}}),
            )
            .unwrap();
        assert_eq!(
            ops.execute(&input, 2, &target, || panic!("重复派发"))
                .unwrap(),
            record
        );
        assert!(
            !String::from_utf8(ops.store.read(&ops.file("s", "one").unwrap()).unwrap())
                .unwrap()
                .contains("RAW_SECRET")
        );
        let mut changed = input.clone();
        changed["text"] = json!("changed");
        assert!(ops.execute(&changed, 2, &target, || panic!()).is_err());
        assert_eq!(ops.operation("other", "one").unwrap()["state"], "not_found");
        let next = json!({"session_id":"s","operation_key":"two"});
        ops.execute(&next, 2, &target, || json!({"state":"unknown"}))
            .unwrap();
        assert_eq!(
            ops.execute(
                &json!({"session_id":"s","operation_key":"three"}),
                3,
                &target,
                || panic!()
            )
            .unwrap_err()
            .code,
            "target_outcome_unknown"
        );
        let other = ComputerOperations::open(dir.path(), "codex").unwrap();
        assert_eq!(other.operation("s", "one").unwrap()["state"], "not_found");
        assert_eq!(
            other
                .execute(
                    &json!({"session_id":"x","operation_key":"x"}),
                    3,
                    &target,
                    || panic!()
                )
                .unwrap_err()
                .code,
            "target_outcome_unknown"
        );
    }
    #[test]
    fn interrupted_intent_survives_restart_and_refuses_new_dispatch() {
        let dir = tempfile::tempdir().unwrap();
        let ops = ComputerOperations::open(dir.path(), "generic").unwrap();
        let target = json!({"window":3});
        let input = json!({"session_id":"s","operation_key":"one"});
        let file = ops.file("s", "one").unwrap();
        ops.write(&file,&json!({"version":1,"client":"generic","session_id":"s","operation_key":"one","request_sha256":record_digest(&input).unwrap(),"target_sha256":record_digest(&target).unwrap(),"state":"dispatching"})).unwrap();
        drop(ops);
        let ops = ComputerOperations::open(dir.path(), "generic").unwrap();
        assert_eq!(
            ops.execute(&input, 2, &target, || panic!()).unwrap()["state"],
            "unknown"
        );
        assert_eq!(
            ops.execute(
                &json!({"session_id":"s","operation_key":"two"}),
                2,
                &target,
                || panic!()
            )
            .unwrap_err()
            .code,
            "target_outcome_unknown"
        );
    }
}
