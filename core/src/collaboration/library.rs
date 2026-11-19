//! 桌面位置登记的目录投影；内容读取仍逐作品使用当前客户端已有的授权。
use super::*;
use std::collections::BTreeSet;

const DISPLAY_FIELDS: &[&str] = &[
    "work_ref",
    "title",
    "author_name",
    "genre",
    "status",
    "archived",
    "chapter_count",
    "created_at",
    "updated_at",
];

impl CollaborationHub {
    pub(super) fn library(&self, input: &Value, cancelled: &dyn Fn() -> bool) -> Result<Value> {
        let parent = self.library_directory()?;
        let file = parent.join("creative-library.json");
        let mut rows = Vec::new();
        let mut seen = BTreeSet::new();
        let registered = file.try_exists()?;
        if registered {
            let store = Store::open(&parent)?;
            let bytes = store.read("creative-library.json")?;
            ensure(
                bytes.len() <= 4 * 1024 * 1024,
                "hetu.budget_exceeded",
                "创作库登记超过读取预算。",
            )?;
            let record: Value = serde_json::from_slice(&bytes).map_err(|_| {
                Error::new(
                    "hetu.integrity_failure",
                    "创作库登记损坏，请保留记录并检查。",
                )
            })?;
            ensure(
                record["schema_version"] == 1 && record["roots"].is_array(),
                "hetu.integrity_failure",
                "创作库登记格式无效。",
            )?;
            let roots = record["roots"].as_array().unwrap();
            ensure(
                roots.len() <= 1000,
                "hetu.budget_exceeded",
                "创作库登记超过支持上限。",
            )?;
            for root in roots {
                let works = root["works"]
                    .as_array()
                    .ok_or_else(|| Error::new("hetu.integrity_failure", "创作库作品目录无效。"))?;
                for work in works {
                    check_work(&work["work_ref"])?;
                    ensure(
                        work["work_ref"]["workspace_id"] == root["workspace_id"]
                            && work["title"].as_str().is_some_and(|s| s.len() <= 4096),
                        "hetu.integrity_failure",
                        "创作库作品身份或名称无效。",
                    )?;
                    if seen.insert(key(&work["work_ref"])) {
                        rows.push(display(work));
                    }
                }
            }
        }
        // 私有授权映射只用于解析已有范围；路径及其他客户端授权不进入目录投影。
        let mut references = Vec::new();
        if self.directory.try_exists()? {
            let store = Store::open(&self.directory)?;
            let _guard = store.read_lock()?;
            let folder = format!("management/{}", self.client);
            if store.entries("")?.iter().any(|name| name == "management")
                && store
                    .entries("management")?
                    .iter()
                    .any(|name| name == &self.client)
            {
                for name in store.entries(&folder)? {
                    let grant = store.json(&format!("{folder}/{name}"))?;
                    if grant["revoked"] != false
                        || grant["client_adapter"] != self.client
                        || grant["expires_at"].as_i64().is_some_and(|at| {
                            at <= time::OffsetDateTime::now_utc().unix_timestamp()
                        })
                    {
                        continue;
                    }
                    if grant["authorized_workspace"] == true {
                        let grant_id = name.strip_suffix(".json").unwrap_or("");
                        if grant_id.len() != 64 {
                            continue;
                        }
                        let reference = json!({"scope_ref":{"kind":"workspace","id":grant["workspace_id"]},
                            "grant_id":grant_id,"grant_revision":grant["grant_revision"]});
                        references.push((reference, grant.get("work_ref").cloned()));
                    } else if grant["created_workspace"]["management_ref"].is_object() {
                        let created = &grant["created_workspace"];
                        // 旧新建记录可能只有工作区位置；不能据此推断具体作品权限。
                        if check_work(&created["work_ref"]).is_err() {
                            continue;
                        }
                        if !registered && seen.insert(key(&created["work_ref"])) {
                            rows.push(json!({"work_ref":created["work_ref"],"title":"未命名作品"}));
                        }
                        references.push((
                            created["management_ref"].clone(),
                            Some(created["work_ref"].clone()),
                        ));
                    }
                }
            }
        }
        ensure(
            rows.len() <= 10000,
            "hetu.budget_exceeded",
            "创作库作品数量超过读取预算。",
        )?;
        for row in &mut rows {
            if cancelled() {
                return Err(Error::new("cancelled", "创作库读取已取消。"));
            }
            row["authorized"] = json!(false);
            for (reference, exact) in &references {
                if reference["scope_ref"]["id"] != row["work_ref"]["workspace_id"]
                    || exact.as_ref().is_some_and(|work| work != &row["work_ref"])
                {
                    continue;
                }
                let checked = self.request_cancellable(
                    json!({"action":"hetu.works.get","contract_revision":"1",
                    "input":{"management_ref":reference,"work_ref":row["work_ref"]}}),
                    cancelled,
                );
                if checked["status"] == "succeeded" {
                    for (field, value) in display(&checked["data"]["summary"]).as_object().unwrap()
                    {
                        row[field] = value.clone();
                    }
                    row["authorized"] = json!(true);
                    row["management_ref"] = reference.clone();
                    break;
                }
                row["access_error"] = json!("原作品授权或位置已不可用，请重新核对接入。");
            }
        }
        if !registered {
            rows.retain(|row| row["authorized"] == true);
        }
        let sha = digest(serde_json_canonicalizer::to_vec(&rows)?);
        let offset = if let Some(cursor) = input["cursor"].as_str() {
            let (expected, position) = cursor
                .split_once(':')
                .ok_or_else(|| Error::new("invalid_input", "创作库分页引用无效。"))?;
            ensure(
                expected == sha,
                "hetu.stale_request",
                "创作库或授权已变化，请刷新目录。",
            )?;
            position
                .parse::<usize>()
                .map_err(|_| Error::new("invalid_input", "创作库分页位置无效。"))?
        } else {
            0
        };
        ensure(
            offset <= rows.len(),
            "invalid_input",
            "创作库分页位置超出目录。",
        )?;
        let end = offset
            .saturating_add(input["limit"].as_u64().unwrap_or(100) as usize)
            .min(rows.len());
        Ok(
            json!({"works":rows[offset..end],"total":rows.len(),"catalog_sha256":sha,
            "registered":registered,"source":if registered {"desktop_catalog"} else {"client_created_works"},
            "next_cursor":if end < rows.len() { json!(format!("{sha}:{end}")) } else { Value::Null }}),
        )
    }

    fn library_directory(&self) -> Result<PathBuf> {
        if let Some(profile) = std::env::var_os("HETU_DESKTOP_PROFILE") {
            let path = PathBuf::from(profile);
            ensure(
                path.is_absolute(),
                "invalid_input",
                "桌面资料目录必须为绝对路径。",
            )?;
            return Ok(path);
        }
        if self.directory != default_directory()? {
            return self
                .directory
                .parent()
                .map(Path::to_path_buf)
                .ok_or_else(|| Error::new("missing_context", "无法确定创作库登记位置。"));
        }
        #[cfg(windows)]
        {
            return std::env::var_os("APPDATA")
                .map(|root| PathBuf::from(root).join("Hetu"))
                .ok_or_else(|| Error::new("missing_context", "无法确定桌面创作库位置。"));
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let config = std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config"))
                })
                .ok_or_else(|| Error::new("missing_context", "无法确定桌面创作库位置。"))?;
            return Ok(config.join("Hetu"));
        }
        #[cfg(target_os = "macos")]
        self.directory
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| Error::new("missing_context", "无法确定桌面创作库位置。"))
    }
}

fn key(reference: &Value) -> String {
    reference.to_string()
}
fn display(work: &Value) -> Value {
    Value::Object(
        DISPLAY_FIELDS
            .iter()
            .filter_map(|field| work.get(*field).map(|v| ((*field).to_owned(), v.clone())))
            .collect(),
    )
}
fn check_work(reference: &Value) -> Result<()> {
    checked_id(text(reference, "workspace_id")?, "workspace")?;
    let prefix = match text(reference, "kind")? {
        "novel" => "novel",
        "drama" => "drama",
        "video" => "video",
        _ => return Err(Error::new("hetu.integrity_failure", "创作对象类型无效。")),
    };
    checked_id(text(reference, "object_id")?, prefix)?;
    Ok(())
}
