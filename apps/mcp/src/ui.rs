use rmcp::{
    ErrorData,
    model::{ReadResourceResult, Resource, ResourceContents, Tool},
    service::{RequestContext, RoleServer},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

pub const URI: &str = "ui://hetu/task-view/1";
pub const MIME: &str = "text/html;profile=mcp-app";
const HTML: &str = include_str!("../resources/task-view.html");
pub const OPERATION_URI: &str = "ui://hetu/operation-view/1";
const OPERATION_HTML: &str = include_str!("../resources/operation-view.html");
pub const WORKBENCH_URI_PREFIX: &str = "ui://hetu/workbench/2";
const WORKBENCH_HTML: &str = include_str!("../resources/workbench.html");

/// 页面身份随固定字节更新，包括同版本的本地覆盖构建。
pub fn workbench_uri() -> &'static str {
    static URI: OnceLock<String> = OnceLock::new();
    URI.get_or_init(|| format!("{WORKBENCH_URI_PREFIX}/{:x}", Sha256::digest(WORKBENCH_HTML.as_bytes())))
}

pub fn supported(context: &RequestContext<RoleServer>) -> bool {
    context
        .client_capabilities()
        .and_then(|capabilities| {
            // 目录发现不依赖此协商；任务增强兼容旧客户端的experimental字段。
            capabilities.extensions.as_ref().and_then(|e| e.get("io.modelcontextprotocol/ui"))
                .or_else(|| capabilities.experimental.as_ref().and_then(|e| e.get("io.modelcontextprotocol/ui")))
                .cloned()
        })
        .and_then(|settings| settings.get("mimeTypes").cloned())
        .and_then(|types| types.as_array().cloned())
        .is_some_and(|types| types.iter().any(|value| value == MIME))
}

pub fn tool(mut tool: Tool) -> Tool {
    let uri = match tool.name.as_ref() {
        "hetu_open_task_view" => Some(URI),
        "hetu_prepare_management_operation"
        | "hetu_get_management_operation"
        | "hetu_local_settings_prepare"
        | "hetu_local_settings_get_operation" => Some(OPERATION_URI),
        _ => None,
    };
    if let Some(uri) = uri {
        tool.meta = Some(
            json!({"ui":{"resourceUri":uri,"visibility":["model","app"]}})
                .as_object()
                .unwrap()
                .clone()
                .into(),
        );
    }
    // 精简模型目录与App调用目录分别管理，权限仍由Core核验。
    if tool.meta.is_none() {
        tool.meta = Some(json!({"ui":{"visibility":["model","app"]}}).as_object().unwrap().clone().into());
    }
    tool
}

pub fn workbench_resource() -> Resource {
    Resource::new(workbench_uri(), "hetu-workbench")
        .with_title("河图洛书 / Hetu Luoshu")
        .with_mime_type(MIME)
        .with_size(WORKBENCH_HTML.len() as u64)
}
pub fn read_workbench() -> ReadResourceResult {
    ReadResourceResult::new(vec![ResourceContents::text(WORKBENCH_HTML, workbench_uri()).with_mime_type(MIME)
        .with_meta(json!({"ui":{"csp":{"connectDomains":[],"resourceDomains":[],"frameDomains":[],"baseUriDomains":[]},"permissions":{},"prefersBorder":true}}).as_object().unwrap().clone().into())])
}

pub fn operation_resource() -> Resource {
    Resource::new(OPERATION_URI, "hetu-operation-view")
        .with_title("查看操作方案 / Inspect operation")
        .with_mime_type(MIME)
        .with_size(OPERATION_HTML.len() as u64)
}
pub fn read_operation() -> ReadResourceResult {
    ReadResourceResult::new(vec![ResourceContents::text(OPERATION_HTML, OPERATION_URI).with_mime_type(MIME)
        .with_meta(json!({"ui":{"csp":{"connectDomains":[],"resourceDomains":[],"frameDomains":[],"baseUriDomains":[]},"permissions":{},"prefersBorder":true}}).as_object().unwrap().clone().into())])
}

pub fn resource() -> Resource {
    Resource::new(URI, "hetu-task-view")
        .with_title("比较参考方案 / Compare references")
        .with_mime_type(MIME)
        .with_size(HTML.len() as u64)
}

pub fn read() -> Result<ReadResourceResult, ErrorData> {
    Ok(ReadResourceResult::new(vec![
        ResourceContents::text(HTML, URI)
            .with_mime_type(MIME)
            .with_meta(json!({"ui":{"csp":{"connectDomains":[],"resourceDomains":[],"frameDomains":[],"baseUriDomains":[]},"permissions":{},"prefersBorder":true}}).as_object().unwrap().clone().into()),
    ]))
}
