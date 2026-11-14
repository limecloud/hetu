use super::*;
use std::collections::BTreeSet;

const PROJECTS: &str = "packages/drama/projects";
const EPISODES: &str = "packages/drama/episodes";

impl Kernel {
    pub(super) fn drama_project(&self, project_id: &str) -> Result<Value> {
        checked_id(project_id, "drama")?;
        let (project, _, _) = self.versioned_record(PROJECTS, project_id, "project_id", None)?;
        schema(
            &project,
            &serde_json::from_str(include_str!(
                "../../../contracts/schemas/drama-project.schema.json"
            ))?,
        )?;
        Ok(project)
    }
    fn drama_project_result(&self, project: Value) -> Result<Value> {
        let mut episodes = Vec::new();
        for (index, episode_id) in project["episode_refs"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            let (episode, sha, _) = self.read_drama_episode(episode_id.as_str().unwrap(), None)?;
            ensure(
                episode["project_id"] == project["project_id"],
                "hetu.integrity_failure",
                "分集不属于当前项目。",
            )?;
            episodes.push(json!({"episode":episode,"sha256":sha,"episode_number":index+1}));
        }
        Ok(json!({"sha256":digest(bytes(&project)?),"project":project,"episodes":episodes}))
    }
    pub(super) fn expected_drama_project(&self, reference: &Value) -> Result<Value> {
        let project = self.drama_project(text(reference, "project_id")?)?;
        ensure(
            reference["revision"] == project["revision"]
                && reference["sha256"] == digest(bytes(&project)?),
            "revision_conflict",
            "短剧项目已有更新，请重新读取并比较。",
        )?;
        ensure(
            project["archived"] != true,
            "forbidden",
            "请先恢复已归档的短剧项目。",
        )?;
        Ok(project)
    }
    fn stage_drama_project(&self, project: &Value, changes: &mut Changes) -> Result<String> {
        schema(
            project,
            &serde_json::from_str(include_str!(
                "../../../contracts/schemas/drama-project.schema.json"
            ))?,
        )?;
        self.stage_versioned_record(PROJECTS, "project_id", project, changes)
    }
    fn advance_project(&self, project: &mut Value) -> Result<()> {
        let sha = digest(bytes(project)?);
        self.advance_record(project, &sha)
    }
    pub(super) fn create_drama_project(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        ensure(
            !text(input, "title")?.trim().is_empty(),
            "invalid_input",
            "请填写短剧项目名称。",
        )?;
        let source_refs = input.get("source_refs").cloned().unwrap_or(json!([]));
        for reference in source_refs.as_array().unwrap() {
            self.fixed_document_ref(reference)?;
        }
        let mode = input["mode"].as_str().unwrap_or("original");
        let project = json!({"schema_version":"2.0.0","project_id":id("drama"),"workspace_id":self.scope(),"revision":1,"previous_sha256":null,
            "title":input["title"],"description":input["description"].as_str().unwrap_or(""),"mode":mode,"source_refs":source_refs,"archived":false,"skeleton_ids":[],"episode_refs":[],"created_at":now(),"updated_at":now(),"actor_ref":self.actor()});
        let sha = self.stage_drama_project(&project, changes)?;
        Ok(json!({"project":project,"sha256":sha,"episodes":[]}))
    }
    pub(super) fn get_drama_project(&self, input: &Value) -> Result<Value> {
        self.drama_project_result(self.drama_project(text(input, "project_id")?)?)
    }
    pub(super) fn list_drama_projects(&self, input: &Value) -> Result<Value> {
        let mut projects = Vec::new();
        for name in self.record_ids(PROJECTS, "drama")? {
            let project = self.drama_project(&name)?;
            if input["include_archived"] == true || project["archived"] != true {
                projects.push(json!({"project":project,"sha256":digest(bytes(&project)?)}));
            }
        }
        self.record_page(input, projects, "projects")
    }
    pub(super) fn update_drama_project(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let reference = &input["project_ref"];
        let mut project = self.drama_project(text(reference, "project_id")?)?;
        ensure(
            reference["revision"] == project["revision"]
                && reference["sha256"] == digest(bytes(&project)?),
            "revision_conflict",
            "短剧项目已有更新，请重新读取并比较。",
        )?;
        ensure(
            !text(input, "title")?.trim().is_empty(),
            "invalid_input",
            "请填写短剧项目名称。",
        )?;
        self.advance_project(&mut project)?;
        for field in ["title", "description", "archived"] {
            project[field] = input[field].clone();
        }
        if let Some(references) = input.get("source_refs") {
            for reference in references.as_array().unwrap() {
                self.fixed_document_ref(reference)?;
            }
            project["source_refs"] = references.clone();
        }
        let sha = self.stage_drama_project(&project, changes)?;
        Ok(json!({"project":project,"sha256":sha}))
    }
    pub(super) fn attach_project_skeleton(
        &self,
        reference: &Value,
        skeleton_id: &str,
        changes: &mut Changes,
    ) -> Result<Value> {
        let mut project = self.expected_drama_project(reference)?;
        if !changes.contains_key(&format!(".hetu/skeletons/{skeleton_id}/head.json")) {
            self.skeleton_descriptor(skeleton_id, None)?;
        }
        for name in self.record_ids(PROJECTS, "drama")? {
            let other = self.drama_project(&name)?;
            ensure(
                other["project_id"] == project["project_id"]
                    || !other["skeleton_ids"]
                        .as_array()
                        .unwrap()
                        .contains(&json!(skeleton_id)),
                "invalid_input",
                "骨架已属于其他短剧项目。",
            )?;
        }
        ensure(
            !project["skeleton_ids"]
                .as_array()
                .unwrap()
                .contains(&json!(skeleton_id)),
            "invalid_input",
            "骨架已在当前项目中。",
        )?;
        self.advance_project(&mut project)?;
        project["skeleton_ids"]
            .as_array_mut()
            .unwrap()
            .push(json!(skeleton_id));
        let sha = self.stage_drama_project(&project, changes)?;
        Ok(json!({"project":project,"sha256":sha}))
    }
    pub(super) fn read_drama_episode(
        &self,
        episode_id: &str,
        revision: Option<u64>,
    ) -> Result<(Value, String, Value)> {
        checked_id(episode_id, "depisode")?;
        let result = self.versioned_record(EPISODES, episode_id, "episode_id", revision)?;
        let source: Value = serde_json::from_str(include_str!(
            "../../../contracts/schemas/drama-episode.schema.json"
        ))?;
        schema(&result.0, &source)?;
        Ok(result)
    }
    pub(super) fn get_drama_episode(&self, input: &Value) -> Result<Value> {
        let (episode, sha, current) =
            self.read_drama_episode(text(input, "episode_id")?, input["revision"].as_u64())?;
        let project = self.drama_project(text(&episode, "project_id")?)?;
        let number = project["episode_refs"]
            .as_array()
            .unwrap()
            .iter()
            .position(|e| *e == episode["episode_id"])
            .map(|i| i + 1);
        Ok(
            json!({"episode":episode,"sha256":sha,"is_head":episode["revision"]==current["revision"],"episode_number":number,
            "project_ref":{"project_id":project["project_id"],"revision":project["revision"],"sha256":digest(bytes(&project)?)}}),
        )
    }
    fn add_episode_document(
        &self,
        mut project: Value,
        mut doc: Value,
        title: &str,
        plan: &str,
        changes: &mut Changes,
    ) -> Result<Value> {
        ensure(
            !title.trim().is_empty(),
            "invalid_input",
            "请填写分集标题。",
        )?;
        let episode_id = id("depisode");
        let document_id = text(&doc, "document_id")?.to_owned();
        let episode = json!({"schema_version":"1.0.0","workspace_id":self.scope(),"episode_id":episode_id,"project_id":project["project_id"],"revision":1,"previous_sha256":null,"title":title,"plan":plan,"document_id":document_id,"archived":false,"created_at":now(),"updated_at":now(),"actor_ref":self.actor()});
        schema(
            &episode,
            &serde_json::from_str(include_str!(
                "../../../contracts/schemas/drama-episode.schema.json"
            ))?,
        )?;
        let episode_sha = self.stage_versioned_record(EPISODES, "episode_id", &episode, changes)?;
        // 文档仅保留归属身份，不重复存集号或标题计划。
        doc["drama_episode_id"] = json!(episode_id);
        changes.insert(
            format!("packages/drama/documents/{document_id}/document.json"),
            bytes(&doc)?,
        );
        self.advance_project(&mut project)?;
        ensure(
            project["episode_refs"].as_array().unwrap().len() < 10_000,
            "hetu.budget_exceeded",
            "分集数量超过项目上限。",
        )?;
        project["episode_refs"]
            .as_array_mut()
            .unwrap()
            .push(json!(episode_id));
        let sha = self.stage_drama_project(&project, changes)?;
        Ok(
            json!({"project":project,"sha256":sha,"episode":episode,"episode_sha256":episode_sha,"document":doc}),
        )
    }
    pub(super) fn attach_drama_project(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        if let Some(skeleton_id) = input["skeleton_id"].as_str() {
            return self.attach_project_skeleton(&input["project_ref"], skeleton_id, changes);
        }
        let project = self.expected_drama_project(&input["project_ref"])?;
        let doc = self.document(text(input, "document_id")?)?;
        ensure(
            doc["kind"] == "drama_script"
                && doc["draft_source_id"].is_null()
                && doc["drama_episode_id"].is_null()
                && doc["drama_project_id"].is_null(),
            "invalid_input",
            "请选择尚未归入项目的写作剧本。",
        )?;
        self.add_episode_document(
            project,
            doc,
            text(input, "title")?,
            input["plan"].as_str().unwrap_or(""),
            changes,
        )
    }
    pub(super) fn create_project_episode(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let project = self.expected_drama_project(&input["project_ref"])?;
        let created = if input.get("skeleton_ref").is_some() {
            ensure(
                project["skeleton_ids"]
                    .as_array()
                    .unwrap()
                    .contains(&input["skeleton_ref"]["skeleton_id"]),
                "invalid_input",
                "骨架不属于当前短剧项目。",
            )?;
            let mut render = input.clone();
            render["episode_id"] = input["skeleton_episode_id"].clone();
            self.create_script(&render, changes)?
        } else {
            self.create_document(&json!({"kind":"drama_script","title":input["title"],"source_format":"fountain","language_tag":input["language_tag"],"content":""}),changes)?
        };
        let mut result = self.add_episode_document(
            project,
            created["document"].clone(),
            text(input, "title")?,
            input["plan"].as_str().unwrap_or(""),
            changes,
        )?;
        result["document_revision"] = created["revision"].clone();
        Ok(result)
    }
    pub(super) fn update_drama_episode(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let (mut episode, sha, _) = self.read_drama_episode(text(input, "episode_id")?, None)?;
        self.expected_drama_project(&input["project_ref"])?;
        ensure(
            episode["project_id"] == input["project_ref"]["project_id"],
            "invalid_input",
            "分集不属于当前项目。",
        )?;
        ensure(
            input["expected"] == json!({"revision":episode["revision"],"sha256":sha}),
            "revision_conflict",
            "分集已有更新，请重新读取并比较。",
        )?;
        ensure(
            !text(input, "title")?.trim().is_empty(),
            "invalid_input",
            "请填写分集标题。",
        )?;
        self.advance_record(&mut episode, &sha)?;
        for field in ["title", "plan", "archived"] {
            episode[field] = input[field].clone();
        }
        let sha = self.stage_versioned_record(EPISODES, "episode_id", &episode, changes)?;
        Ok(json!({"episode":episode,"sha256":sha}))
    }
    pub(super) fn reorder_drama_episodes(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let mut project = self.expected_drama_project(&input["project_ref"])?;
        let previous: BTreeSet<_> = project["episode_refs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        let requested: Vec<_> = input["episode_refs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        ensure(
            requested.len() == previous.len()
                && requested.iter().copied().collect::<BTreeSet<_>>() == previous,
            "invalid_input",
            "分集重排必须包含完整且不重复的原目录。",
        )?;
        self.advance_project(&mut project)?;
        project["episode_refs"] = input["episode_refs"].clone();
        let sha = self.stage_drama_project(&project, changes)?;
        Ok(json!({"project":project,"sha256":sha}))
    }
    fn fixed_document_ref(&self, reference: &Value) -> Result<()> {
        let fixed = self.document_content(
            text(reference, "document_id")?,
            Some(text(reference, "revision_id")?),
        )?;
        ensure(
            fixed["revision"]["sha256"] == reference["sha256"],
            "hetu.stale_evidence",
            "原著来源摘要不一致。",
        )
    }
}
