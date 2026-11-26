//! 本机资料计量与固定清理；作品目录不作为清理输入。
use super::*;
use crate::infrastructure::local_storage as files;
use std::collections::BTreeSet;

const CACHES: &[&str] = &[
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
];
fn category(path: &str) -> (&'static str, &'static str) {
    let top = path.split('/').next().unwrap_or("");
    if CACHES.contains(&top) {
        ("cache", "界面缓存")
    } else {
        match top {
            "agent-sessions" => ("sessions", "会话记录"),
            "Collaboration" => ("collaboration", "协作资料与任务"),
            "DevelopmentRuntimes" | "AgentPackages" => ("runtimes", "运行环境"),
            "PluginHost" => ("plugins", "插件与扩展"),
            "CreationProjects" => ("works", "本机创作资料"),
            _ => ("other", "设置与其他资料"),
        }
    }
}
fn removed_record(value: &Value) -> bool {
    fn projection(value: &Value) -> bool {
        value.is_object()
            && ["draft", "gui_draft", "tui_draft"]
                .iter()
                .all(|key| value.get(*key).is_none_or(|v| v.as_str() == Some("")))
            && value["pending_request"].is_null()
            && value
                .get("requests")
                .is_none_or(|v| v.as_array().is_some_and(Vec::is_empty))
            && value["messages"].as_array().is_some_and(|messages| {
                messages.iter().all(|m| {
                    matches!(m["role"].as_str(), Some("user" | "assistant" | "system"))
                        && m["text"].is_string()
                        && m.get("delivery")
                            .is_none_or(|d| matches!(d.as_str(), Some("accepted" | "rejected")))
                })
            })
            && value.get("tools").is_none_or(|v| {
                v.as_array().is_some_and(|tools| {
                    tools.iter().all(|t| {
                        matches!(
                            t["state"].as_str(),
                            Some("completed" | "failed" | "interrupted")
                        )
                    })
                })
            })
    }
    value["schema_version"] == 1
        && value["session_id"]
            .as_str()
            .is_some_and(|id| id.starts_with("codex-") || id.starts_with("terminal-"))
        && projection(value)
        && value.get("threads").is_none_or(|v| {
            v.as_object()
                .is_some_and(|threads| threads.values().all(projection))
        })
}
impl LocalSettings {
    fn storage_root(&self) -> Result<(Store, PathBuf)> {
        ensure(
            matches!(
                self.directory.file_name().and_then(|v| v.to_str()),
                Some("LocalSettings" | "local-settings")
            ),
            "hetu.capability_unavailable",
            "当前本机设置未连接标准资料目录，无法扫描存储。",
        )?;
        let root = self.directory.parent().unwrap().to_path_buf();
        Ok((Store::open(&root)?, root))
    }
    pub(super) fn inspect_storage(&self) -> Result<Value> {
        let (store, root) = self.storage_root()?;
        let identity = crate::infrastructure::platform::identity(&root)?;
        let mut folders = vec![(String::new(), 0usize)];
        let mut categories: BTreeMap<String, Value> = BTreeMap::new();
        let mut candidates = Vec::new();
        let mut issues = Vec::new();
        let mut visited = 0usize;
        let mut hashed = 0u64;
        while let Some((folder, depth)) = folders.pop() {
            if depth > 32 {
                issues.push(json!({"path":folder,"reason":"目录层级超过扫描上限"}));
                continue;
            }
            let names = match store.entries(&folder) {
                Ok(value) => value,
                Err(_) => {
                    issues.push(json!({"path":folder,"reason":"目录不可读取或包含异常链接"}));
                    continue;
                }
            };
            for name in names {
                visited += 1;
                if visited > 100_000 {
                    issues.push(json!({"reason":"文件数量超过扫描上限"}));
                    folders.clear();
                    break;
                }
                let path = if folder.is_empty() {
                    name
                } else {
                    format!("{folder}/{name}")
                };
                let (kind, label) = category(&path);
                let group = categories.entry(kind.into()).or_insert_with(
                    || json!({"id":kind,"name":label,"bytes":0,"files":0,"cleanable_bytes":0}),
                );
                let meta = match files::entry(&store, &path) {
                    Ok(Some(value)) => value,
                    Ok(None) => continue,
                    Err(_) => {
                        issues.push(json!({"path":path,"reason":"文件不可读取"}));
                        continue;
                    }
                };
                if meta["kind"] == "directory" {
                    folders.push((path, depth + 1));
                    continue;
                }
                if meta["kind"] != "file" {
                    issues.push(json!({"path":path,"reason":"链接或特殊文件已保留"}));
                    continue;
                }
                let bytes = meta["bytes"].as_u64().unwrap();
                group["bytes"] = json!(group["bytes"].as_u64().unwrap() + bytes);
                group["files"] = json!(group["files"].as_u64().unwrap() + 1);
                let removed = path
                    .strip_prefix("agent-sessions/removed/")
                    .is_some_and(|name| {
                        !name.contains('/')
                            && name.ends_with(".json")
                            && (name.starts_with("codex-") || name.starts_with("terminal-"))
                    });
                if kind != "cache" && !removed {
                    continue;
                }
                if candidates.len() >= 2000 || hashed.saturating_add(bytes) > 512 * 1024 * 1024 {
                    issues.push(json!({"path":path,"reason":"超过本次候选核验上限，已保留"}));
                    continue;
                }
                let mut title = path.rsplit('/').next().unwrap().to_owned();
                let mut record_sha = None;
                if removed {
                    match store.read(&path).and_then(|bytes| {
                        Ok((
                            serde_json::from_slice::<Value>(&bytes)?,
                            domain::digest(&bytes),
                        ))
                    }) {
                        Ok((value, sha)) if removed_record(&value) => {
                            record_sha = Some(sha);
                            if let Some(name) =
                                value["title"].as_str().filter(|v| !v.trim().is_empty())
                            {
                                title = name.to_owned();
                            }
                        }
                        _ => {
                            issues.push(json!({"path":path,"reason":"会话含草稿、待恢复内容或记录格式异常，已保留"}));
                            continue;
                        }
                    }
                }
                let fingerprint = match files::fingerprint(&store, &path) {
                    Ok(value)
                        if value["bytes"] == bytes
                            && record_sha
                                .as_ref()
                                .is_none_or(|sha| value["sha256"] == *sha) =>
                    {
                        value
                    }
                    _ => {
                        issues.push(json!({"path":path,"reason":"文件正在变化或无法核验，已保留"}));
                        continue;
                    }
                };
                hashed += bytes;
                let item = json!({"id":hash(&json!([identity,path]))?,"category":kind,"name":title,"path":path,"bytes":bytes,
                    "modified_at":fingerprint["modified_at"],"fingerprint":fingerprint});
                group["cleanable_bytes"] =
                    json!(group["cleanable_bytes"].as_u64().unwrap() + bytes);
                candidates.push(item);
            }
        }
        candidates.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        let snapshot = hash(&json!([identity, candidates]))?;
        let total: u64 = categories
            .values()
            .map(|v| v["bytes"].as_u64().unwrap())
            .sum();
        let cleanable: u64 = candidates
            .iter()
            .map(|v| v["bytes"].as_u64().unwrap())
            .sum();
        Ok(
            json!({"storage_snapshot":snapshot,"profile_identity":identity,"total_bytes":total,"cleanable_bytes":cleanable,
            "categories":categories.values().collect::<Vec<_>>(),"candidates":candidates,"issues":issues,"partial":!issues.is_empty(),
            "scope":"本机河图资料目录；外部作品目录未计入"}),
        )
    }
    pub(super) fn prepare_storage(&self, input: &Value) -> Result<Value> {
        let inspection = self.inspect_storage()?;
        ensure(
            input["storage_snapshot"] == inspection["storage_snapshot"],
            "revision_conflict",
            "存储明细已变化，请刷新后重新选择。",
        )?;
        let ids = input["selected_ids"]
            .as_array()
            .ok_or_else(|| Error::new("invalid_input", "请选择清理项目。"))?;
        let selected: BTreeSet<_> = ids.iter().filter_map(Value::as_str).collect();
        ensure(
            !selected.is_empty() && selected.len() == ids.len() && selected.len() <= 2000,
            "invalid_input",
            "清理选择为空、重复或超过上限。",
        )?;
        let items: Vec<_> = inspection["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| selected.contains(v["id"].as_str().unwrap()))
            .cloned()
            .collect();
        ensure(
            items.len() == selected.len(),
            "invalid_input",
            "清理项目已失效或不在允许范围内。",
        )?;
        let bytes: u64 = items.iter().map(|v| v["bytes"].as_u64().unwrap()).sum();
        Ok(
            json!({"profile_identity":inspection["profile_identity"],"storage_snapshot":input["storage_snapshot"],"items":items,"bytes":bytes}),
        )
    }
    pub(super) fn commit_storage(
        &self,
        mut plan: Value,
        input: &Value,
        state: &Value,
    ) -> Result<Value> {
        let (store, root) = self.storage_root()?;
        ensure(
            json!(crate::infrastructure::platform::identity(&root)?)
                == plan["fixed"]["storage"]["profile_identity"],
            "revision_conflict",
            "本机资料目录身份已变化，清理已停止。",
        )?;
        let operation = text(&plan, "operation_id")?.to_owned();
        let path = plan_path(&operation)?;
        if plan["state"] != "executing" {
            plan["state"] = json!("executing");
            plan["execute_key"] = input["operation_key"].clone();
            plan["file_results"] = json!([]);
            self.store
                .install(&path, &serde_json::to_vec(&plan)?, false)?;
        }
        let items = plan["fixed"]["storage"]["items"]
            .as_array()
            .unwrap()
            .clone();
        let stage_root = format!(
            "{}/storage-staging/{operation}",
            self.directory.file_name().unwrap().to_str().unwrap()
        );
        store.directory(&stage_root)?;
        for (index, item) in items
            .iter()
            .enumerate()
            .skip(plan["file_results"].as_array().unwrap().len())
        {
            let source = text(item, "path")?;
            let stage = format!("{stage_root}/{index}");
            // 暂存名与方案固定；崩溃后只处理原文件，不触及源路径的新文件。
            let result = (|| -> Result<&str> {
                if files::entry(&store, &stage)?.is_none() {
                    if files::entry(&store, source)?.is_none() {
                        return Ok("already_absent");
                    }
                    ensure(
                        files::fingerprint(&store, source)? == item["fingerprint"],
                        "revision_conflict",
                        "文件已变化，已保留。",
                    )?;
                    files::move_to_stage(&store, source, &stage)?;
                }
                files::remove_staged(&store, &stage, &item["fingerprint"])?;
                Ok("deleted")
            })();
            let record = match result {
                Ok(status) => {
                    json!({"id":item["id"],"name":item["name"],"status":status,"deleted_bytes":if status=="deleted"{item["bytes"].as_u64().unwrap()}else{0}})
                }
                Err(error) => {
                    json!({"id":item["id"],"name":item["name"],"status":"retained","deleted_bytes":0,"reason":error.message,"staging_path":stage})
                }
            };
            plan["file_results"].as_array_mut().unwrap().push(record);
            self.store
                .install(&path, &serde_json::to_vec(&plan)?, false)?;
        }
        let results = plan["file_results"].as_array().unwrap();
        plan["result"] = json!({"deleted_bytes":results.iter().map(|v| v["deleted_bytes"].as_u64().unwrap()).sum::<u64>(),
            "deleted_count":results.iter().filter(|v| v["status"]=="deleted").count(),"retained_count":results.iter().filter(|v| v["status"]=="retained").count(),
            "absent_count":results.iter().filter(|v| v["status"]=="already_absent").count()});
        plan["state"] = json!("executed");
        plan["revision"] = json!(plan["revision"].as_u64().unwrap() + 1);
        plan["executed_at"] = json!(domain::now());
        self.store
            .install(&path, &serde_json::to_vec(&plan)?, false)?;
        Ok(self.view(plan, state))
    }
}
