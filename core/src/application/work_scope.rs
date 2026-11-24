//! 对象范围是管理授权的进一步收窄，关联和同目录不扩大它。
use super::*;

impl Kernel {
    pub(super) fn workspace_info(&self) -> Result<Value> {
        let mut config = self.config.clone();
        let mut properties = self.workspace_properties()?;
        if let Some(reference) = self.granted_work()? {
            let work = self.get_work(&json!({"work_ref":reference}))?;
            config["title"] = work["summary"]["title"].clone();
            config["work_type"] = reference["kind"].clone();
            properties = json!({"created_at":work["summary"]["created_at"],"updated_at":work["summary"]["updated_at"]});
        }
        Ok(
            json!({"workspace":config,"properties":properties,"access":{"write_available":self.store.write_available()?}}),
        )
    }
    pub(super) fn granted_work(&self) -> Result<Option<Value>> {
        self.management_grant
            .as_ref()
            .map(crate::collaboration::authoring::granted_work)
            .transpose()
            .map(Option::flatten)
    }

    pub(super) fn check_work_access(&self, action: &str, input: &Value) -> Result<()> {
        let Some(reference) = self.granted_work()? else {
            return Ok(());
        };
        let object_id = &reference["object_id"];
        let kind = &reference["kind"];
        let allowed = match action {
            "hetu.capabilities.get"
            | "hetu.operations.get"
            | "hetu.workspaces.get"
            | "hetu.works.list"
            | "hetu.agent_operations.catalog"
            | "hetu.agent_operations.list" => true,
            "hetu.plugins.capabilities"
            | "hetu.plugins.invoke"
            | "hetu.novels.snapshot"
            | "hetu.plugin_access.record_migration_decision"
            | "hetu.plugin_access.authorize"
            | "hetu.plugin_access.inspect"
            | "hetu.plugin_access.capabilities"
            | "hetu.plugin_access.invoke"
            | "hetu.plugin_access.revoke" => input["work_ref"] == reference,
            "hetu.works.get"
            | "hetu.work_links.list"
            | "hetu.work_links.get"
            | "hetu.work_links.set_archived" => input["work_ref"] == reference,
            "hetu.documents.list" => {
                input["work_ref"] == reference && matches!(kind.as_str(), Some("novel" | "drama"))
            }
            "hetu.documents.create" => {
                kind == "novel" && input["kind"] == "novel_chapter" && input["content"] == ""
            }
            "hetu.documents.duplicate" => input["work_ref"] == reference
                && self.document_in_work(&self.document(text(&input["source_ref"], "document_id")?)?, &reference)?,
            "hetu.documents.move_range" => input["work_ref"] == reference
                && self.document_in_work(&self.document(text(&input["source_ref"], "document_id")?)?, &reference)?
                && self.document_in_work(&self.document(text(&input["target_ref"], "document_id")?)?, &reference)?,
            "hetu.documents.move_to_new" => input["work_ref"] == reference
                && self.document_in_work(&self.document(text(&input["source_ref"], "document_id")?)?, &reference)?
                && matches!(kind.as_str(), Some("novel" | "drama")),
            "hetu.documents.restore_move" | "hetu.documents.get_move" => input["work_ref"] == reference,
            "hetu.documents.get"
            | "hetu.documents.history"
            | "hetu.documents.save"
            | "hetu.documents.rename"
            | "hetu.documents.withdraw_finalization"
            | "hetu.documents.lifecycle"
            | "hetu.drafts.submit_current" => {
                self.work_record(&reference, None)?;
                self.document_in_work(&self.document(text(input, "document_id")?)?, &reference)?
            }
            "hetu.documents.validate" | "hetu.documents.preview_finalization" => self
                .document_in_work(
                    &self.document(text(&input["document_ref"], "document_id")?)?,
                    &reference,
                )?,
            "hetu.documents.finalize" => {
                return self.check_work_access(
                    "hetu.documents.preview_finalization",
                    &input["preview"]["request"],
                );
            }
            "hetu.drafts.list" => input["work_ref"] == reference,
            "hetu.reviews.list"
            | "hetu.plot.list"
            | "hetu.reports.list"
            | "hetu.drama.list_skeletons" => {
                if let Some(id) = input["document_id"].as_str() {
                    self.document_in_work(&self.document(id)?, &reference)?
                } else if let Some(id) = input["plot_revision_id"].as_str() {
                    self.plot_in_work(id, &reference)?
                } else {
                    true
                }
            }
            "hetu.reviews.get" => {
                let id = if let Some(id) = input["draft_id"].as_str() {
                    id.to_owned()
                } else {
                    let id = checked_id(text(input, "review_id")?, "review")?;
                    text(
                        &self.store.json(&format!(".hetu/reviews/{id}.json"))?,
                        "draft_id",
                    )?
                    .to_owned()
                };
                self.draft_work_owner(&self.draft_content(&id)?["draft"])?
                    .as_ref()
                    == Some(&reference)
            }
            "hetu.plot.extract" => {
                input["work_ref"] == reference
                    && self.sources_in_work(&input["document_revisions"], &reference)?
            }
            "hetu.plot.get" | "hetu.plot.correct" | "hetu.validation.run" => {
                self.plot_in_work(text(input, "plot_revision_id")?, &reference)?
            }
            "hetu.drama.build_skeleton" => {
                self.plot_in_work(text(input, "plot_revision_id")?, &reference)?
                    && input
                        .get("project_ref")
                        .is_none_or(|p| kind == "drama" && p["project_id"] == *object_id)
            }
            "hetu.reports.get"
            | "hetu.findings.disposition"
            | "hetu.findings.suggest"
            | "hetu.findings.suggestions" => self.plot_in_work(
                text(
                    &self.report_descriptor(text(input, "report_id")?)?["input_snapshot"],
                    "plot_revision_id",
                )?,
                &reference,
            )?,
            "hetu.drama.get_skeleton"
            | "hetu.drama.edit_skeleton"
            | "hetu.drama.list_comparisons" => {
                let (skeleton, _) =
                    self.read_skeleton(text(input, "skeleton_id")?, input["revision"].as_u64())?;
                self.plot_in_work(&skeleton.plot_revision_id, &reference)?
            }
            "hetu.drama.compare" | "hetu.drama.create_script" => {
                let (skeleton, _) = self.read_skeleton(
                    text(&input["skeleton_ref"], "skeleton_id")?,
                    Some(integer(&input["skeleton_ref"], "revision")?),
                )?;
                let mut valid = self.plot_in_work(&skeleton.plot_revision_id, &reference)?;
                if action == "hetu.drama.compare" {
                    valid &= self.sources_in_work(&input["source_revisions"], &reference)?;
                }
                if let Some(id) = input["episode_id"].as_str() {
                    valid &= kind == "drama"
                        && self.read_drama_episode(id, None)?.0["project_id"] == *object_id;
                }
                valid
            }
            "hetu.drama.get_comparison" => {
                let comparison = self.get_comparison(input)?;
                self.sources_in_work(&comparison["comparison"]["source_revisions"], &reference)?
            }
            "hetu.drama.get_script_mapping" => {
                self.document_in_work(&self.document(text(input, "document_id")?)?, &reference)?
            }
            "hetu.drafts.get"
            | "hetu.reviews.begin"
            | "hetu.reviews.decide"
            | "hetu.reviews.validate" => {
                let draft = self.draft_content(text(input, "draft_id")?)?;
                self.draft_work_owner(&draft["draft"])?.as_ref() == Some(&reference)
            }
            "hetu.drafts.preview_adoption" => {
                let draft = self.draft_content(text(&input["draft_ref"], "draft_id")?)?;
                let owned = self.draft_work_owner(&draft["draft"])?.as_ref() == Some(&reference);
                owned
                    && match input["target_ref"]["document_id"].as_str() {
                        Some(id) => self.document_in_work(&self.document(id)?, &reference)?,
                        None => true,
                    }
            }
            "hetu.drafts.adopt" => {
                return self.check_work_access(
                    "hetu.drafts.preview_adoption",
                    &input["preview"]["request"],
                );
            }
            "hetu.outlines.get" | "hetu.outlines.save" => kind == "novel",
            "hetu.covers.get" => kind == "novel",
            "hetu.covers.select" => {
                kind == "novel"
                    && input["source"]["kind"] == "asset"
                    && self.media_in_work(
                        "asset",
                        text(&input["source"]["asset_ref"], "asset_id")?,
                        Some(integer(&input["source"]["asset_ref"], "revision")?),
                        &reference,
                    )?
            }
            "hetu.documents.preview_import" => {
                input["work_ref"] == reference
                    && matches!(kind.as_str(), Some("novel" | "drama"))
                    && input.get("inline_source").is_some()
                    && input.get("file_path").is_none()
            }
            "hetu.documents.import" => {
                input["work_ref"] == reference
                    && input["preview"]["request"]["work_ref"] == reference
                    && input["preview"]["request"].get("inline_source").is_some()
                    && input["preview"]["request"].get("file_path").is_none()
                    && match kind.as_str() {
                        Some("novel") => {
                            input["kind"] == "novel_chapter"
                                && input["novel_expected"].is_object()
                                && input.get("drama_project_ref").is_none()
                        }
                        Some("drama") => {
                            input["kind"] == "drama_script"
                                && input["drama_project_ref"]["project_id"] == *object_id
                                && input.get("novel_expected").is_none()
                                && input["volume_id"].is_null()
                        }
                        _ => false,
                    }
            }
            "hetu.import_authorizations.register" => {
                input["work_ref"] == reference && kind == "novel"
            }
            "hetu.import_authorizations.get" | "hetu.import_authorizations.revoke" => {
                kind == "novel"
            }
            "hetu.documents.import_batch" => {
                input["work_ref"] == reference
                    && kind == "novel"
                    && input["items"].as_array().is_some_and(|items| {
                        items.iter().all(|item| {
                            let source = &item["source"];
                            source.get("inline_source").is_some()
                                && source.get("file_path").is_none()
                                && source.get("work_ref").is_none_or(|work| *work == reference)
                        })
                    })
            }
            "hetu.documents.preview_export" | "hetu.bundles.preview" => {
                if input["work_ref"] != reference {
                    false
                } else {
                    self.check_delivery_work(input, action == "hetu.bundles.preview")?;
                    true
                }
            }
            "hetu.documents.export" | "hetu.bundles.export" => {
                let request = &input["preview"]["request"];
                if request["work_ref"] != reference {
                    false
                } else {
                    self.check_delivery_work(request, action == "hetu.bundles.export")?;
                    true
                }
            }
            "hetu.bundles.verify" => input["work_ref"] == reference,
            "hetu.git.status"
            | "hetu.git.diff"
            | "hetu.git.log"
            | "hetu.git.read_version"
            | "hetu.git.list_snapshots"
            | "hetu.git.init" => {
                input["work_ref"] == reference && matches!(kind.as_str(), Some("novel" | "drama"))
            }
            "hetu.git.snapshot"
            | "hetu.git.get_snapshot"
            | "hetu.git.snapshot_diff"
            | "hetu.git.record_snapshot_decision" => {
                if input["work_ref"] != reference
                    || !matches!(kind.as_str(), Some("novel" | "drama"))
                {
                    false
                } else if input["snapshot_id"].is_string() {
                    self.check_git_snapshot_work(input)?;
                    true
                } else {
                    true
                }
            }

            "hetu.creative_tasks.list" => {
                input["work_ref"] == reference
                    && match input["target_document_id"].as_str() {
                        Some(document_id) => {
                            self.document_in_work(&self.document(document_id)?, &reference)?
                        }
                        None => true,
                    }
            }
            "hetu.creative_tasks.get" | "hetu.creative_tasks.assess" => {
                self.check_task_work_access(input, &reference)?;
                true
            }
            "hetu.resources.list" | "hetu.resources.create" => input["work_ref"] == reference,
            "hetu.assets.list" => input["work_ref"] == reference,
            "hetu.cues.list" => {
                input["work_ref"] == reference
                    && match input["document_id"].as_str() {
                        Some(id) => {
                            self.document_work_ref(&self.document(id)?)?.as_ref()
                                == Some(&reference)
                        }
                        None => true,
                    }
            }
            "hetu.assets.get" | "hetu.assets.update" => {
                self.media_in_work(
                    "asset",
                    text(input, "asset_id")?,
                    input["revision"].as_u64(),
                    &reference,
                )? && input
                    .get("work_ref")
                    .is_none_or(|owner| *owner == reference)
            }
            "hetu.cues.get" => self.media_in_work(
                "cue",
                text(input, "cue_id")?,
                input["revision"].as_u64(),
                &reference,
            )?,
            "hetu.assets.inspect" | "hetu.assets.import" => {
                input["work_ref"] == reference
                    && input.get("inline_source").is_some()
                    && input.get("file_path").is_none()
            }
            "hetu.cues.save" => {
                let owned = if let Some(id) = input["cue_id"].as_str() {
                    self.media_in_work("cue", id, None, &reference)?
                        && input
                            .get("work_ref")
                            .is_none_or(|owner| *owner == reference)
                } else {
                    input["work_ref"] == reference
                };
                let mut valid = owned;
                for source in input["narrative_refs"].as_array().into_iter().flatten() {
                    valid &= self
                        .document_work_ref(&self.document(text(source, "document_id")?)?)?
                        .as_ref()
                        == Some(&reference);
                }
                for source in input["asset_refs"].as_array().into_iter().flatten() {
                    valid &= self.media_in_work(
                        "asset",
                        text(source, "asset_id")?,
                        Some(integer(source, "revision")?),
                        &reference,
                    )?;
                }
                valid
            }
            "hetu.resources.get"
            | "hetu.resources.update"
            | "hetu.resources.adopt"
            | "hetu.resources.archive"
            | "hetu.resource_usages.list" => self.resource_in_work(
                text(input, "resource_id")?,
                input["revision"].as_u64(),
                &reference,
            )?,
            "hetu.resource_usages.save" => {
                let source = &input["resource_ref"];
                let mut valid = self.resource_in_work(
                    text(source, "resource_id")?,
                    Some(integer(source, "revision")?),
                    &reference,
                )?;
                if let Some(id) = input["usage_id"].as_str() {
                    let old = self
                        .versioned_record("resources/usages", id, "usage_id", None)?
                        .0;
                    valid &= self.resource_in_work(
                        text(&old["resource_ref"], "resource_id")?,
                        Some(integer(&old["resource_ref"], "revision")?),
                        &reference,
                    )?;
                }
                valid
                    && self
                        .document_work_ref(
                            &self.document(text(&input["target_ref"], "document_id")?)?,
                        )?
                        .as_ref()
                        == Some(&reference)
            }
            "hetu.blueprints.get"
            | "hetu.blueprints.preview_change"
            | "hetu.blueprints.save"
            | "hetu.blueprints.lock"
            | "hetu.blueprints.unlock"
            | "hetu.blueprints.initialize" => input["work_ref"] == reference,
            "hetu.creative_tasks.preview_prompt"
            | "hetu.creative_tasks.prepare"
            | "hetu.image_tasks.preview_prompt"
            | "hetu.image_tasks.prepare" => self.task_sources_in_work(&reference, input)?,
            "hetu.handoffs.get" => {
                input["object_ref"]["work_ref"] == reference
                    && self.handoff_objects_in_work(&reference, &input["object_ref"])?
                    && match input["view_kind"].as_str() {
                        Some("video") => kind == "video",
                        Some("drama" | "episode") => kind == "drama",
                        Some("book" | "novel" | "structure") => kind == "novel",
                        Some("related_works") => true,
                        Some(
                            "bible" | "entity" | "artwork" | "resources" | "resource" | "media",
                        ) => true,
                        Some("import" | "delivery" | "git") => {
                            matches!(kind.as_str(), Some("novel" | "drama"))
                        }
                        _ => false,
                    }
            }
            "hetu.novels.get" | "hetu.novels.update" | "hetu.novels.save_structure" => {
                kind == "novel"
            }
            "hetu.drama.projects.list" => kind == "drama",
            "hetu.drama.projects.get" => kind == "drama" && input["project_id"] == *object_id,
            "hetu.drama.projects.update"
            | "hetu.drama.episodes.create"
            | "hetu.drama.episodes.update"
            | "hetu.drama.episodes.reorder" => {
                kind == "drama" && input["project_ref"]["project_id"] == *object_id
            }
            "hetu.drama.episodes.get" => {
                kind == "drama"
                    && self.read_drama_episode(text(input, "episode_id")?, None)?.0["project_id"]
                        == *object_id
            }
            "hetu.video.media.save" | "hetu.video.media.get" | "hetu.video.media.list"
            | "hetu.video.feedback.save" | "hetu.video.feedback.list" | "hetu.video.delivery.preview"
            | "hetu.assets.read_blob" => input["work_ref"] == reference,
            "hetu.video.projects.get" => kind == "video" && input["video_project_id"] == *object_id,
            "hetu.video.projects.update"
            | "hetu.video.episodes.create"
            | "hetu.video.episodes.update"
            | "hetu.video.episodes.reorder" => {
                kind == "video" && input["project_ref"]["video_project_id"] == *object_id
            }
            "hetu.video.episodes.get" => {
                kind == "video"
                    && self
                        .versioned_record(
                            "packages/video/episodes",
                            text(input, "video_episode_id")?,
                            "video_episode_id",
                            None,
                        )?
                        .0["video_project_id"]
                        == *object_id
            }
            "hetu.agent_operations.prepare" => {
                return self.check_work_access(text(input, "action")?, &input["input"]);
            }
            // 方案读取和执行另外核验固定动作，不能借 proposal_id 读取其他对象。
            "hetu.agent_operations.get"
            | "hetu.agent_operations.execute"
            | "hetu.agent_operations.record_decision" => true,
            _ => false,
        };
        ensure(
            allowed,
            "forbidden",
            "此授权仅覆盖所选创作对象；其他对象及资料须另行授权。",
        )
    }

    /// 任务 ID 和同根目录都不是作品归属；复用固定快照及历史目标的归属核验。
    pub(super) fn check_task_work_access(&self, input: &Value, reference: &Value) -> Result<()> {
        let (request, _, _, _) = self.task_for_reference(&input["task_ref"])?;
        ensure(
            self.task_work_owner(&request)?.as_ref() == Some(reference),
            "forbidden",
            "任务不属于当前创作对象或无法确认其归属。",
        )
    }

    pub(super) fn sources_in_work(&self, sources: &Value, reference: &Value) -> Result<bool> {
        let Some(sources) = sources.as_array().filter(|items| !items.is_empty()) else {
            return Ok(false);
        };
        for source in sources {
            if !self.document_in_work(&self.document(text(source, "document_id")?)?, reference)? {
                return Ok(false);
            }
        }
        Ok(true)
    }
    pub(super) fn plot_in_work(&self, id: &str, reference: &Value) -> Result<bool> {
        self.sources_in_work(&self.plot_descriptor(id)?["source_revisions"], reference)
    }

    fn handoff_objects_in_work(&self, reference: &Value, object: &Value) -> Result<bool> {
        // 页面名称不能为嵌套的他对象引用开后门；尚未建立归属的引用失败关闭。
        if object.as_object().is_none_or(|fields| {
            fields.keys().any(|key| {
                !matches!(
                    key.as_str(),
                    "work_ref"
                        | "snapshot_id"
                        | "git_path"
                        | "git_commit_id"
                        | "project_id"
                        | "episode_id"
                        | "video_episode_id"
                        | "media_ref"
                        | "revision"
                        | "entity_ref"
                        | "blueprint_revision"
                        | "document_id"
                        | "revision_id"
                        | "link_id"
                        | "link_revision"
                        | "resource_id"
                        | "asset_id"
                        | "cue_id"
                )
            })
        }) {
            return Ok(false);
        }
        if let Some(project) = object["project_id"].as_str() {
            if reference["kind"] != "drama" || reference["object_id"] != project {
                return Ok(false);
            }
        }
        if let Some(episode) = object["episode_id"].as_str() {
            if reference["kind"] != "drama"
                || self.read_drama_episode(episode, None)?.0["project_id"] != reference["object_id"]
            {
                return Ok(false);
            }
        }
        if let Some(episode) = object["video_episode_id"].as_str() {
            if reference["kind"] != "video"
                || self
                    .versioned_record("packages/video/episodes", episode, "video_episode_id", None)?
                    .0["video_project_id"]
                    != reference["object_id"]
            {
                return Ok(false);
            }
        }
        if object["media_ref"].is_object() {
            self.fixed_video_media(reference, &object["media_ref"])?;
        }
        if let Some(document) = object["document_id"].as_str() {
            if self.document_work_ref(&self.document(document)?)?.as_ref() != Some(reference) {
                return Ok(false);
            }
        }
        if object["link_id"].is_string() {
            self.get_work_link(&json!({"work_ref":reference,"link_id":object["link_id"],"revision":object["link_revision"]}))?;
        }
        if let Some(id) = object["resource_id"].as_str() {
            if !self.resource_in_work(id, object["revision"].as_u64(), reference)? {
                return Ok(false);
            }
        }
        for kind in ["asset", "cue"] {
            if let Some(id) = object[format!("{kind}_id")].as_str() {
                if !self.media_in_work(kind, id, object["revision"].as_u64(), reference)? {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }
}
