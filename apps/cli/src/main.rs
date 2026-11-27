//! 独立机器入口：身份和业务规则仍由 Core 核验，不经过桌面作者通道。
use hetu_core::{
    Error, Kernel, Result, collaboration, failure_result, model_service::ModelService,
};
use serde_json::{Value, json};
use std::{
    env,
    fs::File,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::ExitCode,
};

const INPUT_LIMIT: u64 = 16 * 1024 * 1024;

fn help(english: bool) -> &'static str {
    if english {
        "Hetu Luoshu command line\n\n\
hetu [--locale zh-CN|en] --help\n\
hetu --version\n\
hetu --client <client> doctor\n\
hetu --client <codex|claude-code|workbuddy|generic> [--collaboration-dir <absolute path>] collaboration inspect\n\
hetu --client <client> [--collaboration-dir <absolute path>] collaboration open --input <JSON file|->\n\
hetu --client <client> [--collaboration-dir <absolute path>] call <hetu.action> --input <JSON file|-> [--json]\n\
hetu --workspace <absolute path> [--task <task_id>] capabilities\n\
hetu --workspace <absolute path> [--task <task_id>] call <hetu.action> --input <JSON file|-> [--json]\n\
hetu --creation-project <absolute path> --task <task_id> call <hetu.action> --input <JSON file|->\n\
hetu --workspace <absolute path> bundle verify <bundle_id>\n\
hetu model-service <status|login|poll>\n\n\
Calls return one AXI JSON result. Input is a UTF-8 JSON object, up to 16 MiB.\n\
Start without a workspace: inspect, then use the discovered creation action.\n\
Keep the management reference, reserved directory and operation key.\n\
This entry stays an Agent. Read hetu.execution.get_mode: auto runs workspace actions directly; confirm reads directly and confirms one fixed write plan. Keep CAS, original operation keys and recovery.\n"
    } else {
        "河图洛书命令行\n\n\
hetu [--locale zh-CN|en] --help\n\
hetu --version\n\
hetu --client <client> doctor\n\
hetu --client <codex|claude-code|workbuddy|generic> [--collaboration-dir <绝对目录>] collaboration inspect\n\
hetu --client <客户端> [--collaboration-dir <绝对目录>] collaboration open --input <JSON文件|->\n\
hetu --client <客户端> [--collaboration-dir <绝对目录>] call <hetu.action> --input <JSON文件|-> [--json]\n\
hetu --workspace <绝对目录> [--task <任务ID>] capabilities\n\
hetu --workspace <绝对目录> [--task <任务ID>] call <hetu.action> --input <JSON文件|-> [--json]\n\
hetu --creation-project <绝对目录> --task <任务ID> call <hetu.action> --input <JSON文件|->\n\
hetu --workspace <绝对目录> bundle verify <bundle_id>\n\
hetu model-service <status|login|poll>\n\n\
调用返回单个AXI JSON结果，输入须为完整UTF-8 JSON对象，最多16MiB。\n\
从零开始无需工作区：先inspect，再使用已发现的新建动作。\n\
保留管理引用、预留目录与原操作键，按实际能力继续。\n\
本入口保持Agent身份。先读hetu.execution.get_mode：auto直接处理当前工作区；confirm读取直通，写入集中确认固定计划。保留CAS、原操作键及恢复。\n"
    }
}

fn input_error() -> Error {
    Error::new("invalid_input", "参数无效，请运行 hetu --help。")
}

fn input(path: &str) -> Result<Value> {
    let reader: Box<dyn Read> = if path == "-" {
        Box::new(io::stdin())
    } else {
        Box::new(File::open(path)?)
    };
    let mut bytes = Vec::new();
    reader.take(INPUT_LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > INPUT_LIMIT {
        return Err(Error::new("invalid_input", "输入超过16MiB上限。"));
    }
    // 接受常见编辑器写出的 UTF-8 BOM；预算仍按完整输入字节计算。
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
    let value: Value = serde_json::from_slice(bytes)?;
    if !value.is_object() {
        return Err(input_error());
    }
    Ok(value)
}

fn absolute(value: &str) -> Result<PathBuf> {
    if !Path::new(value).is_absolute() {
        return Err(input_error());
    }
    Ok(PathBuf::from(value))
}

enum Connection {
    Stable {
        client: String,
        directory: Option<PathBuf>,
    },
    Workspace {
        path: PathBuf,
        creation: bool,
        task: Option<String>,
    },
    Local {
        client: String,
    },
}
struct Call {
    connection: Connection,
    action: String,
    input_path: Option<String>,
    fixed_input: Value,
}

fn call_args(command: &[String], stable: bool) -> Result<(String, Option<String>, Value)> {
    if stable && command == ["doctor"] {
        return Ok(("hetu.runtime.inspect".into(), None, json!({})));
    }
    if command == ["capabilities"] || (stable && command == ["collaboration", "inspect"]) {
        return Ok((
            if stable {
                "hetu.collaboration.inspect"
            } else {
                "hetu.capabilities.get"
            }
            .into(),
            None,
            json!({}),
        ));
    }
    if !stable && command.len() == 3 && command[0] == "bundle" && command[1] == "verify" {
        return Ok((
            "hetu.bundles.verify".into(),
            None,
            json!({"bundle_id":command[2]}),
        ));
    }
    if command.len() != 4 || command[2] != "--input" {
        return Err(input_error());
    }
    let action = if stable && command[1] == "request" && matches!(command[0].as_str(), "session" | "bot" | "computer") {
        match command[0].as_str(){"session"=>"hetu.sessions.request","bot"=>"hetu.bots.request",_=>"hetu.computer.request"}.into()
    } else if stable && command[0] == "collaboration" && command[1] == "open" {
        "hetu.collaboration.open".into()
    } else if command[0] == "call" {
        command[1].clone()
    } else {
        return Err(input_error());
    };
    if !action.starts_with("hetu.")
        || action.len() > 128
        || action.ends_with('.')
        || action.contains("..")
        || !action
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'.')
    {
        return Err(input_error());
    }
    Ok((action, Some(command[3].clone()), Value::Null))
}

fn parse(args: &[String]) -> Result<Call> {
    let mut args = args;
    if args.last().is_some_and(|arg| arg == "--json") {
        args = &args[..args.len() - 1];
    }
    if args.first().is_some_and(|s| s == "--local") {
        if args.len() != 7 || args[1] != "--client" || args[3] != "call" {
            return Err(input_error());
        }
        let (action, input_path, fixed_input) = call_args(&args[3..], false)?;
        if !action.starts_with("hetu.local_settings.") {
            return Err(input_error());
        }
        return Ok(Call {
            connection: Connection::Local {
                client: args[2].clone(),
            },
            action,
            input_path,
            fixed_input,
        });
    }
    if args.len() < 3 {
        return Err(input_error());
    }
    let mut command = &args[2..];
    let stable = args[0] == "--client";
    let connection = if stable {
        let mut directory = None;
        if command.first().is_some_and(|s| s == "--collaboration-dir") {
            if command.len() < 3 {
                return Err(input_error());
            }
            directory = Some(absolute(&command[1])?);
            command = &command[2..];
        }
        Connection::Stable {
            client: args[1].clone(),
            directory,
        }
    } else if matches!(args[0].as_str(), "--workspace" | "--creation-project") {
        let path = absolute(&args[1])?;
        let mut task = None;
        if command.first().is_some_and(|s| s == "--task") {
            if command.len() < 3 {
                return Err(input_error());
            }
            task = Some(command[1].clone());
            command = &command[2..];
        }
        let creation = args[0] == "--creation-project";
        if creation && task.is_none() {
            return Err(input_error());
        }
        Connection::Workspace {
            path,
            creation,
            task,
        }
    } else {
        return Err(input_error());
    };
    let (action, input_path, fixed_input) = call_args(command, stable)?;
    Ok(Call {
        connection,
        action,
        input_path,
        fixed_input,
    })
}

fn execute(call: Call) -> Value {
    let scope = if matches!(call.connection, Connection::Local { .. }) {
        "local"
    } else {
        "collaboration"
    };
    let result = (|| -> Result<Value> {
        let fields = match &call.input_path {
            Some(path) => input(path)?,
            None => call.fixed_input,
        };
        let request = json!({"action":call.action,"contract_revision":"1","input":fields});
        match call.connection {
            Connection::Stable { client, directory } => {
                let directory = directory
                    .map(Ok)
                    .unwrap_or_else(collaboration::default_directory)?;
                Ok(collaboration::CollaborationHub::open(&directory, &client)?.request(request))
            }
            Connection::Workspace {
                path,
                creation,
                task,
            } => {
                if !creation && task.is_none() {
                    let execution = hetu_core::execution::WorkspaceExecution::open_default("generic")?;
                    return Ok(if call.action.starts_with("hetu.execution.") {
                        let mut request = request;
                        if matches!(call.action.as_str(),"hetu.execution.invoke"|"hetu.execution.prepare"|"hetu.execution.initialize") && request["input"].get("workspace_path").is_none() {
                            request["input"]["workspace_path"] = json!(path);
                        }
                        execution.request(request)
                    } else {execution.request_workspace(&path,request)});
                }
                let mut config = json!({"mode":"agent"});
                config[if creation {
                    "creation_project_path"
                } else {
                    "workspace_path"
                }] = json!(path);
                if let Some(task) = task {
                    config["task_id"] = json!(task);
                }
                Ok(Kernel::open(config)?.request(request))
            }
            Connection::Local { client } => {
                Ok(hetu_core::local_settings::LocalSettings::open_default()?
                    .request(&client, request))
            }
        }
    })();
    result.unwrap_or_else(|error| failure_result(&call.action, scope, &error))
}

fn model_service(command: &str) -> Value {
    let request = |action| ModelService::request(json!({"action":action,"input":{}}));
    let mut result = request(if command == "login" {
        "connect"
    } else {
        "inspect"
    });
    if result["status"] != "succeeded" {
        return result;
    }
    if command == "poll" && result["data"]["pending"]["verification_uri"].is_string() {
        let polled = request("poll");
        if polled["status"] != "succeeded" {
            return polled;
        }
        if polled["data"]["status"] != "pending" {
            result = polled;
        }
    }
    let data = &result["data"];
    let mut visible = json!({});
    for key in ["connected", "origin", "account_ref", "expires_at"] {
        visible[key] = data[key].clone();
    }
    let pending = data["pending"]["verification_uri"].is_string();
    if pending {
        visible["pending"] = json!({"verification_uri":data["pending"]["verification_uri"],"verification_code":data["pending"]["verification_code"]});
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let expired = data["expires_at"]
        .as_u64()
        .is_some_and(|expires| expires <= now);
    let state = if pending {
        "pending"
    } else if data["connected"] == true {
        "connected"
    } else if expired {
        "expired"
    } else {
        "disconnected"
    };
    visible["connection_state"] = json!(state);
    if state != "connected" {
        visible["next_action"] = json!(format!(
            "hetu model-service {}",
            if pending { "poll" } else { "login" }
        ));
    }
    result["data"] = visible;
    result
}

fn exit_code(value: &Value) -> u8 {
    match value["status"].as_str() {
        Some("succeeded") => return 0,
        Some("partial" | "cancelled") => return 6,
        Some("unknown") => return 7,
        _ => {}
    }
    match value["error"]["code"].as_str() {
        Some("invalid_input") => 2,
        Some("forbidden" | "hetu.author_confirmation_required") => 3,
        Some(
            "revision_conflict"
            | "idempotency_conflict"
            | "hetu.stale_evidence"
            | "hetu.stale_request",
        ) => 4,
        Some("result_unknown") => 7,
        Some("unsupported_version" | "hetu.capability_unavailable") => 8,
        _ => 5,
    }
}

fn main() -> ExitCode {
    let args: std::result::Result<Vec<String>, _> = env::args_os()
        .skip(1)
        .map(|arg| arg.into_string())
        .collect();
    let invalid = || failure_result("hetu.request.invalid", "local", &input_error());
    let mut args = match args {
        Ok(args) => args,
        Err(_) => return emit(invalid()),
    };
    let mut english = false;
    if args.first().is_some_and(|s| s == "--locale") {
        if args.len() < 2 || !matches!(args[1].as_str(), "zh-CN" | "en") {
            return emit(invalid());
        }
        english = args[1] == "en";
        args.drain(..2);
    }
    if args.is_empty() || args == ["--help"] || args == ["-h"] {
        return write_output(help(english).as_bytes(), 0);
    }
    if args == ["--version"] {
        return write_output(
            format!("hetu {}\n", env!("CARGO_PKG_VERSION")).as_bytes(),
            0,
        );
    }
    if args.first().is_some_and(|s| s == "model-service") {
        if args.last().is_some_and(|s| s == "--json") {
            args.pop();
        }
        if args.len() != 2 || !matches!(args[1].as_str(), "status" | "login" | "poll") {
            return emit(invalid());
        }
        return emit(model_service(&args[1]));
    }
    emit(match parse(&args) {
        Ok(call) => execute(call),
        Err(_) => invalid(),
    })
}

fn emit(result: Value) -> ExitCode {
    let code = exit_code(&result);
    match serde_json::to_vec(&result) {
        Ok(mut bytes) => {
            bytes.push(b'\n');
            write_output(&bytes, code)
        }
        Err(_) => ExitCode::from(5),
    }
}
fn write_output(bytes: &[u8], code: u8) -> ExitCode {
    let mut stdout = io::stdout().lock();
    if stdout
        .write_all(bytes)
        .and_then(|_| stdout.flush())
        .is_err()
    {
        return ExitCode::from(5);
    }
    ExitCode::from(code)
}
