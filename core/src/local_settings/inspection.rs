//! 套件检测仅读取受控目录，不将文件存在、启用登记或当前会话加载混为一谈。
use super::*;

fn package(directory: &Path, suite_id: &str) -> Result<(Value, BTreeMap<String, Vec<u8>>)> {
    ensure(directory.is_absolute(), "invalid_input", "套件目录必须是绝对路径。")?;
    let files = suites::bytes(directory)?;
    let read = |name: &str| -> Result<Value> {
        serde_json::from_slice(files.get(name).ok_or_else(|| Error::new("hetu.integrity_failure", "目录缺少套件身份文件。"))?).map_err(Into::into)
    };
    let identity = read("hetu-suite.json")?;
    let manifest = read("plugin.json")?;
    let expected = suites::inspect(suite_id)?;
    ensure(identity["schema_version"] == "1.0.0" && identity["suite_id"] == suite_id
        && manifest["name"] == expected["name"] && manifest["version"].as_str().is_some_and(|v| !v.is_empty() && v.len() <= 80),
        "hetu.integrity_failure", "目录与所选套件身份不一致。")?;
    Ok((manifest, files))
}
pub(super) fn validate_directory(directory: &str, suite_id: &str) -> Result<()> {
    package(Path::new(directory), suite_id).map(|_| ())
}
pub(super) fn inspect(state: &Value, input: &Value) -> Result<Value> {
    closed(input, &["agent_client", "suite_id"])?;
    let client = text(input, "agent_client")?;
    validate_patch(&json!({"agent_client":client}))?;
    let id = text(input, "suite_id")?;
    let bundled = suites::inspect(id)?;
    let catalog = suites::catalog();
    let name = text(&bundled, "name")?;
    let key = format!("{client}:{id}");
    let mut result = json!({"state":"missing","version":null,"found_skills":[],"registration":"unknown",
        "session":"unverified","mcp":"unverified","checked_at":domain::now(),"bundled":bundled,
        "bundle_directory":suites::integration_directory()?.join("codex").join(name),
        "selected_directory":state["package_directories"][&key],"directory":null});
    if client == "none" { result["state"] = json!("manual"); return Ok(result); }
    let mut candidates = Vec::new();
    if let Some(selected) = state["package_directories"][&key].as_str() {
        candidates.push(PathBuf::from(selected));
    } else if client == "codex" {
        let directory = suites::codex_home()?.join("plugins/cache").join(format!("hetu-luoshu-{id}")).join(name);
        if directory.is_dir() {
            for entry in std::fs::read_dir(directory)? {
                ensure(candidates.len() < 100, "hetu.budget_exceeded", "套件缓存版本过多。")?;
                let path = entry?.path();
                if path.is_dir() { candidates.push(path); }
            }
            candidates.sort_by(|a,b| {
                let parts = |p: &PathBuf| p.file_name().unwrap_or_default().to_string_lossy().split('.').map(|n| n.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
                parts(b).cmp(&parts(a)).then_with(|| b.cmp(a))
            });
        }
    } else if client == "workbuddy" {
        candidates.push(suites::workbuddy_directory()?.join("skills").join(name));
    } else { result["state"] = json!("unsupported"); }
    if client == "codex" {
        let market = format!("hetu-luoshu-{id}");
        match suites::command(&["plugin", "list", "--marketplace", &market, "--json"]) {
            Ok(registry) => {
                if let Some(records) = registry["installed"].as_array() {
                    result["registration"] = json!("missing");
                    if let Some(entry) = records.iter().find(|r| r["pluginId"] == format!("{name}@{market}") && r["installed"] == true) {
                        result["registration"] = json!(if entry["enabled"] == true { "enabled" } else { "disabled" });
                        result["registered_version"] = entry["version"].clone();
                    }
                }
            }
            Err(_) => { result["registration"] = json!("unknown"); }
        }
    } else { result["registration"] = json!("not_applicable"); }
    for directory in candidates {
        if !directory.exists() { continue; }
        result["directory"] = json!(directory);
        match package(&directory, id) {
            Ok((manifest, files)) => {
                let found: Vec<_> = catalog["skills"].as_array().unwrap().iter().filter_map(|skill| {
                    let method = skill["id"].as_str().unwrap();
                    let content = files.get(&format!("skills/{method}/SKILL.md"))?;
                    let content = std::str::from_utf8(content).ok()?;
                    let adapted = format!("{name}-{}", method.trim_start_matches("hetu-"));
                    if content.contains(&format!("\nname: {method}\n")) || client == "workbuddy" && content.contains(&format!("\nname: {adapted}\n")) { Some(json!(method)) } else { None }
                }).collect();
                result["state"] = json!(if found.len() == catalog["skills"].as_array().unwrap().len() { "found" } else { "invalid" });
                result["version"] = manifest["version"].clone();
                result["version_differs"] = json!(manifest["version"] != result["bundled"]["version"]);
                result["found_skills"] = json!(found);
                break;
            }
            Err(_) => { result["state"] = json!("invalid"); }
        }
    }
    Ok(result)
}
