//! 阅读偏好只保存一份档案；旧字段在受管入口边界转换，不双写设置。
use super::{Result, ensure};
use serde_json::{Value, json};

const LEGACY_FIELDS: [&str; 4] = ["font_family", "font_size", "line_spacing", "first_line_indent"];

pub(super) fn profiles() -> Value {
    let catalog: Value = serde_json::from_str(include_str!("../../../contracts/reading-defaults.json"))
        .expect("阅读默认档案必须是有效JSON");
    catalog["profiles"].clone()
}

pub(super) fn apply(current: &Value, patch: &Value) -> Result<Value> {
    ensure(
        !(patch.get("reading_profiles").is_some() && LEGACY_FIELDS.iter().any(|key| patch.get(*key).is_some())),
        "invalid_input", "旧版排版字段与阅读档案不能在同一次修改中混用。",
    )?;
    let mut next = current.clone();
    for (key, value) in patch.as_object().unwrap() {
        if LEGACY_FIELDS.contains(&key.as_str()) { continue; }
        if key == "agent_session" {
            for (field, value) in value.as_object().unwrap() { next[key][field] = value.clone(); }
        } else if key == "reading_profiles" {
            for (kind, fields) in value.as_object().unwrap() {
                for (field, value) in fields.as_object().unwrap() {
                    next[key][kind][field] = value.clone();
                }
            }
        } else {
            next[key] = value.clone();
        }
    }
    if LEGACY_FIELDS.iter().any(|key| patch.get(*key).is_some()) {
        let profile = &mut next["reading_profiles"]["novel"];
        let old_size = profile["font_size"].as_f64().unwrap();
        let extra = patch["line_spacing"].as_f64().unwrap_or(
            (profile["line_height"].as_f64().unwrap() - 1.35) * old_size,
        );
        for key in ["font_family", "font_size", "first_line_indent"] {
            if let Some(value) = patch.get(key) { profile[key] = value.clone(); }
        }
        if patch.get("font_size").is_some() || patch.get("line_spacing").is_some() {
            profile["line_height"] = json!(1.35 + extra / profile["font_size"].as_f64().unwrap());
        }
    }
    super::validate_patch(&next)?;
    validate_complete(&next)?;
    Ok(next)
}

pub(super) fn validate_complete(preferences: &Value) -> Result<()> {
    let expected = profiles();
    for kind in ["novel", "screenplay"] {
        let profile = &preferences["reading_profiles"][kind];
        ensure(
            profile.as_object().is_some_and(|v| v.len() == expected[kind].as_object().unwrap().len()
                && expected[kind].as_object().unwrap().keys().all(|key| v.contains_key(key)))
                && (profile["font_family"] != "custom" || profile["font_name"].as_str().is_some_and(|s| !s.trim().is_empty())),
            "invalid_input", "阅读档案不完整，或尚未指定本机字体。",
        )?;
    }
    Ok(())
}

/// 兼容已发行的修订1输入／回读；别名只存在于投影，不进入设置文件及固定基线。
fn project(preferences: &mut Value) {
    let profile = preferences["reading_profiles"]["novel"].clone();
    if !profile.is_object() { return; }
    for key in ["font_family", "font_size", "first_line_indent"] {
        preferences[key] = profile[key].clone();
    }
    let extra = (profile["line_height"].as_f64().unwrap() - 1.35) * profile["font_size"].as_f64().unwrap();
    preferences["line_spacing"] = if (extra - extra.round()).abs() < 1e-10 {
        json!(extra.round() as i64)
    } else { json!(extra) };
}

pub(super) fn projection(mut response: Value) -> Value {
    if response["preferences"].is_object() { project(&mut response["preferences"]); }
    if response["result"]["reading_profiles"].is_object() { project(&mut response["result"]); }
    response
}

pub(super) fn migrate(mut state: Value, defaults: Value) -> Result<Value> {
    ensure(
        state["schema_version"] == 1 && state["revision"].as_u64().is_some_and(|n| n > 0)
            && state["associations"].is_object() && state["installations"].is_object(),
        "hetu.integrity_failure", "旧版本机设置记录无效，已保留原文件。",
    )?;
    let old = &state["preferences"];
    let old_keys = ["language", "appearance", "library_list", "autosave", "font_family", "font_size", "line_spacing",
        "first_line_indent", "git_author_name", "git_author_email", "agent_client"];
    ensure(old.as_object().is_some_and(|v| v.len() == old_keys.len() && old_keys.iter().all(|key| v.contains_key(*key))),
        "hetu.integrity_failure", "旧版本机偏好字段不完整，已保留原文件。")?;
    super::validate_patch(old)?;
    let size = old["font_size"].as_f64().unwrap();
    let mut next = defaults["preferences"].clone();
    for key in old_keys {
        if !LEGACY_FIELDS.contains(&key) { next[key] = old[key].clone(); }
    }
    for kind in ["novel", "screenplay"] {
        next["reading_profiles"][kind]["font_size"] = old["font_size"].clone();
        next["reading_profiles"][kind]["line_width"] = json!(880.0 / size);
    }
    for key in ["font_family", "first_line_indent"] {
        next["reading_profiles"]["novel"][key] = old[key].clone();
    }
    next["reading_profiles"]["novel"]["line_height"] = json!(1.35 + old["line_spacing"].as_f64().unwrap() / size);
    super::validate_patch(&next)?;
    validate_complete(&next)?;
    state["preferences"] = next;
    state["schema_version"] = json!(2);
    state["revision"] = json!(state["revision"].as_u64().unwrap() + 1);
    Ok(state)
}
