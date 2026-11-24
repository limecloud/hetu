//! 当前工作区的统一执行策略；Agent 身份、领域事务和原操作恢复分别保留。
use crate::{Kernel, Result, domain::{self, Error, checked_id, ensure}, infrastructure::store::Store, local_settings::LocalSettings};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::{Path, PathBuf}};

pub struct WorkspaceExecution {
    settings: LocalSettings,
    directory: PathBuf,
    client: String,
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().ok_or_else(|| Error::new("invalid_input", format!("缺少或无效字段：{key}")))
}
fn sha(value: &Value) -> Result<String> {Ok(domain::digest(serde_json_canonicalizer::to_vec(value)?))}
fn bytes(value: &Value) -> Result<Vec<u8>> {Ok(serde_json::to_vec(value)?)}
fn root(path: &Path) -> Result<PathBuf> {
    ensure(path.is_absolute(), "invalid_input", "当前工作区必须是绝对路径。")?;
    if path.exists() {return Ok(path.canonicalize()?);}
    let parent = path.parent().ok_or_else(|| Error::new("invalid_input", "工作区父目录无效。"))?.canonicalize()?;
    Ok(parent.join(path.file_name().ok_or_else(|| Error::new("invalid_input", "工作区名称无效。"))?))
}
fn is_read(command: &Value) -> Result<bool> {
    let action = text(command, "action")?;
    if action == "hetu.execution.initialize" {return Ok(false);}
    let descriptor = Kernel::execution_descriptor(action).ok_or_else(|| Error::new("hetu.capability_unavailable", "工作区动作不存在。"))?;
    ensure(descriptor["scopes"].as_array().is_none_or(|scopes| scopes.iter().any(|scope| scope == "workspace")),
        "invalid_input", "此动作不属于当前工作区。")?;
    ensure(command["contract_revision"] == descriptor["contract_revision"], "unsupported_version", "动作合同修订不一致。")?;
    crate::application::validate_action_input(action, &command["input"])?;
    Ok(read_only_effect(action, &descriptor["effect"], &command["input"]))
}
pub(crate) fn read_only_effect(action: &str, effect: &Value, input: &Value) -> bool {
    effect == "read"
        || matches!(action, "hetu.plot.extract" | "hetu.drama.compare") && input["save_result"] == false
        || action == "hetu.validation.run" && input["save_report"] == false
}
impl WorkspaceExecution {
    pub fn open_default(client: &str) -> Result<Self> {Self::open(&crate::local_settings::default_directory()?, client)}
    pub fn open(settings_directory: &Path, client: &str) -> Result<Self> {
        ensure(matches!(client, "codex" | "claude-code" | "workbuddy" | "generic"), "invalid_input", "客户端标识无效。")?;
        Ok(Self {settings: LocalSettings::open(settings_directory)?, directory: settings_directory.join("execution"), client: client.into()})
    }
    fn store(&self) -> Result<Store> {
        std::fs::create_dir_all(&self.directory)?;
        let store = Store::open(&self.directory)?;
        store.directory(".hetu/transactions")?; store.directory("plans")?; store.directory("operations")?;
        Ok(store)
    }
    fn apply(&self, path: &Path, command: Value) -> Result<Value> {
        if command["action"] == "hetu.execution.initialize" {
            let kernel = Kernel::open_execution(json!({"mode":"agent","workspace_path":path,"create":command["input"]["create"]}))?;
            return Ok(kernel.request(json!({"action":"hetu.workspaces.get","contract_revision":"1","input":{}})));
        }
        let kernel = Kernel::open_execution(json!({"mode":"agent","workspace_path":path}))?;
        Ok(kernel.request(command))
    }
    fn workspace_identity(path: &Path) -> Result<Value> {
        if !path.exists() || std::fs::read_dir(path)?.next().is_none() {return Ok(Value::Null);}
        let kernel = Kernel::open_execution(json!({"mode":"agent","workspace_path":path}))?;
        Ok(json!({"kind":kernel.scope_kind(),"id":kernel.scope()}))
    }
    /// CLI 的已选工作区与稳定入口的显式路径进入相同策略，不接收作者身份覆盖。
    pub fn request_workspace(&self, path: &Path, command: Value) -> Value {
        let action = command["action"].as_str().unwrap_or("hetu.request.invalid").to_owned();
        let result = self.settings.with_execution_policy(|mode, _revision| {
            let read = is_read(&command)?;
            ensure(read || mode == "auto", "hetu.execution_confirmation_required", "请将本次写入集中准备为执行计划，确认后连续执行。")?;
            self.apply(&root(path)?, command.clone())
        });
        result.unwrap_or_else(|error| domain::failure(&action, "collaboration", &error))
    }
    pub fn request(&self, request: Value) -> Value {
        let action = request["action"].as_str().unwrap_or("hetu.request.invalid").to_owned();
        let result = self.settings.with_execution_policy(|mode, revision| {
            ensure(matches!(action.as_str(),"hetu.execution.get_mode"|"hetu.execution.invoke"|"hetu.execution.initialize"|"hetu.execution.prepare"|"hetu.execution.record_confirmation"|"hetu.execution.execute"|"hetu.execution.get_plan"),"hetu.capability_unavailable","执行服务动作不存在。")?;
            crate::application::validate_action_input(&action, &request["input"])?;
            ensure(request["contract_revision"] == "1", "unsupported_version", "执行合同修订不受支持。")?;
            self.execute(&action, &request["input"], mode, revision)
        });
        match result {Ok(value) => {
            let failure = if action == "hetu.execution.execute" && value["state"] == "blocked" {Some(value["last_error"].clone())}
                else if value["result"]["status"].as_str().is_some_and(|status| !matches!(status,"succeeded"|"partial"|"pending")) {Some(value["result"].clone())} else {None};
            if let Some(mut failure) = failure {
                failure["action"] = json!(action);
                if value["plan_id"].is_string() {failure["error"]["resolution"] = json!({"kind":"recover","action":"hetu.execution.get_plan","input":{"plan_ref":{"plan_id":value["plan_id"],"sha256":value["sha256"]}},"retry":"query_original"});}
                return failure;
            }
            domain::success(&action, "collaboration", value)
        }, Err(error) => domain::failure(&action, "collaboration", &error)}
    }
    fn read_plan(&self, store: &Store, reference: &Value) -> Result<Value> {
        let id = checked_id(text(reference, "plan_id")?, "execution")?;
        let plan = store.json(&format!("plans/{id}.json"))?;
        ensure(plan["sha256"] == sha(&plan["fixed"])? && plan["plan_id"] == id, "hetu.integrity_failure", "执行计划身份或摘要损坏。")?;
        ensure(plan["fixed"]["client_adapter"] == self.client && plan["sha256"] == reference["sha256"], "forbidden", "执行计划与当前客户端或固定摘要不一致。")?;
        Ok(plan)
    }
    fn persist(store: &Store, plan: &Value) -> Result<()> {
        store.transaction(&BTreeMap::from([(format!("plans/{}.json", text(plan, "plan_id")?), bytes(plan)?)]))
    }
    fn execute(&self, action: &str, input: &Value, mode: &str, revision: u64) -> Result<Value> {
        if action == "hetu.execution.get_mode" {return Ok(json!({"execution_mode":mode,"policy_revision":revision}));}
        if matches!(action, "hetu.execution.invoke" | "hetu.execution.initialize") {
            let command = if action.ends_with("initialize") {json!({"action":action,"contract_revision":"1","input":{"create":input["create"]}})} else {input["command"].clone()};
            let read = is_read(&command)?;
            ensure(read || mode == "auto", "hetu.execution_confirmation_required", "请集中准备本次写入，确认固定计划后执行。")?;
            return Ok(json!({"execution_mode":mode,"policy_revision":revision,"result":self.apply(&root(Path::new(text(input,"workspace_path")?))?,command)?}));
        }
        let store = self.store()?;
        let _lock = if action == "hetu.execution.get_plan" {store.read_lock()?} else {store.lock()?};
        if action != "hetu.execution.get_plan" {store.recover()?;}
        if action == "hetu.execution.prepare" {
            let path = root(Path::new(text(input, "workspace_path")?))?;
            let commands = input["commands"].as_array().ok_or_else(|| Error::new("invalid_input", "执行计划缺少动作。"))?;
            ensure(!commands.is_empty() && commands.len() <= 100 && bytes(input)?.len() <= 8 * 1024 * 1024, "invalid_input", "执行计划动作数量或大小无效。")?;
            let mut keys = std::collections::BTreeSet::new();
            for command in commands {
                if !is_read(command)? {
                    let key = if command["action"] == "hetu.execution.initialize" {text(&command["input"]["create"], "operation_key")?} else {text(&command["input"], "operation_key")?};
                    ensure(keys.insert(format!("{}:{key}",text(command,"action")?)), "invalid_input", "同一计划不能重复同一动作与操作键。")?;
                }
            }
            let receipt = format!("operations/{}.json",sha(&json!([self.client,text(input,"operation_key")?]))?);
            let digest = sha(input)?;
            if store.exists(&receipt)? {
                let previous = store.json(&receipt)?;
                ensure(previous["input_sha256"] == digest, "idempotency_conflict", "准备键已绑定其他执行计划。")?;
                return self.read_plan(&store,&previous["plan_ref"]);
            }
            let identity = Self::workspace_identity(&path)?;
            ensure(!identity.is_null() || commands.first().is_some_and(|command| command["action"] == "hetu.execution.initialize"), "not_found", "新工作区计划须先初始化明确目录。")?;
            let fixed = json!({"workspace_path":path,"workspace_identity":identity,"client_adapter":self.client,"policy_revision":revision,"execution_mode":mode,"summary":input["summary"],"commands":commands});
            let id = domain::id("execution"); let digest = sha(&fixed)?;
            let plan = json!({"plan_id":id,"sha256":digest,"fixed":fixed,"state":"prepared","results":[],"created_at":domain::now()});
            store.transaction(&BTreeMap::from([
                (format!("plans/{id}.json"),bytes(&plan)?),
                (receipt,bytes(&json!({"input_sha256":sha(input)?,"plan_ref":{"plan_id":id,"sha256":digest}}))?),
            ]))?;
            return Ok(plan);
        }
        let mut plan = self.read_plan(&store,&input["plan_ref"])?;
        if action == "hetu.execution.get_plan" {return Ok(plan);}
        if action == "hetu.execution.execute" && plan["state"] == "completed" {return Ok(plan);}
        ensure(plan["fixed"]["policy_revision"] == revision, "revision_conflict", "执行模式已切换，请重新准备本次变更。")?;
        if action == "hetu.execution.record_confirmation" {
            ensure(!text(input,"user_instruction")?.trim().is_empty(),"invalid_input","请记录本次集中确认的真实用户指令。")?;
            let fixed = json!({"decision":input["decision"],"user_instruction":input["user_instruction"],"operation_key":input["operation_key"]});
            if plan["confirmation"].is_object() {
                ensure(plan["confirmation"] == fixed, "idempotency_conflict", "计划已有不同的集中决定。")?; return Ok(plan);
            }
            ensure(plan["state"] == "prepared", "invalid_input", "已经开始的计划不能修改决定。")?;
            plan["confirmation"] = fixed;
            plan["state"] = json!(if input["decision"] == "confirm" {"confirmed"} else {"rejected"});
            Self::persist(&store,&plan)?; return Ok(plan);
        }
        ensure(action == "hetu.execution.execute", "hetu.capability_unavailable", "执行服务动作不存在。")?;
        ensure(plan["state"] != "rejected", "forbidden", "此执行计划已被拒绝。")?;
        ensure(mode == "auto" || plan["confirmation"]["decision"] == "confirm", "hetu.execution_confirmation_required", "请先集中确认本次固定变更。")?;
        plan["state"] = json!("executing"); Self::persist(&store,&plan)?;
        let commands = plan["fixed"]["commands"].as_array().unwrap().clone();
        let path = root(Path::new(text(&plan["fixed"],"workspace_path")?))?;
        for command in commands.iter().skip(plan["results"].as_array().unwrap().len()) {
            let expected_identity = plan.get("initialized_identity").unwrap_or(&plan["fixed"]["workspace_identity"]);
            let actual_identity = Self::workspace_identity(&path)?;
            ensure(expected_identity == &actual_identity || expected_identity.is_null() && command["action"] == "hetu.execution.initialize" && plan["results"].as_array().unwrap().is_empty(),
                "revision_conflict", "工作区身份已变化，请保留原计划并重新核对位置。")?;
            let result = self.apply(&path,command.clone()).unwrap_or_else(|error|domain::failure(command["action"].as_str().unwrap_or("hetu.request.invalid"),"collaboration",&error));
            if !matches!(result["status"].as_str(),Some("succeeded"|"partial")) {
                plan["state"] = json!("blocked"); plan["last_error"] = result; Self::persist(&store,&plan)?; return Ok(plan);
            }
            if command["action"] == "hetu.execution.initialize" {plan["initialized_identity"] = Self::workspace_identity(&path)?;}
            plan["results"].as_array_mut().unwrap().push(result); plan.as_object_mut().unwrap().remove("last_error"); Self::persist(&store,&plan)?;
        }
        plan["state"] = json!("completed"); Self::persist(&store,&plan)?; Ok(plan)
    }
}
