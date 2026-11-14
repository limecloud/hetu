use super::*;

fn revision_ref(revision: &Value) -> Value {
    json!({"working_copy_id":revision["working_copy_id"],"working_revision_id":revision["working_revision_id"],"sha256":revision["sha256"]})
}

impl Kernel {
    pub(super) fn working_head(
        &self,
        task_ref: &Value,
        copy_id: &str,
    ) -> Result<(Value, Value, String)> {
        let (_, request_sha, state, _) = self.task_for_reference(task_ref)?;
        checked_id(copy_id, "working")?;
        let reference = state["working_copy_refs"]
            .as_array()
            .and_then(|refs| refs.iter().find(|r| r["working_copy_id"] == copy_id))
            .ok_or_else(|| Error::new("not_found", "本任务没有这份参考稿。"))?;
        let folder = format!("{}/working/{copy_id}", root(text(task_ref, "task_id")?)?);
        let raw = self.store.read(&format!("{folder}/head.json"))?;
        ensure(
            reference["sha256"] == digest(&raw),
            "hetu.integrity_failure",
            "参考稿头摘要不一致。",
        )?;
        let copy: Value = serde_json::from_slice(&raw)?;
        record_schema(&copy, "working_record")?;
        ensure(
            copy["working_copy_id"] == copy_id
                && copy["task_ref"] == *task_ref
                && copy["request_sha256"] == request_sha,
            "hetu.integrity_failure",
            "参考稿不属于当前固定任务。",
        )?;
        Ok((copy, state, folder))
    }

    /// 从受任务状态锚定的头向前验证记录链；旧引用始终读取旧字节。
    pub(super) fn working_revision(&self, task_ref: &Value, reference: &Value) -> Result<Value> {
        let (copy, _, folder) = self.working_head(task_ref, text(reference, "working_copy_id")?)?;
        let mut next = copy["current_revision_ref"].clone();
        let mut record_sha = copy["current_revision_sha256"].clone();
        let mut visited = BTreeSet::new();
        let mut history = Vec::new();
        let mut found = None;
        loop {
            let revision_id = checked_id(text(&next, "working_revision_id")?, "wrev")?;
            ensure(
                visited.insert(revision_id.clone()) && visited.len() <= 100,
                "hetu.integrity_failure",
                "参考稿修订链无效或超过上限。",
            )?;
            let raw = self
                .store
                .read(&format!("{folder}/revisions/{revision_id}.json"))?;
            ensure(
                record_sha == digest(&raw),
                "hetu.integrity_failure",
                "参考稿修订摘要不一致。",
            )?;
            let revision: Value = serde_json::from_slice(&raw)?;
            record_schema(&revision, "working_revision_record")?;
            ensure(
                revision_ref(&revision) == next
                    && revision["working_copy_id"] == copy["working_copy_id"],
                "hetu.integrity_failure",
                "参考稿修订归属不一致。",
            )?;
            let path = format!("{folder}/content/{revision_id}.txt");
            ensure(
                revision["content_ref"] == path,
                "hetu.integrity_failure",
                "参考稿内容路径不一致。",
            )?;
            history.push(json!({"working_copy_ref":revision_ref(&revision),"feedback_refs":revision["feedback_refs"],"created_at":revision["created_at"]}));
            if next == *reference {
                let content = self.store.read(&path)?;
                ensure(
                    content.len() <= TEXT_LIMIT
                        && revision["sha256"] == digest(&content)
                        && revision["size_bytes"] == content.len(),
                    "hetu.integrity_failure",
                    "参考稿内容已被外部修改。",
                )?;
                let mut result = revision.clone();
                result["content"] = json!(String::from_utf8(content).map_err(|_| Error::new(
                    "hetu.integrity_failure",
                    "参考稿不是 UTF-8 文本。"
                ))?);
                found = Some(result);
            }
            if revision["parent_revision_ref"].is_null() {
                ensure(
                    revision["previous_sha256"].is_null(),
                    "hetu.integrity_failure",
                    "首修订的前序摘要无效。",
                )?;
                break;
            }
            next = revision["parent_revision_ref"].clone();
            record_sha = revision["previous_sha256"].clone();
        }
        let revision =
            found.ok_or_else(|| Error::new("not_found", "这份参考稿没有指定的固定修订。"))?;
        Ok(
            json!({"working_copy":copy,"revision":revision,"working_copy_ref":reference,"current_revision_ref":copy["current_revision_ref"],"history":history}),
        )
    }

    pub(in crate::application) fn get_working_copy(&self, input: &Value) -> Result<Value> {
        self.working_revision(&input["task_ref"], &input["working_copy_ref"])
    }
    pub(in crate::application) fn list_working_copies(&self, input: &Value) -> Result<Value> {
        let (_, _, state, _) = self.task_for_reference(&input["task_ref"])?;
        let mut copies = Vec::new();
        for r in state["working_copy_refs"].as_array().into_iter().flatten() {
            let (copy, _, _) =
                self.working_head(&input["task_ref"], text(r, "working_copy_id")?)?;
            copies.push(copy);
        }
        let mut page = input.clone();
        if page.get("limit").is_none() {
            page["limit"] = json!(20);
        }
        self.record_page(&page, copies, "working_copies")
    }
    fn working_content(&self, task: &Value, copy: &Value, input: &Value) -> Result<String> {
        ensure(
            task["output_contract"]["artifact_types"]
                .as_array()
                .unwrap()
                .contains(&copy["artifact_kind"]),
            "forbidden",
            "本任务不允许这类参考稿。",
        )?;
        let mut candidate =
            json!({"kind":copy["artifact_kind"],"source_format":copy["source_format"]});
        for key in ["content", "patches"] {
            if let Some(value) = input.get(key) {
                candidate[key] = value.clone();
            }
        }
        self.text_candidate(task, &candidate)
    }
    fn stage_working_revision(
        &self,
        copy: &mut Value,
        input: &Value,
        content: String,
        changes: &mut Changes,
    ) -> Result<Value> {
        let task_ref = &copy["task_ref"];
        let feedback = input.get("feedback_refs").cloned().unwrap_or(json!([]));
        self.check_feedback_refs(task_ref, &feedback)?;
        let copy_id = text(copy, "working_copy_id")?;
        let folder = format!("{}/working/{copy_id}", root(text(task_ref, "task_id")?)?);
        let revision_id = id("wrev");
        let path = format!("{folder}/content/{revision_id}.txt");
        let mut revision = json!({"schema_version":"1.0.0","working_revision_id":revision_id,"working_copy_id":copy_id,"parent_revision_ref":copy["current_revision_ref"],"previous_sha256":copy["current_revision_sha256"],"content_ref":path,"sha256":digest(&content),"size_bytes":content.len(),"feedback_refs":feedback,"actor_ref":self.actor(),"created_at":now()});
        if let Some(patches) = input.get("patches") {
            revision["patches"] = patches.clone();
        }
        record_schema(&revision, "working_revision_record")?;
        let raw = bytes(&revision)?;
        copy["current_revision_ref"] = revision_ref(&revision);
        copy["current_revision_sha256"] = json!(digest(&raw));
        record_schema(copy, "working_record")?;
        changes.insert(format!("{folder}/revisions/{revision_id}.json"), raw);
        changes.insert(path, content.into_bytes());
        changes.insert(format!("{folder}/head.json"), bytes(copy)?);
        Ok(
            json!({"working_copy":copy,"working_copy_ref":copy["current_revision_ref"],"revision":revision,"effect":"reference_only"}),
        )
    }
    fn anchor_working_copy(
        &self,
        copy: &Value,
        state: &mut Value,
        previous: &str,
        changes: &mut Changes,
    ) -> Result<()> {
        if !state["working_copy_refs"].is_array() {
            state["working_copy_refs"] = json!([]);
        }
        let refs = state["working_copy_refs"].as_array_mut().unwrap();
        let reference =
            json!({"working_copy_id":copy["working_copy_id"],"sha256":digest(bytes(copy)?)});
        if let Some(old) = refs
            .iter_mut()
            .find(|r| r["working_copy_id"] == copy["working_copy_id"])
        {
            *old = reference;
        } else {
            ensure(
                refs.len() < 100,
                "hetu.budget_exceeded",
                "任务参考稿数量达到上限。",
            )?;
            refs.push(reference);
        }
        self.stage_task_state(state, Some(previous), changes)?;
        Ok(())
    }
    pub(in crate::application) fn create_working_copy(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let (task, sha, mut state, previous) = self.task_for_reference(&input["task_ref"])?;
        ensure(
            state["state"] != "closed",
            "forbidden",
            "已关闭任务不能保存参考稿。",
        )?;
        for base in input["base_refs"].as_array().unwrap() {
            ensure(
                task["input_refs"].as_array().unwrap().contains(base),
                "forbidden",
                "参考稿不能引入未授权来源。",
            )?;
        }
        let parent = input.get("parent_ref").cloned().unwrap_or(Value::Null);
        if !parent.is_null() {
            self.working_revision(&input["task_ref"], &parent)?;
        }
        let mut copy = json!({"schema_version":"1.0.0","working_copy_id":id("working"),"task_ref":input["task_ref"],"request_sha256":sha,"artifact_kind":input["artifact_kind"],"source_format":input["source_format"],"title":input["title"],"base_refs":input["base_refs"],"parent_ref":parent,"current_revision_ref":null,"current_revision_sha256":null,"created_at":now()});
        let content = self.working_content(&task, &copy, input)?;
        let result = self.stage_working_revision(&mut copy, input, content, changes)?;
        self.anchor_working_copy(&copy, &mut state, &previous, changes)?;
        Ok(result)
    }
    pub(in crate::application) fn save_working_copy(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let (task, _, mut state, previous) = self.task_for_reference(&input["task_ref"])?;
        ensure(
            state["state"] != "closed",
            "forbidden",
            "已关闭任务不能保存参考稿。",
        )?;
        let (mut copy, _, folder) =
            self.working_head(&input["task_ref"], text(input, "working_copy_id")?)?;
        ensure(
            input["expected"] == copy["current_revision_ref"],
            "revision_conflict",
            "参考稿已有新修订，请保留本地稿并比较。",
        )?;
        self.working_revision(&input["task_ref"], &input["expected"])?;
        ensure(
            self.store.entries(&format!("{folder}/revisions"))?.len() < 100,
            "hetu.budget_exceeded",
            "参考稿修订达到上限，请创建后继稿。",
        )?;
        let content = self.working_content(&task, &copy, input)?;
        let result = self.stage_working_revision(&mut copy, input, content, changes)?;
        self.anchor_working_copy(&copy, &mut state, &previous, changes)?;
        Ok(result)
    }
    pub(super) fn candidate_from_working(
        &self,
        task_ref: &Value,
        reference: &Value,
    ) -> Result<Value> {
        let saved = self.working_revision(task_ref, reference)?;
        let copy = &saved["working_copy"];
        let (task, _, _, _) = self.task_for_reference(task_ref)?;
        let indices: Vec<_> = copy["base_refs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|base| {
                task["input_refs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .position(|r| r == base)
                    .map(|i| json!(i))
                    .ok_or_else(|| {
                        Error::new("hetu.integrity_failure", "参考稿来源不属于固定请求。")
                    })
            })
            .collect::<Result<_>>()?;
        let mut candidate = json!({"kind":copy["artifact_kind"],"title":copy["title"],"source_format":copy["source_format"],"source_ref_indices":indices});
        if task["task_kind"] == "revision" {
            candidate["patches"] = saved["revision"]["patches"].clone();
        } else {
            candidate["content"] = saved["revision"]["content"].clone();
        }
        Ok(candidate)
    }
}
