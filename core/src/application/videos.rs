//! 视频项目独立于小说和剧本；本模块不调用模型或执行制作工具。
use super::*;
use std::collections::BTreeSet;

const PROJECTS: &str = "packages/video/projects";
const EPISODES: &str = "packages/video/episodes";

impl Kernel {
    pub(super) fn video_project(&self, object_id: &str, revision: Option<u64>) -> Result<Value> {
        checked_id(object_id, "video")?;
        let record = self
            .versioned_record(PROJECTS, object_id, "video_project_id", revision)?
            .0;
        schema(&record, &works::definition("video_project"))?;
        Ok(record)
    }

    pub(super) fn create_video_project(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        ensure(
            !text(input, "title")?.trim().is_empty(),
            "invalid_input",
            "视频项目名称不能为空。",
        )?;
        let record = json!({"schema_version":"1.0.0","workspace_id":self.scope(),"video_project_id":id("video"),
            "revision":1,"previous_sha256":null,"title":input["title"],"brief":input["brief"],
            "language_tag":input["language_tag"],"episode_refs":[],"archived":false,
            "created_at":now(),"updated_at":now(),"actor_ref":self.actor()});
        schema(&record, &works::definition("video_project"))?;
        let sha = self.stage_versioned_record(PROJECTS, "video_project_id", &record, changes)?;
        self.stage_new_work_canon(
            &self.work_ref("video", &record["video_project_id"]),
            changes,
        )?;
        Ok(
            json!({"project":record,"sha256":sha,"work_ref":self.work_ref("video", &record["video_project_id"])}),
        )
    }

    fn expected_video_project(&self, reference: &Value) -> Result<Value> {
        let current = self.video_project(text(reference, "video_project_id")?, None)?;
        ensure(
            reference["revision"] == current["revision"]
                && reference["sha256"] == digest(bytes(&current)?),
            "revision_conflict",
            "视频项目已有更新，请重新读取并比较。",
        )?;
        ensure(
            current["archived"] != true,
            "forbidden",
            "请先恢复已归档的视频项目。",
        )?;
        Ok(current)
    }

    pub(super) fn get_video_project(&self, input: &Value) -> Result<Value> {
        let record =
            self.video_project(text(input, "video_project_id")?, input["revision"].as_u64())?;
        let mut episodes = Vec::new();
        for (index, episode_id) in record["episode_refs"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            let (episode, sha, _) = self.versioned_record(
                EPISODES,
                episode_id.as_str().unwrap(),
                "video_episode_id",
                None,
            )?;
            schema(&episode, &works::definition("video_episode"))?;
            ensure(
                episode["video_project_id"] == record["video_project_id"],
                "hetu.integrity_failure",
                "视频分集不属于该项目。",
            )?;
            episodes.push(json!({"episode":episode,"sha256":sha,"episode_number":index+1}));
        }
        Ok(
            json!({"project":record,"sha256":digest(bytes(&record)?),"episodes":episodes,
            "work_ref":self.work_ref("video", &record["video_project_id"])}),
        )
    }

    pub(super) fn update_video_project(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let mut record =
            self.video_project(text(&input["project_ref"], "video_project_id")?, None)?;
        ensure(
            input["project_ref"]["revision"] == record["revision"]
                && input["project_ref"]["sha256"] == digest(bytes(&record)?),
            "revision_conflict",
            "视频项目已有更新，请重新读取。",
        )?;
        ensure(
            !text(input, "title")?.trim().is_empty(),
            "invalid_input",
            "视频项目名称不能为空。",
        )?;
        let sha = digest(bytes(&record)?);
        self.advance_record(&mut record, &sha)?;
        for field in ["title", "brief", "archived"] {
            record[field] = input[field].clone();
        }
        schema(&record, &works::definition("video_project"))?;
        let sha = self.stage_versioned_record(PROJECTS, "video_project_id", &record, changes)?;
        Ok(json!({"project":record,"sha256":sha}))
    }

    pub(super) fn create_video_episode(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let mut project = self.expected_video_project(&input["project_ref"])?;
        ensure(
            !text(input, "title")?.trim().is_empty(),
            "invalid_input",
            "视频分集名称不能为空。",
        )?;
        ensure(
            project["episode_refs"].as_array().unwrap().len() < 10000,
            "hetu.budget_exceeded",
            "视频分集数量超过预算。",
        )?;
        let record = json!({"schema_version":"1.0.0","workspace_id":self.scope(),"video_episode_id":id("vepisode"),
            "video_project_id":project["video_project_id"],"revision":1,"previous_sha256":null,
            "title":input["title"],"brief":input["brief"],"archived":false,
            "created_at":now(),"updated_at":now(),"actor_ref":self.actor()});
        schema(&record, &works::definition("video_episode"))?;
        let episode_sha =
            self.stage_versioned_record(EPISODES, "video_episode_id", &record, changes)?;
        let previous = digest(bytes(&project)?);
        self.advance_record(&mut project, &previous)?;
        project["episode_refs"]
            .as_array_mut()
            .unwrap()
            .push(record["video_episode_id"].clone());
        let sha = self.stage_versioned_record(PROJECTS, "video_project_id", &project, changes)?;
        Ok(json!({"episode":record,"episode_sha256":episode_sha,"project":project,"sha256":sha}))
    }

    pub(super) fn get_video_episode(&self, input: &Value) -> Result<Value> {
        let object_id = checked_id(text(input, "video_episode_id")?, "vepisode")?;
        let (record, sha, current) = self.versioned_record(
            EPISODES,
            &object_id,
            "video_episode_id",
            input["revision"].as_u64(),
        )?;
        schema(&record, &works::definition("video_episode"))?;
        let project = self.video_project(text(&record, "video_project_id")?, None)?;
        let index = project["episode_refs"]
            .as_array()
            .unwrap()
            .iter()
            .position(|v| v.as_str() == Some(object_id.as_str()))
            .ok_or_else(|| Error::new("hetu.integrity_failure", "视频分集未登记在项目中。"))?;
        Ok(
            json!({"episode":record,"sha256":sha,"is_head":current["revision"]==record["revision"],
            "episode_number":index+1,"work_ref":self.work_ref("video", &record["video_project_id"]),
            "project_ref":{"video_project_id":project["video_project_id"],"revision":project["revision"],"sha256":digest(bytes(&project)?)}}),
        )
    }

    pub(super) fn update_video_episode(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let project = self.expected_video_project(&input["project_ref"])?;
        let episode_id = checked_id(text(input, "video_episode_id")?, "vepisode")?;
        let (mut episode, sha, _) =
            self.versioned_record(EPISODES, &episode_id, "video_episode_id", None)?;
        ensure(
            episode["video_project_id"] == project["video_project_id"]
                && project["episode_refs"]
                    .as_array()
                    .unwrap()
                    .contains(&episode["video_episode_id"]),
            "invalid_input",
            "视频分集不属于当前项目。",
        )?;
        ensure(
            input["expected"] == json!({"revision":episode["revision"],"sha256":sha}),
            "revision_conflict",
            "视频分集已有更新，请重新读取并比较。",
        )?;
        ensure(
            !text(input, "title")?.trim().is_empty(),
            "invalid_input",
            "视频分集名称不能为空。",
        )?;
        self.advance_record(&mut episode, &sha)?;
        for field in ["title", "brief", "archived"] {
            episode[field] = input[field].clone();
        }
        schema(&episode, &works::definition("video_episode"))?;
        let sha = self.stage_versioned_record(EPISODES, "video_episode_id", &episode, changes)?;
        Ok(json!({"episode":episode,"sha256":sha}))
    }

    pub(super) fn reorder_video_episodes(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let mut project = self.expected_video_project(&input["project_ref"])?;
        let previous: BTreeSet<_> = project["episode_refs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        let requested = input["episode_refs"].as_array().unwrap();
        ensure(
            requested.len() == previous.len()
                && requested
                    .iter()
                    .map(|v| v.as_str().unwrap())
                    .collect::<BTreeSet<_>>()
                    == previous,
            "invalid_input",
            "视频分集重排必须包含完整且不重复的原目录。",
        )?;
        let previous_sha = digest(bytes(&project)?);
        self.advance_record(&mut project, &previous_sha)?;
        project["episode_refs"] = input["episode_refs"].clone();
        let sha = self.stage_versioned_record(PROJECTS, "video_project_id", &project, changes)?;
        Ok(json!({"project":project,"sha256":sha}))
    }
}
