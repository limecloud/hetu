//! 任务执行经过与业务回执分开；不保存参数正文，不把未观察终态当作未执行。
use super::*;
use std::time::Instant;

pub(in crate::application) struct Attempt<'a> {
    kernel: &'a Kernel,
    path: String,
    record: Value,
    started: Instant,
    finished: bool,
}

fn seal(record: &mut Value) -> Result<()> {
    record.as_object_mut().unwrap().remove("record_sha256");
    record["record_sha256"] = json!(digest(serde_json_canonicalizer::to_vec(record)?));
    Ok(())
}

impl Attempt<'_> {
    pub(in crate::application) fn finish(&mut self, result: &Value) -> Result<()> {
        self.kernel
            .store
            .matches_root(&self.kernel.workspace_path)?;
        let previous = self.kernel.store.json(&self.path)?;
        ensure(
            previous == self.record,
            "hetu.integrity_failure",
            "执行开始记录已变化，保留原操作回读。",
        )?;
        self.record["phase"] = json!("finished");
        self.record["status"] = result["status"].clone();
        self.record["ended_at"] = json!(now());
        self.record["elapsed_ms"] =
            json!(self.started.elapsed().as_millis().min(u64::MAX as u128) as u64);
        self.record["error_code"] = result["error"]["code"].clone();
        self.record["result_sha256"] = json!(digest(serde_json_canonicalizer::to_vec(result)?));
        self.record["operation_ref"] = result
            .get("operation")
            .map(|op| json!({"operation_id":op["id"],"input_digest":op["input_digest"]}))
            .unwrap_or(Value::Null);
        seal(&mut self.record)?;
        record_schema(&self.record, "execution_record")?;
        self.kernel
            .store
            .install(&self.path, &bytes(&self.record)?, false)?;
        self.finished = true;
        Ok(())
    }
}

impl Drop for Attempt<'_> {
    fn drop(&mut self) {
        // 进程崩溃也只留下started；读取时显示unknown，原操作可能已经完成。
        if !self.finished {
            let result = domain::failure(
                self.record["action"]
                    .as_str()
                    .unwrap_or("hetu.request.invalid"),
                self.kernel.scope(),
                &Error::new("result_unknown", "未观察到执行终态，请查询原操作。"),
            );
            let _ = self.finish(&result);
        }
    }
}

impl Kernel {
    fn execution_access_digest(&self) -> Result<String> {
        Ok(digest(serde_json_canonicalizer::to_vec(
            &json!({"actor":self.actor(),"task":self.task_id,
            "collaboration":self.collaboration_grant,"management":self.management_grant}),
        )?))
    }
    fn execution_directory(&self, reference: &Value) -> Result<String> {
        Ok(format!(
            ".hetu/audit/task-executions/{}/{}",
            checked_id(text(reference, "task_id")?, "task")?,
            self.execution_access_digest()?
        ))
    }
    pub(in crate::application) fn begin_task_attempt(
        &self,
        request: &Value,
    ) -> Result<Option<Attempt<'_>>> {
        let Some(action) = request["action"].as_str() else {
            return Ok(None);
        };
        // 恢复和诊断读取不依赖新的日志写入，目录查询也不会使自己的游标失效。
        if matches!(
            action,
            "hetu.operations.get"
                | "hetu.task_executions.list"
                | "hetu.task_executions.get"
                | "hetu.creative_tasks.assess"
                | "hetu.capabilities.get"
        ) {
            return Ok(None);
        }
        let Some(metadata) = catalog::descriptor(action) else {
            return Ok(None);
        };
        let bound_reference;
        let reference = if request["input"]["task_ref"].is_object() {
            &request["input"]["task_ref"]
        } else if TASK_ACTIONS.contains(&action) && self.task_id.is_some() {
            let task_id = self.task_id.as_ref().unwrap();
            let (task, _) = self.task_request(task_id)?;
            bound_reference = json!({"scope_ref":self.scope_ref(),"task_id":task_id,"request_revision":task["request_revision"]});
            &bound_reference
        } else {
            return Ok(None);
        };
        if !reference.is_object()
            || !self.action_available(metadata)
            || self.check_task_session().is_err()
            || self.check_work_access(action, &request["input"]).is_err()
        {
            return Ok(None);
        }
        let Ok((_, request_sha, _, _)) = self.task_for_reference(reference) else {
            return Ok(None);
        };
        self.store.matches_root(&self.workspace_path)?;
        let attempt_id = id("attempt");
        let path = format!(
            "{}/{}.json",
            self.execution_directory(reference)?,
            attempt_id
        );
        let input = &request["input"];
        let lookup = if metadata["effect"] != "read" {
            input["operation_key"]
                .as_str()
                .filter(|key| !key.is_empty() && key.len() <= 128)
                .map(|key| self.operation_record_path(action, key))
                .and_then(|path| path.rsplit('/').next().map(str::to_owned))
        } else {
            None
        };
        let plan_id = input["plan_id"].as_str().filter(|value| {
            action.starts_with("hetu.model_tasks.") && checked_id(value, "model").is_ok()
        });
        let mut record = json!({"schema_version":"1.0.0","attempt_id":attempt_id,"task_ref":reference,
            "request_sha256":request_sha,"access_digest":self.execution_access_digest()?,"action":action,
            "effect":metadata["effect"],"input_digest":Self::input_digest(input)?,"phase":"started","status":"unknown",
            "started_at":now(),"ended_at":null,"elapsed_ms":null,"error_code":null,"result_sha256":null,
            "operation_lookup":lookup,"operation_ref":null,"plan_id":plan_id});
        seal(&mut record)?;
        record_schema(&record, "execution_record")?;
        self.store.install(&path, &bytes(&record)?, true)?;
        Ok(Some(Attempt {
            kernel: self,
            path,
            record,
            started: Instant::now(),
            finished: false,
        }))
    }

    fn read_execution(&self, input: &Value, attempt_id: &str) -> Result<Value> {
        checked_id(attempt_id, "attempt")?;
        let (request, request_sha, _, _) = self.task_for_reference(&input["task_ref"])?;
        let path = format!(
            "{}/{}.json",
            self.execution_directory(&input["task_ref"])?,
            attempt_id
        );
        let raw = self.store.read(&path)?;
        let record: Value = serde_json::from_slice(&raw)?;
        record_schema(&record, "execution_record")?;
        let mut sealed = record.clone();
        seal(&mut sealed)?;
        ensure(
            sealed == record
                && record["task_ref"] == input["task_ref"]
                && record["request_sha256"] == request_sha
                && record["access_digest"] == self.execution_access_digest()?
                && record["attempt_id"] == attempt_id,
            "hetu.integrity_failure",
            "执行记录的身份、摘要或授权不一致。",
        )?;
        let mut view = json!({"attempt_ref":{"attempt_id":attempt_id,"sha256":digest(&raw)},"action":record["action"],
            "input_digest":record["input_digest"],"phase":record["phase"],"status":record["status"],"effect":record["effect"],
            "started_at":record["started_at"],"ended_at":record["ended_at"],"elapsed_ms":record["elapsed_ms"],
            "error_code":record["error_code"],"result_sha256":record["result_sha256"],"outcome_source":"execution_record"});
        if let Some(name) = record["operation_lookup"].as_str() {
            ensure(
                name.len() == 69
                    && name.ends_with(".json")
                    && name[..64]
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
                "hetu.integrity_failure",
                "执行记录的原操作索引无效。",
            )?;
            let operation_path = format!(".hetu/operations/{name}");
            if self.store.exists(&operation_path)? {
                let operation = self.store.json(&operation_path)?;
                self.check_operation_task(&operation)?;
                ensure(
                    operation["input_digest"] == record["input_digest"]
                        && operation["action"] == record["action"],
                    "hetu.integrity_failure",
                    "原操作与执行输入不一致。",
                )?;
                view["recovery"] = json!({"action":"hetu.operations.get","input":{"task_ref":input["task_ref"],
                    "operation_id":operation["operation_id"],"input_digest":operation["input_digest"]},"retry":"query_original"});
                if self.collaboration_grant.is_none() {
                    view["recovery"]["input"]
                        .as_object_mut()
                        .unwrap()
                        .remove("task_ref");
                }
                if record["status"] == "unknown" {
                    view["recorded_status"] = record["status"].clone();
                    view["status"] = operation["result"]["status"].clone();
                    view["outcome_source"] = json!("original_operation");
                }
            }
        }
        if let Some(plan_id) = record["plan_id"].as_str() {
            view["recovery"] = json!({"action":"hetu.model_tasks.get","input":{"task_ref":input["task_ref"],"plan_id":plan_id},"retry":"query_original"});
        }
        if view["status"] == "unknown" {
            view["warning"] = json!("terminal_outcome_not_observed_do_not_resend");
        }
        // request参与归属核验，不向日志输出原始请求或业务内容。
        ensure(
            request["task_id"] == input["task_ref"]["task_id"],
            "forbidden",
            "执行记录任务不一致。",
        )?;
        Ok(view)
    }
    pub(in crate::application) fn task_executions(
        &self,
        action: &str,
        input: &Value,
    ) -> Result<Value> {
        self.task_for_reference(&input["task_ref"])?;
        if action == "hetu.task_executions.get" {
            let view = self.read_execution(input, text(&input["attempt_ref"], "attempt_id")?)?;
            ensure(
                view["attempt_ref"]["sha256"] == input["attempt_ref"]["sha256"],
                "hetu.stale_evidence",
                "执行记录已完成或变化，请重新读取目录。",
            )?;
            return Ok(json!({"execution":view,"authority":"core_observed_execution"}));
        }
        let directory = self.execution_directory(&input["task_ref"])?;
        let names = match self.store.entries(&directory) {
            Ok(names) => names
                .into_iter()
                .filter(|name| name.ends_with(".json"))
                .collect::<Vec<_>>(),
            Err(error) if error.code == "not_found" => Vec::new(),
            Err(error) => return Err(error),
        };
        let fingerprint = digest(serde_json_canonicalizer::to_vec(
            &json!({"task":input["task_ref"],"access":self.execution_access_digest()?,
            "action":input["action"],"status":input["status"],"input_digest":input["input_digest"],"members":names}),
        )?);
        let mut offset = if let Some(cursor) = input["cursor"].as_str() {
            let (sha, at) = cursor
                .split_once(':')
                .ok_or_else(|| Error::new("cursor_invalid", "执行目录游标无效。"))?;
            let at = at
                .parse::<usize>()
                .map_err(|_| Error::new("cursor_invalid", "执行目录游标无效。"))?;
            ensure(
                sha == fingerprint && at > 0 && at <= names.len(),
                "cursor_invalid",
                "执行目录或筛选已变化，请重新查询。",
            )?;
            at
        } else {
            0
        };
        let limit = input["limit"].as_u64().unwrap_or(20) as usize;
        let mut rows = Vec::new();
        let mut scanned = 0;
        while offset < names.len() && rows.len() < limit && scanned < 200 {
            let attempt = names[offset].strip_suffix(".json").unwrap();
            let row = self.read_execution(input, attempt)?;
            offset += 1;
            scanned += 1;
            if ["action", "status", "input_digest"]
                .iter()
                .all(|key| input.get(*key).is_none_or(|value| value == &row[*key]))
            {
                rows.push(row);
            }
        }
        Ok(
            json!({"executions":rows,"scanned":scanned,"directory_members":names.len(),
            "next_cursor":(offset<names.len()).then(||format!("{fingerprint}:{offset}")),
            "authority":"core_observed_execution","snapshot_binding":"directory_membership_per_record_outcome",
            "limits":{"page":50,"scan_per_page":200},"semantic_result":"not_implied"}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(value: Value) -> Value {
        assert_eq!(value["status"], "succeeded", "{value}");
        value["data"].clone()
    }
    fn fixture() -> (tempfile::TempDir, Kernel, Value) {
        let root = tempfile::tempdir().unwrap();
        let author = Kernel::open(
            json!({"workspace_path":root.path().join("work"),"mode":"author",
            "create":{"title":"执行记录边界","locale":"zh-CN","operation_key":"create"}}),
        )
        .unwrap();
        let preview=ok(author.request(json!({"action":"hetu.creative_tasks.preview_prompt","contract_revision":"1","input":{
            "scope_ref":{"kind":"workspace","id":author.scope()},"task_kind":"book_profile","brief":"隔离测试",
            "input_refs":[],"client_adapter":"codex","language_tag":"zh-CN"}})));
        let mut prepare = preview["prepare_input"].clone();
        prepare["operation_key"] = json!("prepare");
        let task = ok(author.request(
            json!({"action":"hetu.creative_tasks.prepare","contract_revision":"1","input":prepare}),
        ));
        let agent=Kernel::open(json!({"workspace_path":root.path().join("work"),"mode":"agent","task_id":task["task_ref"]["task_id"]})).unwrap();
        (root, agent, task["task_ref"].clone())
    }
    fn copy(reference: &Value, key: &str) -> Value {
        json!({"action":"hetu.working_copies.create","contract_revision":"1","input":{"task_ref":reference,
            "artifact_kind":"synopsis","source_format":"plain","title":"执行边界","content":"只写一次。","base_refs":[],"operation_key":key}})
    }
    #[test]
    fn unfinished_attempt_preserves_unknown_and_recovers_an_already_committed_operation() {
        let (_root, k, t) = fixture();
        let pending = copy(&t, "not-executed");
        let attempt = k.begin_task_attempt(&pending).unwrap().unwrap();
        std::mem::forget(attempt); // 模拟执行开始记录已落盘、进程未写终态。
        let page = k
            .task_executions("hetu.task_executions.list", &json!({"task_ref":t}))
            .unwrap();
        assert_eq!(page["executions"][0]["status"], "unknown");
        assert_eq!(
            page["executions"][0]["warning"],
            "terminal_outcome_not_observed_do_not_resend"
        );
        let committed = copy(&t, "committed-before-disconnect");
        let attempt = k.begin_task_attempt(&committed).unwrap().unwrap();
        std::mem::forget(attempt);
        let original = ok(k.request_untracked(committed));
        let page = k
            .task_executions(
                "hetu.task_executions.list",
                &json!({"task_ref":t,"status":"succeeded"}),
            )
            .unwrap();
        assert_eq!(page["executions"].as_array().unwrap().len(), 1);
        let row = &page["executions"][0];
        assert_eq!(row["phase"], "started");
        assert_eq!(row["outcome_source"], "original_operation");
        let recovered=ok(k.request(json!({"action":row["recovery"]["action"],"contract_revision":"1","input":row["recovery"]["input"]})));
        assert_eq!(
            recovered["original_result"]["data"]["working_copy_ref"],
            original["working_copy_ref"]
        );
        assert_eq!(
            k.list_working_copies(&json!({"task_ref":t})).unwrap()["working_copies"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn journal_admission_failure_prevents_new_work_but_does_not_block_original_recovery() {
        let (root, k, t) = fixture();
        std::fs::write(
            root.path().join("work/.hetu/audit/task-executions"),
            b"invalid directory fixture",
        )
        .unwrap();
        let request = copy(&t, "blocked-by-journal");
        assert_ne!(k.request(request)["status"], "succeeded");
        assert_eq!(
            k.list_working_copies(&json!({"task_ref":t})).unwrap()["working_copies"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            k.request(
                json!({"action":"hetu.operations.get","contract_revision":"1","input":{
            "action":"hetu.working_copies.create","key":"blocked-by-journal"}})
            )["error"]["code"],
            "not_found"
        );
    }
}
