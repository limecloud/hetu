//! 当前会话中明确授权的整书导入：固定目录范围，分批执行，游标与正文同事务提交。
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

fn path(reference: &Value) -> Result<String> {
    Ok(format!(
        ".hetu/import-authorizations/{}.json",
        checked_id(text(reference, "authorization_id")?, "import_authorization")?
    ))
}
fn expected(novel: &Value) -> Value {
    json!({"revision":novel["revision"],"sha256":novel["sha256"]})
}

impl Kernel {
    fn import_authorization(&self, reference: &Value) -> Result<Value> {
        let record = self.store.json(&path(reference)?)?;
        let fixed = &record["fixed"];
        let units = fixed["plan"]["units"].as_array();
        let imported = record["imported"].as_array();
        ensure(
            record["schema_version"] == "1.0.0"
                && record["authorization_id"] == reference["authorization_id"]
                && matches!(
                    record["state"].as_str(),
                    Some("active" | "revoked" | "complete")
                )
                && record["volumes_ready"].is_boolean()
                && units.is_some()
                && imported.is_some()
                && record["next_index"].as_u64().is_some_and(|next| {
                    next as usize <= units.unwrap().len()
                        && next as usize == imported.unwrap().len()
                }),
            "hetu.integrity_failure",
            "导入授权进度记录损坏，请保留原记录。",
        )?;
        let mut ids = BTreeSet::new();
        for document in imported.unwrap() {
            let id = checked_id(document.as_str().unwrap_or(""), "doc")?;
            ensure(
                ids.insert(id),
                "hetu.integrity_failure",
                "导入进度包含重复成果。",
            )?;
        }
        ensure(
            record["sha256"] == reference["sha256"]
                && record["sha256"] == digest(serde_json_canonicalizer::to_vec(fixed)?),
            "hetu.stale_evidence",
            "导入授权与固定目录摘要不一致。",
        )?;
        ensure(
            self.management_grant.as_ref() == Some(&fixed["binding"]),
            "forbidden",
            "导入授权不属于当前客户端与授权修订。",
        )?;
        self.check_work_access("hetu.novels.get", &json!({}))?;
        let novel = self.get_novel()?;
        ensure(
            fixed["work_ref"]["workspace_id"] == self.scope()
                && fixed["work_ref"]["object_id"] == novel["novel"]["novel_id"],
            "forbidden",
            "导入授权不属于当前小说。",
        )?;
        Ok(record)
    }

    pub(super) fn dispatch_import_authorizations(
        &self,
        action: &str,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        ensure(
            self.task_id.is_none()
                && self
                    .management_grant
                    .as_ref()
                    .is_some_and(|g| g["kind"] == "workspace"),
            "forbidden",
            "整书导入授权必须使用确切作品管理连接。",
        )?;
        if action == "hetu.import_authorizations.register" {
            ensure(
                !text(input, "authorization_note")?.trim().is_empty(),
                "invalid_input",
                "须记录作者在当前会话中实际给出的导入授权。",
            )?;
            let current = self.get_novel()?;
            ensure(
                current["initialized"] == true && input["expected"] == expected(&current),
                "revision_conflict",
                "小说目录已变化，请先回读原导入记录。",
            )?;
            let work = &input["work_ref"];
            ensure(
                work["kind"] == "novel"
                    && work["workspace_id"] == self.scope()
                    && work["object_id"] == current["novel"]["novel_id"],
                "forbidden",
                "导入计划须固定当前小说身份。",
            )?;
            let plan = &input["plan"];
            ensure(
                bytes(plan)?.len() <= 2 * 1024 * 1024,
                "hetu.budget_exceeded",
                "导入目录超过授权预算。",
            )?;
            let mut volumes = BTreeSet::new();
            for volume in plan["volumes"].as_array().unwrap() {
                let id = text(volume, "volume_id")?;
                ensure(
                    volumes.insert(id)
                        && !current["novel"]["volumes"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|v| v["volume_id"] == id),
                    "invalid_input",
                    "导入卷标识重复或已存在。",
                )?;
            }
            let mut cursor = 0;
            for (index, unit) in plan["units"].as_array().unwrap().iter().enumerate() {
                ensure(
                    integer(unit, "index")? == index as u64
                        && integer(unit, "start")? == cursor
                        && integer(unit, "end")? > cursor
                        && volumes.contains(text(unit, "volume_id")?),
                    "invalid_input",
                    "导入目录范围须连续完整，章节必须归属固定分卷。",
                )?;
                cursor = integer(unit, "end")?;
            }
            ensure(
                cursor == integer(plan, "reading_characters")?,
                "invalid_input",
                "导入目录未完整覆盖阅读文本。",
            )?;
            let fixed = json!({"work_ref":work,"plan":plan,"binding":self.management_grant,"initial_expected":input["expected"],"base_volumes":current["novel"]["volumes"],"base_chapters":current["novel"]["chapters"],"authorization_note":input["authorization_note"],"confirmation_channel":"agent_conversation","host":self.management_grant.as_ref().unwrap()["client_adapter"],"created_at":now(),"expires_at":time::OffsetDateTime::now_utc().unix_timestamp()+86400});
            let authorization_id = id("import_authorization");
            let reference = json!({"authorization_id":authorization_id,"sha256":digest(serde_json_canonicalizer::to_vec(&fixed)?)});
            let record = json!({"schema_version":"1.0.0","authorization_id":authorization_id,"sha256":reference["sha256"],"fixed":fixed,"state":"active","next_index":0,"volumes_ready":false,"expected":input["expected"],"imported":[]});
            changes.insert(path(&reference)?, bytes(&record)?);
            return Ok(
                json!({"import_authorization_ref":reference,"state":"active","confirmation_channel":"agent_conversation","work_ref":work,"source_sha256":plan["source_sha256"],"documents":plan["units"].as_array().unwrap().len(),"volumes":plan["volumes"],"next_index":0}),
            );
        }
        let mut record = self.import_authorization(&input["import_authorization_ref"])?;
        if action == "hetu.import_authorizations.revoke" {
            record["state"] = json!("revoked");
            changes.insert(path(&input["import_authorization_ref"])?, bytes(&record)?);
        }
        Ok(record)
    }

    /// 只批准固定计划中的下一步，不接收作者角色、任意动作或新的正文输入。
    pub(super) fn stage_import_authorized_execution(
        &self,
        input: &Value,
        proposal: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let reference = &input["import_authorization_ref"];
        let mut record = self.import_authorization(reference)?;
        let fixed = &record["fixed"];
        ensure(
            record["state"] == "active"
                && time::OffsetDateTime::now_utc().unix_timestamp()
                    < integer(fixed, "expires_at")? as i64,
            "forbidden",
            "导入授权已撤销、完成或过期。",
        )?;
        let plan = fixed["plan"].clone();
        let arguments = &proposal["fixed"]["input"];
        ensure(
            record["expected"] == expected(&self.get_novel()?)
                && arguments["expected"] == record["expected"],
            "revision_conflict",
            "目录已被其他操作修改，请保留原导入计划并核对。",
        )?;
        ensure(
            arguments
                .get("work_ref")
                .is_none_or(|r| *r == fixed["work_ref"]),
            "forbidden",
            "导入方案属于其他作品。",
        )?;
        match proposal["fixed"]["action"].as_str() {
            Some("hetu.novels.save_structure") => {
                let mut volumes = fixed["base_volumes"].as_array().unwrap().clone();
                volumes.extend(plan["volumes"].as_array().unwrap().iter().cloned());
                ensure(
                    record["volumes_ready"] == false
                        && arguments["volumes"] == json!(volumes)
                        && arguments["chapters"] == fixed["base_chapters"],
                    "forbidden",
                    "分卷方案超出当前会话授权的固定目录。",
                )?;
                record["volumes_ready"] = json!(true);
            }
            Some("hetu.documents.import_batch") => {
                ensure(
                    record["volumes_ready"] == true,
                    "forbidden",
                    "请先沿原计划建立分卷。",
                )?;
                let start = integer(&record, "next_index")? as usize;
                let items = arguments["items"].as_array().unwrap();
                let units = plan["units"].as_array().unwrap();
                ensure(
                    start + items.len() <= units.len(),
                    "forbidden",
                    "批次超出固定导入范围。",
                )?;
                for (item, unit) in items.iter().zip(&units[start..]) {
                    let source = &item["source"];
                    let inline = &source["inline_source"];
                    ensure(
                        item["title"] == unit["title"]
                            && item["volume_id"] == unit["volume_id"]
                            && item["language_tag"] == plan["language_tag"]
                            && source["format"] == "txt"
                            && source["profile"] == "source/1"
                            && inline["sha256"] == unit["content_sha256"],
                        "forbidden",
                        "批次标题、分卷、格式或原文摘要超出固定授权。",
                    )?;
                    let bytes = STANDARD
                        .decode(text(inline, "base64")?)
                        .map_err(|_| Error::new("invalid_input", "原稿编码无效。"))?;
                    let text = std::str::from_utf8(&bytes)
                        .map_err(|_| Error::new("invalid_input", "阅读文本须为UTF-8。"))?;
                    ensure(
                        digest(&bytes) == unit["content_sha256"]
                            && text.chars().count() as u64
                                == integer(unit, "end")? - integer(unit, "start")?,
                        "hetu.integrity_failure",
                        "章节原文或范围与授权不符。",
                    )?;
                }
                let documents = proposal["fixed"]["preview"]["documents"]
                    .as_array()
                    .unwrap();
                ensure(
                    documents.len() == items.len(),
                    "hetu.integrity_failure",
                    "固定批次成果数量不一致。",
                )?;
                for document in documents {
                    record["imported"]
                        .as_array_mut()
                        .unwrap()
                        .push(document["document"]["document_id"].clone());
                }
                record["next_index"] = json!(start + items.len());
                if start + items.len() == units.len() {
                    let mut sha = Sha256::new();
                    for document in record["imported"].as_array().unwrap() {
                        let name = format!(
                            ".hetu/imports/{}/original",
                            checked_id(document.as_str().unwrap(), "doc")?
                        );
                        let value = proposal["fixed"]["writes"].get(&name);
                        let data = if let Some(value) = value {
                            value
                                .as_str()
                                .ok_or_else(|| {
                                    Error::new("hetu.integrity_failure", "固定原稿不是文本。")
                                })?
                                .as_bytes()
                                .to_vec()
                        } else {
                            self.store.read(&name)?
                        };
                        sha.update(data);
                    }
                    ensure(
                        format!("{:x}", sha.finalize()) == plan["reading_sha256"],
                        "hetu.integrity_failure",
                        "整书阅读文本摘要不符，停止提交当前批次。",
                    )?;
                    record["state"] = json!("complete");
                }
            }
            _ => {
                return Err(Error::new(
                    "forbidden",
                    "整书导入授权不能批准其他管理动作、采纳、定稿或外部副作用。",
                ));
            }
        }
        record["expected"] = expected(&proposal["fixed"]["preview"]);
        changes.insert(path(reference)?, bytes(&record)?);
        Ok(reference.clone())
    }
}
