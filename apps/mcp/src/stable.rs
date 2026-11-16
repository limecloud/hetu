use super::*;
use hetu_core::collaboration::CollaborationHub;
use std::path::Path;

/// 同一连接显式路由多个获权任务，不更改服务进程的当前作品。
pub struct StableServer {
    hub: Arc<CollaborationHub>,
    tools: Vec<(Tool, String)>,
    gate: Arc<Semaphore>,
}
impl StableServer {
    pub fn open(directory: &Path, client: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let hub = CollaborationHub::open(directory, client)?;
        let actions = hub.catalog();
        let catalog: ToolCatalog =
            serde_json::from_str(include_str!("../../../contracts/tools/catalog.json"))?;
        let mappings = catalog
            .tools
            .into_iter()
            .filter(|m| m.profiles.iter().any(|p| p == "task" || p == "stable"));
        let mut tools = Vec::new();
        for mapping in mappings {
            let Some(action) = actions
                .as_array()
                .unwrap()
                .iter()
                .find(|a| a["name"] == mapping.action)
            else {
                continue;
            };
            let mut tool = Tool::default();
            tool.name = mapping.name.into();
            tool.title = Some(mapping.title);
            tool.description = Some(mapping.description.into());
            tool.input_schema = Arc::new(
                action["input_schema"]
                    .as_object()
                    .ok_or("invalid task schema")?
                    .clone(),
            );
            if tool.name == model_confirmation::TOOL {
                tool.input_schema = Arc::new(model_confirmation::input_schema(&tool.input_schema));
            }
            let mut output: Value = serde_json::from_str(include_str!(
                "../../../contracts/schemas/result.schema.json"
            ))?;
            output.as_object_mut().unwrap().remove("$id");
            output["properties"]["action"] = json!({"const":mapping.action});
            tool.output_schema = Some(Arc::new(output.as_object().unwrap().clone()));
            tool.annotations = Some(ToolAnnotations::from_raw(
                None,
                Some(action["effect"] == "read" && tool.name != model_confirmation::TOOL),
                Some(false),
                Some(true),
                Some(open_world(&mapping.action)),
            ));
            tools.push((tool, mapping.action));
        }
        Ok(Self {
            hub: Arc::new(hub),
            tools,
            gate: Arc::new(Semaphore::new(1)),
        })
    }
}
impl ServerHandler for StableServer {
    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(SUPPORTED_PROTOCOL_VERSIONS)
    }
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_resources().build())
            .with_protocol_version(ProtocolVersion::V_2026_07_28)
            .with_server_info(Implementation::new("hetu-mcp",env!("CARGO_PKG_VERSION")))
            .with_instructions("河图洛书是作者的本机创作工作台。可选模型工具须先固定计划，经作者批准内容和费用后，通过河图网站服务端执行；未知结果沿原 plan_id 查询。先 hetu_inspect_collaboration；没有作品且作者要开始时，用已发现的 hetu_begin_creation 建立独立筹备，保留管理引用和预留新目录，按实际工具创建作品与首任务；已有任务用 TaskLocator 调用 hetu_open_collaboration_task。每次业务都携带返回的完整 task_ref；连接不代表整库权限。作者在当前会话明确要求整书导入时，发现并登记固定 import_authorization_ref，在范围内连续导入与回读，无需回桌面逐批批准；不要伪造会话授权。全软件先发现实际能力；既有作品用精确management_ref读取，agent_operations.catalog发现领域动作，prepare固定差异，在当前会话取得真实作者决定后record_decision，再execute并回读。创作任务默认交付参考稿；采纳、定稿、解锁、封面选用须对应确切决定。设置、插件、版本与费用使用各自合同，不强制进入桌面重复操作，执行身份保持Agent。未知写入沿原 operation_key 查询，勿换键重发。\nHetu Luoshu stores author-owned work locally. Optional model tools require a fixed plan and author approval of content sharing and cost, then execute through the Hetu website service. Recover unknown model results with the original plan_id. Inspect first. With no work or task, begin an isolated creation project using the discovered tool, retain the management reference and reserved new directory, then create the work and prepare its first task. Open an existing TaskLocator and include the exact task_ref in each task call. For an explicitly requested manuscript import, register its fixed conversation authorization and execute within that scope without desktop batch approvals. Read and edit permissions are separate. Use fixed proposals and record actual author decisions in this conversation before adopting or finalizing. Settings, plugins, versions and model costs retain their own scoped contracts. Remain an Agent and recover unknown writes with the original key.")
    }
    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        resources::no_cursor(request)?;
        Ok(ListToolsResult::with_all_items(
            self.tools
                .iter()
                .filter(|(tool, _)| {
                    tool.name != model_confirmation::TOOL || model_confirmation::available(&context)
                })
                .map(|(tool, _)| {
                    if ui::supported(&context) {
                        ui::tool(tool.clone())
                    } else {
                        tool.clone()
                    }
                })
                .collect(),
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
        let permit = self.gate.clone().try_acquire_owned().map_err(|_| {
            ErrorData::internal_error(
                "本机入口忙，请保留原输入与操作键 / Busy; preserve the original input and key",
                None,
            )
        })?;
        if request.name == model_confirmation::TOOL {
            return model_confirmation::request(
                self.hub.clone(),
                request.arguments.unwrap_or_default(),
                context,
                permit,
            )
            .await;
        }
        let hub = self.hub.clone();
        let input = json!({"action":action,"contract_revision":"1","input":request.arguments.unwrap_or_default()});
        let cancellation = context.ct.clone();
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            if cancellation.is_cancelled() {
                return None;
            }
            Some(hub.request(input))
        })
        .await
        .map_err(|_| {
            ErrorData::internal_error(
                "本机操作未返回，请沿原键恢复 / Recover with the original key",
                None,
            )
        })?
        .ok_or_else(|| ErrorData::invalid_request("请求已取消 / Cancelled", None))?;
        if serde_json::to_vec(&result).map_or(true, |b| b.len() > MAX_RESULT_BYTES) {
            return Err(ErrorData::internal_error(
                "结果超过预算，请缩小读取范围并回查原操作 / Narrow the read and recover the original operation",
                None,
            ));
        }
        Ok(if result.get("error").is_some() {
            CallToolResult::structured_error(result)
        } else {
            CallToolResult::structured(result)
        }
        .into())
    }
    async fn list_resources(
        &self,
        request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        resources::no_cursor(request)?;
        Ok(ListResourcesResult::with_all_items(
            if ui::supported(&context) {
                vec![ui::resource(), ui::operation_resource()]
            } else {
                vec![]
            },
        ))
    }
    async fn list_resource_templates(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, ErrorData> {
        resources::no_cursor(request)?;
        Ok(ListResourceTemplatesResult::with_all_items(vec![]))
    }
    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        if request.uri == ui::OPERATION_URI && ui::supported(&context) {
            return Ok(ui::read_operation().into());
        }
        if request.uri == ui::URI && ui::supported(&context) {
            return Ok(ui::read()?.into());
        }
        Err(ErrorData::invalid_params(
            "请通过确切任务引用读取获权内容 / Read through an exact authorized task reference",
            None,
        ))
    }
}
