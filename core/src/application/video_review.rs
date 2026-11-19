//! 基础媒体与意见属于作品；制作工程及专业判断仍归插件和外部工具。
use super::*;

const MEDIA: &str = "packages/video/media";
const FEEDBACK: &str = "packages/video/feedback";

pub(super) fn definition(name: &str) -> Value {
    static SOURCE: OnceLock<Value> = OnceLock::new();
    domain::schema::definition(
        SOURCE.get_or_init(|| {
            serde_json::from_str(include_str!(
                "../../../contracts/schemas/video-review.schema.json"
            ))
            .expect("video review schema")
        }),
        name,
    )
}

impl Kernel {
    fn video_review_work(&self, work: &Value) -> Result<()> {
        self.work_record(work, None)?;
        ensure(
            work["kind"] == "video",
            "forbidden",
            "视频审阅需要确切视频作品。",
        )
    }
    fn video_review_episode(&self, work: &Value, episode: &str) -> Result<Value> {
        self.video_review_work(work)?;
        let value = self.get_video_episode(&json!({"video_episode_id":episode}))?;
        ensure(
            value["work_ref"] == *work,
            "forbidden",
            "视频分集不属于当前作品。",
        )?;
        Ok(value)
    }
    pub(super) fn fixed_video_media(
        &self,
        work: &Value,
        reference: &Value,
    ) -> Result<(Value, String)> {
        self.video_review_work(work)?;
        let id = checked_id(text(reference, "media_id")?, "vmedia")?;
        let (record, sha, _) = self.versioned_record(
            MEDIA,
            &id,
            "media_id",
            Some(integer(reference, "revision")?),
        )?;
        ensure(
            record["work_ref"] == *work,
            "forbidden",
            "视频成果不属于当前作品。",
        )?;
        ensure(
            reference["sha256"] == sha,
            "hetu.stale_evidence",
            "视频成果固定摘要不一致。",
        )?;
        self.video_review_episode(work, text(&record, "video_episode_id")?)?;
        Ok((record, sha))
    }
    pub(super) fn fixed_asset(&self, work: &Value, reference: &Value) -> Result<(Value, String)> {
        self.work_record(work, None)?;
        let value = self.get_asset(
            &json!({"asset_id":reference["asset_id"],"revision":reference["revision"]}),
        )?;
        ensure(
            value["asset"]["work_ref"] == *work,
            "forbidden",
            "素材不属于当前作品。",
        )?;
        ensure(
            value["sha256"] == reference["sha256"],
            "hetu.stale_evidence",
            "固定素材摘要不一致。",
        )?;
        Ok((value["asset"].clone(), text(&value, "sha256")?.to_owned()))
    }
    pub(super) fn save_video_media(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let episode =
            self.video_review_episode(&input["work_ref"], text(input, "video_episode_id")?)?;
        ensure(
            episode["episode"]["archived"] != true,
            "forbidden",
            "请先恢复已归档视频分集。",
        )?;
        let (asset, _) = self.fixed_asset(&input["work_ref"], &input["asset_ref"])?;
        ensure(
            asset["blob"]["media_type"]
                .as_str()
                .is_some_and(|s| s.starts_with("video/")),
            "invalid_input",
            "分集成果需要实际视频素材。",
        )?;
        ensure(
            !text(input, "title")?.trim().is_empty(),
            "invalid_input",
            "成果名称不能为空。",
        )?;
        if input["previous_media_ref"].is_object() {
            let (previous, _) =
                self.fixed_video_media(&input["work_ref"], &input["previous_media_ref"])?;
            ensure(
                previous["video_episode_id"] == input["video_episode_id"],
                "forbidden",
                "前版须属于同一视频分集。",
            )?;
        }
        let mut record = json!({"schema_version":"1.0.0","workspace_id":self.scope(),"media_id":id("vmedia"),
            "revision":1,"previous_sha256":null,"created_at":now(),"updated_at":now(),"actor_ref":self.actor(),
            "timing_authority":"submitter_reported","adoption":"not_recorded"});
        for key in [
            "work_ref",
            "video_episode_id",
            "asset_ref",
            "title",
            "purpose",
            "stream_index",
            "time_base",
            "duration_ticks",
            "previous_media_ref",
        ] {
            record[key] = input[key].clone();
        }
        let sha = self.stage_versioned_record(MEDIA, "media_id", &record, changes)?;
        Ok(
            json!({"media":record,"sha256":sha,"media_ref":{"media_id":record["media_id"],"revision":1,"sha256":sha}}),
        )
    }
    pub(super) fn get_video_media(&self, input: &Value) -> Result<Value> {
        let (record, sha) = self.fixed_video_media(&input["work_ref"], &input["media_ref"])?;
        let (mut asset, _) = self.fixed_asset(&input["work_ref"], &record["asset_ref"])?;
        // 原字节只通过受管分块或媒体服务提供，列表和renderer不消费存储路径。
        asset["blob"].as_object_mut().unwrap().remove("path");
        Ok(
            json!({"media":record,"sha256":sha,"media_ref":input["media_ref"],"asset":asset,
            "verification":{"bytes":"verified","decoding":"not_checked","viewing":"not_checked","author_approval":"not_recorded"}}),
        )
    }
    fn video_review_page(
        &self,
        input: &Value,
        records: Vec<Value>,
        identity: Value,
    ) -> Result<Value> {
        let fingerprint = digest(bytes(&json!({"identity":identity,"records":records}))?);
        let start = if let Some(cursor) = input["cursor"].as_str() {
            let (sha, offset) = cursor
                .split_once(':')
                .ok_or_else(|| Error::new("invalid_input", "分页引用无效。"))?;
            ensure(
                sha == fingerprint,
                "hetu.stale_evidence",
                "成果或意见目录已有变化，请重新读取。",
            )?;
            offset
                .parse::<usize>()
                .map_err(|_| Error::new("invalid_input", "分页位置无效。"))?
        } else {
            0
        };
        ensure(start <= records.len(), "invalid_input", "分页超出范围。")?;
        let end = start
            .saturating_add(input["limit"].as_u64().unwrap_or(25) as usize)
            .min(records.len());
        Ok(
            json!({"items":records[start..end],"total":records.len(),"catalog_sha256":fingerprint,
            "next_cursor":(end<records.len()).then(||format!("{fingerprint}:{end}"))}),
        )
    }
    pub(super) fn list_video_media(&self, input: &Value) -> Result<Value> {
        self.video_review_episode(&input["work_ref"], text(input, "video_episode_id")?)?;
        let ids = self.record_ids(MEDIA, "vmedia")?;
        ensure(
            ids.len() <= 10000,
            "hetu.budget_exceeded",
            "视频成果目录超过单次扫描预算。",
        )?;
        let mut records = Vec::new();
        for id in ids {
            let (record, sha, _) = self.versioned_record(MEDIA, &id, "media_id", None)?;
            if record["work_ref"] == input["work_ref"]
                && record["video_episode_id"] == input["video_episode_id"]
            {
                records.push(json!({"media_ref":{"media_id":id,"revision":record["revision"],"sha256":sha},"media":record}));
            }
        }
        records.sort_by(|a, b| {
            a["media"]["created_at"]
                .as_str()
                .cmp(&b["media"]["created_at"].as_str())
                .then_with(|| {
                    a["media"]["media_id"]
                        .as_str()
                        .cmp(&b["media"]["media_id"].as_str())
                })
        });
        self.video_review_page(
            input,
            records,
            json!({"work_ref":input["work_ref"],"episode":input["video_episode_id"]}),
        )
    }
    pub(super) fn save_video_feedback(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let (media, _) = self.fixed_video_media(&input["work_ref"], &input["media_ref"])?;
        ensure(
            !text(input, "comment")?.trim().is_empty(),
            "invalid_input",
            "意见不能为空。",
        )?;
        if input["range"].is_object() {
            let start = integer(&input["range"], "start_tick")?;
            let end = integer(&input["range"], "end_tick")?;
            ensure(
                start < end && end <= integer(&media, "duration_ticks")?,
                "invalid_range",
                "意见区间超出固定媒体时长。",
            )?;
        }
        let record = json!({"schema_version":"1.0.0","workspace_id":self.scope(),"feedback_id":id("vfeedback"),
            "revision":1,"previous_sha256":null,"work_ref":input["work_ref"],"media_ref":input["media_ref"],
            "stream_index":media["stream_index"],"time_base":media["time_base"],"range":input["range"],"comment":input["comment"],
            "created_at":now(),"updated_at":now(),"actor_ref":self.actor(),"effect":"feedback_only"});
        let sha = self.stage_versioned_record(FEEDBACK, "feedback_id", &record, changes)?;
        Ok(json!({"feedback":record,"sha256":sha}))
    }
    pub(super) fn list_video_feedback(&self, input: &Value) -> Result<Value> {
        self.fixed_video_media(&input["work_ref"], &input["media_ref"])?;
        let ids = self.record_ids(FEEDBACK, "vfeedback")?;
        ensure(
            ids.len() <= 10000,
            "hetu.budget_exceeded",
            "视频意见目录超过单次扫描预算。",
        )?;
        let mut records = Vec::new();
        for id in ids {
            let (record, sha, _) = self.versioned_record(FEEDBACK, &id, "feedback_id", None)?;
            if record["work_ref"] == input["work_ref"] && record["media_ref"] == input["media_ref"]
            {
                records.push(json!({"feedback":record,"sha256":sha}));
            }
        }
        records.sort_by(|a, b| {
            a["feedback"]["created_at"]
                .as_str()
                .cmp(&b["feedback"]["created_at"].as_str())
                .then_with(|| {
                    a["feedback"]["feedback_id"]
                        .as_str()
                        .cmp(&b["feedback"]["feedback_id"].as_str())
                })
        });
        self.video_review_page(
            input,
            records,
            json!({"work_ref":input["work_ref"],"media_ref":input["media_ref"]}),
        )
    }
    pub(super) fn preview_video_delivery(&self, input: &Value) -> Result<Value> {
        self.video_review_work(&input["work_ref"])?;
        let mut items = Vec::new();
        for reference in input["media_refs"].as_array().unwrap() {
            let view =
                self.get_video_media(&json!({"work_ref":input["work_ref"],"media_ref":reference}))?;
            let asset = &view["asset"];
            ensure(
                self.asset_delivery_metadata(
                    &json!({"asset_id":asset["asset_id"],"revision":asset["revision"]}),
                )?["delivery_eligible"]
                    == true,
                "forbidden",
                "素材权利未允许交付，请核对权利声明。",
            )?;
            items.push(json!({"media_ref":reference,"title":view["media"]["title"],"purpose":view["media"]["purpose"],
                "asset_ref":view["media"]["asset_ref"],"blob":asset["blob"],"filename":asset["original_filename"],
                "read_action":"hetu.assets.read_blob"}));
        }
        Ok(
            json!({"work_ref":input["work_ref"],"manifest_sha256":digest(serde_json::to_vec(&items)?),"items":items,
            "profile":"fixed_media_files","professional_project":"not_included","author_approval":"not_recorded"}),
        )
    }
    pub(super) fn read_asset_blob(&self, input: &Value) -> Result<Value> {
        self.work_record(&input["work_ref"], None)?;
        let metadata=self.asset_delivery_metadata(&json!({"asset_id":input["asset_ref"]["asset_id"],"revision":input["asset_ref"]["revision"]}))?;
        let asset = metadata["asset"].clone();
        let sha = text(&metadata, "sha256")?;
        ensure(
            asset["work_ref"] == input["work_ref"] && input["asset_ref"]["sha256"] == sha,
            "forbidden",
            "固定素材不属于当前作品或摘要不符。",
        )?;
        let file = self.store.managed_media(text(&asset["blob"], "path")?)?;
        let mut reader = AssetMedia::open(file, &asset["blob"], input["asset_ref"].clone())?;
        let mut chunk = reader.read(integer(input, "offset")?, integer(input, "length")?)?;
        let next = integer(&chunk, "offset")? + integer(&chunk, "size_bytes")?;
        chunk["asset_ref"] =
            json!({"asset_id":asset["asset_id"],"revision":asset["revision"],"sha256":sha});
        chunk["blob_sha256"] = asset["blob"]["sha256"].clone();
        chunk["total_bytes"] = asset["blob"]["size_bytes"].clone();
        chunk["next_offset"] = if next < integer(&asset["blob"], "size_bytes")? {
            json!(next)
        } else {
            Value::Null
        };
        Ok(chunk)
    }
}
