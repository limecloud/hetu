//! 原生动作应用用例：短期依据、一次派发账本、原生交付和独立观察回读。
use super::{computer_operations::ComputerOperations, computer_snapshots::SnapshotStore};
use crate::{Error, Result};
use serde_json::{Value, json};
use std::{path::Path, process::Command, time::Duration};

pub const KINDS: &[&str] = &[
    "focus_window",
    "focus_element",
    "perform_action",
    "set_value",
    "type_text",
    "paste",
    "press_key",
    "click",
    "scroll",
    "drag",
    "move_resize",
];

pub fn request(
    client: &str,
    directory: &Path,
    input: &Value,
    program: Option<&Path>,
    now: u64,
) -> Result<Value> {
    let ops = ComputerOperations::open(directory, client)?;
    let session = input["session_id"].as_str().unwrap();
    if input["method"] == "operation" {
        return ops.operation(session, input["operation_key"].as_str().unwrap());
    }
    if let Some(record) = ops.existing(input)? {
        return Ok(record);
    }
    if matches!(input["method"].as_str(), Some("takeover" | "resume")) {
        let snapshot =
            SnapshotStore::new(directory, client)?.read(&input["snapshot_ref"], session, now)?;
        let data = &snapshot["data"];
        let target = json!({"pid":data["app"]["pid"],"launched_at_ms":data["app"]["launched_at_ms"],"window_id":data["window"]["window_id"]});
        let run = || {
            ops.control(
                input,
                &target,
                snapshot["created_at_ms"].as_u64().unwrap(),
                now,
            )
        };
        if input["method"] == "takeover" {
            return run();
        }
        return crate::local_settings::LocalSettings::open_default()?.with_execution_policy(
            |mode, _revision| {
                crate::domain::ensure(
                    mode == "auto",
                    "hetu.execution_confirmation_required",
                    "请确认恢复电脑输入，当前模式没有恢复。",
                )?;
                run()
            },
        );
    }
    crate::local_settings::LocalSettings::open_default()?.with_execution_policy(
        |mode, _revision| {
            crate::domain::ensure(
                mode == "auto",
                "hetu.execution_confirmation_required",
                "请确认固定电脑动作；当前模式没有派发输入。",
            )?;
            dispatch(client, directory, input, program, now, &ops)
        },
    )
}

fn dispatch(
    client: &str,
    directory: &Path,
    input: &Value,
    program: Option<&Path>,
    now: u64,
    ops: &ComputerOperations,
) -> Result<Value> {
    let session = input["session_id"].as_str().unwrap();
    let program = program
        .ok_or_else(|| Error::new("unsupported_capability", "当前安装没有原生电脑动作适配器。"))?;
    let snapshots = SnapshotStore::new(directory, client)?;
    let mut basis_time = None;
    let (native, target, basis) = if input["method"] == "launch" {
        let path = Path::new(input["app_path"].as_str().unwrap());
        if !path.is_absolute() {
            return Err(Error::new("invalid_input", "应用路径必须为绝对路径。"));
        }
        let canonical = path.canonicalize()?;
        if !canonical.is_dir()
            || canonical.extension().and_then(|value| value.to_str()) != Some("app")
        {
            return Err(Error::new(
                "invalid_input",
                "应用路径必须指向实际.app目录。",
            ));
        }
        let mut native = input.clone();
        native["app_path"] = json!(canonical);
        (native, json!({"app_path":canonical}), None)
    } else {
        let record = snapshots.read(&input["snapshot_ref"], session, now)?;
        basis_time = record["created_at_ms"].as_u64();
        let data = &record["data"];
        let mut basis = json!({"app":data["app"],"window":data["window"]});
        if let Some(index) = input["element_index"].as_u64() {
            let element = data["elements"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["index"] == index)
                .ok_or_else(|| Error::new("element_not_found", "原快照没有此元素。"))?;
            if !element["action_fingerprint"].is_string() {
                return Err(Error::new(
                    "snapshot_invalid",
                    "原快照不包含动作前校验依据，请重新观察。",
                ));
            }
            basis["element"] = element.clone();
        }
        if matches!(
            input["action"]["kind"].as_str(),
            Some(
                "focus_element"
                    | "perform_action"
                    | "set_value"
                    | "type_text"
                    | "paste"
                    | "press_key"
            )
        ) && !basis["element"].is_object()
        {
            return Err(Error::new(
                "invalid_input",
                "此动作必须固定element_index，不能猜测当前输入目标。",
            ));
        }
        if matches!(
            input["action"]["kind"].as_str(),
            Some("click" | "scroll" | "drag")
        ) && !basis["element"].is_object()
            && !input["action"]["position"].is_object()
        {
            return Err(Error::new(
                "invalid_input",
                "指针动作需要原元素或明确坐标。",
            ));
        }
        if input["verify"]["value_equals"].is_string() && !basis["element"].is_object() {
            return Err(Error::new("invalid_input", "值回读需要固定原元素。"));
        }
        let target = json!({"pid":data["app"]["pid"],"launched_at_ms":data["app"]["launched_at_ms"],"window_id":data["window"]["window_id"]});
        (
            json!({"method":"act","basis":basis,"action":input["action"]}),
            target,
            Some(basis),
        )
    };
    ops.execute_with_basis(input,now,&target,basis_time,||{
        let result=invoke(program,&native);
        match result {
            Err(error)=>json!({"state":"unknown","error":{"code":"outcome_unknown","cause":error.code,"message":"原生派发结果未知；只查询原operation_key，不重发动作。"}}),
            Ok(response) if response["ok"]==false=>json!({"state":if response["dispatch_started"]==false{"rejected"}else{"unknown"},"error":response["error"]}),
            Ok(response)=>{
                let mut receipt=response["data"].clone();
                if let Some(basis)=basis { receipt["readback"]=readback(program,&snapshots,session,&basis,input,now); }
                json!({"state":"succeeded","result":receipt})
            }
        }
    })
}

fn invoke(program: &Path, input: &Value) -> Result<Value> {
    let bytes = serde_json::to_vec(input)?;
    if bytes.len() > 65536 {
        return Err(Error::new("invalid_input", "原生动作输入超过预算。"));
    }
    let output = crate::process_supervisor::run(
        Command::new(program).env_clear(),
        bytes,
        Duration::from_secs(12),
        1024 * 1024,
        &|| false,
    )?;
    let response: Value = serde_json::from_slice(&output)?;
    if response["protocol_version"] != 1
        || !response["ok"].is_boolean()
        || response["ok"] == true && !response["data"].is_object()
        || response["ok"] == false && !response["dispatch_started"].is_boolean()
    {
        return Err(Error::new(
            "provider_incompatible",
            "原生动作回执无法明确核对。",
        ));
    }
    Ok(response)
}

fn readback(
    program: &Path,
    store: &SnapshotStore,
    session: &str,
    basis: &Value,
    input: &Value,
    now: u64,
) -> Value {
    let next = json!({"method":"snapshot","app":{"pid":basis["app"]["pid"]},"window_id":basis["window"]["window_id"],"max_nodes":1000,"max_depth":64,"screenshot":false});
    let observed =
        crate::external_execution::computer::observe_native(program, &next, Duration::from_secs(8));
    match observed {
        Err(error) => {
            json!({"state":"unavailable","code":error.code,"verification":"not_observed"})
        }
        Ok(data) => {
            if !crate::external_execution::computer_snapshots::same_window(basis, &data) {
                return json!({"state":"unavailable","code":"window_stale","verification":"not_observed"});
            }
            let verification = if let Some(text) = input["verify"]["text"].as_str() {
                let found = data["elements"].as_array().unwrap().iter().any(|row| {
                    ["title", "description", "value"]
                        .iter()
                        .any(|key| row[key].as_str().is_some_and(|value| value.contains(text)))
                });
                if found { "matched" } else { "not_observed" }
            } else if let Some(text) = input["verify"]["value_equals"].as_str() {
                let element = &basis["element"];
                let found = data["elements"].as_array().unwrap().iter().find(|row| {
                    row["route"] == element["route"]
                        && row["role"] == element["role"]
                        && row["identifier"] == element["identifier"]
                });
                if found.is_some_and(|row| row["value"] == text) {
                    "matched_at_original_route"
                } else {
                    "not_observed"
                }
            } else {
                "not_requested"
            };
            match store.save(&data, session, now) {
                Ok(reference) => {
                    json!({"state":"observed","snapshot_ref":reference,"verification":verification,"work_completion_authority":false})
                }
                Err(error) => {
                    json!({"state":"cache_unavailable","code":error.code,"verification":verification})
                }
            }
        }
    }
}
