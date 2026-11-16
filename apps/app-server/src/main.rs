use hetu_app_server::Server;
use hetu_core::Kernel;
use serde_json::json;
use std::io;
use std::path::PathBuf;

fn main() {
    if let Err(message) = start() {
        // stdout 仅承载协议；不把打开路径或作品内容写入诊断。
        eprintln!("{message}");
        std::process::exit(1);
    }
}

fn start() -> Result<(), String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() >= 2 && args[0] == "--stdio" && args[1] == "--local" {
        let mut server = Server::local();
        if args.len() == 4
            && args[2] == "--plugin-access-dir"
            && PathBuf::from(&args[3]).is_absolute()
        {
            server = server.with_plugin_access_directory(PathBuf::from(&args[3]));
        } else if args.len() != 2 {
            return Err("本机宿主参数无效。".into());
        }
        return server
            .run(io::stdin().lock(), io::stdout().lock())
            .map_err(|_| "桌面 stdio 通道已中断。".into());
    }
    if !matches!(args.len(), 3 | 5 | 7) || args[0] != "--stdio" || args[1] != "--workspace" {
        return Err(
            "用法：hetu-app-server --stdio --workspace <作品目录>；仅供可信桌面宿主启动。".into(),
        );
    }
    let path = PathBuf::from(&args[2]);
    if !path.is_absolute() || !path.is_dir() {
        return Err("桌面宿主必须绑定已存在作品的绝对目录。".into());
    }
    let mut plugin_directory = None;
    let mut git_authorizations = None;
    for pair in args[3..].chunks_exact(2) {
        let directory = PathBuf::from(&pair[1]);
        if !directory.is_absolute() {
            return Err("宿主私密目录须为绝对路径。".into());
        }
        let target = if pair[0] == "--plugin-access-dir" {
            &mut plugin_directory
        } else if pair[0] == "--git-authorizations-dir" {
            &mut git_authorizations
        } else {
            return Err("未知宿主启动参数。".into());
        };
        if target.replace(directory).is_some() {
            return Err("宿主启动参数不能重复。".into());
        }
    }
    // 目录由可信主进程确定；RPC 无 open/mode/actor/create 或私密路径接口。
    let mut options = json!({"workspace_path":path,"mode":"author"});
    if let Some(directory) = git_authorizations {
        options["authorization_path"] = json!(directory);
    }
    let kernel = Kernel::open(options).map_err(|e| e.to_string())?;
    let mut server = Server::new(kernel);
    if let Some(directory) = plugin_directory {
        server = server.with_plugin_access_directory(directory);
    }
    server
        .run(io::stdin().lock(), io::stdout().lock())
        .map_err(|_| "桌面 stdio 通道已中断。".into())
}
