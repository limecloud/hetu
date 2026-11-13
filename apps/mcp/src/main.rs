use hetu_mcp::{HetuServer, MAX_MESSAGE_BYTES, ScopeKind};
use rmcp::{ServiceExt, service::ServerInitializeError, transport::async_rw::AsyncRwTransport};
use std::{path::PathBuf, process::ExitCode};

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let first = args.next();
    if matches!(
        first.as_deref().and_then(|s| s.to_str()),
        Some("--help" | "-h")
    ) && args.next().is_none()
    {
        println!(
            "河图洛书 MCP Server / Hetu Luoshu MCP Server\n\nhetu-mcp --workspace <absolute path> [--task <task_id>]\nhetu-mcp --creation-project <absolute path> --task <task_id>\n\nstdio · MCP 2026-07-28 · Agent 权限 / Agent permissions"
        );
        return ExitCode::SUCCESS;
    }
    let kind = match first.as_deref().and_then(|s| s.to_str()) {
        Some("--workspace") => ScopeKind::Workspace,
        Some("--creation-project") => ScopeKind::CreationProject,
        _ => {
            eprintln!(
                "用法 / Usage: hetu-mcp --workspace <absolute path> [--task <task_id>] | --creation-project <absolute path> --task <task_id>"
            );
            return ExitCode::from(2);
        }
    };
    let Some(path) = args.next().map(PathBuf::from) else {
        eprintln!("需要工作区绝对路径 / Absolute workspace path required");
        return ExitCode::from(2);
    };
    let task = match args.next() {
        None if matches!(kind, ScopeKind::Workspace) => None,
        Some(flag) if flag == "--task" => match args
            .next()
            .and_then(|s| s.into_string().ok())
            .filter(|s| !s.is_empty())
        {
            Some(task) => Some(task),
            None => {
                eprintln!("需要任务 ID / Task ID required");
                return ExitCode::from(2);
            }
        },
        _ => {
            eprintln!(
                "筹备须绑定任务，不支持身份覆盖 / Creation projects require a bound task; identity overrides are not supported"
            );
            return ExitCode::from(2);
        }
    };
    if args.next().is_some() {
        eprintln!(
            "不支持额外参数或身份覆盖 / Extra arguments and identity overrides are not supported"
        );
        return ExitCode::from(2);
    }
    let opened = if let Some(task) = task {
        HetuServer::open_task(&path, kind, &task)
    } else {
        HetuServer::open(&path)
    };
    let server = match opened {
        Ok(server) => server,
        Err(_) => {
            eprintln!(
                "无法以 Agent 权限打开工作区，请检查路径、权限和完整性。 / Cannot open workspace as Agent; check path, permissions and integrity."
            );
            return ExitCode::FAILURE;
        }
    };
    let (reader, writer) = rmcp::transport::stdio_pipes();
    let transport = AsyncRwTransport::new(reader, writer).with_max_line_length(MAX_MESSAGE_BYTES);
    match server.serve(transport).await {
        Ok(service) => match service.waiting().await {
            Ok(_) => ExitCode::SUCCESS,
            Err(_) => {
                eprintln!(
                    "MCP 连接结束异常；写请求请沿原键恢复。 / MCP connection ended unexpectedly; recover writes with the original key."
                );
                ExitCode::FAILURE
            }
        },
        Err(ServerInitializeError::ConnectionClosed(_)) => ExitCode::SUCCESS,
        Err(_) => {
            eprintln!("MCP 传输失败 / MCP transport failed");
            ExitCode::FAILURE
        }
    }
}
