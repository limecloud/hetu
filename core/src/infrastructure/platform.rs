//! 受管存储的平台边界；Unix 保留 openat，Windows 使用目录能力句柄。
#[cfg(unix)]
pub use rustix::{
    fd::OwnedFd,
    io::{Errno, dup},
};
#[cfg(unix)]
pub use std::{fs::Metadata as FileMetadata, os::unix::fs::MetadataExt as FileMetadataExt};

#[cfg(unix)]
pub mod fs {
    pub use rustix::fs::*;
    pub fn names(parent: &super::OwnedFd) -> crate::domain::Result<Vec<String>> {
        let mut names = Vec::new();
        for entry in Dir::read_from(parent)? {
            let entry = entry?;
            let name = entry.file_name().to_str().map_err(|_| {
                crate::domain::Error::new("hetu.unsafe_path", "目录名称不是有效 UTF-8。")
            })?;
            if name != "." && name != ".." {
                names.push(name.to_owned());
            }
            crate::domain::ensure(
                names.len() <= 100_000,
                "hetu.budget_exceeded",
                "目录超过当前枚举预算。",
            )?;
        }
        Ok(names)
    }
}

#[cfg(windows)]
#[path = "platform/windows.rs"]
mod windows;
#[cfg(windows)]
pub use windows::*;

#[cfg(unix)]
pub fn metadata(file: &std::fs::File) -> std::io::Result<FileMetadata> {
    file.metadata()
}

#[cfg(unix)]
pub fn sync_all(file: &std::fs::File) -> std::io::Result<()> { file.sync_all() }

/// 身份来自实际打开的对象，不能用路径字符串或时间戳代替。
pub fn identity(path: &std::path::Path) -> crate::domain::Result<(u64, u64)> {
    let flags = fs::OFlags::RDONLY | fs::OFlags::CLOEXEC | fs::OFlags::NOFOLLOW;
    #[cfg(windows)]
    let flags = if path.is_dir() {
        flags | fs::OFlags::DIRECTORY
    } else {
        flags
    };
    let file = std::fs::File::from(fs::open(path, flags, fs::Mode::empty())?);
    let meta = metadata(&file)?;
    Ok((meta.dev(), meta.ino()))
}
