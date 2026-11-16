//! 插件只持有精确作品、包摘要和专业数据权限；不暴露作者 Kernel。
use super::*;
use std::path::{Path, PathBuf};

const LIMIT: usize = 1024 * 1024;
mod index;
mod migrations;
mod open;

fn data_write(action: &str) -> bool {
    action_catalog()["actions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| {
            a["name"] == action && (a["effect"] == "managed_write" || a["effect"] == "cache_write")
        })
}
fn action_allowed(grant: &Value, action: &str) -> bool {
    action_catalog()["actions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["name"] == action)
        .is_some_and(|a| {
            a["required_permissions"]
                .as_array()
                .is_some_and(|permissions| {
                    permissions
                        .iter()
                        .all(|p| grant["permissions"].as_array().unwrap().contains(p))
                })
        })
}
fn extension_operation(key: &str, input_sha: &str) -> Value {
    let mut operation = Kernel::operation(key, input_sha);
    operation["recover_action"] = json!("hetu.extensions.operations.get");
    operation
}

pub fn action_catalog() -> Value {
    serde_json::from_str(include_str!("../../../contracts/extensions/actions.json"))
        .expect("embedded extension catalog")
}
fn validate_data_input(action: &str, input: &Value) -> Result<()> {
    let catalog = action_catalog();
    let metadata = catalog["actions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["name"] == action)
        .ok_or_else(|| Error::new("hetu.capability_unavailable", "未知插件数据动作。"))?;
    let mut definition = metadata["input_schema"].clone();
    definition["properties"]["work_ref"] = works::definition("work_ref");
    definition["required"]
        .as_array_mut()
        .unwrap()
        .push(json!("work_ref"));
    schema(input, &definition)
}

pub fn access_directory() -> Result<PathBuf> {
    if let Some(directory) = std::env::var_os("HETU_PLUGIN_ACCESS_DIR") {
        let path = PathBuf::from(directory);
        ensure(
            path.is_absolute(),
            "invalid_input",
            "插件授权目录必须为绝对路径。",
        )?;
        return Ok(path);
    }
    Ok(crate::collaboration::default_directory()?
        .parent()
        .ok_or_else(|| Error::new("missing_context", "无法确定插件授权目录。"))?
        .join("PluginAccess"))
}
fn access_store(directory: &Path) -> Result<Store> {
    ensure(
        directory.is_absolute(),
        "invalid_input",
        "授权目录必须为绝对路径。",
    )?;
    std::fs::create_dir_all(directory)?;
    let store = Store::open(directory)?;
    store.directory(".hetu/transactions")?;
    Ok(store)
}
fn plugin_id(value: &str) -> Result<()> {
    ensure(
        value.len() <= 120
            && value.split('.').count() >= 2
            && value.split('.').all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            }),
        "invalid_input",
        "插件标识须为规范反向域名。",
    )
}
fn sha(value: &str) -> Result<()> {
    ensure(
        value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "invalid_input",
        "摘要格式无效。",
    )
}
fn grant_path(grant_id: &str) -> Result<String> {
    checked_id(grant_id, "grant")?;
    Ok(format!("grants/{grant_id}.json"))
}
fn read_grant(access: &Store, grant_id: &str) -> Result<Value> {
    let grant = access.json(&grant_path(grant_id)?)?;
    let valid = (|| -> Result<()> {
        closed(
            &grant,
            &[
                "grant_id",
                "root",
                "work_ref",
                "plugin_id",
                "package_sha256",
                "permissions",
                "types",
                "revoked",
                "created_at",
            ],
            &["conversation_decision"],
        )?;
        ensure(
            grant["grant_id"] == grant_id && grant["revoked"].is_boolean(),
            "invalid_input",
            "授权记录身份无效。",
        )?;
        ensure(
            Path::new(text(&grant, "root")?).is_absolute(),
            "invalid_input",
            "授权根目录无效。",
        )?;
        schema(&grant["work_ref"], &works::definition("work_ref"))?;
        plugin_id(text(&grant, "plugin_id")?)?;
        sha(text(&grant, "package_sha256")?)?;
        let permissions = grant["permissions"]
            .as_array()
            .ok_or_else(|| Error::new("invalid_input", "授权权限无效。"))?;
        ensure(
            permissions.len() <= 3
                && permissions
                    .iter()
                    .all(|p| p == "objects.read" || p == "objects.write" || p == "work.read"),
            "invalid_input",
            "授权权限无效。",
        )?;
        let types = grant["types"]
            .as_array()
            .ok_or_else(|| Error::new("invalid_input", "授权类型无效。"))?;
        ensure(
            (!permissions.iter().any(|p| p == "objects.read" || p == "objects.write") || !types.is_empty()) && types.len() <= 16,
            "invalid_input",
            "授权类型无效。",
        )?;
        let mut seen = std::collections::BTreeSet::new();
        for kind in types {
            closed(kind, &["kind", "schema_version", "schema"], &[])?;
            ensure(
                seen.insert(text(kind, "kind")?)
                    && !text(kind, "kind")?.is_empty()
                    && text(kind, "kind")?.len() <= 120
                    && !text(kind, "schema_version")?.is_empty()
                    && kind["schema"].is_object(),
                "invalid_input",
                "授权类型无效。",
            )?;
        }
        Ok(())
    })();
    valid.map_err(|_| {
        Error::new(
            "hetu.integrity_failure",
            "插件授权记录损坏，请通过可信宿主重新授权。",
        )
    })?;
    Ok(grant)
}
fn check_parent_grant(grant: &Value) -> Result<()> {
    if grant["conversation_decision"].is_object() {
        crate::collaboration::authoring::check_management(
            &grant["conversation_decision"]["management_binding"],
            Path::new(text(grant, "root")?),
            None,
        )?;
    }
    Ok(())
}
fn request_schema(value: &Value) -> Result<()> {
    schema(
        value,
        &json!({"type":"object","additionalProperties":false,"required":["action","contract_revision","input"],"properties":{
        "action":{"type":"string"},"contract_revision":{"const":"1"},"input":{"type":"object"}}}),
    )
}
fn scope_key(work: &Value, owner: &str) -> Result<String> {
    Ok(digest(serde_json_canonicalizer::to_vec(
        &json!({"work_ref":work,"plugin_id":owner}),
    )?))
}
fn collection(work: &Value, owner: &str) -> Result<String> {
    Ok(format!("extensions/objects/{}", scope_key(work, owner)?))
}
fn operation_path(work: &Value, owner: &str, key: &str) -> Result<String> {
    ensure(
        !key.is_empty() && key.len() <= 200,
        "invalid_input",
        "操作键长度无效。",
    )?;
    Ok(format!(
        ".hetu/extension-operations/{}/{}.json",
        scope_key(work, owner)?,
        digest(key.as_bytes())
    ))
}
fn closed(input: &Value, required: &[&str], optional: &[&str]) -> Result<()> {
    let fields = input
        .as_object()
        .ok_or_else(|| Error::new("invalid_input", "参数必须为对象。"))?;
    ensure(
        required.iter().all(|key| fields.contains_key(*key))
            && fields
                .keys()
                .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str())),
        "invalid_input",
        "插件参数缺失或含未知字段。",
    )
}

pub struct PluginSession {
    kernel: Kernel,
    directory: PathBuf,
    grant_id: String,
    package_sha256: String,
}
impl PluginSession {
    pub fn open(
        workspace: &Path,
        directory: &Path,
        grant_id: &str,
        package_sha256: &str,
    ) -> Result<Self> {
        sha(package_sha256)?;
        let access = access_store(directory)?;
        let _guard = access.read_lock()?;
        let grant = read_grant(&access, grant_id)?;
        check_parent_grant(&grant)?;
        ensure(
            grant["revoked"] == false
                && grant["package_sha256"] == package_sha256
                && grant["root"] == workspace.canonicalize()?.to_string_lossy().as_ref(),
            "forbidden",
            "插件授权不存在、已撤销或不属于此包及作品。",
        )?;
        let kernel = Kernel::open(json!({"workspace_path":workspace,"mode":"author"}))?;
        ensure(
            grant["work_ref"]["workspace_id"] == kernel.scope(),
            "forbidden",
            "插件授权不属于此工作区。",
        )?;
        Ok(Self {
            kernel,
            directory: directory.into(),
            grant_id: grant_id.into(),
            package_sha256: package_sha256.into(),
        })
    }
    pub fn inspect(&self) -> Value {
        let result = (|| -> Result<Value> {
            let access = access_store(&self.directory)?;
            let _guard = access.read_lock()?;
            let grant = read_grant(&access, &self.grant_id)?;
            check_parent_grant(&grant)?;
            ensure(
                grant["revoked"] == false
                    && grant["package_sha256"] == self.package_sha256
                    && grant["root"]
                        == self
                            .kernel
                            .workspace_path
                            .canonicalize()?
                            .to_string_lossy()
                            .as_ref()
                    && grant["work_ref"]["workspace_id"] == self.kernel.scope(),
                "forbidden",
                "插件授权已撤销。",
            )?;
            let _workspace_guard = self.kernel.store.read_lock()?;
            ensure(
                digest(self.kernel.store.read(self.kernel.config_path())?)
                    == self.kernel.config_sha,
                "revision_conflict",
                "工作区配置已变化，请重新打开。",
            )?;
            self.kernel.work_record(&grant["work_ref"], None)?;
            Ok(domain::success(
                "hetu.extensions.catalog.get",
                self.kernel.scope(),
                json!({"plugin_id":grant["plugin_id"],"work_ref":grant["work_ref"],"package_sha256":grant["package_sha256"],"types":grant["types"],"permissions":grant["permissions"],"host_api":"1","actions":action_catalog()["actions"].as_array().unwrap().iter().filter(|a|action_allowed(&grant,a["name"].as_str().unwrap())).cloned().collect::<Vec<_>>()}),
            ))
        })();
        result.unwrap_or_else(|e| {
            domain::failure("hetu.extensions.catalog.get", self.kernel.scope(), &e)
        })
    }
    pub fn request(&self, request: Value) -> Value {
        let action = request["action"]
            .as_str()
            .unwrap_or("hetu.request.invalid")
            .to_owned();
        self.execute(&request)
            .unwrap_or_else(|e| domain::failure(&action, self.kernel.scope(), &e))
    }
    fn execute(&self, request: &Value) -> Result<Value> {
        request_schema(request)?;
        ensure(
            bytes(request)?.len() <= LIMIT,
            "hetu.budget_exceeded",
            "插件消息超过1MiB。",
        )?;
        let access = access_store(&self.directory)?;
        // 撤权与本次作品事务按同一授权锁串行；撤权完成后旧会话不能继续提交。
        let _grant_guard = access.read_lock()?;
        let grant = read_grant(&access, &self.grant_id)?;
        check_parent_grant(&grant)?;
        ensure(
            grant["revoked"] == false
                && grant["package_sha256"] == self.package_sha256
                && grant["root"]
                    == self
                        .kernel
                        .workspace_path
                        .canonicalize()?
                        .to_string_lossy()
                        .as_ref(),
            "forbidden",
            "插件授权已撤销或上下文发生变化。",
        )?;
        let input = &request["input"];
        ensure(
            input["work_ref"] == grant["work_ref"],
            "forbidden",
            "插件只获权操作所选创作对象。",
        )?;
        let action = text(request, "action")?;
        ensure(
            action_allowed(&grant, action),
            "forbidden",
            "插件没有所需的数据权限。",
        )?;
        self.kernel.extension_data(
            &grant["work_ref"],
            text(&grant, "plugin_id")?,
            action,
            input,
            Some(&grant),
            Some(&access),
        )
    }
}

impl Kernel {
    fn extension_object(
        &self,
        work: &Value,
        owner: &str,
        object_id: &str,
        revision: Option<u64>,
    ) -> Result<(Value, String)> {
        checked_id(object_id, "ext")?;
        let (record, sha, _) =
            self.versioned_record(&collection(work, owner)?, object_id, "object_id", revision)?;
        ensure(
            record["work_ref"] == *work && record["owner_plugin_id"] == owner,
            "hetu.integrity_failure",
            "插件对象归属不一致。",
        )?;
        Ok((record, sha))
    }

    /// 来源只校验确切依据，不向插件返回正文或提升为领域读取授权。
    fn validate_extension_sources(&self, work: &Value, sources: &Value) -> Result<()> {
        let sources = sources
            .as_array()
            .ok_or_else(|| Error::new("invalid_input", "插件来源须为列表。"))?;
        ensure(
            sources.len() <= 64,
            "invalid_input",
            "插件来源超过数量限制。",
        )?;
        let mut seen = std::collections::BTreeSet::new();
        for source in sources {
            schema(&source["work_ref"], &works::definition("work_ref"))?;
            ensure(
                source["work_ref"] == *work,
                "forbidden",
                "插件来源只能引用当前获权作品。",
            )?;
            sha(text(source, "sha256")?)?;
            ensure(
                seen.insert(Self::input_digest(source)?),
                "invalid_input",
                "插件来源不能重复。",
            )?;
            match text(source, "kind")? {
                "document" => {
                    closed(
                        source,
                        &["kind", "work_ref", "document_id", "revision_id", "sha256"],
                        &[],
                    )?;
                    let document = self.document(text(source, "document_id")?)?;
                    ensure(
                        self.document_in_work(&document, work)?,
                        "forbidden",
                        "插件来源正文不属于当前作品。",
                    )?;
                    let fixed = self.document_content(
                        text(source, "document_id")?,
                        Some(text(source, "revision_id")?),
                    )?;
                    ensure(
                        fixed["revision"]["sha256"] == source["sha256"],
                        "hetu.stale_evidence",
                        "插件正文来源摘要不一致。",
                    )?;
                }
                "blueprint" => {
                    closed(
                        source,
                        &["kind", "work_ref", "blueprint_id", "revision", "sha256"],
                        &[],
                    )?;
                    let (fixed, actual) = self.source_blueprint(source)?;
                    ensure(
                        fixed["blueprint_id"] == source["blueprint_id"]
                            && actual == source["sha256"],
                        "hetu.stale_evidence",
                        "插件设定来源身份或摘要不一致。",
                    )?;
                }
                "asset" | "cue" => {
                    let kind = text(source, "kind")?;
                    let field = format!("{kind}_id");
                    closed(
                        source,
                        &["kind", "work_ref", &field, "revision", "sha256"],
                        &[],
                    )?;
                    let id = text(source, &field)?;
                    ensure(
                        self.media_in_work(kind, id, Some(integer(source, "revision")?), work)?,
                        "forbidden",
                        "插件媒体来源不属于当前作品。",
                    )?;
                    let input = json!({field:id,"revision":source["revision"]});
                    let fixed = if kind == "asset" {
                        self.get_asset(&input)?
                    } else {
                        self.get_cue(&input)?
                    };
                    ensure(
                        fixed["sha256"] == source["sha256"],
                        "hetu.stale_evidence",
                        "插件媒体来源摘要不一致。",
                    )?;
                }
                "work" => {
                    closed(source, &["kind", "work_ref", "revision_ref", "sha256"], &[])?;
                    let mut reference = source.clone();
                    reference.as_object_mut().unwrap().remove("kind");
                    self.fixed_work_record(&reference)?;
                }
                _ => return Err(Error::new("invalid_input", "插件来源类型不受支持。")),
            }
        }
        Ok(())
    }

    pub fn extension_request(&self, input: Value) -> Value {
        match access_directory() {
            Ok(directory) => self.extension_request_in(&directory, input),
            Err(e) => domain::failure("hetu.extensions.request", self.scope(), &e),
        }
    }
    pub fn extension_request_in(&self, directory: &Path, input: Value) -> Value {
        let result = (|| -> Result<Value> {
            closed(&input, &["grant_id", "package_sha256", "request"], &[])?;
            let session = PluginSession::open(
                &self.workspace_path,
                directory,
                text(&input, "grant_id")?,
                text(&input, "package_sha256")?,
            )?;
            Ok(session.request(input["request"].clone()))
        })();
        result.unwrap_or_else(|e| domain::failure("hetu.extensions.request", self.scope(), &e))
    }
    /// 精确管理授权下的会话入口；不开放作者私有路由或跨作品授权。
    pub(super) fn execute_plugin_access(&self, action: &str, input: &Value) -> Result<Value> {
        let binding = self
            .management_grant
            .as_ref()
            .ok_or_else(|| Error::new("forbidden", "须使用精确作品管理授权。"))?;
        let work = self
            .granted_work()?
            .or(crate::collaboration::authoring::created_work(binding)?);
        ensure(
            work.as_ref() == Some(&input["work_ref"]),
            "forbidden",
            "插件能力只覆盖当前作品。",
        )?;
        let directory = access_directory()?;
        let method = action.strip_prefix("hetu.plugin_access.").unwrap_or("");
        if matches!(method, "capabilities" | "invoke") {
            {
                let access = access_store(&directory)?;
                let _guard = access.read_lock()?;
                let grant = read_grant(&access, text(input, "grant_id")?)?;
                ensure(
                    grant["conversation_decision"]["management_binding"] == *binding,
                    "forbidden",
                    "插件调用须沿当前客户端的确切作品授权。",
                )?;
            }
            let session = PluginSession::open(
                &self.workspace_path,
                &directory,
                text(input, "grant_id")?,
                text(input, "package_sha256")?,
            )?;
            let inspected = session.inspect();
            ensure(
                inspected["status"] == "succeeded",
                "forbidden",
                "插件授权已失效。",
            )?;
            ensure(
                inspected["data"]["work_ref"] == input["work_ref"],
                "forbidden",
                "插件授权不属于当前作品。",
            )?;
            let mut runtime = input.clone();
            runtime["plugin_id"] = inspected["data"]["plugin_id"].clone();
            runtime["workspace_directory"] = json!(self.workspace_path);
            runtime["access_directory"] = json!(directory);
            return crate::plugin_settings::request(
                binding["client_adapter"].as_str().unwrap_or(""),
                action,
                &runtime,
            );
        }
        let mut params = input.clone();
        params.as_object_mut().unwrap().remove("work_ref");
        if method == "authorize" {
            ensure(
                !text(input, "authorization_note")?.trim().is_empty(),
                "invalid_input",
                "须如实记录作者的插件安装与授权选择。",
            )?;
            params.as_object_mut().unwrap().remove("authorization_note");
            params["work_ref"] = input["work_ref"].clone();
            params["conversation_decision"] = json!({"confirmation_channel":"agent_conversation","authorization_note":input["authorization_note"],"management_binding":binding});
        } else {
            let access = access_store(&directory)?;
            let grant = read_grant(&access, text(input, "grant_id")?)?;
            ensure(
                grant["work_ref"] == input["work_ref"]
                    && grant["root"]
                        == self
                            .workspace_path
                            .canonicalize()?
                            .to_string_lossy()
                            .as_ref(),
                "forbidden",
                "插件授权属于其他作品。",
            )?;
            if method == "record_migration_decision" {
                ensure(
                    grant["conversation_decision"]["management_binding"] == *binding
                        && !text(input, "authorization_note")?.trim().is_empty(),
                    "forbidden",
                    "迁移决定须沿本客户端的原插件授权记录真实指令。",
                )?;
                params.as_object_mut().unwrap().remove("authorization_note");
                params["conversation_decision"] = json!({"confirmation_channel":"agent_conversation","authorization_note":input["authorization_note"],"management_binding":binding});
            }
            if method == "revoke" {
                ensure(
                    !text(input, "authorization_note")?.trim().is_empty(),
                    "invalid_input",
                    "须记录撤权指令。",
                )?;
                params = json!({"grant_id":input["grant_id"]});
            }
        }
        ensure(
            matches!(
                method,
                "authorize" | "inspect" | "revoke" | "record_migration_decision"
            ),
            "invalid_input",
            "未开放此插件管理动作。",
        )?;
        let host_method = if method == "record_migration_decision" {
            "approve_migration"
        } else {
            method
        };
        self.extension_host_action(
            &directory,
            json!({"method":host_method,"params":params}),
            true,
        )
    }
    pub fn extension_host_request(&self, input: Value) -> Value {
        match access_directory() {
            Ok(directory) => self.extension_host_request_in(&directory, input),
            Err(e) => domain::failure("hetu.extensions.host", self.scope(), &e),
        }
    }
    /// 仅供可信作者宿主与隔离测试组装；不得由机器参数转发到此通道。
    pub fn extension_host_request_in(&self, directory: &Path, input: Value) -> Value {
        self.extension_host_request_impl(directory, input, false)
    }
    fn extension_host_action(
        &self,
        directory: &Path,
        input: Value,
        conversation: bool,
    ) -> Result<Value> {
        (|| -> Result<Value> {
            ensure(
                self.author || conversation,
                "forbidden",
                "插件授权须通过可信作者入口或精确会话决定。",
            )?;
            let method = text(&input, "method")?;
            let params = &input["params"];
            ensure(
                bytes(&input)?.len() <= LIMIT,
                "hetu.budget_exceeded",
                "插件宿主消息超过预算。",
            )?;
            match method {
                "approve_migration" => self.approve_extension_migration(directory, params),
                "inspect" => {
                    closed(params, &["grant_id", "package_sha256"], &[])?;
                    let session = PluginSession::open(
                        &self.workspace_path,
                        directory,
                        text(params, "grant_id")?,
                        text(params, "package_sha256")?,
                    )?;
                    Ok(session.inspect())
                }
                "authorize" => {
                    closed(
                        params,
                        &[
                            "work_ref",
                            "plugin_id",
                            "package_sha256",
                            "permissions",
                            "types",
                            "operation_key",
                        ],
                        &["conversation_decision"],
                    )?;
                    self.work_record(&params["work_ref"], None)?;
                    plugin_id(text(params, "plugin_id")?)?;
                    sha(text(params, "package_sha256")?)?;
                    let permissions = params["permissions"]
                        .as_array()
                        .ok_or_else(|| Error::new("invalid_input", "权限须为数组。"))?;
                    ensure(
                        permissions.len() <= 3
                            && permissions
                                .iter()
                                .all(|p| p == "objects.read" || p == "objects.write" || p == "work.read"),
                        "invalid_input",
                        "仅允许专业对象读写及当前作品只读权限。",
                    )?;
                    let types = params["types"]
                        .as_array()
                        .ok_or_else(|| Error::new("invalid_input", "类型声明须为数组。"))?;
                    ensure(
                        (!permissions.iter().any(|p| p == "objects.read" || p == "objects.write") || !types.is_empty()) && types.len() <= 16,
                        "invalid_input",
                        "类型声明数量无效。",
                    )?;
                    let mut seen = std::collections::BTreeSet::new();
                    for kind in types {
                        closed(kind, &["kind", "schema_version", "schema"], &[])?;
                        ensure(
                            seen.insert(text(kind, "kind")?)
                                && !text(kind, "kind")?.is_empty()
                                && text(kind, "kind")?.len() <= 120
                                && !text(kind, "schema_version")?.is_empty()
                                && kind["schema"].is_object(),
                            "invalid_input",
                            "类型标识重复或无效。",
                        )?;
                        ensure(
                            bytes(&kind["schema"])?.len() <= 32768,
                            "hetu.budget_exceeded",
                            "Schema超过预算。",
                        )?;
                        jsonschema::validator_for(&kind["schema"]).map_err(|_| {
                            Error::new("invalid_input", "插件Schema无效或含无法解析的引用。")
                        })?;
                    }
                    let access = access_store(directory)?;
                    ensure(
                        !directory
                            .canonicalize()?
                            .starts_with(self.workspace_path.canonicalize()?),
                        "hetu.unsafe_path",
                        "插件授权必须保存在作品之外。",
                    )?;
                    let _guard = access.lock()?;
                    access.recover()?;
                    let key = text(params, "operation_key")?;
                    ensure(
                        !key.is_empty() && key.len() <= 200,
                        "invalid_input",
                        "授权操作键无效。",
                    )?;
                    let op = format!(
                        "operations/{}.json",
                        digest(bytes(&json!({"workspace":self.scope(),"key":key}))?)
                    );
                    let input_sha = Self::input_digest(params)?;
                    if access.exists(&op)? {
                        let previous = access.json(&op)?;
                        ensure(
                            previous["input_sha256"] == input_sha,
                            "idempotency_conflict",
                            "原授权键已绑定其他输入。",
                        )?;
                        let record = read_grant(&access, text(&previous, "grant_id")?)?;
                        ensure(
                            record["revoked"] == false,
                            "forbidden",
                            "原授权已撤销；重新授权须使用新操作键。",
                        )?;
                        return Ok(record);
                    }
                    let mut grant = params.clone();
                    grant.as_object_mut().unwrap().remove("operation_key");
                    grant["grant_id"] = json!(id("grant"));
                    grant["root"] = json!(self.workspace_path.canonicalize()?);
                    grant["revoked"] = json!(false);
                    grant["created_at"] = json!(now());
                    let mut changes = Changes::new();
                    changes.insert(grant_path(text(&grant, "grant_id")?)?, bytes(&grant)?);
                    changes.insert(
                        op,
                        bytes(&json!({"input_sha256":input_sha,"grant_id":grant["grant_id"]}))?,
                    );
                    access.transaction(&changes)?;
                    Ok(grant)
                }
                "disable" => {
                    closed(params, &["plugin_id", "package_sha256"], &[])?;
                    disable_package_in(
                        directory,
                        text(params, "plugin_id")?,
                        text(params, "package_sha256")?,
                    )
                }
                "revoke" => {
                    closed(params, &["grant_id"], &[])?;
                    let access = access_store(directory)?;
                    let _guard = access.lock()?;
                    access.recover()?;
                    let path = grant_path(text(params, "grant_id")?)?;
                    let mut grant = read_grant(&access, text(params, "grant_id")?)?;
                    ensure(
                        grant["work_ref"]["workspace_id"] == self.scope()
                            && grant["root"]
                                == self
                                    .workspace_path
                                    .canonicalize()?
                                    .to_string_lossy()
                                    .as_ref(),
                        "forbidden",
                        "授权不属于当前工作区。",
                    )?;
                    grant["revoked"] = json!(true);
                    access.transaction(&Changes::from([(path, bytes(&grant)?)]))?;
                    Ok(json!({"revoked":true}))
                }
                "read" => {
                    closed(params, &["work_ref", "plugin_id", "request"], &[])?;
                    plugin_id(text(params, "plugin_id")?)?;
                    request_schema(&params["request"])?;
                    let action = text(&params["request"], "action")?;
                    ensure(
                        matches!(
                            action,
                            "hetu.extensions.objects.list"
                                | "hetu.extensions.objects.search"
                                | "hetu.extensions.index.status"
                                | "hetu.extensions.objects.get"
                                | "hetu.extensions.objects.export"
                                | "hetu.extensions.migrations.list"
                                | "hetu.extensions.migrations.get"
                        ),
                        "forbidden",
                        "通用降级入口仅支持读取和导出。",
                    )?;
                    ensure(
                        params["request"]["input"]["work_ref"] == params["work_ref"],
                        "forbidden",
                        "读取范围不一致。",
                    )?;
                    self.extension_data(
                        &params["work_ref"],
                        text(params, "plugin_id")?,
                        action,
                        &params["request"]["input"],
                        None,
                        None,
                    )
                }
                _ => Err(Error::new("invalid_input", "未知插件宿主方法。")),
            }
        })()
    }

    fn extension_host_request_impl(
        &self,
        directory: &Path,
        input: Value,
        conversation: bool,
    ) -> Value {
        self.extension_host_action(directory, input, conversation)
            .map(|data| {
                if data["spec_version"] == "0.2.1" {
                    data
                } else {
                    domain::success("hetu.extensions.host", self.scope(), data)
                }
            })
            .unwrap_or_else(|e| domain::failure("hetu.extensions.host", self.scope(), &e))
    }

    fn extension_data(
        &self,
        work: &Value,
        owner: &str,
        action: &str,
        input: &Value,
        grant: Option<&Value>,
        access: Option<&Store>,
    ) -> Result<Value> {
        validate_data_input(action, input)?;
        let write = data_write(action);
        let _guard = if write {
            self.store.lock()?
        } else {
            self.store.read_lock()?
        };
        if write {
            self.store.recover()?;
        }
        ensure(
            digest(self.store.read(self.config_path())?) == self.config_sha,
            "revision_conflict",
            "工作区配置已变化，请重新打开。",
        )?;
        self.work_record(work, None)?;
        if action.starts_with("hetu.extensions.migrations.") {
            return self.extension_migration(work, owner, action, input, grant, access);
        }
        if action.starts_with("hetu.extensions.index.")
            || action == "hetu.extensions.objects.search"
        {
            return self.extension_index(work, owner, action, input, grant);
        }
        let root = collection(work, owner)?;
        let read = |object_id: &str, revision: Option<u64>| -> Result<(Value, String)> {
            self.extension_object(work, owner, object_id, revision)
        };
        let mut changes = Changes::new();
        let data = match action {
            "hetu.extensions.work.snapshot" => {
                self.novel_snapshot(input)?
            }
            "hetu.extensions.sources.inspect" => {
                let source = &input["source_ref"];
                self.validate_extension_sources(work, &json!([source]))?;
                if source["kind"] == "blueprint" {
                    let (blueprint, _) = self.source_blueprint(source)?;
                    if let Some(entity) = input["entity_ref"].as_str() {
                        let mut found = None;
                        for (collection, field) in [("characters","character_id"),("factions","faction_id"),("locations","location_id"),("timeline","event_id"),("world","entry_id"),("rules","rule_id")] {
                            if let Some(items) = blueprint[collection].as_array() {
                                if let Some(item) = items.iter().find(|item| item[field] == entity) { found = Some((item.clone(),collection)); }
                            }
                        }
                        let (entity, collection) = found.ok_or_else(|| Error::new("not_found","固定设定中不存在该实体。"))?;
                        let entity_kind = match collection { "characters"=>"character", "factions"=>"faction", "locations"=>"location", "rules"=>"rule", "timeline"=>"event", _=>"world_entry" };
                        json!({"source_ref":source,"entity":entity,"entity_kind":entity_kind})
                    } else { json!({"source_ref":source,"blueprint":blueprint}) }
                } else if source["kind"] == "document" {
                    ensure(input.get("entity_ref").is_none(), "invalid_input", "正文来源不包含设定实体。")?;
                    let fixed = self.document_content(text(source,"document_id")?,Some(text(source,"revision_id")?))?;
                    json!({"source_ref":source,"document":fixed["document"],"content":fixed["content"]})
                } else if source["kind"] == "work" {
                    ensure(input.get("entity_ref").is_none(), "invalid_input", "作品资料来源不包含设定实体。")?;
                    self.get_work(&json!({"work_ref":work,"revision":source["revision_ref"]["revision"]}))?
                } else {
                    let kind = text(source,"kind")?;
                    let field = format!("{kind}_id");
                    let record = if kind == "asset" { self.get_asset(&json!({field.clone():source[&field],"revision":source["revision"]}))? }
                        else { self.get_cue(&json!({field.clone():source[&field],"revision":source["revision"]}))? };
                    if let Some(entity) = input["entity_ref"].as_str() { ensure(source[&field] == entity,"not_found","来源实体身份不一致。")?; }
                    // 私密物理路径不回传到专业插件。
                    let mut record = record;
                    if let Some(blob) = record["asset"]["blob"].as_object_mut() { blob.remove("path"); }
                    json!({"source_ref":source,"resource":record,"entity_kind":kind})
                }
            }
            "hetu.extensions.objects.list" => {
                closed(input, &["work_ref"], &["kind", "limit", "cursor"])?;
                let limit = input
                    .get("limit")
                    .map(|v| {
                        v.as_u64()
                            .ok_or_else(|| Error::new("invalid_input", "分页数量须为整数。"))
                    })
                    .transpose()?
                    .unwrap_or(50);
                ensure(
                    limit > 0 && limit <= 100,
                    "invalid_input",
                    "分页数量须为1至100。",
                )?;
                let cursor = input
                    .get("cursor")
                    .map(|v| {
                        v.as_str()
                            .ok_or_else(|| Error::new("invalid_input", "分页游标无效。"))
                    })
                    .transpose()?
                    .unwrap_or("");
                if !cursor.is_empty() {
                    checked_id(cursor, "ext")?;
                }
                let mut entries = match self.store.entries(&root) {
                    Ok(entries) => entries,
                    Err(e) if e.code == "not_found" => Vec::new(),
                    Err(e) => return Err(e),
                };
                entries.sort();
                let mut objects = Vec::new();
                for object_id in entries.into_iter().filter(|name| name.as_str() > cursor) {
                    let (record, sha) = read(&object_id, None)?;
                    if input
                        .get("kind")
                        .is_some_and(|kind| *kind != record["kind"])
                    {
                        continue;
                    }
                    if grant.is_some_and(|g| {
                        !g["types"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|t| t["kind"] == record["kind"])
                    }) {
                        continue;
                    }
                    objects.push(json!({"object_id":object_id,"work_ref":work,"owner_plugin_id":owner,"kind":record["kind"],"title":record["title"],"revision":record["revision"],"sha256":sha}));
                    if objects.len() > limit as usize {
                        break;
                    }
                }
                let more = objects.len() > limit as usize;
                if more {
                    objects.pop();
                }
                json!({"next_cursor":if more {objects.last().unwrap()["object_id"].clone()} else {Value::Null},"objects":objects})
            }
            "hetu.extensions.objects.get" | "hetu.extensions.objects.export" => {
                closed(input, &["work_ref", "object_id"], &["revision", "format"])?;
                let revision = input
                    .get("revision")
                    .map(|v| {
                        v.as_u64()
                            .ok_or_else(|| Error::new("invalid_input", "修订须为整数。"))
                    })
                    .transpose()?;
                let (record, sha) = read(text(input, "object_id")?, revision)?;
                if let Some(grant) = grant {
                    ensure(
                        grant["types"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|t| t["kind"] == record["kind"]),
                        "forbidden",
                        "类型不在插件授权内。",
                    )?;
                }
                if action.ends_with("export") {
                    let format = text(input, "format")?;
                    ensure(
                        matches!(format, "json" | "markdown"),
                        "invalid_input",
                        "导出格式不受支持。",
                    )?;
                    let content = serde_json::to_string_pretty(&record)?;
                    json!({"object":record,"sha256":sha,"format":format,"content":if format=="json" {content} else {format!("# {}\n\n```json\n{}\n```\n",record["title"].as_str().unwrap_or(""),content)}})
                } else {
                    json!({"object":record,"sha256":sha})
                }
            }
            "hetu.extensions.operations.get" => {
                closed(input, &["work_ref", "operation_key"], &["invocation_sha256"])?;
                let record = self.store.json(&operation_path(
                    work,
                    owner,
                    text(input, "operation_key")?,
                )?)?;
                if let Some(invocation) = input.get("invocation_sha256") {
                    sha(invocation.as_str().ok_or_else(|| Error::new("invalid_input", "专业输入摘要无效。"))?)?;
                    ensure(record["invocation_sha256"] == *invocation, "idempotency_conflict", "原操作键已绑定其他专业输入，或旧记录无法核验该输入。")?;
                }
                let result = record["result"].clone();
                if let Some(grant) = grant {
                    ensure(
                        grant["types"].as_array().unwrap().iter().any(|t| {
                            &t["kind"]
                                == result["data"]["object"]
                                    .get("kind")
                                    .unwrap_or(&result["data"]["plan"]["kind"])
                        }),
                        "forbidden",
                        "原操作类型不在当前授权内。",
                    )?;
                }
                return Ok(result);
            }
            "hetu.extensions.objects.save" => {
                closed(
                    input,
                    &[
                        "work_ref",
                        "kind",
                        "title",
                        "schema_version",
                        "content",
                        "expected_revision",
                        "expected_sha256",
                        "operation_key",
                    ],
                    &["object_id", "source_refs", "invocation_sha256"],
                )?;
                if let Some(invocation) = input.get("invocation_sha256") {
                    sha(invocation.as_str().ok_or_else(|| Error::new("invalid_input", "专业输入摘要无效。"))?)?;
                }
                let grant = grant.ok_or_else(|| Error::new("forbidden", "写入须有插件授权。"))?;
                let path = operation_path(work, owner, text(input, "operation_key")?)?;
                let mut fixed = input.clone();
                fixed.as_object_mut().unwrap().remove("operation_key");
                let input_sha = Self::input_digest(
                    &json!({"input":fixed,"package_sha256":grant["package_sha256"]}),
                )?;
                if self.store.exists(&path)? {
                    let old = self.store.json(&path)?;
                    ensure(
                        old["input_sha256"] == input_sha,
                        "idempotency_conflict",
                        "原操作键已绑定其他输入。",
                    )?;
                    ensure(
                        grant["types"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|t| t["kind"] == old["result"]["data"]["object"]["kind"]),
                        "forbidden",
                        "原操作类型不在当前插件授权内。",
                    )?;
                    return Ok(old["result"].clone());
                }
                let kind = grant["types"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|t| {
                        t["kind"] == input["kind"] && t["schema_version"] == input["schema_version"]
                    })
                    .ok_or_else(|| {
                        Error::new("unsupported_version", "插件类型或Schema版本未获授权。")
                    })?;
                schema(&input["content"], &kind["schema"])?;
                let title = text(input, "title")?;
                ensure(
                    !title.trim().is_empty() && title.len() <= 512,
                    "invalid_input",
                    "对象名称无效。",
                )?;
                let expected = integer(input, "expected_revision")?;
                let mut record = if let Some(object_id) = input.get("object_id") {
                    let (mut old, sha) = read(
                        object_id
                            .as_str()
                            .ok_or_else(|| Error::new("invalid_input", "对象标识无效。"))?,
                        None,
                    )?;
                    ensure(
                        old["revision"] == expected && input["expected_sha256"] == sha,
                        "revision_conflict",
                        "插件对象已变化，请比较当前修订。",
                    )?;
                    ensure(
                        old["kind"] == input["kind"]
                            && old["schema_version"] == input["schema_version"],
                        "unsupported_version",
                        "类型或Schema迁移须另行处理。",
                    )?;
                    self.advance_record(&mut old, &sha)?;
                    old
                } else {
                    ensure(
                        expected == 0 && input["expected_sha256"] == "",
                        "revision_conflict",
                        "新对象须使用空基线。",
                    )?;
                    json!({"object_id":id("ext"),"workspace_id":self.scope(),"work_ref":work,"owner_plugin_id":owner,"kind":input["kind"],"schema_version":input["schema_version"],"revision":1,"previous_sha256":null,"created_at":now(),"updated_at":now()})
                };
                record["title"] = input["title"].clone();
                record["content"] = input["content"].clone();
                let sources = input
                    .get("source_refs")
                    .or_else(|| record.get("source_refs"))
                    .cloned()
                    .unwrap_or_else(|| json!([]));
                self.validate_extension_sources(work, &sources)?;
                record["source_refs"] = sources;
                record["package_sha256"] = grant["package_sha256"].clone();
                record["actor_ref"] = json!(owner);
                let sha = self.stage_versioned_record(&root, "object_id", &record, &mut changes)?;
                let mut result =
                    domain::success(action, self.scope(), json!({"object":record,"sha256":sha}));
                result["operation"] =
                    extension_operation(text(input, "operation_key")?, &input_sha);
                changes.insert(
                    path,
                    bytes(&json!({"input_sha256":input_sha,"invocation_sha256":input.get("invocation_sha256").unwrap_or(&Value::Null),"result":result}))?,
                );
                changes.insert(format!(".hetu/audit/{}.json",result["operation"]["id"].as_str().unwrap()),bytes(&json!({"action":action,"plugin_id":owner,"work_ref":work,"package_sha256":grant["package_sha256"],"created_at":now(),"input_sha256":input_sha}))?);
                self.stage_workspace_properties(&mut changes)?;
                self.store.transaction(&changes)?;
                return Ok(result);
            }
            _ => {
                return Err(Error::new(
                    "hetu.capability_unavailable",
                    "未知插件数据动作。",
                ));
            }
        };
        Ok(domain::success(action, self.scope(), data))
    }
}

/// 可信本机宿主的撤权操作，不依赖仍然存在的作品目录；不向插件桥接公开。
pub fn disable_package_in(directory: &Path, owner: &str, package_sha256: &str) -> Result<Value> {
    plugin_id(owner)?;
    sha(package_sha256)?;
    let access = access_store(directory)?;
    let _guard = access.lock()?;
    access.recover()?;
    let entries = match access.entries("grants") {
        Ok(entries) => entries,
        Err(e) if e.code == "not_found" => Vec::new(),
        Err(e) => return Err(e),
    };
    let mut changes = Changes::new();
    let mut revoked = 0;
    for name in entries {
        let grant_id = name
            .strip_suffix(".json")
            .ok_or_else(|| Error::new("hetu.integrity_failure", "授权目录包含未知文件。"))?;
        let mut grant = read_grant(&access, grant_id)?;
        if grant["plugin_id"] == owner
            && grant["package_sha256"] == package_sha256
            && grant["revoked"] == false
        {
            grant["revoked"] = json!(true);
            changes.insert(grant_path(grant_id)?, bytes(&grant)?);
            revoked += 1;
        }
    }
    if !changes.is_empty() {
        access.transaction(&changes)?;
    }
    Ok(json!({"revoked_count":revoked}))
}
