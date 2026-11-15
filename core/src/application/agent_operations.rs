//! Agent 准备固定管理变更，作者审阅后批准；执行不提升调用方身份。
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};

pub(super) const PROPOSABLE: &[&str] = &[
    "hetu.novels.initialize",
    "hetu.novels.update",
    "hetu.novels.save_structure",
    "hetu.documents.create",
    "hetu.outlines.save",
    "hetu.blueprints.save",
    "hetu.drama.projects.create",
    "hetu.drama.projects.update",
    "hetu.drama.projects.attach",
    "hetu.drama.episodes.create",
    "hetu.drama.episodes.update",
    "hetu.drama.episodes.reorder",
    "hetu.creative_tasks.prepare",
    "hetu.image_tasks.prepare",
    "hetu.plot.correct",
    "hetu.drama.edit_skeleton",
    "hetu.drama.create_script",
    "hetu.assets.update",
    "hetu.cues.save",
    "hetu.resource_usages.save",
    "hetu.documents.import",
    "hetu.documents.import_batch",
    "hetu.assets.import",
    "hetu.documents.export",
    "hetu.bundles.export",
    "hetu.git.init",
    "hetu.git.branch_create", "hetu.git.branch_switch", "hetu.git.merge",
    "hetu.git.remote_save", "hetu.git.fetch", "hetu.git.push", "hetu.git.pull",
];

fn proposal_path(input: &Value) -> Result<String> {
    Ok(format!(
        ".hetu/agent-proposals/{}.json",
        checked_id(text(input, "proposal_id")?, "proposal")?
    ))
}
fn stamp(store: &Store, path: &str) -> Result<Value> {
    Ok(if store.exists(path)? {
        json!(digest(store.read(path)?))
    } else {
        Value::Null
    })
}

impl Kernel {
    fn proposal_baseline(&self) -> Result<Value> {
        Ok(
            json!({"config":self.config_sha,"blueprint":stamp(&self.store,"shared/blueprint.json")?,
            "novel":stamp(&self.store,".hetu/novel-head.json")?}),
        )
    }
    pub(super) fn read_proposal(&self, input: &Value) -> Result<(Value, Value)> {
        let path = proposal_path(input)?;
        let proposal = self.store.json(&path)?;
        let mut contract: Value = serde_json::from_str(include_str!(
            "../../../contracts/schemas/agent-operation.schema.json"
        ))?;
        contract["$ref"] = json!("#/$defs/proposal");
        schema(&proposal, &contract)?;
        ensure(
            proposal["scope_id"] == self.scope() && proposal["proposal_id"] == input["proposal_id"],
            "forbidden",
            "操作方案不属于当前作品。",
        )?;
        ensure(
            PROPOSABLE.contains(&text(&proposal["fixed"], "action")?),
            "hetu.integrity_failure",
            "方案中的动作不属于可执行管理范围。",
        )?;
        let fixed = &proposal["fixed"];
        ensure(fixed["effect"] == "deferred" || fixed["writes"].as_object().is_some_and(|items| !items.is_empty()), "hetu.integrity_failure", "方案缺少固定变更。")?;
        if fixed["action"] == "hetu.creative_tasks.prepare" || fixed["action"] == "hetu.image_tasks.prepare" {
            if let Some(binding) = &self.management_grant {
                let client = text(binding,"client_adapter")?;
                ensure(fixed["input"]["client_adapter"] == if client == "generic" { "other" } else { client }, "forbidden", "方案任务属于其他客户端。")?;
            }
        }
        let writes = fixed["writes"].as_object().ok_or_else(|| Error::new("hetu.integrity_failure", "方案写入记录无效。"))?;
        let before = fixed["before_files"].as_object().ok_or_else(|| Error::new("hetu.integrity_failure", "方案基线记录无效。"))?;
        let binary = fixed.get("binary_writes").and_then(Value::as_object);
        let all_keys = writes.keys().chain(binary.into_iter().flat_map(|m| m.keys())).collect::<std::collections::BTreeSet<_>>();
        ensure(all_keys == before.keys().collect() && all_keys.len() == writes.len() + binary.map_or(0, |m| m.len()), "hetu.integrity_failure", "每个管理变更必须有唯一对应基线。")?;
        let mut total = writes.values().map(|v| v.as_str().map_or(0, str::len)).sum::<usize>();
        for value in binary.into_iter().flat_map(|m| m.values()) {
            total = total.saturating_add(STANDARD.decode(value.as_str().unwrap_or("")).map_err(|_| Error::new("hetu.integrity_failure", "方案原文件编码无效。"))?.len());
        }
        ensure(total <= 8 * 1024 * 1024,
            "hetu.integrity_failure", "管理变更超过大小上限。")?;
        let sha = digest(serde_json_canonicalizer::to_vec(&proposal["fixed"])?);
        ensure(
            proposal["sha256"] == sha,
            "hetu.integrity_failure",
            "操作方案摘要不一致。",
        )?;
        if let Some(expected) = input.get("proposal_sha256") {
            ensure(
                *expected == sha,
                "hetu.stale_evidence",
                "操作方案与确认的版本不一致。",
            )?;
        }
        let state = self.store.json(&path.replace(".json", ".state.json"))?;
        contract["$ref"] = json!("#/$defs/decision_record");
        schema(&state, &contract)?;
        ensure(
            state["proposal_sha256"] == sha,
            "hetu.integrity_failure",
            "操作方案与审核记录不一致。",
        )?;
        ensure(state["state"] == "pending" || (state["decided_by"].is_string() && state["decided_at"].is_string()),
            "hetu.integrity_failure", "方案缺少作者决定记录。")?;
        ensure(state["state"] != "executed" || (state["executed_by"].is_string() && state["executed_at"].is_string() && (fixed["effect"] == "deferred" || state["result"] == fixed["preview"])),
            "hetu.integrity_failure", "方案执行记录不完整。")?;
        Ok((proposal, state))
    }
    pub(super) fn proposal_view(&self, proposal: &Value, state: &Value) -> Result<Value> {
        let fixed = &proposal["fixed"];
        let mut current = fixed["baseline"] == self.proposal_baseline()?;
        for (path, expected) in fixed["before_files"].as_object().unwrap() {
            current &= *expected == stamp(&self.store, path)?;
        }
        Ok(
            json!({"proposal_id":proposal["proposal_id"],"proposal_sha256":proposal["sha256"],
            "action":fixed["action"],"summary":fixed["summary"],"created_at":fixed["created_at"],
            "expires_at":fixed["expires_at"],"input":fixed["input"],"preview":fixed["preview"],
            "changes":fixed["review_changes"],"state":state["state"],"state_revision":state["revision"],
            "is_expired":time::OffsetDateTime::now_utc().unix_timestamp() >= integer(fixed, "expires_at")? as i64,
            "is_current":current,"result":state.get("result").cloned().unwrap_or(Value::Null)}),
        )
    }
    pub(super) fn dispatch_agent_operations(
        &self,
        action: &str,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        ensure(
            self.task_id.is_none() && (self.management_grant.is_none() || self.management_grant.as_ref().is_some_and(|v| v["kind"] == "workspace")),
            "forbidden",
            "作品管理方案不能借用创作任务或有限新建授权。",
        )?;
        match action {
            "hetu.agent_operations.prepare" => {
                let target = text(input, "action")?;
                ensure(
                    PROPOSABLE.contains(&target),
                    "hetu.capability_unavailable",
                    "此管理操作未开放方案准备；不能代替作者采纳、定稿、解锁或付费批准。",
                )?;
                let arguments = &input["input"];
                validate_action_input(target, arguments)?;
                if target == "hetu.documents.import_batch" {
                    for item in arguments["items"].as_array().unwrap() {
                        let source = &item["source"];
                        ensure(source.get("inline_source").is_some() && source.get("file_path").is_none(),
                            "forbidden", "批量导入须固定每份 inline_source 内容，不能读取本机路径。")?;
                    }
                }
                if matches!(target, "hetu.documents.import" | "hetu.assets.import") {
                    let source = if target == "hetu.documents.import" { &arguments["preview"]["request"] } else { arguments };
                    ensure(source.get("inline_source").is_some() && source.get("file_path").is_none(),
                        "forbidden", "导入方案须固定 inline_source 文件内容，不能借作品授权读取本机路径。")?;
                }
                if matches!(target, "hetu.creative_tasks.prepare" | "hetu.image_tasks.prepare") {
                    if let Some(binding) = &self.management_grant {
                        let client = text(binding, "client_adapter")?;
                        ensure(arguments["client_adapter"] == if client == "generic" { "other" } else { client },
                            "forbidden", "不能替其他客户端准备任务。")?;
                    }
                }
                ensure(
                    target != "hetu.documents.create" || arguments["content"] == "",
                    "forbidden",
                    "新建管理方案只建立空文档，正文通过参考稿交付。",
                )?;
                let mut staged = Changes::new();
                // 只对有界、确定性的本地领域事务作预演，不调用网络或交付引擎。
                let deferred = target.starts_with("hetu.git.") || matches!(target, "hetu.assets.import" | "hetu.documents.export" | "hetu.bundles.export");
                let preview = if deferred { self.preview_proposal_effect(target, arguments)? } else { self.dispatch(target, arguments, &mut staged)? };
                ensure(
                    deferred || !staged.is_empty(),
                    "invalid_input",
                    "操作没有可审阅的变更。",
                )?;
                ensure(
                    staged.values().map(Vec::len).sum::<usize>() <= 8 * 1024 * 1024,
                    "hetu.budget_exceeded",
                    "单项方案超过大小上限。",
                )?;
                let mut before = serde_json::Map::new();
                let mut writes = serde_json::Map::new();
                let mut binary = serde_json::Map::new();
                let mut review = Vec::new();
                for (path, data) in staged {
                    before.insert(path.clone(), stamp(&self.store, &path)?);
                    let after = match String::from_utf8(data) {
                        Ok(text) => text,
                        Err(error) => { binary.insert(path, json!(STANDARD.encode(error.into_bytes()))); continue; }
                    };
                    if !path.starts_with(".hetu/") {
                        let previous = if self.store.exists(&path)? {
                            Some(String::from_utf8(self.store.read(&path)?).map_err(|_| {
                                Error::new("hetu.integrity_failure", "原文件不是文本。")
                            })?)
                        } else {
                            None
                        };
                        review.push(json!({"path":path,"before":previous,"after":after}));
                    }
                    writes.insert(path, json!(after));
                }
                let proposal_id = id("proposal");
                let mut fixed = json!({"action":target,"input":arguments,"summary":input["summary"],"created_at":now(),
                    "expires_at":time::OffsetDateTime::now_utc().unix_timestamp()+86400,
                    "baseline":self.proposal_baseline()?,"before_files":before,"writes":writes,"binary_writes":binary,"preview":preview,"review_changes":review});
                if deferred { fixed["effect"] = json!("deferred"); }
                let sha = digest(serde_json_canonicalizer::to_vec(&fixed)?);
                let proposal = json!({"schema_version":"1.0.0","scope_id":self.scope(),"proposal_id":proposal_id,"sha256":sha,"fixed":fixed,"prepared_by":self.actor()});
                let state = json!({"proposal_sha256":sha,"state":"pending","revision":1});
                let view = self.proposal_view(&proposal, &state)?;
                ensure(bytes(&view)?.len() <= 7 * 1024 * 1024, "hetu.budget_exceeded", "方案超过审阅传输预算，请缩小或拆分导入文件。")?;
                self.store.directory(".hetu/agent-proposals")?;
                let path = format!(".hetu/agent-proposals/{proposal_id}.json");
                changes.insert(path.replace(".json", ".state.json"), bytes(&state)?);
                changes.insert(path, bytes(&proposal)?);
                Ok(view)
            }
            "hetu.agent_operations.list" => {
                let mut proposals = Vec::new();
                if !self
                    .store
                    .entries(".hetu")?
                    .iter()
                    .any(|name| name == "agent-proposals")
                {
                    return self.record_page(input, proposals, "proposals");
                }
                for name in self.store.entries(".hetu/agent-proposals")? {
                    if !name.ends_with(".state.json") && name.ends_with(".json") {
                        let key = name.trim_end_matches(".json");
                        let (proposal, state) = self.read_proposal(&json!({"proposal_id":key}))?;
                        let mut value = self.proposal_view(&proposal, &state)?;
                        // 列表不重复传输全文；详情按确切方案读取。
                        value.as_object_mut().unwrap().remove("changes");
                        value.as_object_mut().unwrap().remove("preview");
                        value.as_object_mut().unwrap().remove("input");
                        proposals.push(value);
                    }
                }
                proposals.sort_by(|a, b| b["created_at"].as_str().cmp(&a["created_at"].as_str()));
                self.record_page(input, proposals, "proposals")
            }
            "hetu.agent_operations.get" => {
                let (proposal, state) = self.read_proposal(input)?;
                self.proposal_view(&proposal, &state)
            }
            "hetu.agent_operations.decide" | "hetu.agent_operations.execute" => {
                let (proposal, mut state) = self.read_proposal(input)?;
                let view = self.proposal_view(&proposal, &state)?;
                if action.ends_with(".decide") {
                    ensure(self.author, "forbidden", "操作方案只能由作者确认或拒绝。")?;
                    ensure(
                        state["state"] != "executed" && state["state"] != "executing",
                        "revision_conflict",
                        "已执行的方案保留历史，不可修改决定。",
                    )?;
                    ensure(
                        input["expected_state_revision"] == state["revision"],
                        "revision_conflict",
                        "方案审核状态已有变化。",
                    )?;
                    if input["decision"] == "approve" {
                        ensure(view["is_expired"] == false, "forbidden", "方案已过期，请重新准备。")?;
                        ensure(
                            view["is_current"] == true,
                            "revision_conflict",
                            "作品已有更新，请让 Agent 重新准备方案。",
                        )?;
                    }
                    state["state"] = json!(if input["decision"] == "approve" {
                        "approved"
                    } else {
                        "rejected"
                    });
                    state["decided_by"] = json!(self.actor());
                    state["decided_at"] = json!(now());
                } else {
                    if state["state"] == "executed" {
                        return self.proposal_view(&proposal, &state);
                    }
                    ensure(
                        state["state"] == "approved",
                        "hetu.author_confirmation_required",
                        "方案尚未由作者批准或已撤销。",
                    )?;
                    ensure(
                        view["is_current"] == true,
                        "revision_conflict",
                        "作品基线已有变化，不能执行旧方案。",
                    )?;
                    ensure(
                        time::OffsetDateTime::now_utc().unix_timestamp()
                            < integer(&proposal["fixed"], "expires_at")? as i64,
                        "forbidden",
                        "方案已过期，请重新准备。",
                    )?;
                    for (path, data) in proposal["fixed"]["writes"].as_object().unwrap() {
                        changes.insert(path.clone(), data.as_str().unwrap().as_bytes().to_vec());
                    }
                    if let Some(binary) = proposal["fixed"]["binary_writes"].as_object() {
                        for (path, data) in binary {
                            changes.insert(path.clone(), STANDARD.decode(data.as_str().unwrap()).map_err(|_| Error::new("hetu.integrity_failure", "方案原文件编码无效。"))?);
                        }
                    }
                    state["state"] = json!("executed");
                    state["executed_by"] = json!(self.actor());
                    state["result"] = proposal["fixed"]["preview"].clone();
                    state["executed_at"] = json!(now());
                }
                state["revision"] = json!(integer(&state, "revision")?.checked_add(1)
                    .ok_or_else(|| Error::new("hetu.budget_exceeded", "方案审核修订超过支持上限。"))?);
                changes.insert(
                    proposal_path(input)?.replace(".json", ".state.json"),
                    bytes(&state)?,
                );
                self.proposal_view(&proposal, &state)
            }
            _ => Err(Error::new(
                "hetu.capability_unavailable",
                "未开放的管理方案动作。",
            )),
        }
    }
}
