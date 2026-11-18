use super::*;
use hetu_core::collaboration::CollaborationHub;
use std::path::Path;

/// 同一连接显式路由多个获权任务，不更改服务进程的当前作品。
pub struct StableServer {
    hub: Arc<CollaborationHub>,
    tools: Vec<(Tool, String)>,
    gate: Arc<Semaphore>,
    all_tools: bool,
    output_validator: jsonschema::Validator,
    read_actions: Vec<String>,
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
            if mapping.action != "hetu.collaboration.invoke" {
                output["properties"]["action"] = json!({"const":mapping.action});
            }
            tool.output_schema = Some(Arc::new(output.as_object().unwrap().clone()));
            tool.annotations = Some(ToolAnnotations::from_raw(
                None,
                Some(action["effect"] == "read" && tool.name != model_confirmation::TOOL),
                Some(mapping.action == "hetu.collaboration.invoke"),
                Some(mapping.action != "hetu.collaboration.invoke"),
                Some(mapping.action == "hetu.collaboration.invoke" || open_world(&mapping.action)),
            ));
            tools.push((tool, mapping.action));
        }
        Ok(Self {
            hub: Arc::new(hub),
            tools,
            gate: Arc::new(Semaphore::new(1)),
            all_tools: false,
            read_actions: actions
                .as_array()
                .unwrap()
                .iter()
                .filter(|action| action["effect"] == "read")
                .filter_map(|action| action["name"].as_str().map(str::to_owned))
                .collect(),
            output_validator: jsonschema::validator_for(&serde_json::from_str::<Value>(
                include_str!("../../../contracts/schemas/result.schema.json"),
            )?)?,
        })
    }
    pub fn with_all_tools(mut self, enabled: bool) -> Self {
        self.all_tools = enabled;
        self
    }
}
impl ServerHandler for StableServer {
    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(SUPPORTED_PROTOCOL_VERSIONS)
    }
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_protocol_version(ProtocolVersion::V_2026_07_28)
        .with_server_info(Implementation::new("hetu-mcp", env!("CARGO_PKG_VERSION")))
        .with_instructions(MACHINE_INSTRUCTIONS)
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
                    (tool.name != model_confirmation::TOOL
                        || model_confirmation::available(&context))
                        && (self.all_tools
                            || matches!(
                                tool.name.as_ref(),
                                "hetu_inspect_collaboration"
                                    | "hetu_get_capability_map"
                                    | "hetu_begin_creation"
                                    | "hetu_open_collaboration_task"
                                    | "hetu_read_creative_task"
                                    | "hetu_read_task_operation"
                                    | "hetu_get_task_checkpoint"
                                    | "hetu_save_task_checkpoint"
                                    | "hetu_inspect_runtime"
                                    | "hetu_call_action"
                                    | "hetu_open_task_view"
                                    | "hetu_save_task_selection"
                                    | "hetu_request_model_confirmation"
                            ))
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
        let mut arguments = json!(request.arguments.clone().unwrap_or_default());
        response::read_input(action, &mut arguments);
        let recovery_input = if action == "hetu.collaboration.invoke" {
            arguments["input"].clone()
        } else {
            arguments.clone()
        };
        let actual = if action == "hetu.collaboration.invoke" {
            arguments["action"].as_str().unwrap_or(action)
        } else {
            action
        };
        let permit = match self.gate.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                return Ok(CallToolResult::structured_error(response::interrupted(
                    actual,
                    &recovery_input,
                    "workspace_busy",
                    "本机入口忙；保留原输入与键，写入先查询原操作。",
                ))
                .into());
            }
        };
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
        let input = json!({"action":action,"contract_revision":"1","input":arguments.clone()});
        let cancellation = context.ct.clone();
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            if cancellation.is_cancelled() {
                return None;
            }
            Some(hub.request(input))
        })
        .await;
        let result = match result {
            Ok(Some(result)) => result,
            Ok(None) => response::interrupted(
                actual,
                &recovery_input,
                "cancelled",
                "请求在开始前取消，未执行本次操作。",
            ),
            Err(_) => response::interrupted(
                actual,
                &recovery_input,
                "result_unknown",
                "本机操作未返回，请沿原键查询。",
            ),
        };
        let is_read = response::plugin_read(&result) || result["action"]
            .as_str()
            .is_some_and(|action| self.read_actions.iter().any(|name| name == action));
        let result = if is_read && arguments.get("view").is_none() {
            response::summary_read(result, actual, &recovery_input)
        } else {
            result
        };
        let result = response::bounded(result, action, &recovery_input, MAX_RESULT_BYTES);
        if !self.output_validator.is_valid(&result) {
            return Err(ErrorData::internal_error(
                "内核结果违反机器合同 / Result violates contract",
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
