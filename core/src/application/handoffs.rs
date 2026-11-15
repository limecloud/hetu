//! 页面交接消费真实领域动作，不将页面按钮或提示词当作执行能力。
use super::*;

impl Kernel {
    fn handoff_blueprint(&self, object: &Value) -> Result<Option<(Value, String)>> {
        if object["work_ref"].is_object() {
            self.work_blueprint_revision(&object["work_ref"], object["blueprint_revision"].as_u64())
        } else { self.blueprint_revision(object["blueprint_revision"].as_u64()).map(Some) }
    }
    pub(super) fn page_handoff(&self, input: &Value) -> Result<Value> {
        ensure(
            self.task_id.is_none() && (self.management_grant.is_none() || self.management_grant.as_ref().is_some_and(|v| v["kind"] == "workspace")),
            "forbidden",
            "页面交接需要明确作品入口，不能扩大单任务权限。",
        )?;
        let page = text(input, "view_kind")?;
        let mut fixed = Vec::new();
        let object = &input["object_ref"];
        if object["work_ref"].is_object() {
            let record = self.work_record(&object["work_ref"], None)?;
            fixed.push(json!({"kind":"work","fixed_ref":self.work_revision_ref(&object["work_ref"], &record)?}));
            ensure(page != "video" || object["work_ref"]["kind"] == "video", "invalid_input", "视频页面须定位视频项目。")?;
        }
        if let Some(episode) = object["video_episode_id"].as_str() {
            let value = self.get_video_episode(&json!({"video_episode_id":episode,"revision":object["revision"]}))?;
            ensure(object["work_ref"] == value["work_ref"], "invalid_input", "视频分集不属于当前项目。")?;
            fixed.push(json!({"kind":"video_episode","video_episode_id":episode,"revision":value["episode"]["revision"],"sha256":value["sha256"]}));
        }
        if let Some(document) = object["document_id"].as_str() {
            let value = self.document_content(document, object["revision_id"].as_str())?;
            fixed.push(json!({"kind":"document","document_id":document,"revision_id":value["revision"]["revision_id"],"sha256":value["revision"]["sha256"]}));
            if object.get("byte_start").is_some() || object.get("byte_end").is_some() || object.get("quote").is_some() {
                let content = text(&value,"content")?;
                let start = integer(object,"byte_start")? as usize;
                let end = integer(object,"byte_end")? as usize;
                ensure(start <= end && content.get(start..end) == object["quote"].as_str(), "hetu.stale_evidence", "交接选区与固定原文不一致。")?;
                fixed.push(json!({"kind":"source_range","document_id":document,"revision_id":value["revision"]["revision_id"],"byte_start":start,"byte_end":end,"quote":object["quote"]}));
            }
        }
        ensure(["byte_start", "byte_end", "quote"].iter().all(|key| object.get(key).is_none()) || object["document_id"].is_string(), "invalid_input", "选区需要明确的原文文档。")?;
        ensure(object.get("skeleton_revision").is_none() || object["skeleton_id"].is_string(), "invalid_input", "骨架版本需要明确的骨架。")?;
        ensure(object.get("finding_id").is_none() || object["report_id"].is_string(), "invalid_input", "问题需要明确的报告。")?;
        if let Some(plot) = object["plot_revision_id"].as_str() {
            self.read_plot(plot)?;
            fixed.push(json!({"kind":"plot","plot_revision_id":plot,"sha256":self.plot_descriptor(plot)?["sha256"]}));
        }
        if let Some(id) = object["skeleton_id"].as_str() {
            let (skeleton, sha) = self.read_skeleton(id, object["skeleton_revision"].as_u64())?;
            if let Some(scene) = object["scene_id"].as_str() {
                let value = serde_json::to_value(&skeleton)?;
                ensure(value["episodes"].as_array().is_some_and(|items|items.iter().any(|ep|ep["scenes"].as_array().is_some_and(|scenes|scenes.iter().any(|item|item["scene_id"] == scene)))), "not_found", "场次不属于固定骨架。")?;
                fixed.push(json!({"kind":"scene","skeleton_id":id,"skeleton_revision":skeleton.revision,"scene_id":scene}));
            }
            fixed.push(json!({"kind":"skeleton","skeleton_id":id,"revision":skeleton.revision,"sha256":sha}));
        }
        ensure(object.get("scene_id").is_none() || object["skeleton_id"].is_string(), "invalid_input", "场次需要明确的骨架。")?;
        if let Some(snapshot) = object["snapshot_id"].as_str() {
            let value = self.get_git_snapshot(&json!({"snapshot_id":snapshot}))?;
            fixed.push(json!({"kind":"git_snapshot","snapshot_id":snapshot,"sha256":value["snapshot_sha256"]}));
        }
        if let Some(path) = object["git_path"].as_str() {
            let value = self.git_diff(&json!({"path":path}))?;
            fixed.push(json!({"kind":"git_difference","path":path,"head":value["head"],"before_oid":value["before_oid"],"after_sha256":value["after_sha256"]}));
        }
        if let Some(commit) = object["git_commit_id"].as_str() {
            let value = self.git_version(&json!({"commit_id":commit}))?;
            fixed.push(json!({"kind":"git_commit","commit_id":commit,"timestamp":value["timestamp"]}));
        }
        if let Some(asset) = object["asset_id"].as_str() {
            let value = self.get_asset(&json!({"asset_id":asset,"revision":object["revision"]}))?;
            fixed.push(json!({"kind":"asset","asset_id":asset,"revision":value["asset"]["revision"],"sha256":value["sha256"]}));
        }
        if let Some(cue) = object["cue_id"].as_str() {
            let value = self.get_cue(&json!({"cue_id":cue,"revision":object["revision"]}))?;
            fixed.push(json!({"kind":"cue","cue_id":cue,"revision":value["cue"]["revision"],"sha256":value["sha256"]}));
        }
        if let Some(entity) = object["entity_ref"].as_str() {
            let (blueprint, sha) = self.handoff_blueprint(object)?
                .ok_or_else(|| Error::new("hetu.canon_initialization_required", "此作品尚未建立自身设定。"))?;
            ensure(
                [
                    "characters",
                    "factions",
                    "locations",
                    "timeline",
                    "world",
                    "rules",
                ]
                .iter()
                .any(|key| {
                    blueprint[key].as_array().is_some_and(|items| {
                        items.iter().any(|item| {
                            item.as_object()
                                .is_some_and(|fields| fields.values().any(|v| v == entity))
                        })
                    })
                }),
                "not_found",
                "设定对象不属于该固定版本。",
            )?;
            fixed.push(json!({"kind":"blueprint","work_ref":object["work_ref"],"blueprint_id":blueprint["blueprint_id"],"revision":blueprint["revision"],"sha256":sha,"entity_ref":entity}));
        }
        if let Some(project) = object["project_id"].as_str() {
            let value = self.drama_project(project)?;
            fixed.push(json!({"kind":"drama_project","project_id":project,"revision":value["revision"],"sha256":digest(bytes(&value)?)}));
        }
        if let Some(episode) = object["episode_id"].as_str() {
            let value = self
                .get_drama_episode(&json!({"episode_id":episode,"revision":object["revision"]}))?;
            fixed.push(json!({"kind":"drama_episode","episode_id":episode,"revision":value["episode"]["revision"],"sha256":value["sha256"]}));
        }
        if let Some(resource) = object["resource_id"].as_str() {
            let value =
                self.get_resource(&json!({"resource_id":resource,"revision":object["revision"]}))?;
            fixed.push(json!({"kind":"resource","resource_id":resource,"revision":value["resource"]["revision"],"sha256":value["sha256"]}));
        }
        if let Some(draft) = object["draft_id"].as_str() {
            let value = self.draft_content(draft)?;
            fixed.push(json!({"kind":"draft","draft_id":draft,"revision":value["draft"]["revision"],"sha256":value["draft"]["content_sha256"]}));
        }
        if let Some(report) = object["report_id"].as_str() {
            let value = self.read_report(report)?;
            if let Some(finding) = object["finding_id"].as_str() {
                ensure(value["findings"].as_array().is_some_and(|items| items.iter().any(|item| item["finding_id"] == finding)), "not_found", "问题不属于固定报告。")?;
                fixed.push(json!({"kind":"finding","report_id":report,"finding_id":finding}));
            }
            fixed.push(json!({"kind":"report","report_id":report,"sha256":digest(bytes(&value)?)}));
        }
        let (wanted, missing): (&[&str], &[&str]) = match page {
            "related_works" => (
                &["hetu.works.list", "hetu.works.get", "hetu.work_links.list", "hetu.work_links.create"], &[],
            ),
            "video" => (
                &["hetu.works.get", "hetu.work_links.list", "hetu.video.projects.get", "hetu.video.projects.update", "hetu.video.episodes.create", "hetu.video.episodes.get"],
                &["video_media_task_required"],
            ),
            "book" => (
                &[
                    "hetu.novels.get",
                    "hetu.novels.initialize",
                    "hetu.novels.update",
                ],
                &[],
            ),
            "novel" | "structure" => (
                &[
                    "hetu.novels.get",
                    "hetu.documents.list",
                    "hetu.documents.get",
                    "hetu.documents.create",
                    "hetu.novels.save_structure",
                    "hetu.outlines.get",
                    "hetu.outlines.save",
                ],
                &[],
            ),
            "document" | "search" | "notes" => (
                &[
                    "hetu.documents.get",
                    "hetu.documents.history",
                    "hetu.outlines.get",
                    "hetu.outlines.save",
                ],
                &["unsaved_buffer_and_private_notes"],
            ),
            "bible" | "entity" => (
                &["hetu.blueprints.get", "hetu.blueprints.initialize", "hetu.blueprints.save"],
                &["author_unlock_required"],
            ),
            "drama" | "episode" => (
                &[
                    "hetu.drama.projects.list",
                    "hetu.drama.projects.get",
                    "hetu.drama.episodes.get",
                    "hetu.drama.projects.create",
                    "hetu.drama.projects.update",
                    "hetu.drama.episodes.create",
                    "hetu.drama.episodes.update",
                    "hetu.drama.episodes.reorder",
                    "hetu.drama.build_skeleton",
                    "hetu.drama.compare",
                    "hetu.drama.get_skeleton", "hetu.drama.list_skeletons", "hetu.drama.edit_skeleton",
                    "hetu.drama.create_script", "hetu.drama.get_script_mapping", "hetu.drama.projects.attach",
                ],
                &[],
            ),
            "resources" | "resource" | "media" | "artwork" | "cover" => (
                &[
                    "hetu.resources.list",
                    "hetu.resources.get",
                    "hetu.resource_usages.list",
                    "hetu.assets.list",
                    "hetu.assets.get",
                    "hetu.cues.list",
                    "hetu.cues.get",
                    "hetu.assets.inspect", "hetu.assets.import", "hetu.assets.update", "hetu.cues.save", "hetu.resource_usages.save",
                    "hetu.image_tasks.preview_prompt",
                    "hetu.image_tasks.prepare",
                ],
                &[
                    "resource_task_required",
                ],
            ),
            "plot" => (
                &[
                    "hetu.documents.list",
                    "hetu.documents.get",
                    "hetu.plot.extract",
                    "hetu.plot.list",
                    "hetu.plot.get",
                    "hetu.plot.correct",
                ],
                &[],
            ),
            "validation" => (
                &[
                    "hetu.reports.list",
                    "hetu.reports.get",
                    "hetu.validation.run",
                    "hetu.findings.suggest", "hetu.findings.suggestions",
                    "hetu.plot.list",
                    "hetu.plot.get",
                ],
                &["finding_disposition_requires_author"],
            ),
            "reviews" => (
                &[
                    "hetu.reviews.list",
                    "hetu.reviews.get",
                    "hetu.reviews.validate",
                    "hetu.drafts.get",
                ],
                &[
                    "task_required_for_feedback_and_revisions",
                    "author_adoption_and_finalization",
                ],
            ),
            "git" => (
                &[
                    "hetu.git.status",
                    "hetu.git.init",
                    "hetu.git.diff",
                    "hetu.git.log",
                    "hetu.git.snapshot",
                    "hetu.git.list_snapshots",
                    "hetu.git.get_snapshot",
                    "hetu.git.snapshot_diff",
                    "hetu.git.references", "hetu.git.read_version", "hetu.git.merge_preview", "hetu.git.branch_create", "hetu.git.branch_switch",
                    "hetu.git.merge", "hetu.git.remote_save", "hetu.git.fetch", "hetu.git.push", "hetu.git.pull",
                ],
                &["author_snapshot_approval"],
            ),
            "delivery" | "import" => (
                &["hetu.bundles.verify", "hetu.bundles.preview", "hetu.bundles.export", "hetu.documents.preview_import", "hetu.documents.import", "hetu.documents.import_batch", "hetu.documents.preview_export", "hetu.documents.export"],
                &[],
            ),
            _ => return Err(Error::new("invalid_input", "未知页面交接类型。")),
        };
        let mut available = Vec::new();
        let mut proposals = Vec::new();
        for name in wanted {
            let metadata = catalog()["actions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["name"] == *name)
                .unwrap();
            if agent_operations::PROPOSABLE.contains(name) {
                proposals.push(metadata.clone());
            } else if self.action_available(metadata) && (metadata["author_only"] == false || metadata["effect"] == "read" && crate::collaboration::authoring::management_action(name)) {
                let mut action = metadata.clone();
                action["author_only"] = json!(false);
                available.push(action);
            }
        }
        if !matches!(page, "delivery" | "import" | "git" | "validation" | "plot") {
            for name in [
                "hetu.creative_tasks.preview_prompt",
                "hetu.creative_tasks.prepare",
            ] {
                let item = catalog()["actions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|item| item["name"] == name)
                    .unwrap();
                if agent_operations::PROPOSABLE.contains(&name) {
                    proposals.push(item.clone());
                } else {
                    available.push(item.clone());
                }
            }
        }
        if matches!(page, "novel" | "structure" | "book" | "document" | "notes") {
            let novel = self.get_novel()?;
            if novel["initialized"] == true {
                fixed.push(
                    json!({"kind":"novel","revision":novel["revision"],"sha256":novel["sha256"]}),
                );
            }
        }
        if matches!(page, "bible" | "entity") && object["entity_ref"].is_null() {
            if let Some((blueprint, sha)) = self.handoff_blueprint(object)? {
                fixed.push(json!({"kind":"blueprint","work_ref":object["work_ref"],"blueprint_id":blueprint["blueprint_id"],"revision":blueprint["revision"],"sha256":sha,"locked":blueprint["lock"]["locked"]}));
            } else {
                fixed.push(json!({"kind":"canon_binding","work_ref":object["work_ref"],"initialized":false}));
            }
        }
        Ok(
            json!({"scope_ref":{"kind":self.scope_kind(),"id":self.scope()},"view_kind":page,"object_ref":object,
            "fixed_refs":fixed,"direct_actions":available,"proposal_actions":proposals,"limitations":missing,
            "workflow":{"prepare":"hetu.agent_operations.prepare","read":"hetu.agent_operations.get","execute":"hetu.agent_operations.execute","author_decision":"native_review"},
            "unsaved_buffer_included":false,"computer_use_required":false}),
        )
    }
}
