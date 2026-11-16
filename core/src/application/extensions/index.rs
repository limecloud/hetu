//! 可丢弃的标题元数据投影；权威对象与授权始终由Core核验。
use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use std::collections::BTreeMap;

const MAX_OBJECTS: usize = 10_000;
const SCAN_BYTES: usize = 32 * 1024 * 1024;
const CACHE_BYTES: usize = 8 * 1024 * 1024;

fn fixed_digest(value: &Value) -> Result<String> {
    Ok(digest(serde_json_canonicalizer::to_vec(value)?))
}
fn visible_kinds(grant: Option<&Value>) -> Value {
    grant.map_or(Value::Null, |grant| {
        let mut kinds: Vec<_> = grant["types"].as_array().unwrap().iter()
            .map(|kind| kind["kind"].clone()).collect();
        kinds.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
        json!(kinds)
    })
}
fn visible(kinds: &Value, kind: &Value) -> bool {
    kinds.is_null() || kinds.as_array().is_some_and(|values| values.contains(kind))
}
fn summary(record: &Value, sha: &str) -> Value {
    json!({"object_id":record["object_id"],"work_ref":record["work_ref"],
        "owner_plugin_id":record["owner_plugin_id"],"kind":record["kind"],
        "title":record["title"],"schema_version":record["schema_version"],
        "revision":record["revision"],"sha256":sha,"updated_at":record["updated_at"]})
}
struct Projection {
    state: &'static str,
    rows: Option<Vec<Value>>,
}

impl Kernel {
    fn extension_heads(&self, work: &Value, owner: &str) -> Result<(BTreeMap<String, Value>, String)> {
        let root = collection(work, owner)?;
        let ids = self.record_ids(&root, "ext")?;
        ensure(ids.len() <= MAX_OBJECTS, "hetu.budget_exceeded", "插件对象超过单次索引枚举预算。")?;
        let mut heads = BTreeMap::new();
        for object in ids {
            let head = self.store.json(&format!("{root}/{object}/head.json"))?;
            closed(&head, &["object_id", "revision", "sha256"], &[])?;
            ensure(head["object_id"] == object && integer(&head, "revision")? > 0,
                "hetu.integrity_failure", "插件对象当前索引身份无效。")?;
            sha(text(&head, "sha256")?)?;
            heads.insert(object, head);
        }
        let snapshot = fixed_digest(&json!({"work_ref":work,"owner_plugin_id":owner,"heads":heads}))?;
        Ok((heads, snapshot))
    }

    fn extension_index_path(&self, work: &Value, owner: &str, kinds: &Value) -> Result<String> {
        Ok(format!(".hetu/cache/extension-index/{}/{}.json", scope_key(work, owner)?, fixed_digest(kinds)?))
    }

    fn extension_projection(&self, work: &Value, owner: &str, kinds: &Value,
        heads: &BTreeMap<String, Value>, snapshot: &str) -> Result<Projection> {
        let path = self.extension_index_path(work, owner, kinds)?;
        if !self.store.exists(&path)? {
            return Ok(Projection { state: "missing", rows: None });
        }
        let read = (|| -> Result<Projection> {
            let raw = self.store.read(&path)?;
            ensure(raw.len() <= CACHE_BYTES, "hetu.budget_exceeded", "插件索引超过预算。")?;
            let cache: Value = serde_json::from_slice(&raw)
                .map_err(|_| Error::new("hetu.integrity_failure", "插件派生索引损坏。"))?;
            closed(&cache, &["payload", "sha256"], &[])?;
            let payload = &cache["payload"];
            closed(payload, &["version", "work_ref", "owner_plugin_id", "visible_kinds", "source_sha256", "objects"], &[])?;
            ensure(payload["version"] == 1 && payload["work_ref"] == *work
                && payload["owner_plugin_id"] == owner && payload["visible_kinds"] == *kinds
                && fixed_digest(payload)? == cache["sha256"],
                "hetu.integrity_failure", "插件派生索引身份或校验和无效。")?;
            if payload["source_sha256"] != snapshot {
                return Ok(Projection { state: "stale", rows: None });
            }
            let rows = payload["objects"].as_array()
                .ok_or_else(|| Error::new("hetu.integrity_failure", "插件索引条目无效。"))?;
            ensure(rows.len() <= heads.len(), "hetu.integrity_failure", "插件索引条目数量无效。")?;
            let mut previous = "";
            for row in rows {
                closed(row, &["object_id", "work_ref", "owner_plugin_id", "kind", "title", "schema_version", "revision", "sha256", "updated_at"], &[])?;
                let object = checked_id(text(row, "object_id")?, "ext")?;
                ensure(object.as_str() > previous && row["work_ref"] == *work
                    && row["owner_plugin_id"] == owner && visible(kinds, &row["kind"])
                    && heads.get(&object).is_some_and(|head| head["sha256"] == row["sha256"] && head["revision"] == row["revision"]),
                    "hetu.integrity_failure", "插件索引条目归属或来源无效。")?;
                for field in ["kind", "title", "schema_version", "updated_at"] { text(row, field)?; }
                previous = row["object_id"].as_str().unwrap();
            }
            Ok(Projection { state: "ready", rows: Some(rows.clone()) })
        })();
        match read {
            Ok(projection) => Ok(projection),
            Err(error) if matches!(error.code, "hetu.integrity_failure" | "invalid_input" | "hetu.budget_exceeded") =>
                Ok(Projection { state: "invalid", rows: None }),
            Err(error) => Err(error),
        }
    }

    fn extension_index_rows(&self, work: &Value, owner: &str, kinds: &Value,
        heads: &BTreeMap<String, Value>) -> Result<Vec<Value>> {
        let mut rows = Vec::new();
        let mut scanned = 0;
        for object in heads.keys() {
            let (record, sha) = self.extension_object(work, owner, object, None)?;
            scanned += bytes(&record)?.len();
            ensure(scanned <= SCAN_BYTES, "hetu.budget_exceeded", "插件索引核验超过32MiB预算。")?;
            if visible(kinds, &record["kind"]) { rows.push(summary(&record, &sha)); }
        }
        Ok(rows)
    }

    pub(super) fn extension_index(&self, work: &Value, owner: &str, action: &str,
        input: &Value, grant: Option<&Value>) -> Result<Value> {
        let kinds = visible_kinds(grant);
        let (heads, snapshot) = self.extension_heads(work, owner)?;
        let projection = self.extension_projection(work, owner, &kinds, &heads, &snapshot)?;
        if action == "hetu.extensions.index.status" {
            return Ok(domain::success(action, self.scope(), json!({"state":projection.state,
                "source_sha256":snapshot,"indexed_objects":projection.rows.as_ref().map(Vec::len)})));
        }
        if action == "hetu.extensions.index.rebuild" {
            let rows = self.extension_index_rows(work, owner, &kinds, &heads)?;
            let payload = json!({"version":1,"work_ref":work,"owner_plugin_id":owner,
                "visible_kinds":kinds,"source_sha256":snapshot,"objects":rows});
            let content = bytes(&json!({"sha256":fixed_digest(&payload)?,"payload":payload}))?;
            ensure(content.len() <= CACHE_BYTES, "hetu.budget_exceeded", "插件派生索引超过8MiB预算。")?;
            self.store.install(&self.extension_index_path(work, owner, &kinds)?, &content, false)?;
            return Ok(domain::success(action, self.scope(), json!({"state":"ready","source_sha256":snapshot,
                "indexed_objects":rows.len(),"authority_changed":false})));
        }
        ensure(action == "hetu.extensions.objects.search", "hetu.capability_unavailable", "未知插件索引动作。")?;
        let query = text(input, "query")?.trim().to_lowercase();
        let limit = input["limit"].as_u64().unwrap_or(50) as usize;
        let binding = json!({"work_ref":work,"owner_plugin_id":owner,"visible_kinds":kinds,
            "grant_id":grant.map(|g| &g["grant_id"]),"package_sha256":grant.map(|g| &g["package_sha256"]),
            "query":query,"kind":input.get("kind"),"limit":limit,"source_sha256":snapshot});
        let binding_sha = fixed_digest(&binding)?;
        let after = if input.get("cursor").is_some() {
            let decoded = URL_SAFE_NO_PAD.decode(text(input, "cursor")?)
                .map_err(|_| Error::new("invalid_input", "插件检索游标编码无效。"))?;
            let cursor: Value = serde_json::from_slice(&decoded)
                .map_err(|_| Error::new("invalid_input", "插件检索游标无效。"))?;
            closed(&cursor, &["version", "binding_sha256", "after"], &[])?;
            ensure(cursor["version"] == 1 && cursor["binding_sha256"] == binding_sha,
                "hetu.stale_evidence", "检索内容、查询或授权已变化，请从第一页重新读取。")?;
            let after = checked_id(text(&cursor, "after")?, "ext")?;
            ensure(heads.contains_key(&after), "hetu.stale_evidence", "游标对象已不属于当前快照。")?;
            after
        } else { String::new() };
        let rows = match projection.rows {
            Some(rows) => rows,
            None => self.extension_index_rows(work, owner, &kinds, &heads)?,
        };
        let mut objects: Vec<_> = rows.into_iter().filter(|row|
            row["object_id"].as_str().is_some_and(|id| id > after.as_str())
                && input.get("kind").is_none_or(|kind| *kind == row["kind"])
                && row["title"].as_str().is_some_and(|title| title.to_lowercase().contains(&query)))
            .take(limit + 1).collect();
        let more = objects.len() > limit;
        if more { objects.pop(); }
        // 投影只用于定位；真正返回给调用方的修订仍逐项核验权威记录。
        for row in &objects {
            let (record, sha) = self.extension_object(work, owner, text(row, "object_id")?, None)?;
            ensure(summary(&record, &sha) == *row, "hetu.integrity_failure", "插件检索投影与权威对象不一致，请重建索引。")?;
        }
        let cursor = more.then(|| URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({"version":1,
            "binding_sha256":binding_sha,"after":objects.last().unwrap()["object_id"]})).unwrap()));
        Ok(domain::success(action, self.scope(), json!({"objects":objects,"next_cursor":cursor,
            "source_sha256":snapshot,"index_state":projection.state})))
    }
}
