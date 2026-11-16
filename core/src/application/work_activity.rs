//! 对象的更新时间由实际事务投影，不使用打开时间或文件系统时间。
use super::*;
use std::collections::BTreeSet;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

fn parse(value: &Value) -> Option<OffsetDateTime> {
    value
        .as_str()
        .and_then(|s| OffsetDateTime::parse(s, &Rfc3339).ok())
}
fn path(kind: &str, object_id: &str) -> String {
    format!(".hetu/work-activity/{kind}/{object_id}.json")
}

impl Kernel {
    pub(super) fn work_updated_at(&self, reference: &Value, record: &Value) -> Result<Value> {
        let file = path(text(reference, "kind")?, text(reference, "object_id")?);
        if !self.store.exists(&file)? {
            return Ok(record["updated_at"].clone());
        }
        let activity = self.store.json(&file)?;
        ensure(
            activity["schema_version"] == "1.0.0"
                && activity["work_ref"] == *reference
                && parse(&activity["updated_at"]).is_some(),
            "hetu.integrity_failure",
            "创作对象时间记录无效。",
        )?;
        Ok(
            if parse(&activity["updated_at"]) > parse(&record["updated_at"]) {
                activity["updated_at"].clone()
            } else {
                record["updated_at"].clone()
            },
        )
    }

    pub(super) fn stage_work_activity(&self, changes: &mut Changes) -> Result<()> {
        let mut affected: BTreeSet<(String, String)> = BTreeSet::new();
        let mut novel = None;
        let records = changes
            .iter()
            .filter(|(path, _)| {
                path.as_str() == "packages/novel/novel.json"
                    || path.starts_with(".hetu/novels/")
                    || (path.ends_with("/document.json")
                        && (path.starts_with("packages/novel/documents/")
                            || path.starts_with("packages/drama/documents/")))
                    || ([
                        "packages/drama/projects/",
                        "packages/drama/episodes/",
                        "packages/video/projects/",
                        "packages/video/episodes/",
                        "resources/items/",
                        "shared/work-links/",
                    ]
                    .iter()
                    .any(|prefix| path.starts_with(prefix))
                        && path.contains("/revisions/")
                        && path.ends_with(".json"))
                    || (path.starts_with("shared/work-canons/")
                        && path.contains("/revisions/")
                        && path.ends_with(".json"))
            })
            .filter_map(|(_, bytes)| serde_json::from_slice::<Value>(bytes).ok())
            .collect::<Vec<_>>();
        for record in &records {
            if record["workspace_id"] != self.scope() {
                continue;
            }
            if record["work_ref"].is_object() {
                self.check_work_ref(&record["work_ref"])?;
                affected.insert((
                    text(&record["work_ref"], "kind")?.into(),
                    text(&record["work_ref"], "object_id")?.into(),
                ));
            }
            if record["link_id"].is_string() {
                let target = &record["target_ref"]["work_ref"];
                self.check_work_ref(target)?;
                affected.insert((
                    text(target, "kind")?.into(),
                    text(target, "object_id")?.into(),
                ));
            }
            for (key, kind) in [
                ("novel_id", "novel"),
                ("project_id", "drama"),
                ("video_project_id", "video"),
            ] {
                if let Some(object_id) = record[key]
                    .as_str()
                    .filter(|value| value.starts_with(&format!("{kind}_")))
                {
                    checked_id(object_id, kind)?;
                    affected.insert((kind.to_owned(), object_id.to_owned()));
                    if kind == "novel" {
                        novel = Some(object_id.to_owned());
                    }
                }
            }
        }
        for record in &records {
            if !record["document_id"].is_string() {
                continue;
            }
            match record["kind"].as_str() {
                Some("novel_chapter" | "novel_outline" | "adaptation_note") => {
                    if novel.is_none() {
                        novel = self
                            .novel_record()?
                            .map(|v| v["novel_id"].as_str().unwrap().to_owned());
                    }
                    if let Some(novel) = &novel {
                        affected.insert(("novel".into(), novel.clone()));
                    }
                }
                Some("drama_script") => {
                    if let Some(episode_id) = record["drama_episode_id"].as_str() {
                        // 新分集和空作者稿在同一事务中创建，此时分集尚未落盘。
                        let staged = records.iter().find(|item| {
                            item["workspace_id"] == self.scope() && item["episode_id"] == episode_id
                        });
                        let project = if let Some(episode) = staged {
                            text(episode, "project_id")?.to_owned()
                        } else {
                            text(&self.read_drama_episode(episode_id, None)?.0, "project_id")?
                                .to_owned()
                        };
                        affected.insert(("drama".into(), project));
                    }
                }
                _ => {}
            }
        }
        // 旧单对象目录中的无归属资料仍属于该对象；多对象目录不能据此猜归属。
        if affected.is_empty() {
            let mut owners = Vec::new();
            if novel.is_none() {
                novel = self
                    .novel_record()?
                    .map(|v| v["novel_id"].as_str().unwrap().to_owned());
            }
            if let Some(novel) = novel {
                owners.push(("novel".to_owned(), novel));
            }
            owners.extend(
                self.record_ids("packages/drama/projects", "drama")?
                    .into_iter()
                    .map(|id| ("drama".to_owned(), id)),
            );
            owners.extend(
                self.record_ids("packages/video/projects", "video")?
                    .into_iter()
                    .map(|id| ("video".to_owned(), id)),
            );
            if owners.len() == 1 {
                affected.extend(owners);
            }
        }
        let timestamp = json!(now());
        for (kind, object_id) in affected {
            let reference = self.work_ref(&kind, &json!(object_id));
            let file = path(&kind, &object_id);
            let updated = if self.store.exists(&file)? {
                let old = self.store.json(&file)?;
                ensure(
                    old["work_ref"] == reference && parse(&old["updated_at"]).is_some(),
                    "hetu.integrity_failure",
                    "创作对象时间记录无效。",
                )?;
                if parse(&old["updated_at"]) > parse(&timestamp) {
                    old["updated_at"].clone()
                } else {
                    timestamp.clone()
                }
            } else {
                timestamp.clone()
            };
            changes.insert(
                file,
                bytes(
                    &json!({"schema_version":"1.0.0","work_ref":reference,"updated_at":updated}),
                )?,
            );
        }
        Ok(())
    }
}
