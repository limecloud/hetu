//! 本机电脑观察独立于作品Core；仅报告实际安装的原生能力，不请求系统权限。
use crate::external_execution::computer_snapshots::SnapshotStore;
use crate::{Error, Result};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const ACTION: &str = "hetu.computer.request";
static INPUT_VALIDATOR: std::sync::OnceLock<std::result::Result<jsonschema::Validator, String>> =
    std::sync::OnceLock::new();

fn helper() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let current = std::env::current_exe().ok()?;
    let bin = current.parent()?;
    let mut candidates = vec![
        bin.join("hetu-computer"),
        bin.parent()?.join("app/dist/native/hetu-computer"),
    ];
    // Cargo开发目录可取本仓构建产物；正式bin目录不能借用开发机文件冒充随包能力。
    if matches!(
        bin.file_name().and_then(|name| name.to_str()),
        Some("debug" | "release")
    ) {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../apps/desktop/dist/native/hetu-computer"),
        );
    }
    candidates
        .into_iter()
        .find(|path| path.is_absolute() && path.is_file())
}

pub fn input_schema() -> Value {
    super::definition("computer")
}

/// CLI、MCP与未来桌面工作面共用同一受限机器适配，不接受任意进程或脚本。
pub fn request_for(client: &str, directory: Option<&Path>, input: Value) -> Value {
    let execute = || -> Result<Value> {
        let validator = INPUT_VALIDATOR
            .get_or_init(|| {
                jsonschema::validator_for(&input_schema()).map_err(|error| error.to_string())
            })
            .as_ref()
            .map_err(|_| Error::new("invalid_input", "电脑操作Schema无法读取。"))?;
        if !validator.is_valid(&input) {
            return Err(Error::new(
                "invalid_input",
                "电脑观察参数不符合实际Schema。",
            ));
        }
        let program = helper();
        if input["method"] == "capabilities" {
            return Ok(json!({"protocol_version":1,"platform":std::env::consts::OS,
                "provider":if cfg!(target_os="macos") {"macos_native_observation"} else {"unavailable"},
                "available":program.is_some(),"read_methods":if program.is_some(){json!(["permissions","apps","windows","snapshot","query","wait"])}else{json!([])},
                "action_methods":if program.is_some(){json!(["act","launch","takeover","resume"])}else{json!([])},"action_kinds":if program.is_some(){json!(crate::external_execution::computer_actions::KINDS)}else{json!([])},"operation_read_method":"operation","persistent_operation_keys":true,"input_schema":input_schema(),"permission_prompt":false,
                "snapshot_ttl_ms":120000,"snapshot_limit":32,"pixels_cached":false,"work_completion_authority":false}));
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::new("invalid_input", "系统时间无效。"))?
            .as_millis() as u64;
        if matches!(
            input["method"].as_str(),
            Some("act" | "launch" | "operation" | "takeover" | "resume")
        ) {
            let directory = directory
                .map(Path::to_path_buf)
                .map(Ok)
                .unwrap_or_else(crate::collaboration::default_directory)?;
            return crate::external_execution::computer_actions::request(
                client,
                &directory,
                &input,
                program.as_deref(),
                now,
            );
        }
        let store = if matches!(
            input["method"].as_str(),
            Some("snapshot" | "query" | "wait")
        ) {
            Some(SnapshotStore::new(
                &directory
                    .map(Path::to_path_buf)
                    .map(Ok)
                    .unwrap_or_else(crate::collaboration::default_directory)?,
                client,
            )?)
        } else {
            None
        };
        let session = input["session_id"].as_str().unwrap_or("");
        if input["method"] == "query" {
            let record = store
                .as_ref()
                .unwrap()
                .read(&input["snapshot_ref"], session, now)?;
            return crate::external_execution::computer_snapshots::query(&record, &input);
        }
        let base = if input["base_ref"].is_object() {
            Some(
                store
                    .as_ref()
                    .unwrap()
                    .read(&input["base_ref"], session, now)?,
            )
        } else {
            None
        };
        let program = program.ok_or_else(|| {
            Error::new(
                "unsupported_capability",
                "当前安装没有此平台的原生电脑观察适配器。",
            )
        })?;
        let mut data = if input["method"] == "wait" {
            wait_for(&program, &input)?
        } else {
            observe_native(&program, &input, Duration::from_secs(12))?
        };

        if input["method"] == "snapshot" || input["method"] == "wait" && data["elements"].is_array()
        {
            if let Some(base) = base {
                data["tree_diff"] = crate::external_execution::computer_snapshots::diff(
                    &base["data"],
                    &data,
                    &input["base_ref"],
                )?;
            }
            let reference = store.as_ref().unwrap().save(&data, session, now)?;
            data["snapshot_ref"] = reference;
            data["session_id"] = json!(session);
            data["created_at_ms"] = json!(now);
            data["expires_at_ms"] = json!(now + 120000);
            data["pixels_cached"] = json!(false);
            let target = json!({"pid":data["app"]["pid"],"launched_at_ms":data["app"]["launched_at_ms"],"window_id":data["window"]["window_id"]});
            let control_directory = directory
                .map(Path::to_path_buf)
                .map(Ok)
                .unwrap_or_else(crate::collaboration::default_directory)?;
            data["control"] =
                crate::external_execution::computer_operations::ComputerOperations::open(
                    &control_directory,
                    client,
                )?
                .state(&target, session)?;
        }
        Ok(data)
    };
    match execute() {
        Ok(mut data) => {
            data["instruction_authority"] = json!("none");
            if matches!(input["method"].as_str(), Some("act" | "launch"))
                && matches!(data["state"].as_str(), Some("rejected" | "unknown"))
            {
                let unknown = data["state"] == "unknown";
                let code = if unknown {
                    "hetu.outcome_unknown"
                } else {
                    "action_rejected"
                };
                let error = Error::new(
                    code,
                    data["error"]["message"]
                        .as_str()
                        .unwrap_or("电脑动作未明确完成。"),
                );
                let mut result = crate::failure_result(ACTION, "collaboration", &error);
                result["error"]["resolution"] = json!({"kind":"read","action":ACTION,"input":{"method":"operation","session_id":input["session_id"],"operation_key":input["operation_key"]}});
                result["data"] = data;
                return result;
            }
            crate::domain::success(ACTION, "collaboration", data)
        }
        Err(error) => {
            let mut result = crate::failure_result(ACTION, "collaboration", &error);
            if error.code == "hetu.outcome_unknown" && input["operation_key"].is_string() {
                result["error"]["resolution"] = json!({"kind":"read","action":ACTION,"input":{"method":"operation","session_id":input["session_id"],"operation_key":input["operation_key"]}});
            }
            result
        }
    }
}

pub(crate) fn observe_native(program: &Path, input: &Value, timeout: Duration) -> Result<Value> {
    let started = std::time::Instant::now();
    let output = crate::process_supervisor::run(
        Command::new(program).env_clear(),
        serde_json::to_vec(input)?,
        timeout,
        8 * 1024 * 1024,
        &|| false,
    )
    .map_err(|error| {
        if error.code == "hetu.outcome_unknown" && started.elapsed() >= timeout {
            Error::new(
                "observation_timeout",
                "本机只读观察未在期限内返回，未执行电脑动作。",
            )
        } else {
            error
        }
    })?;
    let response: Value = serde_json::from_slice(&output)?;
    if response["protocol_version"] != 1 || !response["ok"].is_boolean() {
        return Err(Error::new(
            "provider_incompatible",
            "原生电脑观察协议不匹配。",
        ));
    }
    if response["ok"] == false {
        let code = response["error"]["code"]
            .as_str()
            .unwrap_or("observation_failed");
        let message = response["error"]["message"]
            .as_str()
            .unwrap_or("本机电脑观察未完成。");
        return Err(Error::new(
            "computer_observation_failed",
            format!("{code}：{message}"),
        ));
    }
    if !response["data"].is_object() {
        return Err(Error::new(
            "provider_incompatible",
            "原生电脑观察缺少结果。",
        ));
    }
    Ok(response["data"].clone())
}

fn wait_for(program: &Path, input: &Value) -> Result<Value> {
    let start = std::time::Instant::now();
    let timeout = Duration::from_millis(input["timeout_ms"].as_u64().unwrap_or(10_000));
    let mut polls = 0;
    loop {
        let remaining = timeout.saturating_sub(start.elapsed());
        if remaining.is_zero() {
            return Err(Error::new(
                "wait_timeout",
                "指定电脑观察条件未在期限内出现。",
            ));
        }
        let title = input["condition"]["window_title"].as_str();
        let next = if title.is_some() {
            json!({"method":"windows","app":input["app"],"limit":128})
        } else {
            json!({"method":"snapshot","app":input["app"],"window_id":input["window_id"],"max_nodes":input["max_nodes"].as_u64().unwrap_or(500),"screenshot":false})
        };
        let observed = observe_native(program, &next, remaining.min(Duration::from_secs(12)));
        polls += 1;
        if let Ok(mut data) = observed {
            let matched = if let Some(title) = title {
                let matches: Vec<_> = data["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|row| {
                        input["window_id"]
                            .as_u64()
                            .is_none_or(|id| row["window_id"] == id)
                            && row["title"].as_str().is_some_and(|value| {
                                value.to_lowercase().contains(&title.to_lowercase())
                            })
                    })
                    .cloned()
                    .collect();
                let found = !matches.is_empty();
                data["matched_windows"] = json!(matches);
                found
            } else {
                let text = input["condition"]["text"]
                    .as_str()
                    .or_else(|| input["condition"]["enabled"].as_str())
                    .unwrap()
                    .to_lowercase();
                let matches: Vec<_> = data["elements"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|row| {
                        ["title", "description", "identifier", "value"]
                            .iter()
                            .any(|key| {
                                row[key]
                                    .as_str()
                                    .is_some_and(|value| value.to_lowercase().contains(&text))
                            })
                    })
                    .collect();
                if input["condition"]["enabled"].is_string() {
                    if matches.iter().any(|row| !row["enabled"].is_boolean()) {
                        return Err(Error::new(
                            "unsupported_capability",
                            "匹配元素没有明确的启用状态，未推断条件成功。",
                        ));
                    }
                    !matches.is_empty() && matches.iter().all(|row| row["enabled"] == true)
                } else {
                    !matches.is_empty()
                }
            };
            if matched {
                data["wait"] = json!({"condition":input["condition"],"polls":polls,"elapsed_ms":start.elapsed().as_millis()as u64});
                return Ok(data);
            }
        } else if let Err(error) = observed {
            if error.code == "observation_timeout" && start.elapsed() >= timeout {
                return Err(Error::new(
                    "wait_timeout",
                    "指定电脑观察条件未在期限内出现。",
                ));
            }
            if error.code != "window_not_found" {
                return Err(error);
            }
        }
        std::thread::sleep(Duration::from_millis(200).min(timeout.saturating_sub(start.elapsed())));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(input: Value) -> Value {
        request_for("generic", None, input)
    }
    #[test]
    fn rejects_ambiguous_targets_unknown_actions_and_input_budgets() {
        for input in [
            json!({"method":"click"}),
            json!({"method":"permissions","request":true}),
            json!({"method":"windows","app":{"pid":1,"name":"other"}}),
            json!({"method":"windows","app":{"pid":0}}),
            json!({"method":"apps","limit":129}),
            json!({"method":"apps","offset":-1}),
            json!({"method":"windows","app":{"name":"x".repeat(256)}}),
            json!({"method":"snapshot","app":{"pid":1},"window_id":1,"session_id":"../foreign"}),
            json!({"method":"snapshot","app":{"pid":1},"window_id":1,"session_id":"s","max_nodes":1001}),
            json!({"method":"snapshot","app":{"pid":1},"window_id":1,"session_id":"s","screenshot":{"crop":{"x":0,"y":0,"width":0,"height":1}}}),
            json!({"method":"wait","app":{"pid":1},"session_id":"s","condition":{"text":"value"}}),
            json!({"method":"wait","app":{"pid":1},"session_id":"s","condition":{"window_title":"title"},"timeout_ms":20001}),
        ] {
            assert_ne!(request(input)["status"], "succeeded");
        }
    }
    #[test]
    fn discovery_exposes_only_actual_observation_not_actions_or_authority() {
        let result = request(json!({"method":"capabilities"}));
        assert_eq!(result["status"], "succeeded");
        assert_eq!(result["data"]["persistent_operation_keys"], true);
        assert_eq!(result["data"]["permission_prompt"], false);
        assert_eq!(result["data"]["work_completion_authority"], false);
    }
    #[cfg(unix)]
    #[test]
    fn wait_deadline_is_a_read_timeout_not_an_unknown_write_operation() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("slow-observer");
        std::fs::write(&program, "#!/bin/sh\n/bin/sleep 10\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let error = wait_for(
            &program,
            &json!({"app":{"pid":1},"condition":{"window_title":"目标"},"timeout_ms":200}),
        )
        .unwrap_err();
        assert_eq!(error.code, "wait_timeout");
    }
}
