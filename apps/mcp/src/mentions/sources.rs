//! 固定资源身份与原Owner读取；链接不承载授权，更新不替换历史。
use super::*;
use serde::Serialize;

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Source {
    Scene {
        work_ref: Value,
        document_id: String,
        revision_id: String,
        sha256: String,
        byte_start: usize,
        byte_end: usize,
    },
    VideoEpisode {
        work_ref: Value,
        video_episode_id: String,
        revision: u64,
        sha256: String,
    },
    VideoMedia {
        work_ref: Value,
        media_ref: Value,
    },
    PluginObject {
        work_ref: Value,
        owner_plugin_id: String,
        object_id: String,
        revision: u64,
        sha256: String,
    },
    Document {
        work_ref: Value,
        document_id: String,
        revision_id: String,
        sha256: String,
    },
    Entity {
        work_ref: Value,
        revision: u64,
        sha256: String,
        section: String,
        entity_id: String,
    },
    Outline {
        work_ref: Value,
        revision: u64,
        sha256: String,
        outline_id: String,
    },
    Resource {
        work_ref: Value,
        revision: u64,
        sha256: String,
        resource_id: String,
    },
    TaskContext {
        task_ref: Value,
        context_ref: Value,
    },
}
impl Source {
    fn work(&self) -> Option<&Value> {
        match self {
            Self::Scene { work_ref, .. }
            | Self::VideoEpisode { work_ref, .. }
            | Self::VideoMedia { work_ref, .. }
            | Self::PluginObject { work_ref, .. }
            | Self::Document { work_ref, .. }
            | Self::Entity { work_ref, .. }
            | Self::Outline { work_ref, .. }
            | Self::Resource { work_ref, .. } => Some(work_ref),
            Self::TaskContext { .. } => None,
        }
    }
    fn digest(&self) -> &str {
        match self {
            Self::Scene { sha256, .. }
            | Self::VideoEpisode { sha256, .. }
            | Self::PluginObject { sha256, .. }
            | Self::Document { sha256, .. }
            | Self::Entity { sha256, .. }
            | Self::Outline { sha256, .. }
            | Self::Resource { sha256, .. } => sha256,
            Self::VideoMedia { media_ref, .. } => media_ref["sha256"].as_str().unwrap_or(""),
            Self::TaskContext { context_ref, .. } => context_ref["sha256"].as_str().unwrap_or(""),
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Reference {
    pub(super) source: Source,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub(super) offset: usize,
}
fn is_zero(value: &usize) -> bool {
    *value == 0
}
pub(super) fn uri(reference: &Reference) -> String {
    let value = serde_json::to_string(reference).expect("fixed source serializes");
    format!(
        "{URI_PREFIX}{}",
        form_urlencoded::Serializer::new(String::new())
            .append_pair("ref", &value)
            .finish()
    )
}
fn parse(uri: &str) -> Result<Reference, ErrorData> {
    let invalid =
        || ErrorData::invalid_params("固定来源链接无效 / Invalid fixed source link", None);
    if uri.len() > 8192 {
        return Err(invalid());
    }
    let query = uri.strip_prefix(URI_PREFIX).ok_or_else(invalid)?;
    let fields: Vec<_> = form_urlencoded::parse(query.as_bytes()).collect();
    if fields.len() != 1 || fields[0].0 != "ref" {
        return Err(invalid());
    }
    let reference: Reference = serde_json::from_str(&fields[0].1).map_err(|_| invalid())?;
    let sha = reference.source.digest();
    if sha.len() != 64
        || !sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid());
    }
    Ok(reference)
}
pub fn work_for_uri(uri: &str) -> Result<Option<Value>, ErrorData> {
    Ok(parse(uri)?.source.work().cloned())
}
pub fn read(uri_value: &str, read: &mut Read<'_>) -> Result<ReadResourceResponse, ErrorData> {
    let reference = parse(uri_value)?;
    let source = &reference.source;
    let mismatch = || {
        ErrorData::invalid_request(
            "固定来源身份或摘要不一致 / Fixed source identity or digest differs",
            None,
        )
    };
    if let Source::Scene {
        work_ref,
        document_id,
        revision_id,
        sha256,
        byte_start,
        byte_end,
    } = source
    {
        let mut value = read(
            "hetu.documents.scene_index",
            json!({"work_ref":work_ref,"document_id":document_id,"revision_id":revision_id,
            "sha256":sha256,"scene_range":{"byte_start":byte_start,"byte_end":byte_end},"offset":reference.offset,"max_bytes":PAGE_BYTES}),
        )?;
        if value["work_ref"] != *work_ref
            || value["document_ref"]["sha256"] != *sha256
            || value["document_ref"]["revision_id"] != *revision_id
        {
            return Err(mismatch());
        }
        if let Some(next) = value["next_offset"].as_u64() {
            if next <= reference.offset as u64 {
                return Err(mismatch());
            }
            value["next_resource"] = json!(uri(&Reference {
                source: source.clone(),
                offset: next as usize
            }));
        }
        return Ok(ReadResourceResult::new(vec![
            ResourceContents::text(value.to_string(), uri_value).with_mime_type("application/json"),
        ])
        .into());
    }
    if let Source::TaskContext {
        task_ref,
        context_ref,
    } = source
    {
        let mut input =
            json!({"task_ref":task_ref,"context_ref":context_ref,"max_bytes":PAGE_BYTES});
        if reference.offset > 0 {
            input["range"] = json!({"byte_start":reference.offset});
        }
        let mut value = read("hetu.task_context.read", input.clone())?;
        if value["sha256"] != context_ref["sha256"] {
            return Err(mismatch());
        }
        if value["next_range"].is_object() {
            let offset = value["next_range"]["byte_start"]
                .as_u64()
                .ok_or_else(mismatch)? as usize;
            if offset <= reference.offset {
                return Err(mismatch());
            }
            value["next_resource"] = json!(uri(&Reference {
                source: source.clone(),
                offset
            }));
        }
        // 结构化来源继续按原Core分类／字段协议展开，不能将目录误称为完整内容。
        value["read"] = json!({"action":"hetu.task_context.read","input":input});
        return Ok(ReadResourceResult::new(vec![
            ResourceContents::text(value.to_string(), uri_value).with_mime_type("application/json"),
        ])
        .into());
    }
    let (format, content) = match source {
        Source::VideoEpisode {
            work_ref,
            video_episode_id,
            revision,
            sha256,
        } => {
            let value = read(
                "hetu.video.episodes.get",
                json!({"video_episode_id":video_episode_id,"revision":revision}),
            )?;
            if value["work_ref"] != *work_ref
                || value["sha256"] != *sha256
                || value["episode"]["revision"] != *revision
            {
                return Err(mismatch());
            }
            (
                "json".into(),
                serde_json::to_string(&value["episode"]).map_err(|_| mismatch())?,
            )
        }
        Source::VideoMedia {
            work_ref,
            media_ref,
        } => {
            let value = read(
                "hetu.video.media.get",
                json!({"work_ref":work_ref,"media_ref":media_ref}),
            )?;
            if value["media_ref"] != *media_ref
                || value["sha256"] != media_ref["sha256"]
                || value["media"]["work_ref"] != *work_ref
            {
                return Err(mismatch());
            }
            // 作者决定单独变化；来源只返回原媒体记录，不把后来的决定混入固定正文。
            (
                "json".into(),
                serde_json::to_string(&value["media"]).map_err(|_| mismatch())?,
            )
        }
        Source::PluginObject {
            work_ref,
            owner_plugin_id,
            object_id,
            revision,
            sha256,
        } => {
            let value = read(
                "hetu.plugin_results.get",
                json!({"work_ref":work_ref,"owner_plugin_id":owner_plugin_id,"object_id":object_id,"revision":revision}),
            )?;
            if value["sha256"] != *sha256
                || value["object"]["work_ref"] != *work_ref
                || value["object"]["owner_plugin_id"] != *owner_plugin_id
                || value["object"]["object_id"] != *object_id
                || value["object"]["revision"] != *revision
            {
                return Err(mismatch());
            }
            (
                "json".into(),
                serde_json::to_string(&value["object"]).map_err(|_| mismatch())?,
            )
        }
        Source::Document {
            work_ref,
            document_id,
            revision_id,
            sha256,
        } => {
            let value = read(
                "hetu.documents.get",
                json!({"document_id":document_id,"revision_id":revision_id}),
            )?;
            if value["work_ref"] != *work_ref
                || value["revision"]["sha256"] != *sha256
                || value["revision"]["revision_id"] != *revision_id
            {
                return Err(mismatch());
            }
            (
                text(&value["revision"], "source_format"),
                text(&value, "content"),
            )
        }
        Source::Entity {
            work_ref,
            revision,
            sha256,
            section,
            entity_id,
        } => {
            let id_key = ENTITY_FIELDS
                .iter()
                .find(|(field, _)| field == section)
                .map(|(_, key)| *key)
                .ok_or_else(mismatch)?;
            let value = read(
                "hetu.blueprints.get",
                json!({"work_ref":work_ref,"revision":revision,"sha256":sha256}),
            )?;
            if value["sha256"] != *sha256 || value["revision"] != *revision {
                return Err(mismatch());
            }
            let entity = value["blueprint"][section]
                .as_array()
                .into_iter()
                .flatten()
                .find(|item| item[id_key] == *entity_id)
                .ok_or_else(mismatch)?;
            (
                "json".into(),
                serde_json::to_string(entity).map_err(|_| mismatch())?,
            )
        }
        Source::Outline {
            work_ref: _,
            revision,
            sha256,
            outline_id,
        } => {
            let value = read(
                "hetu.outlines.get",
                json!({"revision":revision,"sha256":sha256,"outline_id":outline_id}),
            )?;
            if value["sha256"] != *sha256
                || value["revision"] != *revision
                || value["items"][0]["id"] != *outline_id
            {
                return Err(mismatch());
            }
            (
                "json".into(),
                serde_json::to_string(&value["items"][0]).map_err(|_| mismatch())?,
            )
        }
        Source::Resource {
            work_ref,
            revision,
            sha256,
            resource_id,
        } => {
            let value = read(
                "hetu.resources.get",
                json!({"resource_id":resource_id,"revision":revision}),
            )?;
            if value["sha256"] != *sha256
                || value["resource"]["work_ref"] != *work_ref
                || value["resource"]["revision"] != *revision
            {
                return Err(mismatch());
            }
            (
                "json".into(),
                serde_json::to_string(&value["resource"]).map_err(|_| mismatch())?,
            )
        }
        Source::TaskContext { .. } => unreachable!("task context returns through Core paging"),
        Source::Scene { .. } => unreachable!("scene returns through Core paging"),
    };
    let start = reference.offset;
    if start > content.len() || !content.is_char_boundary(start) {
        return Err(ErrorData::invalid_params(
            "来源分页位置无效 / Invalid source offset",
            None,
        ));
    }
    let mut end = start.saturating_add(PAGE_BYTES).min(content.len());
    while !content.is_char_boundary(end) {
        end -= 1;
    }
    let next = if end < content.len() {
        Some(uri(&Reference {
            source: reference.source.clone(),
            offset: end,
        }))
    } else {
        None
    };
    let value = json!({"fixed_ref":source,"format":format,"content":&content[start..end],"byte_start":start,"byte_end":end,
        "total_bytes":content.len(),"complete":end==content.len(),"next_resource":next});
    Ok(ReadResourceResult::new(vec![
        ResourceContents::text(value.to_string(), uri_value).with_mime_type("application/json"),
    ])
    .into())
}
