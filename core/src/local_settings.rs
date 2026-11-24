//! 新桌面的非敏感本机设置；公开机器入口与可信作者入口共享事务及恢复记录。
mod inspection;
mod reading;
mod suites;
#[cfg(test)]
mod tests_concurrency;

use crate::{
    Kernel,
    domain::{self, Error, Result, checked_id, ensure, id},
    infrastructure::store::Store,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub struct LocalSettings {
    store: Store,
}
const SETTINGS_VERSION: u64 = 5;

pub fn default_directory() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("HETU_LOCAL_SETTINGS_DIR") {
        let path = PathBuf::from(path);
        ensure(
            path.is_absolute(),
            "invalid_input",
            "本机设置目录必须为绝对路径。",
        )?;
        return Ok(path);
    }
    Ok(crate::collaboration::default_directory()?
        .parent()
        .ok_or_else(|| Error::new("missing_context", "无法确定本机设置目录。"))?
        .join("LocalSettings"))
}
fn hash(value: &Value) -> Result<String> {
    Ok(domain::digest(serde_json_canonicalizer::to_vec(value)?))
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .ok_or_else(|| Error::new("invalid_input", "本机操作字段格式无效。"))
}
fn closed(v: &Value, keys: &[&str]) -> Result<()> {
    ensure(
        v.as_object()
            .is_some_and(|o| o.keys().all(|k| keys.contains(&k.as_str()))),
        "invalid_input",
        "本机操作包含不支持的字段。",
    )
}
fn client_valid(client: &str) -> Result<()> {
    ensure(
        matches!(client, "codex" | "claude-code" | "workbuddy" | "generic"),
        "invalid_input",
        "客户端标识无效。",
    )
}
fn agent_session_defaults() -> Value {
    let catalog: Value = serde_json::from_str(include_str!("../../contracts/agent-session-defaults.json")).expect("会话默认档案必须是有效JSON");
    catalog["preferences"].clone()
}
fn defaults() -> Value {
    json!({"schema_version":SETTINGS_VERSION,"revision":1,"execution_policy_revision":1,"preferences":{
        "language":"zh-CN","appearance":"system","library_list":false,"autosave":true,
        "execution_mode":"auto",
        "agent_session":agent_session_defaults(),
        "reading_profiles":reading::profiles(),"document_theme":"system",
        "focus_paragraph":false,"typewriter_scroll":false,"smart_pairs":false,
        "git_author_name":"","git_author_email":"","agent_client":"codex"
    },"associations":{},"installations":{}})
}
fn validate_patch(patch: &Value) -> Result<()> {
    let catalog = Kernel::collaboration_action_catalog();
    let schema = &catalog
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["name"] == "hetu.local_settings.prepare")
        .unwrap()["input_schema"]["properties"]["patch"];
    let validator = jsonschema::validator_for(schema)
        .map_err(|_| Error::new("hetu.integrity_failure", "本机偏好合同无效。"))?;
    ensure(
        validator.is_valid(patch),
        "invalid_input",
        "偏好值不符合可交接设置合同。",
    )?;
    for key in ["git_author_name", "git_author_email"] {
        if let Some(s) = patch[key].as_str() {
            ensure(
                !s.contains(['\r', '\n', '\0']),
                "invalid_input",
                "提交身份不能含换行或空字符。",
            )?;
        }
    }
    Ok(())
}
fn validate_state(state: &Value, version: u64, expected_session: &Value) -> Result<()> {
    ensure(
        state["schema_version"] == version
            && state["revision"].as_u64().is_some_and(|n| n > 0)
            && state["execution_policy_revision"].as_u64().is_some_and(|n| n > 0)
            && state["associations"].is_object()
            && state["installations"].is_object(),
        "hetu.integrity_failure", "本机设置记录无效。",
    )?;
    validate_patch(&state["preferences"])?;
    reading::validate_complete(&state["preferences"])?;
    ensure(state["preferences"]["agent_session"].as_object().is_some_and(|fields| fields.len() == expected_session.as_object().unwrap().len()
        && expected_session.as_object().unwrap().keys().all(|key| fields.contains_key(key))), "hetu.integrity_failure", "会话偏好字段不完整。")?;
    ensure(state["preferences"].as_object().unwrap().len() == defaults()["preferences"].as_object().unwrap().len()
        && defaults()["preferences"].as_object().unwrap().keys().all(|key| state["preferences"].get(key).is_some()),
        "hetu.integrity_failure", "本机偏好字段不完整。")?;
    Ok(())
}
fn plan_path(operation_id: &str) -> Result<String> {
    checked_id(operation_id, "localop")?;
    Ok(format!("plans/{operation_id}.json"))
}
fn association_key(input: &Value) -> Result<String> {
    if let Some(reference) = input.get("work_ref") {
        ensure(
            input.get("workspace_id").is_none(),
            "invalid_input",
            "作品与旧工作区范围不能混用。",
        )?;
        let schema: Value =
            serde_json::from_str(include_str!("../../contracts/schemas/work.schema.json"))?;
        let validator = jsonschema::validator_for(&schema["$defs"]["work_ref"])
            .map_err(|_| Error::new("hetu.integrity_failure", "作品引用合同无效。"))?;
        ensure(
            validator.is_valid(reference),
            "invalid_input",
            "作品引用不符合设置合同。",
        )?;
        return Ok(format!("work:{}", hash(reference)?));
    }
    if let Some(workspace) = input.get("workspace_id") {
        checked_id(text(input, "workspace_id")?, "workspace")?;
        return Ok(workspace.as_str().unwrap().to_owned());
    }
    Ok("default".into())
}
fn association(state: &Value, input: &Value) -> Result<Value> {
    let key = association_key(input)?;
    Ok(state["associations"]
        .get(&key)
        .cloned()
        .unwrap_or(json!({"client":null,"suite":null})))
}

impl LocalSettings {
    pub fn open_default() -> Result<Self> {
        Self::open(&default_directory()?)
    }
    pub fn open(directory: &Path) -> Result<Self> {
        ensure(
            directory.is_absolute(),
            "invalid_input",
            "本机设置目录必须为绝对路径。",
        )?;
        std::fs::create_dir_all(directory)?;
        let store = Store::open(directory)?;
        store.directory(".hetu/transactions")?;
        store.directory("plans")?;
        let service = Self { store };
        {
            let _reader = service.store.read_lock()?;
            if service.store.exists("settings.json")?
                && service.store.json("settings.json")?["schema_version"] == SETTINGS_VERSION
            {
                service.state()?;
                return Ok(service);
            }
        }
        let _lock = service.store.lock()?;
        service.store.recover()?;
        if !service.store.exists("settings.json")? {
            service
                .store
                .install("settings.json", &serde_json::to_vec(&defaults())?, true)?;
        }
        let original = service.store.read("settings.json")?;
        let state: Value = serde_json::from_slice(&original)?;
        if state["schema_version"] == 1 || state["schema_version"] == 2 {
            let version = state["schema_version"].as_u64().unwrap();
            let mut legacy_defaults = defaults();
            legacy_defaults["preferences"].as_object_mut().unwrap().remove("agent_session");
            let mut next = if version == 1 { reading::migrate(state, legacy_defaults.clone())? } else {
                ensure(state["revision"].as_u64().is_some_and(|n| n > 0) && state["associations"].is_object() && state["installations"].is_object(),
                    "hetu.integrity_failure", "旧版本机设置记录无效，已保留原文件。")?;
                validate_patch(&state["preferences"])?; reading::validate_complete(&state["preferences"])?;
                let mut next = state;
                ensure(next["preferences"].as_object().is_some_and(|fields| fields.len() + 1 == legacy_defaults["preferences"].as_object().unwrap().len() && !fields.contains_key("execution_mode")
                    && legacy_defaults["preferences"].as_object().unwrap().keys().filter(|key| key.as_str() != "execution_mode").all(|key| fields.contains_key(key))),
                    "hetu.integrity_failure", "旧版本机偏好字段不完整，已保留原文件。")?;
                next["preferences"]["execution_mode"] = json!("auto");
                next["revision"] = json!(next["revision"].as_u64().unwrap().checked_add(1).ok_or_else(|| Error::new("hetu.budget_exceeded", "设置修订已达上限。"))?);
                next
            };
            next["schema_version"] = json!(3);
            next["execution_policy_revision"] = json!(1);
            let backup = format!("migrations/v{version}/settings.json");
            ensure(!service.store.exists(&backup)? || service.store.read(&backup)? == original,
                "revision_conflict", "旧版设置备份已存在不同内容，请保留原文件核对。")?;
            service.store.transaction(&BTreeMap::from([
                (backup, original),
                ("settings.json".into(), serde_json::to_vec(&next)?),
            ]))?;
        }
        let original = service.store.read("settings.json")?;
        let mut next: Value = serde_json::from_slice(&original)?;
        if next["schema_version"] == 3 {
            validate_patch(&next["preferences"])?;
            reading::validate_complete(&next["preferences"])?;
            ensure(next["preferences"].as_object().is_some_and(|fields| fields.len() + 1 == defaults()["preferences"].as_object().unwrap().len()
                && !fields.contains_key("agent_session") && defaults()["preferences"].as_object().unwrap().keys().filter(|key| key.as_str() != "agent_session").all(|key| fields.contains_key(key))),
                "hetu.integrity_failure", "旧版设置字段不完整，已保留原文件。")?;
            next["preferences"]["agent_session"] = agent_session_defaults();
            next["schema_version"] = json!(SETTINGS_VERSION);
            next["revision"] = json!(next["revision"].as_u64().ok_or_else(|| Error::new("hetu.integrity_failure", "旧版设置修订无效。"))?.checked_add(1).ok_or_else(|| Error::new("hetu.budget_exceeded", "设置修订已达上限。"))?);
            let backup = "migrations/v3/settings.json";
            ensure(!service.store.exists(backup)? || service.store.read(backup)? == original, "revision_conflict", "旧设置迁移记录已存在不同内容。")?;
            service.store.transaction(&BTreeMap::from([(backup.into(), original), ("settings.json".into(), serde_json::to_vec(&next)?)]))?;
        }
        if next["schema_version"] == 4 {
            let original = service.store.read("settings.json")?;
            let mut expected_session = agent_session_defaults();
            expected_session.as_object_mut().unwrap().remove("terminal_focus_on_hover");
            validate_state(&next, 4, &expected_session)?;
            next["preferences"]["agent_session"]["terminal_focus_on_hover"] = json!(false);
            next["schema_version"] = json!(SETTINGS_VERSION);
            next["revision"] = json!(next["revision"].as_u64().unwrap().checked_add(1)
                .ok_or_else(|| Error::new("hetu.budget_exceeded", "设置修订已达上限。"))?);
            let backup = "migrations/v4/settings.json";
            ensure(!service.store.exists(backup)? || service.store.read(backup)? == original,
                "revision_conflict", "旧设置迁移记录已存在不同内容。")?;
            service.store.transaction(&BTreeMap::from([(backup.into(), original), ("settings.json".into(), serde_json::to_vec(&next)?)]))?;
        }
        service.state()?;
        Ok(service)
    }
    fn state(&self) -> Result<Value> {
        let state = self.store.json("settings.json")?;
        validate_state(&state, SETTINGS_VERSION, &agent_session_defaults())?;
        Ok(state)
    }
    pub(crate) fn with_execution_policy<T>(&self, run: impl FnOnce(&str, u64) -> Result<T>) -> Result<T> {
        let _lock = self.store.read_lock()?;
        let state = self.state()?;
        run(text(&state["preferences"], "execution_mode")?, state["execution_policy_revision"].as_u64().unwrap())
    }
    fn advance_execution_policy(before: &Value, next: &mut Value) -> Result<()> {
        if before["preferences"]["execution_mode"] != next["preferences"]["execution_mode"] {
            next["execution_policy_revision"] = json!(before["execution_policy_revision"].as_u64().unwrap().checked_add(1)
                .ok_or_else(|| Error::new("hetu.budget_exceeded", "执行策略修订已达上限。"))?);
        }
        Ok(())
    }
    fn plan(&self, operation_id: &str) -> Result<Value> {
        let plan = self.store.json(&plan_path(operation_id)?)?;
        ensure(
            plan["operation_id"] == operation_id
                && plan["sha256"] == hash(&plan["fixed"])?
                && plan["fixed"]["owner"] == "hetu.local-settings.v1"
                && plan["revision"].as_u64().is_some_and(|r| r > 0)
                && matches!(
                    plan["state"].as_str(),
                    Some("pending" | "approved" | "rejected" | "executing" | "executed")
                ),
            "hetu.integrity_failure",
            "本机方案身份或摘要不一致。",
        )?;
        Ok(plan)
    }
    fn view(&self, mut plan: Value, state: &Value) -> Value {
        plan["is_current"] = json!(plan["fixed"]["before"] == *state);
        plan["is_expired"] = json!(
            plan["fixed"]["expires_at"].as_i64().unwrap_or(0)
                <= time::OffsetDateTime::now_utc().unix_timestamp()
        );
        plan
    }
    pub fn request(&self, client: &str, request: Value) -> Value {
        let action = request["action"]
            .as_str()
            .unwrap_or("hetu.request.invalid")
            .to_owned();
        match self.execute(client, &request) {
            Ok(data) => domain::success(&action, "collaboration", reading::projection(data)),
            Err(error) => {
                let mut result = domain::failure(&action, "collaboration", &error);
                if matches!(
                    error.code,
                    "result_unknown" | "hetu.recovery_required" | "revision_conflict"
                ) {
                    result["error"]["resolution"] =
                        json!({"kind":"recover","action":"hetu.local_settings.get_operation"});
                }
                result
            }
        }
    }
    fn execute(&self, client: &str, request: &Value) -> Result<Value> {
        client_valid(client)?;
        closed(request, &["action", "contract_revision", "input"])?;
        ensure(
            request["contract_revision"] == "1",
            "unsupported_version",
            "本机设置合同修订不受支持。",
        )?;
        let action = text(request, "action")?;
        let catalog = Kernel::collaboration_action_catalog();
        let meta = catalog
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["name"] == action && action.starts_with("hetu.local_settings."))
            .ok_or_else(|| Error::new("hetu.capability_unavailable", "未开放该本机动作。"))?;
        let validator = jsonschema::validator_for(&meta["input_schema"])
            .map_err(|_| Error::new("hetu.integrity_failure", "本机设置合同无效。"))?;
        let input = &request["input"];
        ensure(
            validator.is_valid(input),
            "invalid_input",
            "本机方案参数不符合当前合同。",
        )?;
        let _lock = self.store.lock()?;
        self.store.recover()?;
        let state = self.state()?;
        match action {
            "hetu.local_settings.get" => Ok(
                json!({"settings_revision":state["revision"],"preferences":state["preferences"],
                "association":association(&state,input)?,"workspace_id":input["workspace_id"],"work_ref":input["work_ref"],
                "suites":suites::catalog()["suites"],"skills":suites::catalog()["skills"],"categories":suites::catalog()["categories"],
                "installable_clients":suites::installable_clients(),"installations":state["installations"]}),
            ),
            "hetu.local_settings.inspect_suite" => inspection::inspect(&state, input),
            "hetu.local_settings.inspect_connection" => {
                ensure(input["agent_client"] == "codex", "hetu.capability_unavailable", "当前只提供Codex连接核对。")?;
                suites::inspect_connection(&state["installations"]["codex:machine-connection"])
            }
            "hetu.local_settings.prepare" => self.prepare(client, input, &state),
            "hetu.local_settings.get_operation" => {
                let plan = self.plan(text(input, "operation_id")?)?;
                ensure(
                    plan["fixed"]["client_adapter"] == client,
                    "forbidden",
                    "本机方案不属于当前客户端。",
                )?;
                Ok(self.view(plan, &state))
            }
            "hetu.local_settings.record_decision" => self.decide(&json!({"operation_id":input["operation_id"],"sha256":input["sha256"],"revision":input["revision"],"approve":input["decision"] == "approve","operation_key":input["operation_key"]}), &state, Some((client,text(input,"authorization_note")?))),
            "hetu.local_settings.execute" => self.commit(client, input, &state),
            _ => Err(Error::new(
                "hetu.capability_unavailable",
                "未开放该本机动作。",
            )),
        }
    }
    fn prepare(&self, client: &str, input: &Value, state: &Value) -> Result<Value> {
        let receipt = format!(
            "prepare/{}.json",
            hash(&json!([client, input["operation_key"]]))?
        );
        let request_sha = hash(input)?;
        if self.store.exists(&receipt)? {
            let prior = self.store.json(&receipt)?;
            ensure(
                prior["input_sha256"] == request_sha,
                "idempotency_conflict",
                "此本机准备键已用于不同输入。",
            )?;
            return Ok(self.view(self.plan(text(&prior, "operation_id")?)?, state));
        }
        let mut fixed = json!({"owner":"hetu.local-settings.v1","client_adapter":client,"kind":input["kind"],
            "summary":input["summary"],"before":state,"expires_at":time::OffsetDateTime::now_utc().unix_timestamp()+86400});
        if input["kind"] == "preferences" {
            closed(input, &["kind", "patch", "summary", "operation_key"])?;
            validate_patch(&input["patch"])?;
            reading::apply(&state["preferences"], &input["patch"])?;
            fixed["patch"] = input["patch"].clone();
        } else if input["kind"] == "agent_connection" {
            closed(input, &["kind", "agent_client", "summary", "operation_key"])?;
            ensure(input["agent_client"] == "codex", "hetu.capability_unavailable", "当前只提供Codex受管机器连接安装。")?;
            fixed["agent_client"] = json!("codex");
            fixed["suite"] = suites::connection_package()?;
            fixed["install_target"] = suites::target("codex")?;
        } else {
            ensure(
                input.get("patch").is_none(),
                "invalid_input",
                "套件选择不能混入偏好补丁。",
            )?;
            let selected = suites::inspect(text(input, "suite_id")?)?;
            fixed["suite"] = selected;
            fixed["agent_client"] = input["agent_client"].clone();
            ensure(
                fixed["agent_client"].is_string(),
                "invalid_input",
                "请指定套件接入客户端。",
            )?;
            fixed["workspace_id"] = input["workspace_id"].clone();
            if let Some(reference) = input.get("work_ref") {
                fixed["work_ref"] = reference.clone();
            }
            if let Some(workspace) = input["workspace_id"].as_str() {
                checked_id(workspace, "workspace")?;
            }
            fixed["association_before"] = association(state, input)?;
            fixed["install"] = input.get("install").cloned().unwrap_or(json!(false));
            if fixed["install"] == true {
                ensure(
                    matches!(fixed["agent_client"].as_str(), Some("codex" | "workbuddy")),
                    "hetu.capability_unavailable",
                    "当前客户端只支持选择与手动接入说明。",
                )?;
                fixed["install_target"] = suites::target(text(&fixed, "agent_client")?)?;
            }
        }
        let operation_id = id("localop");
        let plan = json!({"operation_id":operation_id,"sha256":hash(&fixed)?,"fixed":fixed,"state":"pending","revision":1,"created_at":domain::now()});
        let changes = BTreeMap::from([
            (plan_path(&operation_id)?, serde_json::to_vec(&plan)?),
            (
                receipt,
                serde_json::to_vec(
                    &json!({"input_sha256":request_sha,"operation_id":operation_id}),
                )?,
            ),
        ]);
        self.store.transaction(&changes)?;
        Ok(self.view(plan, state))
    }
    fn decide(
        &self,
        params: &Value,
        state: &Value,
        conversation: Option<(&str, &str)>,
    ) -> Result<Value> {
        closed(
            params,
            &[
                "operation_id",
                "sha256",
                "revision",
                "approve",
                "operation_key",
            ],
        )?;
        let operation_id = text(params, "operation_id")?;
        let mut plan = self.plan(operation_id)?;
        ensure(
            plan["sha256"] == params["sha256"],
            "revision_conflict",
            "本机方案摘要已变化。",
        )?;
        if let Some((client, note)) = conversation {
            ensure(
                plan["fixed"]["client_adapter"] == client && !note.trim().is_empty(),
                "forbidden",
                "本机会话决定须属于原客户端并记录真实用户指令。",
            )?;
        }
        let decision_sha = if conversation.is_some() {
            hash(&json!([params, conversation]))?
        } else {
            hash(params)?
        };
        let key = text(params, "operation_key")?;
        ensure(
            !key.is_empty() && key.len() <= 128 && params["approve"].is_boolean(),
            "invalid_input",
            "本机审核决定无效。",
        )?;
        let receipt = format!("decisions/{}.json", hash(&json!([operation_id, key]))?);
        if self.store.exists(&receipt)? {
            let prior = self.store.json(&receipt)?;
            ensure(
                prior["input_sha256"] == decision_sha,
                "idempotency_conflict",
                "本机审核键已用于不同决定。",
            )?;
            return Ok(prior["result"].clone());
        }
        ensure(
            plan["revision"] == params["revision"]
                && !matches!(plan["state"].as_str(), Some("executing" | "executed")),
            "revision_conflict",
            "方案状态已变化，请回读后审阅。",
        )?;
        if params["approve"] == true {
            ensure(
                plan["fixed"]["before"] == *state,
                "revision_conflict",
                "偏好基线已变化，请重新准备。",
            )?;
            ensure(
                plan["fixed"]["expires_at"].as_i64().unwrap_or(0)
                    > time::OffsetDateTime::now_utc().unix_timestamp(),
                "hetu.author_confirmation_required",
                "方案已过期。",
            )?;
            if plan["fixed"]["kind"] == "agent_suite" {
                ensure(
                    suites::inspect(text(&plan["fixed"]["suite"], "suite_id")?)?
                        == plan["fixed"]["suite"],
                    "revision_conflict",
                    "套件包已变化。",
                )?;
            }
        }
        plan["state"] = json!(if params["approve"] == true {
            "approved"
        } else {
            "rejected"
        });
        plan["revision"] = json!(plan["revision"].as_u64().unwrap() + 1);
        plan["decided_at"] = json!(domain::now());
        if let Some((client, note)) = conversation {
            plan["conversation_decision"] = json!({"confirmation_channel":"agent_conversation","client_adapter":client,"authorization_note":note,"decision":if params["approve"] == true {"approve"} else {"reject"},"recorded_at":domain::now()});
        }
        let result = self.view(plan.clone(), &state);
        self.store.transaction(&BTreeMap::from([
            (plan_path(operation_id)?, serde_json::to_vec(&plan)?),
            (
                receipt,
                serde_json::to_vec(&json!({"input_sha256":decision_sha,"result":result}))?,
            ),
        ]))?;
        Ok(result)
    }
    fn commit(&self, client: &str, input: &Value, state: &Value) -> Result<Value> {
        let operation_id = text(input, "operation_id")?;
        let mut plan = self.plan(operation_id)?;
        ensure(
            plan["fixed"]["client_adapter"] == client && plan["sha256"] == input["sha256"],
            "forbidden",
            "客户端或固定方案摘要不匹配。",
        )?;
        if plan["state"] == "executed" || plan["state"] == "executing" {
            ensure(
                plan["execute_key"] == input["operation_key"],
                "idempotency_conflict",
                "执行键与原操作不一致，请回读原方案。",
            )?;
            if plan["state"] == "executed" {
                return Ok(self.view(plan, state));
            }
        } else {
            ensure(
                plan["state"] == "approved" || state["preferences"]["execution_mode"] == "auto" && plan["state"] == "pending",
                "hetu.author_confirmation_required",
                "本机方案尚未获得作者批准。",
            )?;
            ensure(
                plan["fixed"]["expires_at"].as_i64().unwrap_or(0)
                    > time::OffsetDateTime::now_utc().unix_timestamp(),
                "hetu.author_confirmation_required",
                "本机方案已过期。",
            )?;
        }
        ensure(
            plan["fixed"]["before"] == *state,
            "revision_conflict",
            "本机设置已变化，请重新准备方案。",
        )?;
        let mut next = state.clone();
        if plan["fixed"]["kind"] == "preferences" {
            let patch = &plan["fixed"]["patch"];
            validate_patch(patch)?;
            next["preferences"] = reading::apply(&state["preferences"], patch)?;
        } else if plan["fixed"]["kind"] == "agent_connection" {
            let fixed = plan["fixed"].clone();
            let recovering = plan["state"] == "executing";
            ensure(suites::target("codex")? == fixed["install_target"], "revision_conflict", "Codex安装目标已变化，请保留原方案核对。")?;
            let installed = suites::install(&fixed["suite"], "codex", recovering, || {
                if !recovering {
                    plan["state"] = json!("executing");
                    plan["execute_key"] = input["operation_key"].clone();
                    self.store.install(&plan_path(operation_id)?, &serde_json::to_vec(&plan)?, false)?;
                }
                Ok(())
            })?;
            next["installations"]["codex:machine-connection"] = installed.clone();
            plan["installation"] = installed;
        } else {
            let fixed = plan["fixed"].clone();
            let recovering = plan["state"] == "executing";
            // Codex未知恢复只核对原固定登记与缓存，不要求当前随包仍是旧版。
            if !(recovering && fixed["agent_client"] == "codex") {
                ensure(
                    suites::inspect(text(&fixed["suite"], "suite_id")?)? == fixed["suite"],
                    "revision_conflict",
                    "所选套件字节或版本已变化，请重新准备。",
                )?;
            }
            if fixed["install"] == true {
                ensure(
                    suites::target(text(&fixed, "agent_client")?)? == fixed["install_target"],
                    "revision_conflict",
                    "安装目标或客户端入口已变化，请重新准备。",
                )?;
                let installed = suites::install(
                    &fixed["suite"],
                    text(&fixed, "agent_client")?,
                    recovering,
                    || {
                        if !recovering {
                            plan["state"] = json!("executing");
                            plan["execute_key"] = input["operation_key"].clone();
                            self.store.install(
                                &plan_path(operation_id)?,
                                &serde_json::to_vec(&plan)?,
                                false,
                            )?;
                        }
                        Ok(())
                    },
                )?;
                let key = format!(
                    "{}:{}",
                    text(&fixed, "agent_client")?,
                    text(&fixed["suite"], "suite_id")?
                );
                next["installations"][&key] = installed.clone();
                plan["installation"] = installed;
            }
            let mut scope = json!({});
            if !fixed["work_ref"].is_null() {
                scope["work_ref"] = fixed["work_ref"].clone();
            } else if !fixed["workspace_id"].is_null() {
                scope["workspace_id"] = fixed["workspace_id"].clone();
            }
            let key = association_key(&scope)?;
            next["associations"][&key] = json!({"client":fixed["agent_client"],"suite":fixed["suite"]["suite_id"],"work_ref":fixed["work_ref"]});
            if key == "default" {
                next["preferences"]["agent_client"] = fixed["agent_client"].clone();
            }
        }
        Self::advance_execution_policy(state, &mut next)?;
        next["revision"] = json!(state["revision"].as_u64().unwrap() + 1);
        plan["state"] = json!("executed");
        plan["revision"] = json!(plan["revision"].as_u64().unwrap() + 1);
        plan["execute_key"] = input["operation_key"].clone();
        plan["executed_at"] = json!(domain::now());
        plan["result"] = next["preferences"].clone();
        self.store.transaction(&BTreeMap::from([
            ("settings.json".into(), serde_json::to_vec(&next)?),
            (plan_path(operation_id)?, serde_json::to_vec(&plan)?),
        ]))?;
        Ok(self.view(plan, &next))
    }
    /// 仅私有 App Server 调用。不能从公开 CLI/MCP 转发到此入口。
    pub fn host(&self, input: Value) -> Result<Value> {
        self.host_inner(input).map(reading::projection)
    }
    fn host_inner(&self, input: Value) -> Result<Value> {
        closed(&input, &["method", "input"])?;
        let params = &input["input"];
        let method = text(&input, "method")?;
        let _lock = if matches!(method, "preferences" | "operation" | "get" | "inspect_suite" | "list") {
            self.store.read_lock()?
        } else {
            let lock = self.store.lock()?;
            self.store.recover()?;
            lock
        };
        let state = self.state()?;
        match method {
            "preferences" => {
                ensure(params == &json!({}), "invalid_input", "偏好读取参数无效。")?;
                Ok(json!({"revision":state["revision"],"preferences":state["preferences"]}))
            }
            "operation" => {
                closed(params, &["operation_id"])?;
                Ok(self.view(self.plan(text(params, "operation_id")?)?, &state))
            }
            "get" => {
                ensure(params == &json!({}), "invalid_input", "本机读取参数无效。")?;
                let catalog = suites::catalog();
                let mut result = state;
                result["suites"] = catalog["suites"].clone();
                result["installable_clients"] = suites::installable_clients();
                result["skills"] = catalog["skills"].clone();
                result["categories"] = catalog["categories"].clone();
                Ok(result)
            }
            "inspect_suite" => inspection::inspect(&state, params),
            "associate" | "package_directory" => {
                let package = input["method"] == "package_directory";
                let mut fields = vec![
                    "work_ref",
                    "expected_revision",
                    "agent_client",
                    "suite_id",
                    "operation_key",
                ];
                if package {
                    fields.push("directory");
                }
                closed(params, &fields)?;
                let scope_key = association_key(params)?;
                validate_patch(&json!({"agent_client":params["agent_client"]}))?;
                suites::inspect(text(params, "suite_id")?)?;
                let key = text(params, "operation_key")?;
                ensure(
                    !key.is_empty() && key.len() <= 128,
                    "invalid_input",
                    "本机操作键无效。",
                )?;
                let receipt = format!(
                    "associations/{}.json",
                    hash(&json!([input["method"], key]))?
                );
                if self.store.exists(&receipt)? {
                    let prior = self.store.json(&receipt)?;
                    ensure(
                        prior["input_sha256"] == hash(params)?,
                        "idempotency_conflict",
                        "原操作键已用于不同选择。",
                    )?;
                    return Ok(prior["result"].clone());
                }
                ensure(
                    state["revision"] == params["expected_revision"],
                    "revision_conflict",
                    "本机设置已变化，请刷新后选择。",
                )?;
                let mut next = state;
                if package {
                    if !params["directory"].is_null() {
                        inspection::validate_directory(
                            text(params, "directory")?,
                            text(params, "suite_id")?,
                        )?;
                    }
                    if next["package_directories"].is_null() {
                        next["package_directories"] = json!({});
                    }
                    let package_key = format!(
                        "{}:{}",
                        text(params, "agent_client")?,
                        text(params, "suite_id")?
                    );
                    next["package_directories"][package_key] = params["directory"].clone();
                } else {
                    if scope_key == "default" {
                        next["preferences"]["agent_client"] = params["agent_client"].clone();
                    }
                    next["associations"][scope_key] = json!({"client":params["agent_client"],"suite":params["suite_id"],"work_ref":params["work_ref"]});
                }
                next["revision"] = json!(next["revision"].as_u64().unwrap() + 1);
                self.store.transaction(&BTreeMap::from([
                    ("settings.json".into(), serde_json::to_vec(&next)?),
                    (
                        receipt,
                        serde_json::to_vec(&json!({"input_sha256":hash(params)?,"result":next}))?,
                    ),
                ]))?;
                Ok(next)
            }
            "list" => {
                closed(params, &["limit", "cursor"])?;
                let limit = params
                    .get("limit")
                    .map_or(Some(30), Value::as_u64)
                    .filter(|n| (1..=100).contains(n))
                    .ok_or_else(|| Error::new("invalid_input", "本机方案分页大小无效。"))?
                    as usize;
                let mut plans = Vec::new();
                for name in self.store.entries("plans")? {
                    ensure(
                        plans.len() < 10000,
                        "hetu.budget_exceeded",
                        "本机方案超过枚举预算。",
                    )?;
                    let operation_id = name.strip_suffix(".json").ok_or_else(|| {
                        Error::new("hetu.integrity_failure", "本机方案文件名无效。")
                    })?;
                    plans.push(self.plan(operation_id)?);
                }
                plans.sort_by(|a, b| {
                    b["created_at"]
                        .as_str()
                        .cmp(&a["created_at"].as_str())
                        .then_with(|| b["operation_id"].as_str().cmp(&a["operation_id"].as_str()))
                });
                let start = if let Some(cursor) = params["cursor"].as_str() {
                    plans
                        .iter()
                        .position(|p| p["operation_id"] == cursor)
                        .ok_or_else(|| Error::new("invalid_input", "本机方案游标无效。"))?
                        + 1
                } else {
                    ensure(
                        params.get("cursor").is_none(),
                        "invalid_input",
                        "本机方案游标无效。",
                    )?;
                    0
                };
                let selected: Vec<_> = plans
                    .iter()
                    .skip(start)
                    .take(limit)
                    .cloned()
                    .map(|p| self.view(p, &state))
                    .collect();
                let cursor = if start + selected.len() < plans.len() {
                    selected
                        .last()
                        .map(|p| p["operation_id"].clone())
                        .unwrap_or(Value::Null)
                } else {
                    Value::Null
                };
                Ok(json!({"operations":selected,"next_cursor":cursor}))
            }
            "decide" => self.decide(params, &state, None),
            "update" => {
                closed(params, &["expected_revision", "patch", "operation_key"])?;
                validate_patch(&params["patch"])?;
                let key = text(params, "operation_key")?;
                ensure(
                    !key.is_empty() && key.len() <= 128,
                    "invalid_input",
                    "本机操作键无效。",
                )?;
                let receipt = format!("manual/{}.json", hash(&json!(key))?);
                if self.store.exists(&receipt)? {
                    let previous = self.store.json(&receipt)?;
                    ensure(
                        previous["input_sha256"] == hash(params)?,
                        "idempotency_conflict",
                        "本机操作键已用于不同设置。",
                    )?;
                    return Ok(previous["result"].clone());
                }
                ensure(
                    state["revision"] == params["expected_revision"],
                    "revision_conflict",
                    "本机设置已变化，请刷新后修改。",
                )?;
                let mut next = state.clone();
                next["preferences"] = reading::apply(&next["preferences"], &params["patch"])?;
                Self::advance_execution_policy(&state, &mut next)?;
                next["revision"] = json!(next["revision"].as_u64().unwrap() + 1);
                self.store.transaction(&BTreeMap::from([
                    ("settings.json".into(), serde_json::to_vec(&next)?),
                    (
                        receipt,
                        serde_json::to_vec(&json!({"input_sha256":hash(params)?,"result":next}))?,
                    ),
                ]))?;
                Ok(next)
            }
            _ => Err(Error::new(
                "hetu.capability_unavailable",
                "未知本机作者用例。",
            )),
        }
    }
}
