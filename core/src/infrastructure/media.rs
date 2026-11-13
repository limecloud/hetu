use super::store::Store;
use crate::domain::{Result, digest, ensure, id, media};
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

pub struct VerifiedImage {
    pub scan: Value,
    pub decoded: image::DynamicImage,
}

/// 封面与图片候选共用同一解码限额；文件签名本身不足以接受图片。
pub fn decode_image(file: &mut File) -> Result<VerifiedImage> {
    const LIMIT: u64 = 32 * 1024 * 1024;
    let scan = scan(file, None)?;
    ensure(
        scan["size_bytes"]
            .as_u64()
            .is_some_and(|size| size <= LIMIT),
        "hetu.budget_exceeded",
        "图片不能超过 32 MiB。",
    )?;
    let format = match scan["media_type"].as_str() {
        Some("image/png") => image::ImageFormat::Png,
        Some("image/jpeg") => image::ImageFormat::Jpeg,
        Some("image/webp") => image::ImageFormat::WebP,
        _ => {
            return Err(crate::domain::Error::new(
                "hetu.unsupported_media",
                "封面只支持 PNG、JPEG 和 WebP。",
            ));
        }
    };
    file.seek(SeekFrom::Start(0))?;
    let mut raw = Vec::new();
    (&mut *file).take(LIMIT + 1).read_to_end(&mut raw)?;
    ensure(
        raw.len() as u64 <= LIMIT && scan["sha256"] == digest(&raw),
        "revision_conflict",
        "图片读取期间发生变化。",
    )?;
    let (width, height) = image::ImageReader::with_format(std::io::Cursor::new(&raw), format)
        .into_dimensions()
        .map_err(|_| crate::domain::Error::new("hetu.unsupported_media", "图片头部或尺寸无效。"))?;
    ensure(
        (64..=8192).contains(&width)
            && (64..=8192).contains(&height)
            && u64::from(width) * u64::from(height) <= 64_000_000,
        "hetu.budget_exceeded",
        "图片宽高须为 64～8192，像素总量不超过 6400 万。",
    )?;
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(&raw), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|_| crate::domain::Error::new("hetu.unsupported_media", "图片无法完整解码。"))?;
    Ok(VerifiedImage { scan, decoded })
}

pub fn image_preview(source: &image::DynamicImage) -> Result<Value> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let rgba = source
        .thumbnail(source.width().min(512), source.height().min(512))
        .to_rgba8();
    let image = image::RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let pixel = rgba.get_pixel(x, y);
        let alpha = u32::from(pixel[3]);
        image::Rgb([0, 1, 2].map(|channel| {
            ((u32::from(pixel[channel]) * alpha + 255 * (255 - alpha) + 127) / 255) as u8
        }))
    });
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 75)
        .encode_image(&image)
        .map_err(|_| crate::domain::Error::new("hetu.unsupported_media", "无法生成封面预览。"))?;
    ensure(
        bytes.len() <= 256 * 1024,
        "hetu.budget_exceeded",
        "封面预览超出传输预算。",
    )?;
    Ok(
        json!({"media_type":"image/jpeg","base64":STANDARD.encode(bytes),"width":image.width(),"height":image.height()}),
    )
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
