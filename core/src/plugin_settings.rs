//! TS宿主拥有插件包与依赖；稳定机器连接转发固定安装选择及精确授权的动态调用。
use crate::{Error, Result, domain::ensure};
use serde_json::{Value, json};
use std::{path::PathBuf, process::Command, time::Duration};
pub fn directory() -> Result<PathBuf> {
    let path = std::env::var_os("HETU_PLUGIN_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or(
            crate::collaboration::default_directory()?
                .parent()
                .ok_or_else(|| Error::new("missing_context", "本机插件目录不可用。"))?
                .join("PluginHost"),
        );
    ensure(
        path.is_absolute(),
        "invalid_input",
        "插件状态目录须为绝对路径。",
    )?;
    Ok(path)
}
pub fn request(client: &str, action: &str, input: &Value) -> Result<Value> {
    request_cancellable(client, action, input, &|| false)
}
pub fn request_cancellable(
    client: &str,
    action: &str,
    input: &Value,
    cancelled: &dyn Fn() -> bool,
) -> Result<Value> {
    let exe = std::env::current_exe()?;
    let bin = exe
        .parent()
        .ok_or_else(|| Error::new("missing_context", "安装入口不可用。"))?;
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let packaged = bin.parent().unwrap().join("app/dist/plugin-manager.mjs");
    let script = std::env::var_os("HETU_PLUGIN_MANAGER")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if packaged.exists() {
                packaged
            } else {
                root.join("apps/desktop/dist/plugin-manager.mjs")
            }
        });
    ensure(
        script.is_absolute() && script.is_file(),
        "hetu.capability_unavailable",
        "安装包缺少插件管理宿主，请构建或更新完整软件包。",
    )?;
    let packaged_node = bin.join(format!("node{suffix}"));
    let node = std::env::var_os("HETU_PLUGIN_NODE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if packaged_node.is_file() {
                packaged_node
            } else {
                PathBuf::from("node")
            }
        });
    let plugin = std::env::var_os("HETU_PLUGIN_CLI")
        .map(PathBuf::from)
        .unwrap_or(bin.join(format!("hetu-plugin{suffix}")));
    let mut command = Command::new(node);
    command
        .arg(script)
        .arg("--directory")
        .arg(directory()?)
        .arg("--core-cli")
        .arg(plugin);
    let bytes = crate::process_supervisor::run(
        &mut command,
        serde_json::to_vec(&json!({"client_adapter":client,"action":action,"input":input}))?,
        Duration::from_secs(45),
        4 * 1024 * 1024,
        cancelled,
    )?;
    let response: Value = serde_json::from_slice(&bytes)?;
    ensure(
        response["ok"] == true,
        "hetu.plugin_operation_failed",
        response["message"]
            .as_str()
            .unwrap_or("插件操作未完成，请按原键回读。"),
    )?;
    Ok(response["data"].clone())
}
