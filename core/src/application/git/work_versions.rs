//! 单作品文稿从空树建立版本链，不继承工作区或其他作品的树及历史。
use super::*;
use std::collections::BTreeMap;

fn reference(work: &Value) -> Result<String> {
    Ok(format!(
        "refs/heads/hetu-work/{}/{}",
        text(work, "kind")?,
        text(work, "object_id")?
    ))
}

impl Kernel {
    pub(crate) fn custom_git_authorization_path(&self) -> Option<&Path> {
        self.authorization_path.as_deref()
    }
    pub(in crate::application) fn git_requested_work(
        &self,
        input: &Value,
    ) -> Result<Option<Value>> {
        let Some(work) = input.get("work_ref") else {
            return Ok(None);
        };
        self.work_record(work, None)?;
        ensure(
            matches!(work["kind"].as_str(), Some("novel" | "drama")),
            "forbidden",
            "此版本合同仅保存小说和剧本文稿。",
        )?;
        Ok(Some(work.clone()))
    }

    /// 只允许公开文稿记录及固定正文修订；未知文件和私密审核失败关闭。
    pub(super) fn git_document_path(&self, work: &Value, path: &str) -> Result<bool> {
        let parts: Vec<_> = path.split('/').collect();
        if parts.len() < 5
            || parts[0] != "packages"
            || !matches!(parts[1], "novel" | "drama")
            || parts[2] != "documents"
        {
            return Ok(false);
        }
        if checked_id(parts[3], "doc").is_err() {
            return Ok(false);
        }
        let valid = parts.len() == 5 && parts[4] == "document.json"
            || parts.len() == 6
                && parts[4] == "revisions"
                && parts[5].rsplit_once('.').is_some_and(|(id, extension)| {
                    matches!(extension, "json" | "md" | "fountain") && checked_id(id, "rev").is_ok()
                });
        if !valid {
            return Ok(false);
        }
        let root = format!("packages/{}/documents/{}", parts[1], parts[3]);
        if !self.store.exists(&format!("{root}/document.json"))? {
            return Ok(false);
        }
        Ok(self.document_root(parts[3])? == root
            && self.document_in_work(&self.document(parts[3])?, work)?)
    }

    pub(in crate::application) fn check_git_snapshot_work(&self, input: &Value) -> Result<()> {
        let (snapshot, _) = self.git_snapshot(text(input, "snapshot_id")?)?;
        let requested = self.git_requested_work(input)?;
        let granted = self.granted_work()?;
        if requested.is_some() || granted.is_some() {
            ensure(
                snapshot.get("work_ref") == requested.as_ref()
                    && granted
                        .as_ref()
                        .is_none_or(|g| Some(g) == requested.as_ref()),
                "forbidden",
                "此快照不属于所选作品，旧工作区快照须原范围授权。",
            )?;
        }
        if input["phase"] == "execute" && !self.author {
            if let Some(prepared) = snapshot.get("prepared_by") {
                let binding = self
                    .management_grant
                    .as_ref()
                    .ok_or_else(|| Error::new("forbidden", "请使用准备此快照的原客户端授权。"))?;
                ensure(
                    prepared["client_adapter"] == binding["client_adapter"]
                        && prepared["grant_id"] == binding["grant_id"]
                        && prepared["grant_revision"] == binding["grant_revision"],
                    "forbidden",
                    "快照执行绑定原客户端及授权修订；撤权后须重新准备。",
                )?;
            }
        }
        Ok(())
    }

    /// 返回前逐提交核验原固定快照与执行回执；被外部替换的引用不能引入他作品历史。
    fn git_work_history(&self, repo: &Repository, work: &Value) -> Result<Vec<Oid>> {
        let name = reference(work)?;
        let first = match repo.find_reference(&name) {
            Ok(r) => Some(r.peel_to_commit()?.id()),
            Err(e) if e.code() == git2::ErrorCode::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        let Some(first) = first else {
            return Ok(Vec::new());
        };
        ensure(
            self.store.entries(".hetu")?.iter().any(|s| s == "git")
                && self
                    .store
                    .entries(".hetu/git")?
                    .iter()
                    .any(|s| s == "executions"),
            "hetu.integrity_failure",
            "作品版本缺少原执行记录。",
        )?;
        let entries = self.store.entries(".hetu/git/executions")?;
        ensure(
            entries.len() <= 10_000,
            "hetu.budget_exceeded",
            "作品版本执行历史超过核验上限。",
        )?;
        let mut records = BTreeMap::new();
        for file in entries {
            let record = self.store.json(&format!(".hetu/git/executions/{file}"))?;
            let (snapshot, sha) = self.git_snapshot(text(&record, "snapshot_id")?)?;
            if snapshot.get("work_ref") != Some(work) {
                continue;
            }
            ensure(
                snapshot["head"]["reference"] == name,
                "hetu.integrity_failure",
                "作品快照引用与归属不一致。",
            )?;
            let target = oid(&record["result"]["data"]["commit_id"])?;
            records.insert(target, (record, snapshot, sha));
        }
        let mut chain = Vec::new();
        let mut current = Some(first);
        while let Some(target) = current {
            ensure(
                chain.len() < 10_000 && !chain.contains(&target),
                "hetu.integrity_failure",
                "作品版本历史异常。",
            )?;
            let (record, snapshot, sha) = records.get(&target).ok_or_else(|| {
                Error::new(
                    "hetu.integrity_failure",
                    "作品版本包含没有固定执行依据的提交。",
                )
            })?;
            self.verify_git_execution_record(record, snapshot, sha, target)?;
            self.verify_snapshot_commit(repo, snapshot, target)?;
            for item in snapshot["selection"].as_array().unwrap() {
                ensure(
                    self.git_document_path(work, text(item, "path")?)?,
                    "forbidden",
                    "历史文稿归属无法核验，请保留历史并检查。",
                )?;
            }
            chain.push(target);
            current = snapshot["head"]["commit_id"]
                .as_str()
                .map(Oid::from_str)
                .transpose()?;
        }
        Ok(chain)
    }

    pub(super) fn git_version_head(
        &self,
        repo: &Repository,
        work: Option<&Value>,
    ) -> Result<Value> {
        let Some(work) = work else {
            return head(repo);
        };
        let chain = self.git_work_history(repo, work)?;
        Ok(
            json!({"reference":reference(work)?, "commit_id":chain.first().map(ToString::to_string)}),
        )
    }

    pub(in crate::application) fn check_git_version_work(
        &self,
        repo: &Repository,
        input: &Value,
    ) -> Result<()> {
        if let Some(work) = self.git_requested_work(input)? {
            let commit = oid(&input["commit_id"])?;
            ensure(
                self.git_work_history(repo, &work)?.contains(&commit),
                "forbidden",
                "只能读取当前作品已核验的文稿版本。",
            )?;
            if let Some(path) = input["path"].as_str() {
                ensure(
                    self.git_document_path(&work, path)?,
                    "forbidden",
                    "历史文件不属于当前作品文稿。",
                )?;
            }
        }
        Ok(())
    }
}
