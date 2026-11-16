//! 可信桌面宿主的私有 stdio 适配器；业务规则与结果继续由 Core 持有。
use hetu_core::Kernel;
use hetu_core::application::AssetMedia;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{self, BufRead, Write};

pub const PROTOCOL_VERSION: &str = "1";
pub const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_BATCH: usize = 32;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Initialize {
    protocol_version: String,
    client_name: String,
}

#[derive(Default, PartialEq)]
enum State {
    #[default]
    New,
    Initializing,
    Ready,
    Stopping,
    Exited,
}

pub struct Server {
    kernel: Option<Kernel>,
    state: State,
    plugin_access_directory: Option<std::path::PathBuf>,
    media: BTreeMap<String, AssetMedia>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MediaRead {
    token: String,
    offset: u64,
    length: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MediaClose {
    token: String,
}

fn error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}

impl Server {
    pub fn new(kernel: Kernel) -> Self {
        Self {
            kernel: Some(kernel),
            state: State::New,
            plugin_access_directory: None,
            media: BTreeMap::new(),
        }
    }

    pub fn local() -> Self {
        Self {
            kernel: None,
            state: State::New,
            plugin_access_directory: None,
            media: BTreeMap::new(),
        }
    }

    pub fn with_plugin_access_directory(mut self, directory: std::path::PathBuf) -> Self {
        self.plugin_access_directory = Some(directory);
        self
    }

    pub fn handle(&mut self, message: Value) -> Option<Value> {
        if let Some(batch) = message.as_array() {
            if batch.is_empty() || batch.len() > MAX_BATCH {
                return Some(error(Value::Null, -32600, "批量请求数量无效。"));
            }
            let replies: Vec<_> = batch.iter().filter_map(|item| self.single(item)).collect();
            return (!replies.is_empty()).then_some(Value::Array(replies));
        }
        self.single(&message)
    }

    fn single(&mut self, message: &Value) -> Option<Value> {
        let id = message.get("id");
        let valid_id = id.is_none_or(|id| id.is_string() || id.is_number() || id.is_null());
        let method = message.get("method").and_then(Value::as_str);
        if !message.is_object()
            || message["jsonrpc"] != "2.0"
            || method.is_none()
            || !valid_id
            || message
                .get("params")
                .is_some_and(|p| !p.is_object() && !p.is_array())
        {
            return Some(error(Value::Null, -32600, "JSON-RPC 请求格式无效。"));
        }
        let method = method.unwrap();
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        // 业务通知不执行：写操作必须有请求关联及 Core operation_key 回执。
        let Some(id) = id else {
            if method == "initialized" && self.state == State::Initializing && params == json!({}) {
                self.state = State::Ready;
            } else if method == "exit" && self.state == State::Stopping {
                self.state = State::Exited;
            }
            return None;
        };
        let result = match method {
            "initialize" if self.state == State::New => {
                let Ok(input) = serde_json::from_value::<Initialize>(params) else {
                    return Some(error(id.clone(), -32602, "初始化参数无效。"));
                };
                if input.protocol_version != PROTOCOL_VERSION
                    || input.client_name.is_empty()
                    || input.client_name.len() > 120
                {
                    return Some(error(id.clone(), -32602, "桌面协议版本或客户端名称无效。"));
                }
                self.state = State::Initializing;
                let scope = self.kernel.as_ref().map_or_else(
                    || json!({"kind":"local"}),
                    |k| json!({"kind":k.scope_kind(),"id":k.scope()}),
                );
                json!({"protocol_version":PROTOCOL_VERSION,"server_version":env!("CARGO_PKG_VERSION"),
                    "max_message_bytes":MAX_MESSAGE_BYTES,"scope":scope})
            }
            "initialize" => return Some(error(id.clone(), -32600, "连接已经初始化。")),
            "workspace/request" if self.state == State::Ready => match &self.kernel {
                Some(kernel) => kernel.request(params),
                None => return Some(error(id.clone(), -32002, "连接未绑定作品。")),
            },
            "model_service/host" if self.state == State::Ready => {
                if !params.is_object()
                    || params.as_object().unwrap().len() != 2
                    || !params["input"].is_object()
                    || !matches!(
                        params["action"].as_str(),
                        Some(
                            "inspect"
                                | "connect"
                                | "poll"
                                | "disconnect"
                                | "catalog"
                                | "custom_save"
                                | "channel_select"
                                | "select"
                        )
                    )
                {
                    return Some(error(id.clone(), -32602, "模型设置参数无效。"));
                }
                hetu_core::model_service::ModelService::request(params)
            }
            "local_settings/host" if self.state == State::Ready => {
                match hetu_core::local_settings::LocalSettings::open_default()
                    .and_then(|settings| settings.host(params))
                {
                    Ok(value) => value,
                    Err(e) => {
                        let mut reply = error(id.clone(), -32003, &e.message);
                        reply["error"]["data"] = json!({"code":e.code});
                        return Some(reply);
                    }
                }
            }
            "plugins/directory" if self.state == State::Ready => {
                match hetu_core::plugin_settings::directory() {
                    Ok(directory) => json!({"directory":directory}),
                    Err(e) => return Some(error(id.clone(), -32602, &e.message)),
                }
            }
            "extensions/disable" if self.state == State::Ready => {
                let outcome = (|| {
                    let input = params.as_object().ok_or("撤权参数无效。")?;
                    if input.len() != 2 {
                        return Err("撤权参数无效。");
                    }
                    let owner = params["plugin_id"].as_str().ok_or("插件标识无效。")?;
                    let sha = params["package_sha256"].as_str().ok_or("插件摘要无效。")?;
                    let directory = self
                        .plugin_access_directory
                        .clone()
                        .map(Ok)
                        .unwrap_or_else(hetu_core::application::extensions::access_directory)
                        .map_err(|_| "私密目录不可用。")?;
                    hetu_core::application::extensions::disable_package_in(&directory, owner, sha)
                        .map_err(|_| "插件撤权未完成，请保留原状态并检查授权目录。")
                })();
                match outcome {
                    Ok(value) => value,
                    Err(message) => return Some(error(id.clone(), -32602, message)),
                }
            }
            "extensions/host" if self.state == State::Ready => {
                let Some(kernel) = &self.kernel else {
                    return Some(error(id.clone(), -32002, "连接未绑定作品。"));
                };
                match &self.plugin_access_directory {
                    Some(directory) => kernel.extension_host_request_in(directory, params),
                    None => kernel.extension_host_request(params),
                }
            }
            "extensions/request" if self.state == State::Ready => {
                let Some(kernel) = &self.kernel else {
                    return Some(error(id.clone(), -32002, "连接未绑定作品。"));
                };
                match &self.plugin_access_directory {
                    Some(directory) => kernel.extension_request_in(directory, params),
                    None => kernel.extension_request(params),
                }
            }
            "media/open" if self.state == State::Ready => {
                let Some(kernel) = &self.kernel else {
                    return Some(error(id.clone(), -32002, "连接未绑定作品。"));
                };
                if self.media.len() >= 8 {
                    return Some(error(
                        id.clone(),
                        -32001,
                        "媒体预览数量超过上限，请先关闭旧预览。",
                    ));
                }
                match kernel.open_asset_media(&params) {
                    Ok(reader) => {
                        let metadata = reader.metadata().clone();
                        self.media
                            .insert(metadata["token"].as_str().unwrap().into(), reader);
                        metadata
                    }
                    Err(e) => return Some(error(id.clone(), -32003, &e.message)),
                }
            }
            "media/read" if self.state == State::Ready => {
                let Ok(input) = serde_json::from_value::<MediaRead>(params) else {
                    return Some(error(id.clone(), -32602, "媒体读取参数无效。"));
                };
                let Some(reader) = self.media.get_mut(&input.token) else {
                    return Some(error(id.clone(), -32003, "媒体预览已关闭，请重新加载。"));
                };
                match reader.read(input.offset, input.length) {
                    Ok(value) => value,
                    Err(e) => {
                        self.media.remove(&input.token);
                        return Some(error(id.clone(), -32003, &e.message));
                    }
                }
            }
            "media/close" if self.state == State::Ready => {
                let Ok(input) = serde_json::from_value::<MediaClose>(params) else {
                    return Some(error(id.clone(), -32602, "媒体关闭参数无效。"));
                };
                self.media.remove(&input.token);
                Value::Null
            }
            "shutdown" if self.state == State::Ready && params == json!({}) => {
                self.media.clear();
                self.state = State::Stopping;
                Value::Null
            }
            "workspace/request" | "shutdown" => {
                return Some(error(id.clone(), -32002, "连接未就绪或正在退出。"));
            }
            _ => return Some(error(id.clone(), -32601, "未知桌面方法。")),
        };
        Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
    }

    pub fn run(&mut self, mut input: impl BufRead, mut output: impl Write) -> io::Result<()> {
        loop {
            let Some(line) = read_frame(&mut input)? else {
                return Ok(());
            };
            let response = match line {
                Ok(line) => match serde_json::from_slice(&line) {
                    Ok(message) => self.handle(message),
                    Err(_) => Some(error(Value::Null, -32700, "JSON 或 UTF-8 格式无效。")),
                },
                Err(()) => Some(error(Value::Null, -32600, "消息超过传输预算。")),
            };
            if let Some(response) = response {
                // 输出过大也不回显正文；原操作可能已完成，调用方须按原键恢复。
                let bytes = serde_json::to_vec(&response)?;
                if bytes.len() > MAX_MESSAGE_BYTES {
                    serde_json::to_writer(
                        &mut output,
                        &error(
                            response["id"].clone(),
                            -32001,
                            "结果超过传输预算；请按原操作查询或使用分页。",
                        ),
                    )?;
                } else {
                    output.write_all(&bytes)?;
                }
                output.write_all(b"\n")?;
                output.flush()?;
            }
            if self.state == State::Exited {
                return Ok(());
            }
        }
    }
}

// fill_buf 按块排空超限帧，避免 read_line 在校验前分配任意大小内存。
fn read_frame(input: &mut impl BufRead) -> io::Result<Option<Result<Vec<u8>, ()>>> {
    let mut bytes = Vec::new();
    let mut oversized = false;
    loop {
        let chunk = input.fill_buf()?;
        if chunk.is_empty() {
            return Ok(if oversized {
                Some(Err(()))
            } else if bytes.is_empty() {
                None
            } else {
                Some(Ok(bytes))
            });
        }
        let end = chunk.iter().position(|b| *b == b'\n');
        let count = end.map_or(chunk.len(), |n| n + 1);
        let content_count = end.unwrap_or(count);
        if !oversized {
            if bytes.len() + content_count > MAX_MESSAGE_BYTES {
                oversized = true;
                bytes.clear();
            } else {
                bytes.extend_from_slice(&chunk[..content_count]);
            }
        }
        input.consume(count);
        if end.is_some() {
            return Ok(Some(if oversized { Err(()) } else { Ok(bytes) }));
        }
    }
}
