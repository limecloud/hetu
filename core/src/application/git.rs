use super::*;
use git2::{
    DiffOptions, Index, IndexEntry, IndexTime, ObjectType, Oid, Repository, RepositoryInitOptions,
    Signature,
};
use std::{collections::BTreeSet, path::PathBuf};

const SNAPSHOT_LIMIT: usize = 128 * 1024 * 1024;
const DIFF_LIMIT: usize = 1024 * 1024;

impl From<git2::Error> for Error {
    fn from(error: git2::Error) -> Self {
        let (code, message) = match error.code() {
            git2::ErrorCode::Locked => ("hetu.workspace_busy", "Git 正在被其他进程操作。"),
            git2::ErrorCode::Modified | git2::ErrorCode::Exists => {
                ("revision_conflict", "Git 引用已变化，请重新审阅。")
            }
            git2::ErrorCode::NotFound | git2::ErrorCode::UnbornBranch => {
                ("not_found", "Git 对象或引用不存在。")
            }
            _ => (
                "hetu.git_failure",
                "Git 操作失败；保留工作树并检查仓库完整性与权限。",
            ),
        };
        Self::new(code, message)
    }
}

fn eligible(path: &str) -> bool {
    if path
        .split('/')
        .any(|part| part == ".git" || part == ".DS_Store")
    {
        return false;
    }
    if [
        ".hetu/transactions",
        ".hetu/cache",
        ".hetu/git",
        ".hetu/operations",
        ".hetu/audit",
        ".hetu/deliveries",
    ]
    .iter()
    .any(|root| path == *root || path.starts_with(&format!("{root}/")))
        || matches!(path, ".hetu/workspace.lock" | ".hetu/visibility.lock")
    {
        return false;
    }
    [
        ".heturc.json",
        ".gitignore",
        ".gitattributes",
        "README.md",
        "LICENSE",
    ]
    .contains(&path)
        || ["shared/", "packages/", ".hetu/"]
            .iter()
            .any(|root| path.starts_with(root))
}
fn checked_path(path: &str) -> Result<()> {
    ensure(
        eligible(path)
            && path.len() <= 1024
            && path.split('/').all(|p| {
                !p.is_empty() && p != "." && p != ".." && !p.contains(['\\', '\0', '\n', '\r'])
            }),
        "hetu.unsafe_path",
        "所选路径不属于可版本化的受管内容。",
    )
}
fn oid(value: &Value) -> Result<Oid> {
    Oid::from_str(value.as_str().unwrap_or(""))
        .map_err(|_| Error::new("invalid_input", "Git 对象 ID 无效。"))
}
fn secret(path: &str, content: &[u8]) -> bool {
    let lower = path.to_ascii_lowercase();
    if lower.split('/').any(|name| {
        name == ".env"
            || name.starts_with(".env.")
            || name.ends_with(".pem")
            || name.ends_with(".key")
            || name == "credentials.json"
    }) {
        return true;
    }
    let text = String::from_utf8_lossy(content);
    if text.contains("PRIVATE KEY-----")
        || text
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
            .any(|word| word.starts_with("sk-") && word.len() >= 24)
    {
        return true;
    }
    fn fields(value: &Value) -> bool {
        match value {
            Value::Object(map) => map.iter().any(|(key, value)| {
                let key = key.to_ascii_lowercase().replace(['-', '_'], "");
                ([
                    "password",
                    "apikey",
                    "accesstoken",
                    "refreshtoken",
                    "clientsecret",
                    "privatekey",
                    "authorization",
                ]
                .contains(&key.as_str())
                    && value
                        .as_str()
                        .is_some_and(|s| !(s.is_empty() || s.starts_with('<') && s.ends_with('>'))))
                    || fields(value)
            }),
            Value::Array(items) => items.iter().any(fields),
            _ => false,
        }
    }
    lower.ends_with(".json") && serde_json::from_slice::<Value>(content).is_ok_and(|v| fields(&v))
}
fn head(repo: &Repository) -> Result<Value> {
    let reference = repo.find_reference("HEAD")?;
    let symbolic = reference.symbolic_target().map(str::to_owned);
    let commit = match repo.head().and_then(|r| r.peel_to_commit()) {
        Ok(commit) => Some(commit.id().to_string()),
        Err(error)
            if matches!(
                error.code(),
                git2::ErrorCode::UnbornBranch | git2::ErrorCode::NotFound
            ) =>
        {
            None
        }
        Err(error) => return Err(error.into()),
    };
    Ok(json!({"reference":symbolic,"commit_id":commit}))
}
fn snapshot_path(id: &str) -> Result<String> {
    checked_id(id, "gitsnapshot")?;
    Ok(format!(".hetu/git/snapshots/{id}.json"))
}
fn validate_snapshot(snapshot: &Value) -> Result<()> {
    static SCHEMA: OnceLock<jsonschema::Validator> = OnceLock::new();
    let validator = SCHEMA.get_or_init(|| {
        let schema: Value = serde_json::from_str(include_str!(
            "../../../contracts/schemas/git-snapshot.schema.json"
        ))
        .expect("embedded Git snapshot schema");
        jsonschema::validator_for(&schema).expect("valid Git snapshot schema")
    });
    ensure(
        validator.is_valid(snapshot),
        "hetu.integrity_failure",
        "Git 快照不符合数据合同。",
    )?;
    let paths: Vec<_> = snapshot["selection"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| text(item, "path"))
        .collect::<Result<_>>()?;
    ensure(
        paths.windows(2).all(|pair| pair[0] < pair[1]),
        "hetu.integrity_failure",
        "Git 快照路径重复或顺序不一致。",
    )?;
    for path in paths {
        checked_path(path)?;
    }
    Ok(())
}
fn snapshot_result(
    scope: &str,
    snapshot: &Value,
    sha: &str,
    commit: Oid,
    operation: Value,
) -> Value {
    let mut result = domain::success(
        "hetu.git.snapshot",
        scope,
        json!({"snapshot_id":snapshot["snapshot_id"],"snapshot_sha256":sha,"commit_id":commit.to_string(),"reference":snapshot["head"]["reference"],"selected_paths":snapshot["selection"].as_array().unwrap().iter().map(|s|s["path"].clone()).collect::<Vec<_>>(),"excluded_changes":snapshot["excluded_changes"],"approval_state":"executed"}),
    );
    result["operation"] = operation;
    result
}
fn published(repo: &Repository, reference: &str, commit: Oid, key: &str) -> bool {
    let message = format!("hetu snapshot {}", digest(key));
    repo.reflog(reference).is_ok_and(|log| {
        log.iter()
            .any(|entry| entry.id_new() == commit && entry.message() == Some(message.as_str()))
    }) || repo
        .find_reference(reference)
        .and_then(|r| r.peel_to_commit())
        .is_ok_and(|current| {
            current.id() == commit
                || repo
                    .graph_descendant_of(current.id(), commit)
                    .unwrap_or(false)
        })
}

impl Kernel {
    fn git_repository(&self) -> Result<Repository> {
        self.store.matches_root(&self.workspace_path)?;
        let path = self.workspace_path.join(".git");
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|_| Error::new("hetu.git_not_initialized", "此作品尚未初始化 Git 仓库。"))?;
        ensure(
            meta.is_dir() && !meta.file_type().is_symlink(),
            "hetu.unsafe_path",
            "Git 目录必须位于当前作品根目录，不支持链接或外部 worktree。",
        )?;
        let files = self.store.files(".git", |_| false)?;
        for path in [
            ".git/commondir",
            ".git/objects/info/alternates",
            ".git/objects/info/http-alternates",
        ] {
            ensure(
                !files.iter().any(|file| file == path),
                "hetu.unsafe_path",
                "拒绝共享 Git 目录或外部对象库。",
            )?;
        }
        let repo = Repository::open(&self.workspace_path)?;
        ensure(
            !repo.is_bare()
                && !repo.is_worktree()
                && repo.workdir().is_some_and(|p| p == self.workspace_path)
                && repo.path() == path,
            "hetu.unsafe_path",
            "仓库根与当前作品不一致。",
        )?;
        Ok(repo)
    }
    fn git_instance(&self) -> Result<String> {
        use std::os::unix::fs::MetadataExt;
        let work = std::fs::symlink_metadata(&self.workspace_path)?;
        let git = std::fs::symlink_metadata(self.workspace_path.join(".git"))?;
        Ok(digest(format!(
            "{}:{}:{}:{}:{}",
            self.scope(),
            work.dev(),
            work.ino(),
            git.dev(),
            git.ino()
        )))
    }
    fn git_changes(&self, repo: &Repository) -> Result<Vec<Value>> {
        // 独立快照不改用户 index；内容状态必须直接比较 HEAD 与工作树。
        let tree = head(repo)?["commit_id"]
            .as_str()
            .map(Oid::from_str)
            .transpose()?
            .map(|id| repo.find_commit(id).and_then(|commit| commit.tree()))
            .transpose()?;
        let mut options = DiffOptions::new();
        options
            .include_untracked(true)
            .recurse_untracked_dirs(true)
            .include_typechange(true);
        let diff = repo.diff_tree_to_workdir(tree.as_ref(), Some(&mut options))?;
        ensure(
            diff.deltas().len() <= 100_000,
            "hetu.budget_exceeded",
            "Git 状态超过枚举上限。",
        )?;
        let mut records = Vec::new();
        for entry in diff.deltas() {
            let file = if entry.status() == git2::Delta::Deleted {
                entry.old_file()
            } else {
                entry.new_file()
            };
            let path = file
                .path()
                .and_then(Path::to_str)
                .ok_or_else(|| Error::new("hetu.unsafe_path", "Git 路径不是有效 UTF-8。"))?;
            if !eligible(path) {
                continue;
            }
            checked_path(path)?;
            let status = repo.status_file(Path::new(path))?;
            let size = std::fs::symlink_metadata(self.workspace_path.join(path))
                .ok()
                .map(|m| m.len());
            records.push(json!({"path":path,"change_kind":format!("{:?}",entry.status()).to_ascii_lowercase(),"status_bits":status.bits(),"staged":status.intersects(git2::Status::INDEX_NEW|git2::Status::INDEX_MODIFIED|git2::Status::INDEX_DELETED|git2::Status::INDEX_RENAMED|git2::Status::INDEX_TYPECHANGE),"conflicted":status.is_conflicted(),"size_bytes":size}));
        }
        records.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
        Ok(records)
    }
    pub(super) fn git_status(&self) -> Result<Value> {
        if std::fs::symlink_metadata(self.workspace_path.join(".git")).is_err() {
            self.store.matches_root(&self.workspace_path)?;
            return Ok(json!({"initialized":false,"head":null,"changes":[]}));
        }
        let repo = self.git_repository()?;
        Ok(
            json!({"initialized":true,"head":head(&repo)?,"changes":self.git_changes(&repo)?,"state":format!("{:?}",repo.state()),"repository_instance":self.git_instance()?}),
        )
    }
    pub(super) fn git_init(&self, input: &Value) -> Result<Value> {
        self.store.matches_root(&self.workspace_path)?;
        let branch = text(input, "branch")?;
        ensure(
            git2::Reference::is_valid_name(&format!("refs/heads/{branch}")),
            "invalid_input",
            "分支名称无效。",
        )?;
        if std::fs::symlink_metadata(self.workspace_path.join(".git")).is_err() {
            let mut options = RepositoryInitOptions::new();
            options
                .no_reinit(true)
                .initial_head(branch)
                .external_template(false);
            let repo = Repository::init_opts(&self.workspace_path, &options)?;
            repo.config()?.set_bool("core.fsyncObjectFiles", true)?;
            self.store.sync_tree(".git")?;
        }
        self.git_status()
    }
    fn git_work_blob(&self, path: &str) -> Result<Option<(Vec<u8>, u32)>> {
        checked_path(path)?;
        let mut absolute = self.workspace_path.clone();
        let parts: Vec<_> = path.split('/').collect();
        for (index, part) in parts.iter().enumerate() {
            absolute.push(part);
            match std::fs::symlink_metadata(&absolute) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error.into()),
                Ok(meta) => ensure(
                    if index + 1 == parts.len() {
                        meta.is_file()
                    } else {
                        meta.is_dir()
                    } && !meta.file_type().is_symlink(),
                    "hetu.unsafe_path",
                    "Git 内容路径含链接或非普通文件。",
                )?,
            }
        }
        let (_, mode) = self.store.file_metadata(path)?;
        Ok(Some((
            self.store.read(path)?,
            if mode & 0o111 != 0 {
                0o100755
            } else {
                0o100644
            },
        )))
    }
    fn git_head_blob(&self, repo: &Repository, path: &str) -> Result<Option<(Oid, u32)>> {
        let Some(commit) = head(repo)?["commit_id"].as_str().map(str::to_owned) else {
            return Ok(None);
        };
        let tree = repo.find_commit(Oid::from_str(&commit)?)?.tree()?;
        match tree.get_path(Path::new(path)) {
            Ok(entry) => {
                ensure(
                    entry.kind() == Some(ObjectType::Blob)
                        && matches!(entry.filemode(), 0o100644 | 0o100755),
                    "hetu.unsafe_path",
                    "拒绝符号链接、子模块或非正文 Git 项。",
                )?;
                Ok(Some((entry.id(), entry.filemode() as u32)))
            }
            Err(error) if error.code() == git2::ErrorCode::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
    pub(super) fn git_diff(&self, input: &Value) -> Result<Value> {
        let repo = self.git_repository()?;
        let path = text(input, "path")?;
        checked_path(path)?;
        ensure(
            self.author || !path.starts_with(".hetu/reviews/"),
            "forbidden",
            "私密审核记录只能由作者查看；Agent 请读取公共审核投影。",
        )?;
        let before = self
            .git_head_blob(&repo, path)?
            .map(|(id, _)| repo.find_blob(id).map(|b| b.content().to_vec()))
            .transpose()?;
        let working = self.git_work_blob(path)?;
        let after_mode = working.as_ref().map(|(_, mode)| *mode);
        let after = working.map(|(bytes, _)| bytes);
        let unsafe_content = before.as_ref().is_some_and(|b| secret(path, b))
            || after.as_ref().is_some_and(|b| secret(path, b));
        ensure(
            !unsafe_content,
            "hetu.secret_detected",
            "该文件包含已知凭据字段或密钥，不在差异面板展示。",
        )?;
        let too_large = before.as_ref().is_some_and(|b| b.len() > DIFF_LIMIT)
            || after.as_ref().is_some_and(|b| b.len() > DIFF_LIMIT);
        let binary = before
            .as_ref()
            .is_some_and(|b| std::str::from_utf8(b).is_err() || b.contains(&0))
            || after
                .as_ref()
                .is_some_and(|b| std::str::from_utf8(b).is_err() || b.contains(&0));
        let render = |bytes: &Option<Vec<u8>>| {
            if too_large || binary {
                None
            } else {
                bytes
                    .as_ref()
                    .map(|b| String::from_utf8_lossy(b).into_owned())
            }
        };
        Ok(
            json!({"path":path,"head":head(&repo)?,"binary":binary,"truncated":too_large,"before":render(&before),"after":render(&after),"before_size":before.as_ref().map(Vec::len),"after_size":after.as_ref().map(Vec::len),"before_oid":before.as_ref().map(|b|Oid::hash_object(ObjectType::Blob,b).map(|id|id.to_string())).transpose()?,"after_sha256":after.as_ref().map(digest),"after_mode":after_mode}),
        )
    }
    pub(super) fn git_snapshot_diff(&self, input: &Value) -> Result<Value> {
        let (snapshot, sha) = self.git_snapshot(text(input, "snapshot_id")?)?;
        let path = text(input, "path")?;
        let item = snapshot["selection"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["path"] == path))
            .ok_or_else(|| Error::new("not_found", "该文件不属于此快照。"))?;
        let mut diff = self.git_diff(input)?;
        ensure(
            diff["head"] == snapshot["head"]
                && diff["before_oid"] == item["before_oid"]
                && diff["after_sha256"] == item["after_sha256"]
                && diff["after_mode"] == item["mode"],
            "revision_conflict",
            "文件或 HEAD 已变化，不能作为固定快照差异展示。",
        )?;
        diff["snapshot_id"] = snapshot["snapshot_id"].clone();
        diff["snapshot_sha256"] = json!(sha);
        Ok(diff)
    }
    pub(super) fn git_log(&self, input: &Value) -> Result<Value> {
        let repo = self.git_repository()?;
        let current = head(&repo)?;
        let Some(commit) = current["commit_id"].as_str() else {
            return Ok(json!({"head":current,"commits":[],"next_cursor":null}));
        };
        let start = if let Some(cursor) = input["cursor"].as_str() {
            let (hash, offset) = cursor
                .split_once(':')
                .ok_or_else(|| Error::new("cursor_invalid", "历史游标无效。"))?;
            ensure(
                hash == commit,
                "cursor_invalid",
                "提交历史已变化，请重新读取。",
            )?;
            offset
                .parse::<usize>()
                .map_err(|_| Error::new("cursor_invalid", "历史游标无效。"))?
        } else {
            0
        };
        ensure(
            start <= 100_000,
            "hetu.budget_exceeded",
            "历史页超过查询上限。",
        )?;
        let limit = input["limit"].as_u64().unwrap_or(30) as usize;
        let mut walk = repo.revwalk()?;
        walk.push(Oid::from_str(commit)?)?;
        walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;
        let mut commits = Vec::new();
        for id in walk.skip(start).take(limit + 1) {
            let commit = repo.find_commit(id?)?;
            commits.push(json!({"commit_id":commit.id().to_string(),"message":commit.message().unwrap_or("").chars().take(4000).collect::<String>(),"author":{"name":commit.author().name(),"email":commit.author().email()},"timestamp":commit.time().seconds(),"parents":commit.parent_ids().map(|id|id.to_string()).collect::<Vec<_>>()}));
        }
        let more = commits.len() > limit;
        commits.truncate(limit);
        Ok(
            json!({"head":current,"commits":commits,"next_cursor":more.then(||format!("{commit}:{}",start+limit))}),
        )
    }
    pub(super) fn get_git_snapshot(&self, input: &Value) -> Result<Value> {
        let repo = self.git_repository()?;
        let (snapshot, sha) = self.git_snapshot(text(input, "snapshot_id")?)?;
        let current = match self.verify_git_snapshot(&repo, &snapshot) {
            Ok(()) => true,
            Err(error) if error.code == "revision_conflict" => false,
            Err(error) => return Err(error),
        };
        let approved = match self.check_git_approval(&snapshot, &sha, true) {
            Ok(()) => true,
            Err(error) if error.code == "hetu.author_confirmation_required" => false,
            Err(error) => return Err(error),
        };
        let execution = self.git_snapshot_execution(&repo, &snapshot, &sha)?;
        Ok(
            json!({"snapshot":snapshot,"snapshot_sha256":sha,"is_current":current,"execution":execution,"approval_state":if execution.is_some() {"executed"} else if !current {"stale"} else if approved {"approved"} else {"pending_approval"}}),
        )
    }
    fn git_snapshot_execution(
        &self,
        repo: &Repository,
        snapshot: &Value,
        sha: &str,
    ) -> Result<Option<Value>> {
        if !self
            .store
            .entries(".hetu/git")?
            .iter()
            .any(|name| name == "executions")
        {
            return Ok(None);
        }
        let entries = self.store.entries(".hetu/git/executions")?;
        ensure(
            entries.len() <= 10_000,
            "hetu.budget_exceeded",
            "快照执行历史超过单次核对上限。",
        )?;
        for name in entries {
            let record = self.store.json(&format!(".hetu/git/executions/{name}"))?;
            if record["snapshot_id"] != snapshot["snapshot_id"] {
                continue;
            }
            let result = &record["result"];
            let target = oid(&result["data"]["commit_id"])?;
            self.verify_git_execution_record(&record, snapshot, sha, target)?;
            self.verify_snapshot_commit(repo, snapshot, target)?;
            if published(
                repo,
                text(&snapshot["head"], "reference")?,
                target,
                text(&result["operation"], "key")?,
            ) {
                return Ok(Some(
                    json!({"commit_id":target.to_string(),"reference":snapshot["head"]["reference"]}),
                ));
            }
        }
        Ok(None)
    }
    fn verify_git_execution_record(
        &self,
        record: &Value,
        snapshot: &Value,
        sha: &str,
        commit: Oid,
    ) -> Result<()> {
        let result = &record["result"];
        let operation = &result["operation"];
        checked_id(text(operation, "id")?, "op")?;
        let input = json!({"phase":"execute","snapshot_id":snapshot["snapshot_id"],"operation_key":operation["key"]});
        ensure(
            record["schema_version"] == "1.0.0"
                && record["snapshot_id"] == snapshot["snapshot_id"]
                && record["snapshot_sha256"] == sha
                && record["input_digest"] == Self::input_digest(&input)?
                && operation["input_digest"] == record["input_digest"]
                && matches!(record["actor_scope"].as_str(), Some("author" | "agent"))
                && *result
                    == snapshot_result(self.scope(), snapshot, sha, commit, operation.clone()),
            "hetu.integrity_failure",
            "Git 执行日志与原快照、输入或回执不一致。",
        )
    }
    pub(super) fn list_git_snapshots(&self, input: &Value) -> Result<Value> {
        self.git_repository()?;
        if !self
            .store
            .entries(".hetu")?
            .iter()
            .any(|name| name == "git")
            || !self
                .store
                .entries(".hetu/git")?
                .iter()
                .any(|name| name == "snapshots")
        {
            return self.record_page(input, Vec::new(), "snapshots");
        }
        let mut rows = Vec::new();
        for name in self.store.entries(".hetu/git/snapshots")? {
            let id = name
                .strip_suffix(".json")
                .ok_or_else(|| Error::new("hetu.integrity_failure", "快照目录包含非法记录。"))?;
            let (snapshot, sha) = self.git_snapshot(id)?;
            rows.push(json!({"snapshot_id":id,"snapshot_sha256":sha,"message":snapshot["message"],"head":snapshot["head"],"author":snapshot["author"],"timestamp":snapshot["timestamp"],"created_at":format!("{:020}",snapshot["timestamp"].as_i64().unwrap_or(0)),"file_count":snapshot["selection"].as_array().map(Vec::len)}));
        }
        self.record_page(input, rows, "snapshots")
    }
    fn git_selection(&self, repo: &Repository, paths: &[String]) -> Result<Vec<Value>> {
        let mut total = 0usize;
        let mut selected = Vec::new();
        for path in paths {
            checked_path(path)?;
            let before = self.git_head_blob(repo, path)?;
            ensure(
                before.is_some() || !repo.status_should_ignore(Path::new(path))?,
                "hetu.unsafe_path",
                "所选新文件被 Git 忽略，不会纳入快照。",
            )?;
            let after = self.git_work_blob(path)?;
            if let Some((content, _)) = &after {
                total = total.saturating_add(content.len());
                ensure(
                    total <= SNAPSHOT_LIMIT,
                    "hetu.budget_exceeded",
                    "快照读取超过 128 MiB，请分批选择或使用外部媒体管理。",
                )?;
                ensure(
                    !secret(path, content),
                    "hetu.secret_detected",
                    "快照包含已知凭据字段或密钥，不能提交。",
                )?;
            }
            let after_id = after
                .as_ref()
                .map(|(content, mode)| {
                    Oid::hash_object(ObjectType::Blob, content).map(|id| (id, *mode))
                })
                .transpose()?;
            if before == after_id {
                continue;
            }
            selected.push(json!({"path":path,"before_oid":before.map(|(id,_)|id.to_string()),"after_sha256":after.as_ref().map(|(b,_)|digest(b)),"after_oid":after_id.map(|(id,_)|id.to_string()),"mode":after_id.map(|(_,mode)|mode),"size_bytes":after.as_ref().map(|(b,_)|b.len())}));
        }
        Ok(selected)
    }
    pub(super) fn prepare_git_snapshot(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let repo = self.git_repository()?;
        ensure(
            repo.state() == git2::RepositoryState::Clean,
            "hetu.git_conflict",
            "请先处理现有合并或冲突状态。",
        )?;
        let current = head(&repo)?;
        ensure(
            current == input["expected_head"],
            "revision_conflict",
            "HEAD 已变化，请重新审阅。",
        )?;
        ensure(
            current["reference"]
                .as_str()
                .is_some_and(|r| r.starts_with("refs/heads/")),
            "hetu.git_conflict",
            "请先选择本地分支，不能在 detached HEAD 上提交。",
        )?;
        let dirty = self.git_changes(&repo)?;
        ensure(
            dirty.iter().all(|p| p["conflicted"] == false),
            "hetu.git_conflict",
            "存在未解决的 Git 冲突。",
        )?;
        let paths: Vec<String> = if let Some(selected) = input["selected_paths"].as_array() {
            selected
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect()
        } else {
            dirty
                .iter()
                .map(|d| d["path"].as_str().unwrap().to_owned())
                .collect()
        };
        let mut paths = paths;
        paths.sort();
        let selected = self.git_selection(&repo, &paths)?;
        ensure(
            !selected.is_empty(),
            "hetu.nothing_to_commit",
            "所选工作树内容与 HEAD 一致，没有可提交变更。",
        )?;
        let selected_paths: BTreeSet<_> = selected
            .iter()
            .map(|v| v["path"].as_str().unwrap())
            .collect();
        let excluded: Vec<_> = dirty
            .into_iter()
            .filter(|v| !selected_paths.contains(v["path"].as_str().unwrap()))
            .collect();
        let snapshot = json!({"schema_version":"1.0.0","snapshot_id":id("gitsnapshot"),"workspace_id":self.scope(),"repository_instance":self.git_instance()?,"head":current,"selection":selected,"excluded_changes":excluded,"message":input["message"],"author":input["author"],"timestamp":time::OffsetDateTime::now_utc().unix_timestamp()});
        validate_snapshot(&snapshot)?;
        self.store.directory(".hetu/git/snapshots")?;
        let content = bytes(&snapshot)?;
        let sha = digest(&content);
        changes.insert(snapshot_path(text(&snapshot, "snapshot_id")?)?, content);
        Ok(json!({"snapshot":snapshot,"snapshot_sha256":sha,"approval_state":"pending_approval"}))
    }
    fn git_snapshot(&self, id: &str) -> Result<(Value, String)> {
        let bytes = self.store.read(&snapshot_path(id)?)?;
        let snapshot: Value = serde_json::from_slice(&bytes)?;
        validate_snapshot(&snapshot)?;
        ensure(
            snapshot["schema_version"] == "1.0.0"
                && snapshot["snapshot_id"] == id
                && snapshot["workspace_id"] == self.scope()
                && snapshot["repository_instance"] == self.git_instance()?,
            "hetu.integrity_failure",
            "快照身份、版本或仓库归属不一致。",
        )?;
        Ok((snapshot, digest(bytes)))
    }
    fn authorizations(&self, create: bool) -> Result<Store> {
        let path = if let Some(path) = &self.authorization_path {
            path.clone()
        } else {
            let home = std::env::var_os("HOME").ok_or_else(|| {
                Error::new(
                    "hetu.author_confirmation_required",
                    "找不到本机作者授权目录。",
                )
            })?;
            PathBuf::from(home).join("Library/Application Support/Hetu/Authorizations")
        };
        ensure(
            path.is_absolute() && !path.starts_with(&self.workspace_path),
            "hetu.unsafe_path",
            "作者批准必须保存在工作区以外的本机授权目录。",
        )?;
        if create {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&path)?;
        }
        ensure(
            path.is_dir(),
            "hetu.author_confirmation_required",
            "请由作者在本机工作台审阅并批准确切快照。",
        )?;
        ensure(
            !std::fs::symlink_metadata(&path)?.file_type().is_symlink(),
            "hetu.unsafe_path",
            "作者授权目录不能是链接。",
        )?;
        ensure(
            !path.canonicalize()?.starts_with(&self.workspace_path),
            "hetu.unsafe_path",
            "本机批准目录不能经链接落入工作区。",
        )?;
        Store::open(&path)
    }
    fn approval_path(&self, id: &str) -> Result<String> {
        checked_id(id, "gitsnapshot")?;
        Ok(format!("{}/{id}.json", self.git_instance()?))
    }
    pub(super) fn approve_git_snapshot(&self, input: &Value) -> Result<Value> {
        let repo = self.git_repository()?;
        let snapshot_id = text(input, "snapshot_id")?;
        let (snapshot, sha) = self.git_snapshot(snapshot_id)?;
        ensure(
            input["snapshot_sha256"] == sha,
            "revision_conflict",
            "批准的快照摘要已变化。",
        )?;
        self.verify_git_snapshot(&repo, &snapshot)?;
        let authorizations = self.authorizations(true)?;
        let approval = json!({"schema_version":"1.0.0","snapshot_id":snapshot_id,"snapshot_sha256":sha,"repository_instance":snapshot["repository_instance"],"actor_ref":AUTHOR,"approved_at":now(),"expires_at":time::OffsetDateTime::now_utc().unix_timestamp()+900});
        authorizations.install(&self.approval_path(snapshot_id)?, &bytes(&approval)?, false)?;
        Ok(
            json!({"snapshot_id":snapshot_id,"snapshot_sha256":sha,"approval_state":"approved","expires_at":approval["expires_at"]}),
        )
    }
    fn verify_git_snapshot(&self, repo: &Repository, snapshot: &Value) -> Result<()> {
        ensure(
            repo.state() == git2::RepositoryState::Clean && head(repo)? == snapshot["head"],
            "revision_conflict",
            "分支、HEAD 或仓库状态已变化，请重新准备快照。",
        )?;
        let paths: Vec<_> = snapshot["selection"]
            .as_array()
            .ok_or_else(|| Error::new("hetu.integrity_failure", "快照选择缺失。"))?
            .iter()
            .map(|v| text(v, "path").map(str::to_owned))
            .collect::<Result<_>>()?;
        ensure(
            json!(self.git_selection(repo, &paths)?) == snapshot["selection"],
            "revision_conflict",
            "所选文件已变化，请重新准备和批准快照。",
        )
    }
    fn check_git_approval(&self, snapshot: &Value, sha: &str, fresh: bool) -> Result<()> {
        let store = self.authorizations(false)?;
        let path = self.approval_path(text(snapshot, "snapshot_id")?)?;
        ensure(
            store.entries("")?.contains(&self.git_instance()?),
            "hetu.author_confirmation_required",
            "此仓库实例没有本机作者批准。",
        )?;
        ensure(
            store.exists(&path)?,
            "hetu.author_confirmation_required",
            "此快照未获得本机作者批准。",
        )?;
        let approval = store.json(&path)?;
        ensure(
            approval["snapshot_sha256"] == sha
                && approval["repository_instance"] == snapshot["repository_instance"]
                && approval["actor_ref"] == AUTHOR
                && (!fresh
                    || approval["expires_at"]
                        .as_i64()
                        .is_some_and(|t| t > time::OffsetDateTime::now_utc().unix_timestamp())),
            "hetu.author_confirmation_required",
            "作者批准缺失、过期或与快照不匹配，请重新审阅。",
        )
    }
    pub(super) fn execute_git_snapshot(
        &self,
        input: &Value,
        op_path: &str,
        input_digest: &str,
    ) -> Result<Value> {
        let action = "hetu.git.snapshot";
        let repo = self.git_repository()?;
        let snapshot_id = text(input, "snapshot_id")?;
        let (snapshot, sha) = self.git_snapshot(snapshot_id)?;
        let journal_path = format!(".hetu/git/executions/{}.json", digest(op_path));
        self.store.directory(".hetu/git/executions")?;
        let journal = if self.store.exists(&journal_path)? {
            let record = self.store.json(&journal_path)?;
            ensure(
                record["input_digest"] == input_digest && record["snapshot_sha256"] == sha,
                "idempotency_conflict",
                "原 Git 操作已绑定其他输入或快照被改写。",
            )?;
            record
        } else {
            self.check_git_approval(&snapshot, &sha, true)?;
            self.verify_git_snapshot(&repo, &snapshot)?;
            let mut index = Index::new()?;
            if let Some(commit) = snapshot["head"]["commit_id"].as_str() {
                index.read_tree(&repo.find_commit(Oid::from_str(commit)?)?.tree()?)?;
            }
            for item in snapshot["selection"].as_array().unwrap() {
                let path = text(item, "path")?;
                if let Some((content, mode)) = self.git_work_blob(path)? {
                    ensure(
                        digest(&content) == item["after_sha256"],
                        "revision_conflict",
                        "建立提交时文件发生变化。",
                    )?;
                    let id = repo.blob(&content)?;
                    index.add(&IndexEntry {
                        ctime: IndexTime::new(0, 0),
                        mtime: IndexTime::new(0, 0),
                        dev: 0,
                        ino: 0,
                        mode,
                        uid: 0,
                        gid: 0,
                        file_size: content.len() as u32,
                        id,
                        flags: 0,
                        flags_extended: 0,
                        path: path.as_bytes().to_vec(),
                    })?;
                } else {
                    index.remove_path(Path::new(path))?;
                }
            }
            let tree = repo.find_tree(index.write_tree_to(&repo)?)?;
            let timestamp = snapshot["timestamp"]
                .as_i64()
                .ok_or_else(|| Error::new("hetu.integrity_failure", "快照时间无效。"))?;
            let identity = Signature::new(
                text(&snapshot["author"], "name")?,
                text(&snapshot["author"], "email")?,
                &git2::Time::new(timestamp, 0),
            )?;
            let parent = snapshot["head"]["commit_id"]
                .as_str()
                .map(Oid::from_str)
                .transpose()?
                .map(|id| repo.find_commit(id))
                .transpose()?;
            let parents: Vec<_> = parent.iter().collect();
            let commit = repo.commit(
                None,
                &identity,
                &identity,
                text(&snapshot, "message")?,
                &tree,
                &parents,
            )?;
            self.store.sync_tree(".git/objects")?;
            let operation = Self::operation(text(input, "operation_key")?, input_digest);
            let result = snapshot_result(self.scope(), &snapshot, &sha, commit, operation);
            let record = json!({"schema_version":"1.0.0","input_digest":input_digest,"snapshot_sha256":sha,"snapshot_id":snapshot_id,"actor_scope":if self.author{"author"}else{"agent"},"result":result,"published":false});
            self.store.install(&journal_path, &bytes(&record)?, true)?;
            record
        };
        let result = journal["result"].clone();
        ensure(
            result["action"] == action
                && result["context"]["scope_id"] == self.scope()
                && result["operation"]["key"] == input["operation_key"]
                && journal["actor_scope"] == if self.author { "author" } else { "agent" },
            "hetu.integrity_failure",
            "Git 恢复日志归属不一致。",
        )?;
        let target = oid(&result["data"]["commit_id"])?;
        self.verify_git_execution_record(&journal, &snapshot, &sha, target)?;
        self.verify_snapshot_commit(&repo, &snapshot, target)?;
        let reference = text(&snapshot["head"], "reference")?;
        let message = format!("hetu snapshot {}", digest(text(input, "operation_key")?));
        let published = published(&repo, reference, target, text(input, "operation_key")?);
        self.check_git_approval(&snapshot, &sha, !published)?;
        if !published {
            self.verify_git_snapshot(&repo, &snapshot)?;
            let update = if let Some(old) = snapshot["head"]["commit_id"].as_str() {
                repo.reference_matching(reference, target, true, Oid::from_str(old)?, &message)
            } else {
                repo.reference(reference, target, false, &message)
            };
            update.map_err(|_| {
                Error::new(
                    "result_unknown",
                    "Git 引用更新结果未确认，请保留原键查询恢复。",
                )
            })?;
        }
        self.store
            .sync_tree(".git")
            .map_err(|_| Error::new("result_unknown", "Git 持久化未确认，请沿原键恢复。"))?;
        let mut complete = journal;
        complete["published"] = json!(true);
        self.store
            .install(&journal_path, &bytes(&complete)?, false)
            .map_err(|_| {
                Error::new(
                    "result_unknown",
                    "Git 已写入，恢复记录未确认，请沿原键核对。",
                )
            })?;
        let operation = &result["operation"];
        let mut changes = Changes::new();
        changes.insert(op_path.into(),bytes(&json!({"operation_id":operation["id"],"action":action,"key":input["operation_key"],"input_digest":input_digest,"actor_scope":if self.author{"author"}else{"agent"},"result":result}))?);
        changes.insert(format!(".hetu/audit/{}.json",text(operation,"id")?),bytes(&json!({"schema_version":"1.0.0","operation_id":operation["id"],"action":action,"actor_ref":self.actor(),"input_digest":input_digest,"created_at":now(),"status":"succeeded"}))?);
        self.store
            .transaction(&changes)
            .map_err(|_| Error::new("result_unknown", "Git 已写入，回执未确认，请沿原键恢复。"))?;
        Ok(result)
    }
    fn verify_snapshot_commit(
        &self,
        repo: &Repository,
        snapshot: &Value,
        target: Oid,
    ) -> Result<()> {
        let commit = repo.find_commit(target)?;
        let parent = snapshot["head"]["commit_id"]
            .as_str()
            .map(Oid::from_str)
            .transpose()?;
        ensure(
            commit.parent_ids().collect::<Vec<_>>() == parent.into_iter().collect::<Vec<_>>()
                && commit.message() == snapshot["message"].as_str()
                && commit.author().name() == snapshot["author"]["name"].as_str()
                && commit.author().email() == snapshot["author"]["email"].as_str()
                && Some(commit.author().when().seconds()) == snapshot["timestamp"].as_i64()
                && commit.committer().name() == commit.author().name()
                && commit.committer().email() == commit.author().email()
                && commit.committer().when() == commit.author().when(),
            "hetu.integrity_failure",
            "恢复提交的身份、备注或父提交与批准快照不一致。",
        )?;
        let mut expected = Index::new()?;
        if let Some(parent) = parent {
            expected.read_tree(&repo.find_commit(parent)?.tree()?)?;
        }
        for item in snapshot["selection"]
            .as_array()
            .ok_or_else(|| Error::new("hetu.integrity_failure", "快照选择无效。"))?
        {
            let path = text(item, "path")?;
            checked_path(path)?;
            if item["after_oid"].is_null() {
                expected.remove_path(Path::new(path))?;
                continue;
            }
            let id = oid(&item["after_oid"])?;
            let blob = repo.find_blob(id)?;
            ensure(
                digest(blob.content()) == item["after_sha256"]
                    && json!(blob.size()) == item["size_bytes"],
                "hetu.integrity_failure",
                "恢复提交的文件摘要与快照不一致。",
            )?;
            let mode = integer(item, "mode")? as u32;
            ensure(
                matches!(mode, 0o100644 | 0o100755),
                "hetu.integrity_failure",
                "快照文件模式无效。",
            )?;
            expected.add(&IndexEntry {
                ctime: IndexTime::new(0, 0),
                mtime: IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode,
                uid: 0,
                gid: 0,
                file_size: blob.size() as u32,
                id,
                flags: 0,
                flags_extended: 0,
                path: path.as_bytes().to_vec(),
            })?;
        }
        ensure(
            expected.write_tree_to(repo)? == commit.tree_id(),
            "hetu.integrity_failure",
            "恢复提交包含批准范围以外的变更。",
        )
    }
}
