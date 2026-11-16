use crate::domain::{Error, Result, ensure, id};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    fs::{File, Metadata},
    io::{Read, Seek, SeekFrom},
    time::SystemTime,
};

pub const MEDIA_CHUNK_LIMIT: u64 = 512 * 1024;

#[derive(PartialEq)]
struct Stamp {
    size: u64,
    modified: SystemTime,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64, u64, u32),
}
impl Stamp {
    fn of(metadata: Metadata) -> Result<Self> {
        ensure(
            metadata.is_file(),
            "hetu.unsafe_path",
            "媒体不再是普通文件。",
        )?;
        Ok(Self {
            size: metadata.len(),
            modified: metadata.modified()?,
            #[cfg(unix)]
            identity: {
                use std::os::unix::fs::MetadataExt;
                (
                    metadata.dev(),
                    metadata.ino(),
                    metadata.ctime(),
                    metadata.ctime_nsec(),
                    metadata.nlink(),
                    metadata.mode(),
                )
            },
        })
    }
}

/// 完整摘要核验后的只读媒体。句柄不离开可信宿主；分块始终读取同一个文件。
pub struct AssetMedia {
    file: File,
    stamp: Stamp,
    metadata: Value,
}
impl AssetMedia {
    pub(crate) fn open(mut file: File, expected: &Value, asset_ref: Value) -> Result<Self> {
        let stamp = Stamp::of(file.metadata()?)?;
        let actual = super::media::scan(&mut file, None)?;
        ensure(
            actual["sha256"] == expected["sha256"]
                && actual["size_bytes"] == expected["size_bytes"]
                && actual["media_type"] == expected["media_type"]
                && stamp == Stamp::of(file.metadata()?)?,
            "hetu.integrity_failure",
            "媒体原字节与固定素材不一致。",
        )?;
        if actual["media_type"]
            .as_str()
            .is_some_and(|kind| kind.starts_with("image/"))
        {
            ensure(
                stamp.size <= 32 * 1024 * 1024,
                "hetu.budget_exceeded",
                "图片预览不能超过32MiB。",
            )?;
            file.seek(SeekFrom::Start(0))?;
            let (width, height) = if actual["media_type"] == "image/gif" {
                let mut header = [0; 10];
                file.read_exact(&mut header)?;
                (
                    u32::from(u16::from_le_bytes([header[6], header[7]])),
                    u32::from(u16::from_le_bytes([header[8], header[9]])),
                )
            } else {
                image::ImageReader::new(std::io::BufReader::new(&mut file))
                    .with_guessed_format()?
                    .into_dimensions()
                    .map_err(|_| Error::new("hetu.unsupported_media", "图片尺寸头无效。"))?
            };
            ensure(
                (1..=8192).contains(&width)
                    && (1..=8192).contains(&height)
                    && u64::from(width) * u64::from(height) <= 64_000_000,
                "hetu.budget_exceeded",
                "图片预览宽高须为1～8192，总像素不超过6400万。",
            )?;
            if actual["media_type"] != "image/gif" {
                file.seek(SeekFrom::Start(0))?;
                let mut reader = image::ImageReader::new(std::io::BufReader::new(&mut file))
                    .with_guessed_format()?;
                let mut limits = image::Limits::default();
                limits.max_image_width = Some(8192);
                limits.max_image_height = Some(8192);
                limits.max_alloc = Some(512 * 1024 * 1024);
                reader.limits(limits);
                reader
                    .decode()
                    .map_err(|_| Error::new("hetu.unsupported_media", "图片像素无法完整解码。"))?;
            }
            ensure(
                stamp == Stamp::of(file.metadata()?)?,
                "hetu.integrity_failure",
                "图片读取期间发生变化。",
            )?;
        }
        let metadata = json!({"token":id("media"),"asset_ref":asset_ref,
            "media_type":actual["media_type"],"size_bytes":actual["size_bytes"]});
        Ok(Self {
            file,
            stamp,
            metadata,
        })
    }
    pub fn metadata(&self) -> &Value {
        &self.metadata
    }

    pub fn read(&mut self, offset: u64, length: u64) -> Result<Value> {
        ensure(
            length > 0 && length <= MEDIA_CHUNK_LIMIT && offset < self.stamp.size,
            "invalid_range",
            "媒体读取范围无效或超过512KiB。",
        )?;
        self.unchanged()?;
        let length = length.min(self.stamp.size - offset) as usize;
        self.file.seek(SeekFrom::Start(offset))?;
        let mut bytes = vec![0; length];
        self.file.read_exact(&mut bytes)?;
        self.unchanged()?;
        Ok(json!({"base64":STANDARD.encode(bytes),"offset":offset,"size_bytes":length}))
    }
    fn unchanged(&self) -> Result<()> {
        if self.stamp != Stamp::of(self.file.metadata()?)? {
            return Err(Error::new(
                "hetu.integrity_failure",
                "媒体读取期间文件发生变化，请重新核对。",
            ));
        }
        Ok(())
    }
}
