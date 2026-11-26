//! 存储清理仅操作受管目录描述符内已固定的独立文件。
use super::{
    platform::{
        self,
        fs::{self, Mode, OFlags},
    },
    store::Store,
};
use crate::domain::{Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read};

pub(crate) fn entry(store: &Store, path: &str) -> Result<Option<Value>> {
    let (parent, leaf) = match store.parent(path, false) {
        Ok(value) => value,
        Err(error) if error.code == "not_found" => return Ok(None),
        Err(error) => return Err(error),
    };
    let stat = match fs::statat(&parent, leaf, fs::AtFlags::SYMLINK_NOFOLLOW) {
        Ok(value) => value,
        Err(platform::Errno::NOENT) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let kind = match fs::FileType::from_raw_mode(stat.st_mode) {
        fs::FileType::Directory => "directory",
        fs::FileType::RegularFile if stat.st_nlink == 1 => "file",
        _ => "unsafe",
    };
    Ok(Some(
        json!({"kind":kind,"bytes":stat.st_size.max(0) as u64,"device":stat.st_dev,"inode":stat.st_ino}),
    ))
}

pub(crate) fn fingerprint(store: &Store, path: &str) -> Result<Value> {
    let (parent, leaf) = store.parent(path, false)?;
    let fd = fs::openat(
        &parent,
        leaf,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let stat = fs::fstat(&fd)?;
    ensure(
        fs::FileType::from_raw_mode(stat.st_mode) == fs::FileType::RegularFile
            && stat.st_nlink == 1,
        "hetu.unsafe_path",
        "清理候选必须是独立普通文件。",
    )?;
    ensure(
        (0..=256 * 1024 * 1024).contains(&stat.st_size),
        "hetu.budget_exceeded",
        "文件超过本次清理核验上限。",
    )?;
    let mut file = File::from(fd);
    let before = file.metadata()?;
    let mut hasher = Sha256::new();
    let count = std::io::copy(
        &mut Read::by_ref(&mut file).take(256 * 1024 * 1024 + 1),
        &mut hasher,
    )?;
    let after = file.metadata()?;
    ensure(
        count == stat.st_size as u64
            && before.len() == after.len()
            && before.modified()? == after.modified()?,
        "revision_conflict",
        "文件正在变化，已保留。",
    )?;
    let modified = after
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    Ok(
        json!({"device":stat.st_dev,"inode":stat.st_ino,"bytes":count,
        "modified_ns":modified.as_nanos().to_string(),"modified_at":modified.as_secs(),"sha256":format!("{:x}",hasher.finalize())}),
    )
}

pub(crate) fn move_to_stage(store: &Store, source: &str, stage: &str) -> Result<()> {
    ensure(
        entry(store, stage)?.is_none(),
        "revision_conflict",
        "清理暂存项已存在，请恢复原方案。",
    )?;
    let (from, name) = store.parent(source, false)?;
    let (to, target) = store.parent(stage, false)?;
    fs::renameat(&from, name, &to, target)?;
    fs::fsync(&from)?;
    fs::fsync(&to)?;
    Ok(())
}

pub(crate) fn remove_staged(store: &Store, stage: &str, expected: &Value) -> Result<()> {
    ensure(
        fingerprint(store, stage)? == *expected,
        "revision_conflict",
        "文件已变化，保留清理暂存项。",
    )?;
    let (parent, leaf) = store.parent(stage, false)?;
    fs::unlinkat(&parent, leaf, fs::AtFlags::empty())?;
    fs::fsync(&parent)?;
    Ok(())
}
