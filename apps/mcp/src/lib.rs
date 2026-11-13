mod resources;

use hetu_core::Kernel;
use rmcp::{
    ErrorData, ServerHandler,
    model::*,
    service::{RequestContext, RoleServer},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{borrow::Cow, path::Path, sync::Arc};
use tokio::sync::Semaphore;

pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESULT_BYTES: usize = 8 * 1024 * 1024;
const RESOURCE_ACTIONS: &[&str] = &[
    "hetu.capabilities.get",
    "hetu.workspaces.get",
    "hetu.blueprints.get",
    "hetu.documents.list",
    "hetu.documents.get",
    "hetu.drafts.get",
    "hetu.reviews.list",
    "hetu.reviews.get",
    "hetu.plot.list",
    "hetu.plot.get",
    "hetu.reports.list",
    "hetu.reports.get",
    "hetu.drama.list_skeletons",
    "hetu.drama.get_skeleton",
    "hetu.drama.list_comparisons",
    "hetu.drama.get_comparison",
    "hetu.drama.get_script_mapping",
    "hetu.operations.get",
    "hetu.git.status",
    "hetu.git.diff",
    "hetu.git.log",
    "hetu.git.list_snapshots",
    "hetu.git.get_snapshot",
    "hetu.git.snapshot_diff",
];

#[derive(Deserialize)]
struct ToolCatalog {
    tools: Vec<Mapping>,
}
#[derive(Deserialize)]
struct Mapping {
    name: String,
    action: String,
    title: String,
    description: String,
    profiles: Vec<String>,
}

#[derive(Clone, Copy)]
pub enum ScopeKind {
    Workspace,
    CreationProject,
}
impl ScopeKind {
    fn config_key(self) -> &'static str {
        match self {
            Self::Workspace => "workspace_path",
            Self::CreationProject => "creation_project_path",
        }
    }
}

/// 权限只由启动入口构造，业务参数和客户端自报身份不能改变它。
pub struct HetuServer {
    kernel: Arc<Kernel>,
    tools: Vec<(Tool, String)>,
    actions: Vec<Value>,
    output_validator: jsonschema::Validator,
    gate: Arc<Semaphore>,
}

impl HetuServer {
    pub fn open(workspace: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        Self::open_scope(workspace, ScopeKind::Workspace, None)
    }

    pub fn open_task(
        root: &Path,
        kind: ScopeKind,
        task_id: &str,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        Self::open_scope(root, kind, Some(task_id))
    }

    fn open_scope(
        root: &Path,
        kind: ScopeKind,
        task_id: Option<&str>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        if !root.is_absolute() {
            return Err(
                "工作区必须是显式的绝对路径 / Workspace must be an explicit absolute path".into(),
            );
        }
        let mut config = json!({"mode":"agent"});
        config[kind.config_key()] = json!(root);
        if let Some(task_id) = task_id {
            config["task_id"] = json!(task_id);
        }
        let kernel = Kernel::open(config)?;
        let catalog = kernel
            .request(json!({"action":"hetu.capabilities.get","contract_revision":"1","input":{}}));
        let actions = catalog["data"]["actions"]
            .as_array()
            .ok_or("无法读取内核能力 / Cannot read kernel capabilities")?;
        let mappings: ToolCatalog =
            serde_json::from_str(include_str!("../../../contracts/tools/catalog.json"))?;
        let output: Value = serde_json::from_str(include_str!(
            "../../../contracts/schemas/result.schema.json"
        ))?;
        let mut tools = Vec::new();
        for mapping in mappings.tools {
            if !mapping.profiles.iter().any(|profile| {
                profile
                    == if task_id.is_some() {
                        "task"
                    } else {
                        "workspace"
                    }
            }) {
                continue;
            }
            let action = actions
                .iter()
                .find(|a| a["name"] == mapping.action && a["author_only"] == false)
                .ok_or(
                    "MCP 目录与内核能力不一致 / MCP catalog does not match kernel capabilities",
                )?;
            let mut schema = output.clone();
            schema.as_object_mut().unwrap().remove("$id");
            schema["properties"]["action"] = json!({"const":mapping.action});
            let mut tool = Tool::default();
            tool.name = mapping.name.into();
            tool.title = Some(mapping.title);
            tool.description = Some(mapping.description.into());
            tool.input_schema = Arc::new(
                action["input_schema"]
                    .as_object()
                    .ok_or("invalid input schema")?
                    .clone(),
            );
            tool.output_schema = Some(Arc::new(schema.as_object().unwrap().clone()));
            tool.annotations = Some(ToolAnnotations::from_raw(
                None,
                Some(action["effect"] == "read"),
                Some(false),
                Some(true),
                Some(false),
            ));
            tools.push((tool, mapping.action));
        }
        let actions = actions
            .iter()
            .filter(|a| {
                a["author_only"] == false
                    && (RESOURCE_ACTIONS.contains(&a["name"].as_str().unwrap_or(""))
                        || tools.iter().any(|(_, name)| a["name"] == *name))
            })
            .cloned()
            .collect();
        Ok(Self {
            kernel: Arc::new(kernel),
            tools,
            actions,
            output_validator: jsonschema::validator_for(&output)?,
            gate: Arc::new(Semaphore::new(1)),
        })
    }

    fn task_resource_root(&self) -> Option<String> {
        self.kernel.bound_task().map(|task| {
            format!(
                "hetu://task/{}/{}/{task}/",
                self.kernel.scope_kind(),
                self.kernel.scope()
            )
        })
    }

    fn task_ref(&self) -> Value {
        json!({"scope_ref":{"kind":self.kernel.scope_kind(),"id":self.kernel.scope()},"task_id":self.kernel.bound_task(),"request_revision":1})
    }

    fn failure(&self, action: &str, code: &str, message: &str) -> Value {
        json!({"spec_version":"0.2.1","kind":"result","action":action,"contract_revision":"1",
            "status":"blocked","context":{"scope_id":self.kernel.scope()},
            "error":{"code":code,"message":message,"resolution":{"kind":"recover","action":"hetu.operations.get"}}})
    }

    async fn execute(
        &self,
        action: &str,
        input: Value,
        context: &RequestContext<RoleServer>,
    ) -> Result<Value, ErrorData> {
        let permit = match self.gate.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => return Ok(self.failure(action, "workspace_busy", "工作区正在处理其他请求，请沿原键恢复。 / Workspace is busy; recover using the original operation key.")),
        };
        let kernel = self.kernel.clone();
        let request = json!({"action":action,"contract_revision":"1","input":input});
        let cancellation = context.ct.clone();
        // 取消尚未开始的操作；已开始的事务完成落盘后由原键查询，不能硬杀写入。
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            if cancellation.is_cancelled() { return None; }
            Some(kernel.request(request))
        }).await.map_err(|_| ErrorData::internal_error(
            "内核任务未返回，请查询原操作，勿更换键重发。 / Kernel task did not return; query the original operation before retrying.", None,
        ))?;
        let mut result = result
            .ok_or_else(|| ErrorData::invalid_request("请求已取消 / Request cancelled", None))?;
        if action == "hetu.capabilities.get" && result.get("data").is_some() {
            result["data"]["actions"] = json!(self.actions);
        }
        if !self.output_validator.is_valid(&result) {
            return Err(ErrorData::internal_error(
                "内核结果违反合同 / Kernel result violates its contract",
                None,
            ));
        }
        Ok(result)
    }

    fn bounded_result(&self, result: Value) -> Value {
        if serde_json::to_vec(&result).is_ok_and(|bytes| bytes.len() <= MAX_RESULT_BYTES) {
            return result;
        }
        let mut failure = self.failure(result["action"].as_str().unwrap_or("hetu.request.invalid"),
            "hetu.budget_exceeded", "结果超过传输上限；请缩小范围并查询原操作。 / Result exceeds transport budget; narrow the selection and inspect the original operation.");
        if let Some(operation) = result.get("operation") {
            failure["operation"] = operation.clone();
        }
        failure
    }
}

impl ServerHandler for HetuServer {
    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(&[ProtocolVersion::V_2026_07_28])
    }

    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_resources().build())
            .with_protocol_version(ProtocolVersion::V_2026_07_28)
            .with_server_info(Implementation::new("hetu-mcp", env!("CARGO_PKG_VERSION")))
            .with_instructions("河图洛书保存作者的设定与创作资产，不生成内容。先读设定集和固定原文，再提交待审草稿。通过 resources/list 与 resources/templates/list 查找文档、审核意见、报告和原操作。写请求超时或取消后沿原 operation_key 恢复；取消不保证未写入。最终批准必须由作者在原生客户端完成。\nHetu Luoshu stores author-owned story assets; it does not generate content. Read the story bible and fixed sources before submitting drafts. Discover resources for documents, review feedback, reports and original operations. After timeout or cancellation, recover with the original operation_key; cancellation does not prove that no write occurred. Only the author can approve in the native app.")
    }

    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        resources::no_cursor(request)?;
        Ok(ListToolsResult::with_all_items(
            self.tools.iter().map(|(tool, _)| tool.clone()).collect(),
        ))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let (_, action) = self
            .tools
            .iter()
            .find(|(tool, _)| tool.name == request.name)
            .ok_or_else(|| {
                ErrorData::new(
                    ErrorCode::METHOD_NOT_FOUND,
                    "未开放此工具 / Tool is not exposed",
                    None,
                )
            })?;
        let result = self
            .execute(
                action,
                json!(request.arguments.unwrap_or_default()),
                &context,
            )
            .await?;
        let result = self.bounded_result(result);
        let response = if result.get("error").is_some() {
            CallToolResult::structured_error(result)
        } else {
            CallToolResult::structured(result)
        };
        Ok(response.into())
    }

    async fn list_resources(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        resources::no_cursor(request)?;
        let items = if let Some(root) = self.task_resource_root() {
            [
                ("capabilities", "当前任务权限 / Task permissions"),
                ("request", "固定任务及候选 / Fixed task and candidates"),
                ("view", "局部选择数据 / Local selection data"),
            ]
            .into_iter()
            .map(|(path, title)| {
                Resource::new(format!("{root}{path}"), path)
                    .with_title(title)
                    .with_mime_type("application/json")
            })
            .collect()
        } else {
            resources::directory(self.kernel.scope())
        };
        Ok(ListResourcesResult::with_all_items(items))
    }

    async fn list_resource_templates(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, ErrorData> {
        resources::no_cursor(request)?;
        let items = if let Some(root) = self.task_resource_root() {
            [
                ("operations/{operation_id}", "本任务原操作 / Task operation"),
                (
                    "operations/by-key{?action,key}",
                    "按原键恢复本任务 / Recover task by key",
                ),
            ]
            .into_iter()
            .map(|(path, title)| {
                ResourceTemplate::new(format!("{root}{path}"), path)
                    .with_title(title)
                    .with_mime_type("application/json")
            })
            .collect()
        } else {
            resources::templates(self.kernel.scope())
        };
        Ok(ListResourceTemplatesResult::with_all_items(items))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        let (action, input, page) = if let Some(root) = self.task_resource_root() {
            let invalid = || {
                ErrorData::invalid_params(
                    "资源不属于当前任务 / Resource is outside this task",
                    None,
                )
            };
            let path = request.uri.strip_prefix(&root).ok_or_else(invalid)?;
            match path {
                "request" => (
                    "hetu.creative_tasks.get",
                    json!({"task_ref":self.task_ref()}),
                    None,
                ),
                "view" => (
                    "hetu.interactions.get",
                    json!({"task_ref":self.task_ref()}),
                    None,
                ),
                _ => {
                    let route = resources::route(
                        self.kernel.scope(),
                        &format!("hetu://workspace/{}/{path}", self.kernel.scope()),
                    )?;
                    if !matches!(route.0, "hetu.capabilities.get" | "hetu.operations.get") {
                        return Err(invalid());
                    }
                    route
                }
            }
        } else {
            resources::route(self.kernel.scope(), &request.uri)?
        };
        let mut result = self.execute(action, input, &context).await?;
        if let Some(page) = page {
            resources::paginate(&mut result, page)?;
        }
        if self.kernel.bound_task().is_none() {
            resources::links(self.kernel.scope(), &request.uri, &mut result);
        }
        let result = self.bounded_result(result);
        Ok(ReadResourceResult::new(vec![
            ResourceContents::text(result.to_string(), request.uri)
                .with_mime_type("application/json"),
        ])
        .into())
    }
}
