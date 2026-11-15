//! 本机偏好与宿主安装归原生 Owner，稳定 MCP 委托同包 CLI，不复制一套配置存储。
use super::*;
use std::{io::{Read, Write}, process::{Command, Stdio}, time::{Duration, Instant}};

impl CollaborationHub {
    pub(super) fn execute_local(&self, request: &Value) -> Result<Value> {
        let helper = std::env::current_exe()?.with_file_name(if cfg!(windows) { "hetu.exe" } else { "hetu" });
        let metadata = std::fs::symlink_metadata(&helper).map_err(|_| Error::new("hetu.capability_unavailable", "本次运行缺少同包本机设置入口，请使用已安装应用的 CLI/MCP。"))?;
        ensure(metadata.is_file() && !metadata.file_type().is_symlink(), "hetu.unsafe_path", "本机设置入口必须为同包常规可执行文件。")?;
        let action = text(request,"action")?;
        let mut child = Command::new(helper).args(["--local", "--client", &self.client, "call", action, "--input", "-", "--json"])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
        let output = child.stdout.take().unwrap();
        let reader = std::thread::spawn(move || { let mut data = Vec::new(); output.take(16*1024*1024+1).read_to_end(&mut data).map(|_| data) });
        child.stdin.take().unwrap().write_all(&serde_json::to_vec(&request["input"])?)?;
        let started = Instant::now();
        loop {
            if child.try_wait()?.is_some() { break; }
            if started.elapsed() > Duration::from_secs(240) {
                let _ = child.kill(); let _ = child.wait();
                return Err(Error::new("result_unknown", "本机操作未返回，请保留原操作引用并回读，不重复安装。"));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let bytes = reader.join().map_err(|_| Error::new("result_unknown", "本机结果读取中断，请查询原方案。"))??;
        ensure(bytes.len() <= 16*1024*1024, "hetu.budget_exceeded", "本机操作回读超过大小上限。")?;
        let result: Value = serde_json::from_slice(&bytes)?;
        ensure(result["action"] == action && result["contract_revision"] == "1", "hetu.integrity_failure", "本机操作结果合同不一致。")?;
        Ok(result)
    }
}
