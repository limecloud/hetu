use super::{Result, ensure};
use serde_json::{Value, json};
use std::sync::OnceLock;

pub const FILE_LIMIT: u64 = 2 * 1024 * 1024 * 1024;

pub fn definition(name: &str) -> Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    let schema = SCHEMA.get_or_init(|| {
        serde_json::from_str(include_str!("../../../contracts/schemas/media.schema.json"))
            .expect("embedded media schema")
    });
    let mut result = schema["$defs"][name].clone();
    assert!(result.is_object(), "registered media schema definition");
    result["$schema"] = schema["$schema"].clone();
    result["$defs"] = schema["$defs"].clone();
    result
}

pub fn package(kind: &str) -> &'static str {
    if kind == "music" {
        "music-cue"
    } else {
        "visual-prompt"
    }
}

pub fn validate_metadata(value: &Value) -> Result<()> {
    ensure(
        !value["title"].as_str().unwrap_or("").trim().is_empty(),
        "invalid_input",
        "请填写素材或线索名称。",
    )?;
    if value.get("rights_status").is_some() {
        ensure(
            value["redistribution_allowed"] != true
                || (matches!(
                    value["rights_status"].as_str(),
                    Some("author_owned" | "licensed")
                ) && !value["rights_statement"]
                    .as_str()
                    .unwrap_or("")
                    .trim()
                    .is_empty()),
            "hetu.rights_confirmation_required",
            "允许嵌入交付包需要明确的权利状态与再分发声明。",
        )?;
        if let Some(uri) = value["source"]["source_uri"].as_str() {
            let valid = url::Url::parse(uri).is_ok_and(|url| {
                matches!(url.scheme(), "https" | "http")
                    && url.has_host()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
            });
            ensure(
                valid,
                "invalid_input",
                "来源地址只接受不带凭据、查询参数或片段的 HTTP(S) 页面地址。",
            )?;
        }
    }
    if let Some(name) = value["original_filename"].as_str() {
        ensure(
            !name.contains(['/', '\\']) && !name.chars().any(char::is_control),
            "invalid_input",
            "原文件名称不能包含目录分隔符或控制字符。",
        )?;
    }
    Ok(())
}

pub fn blob_path(asset: &Value) -> Result<String> {
    let extension = match asset["blob"]["media_type"].as_str() {
        Some("image/png") => "png",
        Some("image/jpeg") => "jpg",
        Some("image/gif") => "gif",
        Some("image/webp") => "webp",
        Some("audio/wav") => "wav",
        Some("audio/flac") => "flac",
        Some("application/ogg") => "ogg",
        Some("audio/mpeg") => "mp3",
        Some("audio/mp4") => "m4a",
        Some("video/mp4") => "mp4",
        Some("video/quicktime") => "mov",
        _ => {
            return Err(super::Error::new(
                "hetu.integrity_failure",
                "媒体类型无效。",
            ));
        }
    };
    Ok(format!(
        "packages/{}/assets/{}/source.{extension}",
        package(asset["kind"].as_str().unwrap_or("")),
        asset["asset_id"].as_str().unwrap_or("")
    ))
}

// 只识别文件签名，不把签名识别等同于完整解码、安全扫描或版权验证。
pub fn signature(prefix: &[u8]) -> Result<Value> {
    let (media_type, kind, extension) = if prefix.starts_with(b"\x89PNG\r\n\x1a\n") {
        ("image/png", "visual", "png")
    } else if prefix.starts_with(b"\xff\xd8\xff") {
        ("image/jpeg", "visual", "jpg")
    } else if prefix.starts_with(b"GIF87a") || prefix.starts_with(b"GIF89a") {
        ("image/gif", "visual", "gif")
    } else if prefix.starts_with(b"RIFF") && prefix.get(8..12) == Some(b"WEBP") {
        ("image/webp", "visual", "webp")
    } else if prefix.starts_with(b"RIFF") && prefix.get(8..12) == Some(b"WAVE") {
        ("audio/wav", "music", "wav")
    } else if prefix.starts_with(b"fLaC") {
        ("audio/flac", "music", "flac")
    } else if prefix.starts_with(b"OggS")
        && (prefix.windows(8).any(|p| p == b"OpusHead")
            || prefix.windows(6).any(|p| p == b"vorbis"))
    {
        ("application/ogg", "music", "ogg")
    } else if prefix.starts_with(b"ID3")
        || (prefix.len() >= 4 && prefix[0] == 0xff && prefix[1] & 0xe6 == 0xe2)
    {
        ("audio/mpeg", "music", "mp3")
    } else if prefix.get(4..8) == Some(b"ftyp") {
        match prefix.get(8..12) {
            Some(b"M4A " | b"M4B ") => ("audio/mp4", "music", "m4a"),
            Some(b"qt  ") => ("video/quicktime", "visual", "mov"),
            Some(b"isom" | b"iso2" | b"mp41" | b"mp42" | b"avc1" | b"M4V " | b"dash") => {
                ("video/mp4", "visual", "mp4")
            }
            _ => {
                return Err(super::Error::new(
                    "hetu.unsupported_media",
                    "媒体容器类型不受支持。",
                ));
            }
        }
    } else {
        return Err(super::Error::new(
            "hetu.unsupported_media",
            "文件签名不属于支持的图片、音频或视频；不能作为媒体导入。",
        ));
    };
    Ok(
        json!({"media_type":media_type,"kind":kind,"extension":extension,"validation":"signature_only"}),
    )
}

pub fn delivery_eligible(asset: &Value) -> bool {
    matches!(
        asset["rights_status"].as_str(),
        Some("author_owned" | "licensed")
    ) && asset["redistribution_allowed"] == true
        && !asset["rights_statement"]
            .as_str()
            .unwrap_or("")
            .trim()
            .is_empty()
}
