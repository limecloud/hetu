//! 专业插件数据的独立受限入口；基础业务仍使用 hetu CLI。
use hetu_core::application::extensions::{PluginSession, access_directory};
use hetu_core::Kernel;
use serde_json::{Value, json};
use std::{
    io::{self, Read},
    path::PathBuf,
    process::ExitCode,
};
fn run() -> Result<Value, String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args == ["--help"] {
        return Ok(
            json!({"usage":"hetu-plugin --workspace <absolute> --grant <grant_id> --package-sha256 <sha> [--access-dir <absolute>] call <action> --input -","identity":"scoped plugin; no author override"}),
        );
    }
    if args == ["disable-package", "--input", "-"] {
        let mut bytes = Vec::new();
        io::stdin()
            .take(16385)
            .read_to_end(&mut bytes)
            .map_err(|_| "输入无法读取。")?;
        if bytes.len() > 16384 {
            return Err("撤权输入超过预算。".into());
        }
        let input: Value = serde_json::from_slice(&bytes).map_err(|_| "撤权输入无效。")?;
        if input["authorization_note"]
            .as_str()
            .is_none_or(|s| s.trim().is_empty())
            || input["operation_key"].as_str().is_none_or(|s| s.is_empty())
        {
            return Err("须提供真实安装选择和原键。".into());
        }
        return hetu_core::application::extensions::disable_package_in(
            &access_directory().map_err(|e| e.to_string())?,
            input["plugin_id"].as_str().ok_or("插件标识无效。")?,
            input["package_sha256"].as_str().ok_or("插件摘要无效。")?,
        )
        .map_err(|e| e.to_string());
    }
    let mut values = std::collections::BTreeMap::new();
    let mut index = 0;
    while args.get(index).is_some_and(|a| a.starts_with("--")) {
        let name = &args[index];
        if !matches!(
            name.as_str(),
            "--workspace" | "--grant" | "--package-sha256" | "--access-dir" | "--context-file"
        ) {
            return Err("不支持的连接参数。".into());
        }
        let value = args.get(index + 1).ok_or("连接参数缺值。")?;
        if values.insert(name.as_str(), value.as_str()).is_some() {
            return Err("连接参数重复。".into());
        }
        index += 2;
    }
    let tail = &args[index..];
    if tail != ["inspect"]
        && (tail.len() != 4 || tail[0] != "call" || tail[2] != "--input" || tail[3] != "-")
    {
        return Err("使用 call <action> --input -，输入UTF-8 JSON。".into());
    }
    let required = |key| {
        values
            .get(key)
            .copied()
            .ok_or_else(|| format!("缺少参数：{key}"))
    };
    let path = PathBuf::from(required("--workspace")?);
    if !path.is_absolute() {
        return Err("作品目录必须为绝对路径。".into());
    }
    if let Some(file) = values.get("--context-file") {
        let raw = std::fs::read(file).map_err(|_| "插件上下文无法读取。")?;
        if raw.len() > 1024 * 1024 { return Err("插件上下文超过预算。".into()); }
        let context: Value = serde_json::from_slice(&raw).map_err(|_| "插件上下文无效。")?;
        if context["context"]["package_sha256"] != required("--package-sha256")? {
            return Err("插件上下文与包摘要不一致。".into());
        }
        let kernel = Kernel::open_plugin_kernel(&path, context.get("management_binding").cloned())
            .map_err(|e| e.to_string())?;
        let request = if tail == ["inspect"] {
            json!({"action":"hetu.plugins.catalog","contract_revision":"1","input":{}})
        } else {
            let mut bytes = Vec::new();
            io::stdin().take(1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|_| "输入无法读取。")?;
            if bytes.len() > 1024 * 1024 { return Err("输入超过预算。".into()); }
            let input: Value = serde_json::from_slice(&bytes).map_err(|_| "输入不是 JSON。")?;
            json!({"action":tail[1],"contract_revision":"1","input":input})
        };
        return Ok(kernel.open_plugin_request(json!({"context":context["context"],"request":request})));
    }
    let directory = values
        .get("--access-dir")
        .map(|p| Ok(PathBuf::from(p)))
        .unwrap_or_else(access_directory)
        .map_err(|e| e.to_string())?;
    let session = PluginSession::open(
        &path,
        &directory,
        required("--grant")?,
        required("--package-sha256")?,
    )
    .map_err(|e| e.to_string())?;
    if tail == ["inspect"] {
        return Ok(session.inspect());
    }
    let mut bytes = Vec::new();
    io::stdin()
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取输入。")?;
    if bytes.len() > 1024 * 1024 {
        return Err("输入超过1MiB。".into());
    }
    let input: Value = serde_json::from_slice(&bytes).map_err(|_| "输入不是有效JSON。")?;
    Ok(session.request(json!({"action":tail[1],"contract_revision":"1","input":input})))
}
fn main() -> ExitCode {
    match run() {
        Ok(result) => {
            let code = if result.get("status").is_none() || result["status"] == "succeeded" {
                0
            } else {
                match result["error"]["code"].as_str() {
                    Some("permission_denied" | "forbidden") => 3,
                    Some("revision_conflict" | "idempotency_conflict") => 4,
                    Some("invalid_input") => 2,
                    _ => 5,
                }
            };
            println!("{result}");
            ExitCode::from(code)
        }
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(2)
        }
    }
}
