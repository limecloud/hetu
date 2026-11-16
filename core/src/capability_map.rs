//! 静态源码地图用于导航；执行权限与安装版能力仍在实际入口核验。
use crate::{Error, Result, domain::ensure};
use serde_json::{Value, json};
pub fn read(input: &Value) -> Result<Value> {
    let map: Value = serde_json::from_str(include_str!("../../contracts/capability-map.json"))?;
    let mut actions = Vec::new();
    for entry in map["actions"].as_array().unwrap() {
        if ["group", "action", "skill"]
            .iter()
            .any(|key| input[*key].is_string() && input[*key] != entry[*key])
        {
            continue;
        }
        let mut entry = entry.clone();
        if input["include_schema"] != true {
            entry.as_object_mut().unwrap().remove("input_schema");
        }
        actions.push(entry);
    }
    let start = input["offset"].as_u64().unwrap_or(0) as usize;
    ensure(
        start <= actions.len(),
        "invalid_input",
        "地图分页超出当前筛选结果。",
    )?;
    let end = start
        .saturating_add(input["limit"].as_u64().unwrap_or(25) as usize)
        .min(actions.len());
    let skills = map["skills"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|skill| {
            input["skill"]
                .as_str()
                .is_none_or(|name| skill["name"] == name)
                && (input["action"].is_null() && input["group"].is_null()
                    || actions
                        .iter()
                        .any(|action| action["skill"] == skill["name"]))
        })
        .collect::<Vec<_>>();
    let workflows = map["workflows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|workflow| {
            input["skill"]
                .as_str()
                .is_none_or(|name| workflow["skill"] == name)
        })
        .collect::<Vec<_>>();
    let mut groups = std::collections::BTreeSet::new();
    for entry in map["actions"].as_array().unwrap() {
        groups.insert(
            entry["group"]
                .as_str()
                .ok_or_else(|| Error::new("hetu.integrity_failure", "能力地图领域无效。"))?,
        );
    }
    Ok(
        json!({"build_version":env!("CARGO_PKG_VERSION"),"meaning":map["meaning"],"groups":groups,"skills":skills,"workflows":workflows,"extension_runtime_discovery":map["extension_runtime_discovery"],"total":actions.len(),"actions":actions[start..end],"next_offset":(end<actions.len()).then_some(end),"runtime_discovery":"hetu.collaboration.inspect","document":"docs/40-机器能力地图与Review清单.md","source_map":"contracts/capability-map.json"}),
    )
}
