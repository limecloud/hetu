//! TS宿主拥有插件包与依赖；稳定机器连接只转发固定安装选择。
use crate::{Error, Result, domain::ensure};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
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
    let mut child = Command::new(node)
        .arg(script)
        .arg("--directory")
        .arg(directory()?)
        .arg("--core-cli")
        .arg(plugin)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    child.stdin.take().unwrap().write_all(&serde_json::to_vec(
        &json!({"client_adapter":client,"action":action,"input":input}),
    )?)?;
    let stdout = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let started = Instant::now();
    while child.try_wait()?.is_none() {
        if started.elapsed() > Duration::from_secs(45) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::new(
                "hetu.outcome_unknown",
                "插件操作结果未知，请按原键回读。",
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let bytes = reader
        .join()
        .map_err(|_| Error::new("hetu.outcome_unknown", "插件回读未完成。"))??;
    ensure(
        bytes.len() <= 4 * 1024 * 1024,
        "hetu.budget_exceeded",
        "插件管理结果超过预算。",
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
