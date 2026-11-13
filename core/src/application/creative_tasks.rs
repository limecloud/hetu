use super::*;
use std::collections::BTreeSet;

pub(super) const TASK_ACTIONS: &[&str] = &[
    "hetu.capabilities.get",
    "hetu.operations.get",
    "hetu.creative_tasks.get",
    "hetu.creative_tasks.submit_result",
    "hetu.interactions.get",
    "hetu.interactions.save_selection",
];
const TEXT_LIMIT: usize = 1024 * 1024;
const IMAGE_LIMIT: u64 = 32 * 1024 * 1024;

pub(super) fn definition(name: &str) -> Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    let schema = SCHEMA.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../contracts/schemas/creative-task.schema.json"
        ))
        .expect("embedded creative task schema")
    });
    domain::schema::definition(schema, name)
}
pub(super) fn record_schema(record: &Value, name: &str) -> Result<()> {
    static VALIDATORS: OnceLock<BTreeMap<&str, OnceLock<jsonschema::Validator>>> = OnceLock::new();
    let validators = VALIDATORS.get_or_init(|| {
        [
            "project_record",
            "request_record",
            "state_record",
            "submission_record",
            "decision_record",
        ]
        .into_iter()
        .map(|name| (name, OnceLock::new()))
        .collect()
    });
    // 任务连接只编译实际读取的记录合同，不为打开任务预热筹备与决定等无关合同。
    let validator = validators[name].get_or_init(|| {
        jsonschema::validator_for(&definition(name)).expect("embedded creative record schema")
    });
    ensure(
        validator.is_valid(record),
        "hetu.integrity_failure",
        "筹备或任务记录不符合持久化合同。",
    )
}
fn root(task_id: &str) -> Result<String> {
    Ok(format!(".hetu/tasks/{}", checked_id(task_id, "task")?))
}
fn check_span<'a>(content: &'a str, range: &Value) -> Result<&'a str> {
    let start = usize::try_from(integer(range, "byte_start")?)
        .map_err(|_| Error::new("hetu.invalid_source_ref", "选区超出范围。"))?;
    let end = usize::try_from(integer(range, "byte_end")?)
        .map_err(|_| Error::new("hetu.invalid_source_ref", "选区超出范围。"))?;
    let selected = content.get(start..end).ok_or_else(|| {
        Error::new(
            "hetu.invalid_source_ref",
            "选区必须位于原文 UTF-8 字符边界内。",
        )
    })?;
    ensure(
        Some(selected) == range["quote"].as_str(),
        "hetu.invalid_source_ref",
        "选区引文与原文不一致。",
    )?;
    Ok(selected)
}
fn nonoverlapping(ranges: &[Value]) -> Result<Vec<Value>> {
    let mut ordered = ranges.to_vec();
    ordered.sort_by_key(|r| {
        (
            r["byte_start"].as_u64().unwrap(),
            r["byte_end"].as_u64().unwrap(),
        )
    });
    for pair in ordered.windows(2) {
        ensure(
            pair[0]["byte_end"].as_u64() <= pair[1]["byte_start"].as_u64()
                && pair[0]["byte_start"] != pair[1]["byte_start"],
            "invalid_input",
            "选区或改动不能重叠，也不能在同一位置重复插入。",
        )?;
    }
    Ok(ordered)
}

impl Kernel {
    fn scope_ref(&self) -> Value {
        json!({"kind":self.scope_kind(),"id":self.scope()})
    }
    fn scope_snapshot(&self) -> Result<Value> {
        if self.is_creation_project() {
            let (project, sha) = self.creation_project(None)?;
            ensure(
                !self.store.exists(".hetu/creation/active-intent.json")?,
                "hetu.recovery_required",
                "请先恢复此筹备的创建作品操作。",
            )?;
            ensure(
                project["created_workspace_ref"].is_null(),
                "revision_conflict",
                "此筹备已创建作品，请在新作品中准备任务。",
            )?;
            Ok(
                json!({"expected":{"revision":project["revision"],"sha256":sha},"context":{"brief":project["brief"],"selected_fields":project["selected_fields"]}}),
            )
        } else {
            let novel = self.get_novel()?;
            ensure(
                novel["initialized"] == true,
                "hetu.novel_initialization_required",
                "请先确认作品资料。",
            )?;
            let (bp, sha) = self.blueprint_revision(None)?;
            let context = json!({"metadata":novel["novel"]["metadata"],"blueprint_revision":bp["revision"],"blueprint_sha256":sha});
            Ok(
                json!({"expected":{"revision":novel["revision"],"sha256":digest(bytes(&json!({"novel_sha256":novel["sha256"],"context":context}))?)},"context":context}),
            )
        }
    }
    fn fixed_task_inputs(&self, input: &Value) -> Result<(Value, Value)> {
        ensure(
            input["scope_ref"] == self.scope_ref(),
            "forbidden",
            "任务范围不属于当前筹备或作品。",
        )?;
        ensure(
            !self.is_creation_project()
                || matches!(
                    input["task_kind"].as_str(),
                    Some("book_concept" | "book_profile" | "outline" | "cover")
                ),
            "forbidden",
            "建书筹备只支持构思、资料、大纲和封面任务。",
        )?;
        let snapshot = self.scope_snapshot()?;
        let mut sources = Vec::new();
        let mut seen = BTreeSet::new();
        for reference in input["input_refs"].as_array().unwrap() {
            ensure(
                !self.is_creation_project(),
                "forbidden",
                "建书筹备不能读取既有作品资料。",
            )?;
            ensure(
                seen.insert(reference.to_string()),
                "invalid_input",
                "输入引用不能重复。",
            )?;
            if reference["kind"] == "document" {
                let doc = self.document_content(
                    text(reference, "document_id")?,
                    Some(text(reference, "revision_id")?),
                )?;
                ensure(
                    doc["document"]["draft_source_id"].is_null(),
                    "forbidden",
                    "请明确选择作者文档作为任务原文。",
                )?;
                ensure(
                    text(&doc, "content")?.len() <= TEXT_LIMIT,
                    "hetu.budget_exceeded",
                    "单篇上下文超过 1 MiB，请缩小范围。",
                )?;
                sources.push(json!({"reference":reference,"title":doc["document"]["title"],"source_format":doc["document"]["source_format"],"sha256":doc["revision"]["sha256"],"content":doc["content"]}));
            } else {
                let (bp, sha) = self.blueprint_revision(Some(integer(reference, "revision")?))?;
                sources.push(json!({"reference":reference,"sha256":sha,"blueprint":bp}));
            }
        }
        if input["task_kind"] == "revision" {
            ensure(
                !self.is_creation_project() && input["edit_scope"].is_object(),
                "missing_context",
                "改稿须明确授权文档、基线和可改选区。",
            )?;
            let edit = &input["edit_scope"];
            let source = sources
                .iter()
                .find(|s| {
                    s["reference"]["kind"] == "document"
                        && s["reference"]["document_id"] == edit["document_id"]
                        && s["reference"]["revision_id"] == edit["revision_id"]
                })
                .ok_or_else(|| {
                    Error::new("missing_context", "可改文档必须包含在明确的任务输入中。")
                })?;
            let content = text(source, "content")?;
            ensure(
                content.len() <= TEXT_LIMIT,
                "hetu.budget_exceeded",
                "改稿原文超过 1 MiB。",
            )?;
            for range in edit["ranges"].as_array().unwrap() {
                check_span(content, range)?;
            }
            nonoverlapping(edit["ranges"].as_array().unwrap())?;
            let current = self.document(text(edit, "document_id")?)?;
            ensure(
                current["current_revision_id"] == edit["revision_id"],
                "revision_conflict",
                "正文已变化，请重新选区并准备任务。",
            )?;
        } else {
            ensure(
                input.get("edit_scope").is_none(),
                "invalid_input",
                "只有改稿任务可声明正文可改选区。",
            )?;
        }
        let fixed = json!({"scope_context":snapshot["context"],"sources":sources});
        ensure(
            bytes(&fixed)?.len() <= 2 * TEXT_LIMIT,
            "hetu.budget_exceeded",
            "外发上下文超过 2 MiB，请缩小范围。",
        )?;
        Ok((snapshot["expected"].clone(), fixed))
    }
    fn task_request(&self, task_id: &str) -> Result<(Value, String)> {
        let folder = root(task_id)?;
        let bytes = self.store.read(&format!("{folder}/request.json"))?;
        let sha = digest(&bytes);
        let record: Value = serde_json::from_slice(&bytes)?;
        record_schema(&record, "request_record")?;
        let head = self.store.json(&format!("{folder}/request-head.json"))?;
        ensure(
            record["schema_version"] == "1.0.0"
                && record["task_id"] == task_id
                && record["scope_ref"] == self.scope_ref()
                && record["request_revision"] == 1
                && head == json!({"task_id":task_id,"request_revision":1,"sha256":sha}),
            "hetu.integrity_failure",
            "任务请求身份、范围或摘要不一致。",
        )?;
        let contract_input = json!({"task_kind":record["task_kind"],"candidate_limit":record["output_contract"]["candidate_limit"]});
        ensure(
            record["output_contract"] == self.task_output_contract(&contract_input, task_id)?,
            "hetu.integrity_failure",
            "任务输出合同与固定身份不一致。",
        )?;
        Ok((record, sha))
    }
    fn task_state(&self, task_id: &str) -> Result<(Value, String)> {
        let folder = root(task_id)?;
        let head = self.store.json(&format!("{folder}/state.json"))?;
        let revision = integer(&head, "revision")?;
        ensure(
            revision > 0 && revision <= 1000,
            "hetu.budget_exceeded",
            "任务历史超过核验上限。",
        )?;
        let mut expected = text(&head, "sha256")?.to_owned();
        let mut current = Value::Null;
        for number in (1..=revision).rev() {
            let bytes = self.store.read(&format!("{folder}/states/{number}.json"))?;
            let value: Value = serde_json::from_slice(&bytes)?;
            record_schema(&value, "state_record")?;
            ensure(
                digest(&bytes) == expected
                    && value["task_id"] == task_id
                    && value["scope_ref"] == self.scope_ref()
                    && value["revision"] == number
                    && head["task_id"] == task_id,
                "hetu.integrity_failure",
                "任务观察记录或历史摘要不一致。",
            )?;
            ensure(
                matches!(
                    value["state"].as_str(),
                    Some(
                        "ready"
                            | "waiting_for_result"
                            | "result_received"
                            | "partial_result"
                            | "closed"
                    )
                ) && value["submission_refs"].is_array(),
                "hetu.integrity_failure",
                "任务状态记录无效。",
            )?;
            if number == revision {
                current = value.clone();
            }
            if number == 1 {
                ensure(
                    value["previous_sha256"].is_null(),
                    "hetu.integrity_failure",
                    "任务首修订的前序无效。",
                )?;
            } else {
                expected = text(&value, "previous_sha256")?.to_owned();
            }
        }
        Ok((current, text(&head, "sha256")?.to_owned()))
    }
    fn stage_task_state(
        &self,
        state: &mut Value,
        previous: Option<&str>,
        changes: &mut Changes,
    ) -> Result<String> {
        let folder = root(text(&state, "task_id")?)?;
        let revision = if previous.is_some() {
            integer(&state, "revision")?
                .checked_add(1)
                .ok_or_else(|| Error::new("hetu.budget_exceeded", "任务修订超过上限。"))?
        } else {
            1
        };
        ensure(
            revision <= 1000,
            "hetu.budget_exceeded",
            "任务历史达到上限，请保留历史并准备新任务。",
        )?;
        state["revision"] = json!(revision);
        state["previous_sha256"] = json!(previous);
        state["updated_at"] = json!(now());
        record_schema(state, "state_record")?;
        let path = format!("{folder}/states/{revision}.json");
        ensure(
            !self.store.exists(&path)?,
            "hetu.integrity_failure",
            "不能覆盖任务历史。",
        )?;
        let raw = bytes(state)?;
        let sha = digest(&raw);
        changes.insert(path, raw);
        changes.insert(
            format!("{folder}/state.json"),
            bytes(&json!({"task_id":state["task_id"],"revision":revision,"sha256":sha}))?,
        );
        Ok(sha)
    }
    fn task_for_reference(&self, reference: &Value) -> Result<(Value, String, Value, String)> {
        ensure(
            reference["scope_ref"] == self.scope_ref() && reference["request_revision"] == 1,
            "forbidden",
            "任务引用不属于当前范围或修订。",
        )?;
        let task_id = checked_id(text(reference, "task_id")?, "task")?;
        ensure(
            self.author || self.task_id.as_deref() == Some(&task_id),
            "forbidden",
            "此连接未获权访问该任务。",
        )?;
        let (request, sha) = self.task_request(&task_id)?;
        let (state, state_sha) = self.task_state(&task_id)?;
        if !self.author {
            ensure(
                state["state"] != "closed",
                "forbidden",
                "任务已关闭，连接不再有访问权。",
            )?;
        }
        Ok((request, sha, state, state_sha))
    }
    pub(super) fn check_task_session(&self) -> Result<()> {
        if let Some(task) = &self.task_id {
            checked_id(task, "task")?;
            ensure(
                !self.author,
                "invalid_input",
                "任务受限连接不能声明作者身份。",
            )?;
            self.task_request(task)?;
            ensure(
                self.task_state(task)?.0["state"] != "closed",
                "forbidden",
                "任务已关闭，不能继续访问。",
            )?;
        } else if !self.author && self.is_creation_project() {
            return Err(Error::new(
                "forbidden",
                "Agent 访问建书筹备必须绑定明确任务。",
            ));
        }
        Ok(())
    }
    pub(super) fn check_operation_task(&self, record: &Value) -> Result<()> {
        if let Some(task) = &self.task_id {
            ensure(
                record["task_id"] == *task,
                "forbidden",
                "原操作不属于当前获权任务。",
            )?;
        }
        Ok(())
    }
    pub(super) fn preview_creative_task(&self, input: &Value) -> Result<Value> {
        let (expected, fixed) = self.fixed_task_inputs(input)?;
        let task_id = id("task");
        let task_ref = json!({"scope_ref":self.scope_ref(),"task_id":task_id,"request_revision":1});
        let english = input["language_tag"] == "en";
        let prompt = if english {
            format!(
                "Use the Hetu Luoshu {} skill for task {}. Read the fixed task with hetu_read_creative_task; submit independent reference candidates with hetu_submit_creative_result.\nTask reference: {}\nAuthor request:\n{}\nRead access and edit scope are separate. For a revision task, submit UTF-8 patches only inside edit_scope.ranges; preserve all other bytes. Do not overwrite author documents, canon, finalizations, selected covers or Git state. If MCP is unavailable, write complete candidate files then a result manifest into the task inbox. Report missing capabilities honestly. After an unknown write, recover the original operation key before resending.",
                Self::task_skill(text(input, "task_kind")?),
                task_id,
                task_ref,
                text(input, "brief")?
            )
        } else {
            format!(
                "使用河图洛书 {} Skill 处理任务 {}。先用 hetu_read_creative_task 读取固定任务，再用 hetu_submit_creative_result 提交独立参考候选。\n任务引用：{}\n作者要求：\n{}\n读取范围与可改范围分开。改稿只提交 edit_scope.ranges 内的 UTF-8 patches，其他原文字节必须保留。不要覆盖作者正文、设定、定稿、正式封面或 Git 状态。没有 MCP 时先写完整候选文件，最后将结果清单写入本任务 inbox。能力缺失如实说明；写入结果未知先沿原操作键恢复，不换键重发。",
                Self::task_skill(text(input, "task_kind")?),
                task_id,
                task_ref,
                text(input, "brief")?
            )
        };
        let mut prepare = input.clone();
        prepare["task_id"] = json!(task_id);
        prepare["expected_scope"] = expected.clone();
        prepare["prompt"] = json!(prompt);
        Ok(
            json!({"task_ref":task_ref,"expected_scope":expected,"input_snapshot":fixed,"prompt":prompt,"prepare_input":prepare,"output_contract":self.task_output_contract(input,&task_id)?}),
        )
    }
    fn task_skill(kind: &str) -> &str {
        match kind {
            "book_concept" => "hetu-book-create",
            "book_profile" => "hetu-book-profile",
            "outline" => "hetu-outline",
            "cover" => "hetu-cover",
            "revision" => "hetu-revise",
            "drama_draft" => "hetu-drama",
            _ => "hetu-draft",
        }
    }
    fn task_output_contract(&self, input: &Value, task_id: &str) -> Result<Value> {
        let kinds: &[&str] = match text(input, "task_kind")? {
            "book_concept" => &["concept", "title", "synopsis", "outline"],
            "book_profile" => &["title", "synopsis"],
            "outline" => &["outline"],
            "cover" => &["image"],
            _ => &["text"],
        };
        Ok(
            json!({"artifact_types":kinds,"candidate_limit":input["candidate_limit"].as_u64().unwrap_or(4),"text_byte_limit":TEXT_LIMIT,"image_byte_limit":IMAGE_LIMIT,"submission_mode":["mcp","inbox"],"relative_inbox":format!("{}/inbox",root(task_id)?),"revision_requires_patches":input["task_kind"] == "revision"}),
        )
    }
    pub(super) fn prepare_creative_task(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let (expected, fixed) = self.fixed_task_inputs(input)?;
        ensure(
            input["expected_scope"] == expected,
            "revision_conflict",
            "作品或筹备上下文已变化，请重新预览。",
        )?;
        let task_id = text(input, "task_id")?;
        let folder = root(task_id)?;
        self.store.directory(&format!("{folder}/states"))?;
        self.store.directory(&format!("{folder}/inbox"))?;
        self.store.directory(&format!("{folder}/submissions"))?;
        self.store.directory(&format!("{folder}/candidates"))?;
        self.store.directory(&format!("{folder}/decisions"))?;
        ensure(
            !self.store.exists(&format!("{folder}/request.json"))?,
            "idempotency_conflict",
            "任务身份已有请求，不能覆盖。",
        )?;
        let request = json!({"schema_version":"1.0.0","task_id":task_id,"scope_ref":self.scope_ref(),"request_revision":1,"previous_sha256":null,"task_kind":input["task_kind"],"brief":input["brief"],"input_refs":input["input_refs"],"input_snapshot":fixed,"client_adapter":input["client_adapter"],"skill_ref":{"name":Self::task_skill(text(input,"task_kind")?),"contract_revision":"1"},"prompt":input["prompt"],"prompt_language":input["language_tag"],"output_contract":self.task_output_contract(input,task_id)?,"edit_scope":input["edit_scope"],"created_at":now()});
        record_schema(&request, "request_record")?;
        let raw = bytes(&request)?;
        let sha = digest(&raw);
        changes.insert(format!("{folder}/request.json"), raw);
        changes.insert(
            format!("{folder}/request-head.json"),
            bytes(&json!({"task_id":task_id,"request_revision":1,"sha256":sha}))?,
        );
        if self.is_creation_project() {
            self.stage_creation_task_reference(
                json!({"scope_ref":self.scope_ref(),"task_id":task_id,"request_revision":1}),
                changes,
            )?;
        }
        let mut state = json!({"schema_version":"1.0.0","task_id":task_id,"scope_ref":self.scope_ref(),"revision":1,"previous_sha256":null,"state":"ready","copied_at":null,"submission_refs":[],"last_decision_ref":null,"closed_reason":null,"created_at":now(),"updated_at":now()});
        let state_sha = self.stage_task_state(&mut state, None, changes)?;
        Ok(
            json!({"task_ref":{"scope_ref":self.scope_ref(),"task_id":task_id,"request_revision":1},"request":request,"request_sha256":sha,"observation":state,"expected":{"revision":1,"sha256":state_sha}}),
        )
    }
    fn read_submission(
        &self,
        task: &Value,
        state: &Value,
        submission_id: &str,
        include_content: bool,
    ) -> Result<Value> {
        checked_id(submission_id, "submission")?;
        let reference = state["submission_refs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["submission_id"] == submission_id)
            .ok_or_else(|| Error::new("not_found", "此任务没有该提交批次。"))?;
        let folder = root(text(task, "task_id")?)?;
        let raw = self
            .store
            .read(&format!("{folder}/submissions/{submission_id}.json"))?;
        ensure(
            reference["sha256"] == digest(&raw),
            "hetu.integrity_failure",
            "参考成果批次摘要不一致。",
        )?;
        let mut submission: Value = serde_json::from_slice(&raw)?;
        record_schema(&submission, "submission_record")?;
        ensure(
            submission["submission_id"] == submission_id
                && submission["task_ref"]
                    == json!({"scope_ref":self.scope_ref(),"task_id":task["task_id"],"request_revision":1}),
            "hetu.integrity_failure",
            "参考成果批次归属不一致。",
        )?;
        if include_content {
            for candidate in submission["candidates"]
                .as_array_mut()
                .ok_or_else(|| Error::new("hetu.integrity_failure", "候选清单无效。"))?
            {
                let candidate_id = checked_id(text(candidate, "candidate_id")?, "candidate")?;
                if candidate["kind"] == "image" {
                    let extension = match candidate["media_type"].as_str() {
                        Some("image/png") => "png",
                        Some("image/jpeg") => "jpg",
                        Some("image/webp") => "webp",
                        _ => {
                            return Err(Error::new(
                                "hetu.integrity_failure",
                                "候选图片媒体类型无效。",
                            ));
                        }
                    };
                    let path = format!(
                        "{folder}/candidates/{}.{}",
                        text(candidate, "sha256")?,
                        extension
                    );
                    ensure(
                        candidate["relative_path"] == path && candidate["validation"] == "decoded",
                        "hetu.integrity_failure",
                        "候选图片不属于本任务或未经解码核验。",
                    )?;
                    let mut file = self.store.managed_media(&path)?;
                    let scan = crate::infrastructure::media::scan(&mut file, None)?;
                    ensure(
                        scan["sha256"] == candidate["sha256"]
                            && scan["size_bytes"] == candidate["size_bytes"]
                            && scan["media_type"] == candidate["media_type"],
                        "hetu.integrity_failure",
                        "候选图片字节已变化。",
                    )?;
                } else {
                    let path = format!("{folder}/candidates/{candidate_id}.txt");
                    ensure(
                        candidate["relative_path"] == path,
                        "hetu.integrity_failure",
                        "候选正文路径不属于任务。",
                    )?;
                    let content = self.store.read(&path)?;
                    ensure(
                        content.len() <= TEXT_LIMIT
                            && candidate["sha256"] == digest(&content)
                            && candidate["size_bytes"] == content.len(),
                        "hetu.integrity_failure",
                        "候选内容摘要或长度不一致。",
                    )?;
                    candidate["content"] =
                        json!(String::from_utf8(content).map_err(|_| Error::new(
                            "hetu.integrity_failure",
                            "候选不是 UTF-8 文本。"
                        ))?);
                }
            }
        }
        Ok(submission)
    }
    pub(super) fn task_candidate(&self, reference: &Value) -> Result<Value> {
        let (task, _, state, _) = self.task_for_reference(&reference["task_ref"])?;
        let submission =
            self.read_submission(&task, &state, text(reference, "submission_id")?, true)?;
        submission["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["candidate_id"] == reference["candidate_id"])
            .cloned()
            .ok_or_else(|| Error::new("not_found", "此批次没有该候选。"))
    }
    pub(super) fn get_creative_task(&self, input: &Value) -> Result<Value> {
        let (request, sha, state, state_sha) = self.task_for_reference(&input["task_ref"])?;
        let submission_id = input["submission_id"].as_str().or_else(|| {
            state["submission_refs"]
                .as_array()
                .unwrap()
                .last()
                .and_then(|r| r["submission_id"].as_str())
        });
        let submission = submission_id
            .map(|id| self.read_submission(&request, &state, id, true))
            .transpose()?
            .unwrap_or(Value::Null);
        let decision = if state["last_decision_ref"].is_null() {
            Value::Null
        } else {
            let reference = &state["last_decision_ref"];
            let decision_id = checked_id(text(reference, "decision_id")?, "decision")?;
            let raw = self.store.read(&format!(
                "{}/decisions/{decision_id}.json",
                root(text(&request, "task_id")?)?
            ))?;
            ensure(
                reference["sha256"] == digest(&raw),
                "hetu.integrity_failure",
                "局部选择摘要不一致。",
            )?;
            let decision: Value = serde_json::from_slice(&raw)?;
            record_schema(&decision, "decision_record")?;
            ensure(
                decision["task_ref"] == input["task_ref"],
                "hetu.integrity_failure",
                "局部选择归属不一致。",
            )?;
            decision
        };
        Ok(
            json!({"request":request,"request_sha256":sha,"observation":state,"expected":{"revision":state["revision"],"sha256":state_sha},"submission":submission,"decision":decision}),
        )
    }
    pub(super) fn list_creative_tasks(&self, input: &Value) -> Result<Value> {
        let mut records = Vec::new();
        if self
            .store
            .entries(".hetu")?
            .iter()
            .any(|name| name == "tasks")
        {
            for task_id in self.store.entries(".hetu/tasks")? {
                let (request, sha) = self.task_request(&task_id)?;
                let (state, _) = self.task_state(&task_id)?;
                if input.get("state").is_none_or(|v| *v == state["state"]) {
                    records.push(json!({"task_ref":{"scope_ref":self.scope_ref(),"task_id":task_id,"request_revision":1},"task_kind":request["task_kind"],"brief":request["brief"],"request_sha256":sha,"state":state["state"],"submission_count":state["submission_refs"].as_array().unwrap().len(),"created_at":request["created_at"]}));
                }
            }
        }
        let mut page = input.clone();
        if page.get("limit").is_none() {
            page["limit"] = json!(20);
        }
        self.record_page(&page, records, "tasks")
    }
    fn edited_reference_content(&self, task: &Value, candidate: &Value) -> Result<String> {
        ensure(
            candidate.get("patches").is_some() && candidate["kind"] == "text",
            "forbidden",
            "改稿只能提交授权范围内的补丁，不能用整章替换绕过选区。",
        )?;
        let edit = &task["edit_scope"];
        let source = task["input_snapshot"]["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| {
                s["reference"]["document_id"] == edit["document_id"]
                    && s["reference"]["revision_id"] == edit["revision_id"]
            })
            .ok_or_else(|| Error::new("hetu.integrity_failure", "任务缺少固定改稿原文。"))?;
        ensure(
            candidate["source_format"] == source["source_format"],
            "invalid_input",
            "改稿格式必须与原文一致。",
        )?;
        let original = text(source, "content")?;
        let patches = nonoverlapping(candidate["patches"].as_array().unwrap())?;
        let mut replacement_bytes = 0usize;
        for patch in &patches {
            check_span(original, patch)?;
            let start = integer(patch, "byte_start")?;
            let end = integer(patch, "byte_end")?;
            let allowed = edit["ranges"].as_array().unwrap().iter().any(|range| {
                let from = range["byte_start"].as_u64().unwrap();
                let to = range["byte_end"].as_u64().unwrap();
                if start == end {
                    from <= start && start <= to
                } else {
                    from <= start && end <= to
                }
            });
            ensure(allowed, "forbidden", "改动超出作者本次授权的可改选区。")?;
            replacement_bytes = replacement_bytes.saturating_add(text(patch, "replacement")?.len());
            ensure(
                replacement_bytes <= TEXT_LIMIT,
                "hetu.budget_exceeded",
                "补丁替换内容超过 1 MiB。",
            )?;
        }
        let mut edited = original.to_owned();
        for patch in patches.iter().rev() {
            edited.replace_range(
                integer(patch, "byte_start")? as usize..integer(patch, "byte_end")? as usize,
                text(patch, "replacement")?,
            );
        }
        ensure(
            edited.len() <= TEXT_LIMIT && !edited.contains('\0'),
            "hetu.budget_exceeded",
            "改稿后参考文本含 NUL 或超过 1 MiB。",
        )?;
        Ok(edited)
    }
    fn text_candidate(&self, task: &Value, candidate: &Value) -> Result<String> {
        if task["task_kind"] == "revision" {
            return self.edited_reference_content(task, candidate);
        }
        ensure(
            candidate.get("patches").is_none(),
            "invalid_input",
            "补丁仅用于有明确可改范围的改稿任务。",
        )?;
        let content = if let Some(content) = candidate["content"].as_str() {
            content.to_owned()
        } else {
            let path = format!(
                "{}/inbox/{}",
                root(text(task, "task_id")?)?,
                text(candidate, "file_name")?
            );
            let raw = self.store.read(&path)?;
            ensure(
                raw.len() <= TEXT_LIMIT && candidate["sha256"] == digest(&raw),
                "hetu.integrity_failure",
                "参考文本与清单摘要不符或超过预算。",
            )?;
            String::from_utf8(raw)
                .map_err(|_| Error::new("invalid_input", "参考文本必须是 UTF-8。"))?
        };
        ensure(
            !content.trim().is_empty() && content.len() <= TEXT_LIMIT && !content.contains('\0'),
            "hetu.budget_exceeded",
            "参考文本为空、含 NUL 或超过 1 MiB。",
        )?;
        let valid = match candidate["kind"].as_str() {
            Some("title" | "synopsis" | "concept") => candidate["source_format"] == "plain",
            Some("outline") => candidate["source_format"] == "markdown",
            Some("text") => {
                if task["task_kind"] == "drama_draft" {
                    candidate["source_format"] == "fountain"
                } else {
                    candidate["source_format"] == "markdown"
                }
            }
            _ => false,
        };
        ensure(valid, "invalid_input", "候选种类与源格式不一致。")?;
        Ok(content)
    }
    fn image_candidate(&self, task: &Value, candidate: &Value) -> Result<Value> {
        ensure(
            candidate["source_format"] == "image"
                && candidate.get("file_name").is_some()
                && candidate.get("content").is_none(),
            "invalid_input",
            "图片候选须通过任务 inbox 中的实际文件提交。",
        )?;
        let inbox = format!(
            "{}/inbox/{}",
            root(text(task, "task_id")?)?,
            text(candidate, "file_name")?
        );
        let mut file = self.store.managed_media(&inbox)?;
        let image = crate::infrastructure::media::decode_image(&mut file)?;
        let scan = &image.scan;
        ensure(
            scan["sha256"] == candidate["sha256"],
            "hetu.integrity_failure",
            "图片候选摘要不一致。",
        )?;
        let extension = text(scan, "extension")?;
        let name = text(candidate, "file_name")?;
        ensure(
            name.rsplit_once('.').is_some_and(|(_, ext)| {
                ext.eq_ignore_ascii_case(extension)
                    || extension == "jpg" && ext.eq_ignore_ascii_case("jpeg")
            }),
            "invalid_input",
            "图片扩展名与实际媒体类型不一致。",
        )?;
        let (width, height) = (image.decoded.width(), image.decoded.height());
        let blob = format!(
            "{}/candidates/{}.{}",
            root(text(task, "task_id")?)?,
            text(&scan, "sha256")?,
            extension
        );
        if self.store.exists(&blob)? {
            let mut existing = self.store.managed_media(&blob)?;
            ensure(
                crate::infrastructure::media::scan(&mut existing, None)?["sha256"]
                    == scan["sha256"],
                "hetu.integrity_failure",
                "既有候选图片摘要不一致。",
            )?;
        } else {
            self.store.import_media(&blob, &mut file, &scan)?;
        }
        Ok(
            json!({"relative_path":blob,"sha256":scan["sha256"],"size_bytes":scan["size_bytes"],"media_type":scan["media_type"],"width":width,"height":height,"validation":"decoded"}),
        )
    }
    fn stage_task_draft(
        &self,
        task: &Value,
        candidate: &Value,
        content: &str,
        changes: &mut Changes,
    ) -> Result<Value> {
        let draft_id = id("draft");
        let package = if candidate["source_format"] == "fountain" {
            "drama"
        } else {
            "novel"
        };
        let ext = if package == "drama" { "fountain" } else { "md" };
        let path = format!("packages/{package}/drafts/{draft_id}/content.{ext}");
        self.store
            .directory(&format!("packages/{package}/drafts/{draft_id}"))?;
        let bp = &task["input_snapshot"]["scope_context"]["blueprint_revision"];
        let mut draft = json!({"schema_version":"1.0.0","draft_id":draft_id,"revision":1,"package":package,"source_format":candidate["source_format"],"content_path":path,"content_sha256":digest(content),"size_bytes":content.len(),"state":"submitted","actor_ref":self.actor(),"created_at":now(),"blueprint_revision":bp,"diagnostic_state":"not_requested","title":candidate["title"],"language_tag":task["prompt_language"],"creative_task_ref":{"scope_ref":self.scope_ref(),"task_id":task["task_id"],"request_revision":1}});
        if !task["edit_scope"].is_null() {
            draft["target_document_id"] = task["edit_scope"]["document_id"].clone();
            draft["base_revision_id"] = task["edit_scope"]["revision_id"].clone();
        }
        self.anchor_draft(&mut draft, changes)?;
        self.stage_draft(&draft, changes)?;
        changes.insert(path, content.as_bytes().to_vec());
        Ok(json!({"draft_id":draft_id,"revision":1,"sha256":digest(content)}))
    }
    pub(super) fn submit_creative_result(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let (task, request_sha, mut state, previous) =
            self.task_for_reference(&input["task_ref"])?;
        ensure(
            input["request_sha256"] == request_sha,
            "revision_conflict",
            "结果未绑定此固定任务请求。",
        )?;
        ensure(
            state["state"] != "closed",
            "forbidden",
            "已关闭任务不能接收新候选。",
        )?;
        let candidates = input["candidates"].as_array().unwrap();
        ensure(
            candidates.len() as u64 <= integer(&task["output_contract"], "candidate_limit")?
                && state["submission_refs"].as_array().unwrap().len() < 100,
            "hetu.budget_exceeded",
            "候选数量或批次数超过任务预算。",
        )?;
        ensure(
            input["complete"] != true || input["missing_items"].as_array().unwrap().is_empty(),
            "invalid_input",
            "完整结果不能同时声明缺项。",
        )?;
        let folder = root(text(&task, "task_id")?)?;
        let submission_id = id("submission");
        let mut saved = Vec::new();
        for candidate in candidates {
            ensure(
                task["output_contract"]["artifact_types"]
                    .as_array()
                    .unwrap()
                    .contains(&candidate["kind"]),
                "invalid_input",
                "候选类型不属于本任务输出合同。",
            )?;
            let mut sources = Vec::new();
            for index in candidate["source_ref_indices"].as_array().unwrap() {
                sources.push(
                    task["input_refs"]
                        .as_array()
                        .unwrap()
                        .get(index.as_u64().unwrap() as usize)
                        .cloned()
                        .ok_or_else(|| {
                            Error::new(
                                "hetu.invalid_source_ref",
                                "候选引用了不在固定任务中的来源。",
                            )
                        })?,
                );
            }
            let candidate_id = id("candidate");
            let mut record = json!({"candidate_id":candidate_id,"kind":candidate["kind"],"title":candidate["title"],"source_format":candidate["source_format"],"language_tag":task["prompt_language"],"source_refs":sources});
            if candidate["kind"] == "image" {
                let media = self.image_candidate(&task, candidate)?;
                for (key, value) in media.as_object().unwrap() {
                    record[key] = value.clone();
                }
            } else {
                let content = self.text_candidate(&task, candidate)?;
                let path = format!("{folder}/candidates/{candidate_id}.txt");
                record["relative_path"] = json!(path);
                record["sha256"] = json!(digest(&content));
                record["size_bytes"] = json!(content.len());
                if candidate.get("patches").is_some() {
                    record["patches"] = candidate["patches"].clone();
                }
                if !self.is_creation_project()
                    && matches!(candidate["kind"].as_str(), Some("text" | "outline"))
                {
                    record["draft_ref"] =
                        self.stage_task_draft(&task, candidate, &content, changes)?;
                }
                changes.insert(path, content.into_bytes());
            }
            saved.push(record);
        }
        let submission = json!({"schema_version":"1.0.0","submission_id":submission_id,"task_ref":input["task_ref"],"request_sha256":request_sha,"candidates":saved,"complete":input["complete"],"missing_items":input["missing_items"],"provenance":input["provenance"],"received_at":now()});
        record_schema(&submission, "submission_record")?;
        let raw = bytes(&submission)?;
        let reference = json!({"submission_id":submission_id,"sha256":digest(&raw)});
        changes.insert(format!("{folder}/submissions/{submission_id}.json"), raw);
        state["submission_refs"]
            .as_array_mut()
            .unwrap()
            .push(reference.clone());
        state["state"] = json!(if input["complete"] == true {
            "result_received"
        } else {
            "partial_result"
        });
        let sha = self.stage_task_state(&mut state, Some(&previous), changes)?;
        Ok(
            json!({"submission_ref":reference,"submission":submission,"expected":{"revision":integer(&state,"revision")?,"sha256":sha},"approval_state":"awaiting_author"}),
        )
    }
    pub(super) fn inspect_task_inbox(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let (task, _, _, _) = self.task_for_reference(&input["task_ref"])?;
        let path = format!(
            "{}/inbox/{}",
            root(text(&task, "task_id")?)?,
            text(input, "file_name")?
        );
        let raw = self.store.read(&path)?;
        ensure(
            input["manifest_sha256"] == digest(&raw),
            "revision_conflict",
            "结果清单尚未完整写入或与预览摘要不一致。",
        )?;
        let mut manifest: Value = serde_json::from_slice(&raw)?;
        manifest["operation_key"] = input["operation_key"].clone();
        schema(&manifest, &definition("submit_input"))?;
        ensure(
            manifest["task_ref"] == input["task_ref"],
            "forbidden",
            "清单不属于当前任务。",
        )?;
        self.submit_creative_result(&manifest, changes)
    }
    pub(super) fn close_creative_task(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let (_, _, mut state, previous) = self.task_for_reference(&input["task_ref"])?;
        ensure(
            input["expected"] == json!({"revision":state["revision"],"sha256":previous}),
            "revision_conflict",
            "任务已有新结果，请重新查看后关闭。",
        )?;
        state["state"] = json!("closed");
        state["closed_reason"] = input["reason"].clone();
        let sha = self.stage_task_state(&mut state, Some(&previous), changes)?;
        Ok(
            json!({"state":"closed","expected":{"revision":integer(&state,"revision")?,"sha256":sha}}),
        )
    }
    pub(super) fn mark_task_copied(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let (_, request_sha, mut state, previous) = self.task_for_reference(&input["task_ref"])?;
        ensure(
            input["request_sha256"] == request_sha && state["state"] != "closed",
            "revision_conflict",
            "任务请求已变化或关闭。",
        )?;
        state["copied_at"] = json!(now());
        if state["state"] == "ready" {
            state["state"] = json!("waiting_for_result");
        }
        let sha = self.stage_task_state(&mut state, Some(&previous), changes)?;
        Ok(
            json!({"state":state["state"],"copied_at":state["copied_at"],"expected":{"revision":integer(&state,"revision")?,"sha256":sha}}),
        )
    }
    pub(super) fn get_task_interaction(&self, input: &Value) -> Result<Value> {
        let mut result = self.get_creative_task(input)?;
        result["allowed_actions"] = json!(["hetu.interactions.save_selection"]);
        result["effect"] = json!("preference_only");
        let mut previews = Vec::new();
        if let Some(candidates) = result["submission"]["candidates"].as_array() {
            for candidate in candidates.iter().filter(|item| item["kind"] == "image") {
                // 路径与原字节已经过 read_submission 核验；缩略图不提供任意文件读取。
                let mut file = self
                    .store
                    .managed_media(text(candidate, "relative_path")?)?;
                let image = crate::infrastructure::media::decode_image(&mut file)?;
                ensure(
                    image.scan["sha256"] == candidate["sha256"],
                    "revision_conflict",
                    "封面候选读取期间发生变化。",
                )?;
                let mut preview = crate::infrastructure::media::image_preview(&image.decoded)?;
                preview["candidate_id"] = candidate["candidate_id"].clone();
                previews.push(preview);
            }
        }
        result["image_previews"] = json!(previews);
        Ok(result)
    }
    pub(super) fn save_task_selection(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let (task, _, mut state, previous) = self.task_for_reference(&input["task_ref"])?;
        ensure(
            state["state"] != "closed"
                && input["expected"] == json!({"revision":state["revision"],"sha256":previous}),
            "revision_conflict",
            "任务已变化或关闭，请重新比较。",
        )?;
        let mut seen = BTreeSet::new();
        for reference in input["candidate_refs"].as_array().unwrap() {
            ensure(
                reference["task_ref"] == input["task_ref"] && seen.insert(reference.to_string()),
                "forbidden",
                "局部选择只能引用本任务的不同候选。",
            )?;
            self.task_candidate(reference)?;
        }
        let decision_id = id("decision");
        let decision = json!({"schema_version":"1.0.0","decision_id":decision_id,"task_ref":input["task_ref"],"candidate_refs":input["candidate_refs"],"comment":input["comment"],"actor_ref":self.actor(),"effect":"preference_only","previous_decision_ref":state["last_decision_ref"],"created_at":now()});
        record_schema(&decision, "decision_record")?;
        let raw = bytes(&decision)?;
        let reference = json!({"decision_id":decision_id,"sha256":digest(&raw)});
        changes.insert(
            format!(
                "{}/decisions/{decision_id}.json",
                root(text(&task, "task_id")?)?
            ),
            raw,
        );
        state["last_decision_ref"] = reference.clone();
        let sha = self.stage_task_state(&mut state, Some(&previous), changes)?;
        Ok(
            json!({"decision":decision,"decision_ref":reference,"expected":{"revision":integer(&state,"revision")?,"sha256":sha},"effect":"preference_only"}),
        )
    }
}
