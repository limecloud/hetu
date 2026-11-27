//! 两分钟本机观察缓存；固定客户端和会话，不缓存截图，不进入知识文件。
use super::record_digest;
use crate::{
    Error, Result,
    domain::{checked_id, id},
    infrastructure::store::Store,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const TTL_MS: u64 = 120_000;
const MAX_SNAPSHOTS: usize = 32;
const SNAPSHOT_BUDGET: usize = 512 * 1024;

pub struct SnapshotStore {
    root: PathBuf,
    client: String,
}
impl SnapshotStore {
    pub fn new(directory: &Path, client: &str) -> Result<Self> {
        if !directory.is_absolute()
            || !matches!(client, "codex" | "claude-code" | "workbuddy" | "generic")
        {
            return Err(Error::new(
                "invalid_input",
                "电脑观察缓存位置或客户端无效。",
            ));
        }
        Ok(Self {
            root: directory.join("computer").join(client),
            client: client.into(),
        })
    }
    fn open(&self) -> Result<Store> {
        crate::external_execution::private_dir(&self.root)?;
        let store = Store::open(&self.root)?;
        store.directory("snapshots")?;
        store.directory(".hetu/transactions")?;
        Ok(store)
    }
    pub fn read(&self, reference: &Value, session: &str, now: u64) -> Result<Value> {
        let id = checked_id(reference["id"].as_str().unwrap_or(""), "csnp")?;
        let store = self.open()?;
        // 独立缓存不使用知识多文件事务；读取与过期清理共用短锁。
        let _lock = store.lock()?;
        let file = format!("snapshots/{id}.json");
        if !store.exists(&file)? {
            return Err(Error::new(
                "snapshot_not_found",
                "原快照不存在或已过期，请重新观察原窗口。",
            ));
        }
        let bytes = store.read(&file)?;
        if bytes.len() > SNAPSHOT_BUDGET {
            return Err(Error::new("snapshot_invalid", "原快照超过预算。"));
        }
        let record: Value = serde_json::from_slice(&bytes)?;
        if record["client"] != self.client || record["session_id"] != session || record["id"] != id
        {
            return Err(Error::new("forbidden", "快照不属于此客户端和会话。"));
        }
        if reference["sha256"] != record_digest(&record)? {
            return Err(Error::new("snapshot_invalid", "固定快照摘要不一致。"));
        }
        let created = record["created_at_ms"]
            .as_u64()
            .ok_or_else(|| Error::new("invalid_input", "原快照时间无效。"))?;
        if created > now
            || record["expires_at_ms"].as_u64() != created.checked_add(TTL_MS)
            || now >= created + TTL_MS
        {
            return Err(Error::new(
                "snapshot_expired",
                "原观察快照已过期；没有沿用旧元素引用。",
            ));
        }
        Ok(record)
    }
    pub fn save(&self, data: &Value, session: &str, now: u64) -> Result<Value> {
        let mut data = data.clone();
        data.as_object_mut()
            .ok_or_else(|| Error::new("invalid_input", "快照结果不是对象。"))?
            .remove("screenshot");
        let record = json!({"version":1,"id":id("csnp"),"client":self.client,"session_id":session,"created_at_ms":now,"expires_at_ms":now+TTL_MS,"data":data});
        let bytes = serde_json::to_vec(&record)?;
        if bytes.len() > SNAPSHOT_BUDGET {
            return Err(Error::new(
                "snapshot_budget_exceeded",
                "观察树超过缓存预算，请缩小max_nodes。",
            ));
        }
        let stage = |name: &str, error: Error| {
            Error::new(
                error.code,
                format!("电脑快照缓存{name}：{}", error.message),
            )
        };
        let store = self.open().map_err(|error| stage("打开", error))?;
        let _lock = store.lock().map_err(|error| stage("加锁", error))?;
        let mut active = 0;
        for leaf in store
            .entries("snapshots")
            .map_err(|error| stage("枚举", error))?
        {
            let Some(candidate) = leaf.strip_suffix(".json") else {
                continue;
            };
            if checked_id(candidate, "csnp").is_err() {
                continue;
            }
            let file = format!("snapshots/{leaf}");
            let old = store.read(&file)?;
            let old: Value = serde_json::from_slice(&old)?;
            if old["client"] != self.client {
                return Err(Error::new("snapshot_invalid", "缓存记录归属不一致。"));
            }
            if old["expires_at_ms"]
                .as_u64()
                .is_some_and(|expires| expires <= now)
            {
                // 缓存Owner只清理已过期的自有普通记录；不跟随链接、不删除知识或其他用户文件。
                std::fs::remove_file(self.root.join(file))?;
            } else {
                active += 1;
            }
        }
        if active >= MAX_SNAPSHOTS {
            return Err(Error::new(
                "snapshot_budget_exceeded",
                "活动快照已达上限，请等待原快照过期。",
            ));
        }
        store
            .install(
                &format!("snapshots/{}.json", record["id"].as_str().unwrap()),
                &bytes,
                true,
            )
            .map_err(|error| stage("保存", error))?;
        Ok(json!({"id":record["id"],"sha256":record_digest(&record)?}))
    }
}

pub fn same_window(left: &Value, right: &Value) -> bool {
    left["app"]["pid"].is_number()
        && left["app"]["launched_at_ms"].is_number()
        && left["app"]["pid"] == right["app"]["pid"]
        && left["app"]["launched_at_ms"] == right["app"]["launched_at_ms"]
        && left["window"]["window_id"] == right["window"]["window_id"]
}

pub fn query(record: &Value, input: &Value) -> Result<Value> {
    let rows = record["data"]["elements"]
        .as_array()
        .ok_or_else(|| Error::new("snapshot_invalid", "原快照缺少元素目录。"))?;
    let root = input["root_index"].as_u64();
    let root_path = if let Some(index) = root {
        Some(
            rows.iter()
                .find(|row| row["index"] == index)
                .ok_or_else(|| Error::new("element_not_found", "原快照不存在此元素。"))?["route"]
                .as_array()
                .ok_or_else(|| Error::new("invalid_input", "元素路径无效。"))?,
        )
    } else {
        None
    };
    let text = input["query"].as_str().unwrap_or("").to_lowercase();
    let found: Vec<_> = rows
        .iter()
        .filter(|row| {
            let in_root = root_path.is_none_or(|path| {
                row["route"]
                    .as_array()
                    .is_some_and(|route| route.starts_with(path))
            });
            let role = input["role"]
                .as_str()
                .is_none_or(|role| row["role"] == role);
            let matches = text.is_empty()
                || ["title", "description", "identifier", "value"]
                    .iter()
                    .any(|key| {
                        row[key]
                            .as_str()
                            .is_some_and(|value| value.to_lowercase().contains(&text))
                    });
            in_root && role && matches
        })
        .collect();
    let offset = input["offset"].as_u64().unwrap_or(0) as usize;
    let limit = input["limit"].as_u64().unwrap_or(64) as usize;
    let total = found.len();
    let end = offset.saturating_add(limit).min(total);
    Ok(
        json!({"snapshot_ref":input["snapshot_ref"],"session_id":record["session_id"],"app":record["data"]["app"],"window":record["data"]["window"],"created_at_ms":record["created_at_ms"],"expires_at_ms":record["expires_at_ms"],"elements":found.into_iter().skip(offset).take(limit).collect::<Vec<_>>(),"offset":offset,"next_offset":if end<total{json!(end)}else{Value::Null},"total_count":total,"complete":end>=total,"truncation":record["data"]["truncation"],"current_window":"not_checked","pixels_cached":false}),
    )
}

pub fn diff(before: &Value, after: &Value, reference: &Value) -> Result<Value> {
    if !same_window(before, after) {
        return Err(Error::new(
            "forbidden",
            "比较基线不属于同一原生应用和窗口。",
        ));
    }
    let rows = |value: &Value| -> Result<std::collections::BTreeMap<String, Value>> {
        value["elements"]
            .as_array()
            .ok_or_else(|| Error::new("snapshot_invalid", "比较基线缺少元素。"))?
            .iter()
            .map(|row| Ok((serde_json::to_string(&row["route"])?, row.clone())))
            .collect()
    };
    let old = rows(before)?;
    let new = rows(after)?;
    Ok(
        json!({"base_snapshot_ref":reference,"identity_semantics":"structural_path_not_cross_snapshot_element_identity","added":new.iter().filter(|(key,_)|!old.contains_key(*key)).map(|(_,row)|row).collect::<Vec<_>>(),"removed":old.iter().filter(|(key,_)|!new.contains_key(*key)).map(|(_,row)|row).collect::<Vec<_>>(),"changed":new.iter().filter_map(|(key,row)|old.get(key).filter(|old|*old!=row).map(|old|json!({"before":old,"after":row}))).collect::<Vec<_>>()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tree() -> Value {
        json!({"app":{"pid":7,"launched_at_ms":11},"window":{"window_id":9},"elements":[{"index":0,"route":[],"role":"AXWindow"},{"index":1,"route":[0],"role":"AXButton","title":"目标"}],"screenshot":{"data":"PIXELS_NOT_TO_STORE"},"truncation":{"truncated":false}})
    }
    #[test]
    fn fixed_snapshot_ref_scope_expiry_tamper_and_pixels_are_separate() {
        let dir = tempfile::tempdir().unwrap();
        let store = SnapshotStore::new(dir.path(), "generic").unwrap();
        let reference = store.save(&tree(), "session", 1000).unwrap();
        let record = store.read(&reference, "session", 1100).unwrap();
        assert!(record["data"].get("screenshot").is_none());
        assert_eq!(
            store.read(&reference, "other", 1100).unwrap_err().code,
            "forbidden"
        );
        assert_eq!(
            store.read(&reference, "session", 121000).unwrap_err().code,
            "snapshot_expired"
        );
        let mut bad = reference.clone();
        bad["sha256"] = json!("f".repeat(64));
        assert_eq!(
            store.read(&bad, "session", 1100).unwrap_err().code,
            "snapshot_invalid"
        );
        assert!(
            SnapshotStore::new(dir.path(), "codex")
                .unwrap()
                .read(&reference, "session", 1100)
                .is_err()
        );
    }
    #[test]
    fn namespace_query_subtree_and_window_identity_keep_the_original_snapshot() {
        let record = json!({"session_id":"s","data":tree()});
        let result = query(&record, &json!({"query":"目标","root_index":0,"limit":1})).unwrap();
        assert_eq!(result["elements"].as_array().unwrap().len(), 1);
        assert_eq!(result["elements"][0]["index"], 1);
        assert_eq!(result["complete"], true);
        assert_eq!(result["current_window"], "not_checked");
        assert!(query(&record, &json!({"root_index":99})).is_err());
        let mut other = tree();
        other["app"]["launched_at_ms"] = json!(12);
        assert!(diff(&tree(), &other, &json!({})).is_err());
    }
    #[test]
    fn live_cache_quota_is_bounded_and_expired_entries_are_cleaned_without_evicting_live_refs() {
        let dir = tempfile::tempdir().unwrap();
        let store = SnapshotStore::new(dir.path(), "generic").unwrap();
        let first = store.save(&tree(), "s", 1000).unwrap();
        for _ in 1..MAX_SNAPSHOTS {
            store.save(&tree(), "s", 1000).unwrap();
        }
        assert_eq!(
            store.save(&tree(), "s", 1100).unwrap_err().code,
            "snapshot_budget_exceeded"
        );
        assert!(store.read(&first, "s", 1100).is_ok());
        let next = store.save(&tree(), "s", 122000).unwrap();
        assert!(store.read(&next, "s", 122001).is_ok());
        assert_eq!(
            store.read(&first, "s", 122001).unwrap_err().code,
            "snapshot_not_found"
        );
    }
    #[cfg(unix)]
    #[test]
    fn forged_cache_file_cannot_follow_a_symlink_or_hard_link() {
        let dir = tempfile::tempdir().unwrap();
        let store = SnapshotStore::new(dir.path(), "generic").unwrap();
        let reference = store.save(&tree(), "s", 1000).unwrap();
        let file = store.root.join(format!(
            "snapshots/{}.json",
            reference["id"].as_str().unwrap()
        ));
        let original = store.root.join("original.json");
        std::fs::rename(&file, &original).unwrap();
        std::os::unix::fs::symlink(&original, &file).unwrap();
        assert!(store.read(&reference, "s", 1100).is_err());
        std::fs::remove_file(&file).unwrap();
        std::fs::hard_link(&original, &file).unwrap();
        assert!(store.read(&reference, "s", 1100).is_err());
        assert!(original.is_file());
    }
}
