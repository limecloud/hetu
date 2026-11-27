use super::*;
use hetu_core::collaboration::CollaborationHub;
use std::path::Path;

/// 同一连接显式路由多个获权任务，不更改服务进程的当前作品。
pub struct StableServer {
    hub: Arc<CollaborationHub>,
    workbench: workbench::WorkbenchRuntime,
    current_work: Option<Value>,
    tools: Vec<(Tool, String)>,
    gate: Arc<Semaphore>,
    all_tools: bool,
    output_validator: jsonschema::Validator,
    read_actions: Vec<String>,
}
impl StableServer {
    pub fn open(directory: &Path, client: &str) -> Result<Self, Box<dyn std::error::Error>> {
        Self::open_with_work(directory, client, None)
    }
    pub fn open_with_work(directory: &Path, client: &str, current_work: Option<Value>) -> Result<Self, Box<dyn std::error::Error>> {
        let hub = CollaborationHub::open(directory, client)?;
        let actions = hub.catalog_summary();
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
            tool.input_schema = Arc::new(serde_json::Map::new());
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
        let workbench = workbench::WorkbenchRuntime::new(directory,client,hub.library_directory().ok());
        Ok(Self {
            hub: Arc::new(hub),
            workbench,
            current_work,
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
            mentions::capabilities(ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build()),
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
        let apps = ui::supported(&context);
        let mut tools: Vec<Tool> = self.tools
                .iter()
                .filter(|(tool, _)| {
                    (tool.name != model_confirmation::TOOL
                        || model_confirmation::available(&context))
                        && (self.all_tools || apps
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
                                    | "hetu_sessions"
                                    | "hetu_bots"
                                    | "hetu_computer"
                                    | "hetu_open_task_view"
                                    | "hetu_save_task_selection"
                                    | "hetu_request_model_confirmation"
                            ))
                })
                .map(|(tool, action)| {
                    let mut tool = tool.clone();
                    let descriptor = self
                        .hub
                        .action_descriptor(action)
                        .expect("registered tool action");
                    tool.input_schema = Arc::new(
                        descriptor["input_schema"]
                            .as_object()
                            .expect("action schema")
                            .clone(),
                    );
                    if tool.name == model_confirmation::TOOL {
                        tool.input_schema =
                            Arc::new(model_confirmation::input_schema(&tool.input_schema));
                    }
                    if apps {
                        let mut result = ui::tool(tool);
                        if !self.all_tools && !compact_tool(result.name.as_ref()) {
                            let meta = result.meta.get_or_insert_with(Default::default);
                            if let Some(ui) = meta.get_mut("ui").and_then(Value::as_object_mut) {
                                ui.insert("visibility".into(), json!(["app"]));
                            }
                        }
                        result
                    } else {
                        tool
                    }
                })
                .collect();
        // 全局目录探测尚未协商UI；静态入口必须先可发现，才能打开界面。
        tools.push(app::tool());
        tools.push(workbench::tool());
        tools.push(mentions::tool());
        Ok(ListToolsResult::with_all_items(tools))
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        if request.name == mentions::TOOL {
            let permit = tokio::select! {
                _ = context.ct.cancelled() => return Err(ErrorData::internal_error("读取已取消 / Read cancelled",None)),
                permit = self.gate.clone().acquire_owned() => permit.map_err(|_|ErrorData::internal_error("本机入口已关闭 / Local entry closed",None))?,
            };
            let hub=self.hub.clone();
            let work=self.current_work.clone();
            let cancellation=context.ct.clone();
            return tokio::task::spawn_blocking(move || {
                let _permit=permit;
                mentions::search_stable(request.arguments.unwrap_or_default(),&hub,work.as_ref(),&||cancellation.is_cancelled())
            }).await.map_err(|_|ErrorData::internal_error("来源搜索未完成 / Source search interrupted",None))?;
        }
        if request.name == workbench::TOOL { return self.workbench.call(request.arguments.unwrap_or_default()).await; }
        if request.name == app::TOOL {
            let _permit = self.gate.clone().try_acquire_owned().map_err(|_| ErrorData::internal_error("入口忙，请稍后读取 / App is busy", None))?;
            let hub = self.hub.clone();
            let cancellation = context.ct.clone();
            let arguments = request.arguments.unwrap_or_default();
            let mut result = tokio::task::spawn_blocking(move || {
                let _permit = _permit;
                app::open(&hub, arguments, &|| cancellation.is_cancelled())
            }).await.map_err(|_| ErrorData::internal_error("App读取未完成 / App read interrupted", None))??;
            let session=self.workbench.open().await?;
            result.meta=Some(json!({"hetu/workbenchSession":session}).as_object().unwrap().clone().into());
            return Ok(result.into());
        }
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
        let target_action = if action == "hetu.collaboration.invoke" {
            arguments["action"].as_str().unwrap_or(action).to_owned()
        } else {
            action.to_owned()
        };
        if action == "hetu.collaboration.invoke" {
            if let Some(target_input) = arguments.get_mut("input") {
                self.inject_current_management(&target_action, target_input);
            }
        } else {
            self.inject_current_management(&target_action, &mut arguments);
        }
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
        // 引擎会并行发现领域Schema；只读排队，不把同一连接内的正常并发当作失败。
        let permit = if self.read_actions.iter().any(|name| name == actual) && request.name != model_confirmation::TOOL {
            tokio::select! {
                _ = context.ct.cancelled() => return Err(ErrorData::internal_error("读取已取消 / Read cancelled", None)),
                permit = self.gate.clone().acquire_owned() => permit.map_err(|_| ErrorData::internal_error("本机入口已关闭 / Local entry closed", None))?,
            }
        } else { match self.gate.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                let result=response::interrupted(
                    actual,
                    &recovery_input,
                    "workspace_busy",
                    "本机入口忙；保留原输入与键，写入先查询原操作。",
                );
                return Ok(response::tool_result(response::bounded(result,actual,&recovery_input,MAX_RESULT_BYTES)).into());
            }
        }};
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
            hub.request_cancellable(input, &|| cancellation.is_cancelled())
        })
        .await;
        let result = match result {
            Ok(result) => result,
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
        let mut result = result;
        let screenshot = if actual == "hetu.computer.request" { result["data"]["screenshot"].clone() } else { Value::Null };
        if actual == "hetu.computer.request" && let Some(pixels) = result.get_mut("data").and_then(|data|data.get_mut("screenshot")).and_then(Value::as_object_mut) {
            pixels.remove("data");pixels.insert("delivered_as".into(),json!("mcp_image"));
        }
        let mut result = response::bounded(result, action, &recovery_input, MAX_RESULT_BYTES);
        if let Some(work) = &self.current_work {
            if remove_private_management_refs(&mut result) && result["data"].is_object() {
                result["data"]["work_ref"] = work.clone();
            }
        }
        if !self.output_validator.is_valid(&result) {
            return Err(ErrorData::internal_error(
                "内核结果违反机器合同 / Result violates contract",
                None,
            ));
        }
        let mut response=response::tool_result(result);
        if let Some(bytes)=screenshot["data"].as_str(){response.content.push(rmcp::model::ContentBlock::image(bytes,if screenshot["format"]=="jpeg"{"image/jpeg"}else{"image/png"}));}
        Ok(response.into())
    }

    async fn list_resources(
        &self,
        request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        resources::no_cursor(request)?;
        Ok(ListResourcesResult::with_all_items(
            if ui::supported(&context) {
                vec![ui::resource(), ui::operation_resource(), ui::workbench_resource()]
            } else {
                vec![ui::workbench_resource()]
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
        if request.uri.starts_with(mentions::URI_PREFIX) {
            let work=mentions::work_for_uri(&request.uri)?;
            if self.current_work.as_ref().is_some_and(|current|Some(current)!=work.as_ref()) {
                return Err(ErrorData::invalid_params("来源不属于当前作品 / Source outside the current work",None));
            }
            let permit = tokio::select! {
                _ = context.ct.cancelled() => return Err(ErrorData::internal_error("读取已取消 / Read cancelled",None)),
                permit = self.gate.clone().acquire_owned() => permit.map_err(|_|ErrorData::internal_error("本机入口已关闭 / Local entry closed",None))?,
            };
            let hub=self.hub.clone();
            let cancellation=context.ct.clone();
            return tokio::task::spawn_blocking(move || {
                let _permit=permit;
                mentions::read(&request.uri,&mut |action,input|mentions::read_stable(&hub,work.as_ref(),action,input,&||cancellation.is_cancelled()))
            }).await.map_err(|_|ErrorData::internal_error("来源读取未完成 / Source read interrupted",None))?;
        }
        if request.uri == ui::workbench_uri() {
            return Ok(ui::read_workbench().into());
        }
        if request.uri == ui::WORKBENCH_URI_PREFIX || request.uri.starts_with(&format!("{}/", ui::WORKBENCH_URI_PREFIX)) {
            return Err(ErrorData::invalid_params("河图工作台已更新，请关闭旧面板并重新打开河图应用。 / Workbench updated; close this panel and reopen Hetu.", None));
        }
        if request.uri == ui::OPERATION_URI {
            return Ok(ui::read_operation().into());
        }
        if request.uri == ui::URI {
            return Ok(ui::read()?.into());
        }
        Err(ErrorData::invalid_params(
            "请通过确切任务引用读取获权内容 / Read through an exact authorized task reference",
            None,
        ))
    }
}

impl StableServer {
    /// 管理动作复用启动时绑定的 WorkRef，在私有授权目录解析管理引用。
    /// 当前绑定可为无WorkRef字段的读取动作定位；显式不同作品仍由原Schema与范围核验拒绝。
    fn inject_current_management(&self, action: &str, input: &mut Value) {
        let Some(work) = self.current_work.as_ref() else { return; };
        let Some(descriptor) = self.hub.action_descriptor(action) else { return; };
        let authorization = descriptor["authorization"].as_str().unwrap_or("");
        if input.get("work_ref") == Some(work) && !schema_declares_work_ref(&descriptor["input_schema"]) {
            input.as_object_mut().unwrap().remove("work_ref");
        }
        if !matches!(authorization, "new_managed_scope" | "task_or_new_managed_scope") || input.get("management_ref").is_some() {
            return;
        }
        if let Ok(Some(reference)) = self.hub.management_ref_for_work(work) {
            input["management_ref"] = reference;
        }
    }
}

fn compact_tool(name: &str) -> bool {
    matches!(name, "hetu_inspect_collaboration" | "hetu_get_capability_map" | "hetu_begin_creation"
        | "hetu_open_collaboration_task" | "hetu_read_creative_task" | "hetu_read_task_operation"
        | "hetu_get_task_checkpoint" | "hetu_save_task_checkpoint" | "hetu_inspect_runtime"
        | "hetu_call_action" | "hetu_sessions" | "hetu_bots" | "hetu_computer" | "hetu_open_task_view" | "hetu_save_task_selection" | "hetu_request_model_confirmation")
}

/// 受管连接已持有私有范围；模型只需要公开WorkRef，后续请求仍由同一连接解析。
fn remove_private_management_refs(value: &mut Value) -> bool {
    let mut removed = false;
    match value {
        Value::Object(fields) => {
            removed |= fields.remove("management_ref").is_some();
            for child in fields.values_mut() { removed |= remove_private_management_refs(child); }
        }
        Value::Array(values) => for child in values { removed |= remove_private_management_refs(child); },
        _ => {}
    }
    removed
}

fn schema_declares_work_ref(schema: &Value) -> bool {
    schema["properties"].get("work_ref").is_some()
        || ["oneOf", "anyOf", "allOf"].iter().any(|key| schema[key].as_array().is_some_and(|branches| branches.iter().any(schema_declares_work_ref)))
}
