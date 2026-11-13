use super::store::Store;
use crate::domain::{Result, ensure, id, media};
use rustix::fs::{self, AtFlags, Mode, OFlags};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

fn checked_file(file: &File) -> Result<std::fs::Metadata> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    ensure(
        metadata.is_file() && metadata.nlink() == 1 && metadata.mode() & 0o111 == 0,
        "hetu.unsafe_path",
        "素材必须是非可执行的独立普通文件，不能使用链接、目录或设备。",
    )?;
    ensure(
        metadata.len() > 0 && metadata.len() <= media::FILE_LIMIT,
        "hetu.budget_exceeded",
        "媒体文件必须非空且不超过 2 GiB。",
    )?;
    Ok(metadata)
}

pub fn selected_file(path: &Path) -> Result<File> {
    ensure(
        path.is_absolute(),
        "hetu.unsafe_path",
        "导入文件必须由作者选择绝对路径。",
    )?;
    ensure(
        path.file_name().is_some(),
        "hetu.unsafe_path",
        "文件名称无效。",
    )?;
    // 文件选择器授予所选文件的访问权；不额外以可读目录方式打开其父目录。
    // 最终路径不跟随链接，随后始终通过同一文件描述符核验类型、身份和摘要。
    let fd = fs::open(
        path,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    )?;
    let file = File::from(fd);
    checked_file(&file)?;
    Ok(file)
}

pub fn scan(file: &mut File, mut target: Option<&mut File>) -> Result<Value> {
    use std::os::unix::fs::MetadataExt;
    let before = checked_file(file)?;
    file.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let mut prefix = Vec::new();
    let mut count = 0u64;
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let size = file.read(&mut buffer)?;
        if size == 0 {
            break;
        }
        count += size as u64;
        ensure(
            count <= media::FILE_LIMIT,
            "hetu.budget_exceeded",
            "导入过程中素材超过 2 GiB。",
        )?;
        if prefix.len() < 64 {
            prefix.extend_from_slice(&buffer[..size.min(64 - prefix.len())]);
        }
        hasher.update(&buffer[..size]);
        if let Some(target) = &mut target {
            target.write_all(&buffer[..size])?;
        }
    }
    let after = checked_file(file)?;
    ensure(
        before.dev() == after.dev()
            && before.ino() == after.ino()
            && before.len() == count
            && after.len() == count
            && before.mtime() == after.mtime()
            && before.mtime_nsec() == after.mtime_nsec()
            && before.ctime() == after.ctime()
            && before.ctime_nsec() == after.ctime_nsec(),
        "revision_conflict",
        "读取过程中原素材发生变化，请重新选择并核对。",
    )?;
    let mut result = media::signature(&prefix)?;
    result["size_bytes"] = json!(count);
    result["sha256"] = json!(format!("{:x}", hasher.finalize()));
    Ok(result)
}

impl Store {
    pub fn managed_media(&self, path: &str) -> Result<File> {
        let (parent, leaf) = self.parent(path, false)?;
        let file = File::from(fs::openat(
            &parent,
            leaf,
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
            Mode::empty(),
        )?);
        checked_file(&file)?;
        Ok(file)
    }

    pub fn import_media(&self, path: &str, source: &mut File, expected: &Value) -> Result<()> {
        let (parent, leaf) = self.parent(path, true)?;
        ensure(
            !self.exists(path)?,
            "hetu.integrity_failure",
            "素材文件已存在，不能覆盖。",
        )?;
        let temporary = format!(".{}", id("media-import"));
        let fd = fs::openat(
            &parent,
            &temporary,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::from_raw_mode(0o600),
        )?;
        let mut target = File::from(fd);
        let imported = (|| {
            let actual = scan(source, Some(&mut target))?;
            ensure(
                actual["sha256"] == expected["sha256"]
                    && actual["size_bytes"] == expected["size_bytes"],
                "revision_conflict",
                "素材与作者预览的文件摘要不同，请重新检查。",
            )?;
            target.sync_all()?;
            // 原子独占安装，不覆盖并发出现的目标；解除临时硬链接后才登记元数据。
            fs::linkat(&parent, &temporary, &parent, &leaf, AtFlags::empty())?;
            fs::unlinkat(&parent, &temporary, AtFlags::empty())?;
            fs::fsync(&parent)?;
            Ok(())
        })();
        if imported.is_err() {
            let _ = fs::unlinkat(&parent, &temporary, AtFlags::empty());
        }
        imported
    }
}
