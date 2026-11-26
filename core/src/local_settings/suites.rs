//! 随包创作方法的核验及明确安装；不拥有外部 Agent 的配置与账号。
use super::*;
use std::{
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub(super) fn catalog() -> Value {
    static CATALOG: std::sync::LazyLock<Value> = std::sync::LazyLock::new(build_catalog);
    CATALOG.clone()
}

fn build_catalog() -> Value {
    let catalog: Value = serde_json::from_str(include_str!("../../../integrations/catalog.json"))
        .expect("embedded suite catalog");
    let labels: Value =
        serde_json::from_str(include_str!("../../../assets/localization/shared.json"))
            .expect("embedded localization");
    json!({"suites":catalog["suites"].as_array().unwrap().iter().map(|s|json!({
        "suite_id":s["id"],"name":s["pluginName"],"title_key":s["titleKey"],"title":labels[s["titleKey"].as_str().unwrap()]["zh-CN"],
        "family":s["family"],"summary":s["summary"],"aliases":s["aliases"]
    })).collect::<Vec<_>>(),"categories":catalog["categories"],"skills":catalog["skills"].as_array().unwrap().iter().map(|id|json!({
        "id":id,"title":labels[format!("agent.skill.{}",id.as_str().unwrap())]["zh-CN"]
    })).collect::<Vec<_>>()})
}
pub(super) fn installable_clients() -> Value {
    let mut clients = vec!["workbuddy"];
    if codex_binary().is_ok() {
        clients.insert(0, "codex");
    }
    json!(clients)
}

/// 机器连接独立于题材套件，复用同一官方安装、固定字节和未知恢复流程。
pub(super) fn connection_package() -> Result<Value> {
    let executable = std::env::current_exe()?;
    let binary = executable.parent().ok_or_else(|| Error::new("missing_context", "无法定位随包机器入口。"))?
        .join(if cfg!(windows) { "hetu-mcp.exe" } else { "hetu-mcp" });
    ensure(binary.is_file(), "hetu.capability_unavailable", "当前制品缺少同目录的hetu-mcp，请使用完整河图安装包。")?;
    let binary = binary.canonicalize()?;
    let files = connection_files(&binary)?;
    Ok(json!({"suite_id":"machine-connection","name":"hetu-workbench","version":env!("CARGO_PKG_VERSION"),"file_count":files.len(),
        "package_sha256":fingerprint(&files)?,"mcp_binary":binary,"mcp_binary_sha256":domain::digest(std::fs::read(&binary)?)}))
}

fn connection_files(binary: &Path) -> Result<BTreeMap<String, Vec<u8>>> {
    let manifest = json!({"name":"hetu-workbench","version":env!("CARGO_PKG_VERSION"),
        "description":"河图洛书工作台：小说、剧本、视频、固定成果与意见","mcpServers":"./.mcp.json"});
    let mcp = json!({"mcpServers":{"hetu":{"type":"stdio","command":binary,"args":["--client","codex"]}}});
    // 此包是Codex对已安装应用的适配；通用plugin.json会切换到禁止绝对命令的便携解析器。
    Ok(BTreeMap::from([
        (".codex-plugin/plugin.json".into(),serde_json::to_vec(&manifest)?),
        ("mcp.json".into(),serde_json::to_vec(&mcp)?),
        (".mcp.json".into(),serde_json::to_vec(&mcp)?),
    ]))
}

pub(super) fn inspect_connection(installation: &Value) -> Result<Value> {
    if !installation["version"].is_string() { return Ok(json!({"client":"codex","state":"not_installed","registered":false,"session_loaded":false})); }
    let mut fixed = installation.clone();
    fixed["name"] = json!("hetu-workbench");
    fixed["suite_id"] = json!("machine-connection");
    let mut result = installed_codex(&fixed)?;
    result["registered"] = json!(true);
    let bundled = connection_package()?;
    result["version_differs"] = json!(fixed["version"] != bundled["version"] || fixed["package_sha256"] != bundled["package_sha256"]);
    result["bundled"] = bundled;
    Ok(result)
}
pub(super) fn integration_directory() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("HETU_INTEGRATIONS_DIR") {
        let path = PathBuf::from(path);
        ensure(
            path.is_absolute(),
            "invalid_input",
            "套件资源目录必须为绝对路径。",
        )?;
        return Ok(path);
    }
    let packaged = std::env::current_exe()?
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("integrations");
    if packaged.is_dir() {
        return Ok(packaged);
    }
    #[cfg(debug_assertions)]
    {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../integrations"))
    }
    #[cfg(not(debug_assertions))]
    {
        Err(Error::new(
            "hetu.capability_unavailable",
            "随包创作方法不可用，请检查完整安装包。",
        ))
    }
}
fn suite(id: &str) -> Result<Value> {
    let catalog: Value = serde_json::from_str(include_str!("../../../integrations/catalog.json"))?;
    catalog["suites"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == id)
        .cloned()
        .ok_or_else(|| Error::new("invalid_input", "套件不在当前目录中。"))
}
pub(super) fn bytes(directory: &Path) -> Result<BTreeMap<String, Vec<u8>>> {
    ensure(
        std::fs::symlink_metadata(directory)?.is_dir(),
        "hetu.unsafe_path",
        "套件根目录必须为常规目录。",
    )?;
    let store = Store::open(directory)?;
    let files = store.files("", |_| false)?;
    ensure(
        !files.is_empty() && files.len() <= 256,
        "hetu.budget_exceeded",
        "套件文件数量超限。",
    )?;
    let mut result = BTreeMap::new();
    let mut size = 0;
    for name in files {
        let file = store.read(&name)?;
        size += file.len();
        ensure(
            file.len() < 2 * 1024 * 1024 && size <= 16 * 1024 * 1024,
            "hetu.budget_exceeded",
            "套件字节超过上限。",
        )?;
        result.insert(name, file);
    }
    Ok(result)
}
fn fingerprint(files: &BTreeMap<String, Vec<u8>>) -> Result<String> {
    hash(&json!(
        files
            .iter()
            .map(|(path, data)| (path, domain::digest(data)))
            .collect::<BTreeMap<_, _>>()
    ))
}
fn valid_version(version: &str) -> bool {
    let core = version.split(['-', '+']).next().unwrap_or("");
    let parts: Vec<_> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && version.len() <= 80
        && version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-+".contains(&b))
}
pub(super) fn inspect(id: &str) -> Result<Value> {
    let selected = suite(id)?;
    let name = text(&selected, "pluginName")?;
    let files = bytes(&integration_directory()?.join("codex").join(name))?;
    let read = |path: &str| -> Result<Value> {
        serde_json::from_slice(
            files
                .get(path)
                .ok_or_else(|| Error::new("hetu.integrity_failure", "套件缺少必要文件。"))?,
        )
        .map_err(Into::into)
    };
    let plugin = read("plugin.json")?;
    let codex = read(".codex-plugin/plugin.json")?;
    let identity = read("hetu-suite.json")?;
    let methods = read("references/method-manifest.json")?;
    let hashes = methods["files"]
        .as_object()
        .ok_or_else(|| Error::new("hetu.integrity_failure", "套件方法清单无效。"))?;
    ensure(
        methods["suite_id"] == id
            && hashes.len() + 1 == files.len()
            && hashes.iter().all(|(path, expected)| {
                files.get(path).is_some_and(|content| {
                    expected.as_str() == Some(domain::digest(content).as_str())
                })
            }),
        "hetu.integrity_failure",
        "套件文件与方法清单不一致。",
    )?;
    ensure(
        identity["suite_id"] == id
            && identity["schema_version"] == "1.0.0"
            && plugin["name"] == name
            && codex["name"] == name
            && codex["version"] == plugin["version"],
        "hetu.integrity_failure",
        "套件名称、版本或身份不一致。",
    )?;
    let version = text(&plugin, "version")?;
    ensure(
        valid_version(version),
        "hetu.integrity_failure",
        "套件版本格式无效。",
    )?;
    for path in selected["requiredFiles"].as_array().unwrap() {
        ensure(
            files.contains_key(path.as_str().unwrap()),
            "hetu.integrity_failure",
            "套件缺少声明的方法资料。",
        )?;
    }
    let catalog: Value = serde_json::from_str(include_str!("../../../integrations/catalog.json"))?;
    for method in catalog["skills"].as_array().unwrap() {
        ensure(
            files.contains_key(&format!("skills/{}/SKILL.md", method.as_str().unwrap())),
            "hetu.integrity_failure",
            "套件缺少任务方法。",
        )?;
    }
    Ok(
        json!({"suite_id":id,"name":name,"version":version,"package_sha256":fingerprint(&files)?,"file_count":files.len()}),
    )
}
fn home() -> Result<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or_else(|| Error::new("missing_context", "无法确定用户目录。"))
}
pub(super) fn codex_home() -> Result<PathBuf> {
    let path = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| Ok::<_, Error>(home()?.join(".codex")))?;
    ensure(
        path.is_absolute(),
        "invalid_input",
        "Codex 用户目录必须为绝对路径。",
    )?;
    Ok(path)
}
fn codex_binary() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("HETU_CODEX_BINARY") {
        let path = PathBuf::from(path);
        ensure(
            path.is_absolute() && runnable_command(&path),
            "hetu.capability_unavailable",
            "Codex 入口不可用。",
        )?;
        return Ok(path);
    }
    let candidates = std::env::var_os("PATH")
        .map(|p| {
            std::env::split_paths(&p)
                .filter(|p| p.is_absolute())
                .map(|p| p.join(if cfg!(windows) { "codex.exe" } else { "codex" }))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    candidates.into_iter().find(|p| runnable_command(p)).ok_or_else(|| {
        Error::new(
            "hetu.capability_unavailable",
            "未找到 Codex 官方 CLI，请先安装或手动接入所选套件。",
        )
    })
}
/// 旧安装脚本可能仍存在，但执行位或绝对解释器已失效；此时继续探测PATH。
fn runnable_command(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return false;
        }
        let Ok(file) = std::fs::File::open(path) else {
            return false;
        };
        let mut header = Vec::new();
        if file.take(512).read_to_end(&mut header).is_err() {
            return false;
        }
        if header.starts_with(b"#!") {
            let first_line = header.split(|byte| *byte == b'\n').next().unwrap();
            let Ok(line) = std::str::from_utf8(&first_line[2..]) else {
                return false;
            };
            let Some(interpreter) = line.split_whitespace().next() else {
                return false;
            };
            let interpreter = Path::new(interpreter);
            if !interpreter.is_absolute()
                || !interpreter.metadata().is_ok_and(|metadata| {
                    metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
                })
            {
                return false;
            }
        }
    }
    true
}

pub(super) fn workbuddy_directory() -> Result<PathBuf> {
    let config = std::env::var_os("WORKBUDDY_CONFIG_DIR")
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| {
            let suffix = std::env::var("WORKBUDDY_INSTANCE_NUMBER")
                .ok()
                .map(|n| format!("-{n}"))
                .unwrap_or_default();
            ensure(
                suffix.bytes().all(|b| b.is_ascii_digit() || b == b'-'),
                "invalid_input",
                "WorkBuddy 实例编号无效。",
            )?;
            Ok::<_, Error>(home()?.join(format!(".workbuddy{suffix}")))
        })?;
    ensure(
        config.is_absolute(),
        "invalid_input",
        "WorkBuddy 目录必须为绝对路径。",
    )?;
    Ok(config)
}
pub(super) fn target(client: &str) -> Result<Value> {
    if client == "codex" {
        return Ok(
            json!({"client_directory":codex_home()?,"executable":codex_binary()?,"package_directory":default_directory()?.parent().unwrap().join("AgentPackages")}),
        );
    }
    ensure(
        client == "workbuddy",
        "hetu.capability_unavailable",
        "当前客户端不支持自动安装。",
    )?;
    Ok(json!({"client_directory":workbuddy_directory()?}))
}
pub(super) fn command(args: &[&str]) -> Result<Value> {
    let mut child = Command::new(codex_binary()?)
        .args(args)
        .env("CODEX_HOME", codex_home()?)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let stdout = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut data = Vec::new();
        stdout
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut data)
            .map(|_| data)
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > Duration::from_secs(45) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::new(
                "result_unknown",
                "安装命令未返回，请沿原方案回读登记状态。",
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let output = reader
        .join()
        .map_err(|_| Error::new("result_unknown", "安装回执读取中断。"))??;
    ensure(
        status.success() && output.len() <= 2 * 1024 * 1024,
        "result_unknown",
        "安装结果未能确认，请沿原方案核对。",
    )?;
    serde_json::from_slice(&output)
        .map_err(|_| Error::new("result_unknown", "安装回执格式无法确认。"))
}
fn validate_destination(directory: &Path, files: &BTreeMap<String, Vec<u8>>) -> Result<()> {
    match std::fs::symlink_metadata(directory) {
        Ok(_) => ensure(
            fingerprint(&bytes(directory)?)? == fingerprint(files)?,
            "revision_conflict",
            "目标已存在不同内容；保留作者已有文件。",
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
fn materialize(directory: &Path, files: &BTreeMap<String, Vec<u8>>) -> Result<()> {
    validate_destination(directory, files)?;
    if directory.exists() {
        return Ok(());
    }
    let parent = directory
        .parent()
        .ok_or_else(|| Error::new("hetu.unsafe_path", "安装目标目录无效。"))?;
    std::fs::create_dir_all(parent)?;
    let stage = parent.join(format!(".{}", id("hetu-install")));
    std::fs::create_dir(&stage)?;
    let store = Store::open(&stage)?;
    for (name, file) in files {
        store.install(name, file, true)?;
    }
    ensure(
        fingerprint(&bytes(&stage)?)? == fingerprint(files)?,
        "hetu.integrity_failure",
        "安装暂存包校验失败。",
    )?;
    ensure(
        !directory.exists(),
        "revision_conflict",
        "安装目标已由另一进程创建。",
    )?;
    std::fs::rename(&stage, directory)?;
    ensure(
        fingerprint(&bytes(directory)?)? == fingerprint(files)?,
        "hetu.integrity_failure",
        "实际安装文件与固定包不一致。",
    )
}
/// 精确查询也返回本地市场来源；无关市场的加载错误不影响所选套件。
fn codex_market(fixed: &Value, registered: &Value) -> Result<PathBuf> {
    let suite_id = text(fixed, "suite_id")?;
    let name = text(fixed, "name")?;
    let market_name = format!("hetu-luoshu-{suite_id}");
    let base = default_directory()?
        .parent()
        .unwrap()
        .join("AgentPackages/codex")
        .join(suite_id);
    let installed = registered["installed"]
        .as_array()
        .ok_or_else(|| Error::new("hetu.capability_unavailable", "无法核对所选市场登记。"))?;
    let available = registered["available"]
        .as_array()
        .ok_or_else(|| Error::new("hetu.capability_unavailable", "无法核对所选市场目录。"))?;
    let records: Vec<_> = installed.iter().chain(available).collect();
    ensure(
        records.len() <= 1,
        "revision_conflict",
        "所选市场包含重复或非受管插件。",
    )?;
    if let Some(record) = records.first() {
        let source = &record["marketplaceSource"];
        let candidate = PathBuf::from(text(source, "source")?);
        // 官方 CLI 会规范化本机路径（例如 macOS 的 /var → /private/var）。
        // 核对真实目录，既接受同一来源，也不让符号链接扩大受管范围。
        let managed = base.canonicalize().map_err(|_| Error::new(
            "revision_conflict", "受管市场来源无法核对，请保留原登记。"))?;
        let actual = candidate.canonicalize().map_err(|_| Error::new(
            "revision_conflict", "已有市场来源无法核对，请保留原登记。"))?;
        ensure(
            record["pluginId"] == format!("{name}@{market_name}")
                && record["name"] == name
                && record["marketplaceName"] == market_name
                && source["sourceType"] == "local"
                && candidate.is_absolute()
                && (actual == managed || actual.parent() == Some(managed.as_path())),
            "revision_conflict",
            "已有市场来源不属于本机受管套件。",
        )?;
        return Ok(actual);
    }
    // 空目录不证明同名市场未登记；正式add仍由官方CLI核验来源冲突。
    Ok(base)
}
fn installed_codex(fixed: &Value) -> Result<Value> {
    let market = format!("hetu-luoshu-{}", text(fixed, "suite_id")?);
    let plugin_id = format!("{}@{market}", text(fixed, "name")?);
    let registered = command(&[
        "plugin",
        "list",
        "--marketplace",
        &market,
        "--available",
        "--json",
    ])?;
    codex_market(fixed, &registered)?;
    ensure(
        registered["installed"].as_array().is_some_and(|records| {
            records.iter().any(|r| {
                r["pluginId"] == plugin_id
                    && r["installed"] == true
                    && r["enabled"] == true
                    && r["version"] == fixed["version"]
            })
        }),
        "result_unknown",
        "官方登记尚不能确认所选插件版本。",
    )?;
    let path = codex_home()?
        .join("plugins/cache")
        .join(&market)
        .join(text(fixed, "name")?)
        .join(text(fixed, "version")?);
    ensure(
        fingerprint(
            &bytes(&path).map_err(|_| Error::new("result_unknown", "登记包无法完整回读。"))?,
        )? == fixed["package_sha256"],
        "result_unknown",
        "官方缓存与固定套件不一致，请保留现场核对。",
    )?;
    Ok(
        json!({"client":"codex","suite_id":fixed["suite_id"],"version":fixed["version"],"package_sha256":fixed["package_sha256"],
        "directory":path,"state":"registered","session_loaded":false,"verified_at":domain::now()}),
    )
}
pub(super) fn install(
    fixed: &Value,
    client: &str,
    recovering: bool,
    begin: impl FnOnce() -> Result<()>,
) -> Result<Value> {
    let suite_id = text(fixed, "suite_id")?;
    let name = text(fixed, "name")?;
    if client == "codex" && recovering {
        return installed_codex(fixed);
    }
    let mut files = if suite_id == "machine-connection" {
        let actual = connection_package()?;
        ensure(actual == *fixed, "revision_conflict", "机器入口或固定安装包已变化，请重新准备。")?;
        connection_files(Path::new(text(fixed, "mcp_binary")?))?
    } else { bytes(&integration_directory()?.join("codex").join(name))? };
    ensure(
        fingerprint(&files)? == fixed["package_sha256"],
        "revision_conflict",
        "套件资源已变化。",
    )?;
    if client == "workbuddy" {
        let catalog: Value =
            serde_json::from_str(include_str!("../../../integrations/catalog.json"))?;
        for method in catalog["skills"].as_array().unwrap() {
            let method = method.as_str().unwrap();
            let key = format!("skills/{method}/SKILL.md");
            if suite_id != "general" {
                let original = std::str::from_utf8(files.get(&key).unwrap())
                    .map_err(|_| Error::new("hetu.integrity_failure", "方法不是UTF-8文本。"))?;
                let adapted = original.replace(
                    &format!("\nname: {method}\n"),
                    &format!("\nname: {name}-{}\n", method.trim_start_matches("hetu-")),
                );
                files.insert(key, adapted.into_bytes());
            }
        }
        files.insert(
            "hetu-suite.json".into(),
            serde_json::to_vec(
                &json!({"schema_version":"1.0.0","suite_id":suite_id,"adapter":"workbuddy"}),
            )?,
        );
        let config = workbuddy_directory()?;
        let destination = config.join("skills").join(name);
        validate_destination(&destination, &files)?;
        begin()?;
        materialize(&destination, &files)?;
        return Ok(
            json!({"client":client,"suite_id":suite_id,"version":fixed["version"],"package_sha256":fixed["package_sha256"],
            "installed_sha256":fingerprint(&files)?,"directory":destination,"state":"files_installed","session_loaded":false,"verified_at":domain::now()}),
        );
    }
    ensure(
        client == "codex",
        "hetu.capability_unavailable",
        "当前客户端不支持自动安装。",
    )?;
    let market_name = format!("hetu-luoshu-{suite_id}");
    let existing = command(&[
        "plugin",
        "list",
        "--marketplace",
        &market_name,
        "--available",
        "--json",
    ])
    .map_err(|_| {
        Error::new(
            "hetu.capability_unavailable",
            "无法读取所选市场；尚未开始安装，请检查客户端后沿原方案继续。",
        )
    })?;
    let market = codex_market(fixed, &existing)?;
    let manifest_path = ".agents/plugins/marketplace.json";
    if market.exists() && Store::open(&market)?.exists(manifest_path)? {
        let market_store = Store::open(&market)?;
        let previous = market_store.json(manifest_path)?;
        let old_path = text(&previous["plugins"][0]["source"], "path")?;
        let parts: Vec<_> = old_path.split('/').collect();
        ensure(
            (parts.len() == 4
                && parts[0] == "."
                && parts[1] == "versions"
                && valid_version(parts[2])
                && parts[3] == name)
                || (old_path == format!("./{name}")
                    && !existing["installed"].as_array().unwrap().is_empty()),
            "revision_conflict",
            "市场清单包含非受管路径。",
        )?;
        let expected = market_manifest(&market_name, name, old_path);
        ensure(
            previous == expected,
            "revision_conflict",
            "市场清单包含作者改动，请手动核对。",
        )?;
        let previous_package = market.join(old_path);
        let previous_files = bytes(&previous_package)?;
        let manifest: Value = serde_json::from_slice(
            previous_files
                .get("plugin.json")
                .or_else(|| previous_files.get(".codex-plugin/plugin.json"))
                .ok_or_else(|| Error::new("hetu.integrity_failure", "旧市场包缺少身份。"))?,
        )?;
        ensure(
            valid_version(text(&manifest, "version")?),
            "hetu.integrity_failure",
            "旧市场包版本无效。",
        )?;
        let cache = codex_home()?
            .join("plugins/cache")
            .join(&market_name)
            .join(name)
            .join(text(&manifest, "version")?);
        if cache.exists() {
            ensure(
                fingerprint(&bytes(&cache)?)? == fingerprint(&previous_files)?,
                "revision_conflict",
                "已有缓存包含不同内容，不覆盖作者修改。",
            )?;
        }
    }
    let relative = format!("./versions/{}/{name}", text(fixed, "version")?);
    validate_destination(&market.join(&relative), &files)?;
    let cache = codex_home()?
        .join("plugins/cache")
        .join(&market_name)
        .join(name)
        .join(text(fixed, "version")?);
    validate_destination(&cache, &files)?;
    begin()?;
    std::fs::create_dir_all(&market)?;
    let market_store = Store::open(&market)?;
    materialize(&market.join(&relative), &files)?;
    market_store.install(
        manifest_path,
        &serde_json::to_vec(&market_manifest(&market_name, name, &relative))?,
        false,
    )?;
    let market_path = market
        .to_str()
        .ok_or_else(|| Error::new("invalid_input", "安装目录不是有效UTF-8。"))?;
    command(&["plugin", "marketplace", "add", market_path, "--json"])?;
    command(&["plugin", "add", &format!("{name}@{market_name}"), "--json"])?;
    installed_codex(fixed)
}
fn market_manifest(market: &str, name: &str, path: &str) -> Value {
    json!({"name":market,"plugins":[{"name":name,"source":{"source":"local","path":path},
        "policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},"category":"Productivity"}]})
}
