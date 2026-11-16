//! 关联只有一份修订链；更新依据、解除和恢复均保留旧版本及两端身份。
use super::*;

const LINKS: &str = "shared/work-links";

fn work_title(record: &Value) -> Value {
    if record["metadata"].is_object() {
        record["metadata"]["title"].clone()
    } else {
        record["title"].clone()
    }
}

impl Kernel {
    pub(super) fn work_link_set_digest(&self, target: &Value) -> Result<String> {
        let mut records = Vec::new();
        for link_id in self.record_ids(LINKS, "worklink")? {
            let (link, sha) = self.read_work_link(&link_id, None)?;
            if link["target_ref"]["work_ref"] == *target {
                records.push(json!({"link_id":link_id,"sha256":sha}));
            }
        }
        Ok(digest(serde_json_canonicalizer::to_vec(&records)?))
    }

    fn read_work_link(&self, link_id: &str, revision: Option<u64>) -> Result<(Value, String)> {
        checked_id(link_id, "worklink")?;
        let (record, sha, _) = self.versioned_record(LINKS, link_id, "link_id", revision)?;
        schema(&record, &works::definition("work_link"))?;
        ensure(
            record["workspace_id"] == self.scope(),
            "hetu.integrity_failure",
            "关联不属于当前工作区。",
        )?;
        self.check_work_ref(&record["source_ref"]["work_ref"])?;
        self.check_work_ref(&record["target_ref"]["work_ref"])?;
        Self::check_work_link_endpoints(
            &record["source_ref"],
            &record["target_ref"],
            text(&record, "relation")?,
        )?;
        Ok((record, sha))
    }

    fn check_work_link_endpoints(source: &Value, target: &Value, relation: &str) -> Result<()> {
        ensure(
            source["work_ref"] != target["work_ref"],
            "invalid_input",
            "创作对象不能关联自身。",
        )?;
        ensure(
            match relation {
                "adaptation" => {
                    source["work_ref"]["kind"] == "novel" && target["work_ref"]["kind"] == "drama"
                }
                "production" => {
                    source["work_ref"]["kind"] == "drama" && target["work_ref"]["kind"] == "video"
                }
                "reference" | "continuation" => true,
                _ => false,
            },
            "invalid_input",
            "关联类型与两端对象不匹配。",
        )
    }

    fn check_work_link_unique(
        &self,
        source: &Value,
        target: &Value,
        relation: &str,
        except: Option<&str>,
    ) -> Result<()> {
        for link_id in self.record_ids(LINKS, "worklink")? {
            if except == Some(link_id.as_str()) {
                continue;
            }
            let (link, _) = self.read_work_link(&link_id, None)?;
            ensure(
                !(link["source_ref"] == *source
                    && link["target_ref"] == *target
                    && link["relation"] == relation
                    && link["archived"] == false),
                "invalid_input",
                "相同固定来源已经关联。",
            )?;
        }
        Ok(())
    }

    pub(super) fn create_work_link(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let source = &input["source_ref"];
        let target = &input["target_ref"];
        let source_record = self.fixed_work_record(source)?;
        let target_record = self.fixed_work_record(target)?;
        ensure(
            target_record == self.work_record(&target["work_ref"], None)?,
            "revision_conflict",
            "目标已有新修订，请重新准备关联。",
        )?;
        let relation = text(input, "relation")?;
        Self::check_work_link_endpoints(source, target, relation)?;
        self.check_work_link_unique(source, target, relation, None)?;
        let record = json!({"schema_version":"1.0.0","workspace_id":self.scope(),"link_id":id("worklink"),
            "revision":1,"previous_sha256":null,"source_ref":source,"target_ref":target,"relation":relation,
            "source_title":work_title(&source_record),"target_title":work_title(&target_record),
            "archived":false,"created_at":now(),"updated_at":now(),"actor_ref":self.actor()});
        self.save_work_link(&record, changes)
    }

    fn save_work_link(&self, record: &Value, changes: &mut Changes) -> Result<Value> {
        schema(record, &works::definition("work_link"))?;
        let sha = self.stage_versioned_record(LINKS, "link_id", record, changes)?;
        Ok(json!({"link":record,"sha256":sha}))
    }

    fn expected_work_link(&self, input: &Value) -> Result<(Value, String)> {
        let expected = &input["link_ref"];
        let (link, sha) = self.read_work_link(text(expected, "link_id")?, None)?;
        // 管理权属于使用这份依据的对象，不能仅凭来源授权改动下游的选择。
        ensure(
            input["work_ref"] == link["target_ref"]["work_ref"],
            "forbidden",
            "请在使用此依据的作品中管理关联。",
        )?;
        self.work_record(&input["work_ref"], None)?;
        ensure(
            expected["revision"] == link["revision"] && expected["sha256"] == sha,
            "revision_conflict",
            "关联已有更新，请先比较当前版本。",
        )?;
        Ok((link, sha))
    }

    pub(super) fn update_work_link_source(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let (mut link, previous) = self.expected_work_link(input)?;
        ensure(
            link["archived"] == false,
            "invalid_input",
            "已解除的关联须先恢复，才能更新依据。",
        )?;
        let source = &input["source_ref"];
        let target = &input["target_ref"];
        ensure(
            source["work_ref"] == link["source_ref"]["work_ref"]
                && target["work_ref"] == link["target_ref"]["work_ref"],
            "invalid_input",
            "更新依据不能替换两端作品；其他作品须另建关联。",
        )?;
        let source_record = self.fixed_work_record(source)?;
        let target_record = self.fixed_work_record(target)?;
        ensure(
            target_record == self.work_record(&target["work_ref"], None)?,
            "revision_conflict",
            "使用依据的作品已有新修订，请重新准备。",
        )?;
        ensure(
            *source != link["source_ref"] || *target != link["target_ref"],
            "invalid_input",
            "所选依据没有变化。",
        )?;
        self.check_work_link_unique(
            source,
            target,
            text(&link, "relation")?,
            link["link_id"].as_str(),
        )?;
        link["source_ref"] = source.clone();
        link["target_ref"] = target.clone();
        link["source_title"] = work_title(&source_record);
        link["target_title"] = work_title(&target_record);
        self.advance_record(&mut link, &previous)?;
        self.save_work_link(&link, changes)
    }

    pub(super) fn set_work_link_archived(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let (mut link, previous) = self.expected_work_link(input)?;
        ensure(
            link["archived"] != input["archived"],
            "invalid_input",
            "关联已经处于所选状态。",
        )?;
        if input["archived"] == false {
            self.check_work_link_unique(
                &link["source_ref"],
                &link["target_ref"],
                text(&link, "relation")?,
                link["link_id"].as_str(),
            )?;
        }
        link["archived"] = input["archived"].clone();
        self.advance_record(&mut link, &previous)?;
        // 解除、恢复只改变关系，不读取或覆盖来源正文、设定和旧任务。
        self.save_work_link(&link, changes)
    }

    fn work_link_view(
        &self,
        link: Value,
        sha: String,
        reference: &Value,
        detail: bool,
    ) -> Result<Value> {
        let incoming = link["target_ref"]["work_ref"] == *reference;
        ensure(
            incoming || link["source_ref"]["work_ref"] == *reference,
            "forbidden",
            "关联不属于所选创作对象。",
        )?;
        let other = &link[if incoming { "source_ref" } else { "target_ref" }];
        let mut view = json!({"link":link,"sha256":sha,"direction":if incoming { "incoming" } else { "outgoing" },
            "related_title":link[if incoming { "source_title" } else { "target_title" }],
            "related_status":"requires_authorization","related_has_newer_revision":null,
            "related_current_archived":null,"related_read_requires_authorization":true,"related_work":null,"related_error":null});
        // 关系元数据可读不表示另一端获权；不能通过详情或历史版本扩大范围。
        if self.granted_work()?.is_some() {
            return Ok(view);
        }
        view["related_read_requires_authorization"] = json!(false);
        let read = (|| -> Result<()> {
            let current = self.get_work(&json!({"work_ref":other["work_ref"]}))?;
            view["related_has_newer_revision"] =
                json!(current["record"]["revision"] != other["revision_ref"]["revision"]);
            view["related_current_archived"] = current["summary"]["archived"].clone();
            // 旧关系没有保存标题时才读取确切历史；绝不以当前标题冒充固定标题。
            if detail || view["related_title"].is_null() {
                let fixed = self.get_work(&json!({"work_ref":other["work_ref"],"revision":other["revision_ref"]["revision"]}))?;
                ensure(
                    fixed["summary"]["fixed_ref"] == *other,
                    "hetu.integrity_failure",
                    "关联依据的历史摘要不一致。",
                )?;
                view["related_title"] = fixed["summary"]["title"].clone();
                if detail {
                    view["related_work"] = fixed;
                }
            }
            Ok(())
        })();
        match read {
            Ok(()) => view["related_status"] = json!("available"),
            Err(error) => {
                view["related_status"] = json!("unavailable");
                view["related_has_newer_revision"] = Value::Null;
                view["related_current_archived"] = Value::Null;
                view["related_error"] = json!({"code":error.code,"message":error.message});
            }
        }
        Ok(view)
    }

    pub(super) fn get_work_link(&self, input: &Value) -> Result<Value> {
        self.work_record(&input["work_ref"], None)?;
        let link_id = text(input, "link_id")?;
        let (current, current_sha) = self.read_work_link(link_id, None)?;
        ensure(
            current["source_ref"]["work_ref"] == input["work_ref"]
                || current["target_ref"]["work_ref"] == input["work_ref"],
            "forbidden",
            "关联不属于所选创作对象。",
        )?;
        let (link, sha) = if input["revision"].is_number() {
            self.read_work_link(link_id, input["revision"].as_u64())?
        } else {
            (current.clone(), current_sha.clone())
        };
        ensure(
            link["source_ref"]["work_ref"] == current["source_ref"]["work_ref"]
                && link["target_ref"]["work_ref"] == current["target_ref"]["work_ref"],
            "hetu.integrity_failure",
            "关联历史的两端身份不一致。",
        )?;
        let mut view = self.work_link_view(link, sha, &input["work_ref"], true)?;
        view["current_link_ref"] =
            json!({"link_id":link_id,"revision":current["revision"],"sha256":current_sha});
        Ok(view)
    }

    pub(super) fn list_work_links(&self, input: &Value) -> Result<Value> {
        self.work_record(&input["work_ref"], None)?;
        let mut results = Vec::new();
        for link_id in self.record_ids(LINKS, "worklink")? {
            let (link, sha) = self.read_work_link(&link_id, None)?;
            if (link["source_ref"]["work_ref"] == input["work_ref"]
                || link["target_ref"]["work_ref"] == input["work_ref"])
                && (input["include_archived"] == true || link["archived"] != true)
            {
                results.push(self.work_link_view(link, sha, &input["work_ref"], false)?);
            }
        }
        self.record_page(input, results, "links")
    }
}
