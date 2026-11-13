use crate::domain::{Error, Result, digest, ensure, id};
use rustix::fd::OwnedFd;
use rustix::fs::{self, FlockOperation, Mode, OFlags};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

const READ_LIMIT: u64 = 16 * 1024 * 1024;
pub struct Store {
    root: OwnedFd,
}
pub struct Lock {
    fd: OwnedFd,
}
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::flock(&self.fd, FlockOperation::Unlock);
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    path: String,
    before: Option<String>,
    after: String,
    payload: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Transaction {
    version: u32,
    completed: bool,
    changes: Vec<Change>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        // 根目录由可信入口选择并解析一次；所有后代访问固定在此描述符下。
        let path = path.canonicalize()?;
        let root = fs::open(
            &path,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )?;
        Ok(Self { root })
    }
    pub(super) fn parent(&self, path: &str, create: bool) -> Result<(OwnedFd, String)> {
        let parts: Vec<_> = path.split('/').collect();
        ensure(
            !parts.is_empty()
                && parts
                    .iter()
                    .all(|s| !s.is_empty() && *s != "." && *s != ".." && !s.contains(['\\', '\0'])),
            "hetu.unsafe_path",
            "受管路径必须为不含跳转的相对路径。",
        )?;
        let mut parent = rustix::io::dup(&self.root)?;
        for part in &parts[..parts.len() - 1] {
            if create {
                match fs::mkdirat(&parent, *part, Mode::from_raw_mode(0o700)) {
                    Ok(()) => fs::fsync(&parent)?,
                    Err(rustix::io::Errno::EXIST) => {}
                    Err(e) => return Err(e.into()),
                }
            }
            parent = fs::openat(
                &parent,
                *part,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::empty(),
            )?;
        }
        Ok((parent, parts.last().unwrap().to_string()))
    }
    pub fn directory(&self, path: &str) -> Result<()> {
        self.parent(&format!("{path}/.probe"), true).map(|_| ())
    }
    pub fn lock(&self) -> Result<Lock> {
        self.file_lock(
            ".hetu/workspace.lock",
            FlockOperation::NonBlockingLockExclusive,
        )
    }
    fn file_lock(&self, path: &str, operation: FlockOperation) -> Result<Lock> {
        let (parent, leaf) = self.parent(path, false)?;
        let fd = fs::openat(
            &parent,
            leaf,
            OFlags::RDWR | OFlags::CREATE | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::from_raw_mode(0o600),
        )?;
        ensure(
            fs::fstat(&fd)?.st_nlink == 1,
            "hetu.unsafe_path",
            "锁文件不能是硬链接。",
        )?;
        fs::flock(&fd, operation)
            .map_err(|_| Error::new("hetu.workspace_busy", "另一操作正在使用此工作区。"))?;
        Ok(Lock { fd })
    }
    pub fn write_available(&self) -> Result<bool> {
        match self.lock() {
            Ok(_) => Ok(true),
            Err(error) if error.code == "hetu.workspace_busy" => Ok(false),
            Err(error) => Err(error),
        }
    }
    pub fn read_lock(&self) -> Result<Lock> {
        // 长任务只占写入锁；读取仅在多文件发布的短事务期间等待。
        let visible = self.file_lock(".hetu/visibility.lock", FlockOperation::LockShared)?;
        if self.has_pending_transaction()? {
            // 仅未完成事务需要写入恢复，普通浏览不能占写入锁。
            drop(visible);
            let _writer = self.lock().map_err(|error| {
                if error.code == "hetu.workspace_busy" {
                    Error::new(
                        "hetu.recovery_required",
                        "上次提交尚未完成，请等待恢复后查看。",
                    )
                } else {
                    error
                }
            })?;
            self.recover()?;
            return self.file_lock(".hetu/visibility.lock", FlockOperation::LockShared);
        }
        Ok(visible)
    }
    fn has_pending_transaction(&self) -> Result<bool> {
        for entry in self.entries(".hetu/transactions")? {
            crate::domain::checked_id(&entry, "txn")?;
            let journal = format!(".hetu/transactions/{entry}/journal.json");
            if self.exists(&journal)? {
                let tx: Transaction = serde_json::from_slice(&self.read(&journal)?)?;
                ensure(
                    tx.version == 1,
                    "unsupported_version",
                    "不支持此事务日志版本。",
                )?;
                if !tx.completed {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
    pub fn exists(&self, path: &str) -> Result<bool> {
        let (parent, leaf) = self.parent(path, false)?;
        match fs::statat(&parent, leaf, fs::AtFlags::SYMLINK_NOFOLLOW) {
            Ok(meta) => {
                ensure(
                    fs::FileType::from_raw_mode(meta.st_mode) == fs::FileType::RegularFile
                        && meta.st_nlink == 1,
                    "hetu.unsafe_path",
                    "受管记录必须是独立普通文件。",
                )?;
                Ok(true)
            }
            Err(rustix::io::Errno::NOENT) => Ok(false),
            Err(e) => Err(e.into()),
        }
    }
    pub fn read(&self, path: &str) -> Result<Vec<u8>> {
        let (parent, leaf) = self.parent(path, false)?;
        let fd = fs::openat(
            &parent,
            leaf,
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
            Mode::empty(),
        )
        .map_err(|e| {
            if e == rustix::io::Errno::NOENT {
                Error::new("not_found", "受管记录不存在。")
            } else {
                e.into()
            }
        })?;
        let meta = fs::fstat(&fd)?;
        ensure(
            fs::FileType::from_raw_mode(meta.st_mode) == fs::FileType::RegularFile
                && meta.st_nlink == 1,
            "hetu.unsafe_path",
            "拒绝链接、设备及非普通文件。",
        )?;
        ensure(
            meta.st_size >= 0 && meta.st_size as u64 <= READ_LIMIT,
            "hetu.budget_exceeded",
            "记录超过单次读取上限。",
        )?;
        let mut bytes = Vec::new();
        File::from(fd)
            .take(READ_LIMIT + 1)
            .read_to_end(&mut bytes)?;
        ensure(
            bytes.len() as u64 <= READ_LIMIT,
            "hetu.budget_exceeded",
            "读取期间记录超出上限。",
        )?;
        Ok(bytes)
    }
    pub fn json(&self, path: &str) -> Result<serde_json::Value> {
        serde_json::from_slice(&self.read(path)?)
            .map_err(|_| Error::new("hetu.integrity_failure", "受管记录损坏，无法作为可信输入。"))
    }
    pub fn entries(&self, path: &str) -> Result<Vec<String>> {
        let probe = if path.is_empty() {
            ".probe".into()
        } else {
            format!("{path}/.probe")
        };
        let (parent, leaf) = self.parent(&probe, false)?;
        let _ = leaf;
        let mut result = Vec::new();
        for entry in fs::Dir::read_from(&parent)? {
            let entry = entry?;
            let name = entry
                .file_name()
                .to_str()
                .map_err(|_| Error::new("hetu.unsafe_path", "目录名称不是有效 UTF-8。"))?;
            if name != "." && name != ".." {
                result.push(name.into());
            }
            ensure(
                result.len() <= 100_000,
                "hetu.budget_exceeded",
                "目录超过当前枚举预算。",
            )?;
        }
        result.sort();
        Ok(result)
    }
    pub fn matches_root(&self, path: &Path) -> Result<()> {
        use std::os::unix::fs::MetadataExt;
        let current = std::fs::symlink_metadata(path)?;
        let root = fs::fstat(&self.root)?;
        ensure(
            current.is_dir() && current.dev() == root.st_dev as u64 && current.ino() == root.st_ino,
            "hetu.unsafe_path",
            "工作区路径已被替换，请停止操作并重新打开。",
        )
    }
    pub fn file_metadata(&self, path: &str) -> Result<(u64, u32)> {
        let (parent, leaf) = self.parent(path, false)?;
        let meta = fs::statat(&parent, leaf, fs::AtFlags::SYMLINK_NOFOLLOW)?;
        ensure(
            fs::FileType::from_raw_mode(meta.st_mode) == fs::FileType::RegularFile
                && meta.st_nlink == 1
                && meta.st_size >= 0,
            "hetu.unsafe_path",
            "版本文件必须是独立普通文件。",
        )?;
        Ok((meta.st_size as u64, meta.st_mode as u32))
    }
    pub fn files(&self, start: &str, excluded: impl Fn(&str) -> bool) -> Result<Vec<String>> {
        let mut folders = vec![start.to_owned()];
        let mut files = Vec::new();
        let mut visited = 0;
        while let Some(folder) = folders.pop() {
            for name in self.entries(&folder)? {
                let path = if folder.is_empty() {
                    name
                } else {
                    format!("{folder}/{name}")
                };
                if excluded(&path) {
                    continue;
                }
                visited += 1;
                ensure(
                    visited <= 100_000,
                    "hetu.budget_exceeded",
                    "版本目录超过枚举上限。",
                )?;
                let (parent, leaf) = self.parent(&path, false)?;
                let meta = fs::statat(&parent, leaf, fs::AtFlags::SYMLINK_NOFOLLOW)?;
                match fs::FileType::from_raw_mode(meta.st_mode) {
                    fs::FileType::Directory => folders.push(path),
                    fs::FileType::RegularFile if meta.st_nlink == 1 => files.push(path),
                    _ => {
                        return Err(Error::new(
                            "hetu.unsafe_path",
                            "版本目录包含链接、设备或非普通文件。",
                        ));
                    }
                }
            }
        }
        files.sort();
        Ok(files)
    }
    pub fn sync_tree(&self, start: &str) -> Result<()> {
        let files = self.files(start, |_| false)?;
        let mut folders = std::collections::BTreeSet::new();
        for path in files {
            let (parent, leaf) = self.parent(&path, false)?;
            let fd = fs::openat(
                &parent,
                leaf,
                OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::empty(),
            )?;
            fs::fsync(&fd)?;
            let mut folder = path.rsplit_once('/').map(|(p, _)| p);
            while let Some(path) = folder {
                folders.insert(path.to_owned());
                folder = path.rsplit_once('/').map(|(p, _)| p);
            }
        }
        for folder in folders.iter().rev() {
            let (fd, _) = self.parent(&format!("{folder}/.probe"), false)?;
            fs::fsync(&fd)?;
        }
        fs::fsync(&self.root)?;
        Ok(())
    }
    pub fn install(&self, path: &str, bytes: &[u8], exclusive: bool) -> Result<()> {
        let (parent, leaf) = self.parent(path, true)?;
        let exists = self.exists(path)?;
        ensure(
            !exclusive || !exists,
            "revision_conflict",
            "不可覆盖已有记录。",
        )?;
        let temporary = format!(".{}", id("hetu-write"));
        let fd = fs::openat(
            &parent,
            &temporary,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::from_raw_mode(0o600),
        )?;
        let mut file = File::from(fd);
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::renameat(&parent, &temporary, &parent, &leaf)?;
        fs::fsync(&parent)?;
        Ok(())
    }
    pub fn recover(&self) -> Result<()> {
        let _visible = self.file_lock(".hetu/visibility.lock", FlockOperation::LockExclusive)?;
        self.recover_locked()
    }
    fn recover_locked(&self) -> Result<()> {
        for entry in self.entries(".hetu/transactions")? {
            crate::domain::checked_id(&entry, "txn")?;
            let journal = format!(".hetu/transactions/{entry}/journal.json");
            if self.exists(&journal)? {
                self.recover_transaction(&journal)?;
            }
        }
        Ok(())
    }
    fn recover_transaction(&self, journal: &str) -> Result<()> {
        let mut tx: Transaction = serde_json::from_slice(&self.read(journal)?)
            .map_err(|_| Error::new("hetu.recovery_required", "事务日志损坏，需要人工恢复。"))?;
        ensure(
            tx.version == 1,
            "unsupported_version",
            "不支持此事务日志版本。",
        )?;
        if tx.completed {
            return Ok(());
        }
        // 先核验全部目标和全部 payload，再执行任何替换，避免覆盖外部修改。
        for change in &tx.changes {
            let current = if self.exists(&change.path)? {
                Some(digest(self.read(&change.path)?))
            } else {
                None
            };
            ensure(
                current == change.before || current.as_deref() == Some(&change.after),
                "hetu.recovery_required",
                "未完成事务与外部编辑冲突，保留原文件等待审阅。",
            )?;
            ensure(
                digest(self.read(&change.payload)?) == change.after,
                "hetu.integrity_failure",
                "事务 payload 摘要不匹配。",
            )?;
        }
        for change in &tx.changes {
            if !self.exists(&change.path)? || digest(self.read(&change.path)?) != change.after {
                self.install(&change.path, &self.read(&change.payload)?, false)?;
            }
        }
        tx.completed = true;
        self.install(journal, &serde_json::to_vec(&tx)?, false)
    }
    pub fn transaction(&self, changes: &BTreeMap<String, Vec<u8>>) -> Result<()> {
        let _visible = self.file_lock(".hetu/visibility.lock", FlockOperation::LockExclusive)?;
        self.recover_locked()?;
        let root = format!(".hetu/transactions/{}", id("txn"));
        self.directory(&root)?;
        let mut tx = Transaction {
            version: 1,
            completed: false,
            changes: Vec::new(),
        };
        for (index, (path, bytes)) in changes.iter().enumerate() {
            self.parent(path, true)?;
            let before = if self.exists(path)? {
                Some(digest(self.read(path)?))
            } else {
                None
            };
            let payload = format!("{root}/{index}.data");
            self.install(&payload, bytes, true)?;
            tx.changes.push(Change {
                path: path.into(),
                before,
                after: digest(bytes),
                payload,
            });
        }
        let journal = format!("{root}/journal.json");
        self.install(&journal, &serde_json::to_vec(&tx)?, true)?;
        self.recover_transaction(&journal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn readers_never_observe_half_of_a_multifile_publication() {
        use std::sync::mpsc;
        use std::time::Duration;
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path()).unwrap();
        store.directory(".hetu/transactions").unwrap();
        store.install("first.json", b"old", true).unwrap();
        store.install("second.json", b"old", true).unwrap();
        let read = store.read_lock().unwrap();
        let path = root.path().to_owned();
        let (started, waiting) = mpsc::channel();
        let (published, result) = mpsc::channel();
        let writer = std::thread::spawn(move || {
            let store = Store::open(&path).unwrap();
            let _write = store.lock().unwrap();
            started.send(()).unwrap();
            store
                .transaction(&BTreeMap::from([
                    ("first.json".into(), b"new".to_vec()),
                    ("second.json".into(), b"new".to_vec()),
                ]))
                .unwrap();
            published.send(()).unwrap();
        });
        waiting.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(
            result.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        assert_eq!(store.read("first.json").unwrap(), b"old");
        assert_eq!(store.read("second.json").unwrap(), b"old");
        drop(read);
        result.recv_timeout(Duration::from_secs(5)).unwrap();
        writer.join().unwrap();
        let _read = store.read_lock().unwrap();
        assert_eq!(store.read("first.json").unwrap(), b"new");
        assert_eq!(store.read("second.json").unwrap(), b"new");
    }

    #[test]
    fn incomplete_publication_is_not_exposed_as_a_readable_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path()).unwrap();
        prepared(&store);
        store.install("first.json", b"new-first", false).unwrap();
        let writer = store.lock().unwrap();
        assert_eq!(
            store.read_lock().err().unwrap().code,
            "hetu.recovery_required"
        );
        drop(writer);
        let _read = store.read_lock().unwrap();
        assert_eq!(store.read("first.json").unwrap(), b"new-first");
        assert_eq!(store.read("second.json").unwrap(), b"new-second");
    }
    fn prepared(store: &Store) -> String {
        store.directory(".hetu/transactions").unwrap();
        store.install("first.json", b"old-first", true).unwrap();
        store.install("second.json", b"old-second", true).unwrap();
        let root = format!(".hetu/transactions/{}", id("txn"));
        let tx = Transaction {
            version: 1,
            completed: false,
            changes: vec![
                Change {
                    path: "first.json".into(),
                    before: Some(digest(b"old-first")),
                    after: digest(b"new-first"),
                    payload: format!("{root}/0.data"),
                },
                Change {
                    path: "second.json".into(),
                    before: Some(digest(b"old-second")),
                    after: digest(b"new-second"),
                    payload: format!("{root}/1.data"),
                },
            ],
        };
        store
            .install(&tx.changes[0].payload, b"new-first", true)
            .unwrap();
        store
            .install(&tx.changes[1].payload, b"new-second", true)
            .unwrap();
        let journal = format!("{root}/journal.json");
        store
            .install(&journal, &serde_json::to_vec(&tx).unwrap(), true)
            .unwrap();
        journal
    }
    #[test]
    fn interrupted_multifile_transaction_is_completed_on_reopen() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path()).unwrap();
        prepared(&store);
        // 模拟进程在第一个清单替换成功后、第二个清单安装前崩溃。
        store.install("first.json", b"new-first", false).unwrap();
        drop(store);
        let reopened = Store::open(root.path()).unwrap();
        let _lock = reopened.lock().unwrap();
        reopened.recover().unwrap();
        assert_eq!(reopened.read("first.json").unwrap(), b"new-first");
        assert_eq!(reopened.read("second.json").unwrap(), b"new-second");
        reopened.recover().unwrap();
        assert_eq!(reopened.read("second.json").unwrap(), b"new-second");
    }
    #[test]
    fn recovery_preserves_external_edit_and_refuses_further_installation() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path()).unwrap();
        prepared(&store);
        store
            .install("first.json", b"external-edit", false)
            .unwrap();
        assert_eq!(store.recover().unwrap_err().code, "hetu.recovery_required");
        assert_eq!(store.read("first.json").unwrap(), b"external-edit");
        assert_eq!(store.read("second.json").unwrap(), b"old-second");
    }
    #[test]
    fn os_lock_blocks_other_context_without_stale_pid_files() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path()).unwrap();
        store.directory(".hetu").unwrap();
        let held = store.lock().unwrap();
        let second = Store::open(root.path()).unwrap();
        assert!(matches!(
            second.lock(),
            Err(Error {
                code: "hetu.workspace_busy",
                ..
            })
        ));
        drop(held);
        assert!(second.lock().is_ok());
    }
}
