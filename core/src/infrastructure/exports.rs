use super::store::Store;
use crate::domain::{Error, Result, checked_id, digest, ensure};
use rustix::fd::OwnedFd;
use rustix::fs::{self, AtFlags, FlockOperation, Mode, OFlags};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{File, Metadata},
    io::{self, Read, Seek, SeekFrom, Write},
    os::unix::fs::MetadataExt,
};
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

const FILE_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const BUNDLE_LIMIT: u64 = 4 * 1024 * 1024 * 1024;
const MANIFEST_LIMIT: u64 = 16 * 1024 * 1024;
const DIRECTORY_LIMIT: u64 = 16 * 1024 * 1024;
const ENTRY_LIMIT: usize = 10_000;
const BUFFER_SIZE: usize = 256 * 1024;

pub enum PayloadData {
    Bytes(Vec<u8>),
    File {
        file: File,
        size: u64,
        sha256: String,
    },
}

pub struct Payload {
    pub path: String,
    pub media_type: String,
    pub source: Value,
    pub data: PayloadData,
}

pub struct DeliveryLock {
    file: File,
}

impl Drop for DeliveryLock {
    fn drop(&mut self) {
        let _ = fs::flock(&self.file, FlockOperation::Unlock);
    }
}

impl Payload {
    pub fn descriptor(&self) -> Value {
        let (size, sha256) = match &self.data {
            PayloadData::Bytes(bytes) => (bytes.len() as u64, digest(bytes)),
            PayloadData::File { size, sha256, .. } => (*size, sha256.clone()),
        };
        json!({"path":self.path,"size_bytes":size,"sha256":sha256,
            "media_type":self.media_type,"source":self.source})
    }
}

fn integrity(message: &str) -> Error {
    Error::new("hetu.integrity_failure", message)
}

fn zip_error(_: zip::result::ZipError) -> Error {
    integrity("交付包损坏或包含不支持的 ZIP 结构。")
}

fn output_error(error: io::Error) -> Error {
    if error.kind() == io::ErrorKind::FileTooLarge {
        Error::new("hetu.budget_exceeded", "交付包或清单超出写入预算。")
    } else {
        error.into()
    }
}

fn zip_output_error(error: zip::result::ZipError) -> Error {
    match error {
        zip::result::ZipError::Io(error) => output_error(error),
        _ => zip_error(error),
    }
}

fn checked_file_with_links(file: &File, limit: u64, links: u64) -> Result<Metadata> {
    let metadata = file.metadata()?;
    ensure(
        metadata.is_file() && metadata.nlink() == links && metadata.mode() & 0o111 == 0,
        "hetu.unsafe_path",
        "交付文件必须是非可执行的独立普通文件，不能使用链接、目录或设备。",
    )?;
    ensure(
        metadata.len() <= limit,
        "hetu.budget_exceeded",
        "交付文件超过读取预算。",
    )?;
    Ok(metadata)
}

fn checked_file(file: &File, limit: u64) -> Result<Metadata> {
    checked_file_with_links(file, limit, 1)
}

fn same_file(before: &Metadata, after: &Metadata) -> bool {
    before.dev() == after.dev() && before.ino() == after.ino()
}

fn unchanged(before: &Metadata, after: &Metadata) -> bool {
    same_file(before, after)
        && before.len() == after.len()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && before.ctime() == after.ctime()
        && before.ctime_nsec() == after.ctime_nsec()
}

fn checked_staging_path(path: &str) -> Result<()> {
    let parts: Vec<_> = path.split('/').collect();
    ensure(
        parts.len() == 4
            && parts[0] == ".hetu"
            && parts[1] == "deliveries"
            && parts[3] == "artifact.tmp",
        "hetu.unsafe_path",
        "只允许操作交付目录中的 artifact.tmp。",
    )?;
    checked_id(parts[2], "delivery")?;
    Ok(())
}

fn check_path_inode(parent: &OwnedFd, leaf: &str, before: &Metadata, links: u64) -> Result<()> {
    let current = fs::statat(parent, leaf, AtFlags::SYMLINK_NOFOLLOW)?;
    ensure(
        current.st_dev as u64 == before.dev()
            && current.st_ino == before.ino()
            && current.st_nlink as u64 == links
            && current.st_size >= 0
            && current.st_size as u64 == before.len()
            && current.st_mode & 0o111 == 0
            && fs::FileType::from_raw_mode(current.st_mode) == fs::FileType::RegularFile,
        "revision_conflict",
        "交付文件路径、长度或链接状态发生变化。",
    )
}

fn checked_path(path: &str) -> Result<()> {
    ensure(
        !path.is_empty()
            && path.len() <= 4096
            && !path.contains(['\\', '\0'])
            && !path.split('/').next().unwrap_or_default().contains(':')
            && path
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != ".."),
        "hetu.unsafe_path",
        "包内路径必须为不含跳转、反斜杠或驱动器前缀的相对文件路径。",
    )
}

fn manifest_files(manifest: &Value) -> Result<BTreeMap<String, Value>> {
    let files = manifest
        .as_object()
        .and_then(|object| object.get("files"))
        .and_then(Value::as_array)
        .ok_or_else(|| integrity("交付清单缺少文件列表。"))?;
    ensure(
        files.len() < ENTRY_LIMIT,
        "hetu.budget_exceeded",
        "交付包条目总数不能超过 10000。",
    )?;
    let mut result = BTreeMap::new();
    let mut total = 0u64;
    for descriptor in files {
        let path = descriptor["path"]
            .as_str()
            .ok_or_else(|| integrity("清单文件路径无效。"))?;
        checked_path(path)?;
        ensure(
            path != "manifest.json" && !path.starts_with("manifest.json/"),
            "hetu.integrity_failure",
            "清单只能列出载荷文件，不能列出或占用自身路径。",
        )?;
        let size = descriptor["size_bytes"]
            .as_u64()
            .ok_or_else(|| integrity("清单文件长度无效。"))?;
        ensure(
            size <= FILE_LIMIT,
            "hetu.budget_exceeded",
            "单个载荷不能超过 2 GiB。",
        )?;
        total = total
            .checked_add(size)
            .ok_or_else(|| Error::new("hetu.budget_exceeded", "载荷总长度溢出。"))?;
        ensure(
            total <= BUNDLE_LIMIT,
            "hetu.budget_exceeded",
            "交付包载荷总量不能超过 4 GiB。",
        )?;
        let hash = descriptor["sha256"]
            .as_str()
            .ok_or_else(|| integrity("清单文件摘要无效。"))?;
        ensure(
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                && descriptor["media_type"]
                    .as_str()
                    .is_some_and(|value| !value.is_empty())
                && descriptor.get("source").is_some(),
            "hetu.integrity_failure",
            "清单文件的摘要、媒体类型或来源缺失。",
        )?;
        ensure(
            result.insert(path.to_owned(), descriptor.clone()).is_none(),
            "hetu.integrity_failure",
            "交付清单不能包含重复路径。",
        )?;
    }
    // 不允许一个普通文件同时充当另一条目的父目录。
    for path in result.keys() {
        for (offset, _) in path.match_indices('/') {
            ensure(
                !result.contains_key(&path[..offset]),
                "hetu.integrity_failure",
                "交付清单包含冲突的文件与目录路径。",
            )?;
        }
    }
    Ok(result)
}

struct ManifestBuffer(Vec<u8>);

impl Write for ManifestBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() as u64 > MANIFEST_LIMIT.saturating_sub(self.0.len() as u64) {
            return Err(io::Error::from(io::ErrorKind::FileTooLarge));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct BundleFile {
    file: File,
    position: u64,
}

impl Write for BundleFile {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() as u64 > BUNDLE_LIMIT.saturating_sub(self.position) {
            return Err(io::Error::from(io::ErrorKind::FileTooLarge));
        }
        let written = self.file.write(bytes)?;
        self.position += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

impl Seek for BundleFile {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.position = self.file.seek(position)?;
        if self.position > BUNDLE_LIMIT {
            return Err(io::Error::from(io::ErrorKind::FileTooLarge));
        }
        Ok(self.position)
    }
}

fn copy_payload(file: &mut File, target: &mut impl Write, size: u64, hash: &str) -> Result<()> {
    let before = checked_file(file, FILE_LIMIT)?;
    ensure(
        before.len() == size,
        "revision_conflict",
        "载荷长度与已固定快照不同。",
    )?;
    file.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let mut count = 0u64;
    let mut buffer = vec![0; BUFFER_SIZE];
    loop {
        // 多读一个字节即可发现增长，避免来源被持续追加时无限处理。
        let available = (size.saturating_sub(count) + 1).min(buffer.len() as u64) as usize;
        let read = file.read(&mut buffer[..available])?;
        if read == 0 {
            break;
        }
        count += read as u64;
        ensure(
            count <= size,
            "revision_conflict",
            "压缩期间载荷长度发生变化。",
        )?;
        hasher.update(&buffer[..read]);
        target.write_all(&buffer[..read]).map_err(output_error)?;
    }
    let after = checked_file(file, FILE_LIMIT)?;
    ensure(
        unchanged(&before, &after) && count == size && format!("{:x}", hasher.finalize()) == hash,
        "revision_conflict",
        "压缩期间载荷内容发生变化，请重新固定快照。",
    )
}

fn file_digest(file: &mut File) -> Result<Value> {
    let before = checked_file(file, BUNDLE_LIMIT)?;
    file.seek(SeekFrom::Start(0))?;
    let mut count = 0u64;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; BUFFER_SIZE];
    loop {
        let available = (before.len().saturating_sub(count) + 1).min(buffer.len() as u64) as usize;
        let read = file.read(&mut buffer[..available])?;
        if read == 0 {
            break;
        }
        count += read as u64;
        ensure(
            count <= before.len(),
            "revision_conflict",
            "计算摘要时交付包长度发生变化。",
        )?;
        hasher.update(&buffer[..read]);
    }
    ensure(
        count == before.len() && unchanged(&before, &checked_file(file, BUNDLE_LIMIT)?),
        "revision_conflict",
        "计算摘要时交付包发生变化。",
    )?;
    Ok(json!({"size_bytes":count,"sha256":format!("{:x}",hasher.finalize())}))
}

pub fn write_bundle(
    mut file: File,
    manifest: &Value,
    payloads: &mut [Payload],
) -> Result<(File, Value)> {
    let mut manifest_bytes = ManifestBuffer(Vec::new());
    serde_json::to_writer(&mut manifest_bytes, manifest)
        .map_err(|_| Error::new("hetu.budget_exceeded", "交付清单不能超过 16 MiB。"))?;
    let files = manifest_files(manifest)?;
    ensure(
        files.len() == payloads.len(),
        "hetu.integrity_failure",
        "清单与载荷数量不一致。",
    )?;
    let mut paths = std::collections::BTreeSet::new();
    for payload in &*payloads {
        ensure(
            paths.insert(&payload.path) && files.get(&payload.path) == Some(&payload.descriptor()),
            "hetu.integrity_failure",
            "载荷与清单描述不一致，或包含重复路径。",
        )?;
    }
    ensure(
        checked_file(&file, BUNDLE_LIMIT)?.len() == 0,
        "revision_conflict",
        "交付临时文件必须为空，不能覆盖已有内容。",
    )?;
    file.seek(SeekFrom::Start(0))?;
    let mut writer = ZipWriter::new(BundleFile { file, position: 0 });
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o600);
    writer
        .start_file("manifest.json", options)
        .map_err(zip_output_error)?;
    writer.write_all(&manifest_bytes.0).map_err(output_error)?;
    for payload in payloads {
        writer
            .start_file(&payload.path, options)
            .map_err(zip_output_error)?;
        match &mut payload.data {
            PayloadData::Bytes(bytes) => writer.write_all(bytes).map_err(output_error)?,
            PayloadData::File { file, size, sha256 } => {
                copy_payload(file, &mut writer, *size, sha256)?
            }
        }
    }
    let mut file = writer.finish().map_err(zip_output_error)?.file;
    file.sync_all()?;
    let length = checked_file(&file, BUNDLE_LIMIT)?.len();
    archive_budget(&mut file, length)?;
    let descriptor = file_digest(&mut file)?;
    Ok((file, descriptor))
}

fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(
        bytes[offset..offset + 2]
            .try_into()
            .expect("固定 ZIP 字段长度"),
    )
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("固定 ZIP 字段长度"),
    )
}

fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(
        bytes[offset..offset + 8]
            .try_into()
            .expect("固定 ZIP 字段长度"),
    )
}

fn read_at<const N: usize>(file: &mut File, position: u64) -> Result<[u8; N]> {
    file.seek(SeekFrom::Start(position))?;
    let mut bytes = [0; N];
    file.read_exact(&mut bytes)
        .map_err(|_| integrity("交付包 ZIP 尾记录不完整。"))?;
    Ok(bytes)
}

/// 先限制目录条目与元数据，再让 ZIP 库构造索引，避免恶意目录先耗尽内存。
fn archive_budget(file: &mut File, length: u64) -> Result<usize> {
    ensure(
        length >= 22,
        "hetu.integrity_failure",
        "交付包缺少 ZIP 尾记录。",
    )?;
    let tail_size = length.min(22 + u16::MAX as u64) as usize;
    file.seek(SeekFrom::Start(length - tail_size as u64))?;
    let mut tail = vec![0; tail_size];
    file.read_exact(&mut tail)
        .map_err(|_| integrity("交付包 ZIP 尾记录不完整。"))?;
    let position = tail
        .windows(4)
        .rposition(|bytes| bytes == b"PK\x05\x06")
        .ok_or_else(|| integrity("交付包缺少 ZIP 尾记录。"))?;
    ensure(
        position + 22 <= tail.len(),
        "hetu.integrity_failure",
        "交付包 ZIP 尾记录不完整。",
    )?;
    let end = &tail[position..];
    ensure(
        22 + usize::from(u16_at(end, 20)) == end.len()
            && u16_at(end, 4) == 0
            && u16_at(end, 6) == 0,
        "hetu.integrity_failure",
        "交付包不能包含分卷、尾部杂项或含糊的尾记录。",
    )?;
    let end_position = length - tail_size as u64 + position as u64;
    let mut count = u64::from(u16_at(end, 10));
    let mut directory_size = u64::from(u32_at(end, 12));
    let mut directory_start = u64::from(u32_at(end, 16));
    let mut directory_end = end_position;
    let locator = if end_position >= 20 {
        Some(read_at::<20>(file, end_position - 20)?)
    } else {
        None
    };
    let needs_zip64 =
        u16_at(end, 10) == u16::MAX || u32_at(end, 12) == u32::MAX || u32_at(end, 16) == u32::MAX;
    let has_zip64 = needs_zip64
        && locator
            .as_ref()
            .is_some_and(|value| &value[..4] == b"PK\x06\x07");
    if has_zip64 {
        let locator = locator.expect("已检查 ZIP64 定位记录");
        ensure(
            u32_at(&locator, 4) == 0 && u32_at(&locator, 16) == 1,
            "hetu.integrity_failure",
            "交付包不能使用多分卷 ZIP64。",
        )?;
        let offset = u64_at(&locator, 8);
        ensure(
            offset <= end_position.saturating_sub(76),
            "hetu.integrity_failure",
            "ZIP64 尾记录偏移无效。",
        )?;
        let record = read_at::<56>(file, offset)?;
        let record_size = u64_at(&record, 4);
        ensure(
            &record[..4] == b"PK\x06\x06"
                && record_size >= 44
                && record_size <= DIRECTORY_LIMIT
                && offset
                    .checked_add(12)
                    .and_then(|value| value.checked_add(record_size))
                    == Some(end_position - 20)
                && u32_at(&record, 16) == 0
                && u32_at(&record, 20) == 0
                && u64_at(&record, 24) == u64_at(&record, 32),
            "hetu.integrity_failure",
            "ZIP64 尾记录损坏或未与中央目录对齐。",
        )?;
        count = u64_at(&record, 32);
        directory_size = u64_at(&record, 40);
        directory_start = u64_at(&record, 48);
        directory_end = offset;
        ensure(
            (u16_at(end, 10) == u16::MAX || u64::from(u16_at(end, 10)) == count)
                && (u16_at(end, 8) == u16::MAX || u64::from(u16_at(end, 8)) == count)
                && (u32_at(end, 12) == u32::MAX || u64::from(u32_at(end, 12)) == directory_size)
                && (u32_at(end, 16) == u32::MAX || u64::from(u32_at(end, 16)) == directory_start),
            "hetu.integrity_failure",
            "ZIP 与 ZIP64 尾记录不一致。",
        )?;
    } else {
        ensure(
            u16_at(end, 8) == u16_at(end, 10)
                && u16_at(end, 10) != u16::MAX
                && u32_at(end, 12) != u32::MAX
                && u32_at(end, 16) != u32::MAX,
            "hetu.integrity_failure",
            "ZIP 尾记录不一致或缺少 ZIP64 信息。",
        )?;
    }
    ensure(
        count <= ENTRY_LIMIT as u64 && directory_size <= DIRECTORY_LIMIT,
        "hetu.budget_exceeded",
        "交付包目录超过 10000 条目或 16 MiB 元数据预算。",
    )?;
    ensure(
        count > 0
            && directory_size >= count * 46
            && directory_start.checked_add(directory_size) == Some(directory_end),
        "hetu.integrity_failure",
        "交付包中央目录为空、越界或未与尾记录对齐。",
    )?;
    // 已确认的尾记录必须能直接命中目录，禁止 ZIP 库回退到包内其他伪造尾记录。
    ensure(
        read_at::<4>(file, directory_start)? == *b"PK\x01\x02",
        "hetu.integrity_failure",
        "交付包中央目录签名无效。",
    )?;
    Ok(count as usize)
}

pub fn verify_bundle(file: &mut File) -> Result<Value> {
    let before = checked_file(file, BUNDLE_LIMIT)?;
    let count = archive_budget(file, before.len())?;
    file.seek(SeekFrom::Start(0))?;
    let config = zip::read::Config {
        archive_offset: zip::read::ArchiveOffset::Known(0),
    };
    let mut archive = ZipArchive::with_config(config, &mut *file).map_err(zip_error)?;
    ensure(
        !archive.has_duplicate_names() && archive.len() == count,
        "hetu.integrity_failure",
        "交付包包含重复或未正确登记的条目。",
    )?;
    let mut manifest_index = None;
    let mut paths = BTreeMap::new();
    let mut declared_total = 0u64;
    for index in 0..archive.len() {
        let entry = archive.by_index_data(index).map_err(zip_error)?;
        let path = std::str::from_utf8(entry.name_raw())
            .map_err(|_| integrity("交付包路径必须使用 UTF-8。"))?;
        checked_path(path)?;
        ensure(
            entry.name().map_err(zip_error)?.as_ref() == path
                && !entry.encrypted()
                && entry.is_file()
                && entry.unix_mode().is_none_or(|mode| {
                    let kind = mode & 0o170000;
                    kind == 0 || kind == 0o100000
                })
                && matches!(
                    entry.compression(),
                    CompressionMethod::Stored | CompressionMethod::Deflated
                ),
            "hetu.integrity_failure",
            "交付包只接受未加密的普通文件，不能包含链接、设备或含糊路径。",
        )?;
        let limit = if path == "manifest.json" {
            manifest_index = Some(index);
            MANIFEST_LIMIT
        } else {
            declared_total = declared_total
                .checked_add(entry.size())
                .ok_or_else(|| Error::new("hetu.budget_exceeded", "载荷总长度溢出。"))?;
            FILE_LIMIT
        };
        ensure(
            entry.size() <= limit && declared_total <= BUNDLE_LIMIT,
            "hetu.budget_exceeded",
            "交付包清单、单文件或载荷总量超过预算。",
        )?;
        ensure(
            paths
                .insert(path.to_owned(), (index, entry.size()))
                .is_none(),
            "hetu.integrity_failure",
            "交付包包含重复路径。",
        )?;
    }
    archive.validate_header_consistency().map_err(zip_error)?;
    let manifest_index = manifest_index.ok_or_else(|| integrity("交付包缺少 manifest.json。"))?;
    let mut bytes = Vec::new();
    {
        let entry = archive.by_index(manifest_index).map_err(zip_error)?;
        let expected_size = entry.size();
        entry
            .take(MANIFEST_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| integrity("交付清单无法完整解压或 CRC 校验失败。"))?;
        ensure(
            bytes.len() as u64 <= MANIFEST_LIMIT,
            "hetu.budget_exceeded",
            "交付清单超过 16 MiB。",
        )?;
        ensure(
            bytes.len() as u64 == expected_size,
            "hetu.integrity_failure",
            "交付清单长度与 ZIP 声明不一致。",
        )?;
    }
    let manifest: Value =
        serde_json::from_slice(&bytes).map_err(|_| integrity("交付清单不是有效 JSON。"))?;
    let files = manifest_files(&manifest)?;
    ensure(
        files.len() + 1 == paths.len(),
        "hetu.integrity_failure",
        "交付包存在未列出的文件或缺失文件。",
    )?;
    let mut buffer = vec![0; BUFFER_SIZE];
    for (path, descriptor) in &files {
        let (index, actual_size) = paths
            .get(path)
            .ok_or_else(|| integrity("清单中的载荷文件缺失。"))?;
        let expected_size = descriptor["size_bytes"].as_u64().expect("已检查清单长度");
        ensure(
            *actual_size == expected_size,
            "hetu.integrity_failure",
            "载荷长度与清单不同。",
        )?;
        let mut entry = archive.by_index(*index).map_err(zip_error)?;
        let mut hasher = Sha256::new();
        let mut size = 0u64;
        loop {
            let available =
                (expected_size.saturating_sub(size) + 1).min(buffer.len() as u64) as usize;
            let read = entry
                .read(&mut buffer[..available])
                .map_err(|_| integrity("载荷无法完整解压或 CRC 校验失败。"))?;
            if read == 0 {
                break;
            }
            size += read as u64;
            ensure(
                size <= expected_size,
                "hetu.integrity_failure",
                "载荷解压长度超过清单，可能存在 ZIP 炸弹。",
            )?;
            hasher.update(&buffer[..read]);
        }
        ensure(
            size == expected_size && descriptor["sha256"] == format!("{:x}", hasher.finalize()),
            "hetu.integrity_failure",
            "载荷长度或 SHA-256 摘要与清单不同。",
        )?;
    }
    drop(archive);
    let descriptor = file_digest(file)?;
    ensure(
        unchanged(&before, &checked_file(file, BUNDLE_LIMIT)?),
        "revision_conflict",
        "校验期间交付包发生变化。",
    )?;
    Ok(json!({"manifest":manifest,"files_verified":files.len(),
        "size_bytes":descriptor["size_bytes"],"sha256":descriptor["sha256"],"verified":true}))
}

impl Store {
    pub fn lock_delivery(&self, delivery_id: &str) -> Result<DeliveryLock> {
        checked_id(delivery_id, "delivery")?;
        let path = format!(".hetu/deliveries/{delivery_id}/export.lock");
        let (parent, leaf) = self.parent(&path, true)?;
        let file = File::from(fs::openat(
            &parent,
            leaf,
            OFlags::RDWR | OFlags::CREATE | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
            Mode::from_raw_mode(0o600),
        )?);
        checked_file(&file, 0)?;
        fs::flock(&file, FlockOperation::NonBlockingLockExclusive).map_err(|error| {
            if error == rustix::io::Errno::WOULDBLOCK {
                Error::new("result_unknown", "原交付操作仍在执行，请保留原键检查进度。")
            } else {
                error.into()
            }
        })?;
        fs::fsync(&parent)?;
        Ok(DeliveryLock { file })
    }

    pub fn create_export_file(&self, path: &str) -> Result<File> {
        let (parent, leaf) = self.parent(path, true)?;
        let file = File::from(fs::openat(
            &parent,
            leaf,
            OFlags::RDWR | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::from_raw_mode(0o600),
        )?);
        checked_file(&file, BUNDLE_LIMIT)?;
        fs::fsync(&parent)?;
        Ok(file)
    }

    pub fn open_export_file(&self, path: &str) -> Result<File> {
        let (parent, leaf) = self.parent(path, false)?;
        let file = File::from(fs::openat(
            &parent,
            leaf,
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
            Mode::empty(),
        )?);
        checked_file(&file, BUNDLE_LIMIT)?;
        Ok(file)
    }

    pub fn publish_export_file(&self, staging: &str, destination: &str) -> Result<()> {
        checked_staging_path(staging)?;
        ensure(
            staging != destination,
            "hetu.unsafe_path",
            "临时文件与发布目标不能相同。",
        )?;
        let file = self.open_export_file(staging)?;
        let before = checked_file(&file, BUNDLE_LIMIT)?;
        file.sync_all()?;
        let (source_parent, source_leaf) = self.parent(staging, false)?;
        let (target_parent, target_leaf) = self.parent(destination, true)?;
        check_path_inode(&source_parent, &source_leaf, &before, 1)?;
        ensure(
            unchanged(&before, &checked_file(&file, BUNDLE_LIMIT)?),
            "revision_conflict",
            "发布前交付内容发生变化。",
        )?;
        fs::linkat(
            &source_parent,
            &source_leaf,
            &target_parent,
            &target_leaf,
            AtFlags::empty(),
        )
        .map_err(|error| {
            if error == rustix::io::Errno::EXIST {
                Error::new("revision_conflict", "交付目标已存在，不能覆盖。")
            } else {
                error.into()
            }
        })?;
        let finish = (|| -> Result<()> {
            for (parent, leaf) in [
                (&source_parent, &source_leaf),
                (&target_parent, &target_leaf),
            ] {
                check_path_inode(parent, leaf, &before, 2)?;
            }
            // 先保住正式目录项，再移除临时入口，断电后仍可沿原键恢复。
            fs::fsync(&target_parent)?;
            fs::unlinkat(&source_parent, &source_leaf, AtFlags::empty())?;
            fs::fsync(&target_parent)?;
            fs::fsync(&source_parent)?;
            Ok(())
        })();
        finish.map_err(|_| {
            Error::new(
                "result_unknown",
                "交付目标可能已发布，请沿原操作检查并恢复，勿改键重发。",
            )
        })
    }

    /// 调用方持有对应交付锁；这里只恢复发布的链接步骤，不替代包内容与业务快照核验。
    pub fn recover_export_publication(&self, staging: &str, destination: &str) -> Result<bool> {
        checked_staging_path(staging)?;
        ensure(
            staging != destination,
            "hetu.unsafe_path",
            "临时文件与发布目标不能相同。",
        )?;
        let (target_parent, target_leaf) = self.parent(destination, true)?;
        let target = match fs::statat(&target_parent, &target_leaf, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(target) => target,
            Err(rustix::io::Errno::NOENT) => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        if target.st_nlink == 1 {
            self.open_export_file(destination)?;
            return Ok(true);
        }
        ensure(
            target.st_nlink == 2,
            "hetu.unsafe_path",
            "发布文件含有未获准的硬链接。",
        )?;
        let (source_parent, source_leaf) = self.parent(staging, false)?;
        let mut files = Vec::new();
        for (parent, leaf) in [
            (&source_parent, &source_leaf),
            (&target_parent, &target_leaf),
        ] {
            let file = File::from(fs::openat(
                parent,
                leaf,
                OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
                Mode::empty(),
            )?);
            checked_file_with_links(&file, BUNDLE_LIMIT, 2)?;
            files.push(file);
        }
        let before = checked_file_with_links(&files[0], BUNDLE_LIMIT, 2)?;
        ensure(
            same_file(
                &before,
                &checked_file_with_links(&files[1], BUNDLE_LIMIT, 2)?,
            ),
            "hetu.unsafe_path",
            "发布恢复只允许同一文件的临时与正式两条路径。",
        )?;
        check_path_inode(&source_parent, &source_leaf, &before, 2)?;
        check_path_inode(&target_parent, &target_leaf, &before, 2)?;
        fs::fsync(&target_parent)?;
        fs::unlinkat(&source_parent, &source_leaf, AtFlags::empty())?;
        let finish = (|| -> Result<()> {
            fs::fsync(&target_parent)?;
            fs::fsync(&source_parent)?;
            checked_file(&files[1], BUNDLE_LIMIT)?;
            Ok(())
        })();
        finish.map_err(|_| {
            Error::new(
                "result_unknown",
                "发布恢复结果尚未确认，请沿原交付操作继续检查。",
            )
        })?;
        Ok(true)
    }

    pub fn discard_export_staging(&self, path: &str) -> Result<()> {
        checked_staging_path(path)?;
        let (parent, leaf) = self.parent(path, false)?;
        let file = match fs::openat(
            &parent,
            &leaf,
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
            Mode::empty(),
        ) {
            Ok(file) => File::from(file),
            Err(rustix::io::Errno::NOENT) => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        let before = checked_file(&file, BUNDLE_LIMIT)?;
        check_path_inode(&parent, &leaf, &before, 1)?;
        fs::unlinkat(&parent, &leaf, AtFlags::empty())?;
        fs::fsync(&parent)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::OpenOptions;
    use tempfile::TempDir;

    fn output() -> (TempDir, File) {
        let root = tempfile::tempdir().unwrap();
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(root.path().join("bundle.zip"))
            .unwrap();
        (root, file)
    }

    fn payload(path: &str, bytes: &[u8]) -> Payload {
        Payload {
            path: path.into(),
            media_type: "text/plain".into(),
            source: json!({"kind":"test"}),
            data: PayloadData::Bytes(bytes.into()),
        }
    }

    fn manifest(payloads: &[Payload]) -> Value {
        json!({"spec_version":"0.2.1","files":payloads.iter().map(Payload::descriptor).collect::<Vec<_>>()})
    }

    fn raw_bundle(manifest: &Value, entries: &[(&str, &[u8])]) -> (TempDir, File) {
        let (root, file) = output();
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .unix_permissions(0o600);
        writer.start_file("manifest.json", options).unwrap();
        writer
            .write_all(&serde_json::to_vec(manifest).unwrap())
            .unwrap();
        for (name, content) in entries {
            writer.start_file(name, options).unwrap();
            writer.write_all(content).unwrap();
        }
        (root, writer.finish().unwrap())
    }

    fn staging() -> String {
        format!(
            ".hetu/deliveries/{}/artifact.tmp",
            crate::domain::id("delivery")
        )
    }

    #[test]
    fn round_trip_streams_fixed_file_and_memory_payloads() {
        let (_source_root, mut source) = output();
        let content = vec![b'a'; BUFFER_SIZE * 3 + 17];
        source.write_all(&content).unwrap();
        let mut payloads = vec![
            payload("novel.txt", "测试正文".as_bytes()),
            Payload {
                path: "media/original.bin".into(),
                media_type: "application/octet-stream".into(),
                source: json!({"kind":"fixed-file"}),
                data: PayloadData::File {
                    file: source,
                    size: content.len() as u64,
                    sha256: digest(&content),
                },
            },
        ];
        let manifest = manifest(&payloads);
        let (_root, file) = output();
        let (mut file, descriptor) = write_bundle(file, &manifest, &mut payloads).unwrap();
        let verified = verify_bundle(&mut file).unwrap();
        assert_eq!(verified["manifest"], manifest);
        assert_eq!(verified["files_verified"], 2);
        assert_eq!(verified["size_bytes"], descriptor["size_bytes"]);
        assert_eq!(verified["sha256"], descriptor["sha256"]);
        assert_eq!(verified["verified"], true);
    }

    #[test]
    fn changed_file_and_mismatched_manifest_are_rejected() {
        let (_source_root, mut source) = output();
        source.write_all(b"changed").unwrap();
        let mut payloads = vec![Payload {
            path: "novel.txt".into(),
            media_type: "text/plain".into(),
            source: json!({}),
            data: PayloadData::File {
                file: source,
                size: 7,
                sha256: digest(b"initial"),
            },
        }];
        let manifest = manifest(&payloads);
        let (_root, file) = output();
        assert_eq!(
            write_bundle(file, &manifest, &mut payloads)
                .unwrap_err()
                .code,
            "revision_conflict"
        );
        let (_root, file) = output();
        payloads[0].path = "different.txt".into();
        assert_eq!(
            write_bundle(file, &manifest, &mut payloads)
                .unwrap_err()
                .code,
            "hetu.integrity_failure"
        );
    }

    #[test]
    fn sha_length_missing_and_unlisted_payloads_are_rejected() {
        let payloads = vec![payload("novel.txt", b"original")];
        let manifest = manifest(&payloads);
        for entries in [
            vec![("novel.txt", b"modified".as_slice())],
            vec![("novel.txt", b"short".as_slice())],
            vec![],
            vec![
                ("novel.txt", b"original".as_slice()),
                ("unlisted.txt", b"extra".as_slice()),
            ],
        ] {
            let (_root, mut file) = raw_bundle(&manifest, &entries);
            assert_eq!(
                verify_bundle(&mut file).unwrap_err().code,
                "hetu.integrity_failure"
            );
        }
    }

    #[test]
    fn unsafe_and_conflicting_payload_paths_are_rejected() {
        for path in [
            "/absolute.txt",
            "../outside.txt",
            "a/../b",
            "a/./b",
            "a//b",
            "a\\b",
            "C:/b",
            "C:b",
            "manifest.json",
            "manifest.json/b",
        ] {
            let payloads = vec![payload(path, b"x")];
            assert!(manifest_files(&manifest(&payloads)).is_err(), "{path}");
        }
        let payloads = vec![
            payload("a", b"x"),
            payload("a-b", b"x"),
            payload("a/b", b"x"),
        ];
        assert!(manifest_files(&manifest(&payloads)).is_err());
        let payloads = vec![payload("a", b"x"), payload("a", b"x")];
        assert!(manifest_files(&manifest(&payloads)).is_err());
        let (_root, mut file) = raw_bundle(&json!({"files":[]}), &[("../outside.txt", b"x")]);
        assert_eq!(
            verify_bundle(&mut file).unwrap_err().code,
            "hetu.unsafe_path"
        );
    }

    #[test]
    fn duplicate_entries_and_local_header_tampering_are_rejected() {
        let payloads = vec![payload("data/a", b"a"), payload("data/b", b"b")];
        let (_root, mut file) =
            raw_bundle(&manifest(&payloads), &[("data/a", b"a"), ("data/b", b"b")]);
        file.seek(SeekFrom::Start(0)).unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        for offset in 0..bytes.len().saturating_sub(5) {
            if &bytes[offset..offset + 6] == b"data/b" {
                bytes[offset + 5] = b'a';
            }
        }
        file.seek(SeekFrom::Start(0)).unwrap();
        file.write_all(&bytes).unwrap();
        assert_eq!(
            verify_bundle(&mut file).unwrap_err().code,
            "hetu.integrity_failure"
        );

        let payloads = vec![payload("novel.txt", b"body")];
        let (_root, mut file) = raw_bundle(&manifest(&payloads), &[("novel.txt", b"body")]);
        // 仅修改局部文件头名称，保留中央目录，严格一致性检查应拒绝。
        let mut archive = ZipArchive::new(&mut file).unwrap();
        let position = archive.by_name("novel.txt").unwrap().header_start() + 30;
        drop(archive);
        file.seek(SeekFrom::Start(position)).unwrap();
        file.write_all(b"N").unwrap();
        assert_eq!(
            verify_bundle(&mut file).unwrap_err().code,
            "hetu.integrity_failure"
        );
    }

    #[test]
    fn special_zip_entries_are_rejected() {
        for mode in [0o120600u32, 0o010600u32, 0o040600u32] {
            let (_root, file) = output();
            let mut writer = ZipWriter::new(file);
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            writer.start_file("manifest.json", options).unwrap();
            writer.write_all(b"{\"files\":[]}").unwrap();
            writer
                .start_file("special", options.external_attributes(mode << 16))
                .unwrap();
            writer.write_all(b"x").unwrap();
            let mut file = writer.finish().unwrap();
            assert_eq!(
                verify_bundle(&mut file).unwrap_err().code,
                "hetu.integrity_failure"
            );
        }
    }

    #[test]
    fn overlapping_and_unregistered_local_entries_are_rejected() {
        let payloads = vec![payload("a", b"body"), payload("b", b"body")];
        let (_root, file) = output();
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        writer.start_file("manifest.json", options).unwrap();
        writer
            .write_all(&serde_json::to_vec(&manifest(&payloads)).unwrap())
            .unwrap();
        writer.start_file("a", options).unwrap();
        writer.write_all(b"body").unwrap();
        writer.shallow_copy_file("a", "b").unwrap();
        let mut file = writer.finish().unwrap();
        assert_eq!(
            verify_bundle(&mut file).unwrap_err().code,
            "hetu.integrity_failure"
        );

        let payloads = vec![payload("a", b"body")];
        let (_root, mut file) = raw_bundle(
            &manifest(&payloads),
            &[("a", b"body"), ("hidden", b"extra")],
        );
        let mut archive = ZipArchive::new(&mut file).unwrap();
        let header = archive.by_name("hidden").unwrap().central_header_start() as usize;
        drop(archive);
        file.seek(SeekFrom::Start(0)).unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        let record_size = 46
            + usize::from(u16_at(&bytes, header + 28))
            + usize::from(u16_at(&bytes, header + 30))
            + usize::from(u16_at(&bytes, header + 32));
        bytes.drain(header..header + record_size);
        let end = bytes.len() - 22;
        let directory_size = u32_at(&bytes, end + 12) - record_size as u32;
        bytes[end + 8..end + 10].copy_from_slice(&2u16.to_le_bytes());
        bytes[end + 10..end + 12].copy_from_slice(&2u16.to_le_bytes());
        bytes[end + 12..end + 16].copy_from_slice(&directory_size.to_le_bytes());
        file.set_len(bytes.len() as u64).unwrap();
        file.seek(SeekFrom::Start(0)).unwrap();
        file.write_all(&bytes).unwrap();
        assert_eq!(
            verify_bundle(&mut file).unwrap_err().code,
            "hetu.integrity_failure"
        );
    }

    #[test]
    fn payload_manifest_directory_and_archive_budgets_are_enforced() {
        let mut manifest = manifest(&[payload("a", b"x")]);
        manifest["files"][0]["size_bytes"] = json!(FILE_LIMIT + 1);
        assert_eq!(
            manifest_files(&manifest).unwrap_err().code,
            "hetu.budget_exceeded"
        );
        let mut manifest = manifest.clone();
        manifest["files"][0]["size_bytes"] = json!(FILE_LIMIT);
        let mut second = manifest["files"][0].clone();
        second["path"] = json!("b");
        let mut third = second.clone();
        third["path"] = json!("c");
        manifest["files"]
            .as_array_mut()
            .unwrap()
            .extend([second, third]);
        assert_eq!(
            manifest_files(&manifest).unwrap_err().code,
            "hetu.budget_exceeded"
        );

        let (_root, mut file) = output();
        file.set_len(BUNDLE_LIMIT + 1).unwrap();
        assert_eq!(
            verify_bundle(&mut file).unwrap_err().code,
            "hetu.budget_exceeded"
        );
        let (_root, mut file) = output();
        let mut end = [0u8; 22];
        end[..4].copy_from_slice(b"PK\x05\x06");
        end[8..10].copy_from_slice(&10_001u16.to_le_bytes());
        end[10..12].copy_from_slice(&10_001u16.to_le_bytes());
        file.write_all(&end).unwrap();
        assert_eq!(
            verify_bundle(&mut file).unwrap_err().code,
            "hetu.budget_exceeded"
        );

        let (_root, file) = output();
        let manifest = json!({"files":[],"oversized":"x".repeat(MANIFEST_LIMIT as usize)});
        assert_eq!(
            write_bundle(file, &manifest, &mut []).unwrap_err().code,
            "hetu.budget_exceeded"
        );
        let mut bounded = ManifestBuffer(Vec::new());
        bounded.0.resize(MANIFEST_LIMIT as usize, 0);
        assert_eq!(
            bounded.write(b"x").unwrap_err().kind(),
            io::ErrorKind::FileTooLarge
        );
    }

    #[test]
    fn publish_is_exclusive_and_staging_cleanup_is_narrow() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path()).unwrap();
        let first = staging();
        store
            .create_export_file(&first)
            .unwrap()
            .write_all(b"first")
            .unwrap();
        store
            .publish_export_file(&first, "exports/final.zip")
            .unwrap();
        assert!(!store.exists(&first).unwrap());
        assert_eq!(store.read("exports/final.zip").unwrap(), b"first");
        let second = staging();
        store
            .create_export_file(&second)
            .unwrap()
            .write_all(b"second")
            .unwrap();
        assert_eq!(
            store
                .publish_export_file(&second, "exports/final.zip")
                .unwrap_err()
                .code,
            "revision_conflict"
        );
        assert_eq!(store.read("exports/final.zip").unwrap(), b"first");
        assert!(store.discard_export_staging("exports/final.zip").is_err());
        assert!(
            store
                .discard_export_staging(".hetu/deliveries/not-an-id/artifact.tmp")
                .is_err()
        );
        store.discard_export_staging(&second).unwrap();
        store.discard_export_staging(&second).unwrap();
        assert!(!store.exists(&second).unwrap());
        assert_eq!(store.read("exports/final.zip").unwrap(), b"first");
    }

    #[test]
    fn delivery_lease_prevents_same_operation_concurrency() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path()).unwrap();
        let delivery = crate::domain::id("delivery");
        let lease = store.lock_delivery(&delivery).unwrap();
        assert!(
            matches!(store.lock_delivery(&delivery), Err(error) if error.code == "result_unknown")
        );
        store.lock_delivery(&crate::domain::id("delivery")).unwrap();
        drop(lease);
        store.lock_delivery(&delivery).unwrap();
        assert!(store.lock_delivery("../escape").is_err());
    }

    #[test]
    fn interrupted_link_publication_resumes_only_the_exact_two_links() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path()).unwrap();
        let staging = staging();
        store
            .create_export_file(&staging)
            .unwrap()
            .write_all(b"published")
            .unwrap();
        store.directory("exports").unwrap();
        std::fs::hard_link(
            root.path().join(&staging),
            root.path().join("exports/final.zip"),
        )
        .unwrap();
        assert!(store.open_export_file("exports/final.zip").is_err());
        assert!(store.discard_export_staging(&staging).is_err());
        assert!(
            store
                .recover_export_publication(&staging, "exports/final.zip")
                .unwrap()
        );
        assert_eq!(store.read("exports/final.zip").unwrap(), b"published");
        assert!(!store.exists(&staging).unwrap());
        assert!(
            store
                .recover_export_publication(&staging, "exports/final.zip")
                .unwrap()
        );
        assert!(
            !store
                .recover_export_publication(&staging, "exports/absent.zip")
                .unwrap()
        );
        let other = root.path().join("exports/unapproved.zip");
        std::fs::hard_link(root.path().join("exports/final.zip"), other).unwrap();
        assert!(
            store
                .recover_export_publication(&staging, "exports/final.zip")
                .is_err()
        );
    }

    #[test]
    fn store_export_access_rejects_symlinks_and_hardlinks() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path()).unwrap();
        let staging = staging();
        store.create_export_file(&staging).unwrap();
        let linked = staging.replace("artifact.tmp", "other.tmp");
        std::fs::hard_link(root.path().join(&staging), root.path().join(&linked)).unwrap();
        assert!(store.open_export_file(&staging).is_err());
        assert!(store.discard_export_staging(&staging).is_err());
        let symbolic = staging.replace("artifact.tmp", "symbolic.tmp");
        std::os::unix::fs::symlink(root.path().join(&staging), root.path().join(&symbolic))
            .unwrap();
        assert!(store.open_export_file(&symbolic).is_err());
        assert!(store.create_export_file(&symbolic).is_err());
    }
}
