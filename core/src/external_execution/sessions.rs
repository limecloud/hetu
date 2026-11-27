//! 无窗口宿主与桌面共用会话类；机器连接只控制本客户端的固定会话。
use super::{definition, private_dir, read_checked};
use crate::{
    Error, Result, collaboration::CollaborationHub, domain::ensure, local_settings::LocalSettings,
};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddrV4, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

pub(crate) struct SessionBroker {
    root: PathBuf,
    client: String,
    collaboration: PathBuf,
}
impl SessionBroker {
    pub(crate) fn new(directory: &Path, client: &str) -> Result<Self> {
        ensure(
            directory.is_absolute()
                && matches!(client, "codex" | "claude-code" | "workbuddy" | "generic"),
            "invalid_input",
            "外部会话位置或客户端无效。",
        )?;
        Ok(Self {
            root: directory.join("sessions").join(client),
            client: client.into(),
            collaboration: directory.to_owned(),
        })
    }
    fn record(&self) -> Result<Option<Value>> {
        let file = self.root.join("instance.json");
        if !file.try_exists()? {
            return Ok(None);
        }
        let value: Value = serde_json::from_slice(&read_checked(&file, 4096)?)?;
        ensure(
            value["version"] == 1
                && value["pid"].as_u64().is_some_and(|pid| pid > 0)
                && value["port"]
                    .as_u64()
                    .is_some_and(|port| port > 0 && port <= 65535)
                && value["secret"].as_str().is_some_and(|secret| {
                    secret.len() == 64 && secret.bytes().all(|byte| byte.is_ascii_hexdigit())
                }),
            "hetu.integrity_failure",
            "外部会话宿主记录无效，已保留原文件。",
        )?;
        Ok(Some(value))
    }
    fn connect(record: &Value) -> std::io::Result<TcpStream> {
        TcpStream::connect_timeout(
            &SocketAddrV4::new(Ipv4Addr::LOCALHOST, record["port"].as_u64().unwrap() as u16).into(),
            Duration::from_millis(300),
        )
    }
    fn ensure(&self) -> Result<Value> {
        private_dir(&self.root)?;
        let store = crate::infrastructure::store::Store::open(&self.root)?;
        store.directory(".hetu/transactions")?;
        let _lock = store.lock()?;
        if let Some(record) = self.record()? {
            match Self::connect(&record) {
                Ok(_) => return Ok(record),
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound
                    ) => {}
                Err(_) => {
                    return Err(Error::new(
                        "hetu.runtime_unavailable",
                        "原会话宿主状态无法核对，没有启动替代进程。",
                    ));
                }
            }
        }
        let executable = std::env::current_exe()?;
        let bin = executable
            .parent()
            .ok_or_else(|| Error::new("invalid_input", "缺少运行时目录。"))?;
        let development = matches!(
            bin.file_name().and_then(|value| value.to_str()),
            Some("debug" | "release")
        );
        let packaged = bin
            .parent()
            .unwrap_or(bin)
            .join("app/dist/agent-machine-service.mjs");
        let script = if packaged.is_file() {
            packaged
        } else if development {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../apps/desktop/dist/agent-machine-service.mjs")
        } else {
            return Err(Error::new(
                "hetu.runtime_unavailable",
                "当前安装缺少外部会话宿主。",
            ));
        };
        ensure(
            script.is_file(),
            "hetu.runtime_unavailable",
            "请构建或安装当前外部会话运行时。",
        )?;
        let node = std::env::var_os("HETU_PLUGIN_NODE")
            .map(PathBuf::from)
            .or_else(|| {
                let bundled = bin.join(if cfg!(windows) { "node.exe" } else { "node" });
                if bundled.is_file() {
                    return Some(bundled);
                }
                if development {
                    std::env::var_os("PATH").and_then(|paths| {
                        std::env::split_paths(&paths)
                            .map(|path| path.join(if cfg!(windows) { "node.exe" } else { "node" }))
                            .find(|path| path.is_file())
                    })
                } else {
                    None
                }
            })
            .ok_or_else(|| {
                Error::new("hetu.runtime_unavailable", "当前制品缺少受管Node运行时。")
            })?;
        ensure(
            node.is_absolute(),
            "invalid_input",
            "受管Node路径必须为绝对路径。",
        )?;
        let mut command = Command::new(&node);
        command
            .arg(&script)
            .env("HETU_AGENT_SERVICE", "1")
            .env("HETU_AGENT_SERVICE_DIR", &self.root)
            .env("HETU_AGENT_PROFILE", self.root.join("profile"))
            .env("HETU_AGENT_BIN_DIR", bin)
            .env("HETU_AGENT_CLIENT", &self.client)
            .env("HETU_COLLABORATION_DIR", &self.collaboration)
            .env("HETU_PLUGIN_NODE", &node)
            .env_remove("ELECTRON_RUN_AS_NODE")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn()?;
        for _ in 0..100 {
            if let Some(record) = self.record()?
                && Self::connect(&record).is_ok()
            {
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Ok(record);
            }
            if child.try_wait()?.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        Err(Error::new(
            "hetu.runtime_unavailable",
            "外部会话宿主未就绪，请核对原进程；没有发送输入。",
        ))
    }
    pub(crate) fn exchange(&self, input: Value) -> Result<Value> {
        let record = self.ensure()?;
        let mut stream = Self::connect(&record)
            .map_err(|_| Error::new("hetu.runtime_unavailable", "原外部会话宿主未连接。"))?;
        stream.set_read_timeout(Some(Duration::from_secs(45)))?;
        stream.set_write_timeout(Some(Duration::from_secs(10)))?;
        Self::exchange_stream(&mut stream, &record["secret"], &input)
    }
    fn exchange_stream(
        stream: &mut (impl Read + Write),
        secret: &Value,
        input: &Value,
    ) -> Result<Value> {
        let read_only = is_read_method(input["method"].as_str().unwrap_or_default());
        ensure(
            read_only
                || input["operation_key"]
                    .as_str()
                    .is_some_and(|key| !key.is_empty() && key.len() <= 160),
            "invalid_input",
            "会话写入缺少原operation_key，没有派发请求。",
        )?;
        let mut bytes = serde_json::to_vec(&json!({"secret":secret,"input":input}))?;
        bytes.push(b'\n');
        ensure(
            bytes.len() <= 1024 * 1024,
            "hetu.budget_exceeded",
            "会话请求超过传输预算。",
        )?;
        stream.write_all(&bytes).map_err(|_| {
            Error::new(
                if read_only {
                    "hetu.runtime_unavailable"
                } else {
                    "hetu.outcome_unknown"
                },
                if read_only {
                    "会话读取请求未送达，请重试原读取请求。"
                } else {
                    "会话写入结果未知，请查询原operation_key。"
                },
            )
        })?;
        let mut output = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let count = stream.read(&mut chunk).map_err(|error| {
                if read_only {
                    Error::new(
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                        ) {
                            "session_read_timeout"
                        } else {
                            "hetu.runtime_unavailable"
                        },
                        "会话读取未完成，请重试原读取请求。",
                    )
                } else {
                    Error::new(
                        "hetu.outcome_unknown",
                        "会话回执未知，请查询原operation_key。",
                    )
                }
            })?;
            if count == 0 {
                break;
            }
            output.extend_from_slice(&chunk[..count]);
            ensure(
                output.len() <= 1024 * 1024,
                if read_only {
                    "hetu.output_budget_exceeded"
                } else {
                    "hetu.outcome_unknown"
                },
                if read_only {
                    "会话读取回包超过预算，请缩小原读取范围。"
                } else {
                    "会话回执超过预算，写入结果待核对；请查询原operation_key。"
                },
            )?;
            if output.last() == Some(&b'\n') {
                break;
            }
        }
        let invalid_response = || {
            Error::new(
                if read_only {
                    "hetu.integrity_failure"
                } else {
                    "hetu.outcome_unknown"
                },
                if read_only {
                    "会话读取回包无法核对，请重试原读取请求。"
                } else {
                    "会话回执无法核对，请查询原operation_key。"
                },
            )
        };
        let response: Value = serde_json::from_slice(&output).map_err(|_| invalid_response())?;
        if !response["ok"].is_boolean()
            || response["ok"] == true && response.get("result").is_none()
        {
            return Err(invalid_response());
        }
        if response["ok"] != true {
            return Err(Error::new(
                if response["unknown"] == true {
                    if read_only {
                        "hetu.runtime_unavailable"
                    } else {
                        "hetu.outcome_unknown"
                    }
                } else {
                    "external_request_rejected"
                },
                response["error"].as_str().unwrap_or("外部会话请求未执行。"),
            ));
        }
        Ok(response["result"].clone())
    }
}

fn is_read_method(method: &str) -> bool {
    matches!(
        method,
        "capabilities"
            | "describe"
            | "providers"
            | "list"
            | "read"
            | "draft_read"
            | "models"
            | "interaction"
            | "history"
            | "commands"
            | "operation"
    )
}

pub(crate) fn request(client: &str, directory: &Path, input: Value) -> Result<Value> {
    let method = input["method"]
        .as_str()
        .ok_or_else(|| Error::new("invalid_input", "缺少会话方法。"))?;
    if method == "capabilities" {
        return Ok(
            json!({"input_schema":definition("sessions"),"provider_catalog":"contracts/external-ai/providers.json","protocols":["codex-app-server","claude-stream-json","acp","pi-rpc"],"persistent_operation_keys":true,"read_limit":16000,"work_completion_authority":false,"instruction_authority":"none"}),
        );
    }
    let broker = SessionBroker::new(directory, client)?;
    if method == "operation" {
        return broker.exchange(input);
    }
    let hub = CollaborationHub::open(directory, client)?;
    if matches!(method, "create" | "list") {
        hub.verify_external_work(&input["work_ref"])?;
    }
    if input["session_id"].is_string() {
        super::bots::guard_regular_session(directory, client, &input["session_id"], method)?;
        let described =
            broker.exchange(json!({"method":"describe","session_id":input["session_id"]}))?;
        if input.get("work_ref").is_some() {
            ensure(
                described["work_ref"] == input["work_ref"],
                "forbidden",
                "会话不属于此固定作品。",
            )?;
        }
        if !matches!(method, "stop" | "interrupt") {
            hub.verify_external_work(&described["work_ref"])?;
        }
    }
    let read = is_read_method(method);
    if read || matches!(method, "stop" | "interrupt") {
        return broker.exchange(input);
    }
    LocalSettings::open_default()?.with_execution_policy(|mode, _revision| {
        ensure(
            mode == "auto",
            "hetu.execution_confirmation_required",
            "请确认固定会话操作，当前模式没有派发输入。",
        )?;
        broker.exchange(input)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, ErrorKind};

    struct Reply {
        received: Vec<u8>,
        body: Cursor<Vec<u8>>,
        error: Option<ErrorKind>,
    }
    impl Reply {
        fn new(body: &[u8], error: Option<ErrorKind>) -> Self {
            Self {
                received: Vec::new(),
                body: Cursor::new(body.to_vec()),
                error,
            }
        }
    }
    impl Write for Reply {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.received.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl Read for Reply {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            if let Some(error) = self.error {
                return Err(error.into());
            }
            self.body.read(bytes)
        }
    }

    #[test]
    fn read_timeout_retries_the_read_without_an_operation_key() {
        for method in ["describe", "read", "history", "operation"] {
            let input = json!({"method":method,"session_id":"original"});
            let mut stream = Reply::new(&[], Some(ErrorKind::TimedOut));
            let error =
                SessionBroker::exchange_stream(&mut stream, &json!("private"), &input).unwrap_err();
            assert_eq!(error.code, "session_read_timeout");
            let sent: Value = serde_json::from_slice(&stream.received).unwrap();
            assert_eq!(sent["input"], input);
        }
    }

    #[test]
    fn lost_write_receipt_remains_unknown_and_is_not_resent() {
        let input = json!({"method":"send","operation_key":"original","data":"draft"});
        let mut stream = Reply::new(&[], Some(ErrorKind::TimedOut));
        let error =
            SessionBroker::exchange_stream(&mut stream, &json!("private"), &input).unwrap_err();
        assert_eq!(error.code, "hetu.outcome_unknown");
        let sent: Value = serde_json::from_slice(&stream.received).unwrap();
        assert_eq!(sent["input"], input);
        assert_eq!(
            stream
                .received
                .iter()
                .filter(|byte| **byte == b'\n')
                .count(),
            1
        );
    }

    #[test]
    fn incomplete_or_invalid_receipts_do_not_confirm_a_write() {
        for body in [
            b"".as_slice(),
            b"{\"ok\":true}\n",
            b"{\"ok\":true,\"result\":",
        ] {
            for (method, expected) in [
                ("read", "hetu.integrity_failure"),
                ("send", "hetu.outcome_unknown"),
            ] {
                let mut stream = Reply::new(body, None);
                let error = SessionBroker::exchange_stream(
                    &mut stream,
                    &json!("private"),
                    &json!({"method":method,"operation_key":"original"}),
                )
                .unwrap_err();
                assert_eq!(error.code, expected);
            }
        }
    }

    #[test]
    fn oversized_receipts_keep_the_write_outcome_unknown() {
        let body = vec![b'x'; 1024 * 1024 + 1];
        for (method, expected) in [
            ("read", "hetu.output_budget_exceeded"),
            ("send", "hetu.outcome_unknown"),
        ] {
            let mut stream = Reply::new(&body, None);
            let error = SessionBroker::exchange_stream(
                &mut stream,
                &json!("private"),
                &json!({"method":method,"operation_key":"original"}),
            )
            .unwrap_err();
            assert_eq!(error.code, expected);
        }
    }

    #[test]
    fn a_host_read_failure_is_not_an_unknown_write() {
        let mut stream = Reply::new(
            b"{\"ok\":false,\"unknown\":true,\"error\":\"read failed\"}\n",
            None,
        );
        let error = SessionBroker::exchange_stream(
            &mut stream,
            &json!("private"),
            &json!({"method":"history"}),
        )
        .unwrap_err();
        assert_eq!(error.code, "hetu.runtime_unavailable");
    }

    #[test]
    fn writes_without_an_original_key_are_rejected_before_transport() {
        let mut stream = Reply::new(&[], Some(ErrorKind::TimedOut));
        let error = SessionBroker::exchange_stream(
            &mut stream,
            &json!("private"),
            &json!({"method":"restore"}),
        )
        .unwrap_err();
        assert_eq!(error.code, "invalid_input");
        assert!(stream.received.is_empty());
    }
}
