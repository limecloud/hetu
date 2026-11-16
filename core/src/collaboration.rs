//! 本机稳定入口只解析作者已登记的任务，不枚举书库或持有全局当前任务。
use crate::{
    Kernel,
    application::text,
    domain::{self, Error, Result, checked_id, digest, ensure},
    infrastructure::store::Store,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
pub(crate) mod authoring;
mod local;

pub struct CollaborationHub {
    directory: PathBuf,
    client: String,
}

/// 本机适配器持有的固定确认上下文，不进入工具参数或通用业务路由。
pub struct ModelPlanConfirmation {
    kernel: Kernel,
    record: Value,
    task_ref: Value,
    host: String,
    authorization: Option<Value>,
}
impl ModelPlanConfirmation {
    pub fn record(&self) -> &Value {
        &self.record
    }
    pub fn with_task_authorization(mut self, policy: Value) -> Result<Self> {
        let proposal = self
            .kernel
            .prepare_task_model_authorization(&self.record, policy)?;
        self.record["requested_authorization"] = proposal.clone();
        self.authorization = Some(proposal);
        Ok(self)
    }
    /// 适配器只能在宿主返回真实用户接受决定后调用；拒绝、取消和超时不得调用。
    pub fn confirm(self) -> Result<Value> {
        let mut record = if let Some(proposal) = self.authorization {
            self.kernel
                .confirm_task_model_authorization(&self.record, &proposal, &self.host)?
        } else {
            self.kernel
                .confirm_model_plan_from_host(&self.record, &self.host)?
        };
        record["task_ref"] = self.task_ref;
        Ok(domain::success(
            "hetu.model_tasks.get",
            self.kernel.scope(),
            record,
        ))
    }
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientRequest {
    pub directory: Option<PathBuf>,
    pub client_adapter: String,
    pub request: Value,
}
pub fn client_request(value: Value) -> Value {
    let action = value["request"]["action"]
        .as_str()
        .unwrap_or("hetu.request.invalid")
        .to_owned();
    let result = (|| -> Result<Value> {
        let input: ClientRequest = serde_json::from_value(value)?;
        let directory = input.directory.map(Ok).unwrap_or_else(default_directory)?;
        Ok(CollaborationHub::open(&directory, &input.client_adapter)?.request(input.request))
    })();
    result.unwrap_or_else(|error| domain::failure(&action, "collaboration", &error))
}

pub fn default_directory() -> Result<PathBuf> {
    #[cfg(windows)]
    let (variable, suffix) = ("LOCALAPPDATA", "Hetu/Collaboration");
    #[cfg(target_os = "macos")]
    let (variable, suffix) = ("HOME", "Library/Application Support/Hetu/Collaboration");
    #[cfg(all(unix, not(target_os = "macos")))]
    let (variable, suffix) = ("HOME", ".local/share/hetu/collaboration");
    let home = std::env::var_os(variable)
        .ok_or_else(|| Error::new("missing_context", "无法确定本机用户目录。"))?;
    Ok(PathBuf::from(home).join(suffix))
}

fn client_valid(client: &str) -> Result<()> {
    ensure(
        matches!(client, "codex" | "claude-code" | "workbuddy" | "generic"),
        "invalid_input",
        "客户端标识无效。",
    )
}
fn locator(reference: &Value) -> Result<Value> {
    let task = checked_id(text(reference, "task_id")?, "task")?;
    let scope = &reference["scope_ref"];
    let prefix = match scope["kind"].as_str() {
        Some("workspace") => "workspace",
        Some("creation_project") => "project",
        _ => return Err(Error::new("invalid_input", "任务范围类型无效。")),
    };
    checked_id(text(scope, "id")?, prefix)?;
    Ok(json!({"scope_ref":scope,"task_id":task}))
}
fn grant_path(client: &str, reference: &Value) -> Result<String> {
    Ok(format!(
        "grants/{}/{}.json",
        client,
        digest(serde_json_canonicalizer::to_vec(&locator(reference)?)?)
    ))
}
fn encoded(value: &Value) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(value)?)
}

impl CollaborationHub {
    pub fn prepare_model_confirmation(
        &self,
        reference: &Value,
        plan_id: &str,
    ) -> Result<ModelPlanConfirmation> {
        let store = Store::open(&self.directory)?;
        let grant = {
            let _guard = store.read_lock()?;
            store.json(&grant_path(&self.client, reference)?)?
        };
        let binding = json!({"directory":self.directory,"client_adapter":self.client,"task_locator":locator(reference)?,"grant_revision":grant["grant_revision"]});
        check_grant(
            &binding,
            text(&reference["scope_ref"], "id")?,
            reference["task_id"].as_str(),
        )?;
        let result = self.request(json!({"action":"hetu.model_tasks.get","contract_revision":"1","input":{"task_ref":reference,"plan_id":plan_id}}));
        ensure(
            result["status"] == "succeeded",
            "forbidden",
            result["error"]["message"]
                .as_str()
                .unwrap_or("无法读取固定模型计划。"),
        )?;
        let mut config =
            json!({"mode":"agent","task_id":reference["task_id"],"collaboration_grant":binding});
        config[if reference["scope_ref"]["kind"] == "workspace" {
            "workspace_path"
        } else {
            "creation_project_path"
        }] = grant["root"].clone();
        let kernel = Kernel::open(config)?;
        ensure(
            kernel.scope() == reference["scope_ref"]["id"].as_str().unwrap_or(""),
            "forbidden",
            "确认上下文不属于此作品。",
        )?;
        Ok(ModelPlanConfirmation {
            kernel,
            record: result["data"].clone(),
            task_ref: reference.clone(),
            host: self.client.clone(),
            authorization: None,
        })
    }
    pub fn open(directory: &Path, client: &str) -> Result<Self> {
        client_valid(client)?;
        ensure(
            directory.is_absolute(),
            "invalid_input",
            "本机接入目录必须为绝对路径。",
        )?;
        // 发现连接不创建数据目录；没有已批准任务也可正常启动。
        Ok(Self {
            directory: directory.to_owned(),
            client: client.to_owned(),
        })
    }
    pub fn catalog(&self) -> Value {
        let mut actions = Kernel::task_action_catalog();
        for action in actions.as_array_mut().unwrap() {
            let schema = &mut action["input_schema"];
            schema["properties"]["task_ref"] = task_ref_schema();
            if schema["$defs"].get("task_ref").is_some() {
                schema["$defs"]["task_ref"] = task_ref_schema();
            }
            let required = schema["required"].as_array_mut().unwrap();
            if !required.iter().any(|v| v == "task_ref") {
                required.push(json!("task_ref"));
            }
        }
        let list = actions.as_array_mut().unwrap();
        list.extend(
            Kernel::collaboration_action_catalog()
                .as_array()
                .unwrap()
                .iter()
                .cloned(),
        );
        authoring::extend_catalog(list);
        actions
    }
    pub fn request(&self, request: Value) -> Value {
        let action = request["action"]
            .as_str()
            .unwrap_or("hetu.request.invalid")
            .to_owned();
        match self.execute(&request) {
            Ok(value) => value,
            Err(error) => domain::failure(&action, "collaboration", &error),
        }
    }
    fn execute(&self, request: &Value) -> Result<Value> {
        domain::ensure(
            request["contract_revision"] == "1",
            "unsupported_version",
            "接入合同修订不受支持。",
        )?;
        let action = text(request, "action")?;
        let catalog = self.catalog();
        let metadata = catalog
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["name"] == action)
            .ok_or_else(|| Error::new("hetu.capability_unavailable", "稳定入口未开放该动作。"))?;
        let validator = jsonschema::validator_for(&metadata["input_schema"])
            .map_err(|_| Error::new("hetu.integrity_failure", "接入合同无效。"))?;
        if let Some(error) = validator.iter_errors(&request["input"]).next() {
            return Err(Error::new(
                "invalid_input",
                format!("接入参数不符合当前合同：{}", error.instance_path),
            ));
        }
        if action == "hetu.collaboration.inspect" {
            return Ok(domain::success(
                action,
                "collaboration",
                json!({"version":env!("CARGO_PKG_VERSION"),"client_adapter":self.client,"actions":catalog,"task_selection":"explicit_reference","capability_map_action":"hetu.capabilities.map"}),
            ));
        }
        if action == "hetu.collaboration.created_works" {
            return Ok(domain::success(
                action,
                "collaboration",
                self.created_works(&request["input"])?,
            ));
        }
        if action == "hetu.capabilities.map" {
            return Ok(domain::success(
                action,
                "local",
                crate::capability_map::read(&request["input"])?,
            ));
        }
        if action.starts_with("hetu.plugins.") {
            return Ok(domain::success(
                action,
                "local",
                crate::plugin_settings::request(&self.client, action, &request["input"])?,
            ));
        }
        if action.starts_with("hetu.model_settings.") {
            let data = crate::model_service::ModelService::open_default()?.machine_request(
                &self.client,
                action,
                &request["input"],
            )?;
            return Ok(domain::success(action, "local", data));
        }
        if action.starts_with("hetu.local_settings.") {
            return self.execute_local(request);
        }
        if action == "hetu.creation_projects.create"
            || request["input"].get("management_ref").is_some()
        {
            return self.execute_authoring(request);
        }
        let reference = if action == "hetu.collaboration.open" {
            &request["input"]["task_locator"]
        } else {
            &request["input"]["task_ref"]
        };
        let store = Store::open(&self.directory)
            .map_err(|_| Error::new("forbidden", "此客户端尚未获权访问该任务。"))?;
        // 先读私有映射；业务请求在作品锁内再次检查，保持锁顺序一致。
        let guard = store.read_lock()?;
        let path = grant_path(&self.client, reference)?;
        let grant = store
            .json(&path)
            .map_err(|_| Error::new("forbidden", "此客户端尚未获权访问该任务。"))?;
        ensure(
            grant["client_adapter"] == self.client
                && grant["task_locator"] == locator(reference)?
                && grant["revoked"] == false,
            "forbidden",
            "任务授权不可用或已撤销。",
        )?;
        if let Some(expires) = grant["expires_at"].as_i64() {
            ensure(
                time::OffsetDateTime::now_utc().unix_timestamp() < expires,
                "forbidden",
                "任务授权已过期。",
            )?;
        }
        drop(guard);
        let mut config = json!({"mode":"agent","task_id":reference["task_id"],"collaboration_grant":{"directory":self.directory,"client_adapter":self.client,"task_locator":locator(reference)?,"grant_revision":grant["grant_revision"]}});
        config[if reference["scope_ref"]["kind"] == "workspace" {
            "workspace_path"
        } else {
            "creation_project_path"
        }] = grant["root"].clone();
        let kernel = Kernel::open(config)?;
        ensure(
            kernel.scope() == reference["scope_ref"]["id"].as_str().unwrap(),
            "forbidden",
            "登记目录与任务身份不一致。",
        )?;
        let legacy_ref = json!({"scope_ref":reference["scope_ref"],"task_id":reference["task_id"],"request_revision":grant["request_revision"]});
        let mut opened = kernel.request(json!({"action":"hetu.creative_tasks.get","contract_revision":"1","input":{"task_ref":legacy_ref}}));
        if opened["status"] != "succeeded" {
            opened["action"] = json!(action);
            return Ok(opened);
        }
        ensure(
            opened["data"]["request_sha256"] == grant["request_sha256"],
            "hetu.stale_request",
            "请求已变化，请由作者确认当前授权。",
        )?;
        let task_ref = json!({"scope_ref":reference["scope_ref"],"task_id":reference["task_id"],"request_revision":grant["request_revision"],"sha256":grant["request_sha256"]});
        if action == "hetu.collaboration.open" {
            opened["action"] = json!(action);
            opened["data"]["task_ref"] = task_ref;
            opened["data"]["allowed_actions"] = self.allowed_actions(&kernel);
            return Ok(opened);
        }
        ensure(
            reference == &task_ref,
            "hetu.stale_request",
            "请使用打开任务返回的确切请求引用。",
        )?;
        let mut routed = request.clone();
        normalize_task_refs(&mut routed["input"], &task_ref, &legacy_ref)?;
        // 协作层检查完整引用；旧领域动作仍按其已发布的合同读取。
        let action_metadata = Kernel::task_action_catalog()
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["name"] == action)
            .cloned()
            .unwrap();
        if action_metadata["input_schema"]["properties"]
            .get("task_ref")
            .is_some()
        {
            routed["input"]["task_ref"] = legacy_ref;
        } else {
            routed["input"].as_object_mut().unwrap().remove("task_ref");
        }
        let mut result = kernel.request(routed);
        if action == "hetu.capabilities.get" && result["data"].is_object() {
            result["data"]["actions"] = self.allowed_actions(&kernel);
        }
        if result["data"].is_object() {
            result["data"]["task_ref"] = task_ref;
        }
        Ok(result)
    }
    fn allowed_actions(&self, kernel: &Kernel) -> Value {
        let actual = kernel
            .request(json!({"action":"hetu.capabilities.get","contract_revision":"1","input":{}}));
        json!(
            self.catalog()
                .as_array()
                .unwrap()
                .iter()
                .filter(
                    |action| actual["data"]["actions"]
                        .as_array()
                        .is_some_and(|actions| actions
                            .iter()
                            .any(|available| available["name"] == action["name"]))
                )
                .cloned()
                .map(|mut action| {
                    if action["authorization"] == "task_or_new_managed_scope" {
                        action["input_schema"] = action["input_schema"]["oneOf"][0].clone();
                        action["authorization"] = json!("task");
                    }
                    action
                })
                .collect::<Vec<_>>()
        )
    }
}

fn normalize_task_refs(value: &mut Value, expected: &Value, legacy: &Value) -> Result<()> {
    match value {
        Value::Object(fields) => {
            if let Some(reference) = fields.get_mut("task_ref") {
                ensure(
                    reference == expected,
                    "forbidden",
                    "嵌套成果引用不属于当前固定请求。",
                )?;
                *reference = legacy.clone();
            }
            for (key, field) in fields {
                if key != "task_ref" {
                    normalize_task_refs(field, expected, legacy)?;
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                normalize_task_refs(item, expected, legacy)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn check_grant(binding: &Value, scope_id: &str, task_id: Option<&str>) -> Result<()> {
    let client = text(binding, "client_adapter")?;
    client_valid(client)?;
    let reference = &binding["task_locator"];
    ensure(
        reference["scope_ref"]["id"] == scope_id && reference["task_id"].as_str() == task_id,
        "forbidden",
        "本机授权绑定不匹配。",
    )?;
    let store = Store::open(Path::new(text(binding, "directory")?))?;
    let _guard = store.read_lock()?;
    let grant = store.json(&grant_path(client, reference)?)?;
    ensure(
        grant["task_locator"] == *reference
            && grant["client_adapter"] == client
            && grant["grant_revision"] == binding["grant_revision"]
            && grant["revoked"] == false,
        "forbidden",
        "本机授权已撤销或变化，请重新打开任务。",
    )?;
    if let Some(expires) = grant["expires_at"].as_i64() {
        ensure(
            time::OffsetDateTime::now_utc().unix_timestamp() < expires,
            "forbidden",
            "本机授权已过期。",
        )?;
    }
    drop(_guard);
    if let Some(parent) = grant.get("management_binding") {
        authoring::check_management(parent, Path::new(text(&grant, "root")?), None)?;
    }
    Ok(())
}

pub fn locator_schema() -> Value {
    json!({"type":"object","additionalProperties":false,"required":["scope_ref","task_id"],"properties":{"scope_ref":{"type":"object","additionalProperties":false,"required":["kind","id"],"properties":{"kind":{"enum":["workspace","creation_project"]},"id":{"type":"string","maxLength":64}}},"task_id":{"type":"string","pattern":"^task_[0-9a-f-]{36}$"}}})
}
fn task_ref_schema() -> Value {
    let mut schema = locator_schema();
    schema["properties"]["request_revision"] = json!({"type":"integer","minimum":1});
    schema["properties"]["sha256"] = json!({"type":"string","pattern":"^[0-9a-f]{64}$"});
    schema["required"]
        .as_array_mut()
        .unwrap()
        .extend([json!("request_revision"), json!("sha256")]);
    schema
}

impl Kernel {
    pub(crate) fn authorize_collaboration(&self, input: &Value, revoke: bool) -> Result<Value> {
        ensure(
            self.is_author()
                || !revoke
                    && self.management_binding().is_some_and(|binding| {
                        binding["client_adapter"] == input["client_adapter"]
                    }),
            "forbidden",
            "只有作者可以登记或撤销任务授权。",
        )?;
        let client = text(input, "client_adapter")?;
        client_valid(client)?;
        let reference = &input["task_ref"];
        let task = self.requested_task_for_grant(reference)?;
        let directory = input["collaboration_path"]
            .as_str()
            .map(PathBuf::from)
            .map(Ok)
            .unwrap_or_else(default_directory)?;
        ensure(
            directory.is_absolute() && !directory.starts_with(self.root_path()),
            "hetu.unsafe_path",
            "本机授权目录必须位于作品目录之外。",
        )?;
        std::fs::create_dir_all(&directory)?;
        let directory = directory.canonicalize()?;
        ensure(
            !directory.starts_with(self.root_path()),
            "hetu.unsafe_path",
            "授权目录不能通过链接指向作品内部。",
        )?;
        let store = Store::open(&directory)?;
        store.directory(".hetu/transactions")?;
        store.directory(".hetu/operations")?;
        let _guard = store.lock()?;
        store.recover()?;
        let key = text(input, "operation_key")?;
        let operation = format!(
            ".hetu/operations/{}.json",
            digest(format!("{}\0{}\0{}\0{}", self.scope(), client, revoke, key))
        );
        let input_sha = digest(serde_json_canonicalizer::to_vec(input)?);
        if store.exists(&operation)? {
            let previous = store.json(&operation)?;
            ensure(
                previous["input_sha256"] == input_sha,
                "idempotency_conflict",
                "原授权操作键已绑定其他输入。",
            )?;
            return Ok(previous["result"].clone());
        }
        let path = grant_path(client, reference)?;
        let revision = if store.exists(&path)? {
            store.json(&path)?["grant_revision"]
                .as_u64()
                .unwrap_or(0)
                .checked_add(1)
                .ok_or_else(|| Error::new("hetu.budget_exceeded", "授权修订超过支持上限。"))?
        } else {
            1
        };
        let expires_at = input.get("expires_at").cloned().unwrap_or(Value::Null);
        if let Some(expires) = expires_at.as_i64() {
            ensure(
                expires > time::OffsetDateTime::now_utc().unix_timestamp(),
                "invalid_input",
                "授权到期时间必须晚于现在。",
            )?;
        }
        let mut grant = json!({"schema_version":"1.0.0","client_adapter":client,"task_locator":locator(reference)?,"root":self.root_path(),"request_revision":reference["request_revision"],"request_sha256":task["request_sha256"],"grant_revision":revision,"expires_at":expires_at,"revoked":revoke});
        if let Some(binding) = self.management_binding() {
            grant["management_binding"] = binding.clone();
        }
        let result = json!({"task_locator":locator(reference)?,"grant_revision":revision,"revoked":revoke,"request_sha256":task["request_sha256"]});
        store.transaction(&BTreeMap::from([
            (path, encoded(&grant)?),
            (
                operation,
                encoded(&json!({"input_sha256":input_sha,"result":result}))?,
            ),
        ]))?;
        Ok(result)
    }
}
