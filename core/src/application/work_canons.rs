//! 对象自身设定与旧根设定分别解析；旧任务的 revision-only 引用始终保留原义。
use super::*;

fn collection(reference: &Value) -> Result<String> {
    Ok(format!("shared/work-canons/{}", text(reference, "kind")?))
}

impl Kernel {
    fn stage_canon_revision_index(&self, record: &Value, changes: &mut Changes) -> Result<()> {
        let bp = &record["blueprint"];
        let sha = digest(bytes(bp)?);
        let path = format!(".hetu/canon-revisions/{sha}.json");
        let descriptor = json!({"schema_version":"1.0.0","work_ref":record["work_ref"],
            "blueprint_id":bp["blueprint_id"],"revision":bp["revision"],"sha256":sha});
        ensure(
            !self.store.exists(&path)? || self.store.json(&path)? == descriptor,
            "hetu.integrity_failure",
            "固定设定索引已存在且内容不一致。",
        )?;
        changes.insert(path, bytes(&descriptor)?);
        Ok(())
    }

    pub(super) fn blueprint_for_snapshot(
        &self,
        revision: u64,
        sha: &str,
    ) -> Result<(Value, String)> {
        ensure(
            sha.len() == 64
                && sha
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "hetu.integrity_failure",
            "固定设定摘要无效。",
        )?;
        let path = format!(".hetu/canon-revisions/{sha}.json");
        let (bp, actual) = if self.store.exists(&path)? {
            let descriptor = self.store.json(&path)?;
            ensure(
                descriptor["schema_version"] == "1.0.0"
                    && descriptor["revision"] == revision
                    && descriptor["sha256"] == sha,
                "hetu.integrity_failure",
                "固定设定索引修订不一致。",
            )?;
            let value = self
                .work_blueprint_revision(&descriptor["work_ref"], Some(revision))?
                .ok_or_else(|| {
                    Error::new("hetu.integrity_failure", "固定设定所属作品缺少该修订。")
                })?;
            ensure(
                descriptor["blueprint_id"] == value.0["blueprint_id"],
                "hetu.integrity_failure",
                "固定设定身份不一致。",
            )?;
            value
        } else {
            self.blueprint_revision(Some(revision))?
        };
        ensure(
            actual == sha,
            "hetu.integrity_failure",
            "固定设定内容摘要不一致。",
        )?;
        Ok((bp, actual))
    }

    pub(super) fn current_blueprint_for_snapshot(&self, revision: u64, sha: &str) -> Result<Value> {
        let fixed = self.blueprint_for_snapshot(revision, sha)?.0;
        let path = format!(".hetu/canon-revisions/{sha}.json");
        if self.store.exists(&path)? {
            let descriptor = self.store.json(&path)?;
            let (current, _) = self
                .work_blueprint_revision(&descriptor["work_ref"], None)?
                .ok_or_else(|| Error::new("hetu.integrity_failure", "作品自身设定丢失。"))?;
            ensure(
                current["blueprint_id"] == fixed["blueprint_id"],
                "hetu.integrity_failure",
                "作品设定身份发生变化。",
            )?;
            Ok(current)
        } else {
            self.blueprint()
        }
    }

    pub(super) fn stage_resolved_blueprint_snapshot(
        &self,
        bp: &Value,
        changes: &mut Changes,
    ) -> Result<()> {
        if bp["blueprint_id"] == self.store.json("shared/blueprint.json")?["blueprint_id"] {
            stage_blueprint_snapshot(&self.store, bp, changes)
        } else {
            let fixed = self
                .blueprint_for_snapshot(integer(bp, "revision")?, &digest(bytes(bp)?))?
                .0;
            ensure(
                fixed == *bp,
                "hetu.integrity_failure",
                "作品设定与固定版本不一致。",
            )
        }
    }

    pub(super) fn source_blueprint(&self, reference: &Value) -> Result<(Value, String)> {
        if reference["work_ref"].is_object() {
            let (bp, sha) = self
                .work_blueprint_revision(
                    &reference["work_ref"],
                    Some(integer(reference, "revision")?),
                )?
                .ok_or_else(|| {
                    Error::new(
                        "hetu.canon_initialization_required",
                        "作品自身设定尚未建立。",
                    )
                })?;
            ensure(
                reference["blueprint_id"] == bp["blueprint_id"],
                "hetu.stale_evidence",
                "固定设定引用的作品身份不一致。",
            )?;
            Ok((bp, sha))
        } else {
            self.blueprint_revision(Some(integer(reference, "revision")?))
        }
    }

    pub(super) fn document_work_ref(&self, document: &Value) -> Result<Option<Value>> {
        if let Some(episode) = document["drama_episode_id"].as_str() {
            return Ok(Some(self.work_ref(
                "drama",
                &self.read_drama_episode(episode, None)?.0["project_id"],
            )));
        }
        if matches!(
            document["kind"].as_str(),
            Some("novel_chapter" | "novel_outline" | "adaptation_note")
        ) {
            return Ok(self
                .novel()?
                .map(|novel| self.work_ref("novel", &novel["novel_id"])));
        }
        Ok(None)
    }

    /// 调用方已核验作品身份；目录筛选不为每一章重新读取和验证整部小说目录。
    pub(super) fn document_in_work(&self, document: &Value, reference: &Value) -> Result<bool> {
        Ok(match reference["kind"].as_str() {
            Some("novel") => matches!(
                document["kind"].as_str(),
                Some("novel_chapter" | "novel_outline" | "adaptation_note")
            ),
            Some("drama") => {
                if let Some(episode) = document["drama_episode_id"].as_str() {
                    self.read_drama_episode(episode, None)?.0["project_id"]
                        == reference["object_id"]
                } else {
                    false
                }
            }
            _ => false,
        })
    }

    pub(super) fn document_blueprint(&self, document: &Value) -> Result<(Value, String)> {
        if let Some(reference) = self.document_work_ref(document)? {
            if let Some(value) = self.work_blueprint_revision(&reference, None)? {
                return Ok(value);
            }
        }
        // 未绑定设定的旧文档沿用旧含义；新项目在创建事务中已建立自身设定。
        self.blueprint_revision(None)
    }

    pub(super) fn task_sources_in_work(&self, reference: &Value, input: &Value) -> Result<bool> {
        if input["work_ref"] != *reference
            || self.task_work_reference(input)?.as_ref() != Some(reference)
        {
            return Ok(false);
        }
        for source in input["input_refs"].as_array().into_iter().flatten() {
            if source["kind"] == "blueprint" {
                if source["work_ref"] != *reference {
                    return Ok(false);
                }
            } else if source["kind"] == "resource" {
                if source["work_ref"] != *reference
                    || !self.resource_in_work(
                        text(source, "resource_id")?,
                        Some(integer(source, "revision")?),
                        reference,
                    )?
                {
                    return Ok(false);
                }
            } else if self
                .document_work_ref(&self.document(text(source, "document_id")?)?)?
                .as_ref()
                != Some(reference)
            {
                return Ok(false);
            }
        }
        for source in input["resource_scope"]["resource_refs"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if !self.resource_in_work(
                text(source, "resource_id")?,
                Some(integer(source, "revision")?),
                reference,
            )? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub(super) fn draft_blueprint(&self, draft: &Value, current: bool) -> Result<(Value, String)> {
        if draft["blueprint_ref"].is_object() {
            let reference = &draft["blueprint_ref"];
            let fixed = self.source_blueprint(reference)?;
            ensure(
                reference["sha256"] == fixed.1
                    && reference["revision"] == draft["blueprint_revision"],
                "hetu.integrity_failure",
                "参考稿的固定设定引用不一致。",
            )?;
            if current {
                let bp = self
                    .work_blueprint_revision(&reference["work_ref"], None)?
                    .ok_or_else(|| {
                        Error::new("hetu.integrity_failure", "参考稿所属作品设定丢失。")
                    })?;
                return Ok(bp);
            }
            return Ok(fixed);
        }
        self.blueprint_revision(if current {
            None
        } else {
            Some(integer(draft, "blueprint_revision")?)
        })
    }

    pub(super) fn draft_work_owner(&self, draft: &Value) -> Result<Option<Value>> {
        if draft["blueprint_ref"]["work_ref"].is_object() {
            return Ok(Some(draft["blueprint_ref"]["work_ref"].clone()));
        }
        if let Some(target) = draft["target_document_id"].as_str() {
            return self.document_work_ref(&self.document(target)?);
        }
        if let Some(task) = draft["creative_task_ref"]["task_id"].as_str() {
            return self.task_work_owner(&self.task_request(task)?.0);
        }
        if draft["package"] == "novel" {
            return Ok(self
                .novel()?
                .map(|novel| self.work_ref("novel", &novel["novel_id"])));
        }
        Ok(None)
    }
    fn work_canon_record(&self, reference: &Value, revision: Option<u64>) -> Result<Option<Value>> {
        self.work_record(reference, None)?;
        if reference["kind"] == "novel" {
            return Ok(None);
        }
        let parent = collection(reference)?;
        let object_id = text(reference, "object_id")?;
        if !self
            .store
            .exists(&format!("{parent}/{object_id}/head.json"))?
        {
            return Ok(None);
        }
        let (record, _, _) = self.versioned_record(&parent, object_id, "owner_id", revision)?;
        schema(&record, &blueprint::bundle(works::definition("work_canon")))?;
        ensure(
            record["work_ref"] == *reference
                && record["blueprint"]["revision"] == record["revision"],
            "hetu.integrity_failure",
            "设定集归属或修订不一致。",
        )?;
        self.validate_blueprint(&record["blueprint"])?;
        Ok(Some(record))
    }

    pub(super) fn work_blueprint_revision(
        &self,
        reference: &Value,
        revision: Option<u64>,
    ) -> Result<Option<(Value, String)>> {
        self.work_record(reference, None)?;
        // 一根只有一部小说，历史设定继续由它拥有，不重写旧字节和历史身份。
        if reference["kind"] == "novel" {
            return self.blueprint_revision(revision).map(Some);
        }
        Ok(self.work_canon_record(reference, revision)?.map(|record| {
            let bp = record["blueprint"].clone();
            let sha = digest(bytes(&bp).expect("validated JSON"));
            (bp, sha)
        }))
    }

    fn work_blueprint_result(&self, reference: &Value, bp: &Value, sha: &str) -> Value {
        json!({"initialized":true,"work_ref":reference,"blueprint":bp,"revision":bp["revision"],"sha256":sha,
            "binding":{"work_ref":reference,"role":"own","blueprint_ref":{
                "blueprint_id":bp["blueprint_id"],"revision":bp["revision"],"sha256":sha},
                "storage":if reference["kind"]=="novel" {"legacy"} else {"work"}}})
    }

    pub(super) fn get_work_blueprint(&self, input: &Value) -> Result<Value> {
        let reference = &input["work_ref"];
        match self.work_blueprint_revision(reference, input["revision"].as_u64())? {
            Some((bp, sha)) => {
                if let Some(expected) = input["sha256"].as_str() {
                    ensure(
                        expected == sha,
                        "hetu.integrity_failure",
                        "固定设定摘要不属于此作品的指定修订。",
                    )?;
                }
                Ok(self.work_blueprint_result(reference, &bp, &sha))
            }
            None => {
                ensure(
                    input["revision"].is_null(),
                    "not_found",
                    "此作品尚未建立自身设定，不能读取指定修订。",
                )?;
                Ok(
                    json!({"initialized":false,"work_ref":reference,"binding":null,"blueprint":null}),
                )
            }
        }
    }

    /// 与新项目同一事务创建；没有小说、原著或全局设定的隐式前置。
    pub(super) fn stage_new_work_canon(
        &self,
        reference: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        self.check_work_ref(reference)?;
        ensure(
            reference["kind"] != "novel",
            "invalid_input",
            "小说沿用原设定集身份。",
        )?;
        let parent = collection(reference)?;
        let object_id = text(reference, "object_id")?;
        ensure(
            !self
                .store
                .exists(&format!("{parent}/{object_id}/head.json"))?,
            "revision_conflict",
            "此作品已经有自身设定。",
        )?;
        let created_at = now();
        let bp = json!({"schema_version":"1.0.0","blueprint_id":id("blueprint"),"revision":1,
            "lock":{"locked":false,"changed_at":created_at,"actor_ref":self.actor()},
            "characters":[],"factions":[],"locations":[],"timeline":[],"world":[],"rules":[]});
        let record = json!({"schema_version":"1.0.0","workspace_id":self.scope(),"owner_id":object_id,"work_ref":reference,
            "revision":1,"previous_sha256":null,"blueprint":bp,"created_at":created_at,"updated_at":created_at,"actor_ref":self.actor()});
        schema(&record, &blueprint::bundle(works::definition("work_canon")))?;
        self.stage_versioned_record(&parent, "owner_id", &record, changes)?;
        self.stage_canon_revision_index(&record, changes)?;
        Ok(self.work_blueprint_result(reference, &bp, &digest(bytes(&bp)?)))
    }

    fn check_work_canon_sources(&self, reference: &Value, bp: &Value) -> Result<()> {
        if self.granted_work()?.is_none() {
            return Ok(());
        }
        let mut document_ids = std::collections::BTreeSet::new();
        for source in blueprint::source_refs(bp) {
            document_ids.insert(text(source, "document_id")?);
        }
        for rule in bp["rules"].as_array().unwrap() {
            for id in rule["scope"]["document_ids"].as_array().unwrap() {
                document_ids.insert(id.as_str().unwrap());
            }
        }
        for id in document_ids {
            let document = self.document(id)?;
            let belongs = self.document_in_work(&document, reference)?;
            ensure(
                belongs,
                "forbidden",
                "设定变更包含未获授权的其他作品原文；请先准备固定来源交接。",
            )?;
        }
        Ok(())
    }

    pub(super) fn dispatch_work_blueprint(
        &self,
        action: &str,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let reference = &input["work_ref"];
        self.work_record(reference, None)?;
        if action == "hetu.blueprints.get" {
            return self.get_work_blueprint(input);
        }
        let owner = self.work_record(reference, None)?;
        ensure(
            owner["archived"] != true && owner["metadata"]["status"] != "archived",
            "forbidden",
            "请先恢复已归档作品。",
        )?;
        if action == "hetu.blueprints.initialize" {
            ensure(
                reference["kind"] != "novel",
                "revision_conflict",
                "小说已有自身设定。",
            )?;
            return self.stage_new_work_canon(reference, changes);
        }
        let (current, sha) = self
            .work_blueprint_revision(reference, None)?
            .ok_or_else(|| {
                Error::new(
                    "hetu.canon_initialization_required",
                    "此作品尚未建立自身设定，请先准备初始化方案。",
                )
            })?;
        let expected = &input["expected"];
        ensure(
            expected["blueprint_id"] == current["blueprint_id"]
                && expected["revision"] == current["revision"]
                && expected["sha256"] == sha,
            "revision_conflict",
            "作品设定的身份或版本已变化，请重新比较。",
        )?;
        let (bp, impact) = if matches!(
            action,
            "hetu.blueprints.save" | "hetu.blueprints.preview_change"
        ) {
            ensure(
                current["lock"]["locked"] == false,
                "hetu.blueprint_locked",
                "作者已锁定设定集。",
            )?;
            blueprint::apply(&current, input["typed_changes"].as_array().unwrap())?
        } else {
            ensure(
                matches!(action, "hetu.blueprints.lock" | "hetu.blueprints.unlock"),
                "invalid_input",
                "设定动作无效。",
            )?;
            let mut bp = current.clone();
            bp["revision"] = json!(integer(&current, "revision")? + 1);
            bp["lock"] = json!({"locked":action.ends_with(".lock"),"changed_at":now(),"actor_ref":self.actor(),"reason":input["reason"]});
            (bp, json!([]))
        };
        self.check_work_canon_sources(reference, &bp)?;
        self.validate_blueprint(&bp)?;
        ensure(
            bytes(&bp)?.len() <= 4 * 1024 * 1024,
            "hetu.budget_exceeded",
            "作品设定超过单次保存预算。",
        )?;
        if !action.ends_with(".preview_change") {
            if reference["kind"] == "novel" {
                self.save_blueprint(&bp, changes)?;
            } else {
                let mut record = self.work_canon_record(reference, None)?.unwrap();
                let old_sha = digest(bytes(&record)?);
                self.advance_record(&mut record, &old_sha)?;
                record["blueprint"] = bp.clone();
                schema(&record, &blueprint::bundle(works::definition("work_canon")))?;
                self.stage_versioned_record(&collection(reference)?, "owner_id", &record, changes)?;
                self.stage_canon_revision_index(&record, changes)?;
            }
        }
        let mut result = self.work_blueprint_result(reference, &bp, &digest(bytes(&bp)?));
        result["impact"] = impact;
        result["preview"] = json!(action.ends_with(".preview_change"));
        Ok(result)
    }
}
