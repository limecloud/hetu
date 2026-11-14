use super::*;

// 版本化业务记录共用摘要链；缩略图、列表缓存不参与权威内容。
impl Kernel {
    pub(super) fn record_ids(&self, collection: &str, prefix: &str) -> Result<Vec<String>> {
        let mut parent = String::new();
        for part in collection.split('/') {
            if !self.store.entries(&parent)?.iter().any(|name| name == part) {
                return Ok(Vec::new());
            }
            if !parent.is_empty() {
                parent.push('/');
            }
            parent.push_str(part);
        }
        let mut ids = Vec::new();
        for name in self.store.entries(collection)? {
            if !name.starts_with(&format!("{prefix}_")) {
                continue;
            }
            checked_id(&name, prefix)?;
            // 中断首次事务留下的空目录不是已保存记录。
            if self
                .store
                .exists(&format!("{collection}/{name}/head.json"))?
            {
                ids.push(name);
            } else if self
                .store
                .exists(&format!("{collection}/{name}/project.json"))?
            {
                return Err(Error::new(
                    "unsupported_version",
                    "发现旧版短剧项目，请保留原文件并先完成格式升级。",
                ));
            }
        }
        Ok(ids)
    }
    pub(super) fn versioned_record(
        &self,
        collection: &str,
        object_id: &str,
        id_field: &str,
        revision: Option<u64>,
    ) -> Result<(Value, String, Value)> {
        let root = format!("{collection}/{object_id}");
        let head = self.store.json(&format!("{root}/head.json"))?;
        let latest = integer(&head, "revision")?;
        let target = revision.unwrap_or(latest);
        ensure(
            target > 0 && target <= latest,
            "not_found",
            "所选修订不存在。",
        )?;
        ensure(
            latest - target < 1000,
            "hetu.budget_exceeded",
            "历史核验超过单次预算。",
        )?;
        let mut expected = text(&head, "sha256")?.to_owned();
        let mut current = Value::Null;
        for number in (target..=latest).rev() {
            let content = self
                .store
                .read(&format!("{root}/revisions/{number}.json"))?;
            let sha = digest(&content);
            ensure(
                content.len() <= 4 * 1024 * 1024 && sha == expected,
                "hetu.integrity_failure",
                "记录摘要不一致，请保留原文件并检查。",
            )?;
            let record: Value = serde_json::from_slice(&content)?;
            ensure(
                record[id_field] == object_id
                    && record["workspace_id"] == self.scope()
                    && record["revision"] == number,
                "hetu.integrity_failure",
                "记录身份、作品或修订不一致。",
            )?;
            ensure(
                (number == 1 && record["previous_sha256"].is_null())
                    || (number > 1
                        && record["previous_sha256"]
                            .as_str()
                            .is_some_and(|s| s.len() == 64)),
                "hetu.integrity_failure",
                "记录修订链不完整。",
            )?;
            if number == latest {
                ensure(
                    head == json!({id_field:object_id,"revision":number,"sha256":sha}),
                    "hetu.integrity_failure",
                    "记录当前索引不一致。",
                )?;
                current = record.clone();
            }
            ensure(
                record["created_at"] == current["created_at"],
                "hetu.integrity_failure",
                "记录创建时间被改写。",
            )?;
            if number == target {
                return Ok((record, sha, current));
            }
            expected = text(&record, "previous_sha256")?.to_owned();
        }
        unreachable!("validated revision range")
    }

    pub(super) fn stage_versioned_record(
        &self,
        collection: &str,
        id_field: &str,
        record: &Value,
        changes: &mut Changes,
    ) -> Result<String> {
        let object_id = text(record, id_field)?;
        let revision = integer(record, "revision")?;
        let root = format!("{collection}/{object_id}");
        self.store.directory(&format!("{root}/revisions"))?;
        let path = format!("{root}/revisions/{revision}.json");
        ensure(
            !self.store.exists(&path)? && !changes.contains_key(&path),
            "hetu.integrity_failure",
            "历史修订不能覆盖。",
        )?;
        let content = bytes(record)?;
        ensure(
            content.len() <= 4 * 1024 * 1024,
            "hetu.budget_exceeded",
            "记录超过保存预算。",
        )?;
        let sha = digest(&content);
        changes.insert(path, content);
        changes.insert(
            format!("{root}/head.json"),
            bytes(&json!({id_field:object_id,"revision":revision,"sha256":sha}))?,
        );
        Ok(sha)
    }

    pub(super) fn advance_record(&self, record: &mut Value, sha: &str) -> Result<()> {
        record["previous_sha256"] = json!(sha);
        record["revision"] = json!(
            integer(record, "revision")?
                .checked_add(1)
                .filter(|n| *n <= 9_007_199_254_740_991)
                .ok_or_else(|| Error::new("hetu.budget_exceeded", "修订已达上限。"))?
        );
        record["updated_at"] = json!(now());
        record["actor_ref"] = json!(self.actor());
        Ok(())
    }
}
