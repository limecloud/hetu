use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use std::{
    fs::File,
    io,
    os::windows::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, FILE_BASIC_INFO,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FileBasicInfo,
    GetFileInformationByHandle, GetFileInformationByHandleEx,
};

pub type OwnedFd = File;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Errno(io::ErrorKind);
impl Errno {
    pub const EXIST: Self = Self(io::ErrorKind::AlreadyExists);
    pub const NOENT: Self = Self(io::ErrorKind::NotFound);
    pub const WOULDBLOCK: Self = Self(io::ErrorKind::WouldBlock);
}
impl From<io::Error> for Errno {
    fn from(error: io::Error) -> Self {
        Self(error.kind())
    }
}
type Result<T> = std::result::Result<T, Errno>;

pub fn dup(file: &File) -> Result<File> {
    file.try_clone().map_err(Into::into)
}

pub fn sync_all(file: &File) -> io::Result<()> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use windows_sys::Win32::{Foundation::INVALID_HANDLE_VALUE, Storage::FileSystem::{
        ReOpenFile, FILE_GENERIC_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_SHARE_DELETE,
    }};
    // FlushFileBuffers 要求写访问；重新打开同一句柄，不重新解析文件路径。
    // SAFETY: 输入句柄在调用期间存活，成功返回的独占句柄立即交给 File 管理。
    let writable = unsafe {
        let handle = ReOpenFile(file.as_raw_handle(), FILE_GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, 0);
        if handle == INVALID_HANDLE_VALUE { return Err(io::Error::last_os_error()); }
        File::from_raw_handle(handle)
    };
    writable.sync_all()
}

pub struct FileMetadata {
    inner: std::fs::Metadata,
    identity: BY_HANDLE_FILE_INFORMATION,
    change_time: i64,
}
impl std::ops::Deref for FileMetadata {
    type Target = std::fs::Metadata;
    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}
pub trait FileMetadataExt {
    fn dev(&self) -> u64;
    fn ino(&self) -> u64;
    fn nlink(&self) -> u64;
    fn mode(&self) -> u32;
    fn mtime(&self) -> i64;
    fn mtime_nsec(&self) -> i64;
    fn ctime(&self) -> i64;
    fn ctime_nsec(&self) -> i64;
}
impl FileMetadataExt for FileMetadata {
    fn dev(&self) -> u64 {
        self.identity.dwVolumeSerialNumber.into()
    }
    fn ino(&self) -> u64 {
        (u64::from(self.identity.nFileIndexHigh) << 32) | u64::from(self.identity.nFileIndexLow)
    }
    fn nlink(&self) -> u64 {
        self.identity.nNumberOfLinks.into()
    }
    fn mode(&self) -> u32 {
        if self.inner.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            0o120000
        } else if self.is_dir() {
            0o040700
        } else if self.is_file() {
            0o100600
        } else {
            0
        }
    }
    fn mtime(&self) -> i64 {
        (self.inner.last_write_time() / 10_000_000) as i64
    }
    fn mtime_nsec(&self) -> i64 {
        (self.inner.last_write_time() % 10_000_000 * 100) as i64
    }
    fn ctime(&self) -> i64 {
        self.change_time / 10_000_000
    }
    fn ctime_nsec(&self) -> i64 {
        self.change_time % 10_000_000 * 100
    }
}

pub fn metadata(file: &File) -> io::Result<FileMetadata> {
    use std::{
        mem::{MaybeUninit, size_of},
        os::windows::io::AsRawHandle,
    };
    let inner = file.metadata()?;
    let mut identity = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    let mut basic = MaybeUninit::<FILE_BASIC_INFO>::uninit();
    // SAFETY: 句柄在调用期间有效，两个输出缓冲区的类型和大小与 Win32 合同一致。
    unsafe {
        if GetFileInformationByHandle(file.as_raw_handle(), identity.as_mut_ptr()) == 0
            || GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileBasicInfo,
                basic.as_mut_ptr().cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(FileMetadata {
            inner,
            identity: identity.assume_init(),
            change_time: basic.assume_init().ChangeTime,
        })
    }
}

fn invalid_path() -> Errno {
    Errno(io::ErrorKind::InvalidInput)
}

/// 拒绝 ADS、盘符、设备名和 Win32 名称归一化产生的别名。
pub fn valid_component(name: &str) -> bool {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
    {
        return false;
    }
    let stem = name.split('.').next().unwrap().to_uppercase();
    !matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) && !(stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
        .is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        }))
}
fn leaf(path: impl AsRef<Path>) -> Result<std::ffi::OsString> {
    let text = path.as_ref().to_str().ok_or_else(invalid_path)?;
    if !valid_component(text) {
        return Err(invalid_path());
    }
    Ok(path.as_ref().as_os_str().to_owned())
}
fn directory(file: &File) -> Result<Dir> {
    Ok(Dir::from_std_file(dup(file)?))
}
fn reject_reparse(file: &File) -> Result<()> {
    if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(invalid_path());
    }
    Ok(())
}

pub mod fs {
    use super::*;
    #[derive(Clone, Copy)]
    pub struct OFlags(u16);
    impl OFlags {
        pub const RDONLY: Self = Self(1);
        pub const RDWR: Self = Self(2);
        pub const WRONLY: Self = Self(4);
        pub const DIRECTORY: Self = Self(8);
        pub const CREATE: Self = Self(16);
        pub const EXCL: Self = Self(32);
        pub const CLOEXEC: Self = Self(0);
        pub const NOFOLLOW: Self = Self(0);
        pub const NONBLOCK: Self = Self(0);
        fn has(self, other: Self) -> bool {
            self.0 & other.0 != 0
        }
    }
    impl std::ops::BitOr for OFlags {
        type Output = Self;
        fn bitor(self, other: Self) -> Self {
            Self(self.0 | other.0)
        }
    }
    pub struct Mode;
    impl Mode {
        pub fn empty() -> Self {
            Self
        }
        pub fn from_raw_mode(_: u32) -> Self {
            Self
        }
    }
    pub struct AtFlags;
    impl AtFlags {
        pub const SYMLINK_NOFOLLOW: Self = Self;
        pub fn empty() -> Self {
            Self
        }
    }
    pub enum FlockOperation {
        Unlock,
        NonBlockingLockExclusive,
        LockShared,
        LockExclusive,
    }
    #[derive(PartialEq)]
    pub enum FileType {
        RegularFile,
        Directory,
        Other,
    }
    impl FileType {
        pub fn from_raw_mode(mode: u32) -> Self {
            match mode & 0o170000 {
                0o100000 => Self::RegularFile,
                0o040000 => Self::Directory,
                _ => Self::Other,
            }
        }
    }
    pub struct Stat {
        pub st_dev: u64,
        pub st_ino: u64,
        pub st_nlink: u64,
        pub st_mode: u32,
        pub st_size: i64,
    }
    pub fn fstat(file: &File) -> Result<Stat> {
        let meta = metadata(file)?;
        Ok(Stat {
            st_dev: meta.dev(),
            st_ino: meta.ino(),
            st_nlink: meta.nlink(),
            st_mode: meta.mode(),
            st_size: meta.len().try_into().map_err(|_| invalid_path())?,
        })
    }
    pub fn open(path: impl AsRef<Path>, flags: OFlags, _: Mode) -> Result<File> {
        let path = path.as_ref();
        if !path.is_absolute()
            || path.components().any(|part| match part {
                std::path::Component::Normal(name) => !name.to_str().is_some_and(valid_component),
                std::path::Component::ParentDir => true,
                std::path::Component::Prefix(prefix) => !matches!(
                    prefix.kind(),
                    std::path::Prefix::Disk(_)
                        | std::path::Prefix::VerbatimDisk(_)
                        | std::path::Prefix::UNC(..)
                        | std::path::Prefix::VerbatimUNC(..)
                ),
                _ => false,
            })
        {
            return Err(invalid_path());
        }
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(flags.has(OFlags::RDWR) || flags.has(OFlags::WRONLY))
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        reject_reparse(&file)?;
        if flags.has(OFlags::DIRECTORY) && !file.metadata()?.is_dir() {
            return Err(invalid_path());
        }
        Ok(file)
    }
    pub fn openat(parent: &File, name: impl AsRef<Path>, flags: OFlags, _: Mode) -> Result<File> {
        let name = leaf(name)?;
        let dir = directory(parent)?;
        let file = if flags.has(OFlags::DIRECTORY) {
            dir.open_dir_nofollow(&name)?.into_std_file()
        } else {
            let mut options = OpenOptions::new();
            options
                .read(flags.has(OFlags::RDONLY) || flags.has(OFlags::RDWR))
                .write(flags.has(OFlags::WRONLY) || flags.has(OFlags::RDWR))
                .create(flags.has(OFlags::CREATE) && !flags.has(OFlags::EXCL))
                .create_new(flags.has(OFlags::EXCL))
                .follow(FollowSymlinks::No);
            dir.open_with(&name, &options)?.into_std()
        };
        reject_reparse(&file)?;
        Ok(file)
    }
    pub fn statat(parent: &File, name: impl AsRef<Path>, _: AtFlags) -> Result<Stat> {
        let name = leaf(name)?;
        let dir = directory(parent)?;
        let meta = dir.symlink_metadata(&name)?;
        if meta.file_type().is_symlink() {
            return Err(invalid_path());
        }
        let flags = if meta.is_dir() {
            OFlags::RDONLY | OFlags::DIRECTORY
        } else {
            OFlags::RDONLY
        };
        fstat(&openat(parent, name, flags, Mode::empty())?)
    }
    pub fn mkdirat(parent: &File, name: impl AsRef<Path>, _: Mode) -> Result<()> {
        directory(parent)?
            .create_dir(leaf(name)?)
            .map_err(Into::into)
    }
    pub fn renameat(
        from: &File,
        source: impl AsRef<Path>,
        to: &File,
        target: impl AsRef<Path>,
    ) -> Result<()> {
        directory(from)?
            .rename(leaf(source)?, &directory(to)?, leaf(target)?)
            .map_err(Into::into)
    }
    pub fn linkat(
        from: &File,
        source: impl AsRef<Path>,
        to: &File,
        target: impl AsRef<Path>,
        _: AtFlags,
    ) -> Result<()> {
        directory(from)?
            .hard_link(leaf(source)?, &directory(to)?, leaf(target)?)
            .map_err(Into::into)
    }
    pub fn unlinkat(parent: &File, name: impl AsRef<Path>, _: AtFlags) -> Result<()> {
        directory(parent)?
            .remove_file(leaf(name)?)
            .map_err(Into::into)
    }
    pub fn fsync(file: &File) -> Result<()> {
        // Windows 不提供 Unix 目录 fsync；文件与事务日志仍调用 FlushFileBuffers。
        // 目录项的断电持久性不等同于 Unix fsync，恢复时必须核对日志和实际文件。
        if file.metadata()?.is_dir() {
            Ok(())
        } else {
            sync_all(file).map_err(Into::into)
        }
    }
    pub fn flock(file: &File, operation: FlockOperation) -> Result<()> {
        match operation {
            FlockOperation::Unlock => file.unlock().map_err(Into::into),
            FlockOperation::LockExclusive => file.lock().map_err(Into::into),
            FlockOperation::LockShared => file.lock_shared().map_err(Into::into),
            FlockOperation::NonBlockingLockExclusive => {
                file.try_lock().map_err(|error| match error {
                    std::fs::TryLockError::WouldBlock => Errno::WOULDBLOCK,
                    std::fs::TryLockError::Error(error) => error.into(),
                })
            }
        }
    }
    pub fn names(parent: &File) -> crate::domain::Result<Vec<String>> {
        let mut names = Vec::new();
        for entry in directory(parent)?.entries()? {
            let name = entry?.file_name().into_string().map_err(|_| {
                crate::domain::Error::new("hetu.unsafe_path", "目录名称不是有效 UTF-8。")
            })?;
            crate::domain::ensure(
                valid_component(&name),
                "hetu.unsafe_path",
                "目录包含不安全的 Windows 名称。",
            )?;
            names.push(name);
            crate::domain::ensure(
                names.len() <= 100_000,
                "hetu.budget_exceeded",
                "目录超过当前枚举预算。",
            )?;
        }
        Ok(names)
    }
}
