//! MCP App表现层；作品读取仍经原CollaborationHub，不创建作者身份或当前作品。
use super::*;

pub const TOOL: &str = "hetu_open_app";

pub fn tool() -> Tool {
    let mut tool = Tool::default();
    tool.name = TOOL.into();
    tool.title = Some("河图洛书 / Hetu Luoshu".into());
    tool.description = Some("打开河图工作台。空参数读取桌面同一创作库的展示目录；作品正文使用确切management_ref，任务使用task_locator。目录可见不授予正文权限，不能授权、采纳或定稿。Open the shared Hetu library; exact grants are still required for work content.".into());
    tool.input_schema = Arc::new(json!({"type":"object","additionalProperties":false,
        "properties":{"management_ref":{"type":"object"},"task_locator":{"type":"object"}},
        "not":{"required":["management_ref","task_locator"]}}).as_object().unwrap().clone());
    tool.annotations = Some(ToolAnnotations::from_raw(None, Some(true), Some(false), Some(true), Some(false)));
    tool.meta = Some(json!({"ui":{"resourceUri":ui::workbench_uri(),"visibility":["model","app"]},
        "openai/ui":{"entrypoints":[{"type":"global"},{"type":"thread"}]}}).as_object().unwrap().clone().into());
    tool
}

pub fn open(hub: &hetu_core::collaboration::CollaborationHub, arguments: serde_json::Map<String, Value>, cancelled: &dyn Fn() -> bool) -> Result<CallToolResult, ErrorData> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input { management_ref: Option<Value>, task_locator: Option<Value> }
    let input: Input = serde_json::from_value(Value::Object(arguments))
        .map_err(|_| ErrorData::invalid_params("App入口参数无效 / Invalid app arguments", None))?;
    if input.management_ref.is_some() && input.task_locator.is_some() {
        return Err(ErrorData::invalid_params("请打开一个确切作品或任务 / Open one exact work or task", None));
    }
    let mut result = if let Some(locator) = input.task_locator {
        let opened = hub.request_cancellable(json!({"action":"hetu.collaboration.open","contract_revision":"1","input":{"task_locator":locator}}), cancelled);
        if opened["status"] != "succeeded" { return Ok(response::tool_result(opened)); }
        let mut view = hub.request_cancellable(json!({"action":"hetu.interactions.get","contract_revision":"1","input":{"task_ref":opened["data"]["task_ref"]}}), cancelled);
        if view["status"] == "succeeded" { view["data"]["app"] = json!({"route":"task"}); }
        view
    } else if let Some(reference) = input.management_ref {
        let mut works = hub.request_cancellable(json!({"action":"hetu.works.list","contract_revision":"1","input":{"management_ref":reference,"limit":20}}), cancelled);
        if works["status"] == "succeeded" { works["data"]["app"] = json!({"route":"works","management_ref":reference}); }
        works
    } else {
        let mut home = hub.request_cancellable(json!({"action":"hetu.collaboration.library","contract_revision":"1","input":{"limit":20}}), cancelled);
        if home["status"] == "succeeded" { home["data"]["app"] = json!({"route":"library"}); }
        home
    };
    if result["status"] == "succeeded" && result["data"]["app"].is_null() {
        result["data"]["app"] = json!({"route":"home"});
    }
    Ok(response::tool_result(response::bounded(result, TOOL, &json!({}), MAX_RESULT_BYTES)))
}
