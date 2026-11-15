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
        Ok(json!({"workspace":config,"properties":properties,"access":{"write_available":self.store.write_available()?}}))
    }
    pub(super) fn granted_work(&self) -> Result<Option<Value>> {
        self.management_grant.as_ref().map(crate::collaboration::authoring::granted_work).transpose().map(Option::flatten)
    }

    pub(super) fn check_work_access(&self, action: &str, input: &Value) -> Result<()> {
        let Some(reference) = self.granted_work()? else { return Ok(()); };
        let object_id = &reference["object_id"];
        let kind = &reference["kind"];
        let allowed = match action {
            "hetu.capabilities.get" | "hetu.operations.get" | "hetu.workspaces.get" |
            "hetu.works.list" | "hetu.agent_operations.list" => true,
            "hetu.works.get" | "hetu.work_links.list" => input["work_ref"] == reference,
            "hetu.blueprints.get" | "hetu.blueprints.preview_change" |
            "hetu.blueprints.save" | "hetu.blueprints.initialize" => input["work_ref"] == reference,
            "hetu.creative_tasks.preview_prompt" | "hetu.creative_tasks.prepare" |
            "hetu.image_tasks.preview_prompt" | "hetu.image_tasks.prepare" => self.task_sources_in_work(&reference, input)?,
            "hetu.handoffs.get" => input["object_ref"]["work_ref"] == reference
                && self.handoff_objects_in_work(&reference, &input["object_ref"])?
                && match input["view_kind"].as_str() {
                    Some("video") => kind == "video",
                    Some("drama" | "episode") => kind == "drama",
                    Some("book" | "novel" | "structure") => kind == "novel",
                    Some("related_works") => true,
                    Some("bible" | "entity") => true,
                    _ => false,
                },
            "hetu.novels.get" | "hetu.novels.update" | "hetu.novels.save_structure" => kind == "novel",
            "hetu.drama.projects.list" => kind == "drama",
            "hetu.drama.projects.get" => kind == "drama" && input["project_id"] == *object_id,
            "hetu.drama.projects.update" | "hetu.drama.episodes.create" | "hetu.drama.episodes.update" |
            "hetu.drama.episodes.reorder" => kind == "drama" && input["project_ref"]["project_id"] == *object_id,
            "hetu.drama.episodes.get" => kind == "drama" && self.read_drama_episode(text(input, "episode_id")?, None)?.0["project_id"] == *object_id,
            "hetu.video.projects.get" => kind == "video" && input["video_project_id"] == *object_id,
            "hetu.video.projects.update" | "hetu.video.episodes.create" => kind == "video" && input["project_ref"]["video_project_id"] == *object_id,
            "hetu.video.episodes.get" => kind == "video" && self.versioned_record("packages/video/episodes", text(input,"video_episode_id")?, "video_episode_id", None)?.0["video_project_id"] == *object_id,
            "hetu.agent_operations.prepare" => return self.check_work_access(text(input,"action")?, &input["input"]),
            // 方案读取和执行另外核验固定动作，不能借 proposal_id 读取其他对象。
            "hetu.agent_operations.get" | "hetu.agent_operations.execute" => true,
            _ => false,
        };
        ensure(allowed, "forbidden", "此授权仅覆盖所选创作对象；其他对象及资料须另行授权。")
    }

    fn handoff_objects_in_work(&self, reference: &Value, object: &Value) -> Result<bool> {
        // 页面名称不能为嵌套的他对象引用开后门；尚未建立归属的引用失败关闭。
        if object.as_object().is_none_or(|fields| fields.keys().any(|key| !matches!(key.as_str(),
            "work_ref" | "project_id" | "episode_id" | "video_episode_id" | "revision" | "entity_ref" | "blueprint_revision"))) {
            return Ok(false);
        }
        if let Some(project) = object["project_id"].as_str() {
            if reference["kind"] != "drama" || reference["object_id"] != project { return Ok(false); }
        }
        if let Some(episode) = object["episode_id"].as_str() {
            if reference["kind"] != "drama" || self.read_drama_episode(episode, None)?.0["project_id"] != reference["object_id"] { return Ok(false); }
        }
        if let Some(episode) = object["video_episode_id"].as_str() {
            if reference["kind"] != "video" || self.versioned_record("packages/video/episodes", episode, "video_episode_id", None)?.0["video_project_id"] != reference["object_id"] { return Ok(false); }
        }
        Ok(true)
    }
}
