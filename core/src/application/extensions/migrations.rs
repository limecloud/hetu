//! 插件生成转换结果；可信宿主批准固定内容；Core只提交新修订。
use super::*;

fn fixed_sha(value: &Value) -> Result<String> {
    Ok(digest(serde_json_canonicalizer::to_vec(value)?))
}

fn plan_path(work: &Value, owner: &str, migration: &str) -> Result<String> {
    checked_id(migration, "migration")?;
    Ok(format!(
        ".hetu/extension-migrations/{}/{migration}.json",
        scope_key(work, owner)?
    ))
}
fn decision_path(grant: &Value, migration: &str) -> Result<String> {
    checked_id(migration, "migration")?;
    Ok(format!(
        "migration-decisions/{}/{migration}.json",
        text(grant, "grant_id")?
    ))
}
fn permitted_kind(grant: &Value, kind: &Value) -> Result<()> {
    ensure(
        grant["types"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["kind"] == *kind),
        "forbidden",
        "迁移对象类型不在当前插件授权内。",
    )
}

impl Kernel {
    fn read_extension_migration(
        &self,
        work: &Value,
        owner: &str,
        migration: &str,
    ) -> Result<Value> {
        let stored = self.store.json(&plan_path(work, owner, migration)?)?;
        let plan = &stored["plan"];
        ensure(
            plan["migration_id"] == migration
                && plan["work_ref"] == *work
                && plan["owner_plugin_id"] == owner
                && fixed_sha(plan)? == stored["plan_sha256"],
            "hetu.integrity_failure",
            "迁移方案身份或摘要不一致。",
        )?;
        Ok(stored)
    }

    fn migration_target<'a>(
        &self,
        grant: &'a Value,
        kind: &Value,
        version: &Value,
    ) -> Result<&'a Value> {
        grant["types"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["kind"] == *kind && t["schema_version"] == *version)
            .ok_or_else(|| Error::new("unsupported_version", "迁移目标Schema不在当前包授权内。"))
    }

    pub(super) fn approve_extension_migration(
        &self,
        directory: &Path,
        params: &Value,
    ) -> Result<Value> {
        closed(
            params,
            &["grant_id", "package_sha256", "migration_id", "plan_sha256"],
            &["conversation_decision", "operation_key"],
        )?;
        sha(text(params, "plan_sha256")?)?;
        let access = access_store(directory)?;
        // 与公开执行保持授权锁→作品锁的顺序，批准不执行作品变更。
        let _grant_guard = access.lock()?;
        access.recover()?;
        let grant = read_grant(&access, text(params, "grant_id")?)?;
        ensure(
            grant["revoked"] == false
                && grant["package_sha256"] == params["package_sha256"]
                && grant["root"]
                    == self
                        .workspace_path
                        .canonicalize()?
                        .to_string_lossy()
                        .as_ref()
                && grant["permissions"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("objects.write")),
            "forbidden",
            "迁移授权已撤销或不属于当前包与作品。",
        )?;
        if params["conversation_decision"].is_object() {
            let path = decision_path(&grant, text(params, "migration_id")?)?;
            if access.exists(&path)? {
                let original = access.json(&path)?;
                ensure(
                    original["plan_sha256"] == params["plan_sha256"]
                        && original["conversation_decision"] == params["conversation_decision"]
                        && original["operation_key"] == params["operation_key"],
                    "idempotency_conflict",
                    "迁移决定已固定其他输入；不能更换原方案。",
                )?;
                return Ok(
                    json!({"approved":true,"migration_id":params["migration_id"],"plan_sha256":params["plan_sha256"],"executed":false}),
                );
            }
        }
        let _guard = self.store.read_lock()?;
        ensure(
            digest(self.store.read(self.config_path())?) == self.config_sha,
            "revision_conflict",
            "工作区配置已变化，请重新打开。",
        )?;
        self.work_record(&grant["work_ref"], None)?;
        let stored = self.read_extension_migration(
            &grant["work_ref"],
            text(&grant, "plugin_id")?,
            text(params, "migration_id")?,
        )?;
        let plan = &stored["plan"];
        ensure(
            stored["plan_sha256"] == params["plan_sha256"]
                && plan["package_sha256"] == grant["package_sha256"],
            "hetu.stale_evidence",
            "迁移批准必须对应当前包的确切方案摘要。",
        )?;
        let target =
            self.migration_target(&grant, &plan["kind"], &plan["target_schema_version"])?;
        ensure(
            fixed_sha(&target["schema"])? == plan["target_schema_sha256"],
            "hetu.stale_evidence",
            "迁移目标Schema已变化。",
        )?;
        let (current, current_sha) = self.extension_object(
            &grant["work_ref"],
            text(&grant, "plugin_id")?,
            text(plan, "object_id")?,
            None,
        )?;
        ensure(
            current["revision"] == plan["before"]["object"]["revision"]
                && current_sha == plan["before"]["sha256"],
            "revision_conflict",
            "迁移对象已变化，请重新准备并审阅。",
        )?;
        let decision = json!({"grant_id":grant["grant_id"],"package_sha256":grant["package_sha256"],"plan_sha256":params["plan_sha256"],"approved_at":now(),"conversation_decision":params["conversation_decision"],"operation_key":params["operation_key"]});
        access.transaction(&Changes::from([(
            decision_path(&grant, text(params, "migration_id")?)?,
            bytes(&decision)?,
        )]))?;
        Ok(
            json!({"approved":true,"migration_id":params["migration_id"],"plan_sha256":params["plan_sha256"],"executed":false}),
        )
    }

    /// 调用方已核验授权并持有作品锁；每次最多提交一个对象。
    pub(super) fn extension_migration(
        &self,
        work: &Value,
        owner: &str,
        action: &str,
        input: &Value,
        grant: Option<&Value>,
        access: Option<&Store>,
    ) -> Result<Value> {
        if action == "hetu.extensions.migrations.list" {
            let root = format!(".hetu/extension-migrations/{}", scope_key(work, owner)?);
            let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize;
            let cursor = input.get("cursor").and_then(Value::as_str).unwrap_or("");
            let mut entries = match self.store.entries(&root) {
                Ok(entries) => entries,
                Err(e) if e.code == "not_found" => Vec::new(),
                Err(e) => return Err(e),
            };
            entries.sort();
            let mut plans = Vec::new();
            for entry in entries {
                let migration = entry
                    .strip_suffix(".json")
                    .ok_or_else(|| Error::new("hetu.integrity_failure", "迁移方案文件名无效。"))?;
                if migration <= cursor {
                    continue;
                }
                let stored = self.read_extension_migration(work, owner, migration)?;
                let plan = &stored["plan"];
                if grant.is_some_and(|g| permitted_kind(g, &plan["kind"]).is_err()) {
                    continue;
                }
                let operation =
                    self.store
                        .json(&operation_path(work, owner, text(plan, "operation_key")?)?)?;
                plans.push(json!({"migration_id":migration,"plan_sha256":stored["plan_sha256"],"object_id":plan["object_id"],"title":plan["before"]["object"]["title"],"from_schema_version":plan["before"]["object"]["schema_version"],"target_schema_version":plan["target_schema_version"],"state":operation["result"]["data"]["state"]}));
                if plans.len() > limit {
                    break;
                }
            }
            let more = plans.len() > limit;
            if more {
                plans.pop();
            }
            return Ok(domain::success(
                action,
                self.scope(),
                json!({"next_cursor":if more {plans.last().unwrap()["migration_id"].clone()} else {Value::Null},"migrations":plans}),
            ));
        }
        if action == "hetu.extensions.migrations.prepare" {
            return self.prepare_extension_migration(
                work,
                owner,
                input,
                grant.ok_or_else(|| Error::new("forbidden", "迁移需要精确插件授权。"))?,
            );
        }
        let stored = self.read_extension_migration(work, owner, text(input, "migration_id")?)?;
        let plan = &stored["plan"];
        if let Some(grant) = grant {
            permitted_kind(grant, &plan["kind"])?;
        }
        let op_path = operation_path(work, owner, text(plan, "operation_key")?)?;
        let operation = self.store.json(&op_path)?;
        ensure(
            operation["migration_id"] == plan["migration_id"]
                && operation["input_sha256"] == stored["input_sha256"],
            "hetu.integrity_failure",
            "迁移原操作与固定方案不一致。",
        )?;
        if action == "hetu.extensions.migrations.get" {
            let mut receipt = operation["result"].clone();
            // 固定方案只返回一次，避免合法的前后内容因重复包装越过传输预算。
            receipt["data"].as_object_mut().unwrap().remove("plan");
            return Ok(domain::success(
                action,
                self.scope(),
                json!({"plan":plan,"plan_sha256":stored["plan_sha256"],"result":receipt}),
            ));
        }
        ensure(
            action == "hetu.extensions.migrations.execute",
            "hetu.capability_unavailable",
            "未知迁移动作。",
        )?;
        let grant = grant.ok_or_else(|| Error::new("forbidden", "迁移需要精确插件授权。"))?;
        ensure(
            input["plan_sha256"] == stored["plan_sha256"]
                && input["operation_key"] == plan["operation_key"]
                && plan["package_sha256"] == grant["package_sha256"],
            "hetu.stale_evidence",
            "迁移必须保留固定方案、包摘要及原操作键。",
        )?;
        if operation["result"]["data"]["state"] == "executed" {
            return Ok(operation["result"].clone());
        }
        let target = self.migration_target(grant, &plan["kind"], &plan["target_schema_version"])?;
        ensure(
            fixed_sha(&target["schema"])? == plan["target_schema_sha256"],
            "hetu.stale_evidence",
            "迁移目标Schema已变化。",
        )?;
        schema(&plan["content"], &target["schema"])?;
        let access = access.ok_or_else(|| Error::new("forbidden", "缺少可信宿主的迁移决定。"))?;
        let path = decision_path(grant, text(plan, "migration_id")?)?;
        ensure(
            access.exists(&path)?,
            "permission_denied",
            "请先由作者审阅并批准固定迁移内容。",
        )?;
        let decision = access.json(&path)?;
        ensure(
            decision["grant_id"] == grant["grant_id"]
                && decision["package_sha256"] == grant["package_sha256"]
                && decision["plan_sha256"] == stored["plan_sha256"],
            "forbidden",
            "批准不属于此授权、包或迁移方案。",
        )?;
        let (mut record, before_sha) =
            self.extension_object(work, owner, text(plan, "object_id")?, None)?;
        ensure(
            record["revision"] == plan["before"]["object"]["revision"]
                && before_sha == plan["before"]["sha256"],
            "revision_conflict",
            "迁移对象已变化；旧批准不能覆盖新内容。",
        )?;
        self.advance_record(&mut record, &before_sha)?;
        record["schema_version"] = plan["target_schema_version"].clone();
        record["content"] = plan["content"].clone();
        record["package_sha256"] = grant["package_sha256"].clone();
        record["actor_ref"] = json!(owner);
        let mut changes = Changes::new();
        let sha = self.stage_versioned_record(
            &collection(work, owner)?,
            "object_id",
            &record,
            &mut changes,
        )?;
        let mut result = domain::success(
            action,
            self.scope(),
            json!({"object":record,"sha256":sha,"migration_id":plan["migration_id"],"plan_sha256":stored["plan_sha256"],"state":"executed"}),
        );
        result["operation"] =
            extension_operation(text(plan, "operation_key")?, text(&stored, "input_sha256")?);
        changes.insert(op_path, bytes(&json!({"migration_id":plan["migration_id"],"input_sha256":stored["input_sha256"],"result":result}))?);
        changes.insert(format!(".hetu/audit/{}.json", text(&result["operation"], "id")?), bytes(&json!({"action":action,"plugin_id":owner,"work_ref":work,"package_sha256":grant["package_sha256"],"migration_id":plan["migration_id"],"plan_sha256":stored["plan_sha256"],"created_at":now()}))?);
        self.stage_workspace_properties(&mut changes)?;
        self.store.transaction(&changes)?;
        Ok(result)
    }

    fn prepare_extension_migration(
        &self,
        work: &Value,
        owner: &str,
        input: &Value,
        grant: &Value,
    ) -> Result<Value> {
        let op_path = operation_path(work, owner, text(input, "operation_key")?)?;
        let input_sha = Self::input_digest(
            &json!({"action":"migrations.prepare","input":input,"package_sha256":grant["package_sha256"]}),
        )?;
        if self.store.exists(&op_path)? {
            let operation = self.store.json(&op_path)?;
            ensure(
                operation["input_sha256"] == input_sha,
                "idempotency_conflict",
                "原操作键已绑定其他输入。",
            )?;
            let data = &operation["result"]["data"];
            permitted_kind(
                grant,
                data["object"].get("kind").unwrap_or(&data["plan"]["kind"]),
            )?;
            return Ok(operation["result"].clone());
        }
        let (before, before_sha) =
            self.extension_object(work, owner, text(input, "object_id")?, None)?;
        ensure(
            before["revision"] == input["expected_revision"]
                && before_sha == input["expected_sha256"],
            "revision_conflict",
            "迁移对象已变化，请读取当前修订。",
        )?;
        let target =
            self.migration_target(grant, &before["kind"], &input["target_schema_version"])?;
        ensure(
            before["schema_version"] != input["target_schema_version"],
            "invalid_input",
            "同Schema版本内容修改应使用普通保存。",
        )?;
        schema(&input["content"], &target["schema"])?;
        ensure(
            bytes(&before)?.len() <= LIMIT / 4 && bytes(&input["content"])?.len() <= LIMIT / 4,
            "hetu.budget_exceeded",
            "迁移前后内容分别不得超过256KiB。",
        )?;
        let plan = json!({"migration_id":id("migration"),"work_ref":work,"owner_plugin_id":owner,"package_sha256":grant["package_sha256"],"kind":before["kind"],"object_id":before["object_id"],"before":{"object":before,"sha256":before_sha},"target_schema_version":input["target_schema_version"],"target_schema_sha256":fixed_sha(&target["schema"])? ,"content":input["content"],"operation_key":input["operation_key"],"created_at":now()});
        let plan_sha = fixed_sha(&plan)?;
        let mut result = domain::success(
            "hetu.extensions.migrations.prepare",
            self.scope(),
            json!({"plan":plan,"plan_sha256":plan_sha,"state":"prepared"}),
        );
        result["operation"] = extension_operation(text(input, "operation_key")?, &input_sha);
        let mut changes = Changes::new();
        changes.insert(
            plan_path(work, owner, text(&plan, "migration_id")?)?,
            bytes(&json!({"plan":plan,"plan_sha256":plan_sha,"input_sha256":input_sha}))?,
        );
        changes.insert(op_path, bytes(&json!({"migration_id":plan["migration_id"],"input_sha256":input_sha,"result":result}))?);
        self.store.transaction(&changes)?;
        Ok(result)
    }
}
