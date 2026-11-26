//! 剧本、视频和专业来源使用原领域目录；不启动插件或自行推断正文结构。
use super::*;

pub(super) fn work_sources(
    state: &mut SearchState,
    read: &mut Read<'_>,
    work: &Value,
    title: &str,
) {
    let query = if title.to_lowercase().contains(&state.query) {
        String::new()
    } else {
        state.query.clone()
    };
    if work["kind"] == "drama" {
        let scenes = pages(
            state,
            read,
            "hetu.documents.scene_index",
            json!({"work_ref":work,"query":query,"limit":MAX_ITEMS}),
            "scenes",
            |state, _, row, _| {
                state.scanned += 1;
                let heading = row["heading"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("未命名场次");
                let episode = match row["episode_number"].as_u64() {
                    Some(number) => format!(
                        "第{number}集 {}",
                        row["document_title"].as_str().unwrap_or("未命名分集")
                    ),
                    None => row["document_title"]
                        .as_str()
                        .unwrap_or("未命名分集")
                        .to_owned(),
                };
                let name = format!(
                    "{episode} / 第{}场 {heading}",
                    row["scene_number"].as_u64().unwrap_or(0)
                );
                state.push(
                    Source::Scene {
                        work_ref: work.clone(),
                        document_id: text(&row["document_ref"], "document_id"),
                        revision_id: text(&row["document_ref"], "revision_id"),
                        sha256: text(&row["document_ref"], "sha256"),
                        byte_start: row["range"]["byte_start"].as_u64().unwrap_or(0) as usize,
                        byte_end: row["range"]["byte_end"].as_u64().unwrap_or(0) as usize,
                    },
                    &name,
                    title,
                    "固定原稿场次",
                );
                Ok(())
            },
        );
        if scenes.is_err() {
            state.unavailable.insert("scenes");
        }
    }
    if work["kind"] == "video" && state.room() {
        let mut episodes = std::collections::BTreeMap::new();
        match state.read(
            read,
            "hetu.video.projects.get",
            json!({"video_project_id":work["object_id"]}),
        ) {
            Ok(value) => {
                for row in value["episodes"].as_array().into_iter().flatten() {
                    if !state.room() {
                        return;
                    }
                    let episode = &row["episode"];
                    let name = text(episode, "title");
                    if episode["archived"] == true {
                        continue;
                    }
                    episodes.insert(
                        text(episode, "video_episode_id"),
                        format!("第{}集 {name}", row["episode_number"].as_u64().unwrap_or(0)),
                    );
                    if episode["archived"] != true && state.matches(&name, title) {
                        state.push(
                            Source::VideoEpisode {
                                work_ref: work.clone(),
                                video_episode_id: text(episode, "video_episode_id"),
                                revision: episode["revision"].as_u64().unwrap_or(0),
                                sha256: text(row, "sha256"),
                            },
                            &format!("第{}集 {name}", row["episode_number"].as_u64().unwrap_or(0)),
                            title,
                            "固定视频分集",
                        );
                    }
                }
            }
            Err(_) => {
                state.unavailable.insert("video_episodes");
            }
        }
        if state.room() {
            let media = pages(
                state,
                read,
                "hetu.video.media.list",
                json!({"work_ref":work,"query":query,"limit":MAX_ITEMS}),
                "items",
                |state, _, row, _| {
                    state.scanned += 1;
                    let record = &row["media"];
                    let kind = match record["purpose"].as_str() {
                        Some("final") => "固定成片",
                        Some("previsualization") => "固定预演",
                        _ => "固定视频片段",
                    };
                    let name = match episodes.get(record["video_episode_id"].as_str().unwrap_or(""))
                    {
                        Some(episode) => format!("{episode} / {}", text(record, "title")),
                        None => text(record, "title"),
                    };
                    state.push(
                        Source::VideoMedia {
                            work_ref: work.clone(),
                            media_ref: row["media_ref"].clone(),
                        },
                        &name,
                        title,
                        kind,
                    );
                    Ok(())
                },
            );
            if media.is_err() {
                state.unavailable.insert("video_media");
            }
        }
    }
    if state.room() {
        let plugins = pages(
            state,
            read,
            "hetu.plugin_results.list",
            json!({"work_ref":work,"query":query,"limit":MAX_ITEMS}),
            "objects",
            |state, _, row, _| {
                state.scanned += 1;
                state.push(
                    Source::PluginObject {
                        work_ref: work.clone(),
                        owner_plugin_id: text(row, "owner_plugin_id"),
                        object_id: text(row, "object_id"),
                        revision: row["revision"].as_u64().unwrap_or(0),
                        sha256: text(row, "sha256"),
                    },
                    &text(row, "title"),
                    title,
                    &format!("专业成果 {}", text(row, "owner_plugin_id")),
                );
                Ok(())
            },
        );
        if plugins.is_err() {
            state.unavailable.insert("plugin_results");
        }
    }
}
