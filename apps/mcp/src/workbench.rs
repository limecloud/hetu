//! 第一方工作台宿主桥接；普通Agent继续使用独立精确机器范围。
use super::*;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
};
pub const TOOL: &str = "hetu_app_request";
const MAX: usize = 8 * 1024 * 1024;
struct Process {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next: u64,
}
pub struct WorkbenchRuntime {
    directory: PathBuf,
    client: String,
    profile: Option<PathBuf>,
    sessions: Mutex<BTreeMap<String, Arc<Mutex<Option<Process>>>>>,
}
impl WorkbenchRuntime {
    pub fn new(directory: &Path, client: &str, profile: Option<PathBuf>) -> Self {
        Self {
            directory: directory.to_owned(),
            client: client.to_owned(),
            profile,
            sessions: Mutex::new(BTreeMap::new()),
        }
    }
    pub async fn open(&self) -> Result<String, ErrorData> {
        let mut sessions = self.sessions.lock().await;
        if sessions.len() >= 16 {
            return Err(ErrorData::invalid_request(
                "工作台数量已达上限，请关闭旧连接后重试。",
                None,
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        sessions.insert(id.clone(), Arc::new(Mutex::new(None)));
        Ok(id)
    }
    async fn spawn(&self) -> Result<Process, ErrorData> {
        let profile = self
            .profile
            .as_ref()
            .ok_or_else(|| ErrorData::invalid_request("无法确定当前连接的创作库目录。", None))?;
        let exe = std::env::current_exe().map_err(|_| failure())?;
        let bin = exe.parent().ok_or_else(failure)?;
        let packaged = bin
            .parent()
            .ok_or_else(failure)?
            .join("app/dist/mcp-workbench.mjs");
        let script = std::env::var_os("HETU_WORKBENCH_RUNTIME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if packaged.is_file() {
                    packaged
                } else {
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("../desktop/dist/mcp-workbench.mjs")
                }
            });
        if !script.is_absolute() || !script.is_file() {
            return Err(ErrorData::internal_error(
                "安装包缺少共享工作台宿主，请更新完整河图软件包。",
                None,
            ));
        }
        let node = std::env::var_os("HETU_PLUGIN_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let path = bin.join(if cfg!(windows) { "node.exe" } else { "node" });
                if path.is_file() {
                    path
                } else {
                    PathBuf::from("node")
                }
            });
        let mut child = Command::new(node)
            .arg(script)
            .env("HETU_WORKBENCH_BIN", bin)
            .env("HETU_WORKBENCH_CLIENT", &self.client)
            .env("HETU_WORKBENCH_PROFILE", profile)
            .env("HETU_COLLABORATION_DIR", &self.directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| failure())?;
        Ok(Process {
            input: child.stdin.take().ok_or_else(failure)?,
            output: BufReader::new(child.stdout.take().ok_or_else(failure)?),
            child,
            next: 0,
        })
    }
    pub async fn call(&self, args: JsonObject) -> Result<CallToolResponse, ErrorData> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Input {
            session: String,
            method: String,
            args: Vec<Value>,
            #[serde(default)]
            undefined_args: Vec<usize>,
        }
        let input: Input = serde_json::from_value(Value::Object(args))
            .map_err(|_| ErrorData::invalid_params("工作台桥接参数无效。", None))?;
        if input
            .undefined_args
            .iter()
            .any(|index| *index >= input.args.len())
        {
            return Err(ErrorData::invalid_params("工作台可选参数位置无效。", None));
        }
        if ![
            "close",
            "state",
            "library",
            "select",
            "dirty",
            "closeSurface",
            "bounds",
            "zoom",
            "copy",
            "paste",
            "execution",
            "installConnection",
            "installSuite",
            "models",
            "settings",
            "readingState",
            "fonts",
            "settingsAgent",
            "workAgent",
            "connection",
            "handoff",
            "writingPrompt",
            "mediaChunk",
            "open",
            "tasks",
            "read",
            "canon",
            "novel",
            "covers",
            "outlines",
            "video",
            "media",
            "resources",
            "versions",
            "author",
            "management",
            "buffer",
            "install",
            "toggle",
            "uninstall",
            "view",
            "fallback",
            "migrations",
            "pluginCall",
        ]
        .contains(&input.method.as_str())
        {
            return Err(ErrorData::invalid_params("工作台未提供此用例。", None));
        }
        let session = {
            let mut sessions = self.sessions.lock().await;
            if input.method == "close" {
                sessions.remove(&input.session)
            } else {
                sessions.get(&input.session).cloned()
            }
        }
        .ok_or_else(|| {
            ErrorData::invalid_request("工作台连接已关闭，请重新打开河图面板。", None)
        })?;
        let mut process = session.lock().await;
        if input.method == "close" {
            if let Some(mut worker) = process.take() {
                let _ = worker.input.shutdown().await;
                tokio::spawn(async move {
                    if tokio::time::timeout(Duration::from_secs(35), worker.child.wait())
                        .await
                        .is_err()
                    {
                        let _ = worker.child.kill().await;
                    }
                });
            }
            return Ok(CallToolResult::structured(json!({"value":null})).into());
        }
        if process.is_none() {
            *process = Some(self.spawn().await?);
        }
        let worker = process.as_mut().unwrap();
        worker.next += 1;
        let id = worker.next;
        let mut bytes =
            serde_json::to_vec(&json!({"id":id,"method":input.method,"args":input.args,"undefined_args":input.undefined_args}))
                .map_err(|_| failure())?;
        if bytes.len() > MAX {
            return Err(ErrorData::invalid_params("工作台输入超过预算。", None));
        }
        bytes.push(b'\n');
        let response = tokio::time::timeout(Duration::from_secs(330), async {
            worker
                .input
                .write_all(&bytes)
                .await
                .map_err(|_| failure())?;
            let mut line = Vec::new();
            (&mut worker.output)
                .take((MAX + 1) as u64)
                .read_until(b'\n', &mut line)
                .await
                .map_err(|_| failure())?;
            if line.len() > MAX || line.last() != Some(&b'\n') {
                return Err(failure());
            }
            let value: Value = serde_json::from_slice(&line).map_err(|_| failure())?;
            if value["id"] != id {
                return Err(failure());
            }
            Ok(value)
        })
        .await;
        let value = match response {
            Ok(Ok(value)) => value,
            _ => {
                if let Some(mut worker) = process.take() {
                    let _ = worker.child.kill().await;
                }
                return Err(failure());
            }
        };
        if value["ok"] != true {
            return Err(ErrorData::invalid_request(
                value["message"]
                    .as_str()
                    .unwrap_or("工作台操作未完成，原操作保留。")
                    .to_owned(),
                None,
            ));
        }
        Ok(CallToolResult::structured(
            json!({"value":value["value"],"copied":value["copied"],"events":value["events"]}),
        )
        .into())
    }
}
fn failure() -> ErrorData {
    ErrorData::internal_error(
        "共享工作台连接中断；写入结果请沿原操作回读，勿重复创建。",
        None,
    )
}
pub fn tool() -> Tool {
    let mut tool = Tool::default();
    tool.name = TOOL.into();
    tool.title = Some("河图工作台交互".into());
    tool.description = Some(
        "第一方工作台的应用用例桥接；供App页面使用。普通Agent继续使用精确CLI/MCP业务动作。".into(),
    );
    tool.input_schema=Arc::new(json!({"type":"object","additionalProperties":false,"required":["session","method","args"],"properties":{"session":{"type":"string"},"method":{"type":"string"},"args":{"type":"array"},"undefined_args":{"type":"array","items":{"type":"integer","minimum":0}}}}).as_object().unwrap().clone());
    tool.meta = Some(
        json!({"ui":{"visibility":["app"]}})
            .as_object()
            .unwrap()
            .clone()
            .into(),
    );
    tool.annotations = Some(ToolAnnotations::from_raw(
        None,
        Some(false),
        Some(true),
        Some(false),
        Some(false),
    ));
    tool
}
