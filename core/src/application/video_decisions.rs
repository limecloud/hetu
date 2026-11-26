//! 媒体认可与文件接收、意见及文稿定稿分离；每个分集用途只有一份决定链。
use super::*;

const DECISIONS: &str = "packages/video/decisions";

fn reference(record: &Value, sha: &str) -> Value {
    json!({"decision_id":record["decision_id"],"revision":record["revision"],"sha256":sha})
}
fn slot_path(episode: &str, purpose: &str) -> Result<String> {
    checked_id(episode, "vepisode")?;
    ensure(
        matches!(purpose, "previsualization" | "clip" | "final"),
        "invalid_input",
        "媒体决定用途无效。",
    )?;
    Ok(format!(
        "packages/video/decision-slots/{episode}/{purpose}.json"
    ))
}

impl Kernel {
    fn fixed_video_decision(
        &self,
        work: &Value,
        episode: &str,
        purpose: &str,
        fixed: &Value,
    ) -> Result<(Value, String)> {
        let id = checked_id(text(fixed, "decision_id")?, "vdecision")?;
        let (record, sha, _) = self.versioned_record(
            DECISIONS,
            &id,
            "decision_id",
            Some(integer(fixed, "revision")?),
        )?;
        schema(
            &record,
            &works::bundle_reference(video_review::definition("decision_record")),
        )?;
        ensure(
            record["work_ref"] == *work
                && record["video_episode_id"] == episode
                && record["purpose"] == purpose,
            "forbidden",
            "媒体决定不属于当前作品、分集或用途。",
        )?;
        ensure(
            *fixed == reference(&record, &sha),
            "hetu.stale_evidence",
            "媒体决定固定摘要不一致。",
        )?;
        let revision = integer(&record, "revision")?;
        ensure(
            if revision == 1 {
                record["previous_ref"].is_null() && record["decision"] == "confirmed"
            } else {
                record["previous_ref"]
                    == json!({"decision_id":id,"revision":revision-1,"sha256":record["previous_sha256"]})
            },
            "hetu.integrity_failure",
            "媒体决定前一引用不一致。",
        )?;
        Ok((record, sha))
    }
    fn current_video_decision(&self, work: &Value, episode: &str, purpose: &str) -> Result<Value> {
        self.video_review_episode(work, episode)?;
        let path = slot_path(episode, purpose)?;
        if !self.store.exists(&path)? {
            return Ok(Value::Null);
        }
        let fixed = self.store.json(&path)?;
        schema(&fixed, &video_review::definition("decision_ref"))?;
        let (record, sha) = self.fixed_video_decision(work, episode, purpose, &fixed)?;
        let (_, _, current) =
            self.versioned_record(DECISIONS, text(&fixed, "decision_id")?, "decision_id", None)?;
        ensure(
            current == record,
            "hetu.integrity_failure",
            "媒体决定槽位与当前修订不一致。",
        )?;
        Ok(json!({"decision":record,"decision_ref":reference(&record,&sha)}))
    }
    pub(super) fn video_media_decision(&self, media: &Value, media_ref: &Value) -> Result<Value> {
        let current = self.current_video_decision(
            &media["work_ref"],
            text(media, "video_episode_id")?,
            text(media, "purpose")?,
        )?;
        let state = if current.is_null() {
            "not_recorded"
        } else if current["decision"]["media_ref"] != *media_ref {
            "other_media"
        } else if current["decision"]["decision"] == "confirmed" {
            "confirmed"
        } else {
            "withdrawn"
        };
        Ok(
            json!({"state":state,"purpose":media["purpose"],"current_decision_ref":current["decision_ref"],"decision":current["decision"]}),
        )
    }
    pub(super) fn get_video_decision(&self, input: &Value) -> Result<Value> {
        let (work, episode, purpose) = (
            &input["work_ref"],
            text(input, "video_episode_id")?,
            text(input, "purpose")?,
        );
        let current = self.current_video_decision(work, episode, purpose)?;
        let selected = if let Some(fixed) = input.get("decision_ref") {
            let (record, sha) = self.fixed_video_decision(work, episode, purpose, fixed)?;
            json!({"decision":record,"decision_ref":reference(&record,&sha)})
        } else {
            current.clone()
        };
        Ok(
            json!({"work_ref":work,"video_episode_id":episode,"purpose":purpose,
            "decision":selected["decision"],"decision_ref":selected["decision_ref"],"current_decision_ref":current["decision_ref"]}),
        )
    }
    pub(super) fn preview_video_decision(&self, input: &Value) -> Result<Value> {
        let (media, _) = self.fixed_video_media(&input["work_ref"], &input["media_ref"])?;
        // 核对原字节，不能以已有目录或Agent描述替代固定成果。
        self.fixed_asset(&input["work_ref"], &media["asset_ref"])?;
        ensure(
            input["purpose"] == media["purpose"],
            "invalid_input",
            "决定用途必须与所选媒体一致。",
        )?;
        ensure(
            !text(input, "author_statement")?.trim().is_empty(),
            "invalid_input",
            "请保留作者对本版成果的明确决定。",
        )?;
        let episode =
            self.video_review_episode(&input["work_ref"], text(&media, "video_episode_id")?)?;
        let current = self.current_video_decision(
            &input["work_ref"],
            text(&media, "video_episode_id")?,
            text(input, "purpose")?,
        )?;
        ensure(
            input["expected_decision_ref"] == current["decision_ref"],
            "revision_conflict",
            "本集用途的认可已有变化，请重新核对。",
        )?;
        if input["decision"] == "withdrawn" {
            ensure(
                current["decision"]["decision"] == "confirmed"
                    && current["decision"]["media_ref"] == input["media_ref"],
                "revision_conflict",
                "只能撤回当前已认可的确切媒体。",
            )?;
        } else {
            ensure(
                episode["episode"]["archived"] != true,
                "forbidden",
                "请先恢复已归档视频分集。",
            )?;
            ensure(
                current["decision"]["decision"] != "confirmed"
                    || current["decision"]["media_ref"] != input["media_ref"],
                "invalid_input",
                "本版成果已经认可，请读取原决定。",
            )?;
        }
        let mut preview = json!({"request":input,"snapshot":{"work_ref":input["work_ref"],"media_ref":input["media_ref"],
            "video_episode_id":media["video_episode_id"],"episode_revision":episode["episode"]["revision"],"episode_sha256":episode["sha256"],
            "title":media["title"],"purpose":media["purpose"],"asset_ref":media["asset_ref"],"caption_tracks":media.get("caption_tracks").cloned().unwrap_or(json!([])),
            "current_decision":current["decision"]}});
        preview["sha256"] = json!(digest(serde_json_canonicalizer::to_vec(&preview)?));
        Ok(json!({"preview":preview}))
    }
    pub(super) fn save_video_decision(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let requested = &input["preview"];
        ensure(
            input["work_ref"] == requested["request"]["work_ref"],
            "forbidden",
            "媒体决定与当前作品不一致。",
        )?;
        let preview = self.preview_video_decision(&requested["request"])?;
        ensure(
            preview["preview"] == *requested,
            "hetu.stale_evidence",
            "媒体决定预览已变化，请核对原版本。",
        )?;
        let request = &requested["request"];
        let old = &requested["snapshot"]["current_decision"];
        let mut record = if old.is_null() {
            let timestamp = now();
            json!({"schema_version":"1.0.0","workspace_id":self.scope(),"decision_id":id("vdecision"),"revision":1,
                "previous_sha256":null,"created_at":timestamp,"updated_at":timestamp,"actor_ref":self.actor()})
        } else {
            let mut record = old.clone();
            self.advance_record(
                &mut record,
                text(&request["expected_decision_ref"], "sha256")?,
            )?;
            record
        };
        for field in [
            "work_ref",
            "purpose",
            "media_ref",
            "decision",
            "author_statement",
        ] {
            record[field] = request[field].clone();
        }
        record["video_episode_id"] = requested["snapshot"]["video_episode_id"].clone();
        record["previous_ref"] = request["expected_decision_ref"].clone();
        schema(
            &record,
            &works::bundle_reference(video_review::definition("decision_record")),
        )?;
        let sha = self.stage_versioned_record(DECISIONS, "decision_id", &record, changes)?;
        let fixed = reference(&record, &sha);
        let slot = slot_path(
            text(&record, "video_episode_id")?,
            text(&record, "purpose")?,
        )?;
        changes.insert(slot, bytes(&fixed)?);
        Ok(json!({"decision":record,"decision_ref":fixed}))
    }
    pub(super) fn video_decision_history(&self, input: &Value) -> Result<Value> {
        let (work, episode, purpose) = (
            &input["work_ref"],
            text(input, "video_episode_id")?,
            text(input, "purpose")?,
        );
        let current = self.current_video_decision(work, episode, purpose)?;
        let identity = json!({"work_ref":work,"video_episode_id":episode,"purpose":purpose,"head":current["decision_ref"]});
        let fingerprint = digest(serde_json_canonicalizer::to_vec(&identity)?);
        let latest = current["decision"]["revision"].as_u64().unwrap_or(0);
        let start = if let Some(cursor) = input["cursor"].as_str() {
            let (sha, number) = cursor
                .split_once(':')
                .ok_or_else(|| Error::new("invalid_input", "决定历史分页引用无效。"))?;
            ensure(
                sha == fingerprint,
                "hetu.stale_evidence",
                "决定历史已有更新，请重新读取。",
            )?;
            number
                .parse::<u64>()
                .map_err(|_| Error::new("invalid_input", "决定历史分页位置无效。"))?
        } else {
            latest
        };
        ensure(
            start <= latest && (latest == 0 || start > 0),
            "invalid_input",
            "决定历史分页位置超出范围。",
        )?;
        let limit = input["limit"].as_u64().unwrap_or(20);
        let end = start.saturating_sub(limit);
        let mut items = Vec::new();
        for revision in ((end + 1)..=start).rev() {
            let (record, sha, _) = self.versioned_record(
                DECISIONS,
                text(&current["decision_ref"], "decision_id")?,
                "decision_id",
                Some(revision),
            )?;
            let fixed = reference(&record, &sha);
            self.fixed_video_decision(work, episode, purpose, &fixed)?;
            items.push(json!({"decision":record,"decision_ref":fixed}));
        }
        Ok(
            json!({"work_ref":work,"video_episode_id":episode,"purpose":purpose,"current_decision_ref":current["decision_ref"],
            "items":items,"total":latest,"next_cursor":(end>0).then(||format!("{fingerprint}:{end}"))}),
        )
    }
}
