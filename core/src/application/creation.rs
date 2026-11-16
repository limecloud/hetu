use super::*;

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CreateProjectConfig {
    brief: String,
    locale: String,
    operation_key: String,
}

impl Kernel {
    pub(crate) fn creation_start_receipt(&self, key: &str) -> Result<Value> {
        let record = self.store.json(&operation_path(
            "hetu.creation_projects.create",
            key,
            self.author,
        ))?;
        Ok(record["result"].clone())
    }
    pub(super) fn open_creation_project(
        options: OpenConfig,
        management_grant: Option<Value>,
    ) -> Result<Self> {
        let path = Path::new(options.creation_project_path.as_deref().unwrap());
        ensure(
            path.is_absolute(),
            "invalid_input",
            "筹备目录必须是明确的绝对路径。",
        )?;
        let author = options.mode == Mode::Author;
        if let Some(create) = &options.create_project {
            ensure(
                (author || management_grant.is_some()) && options.task_id.is_none(),
                "forbidden",
                "只有作者可以创建建书筹备。",
            )?;
            ensure(
                create.brief.chars().count() <= 20000
                    && matches!(create.locale.as_str(), "zh-CN" | "en")
                    && !create.operation_key.is_empty()
                    && create.operation_key.len() <= 128,
                "invalid_input",
                "筹备想法、语言或操作键无效。",
            )?;
            if !path.exists() {
                std::fs::create_dir(path)?;
            }
        }
        let store = Store::open(path)?;
        ensure(
            !store.exists(".heturc.json")?,
            "invalid_input",
            "作品目录不能作为建书筹备。",
        )?;
        let entries = store.entries("")?;
        ensure(
            entries
                .iter()
                .all(|name| matches!(name.as_str(), ".hetu" | ".hetu-project.json")),
            "invalid_input",
            "筹备目录包含其他内容，请选择独立目录。",
        )?;
        if !store.exists(".hetu-project.json")? {
            ensure(
                options.create_project.is_some(),
                "not_found",
                "未找到建书筹备。",
            )?;
        }
        for directory in [
            ".hetu/transactions",
            ".hetu/operations",
            ".hetu/audit",
            ".hetu/creation/revisions",
        ] {
            store.directory(directory)?;
        }
        let _lock = if options.create_project.is_some() {
            Some(store.lock()?)
        } else {
            None
        };
        if _lock.is_some() {
            store.recover()?;
        }
        if !store.exists(".hetu-project.json")? {
            let create = options.create_project.as_ref().unwrap();
            let marker =
                json!({"schema_version":"1.0.0","project_id":id("project"),"locale":create.locale});
            let project = json!({"schema_version":"1.0.0","project_id":marker["project_id"],"revision":1,"previous_sha256":null,"brief":create.brief,"selected_fields":{},"task_refs":[],"created_workspace_ref":null,"created_at":now(),"updated_at":now()});
            let mut changes = Changes::new();
            changes.insert(".hetu-project.json".into(), bytes(&marker)?);
            Self::stage_project_record(&store, &project, &mut changes)?;
            let input_digest = Self::input_digest(&serde_json::to_value(create)?)?;
            let mut result = domain::success(
                "hetu.creation_projects.create",
                marker["project_id"].as_str().unwrap(),
                json!({"project":project,"revision":1,"sha256":digest(bytes(&project)?)}),
            );
            result["operation"] = Self::operation(&create.operation_key, &input_digest);
            changes.insert(operation_path("hetu.creation_projects.create", &create.operation_key, author), bytes(&json!({"action":"hetu.creation_projects.create","actor_scope":if author {"author"} else {"agent"},"operation_id":result["operation"]["id"],"key":create.operation_key,"input_digest":input_digest,"result":result}))?);
            store.transaction(&changes)?;
        }
        let _read = store.read_lock()?;
        let marker_bytes = store.read(".hetu-project.json")?;
        let marker: Value = serde_json::from_slice(&marker_bytes)?;
        ensure(
            marker["schema_version"] == "1.0.0"
                && matches!(marker["locale"].as_str(), Some("zh-CN" | "en")),
            "unsupported_version",
            "建书筹备格式不受支持。",
        )?;
        checked_id(text(&marker, "project_id")?, "project")?;
        if let Some(create) = &options.create_project {
            let original = store.json(&operation_path(
                "hetu.creation_projects.create",
                &create.operation_key,
                author,
            ))?;
            ensure(
                original["input_digest"] == Self::input_digest(&serde_json::to_value(create)?)?,
                "idempotency_conflict",
                "此筹备已创建，原操作输入不一致。",
            )?;
        }
        let kernel = Self {
            #[cfg(test)]
            model_service_directory: None,
            store,
            config: marker,
            config_sha: digest(marker_bytes),
            author,
            workspace_path: path.canonicalize()?,
            authorization_path: options.authorization_path,
            collaboration_grant: options.collaboration_grant,
            task_id: options.task_id,
            management_grant,
        };
        kernel.creation_project(None)?;
        kernel.check_task_session()?;
        Ok(kernel)
    }

    fn stage_project_record(
        store: &Store,
        record: &Value,
        changes: &mut Changes,
    ) -> Result<String> {
        let revision = integer(record, "revision")?;
        let path = format!(".hetu/creation/revisions/{revision}.json");
        ensure(
            !store.exists(&path)?,
            "hetu.integrity_failure",
            "不能覆盖既有筹备修订。",
        )?;
        let content = bytes(record)?;
        let sha = digest(&content);
        changes.insert(path, content);
        changes.insert(
            ".hetu/creation/head.json".into(),
            bytes(&json!({"project_id":record["project_id"],"revision":revision,"sha256":sha}))?,
        );
        Ok(sha)
    }

    pub(super) fn creation_project(&self, revision: Option<u64>) -> Result<(Value, String)> {
        ensure(
            self.is_creation_project(),
            "forbidden",
            "当前连接不是建书筹备。",
        )?;
        let head = self.store.json(".hetu/creation/head.json")?;
        let latest = integer(&head, "revision")?;
        let target = revision.unwrap_or(latest);
        ensure(
            target > 0 && target <= latest && latest - target < 1000,
            "not_found",
            "筹备修订不存在或超出单次历史范围。",
        )?;
        let mut expected = text(&head, "sha256")?.to_owned();
        for number in (target..=latest).rev() {
            let content = self
                .store
                .read(&format!(".hetu/creation/revisions/{number}.json"))?;
            ensure(
                digest(&content) == expected,
                "hetu.integrity_failure",
                "筹备修订摘要不一致。",
            )?;
            let record: Value = serde_json::from_slice(&content)?;
            creative_tasks::record_schema(&record, "project_record")?;
            ensure(
                record["schema_version"] == "1.0.0"
                    && record["project_id"] == self.scope()
                    && record["revision"] == number
                    && head["project_id"] == self.scope(),
                "hetu.integrity_failure",
                "筹备归属或修订不一致。",
            )?;
            schema(
                &record["selected_fields"],
                &creative_tasks::definition("selected_fields"),
            )?;
            if number == 1 {
                ensure(
                    record["previous_sha256"].is_null(),
                    "hetu.integrity_failure",
                    "首个筹备修订不能引用前序。",
                )?;
            }
            if number == target {
                return Ok((record, expected));
            }
            expected = text(&record, "previous_sha256")?.to_owned();
        }
        unreachable!("checked creation history range")
    }

    pub(super) fn stage_creation_task_reference(
        &self,
        task_ref: Value,
        changes: &mut Changes,
    ) -> Result<()> {
        let (mut project, previous) = self.creation_project(None)?;
        ensure(
            project["task_refs"].as_array().unwrap().len() < 100,
            "hetu.budget_exceeded",
            "本项筹备的任务数量已达到上限。",
        )?;
        project["task_refs"].as_array_mut().unwrap().push(task_ref);
        project["revision"] = json!(integer(&project, "revision")? + 1);
        project["previous_sha256"] = json!(previous);
        project["updated_at"] = json!(now());
        Self::stage_project_record(&self.store, &project, changes)?;
        Ok(())
    }

    pub(super) fn get_creation_project(&self, input: &Value) -> Result<Value> {
        ensure(
            input["project_id"] == self.scope(),
            "forbidden",
            "只能读取当前建书筹备。",
        )?;
        let (project, sha) = self.creation_project(input["revision"].as_u64())?;
        let pending = if self.store.exists(".hetu/creation/active-intent.json")?
            && project["created_workspace_ref"].is_null()
        {
            let intent = self.store.json(".hetu/creation/active-intent.json")?;
            json!({"action":intent["action"].as_str().unwrap_or("hetu.creation_projects.create_novel"),"key":intent["key"]})
        } else {
            Value::Null
        };
        Ok(
            json!({"project":project,"revision":project["revision"],"sha256":sha,"pending_creation":pending}),
        )
    }

    fn expected_project(&self, input: &Value) -> Result<(Value, String)> {
        ensure(
            input["project_id"] == self.scope(),
            "forbidden",
            "筹备身份不属于当前范围。",
        )?;
        let (project, sha) = self.creation_project(None)?;
        ensure(
            input["expected"] == json!({"revision":project["revision"],"sha256":sha}),
            "revision_conflict",
            "筹备资料已有修改，请重新比较。",
        )?;
        ensure(
            project["created_workspace_ref"].is_null(),
            "revision_conflict",
            "此筹备已创建作品，不能重复创建或改写筹备。",
        )?;
        Ok((project, sha))
    }

    pub(super) fn save_creation_project(
        &self,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        let (mut project, previous) = self.expected_project(input)?;
        ensure(
            !self.store.exists(".hetu/creation/active-intent.json")?,
            "hetu.recovery_required",
            "创建作品结果待恢复，请先核对原操作。",
        )?;
        self.selected_creation_sources(&input["selected_fields"])?;
        project["revision"] = json!(
            integer(&project, "revision")?
                .checked_add(1)
                .ok_or_else(|| Error::new("hetu.budget_exceeded", "筹备修订超出上限。"))?
        );
        project["previous_sha256"] = json!(previous);
        project["brief"] = input["brief"].clone();
        project["selected_fields"] = input["selected_fields"].clone();
        if let Some(profile) = input.get("work_profile") {
            project["work_profile"] = profile.clone();
        }
        project["updated_at"] = json!(now());
        let sha = Self::stage_project_record(&self.store, &project, changes)?;
        Ok(json!({"project":project,"revision":project["revision"],"sha256":sha}))
    }

    fn selected_creation_sources(&self, fields: &Value) -> Result<Vec<Value>> {
        let mut sources = Vec::new();
        for field in fields.as_object().unwrap().values() {
            if !field["candidate_ref"].is_null() {
                let reference = &field["candidate_ref"];
                let candidate = self.task_candidate(reference)?;
                ensure(
                    candidate["kind"] != "image",
                    "invalid_input",
                    "图片不能作为文字资料的来源。",
                )?;
                let content = text(&candidate, "content")?;
                ensure(
                    content.chars().count() <= 100000,
                    "hetu.budget_exceeded",
                    "筹备文字来源超过预算。",
                )?;
                sources.push(json!({"reference":reference,"kind":candidate["kind"],"sha256":candidate["sha256"],"content":content}));
            }
        }
        Ok(sources)
    }

    // 创建意图先落盘；新作品的内容、身份和来源在目标目录的首次事务中一并创建。
    // 两个独立目录不假装有跨卷原子事务；中断后只能沿同一意图、目标和原键恢复。
    pub(super) fn execute_create_work(
        &self,
        action: &str,
        input: &Value,
        op_path: &str,
        input_digest: &str,
    ) -> Result<Value> {
        let key = text(input, "operation_key")?;
        let drama = action == "hetu.creation_projects.create_drama";
        let video = action == "hetu.creation_projects.create_video";
        let intent_path = ".hetu/creation/active-intent.json";
        let intent = if self.store.exists(intent_path)? {
            let intent = self.store.json(intent_path)?;
            ensure(
                intent["input_digest"] == input_digest
                    && intent["key"] == key
                    && intent["action"]
                        .as_str()
                        .unwrap_or("hetu.creation_projects.create_novel")
                        == action,
                "idempotency_conflict",
                "已有创建意图，请恢复同一目标和原操作。",
            )?;
            intent
        } else {
            let (project, sha) = self.expected_project(input)?;
            let profile = if drama || video {
                &input["profile"]
            } else {
                &input["metadata"]
            };
            ensure(
                !text(profile, "title")?.trim().is_empty(),
                "invalid_input",
                "请填写作品名称。",
            )?;
            if !drama && !video {
                domain::novel::validate_metadata(profile)?;
            }
            ensure(
                matches!(profile["language_tag"].as_str(), Some("zh-CN" | "en")),
                "invalid_input",
                "当前建书支持中文或英文作品。",
            )?;
            let path = Path::new(text(input, "target_path")?);
            ensure(
                path.is_absolute() && path.file_name().is_some(),
                "hetu.unsafe_path",
                "请为新作品选择独立的绝对目录。",
            )?;
            let parent = path
                .parent()
                .ok_or_else(|| Error::new("hetu.unsafe_path", "目标目录无效。"))?
                .canonicalize()?;
            let target = parent.join(path.file_name().unwrap());
            ensure(
                !target.starts_with(&self.workspace_path)
                    && !self.workspace_path.starts_with(&target),
                "hetu.unsafe_path",
                "筹备与正式作品目录不能互相包含。",
            )?;
            if target.exists() {
                ensure(
                    std::fs::symlink_metadata(&target)?.is_dir()
                        && std::fs::read_dir(&target)?.next().is_none(),
                    "invalid_input",
                    "新作品目录必须为空，不能覆盖已有目录。",
                )?;
            }
            if let Some(selection) = project.get("work_profile") {
                let work_type = if drama {
                    "drama"
                } else if video {
                    "video"
                } else {
                    "novel"
                };
                ensure(
                    selection["work_type"] == work_type
                        && selection["language_tag"] == profile["language_tag"]
                        && (!drama || selection["drama_mode"] == profile["mode"]),
                    "revision_conflict",
                    "创建类型、语言或改编方式与已保存筹备不一致，请先确认筹备资料。",
                )?;
            }
            let mut source = json!({"project_id":self.scope(),"project_revision":project["revision"],"project_sha256":sha,"selected_fields":project["selected_fields"],"candidate_snapshots":self.selected_creation_sources(&project["selected_fields"])?});
            if let Some(profile) = project.get("work_profile") {
                source["work_profile"] = profile.clone();
            }
            let mut intent = json!({"schema_version":"1.0.0","input_digest":input_digest,"key":key,"expected":input["expected"],"target_path":target,"create_key":id("creation"),"metadata":profile,"source":source});
            if drama || video {
                intent["action"] = json!(action);
            }
            self.store
                .transaction(&Changes::from([(intent_path.into(), bytes(&intent)?)]))?;
            intent
        };
        let metadata = &intent["metadata"];
        let mut create = json!({"title":metadata["title"],"locale":metadata["language_tag"],"operation_key":intent["create_key"],"creation_source":intent["source"]});
        if drama || video {
            create["work_type"] = json!(if drama { "drama" } else { "video" });
        } else {
            create["metadata"] = metadata.clone();
        }
        let target = if let Some(binding) = &self.management_grant {
            let target_binding = crate::collaboration::authoring::workspace_binding(
                binding,
                Path::new(text(&intent, "target_path")?),
            )?;
            Kernel::open_managed(
                json!({"workspace_path":intent["target_path"],"mode":"agent","create":create}),
                target_binding,
            )?
        } else {
            Kernel::open(
                json!({"workspace_path":intent["target_path"],"mode":"author","create":create}),
            )?
        };
        let (mut project, previous) = self.creation_project(None)?;
        ensure(
            project["created_workspace_ref"].is_null()
                && input["expected"] == json!({"revision":project["revision"],"sha256":previous}),
            "revision_conflict",
            "创建意图与筹备修订不一致，请保留目标作品并核对。",
        )?;
        let mut data = json!({"workspace":target.config,"target_path":intent["target_path"]});
        let created = if drama {
            let result = target.request(json!({"action":"hetu.drama.projects.create","contract_revision":"1","input":{"title":metadata["title"],"description":metadata["description"],"mode":metadata["mode"],"operation_key":format!("initial-project-{}",text(&intent,"create_key")?)}}));
            ensure(
                result["status"] == "succeeded",
                "hetu.io_failure",
                "剧本作品已创建，请沿原操作恢复短剧项目。",
            )?;
            data["drama_project"] = result["data"].clone();
            json!({"workspace_id":target.scope(),"drama_project_id":result["data"]["project"]["project_id"]})
        } else if video {
            let result = target.request(json!({"action":"hetu.video.projects.create","contract_revision":"1","input":{
                "title":metadata["title"],"brief":metadata["brief"],"language_tag":metadata["language_tag"],
                "operation_key":format!("initial-project-{}",text(&intent,"create_key")?)}}));
            ensure(
                result["status"] == "succeeded",
                "hetu.io_failure",
                "视频工作区已创建，请沿原操作恢复项目。",
            )?;
            data["video_project"] = result["data"].clone();
            json!({"workspace_id":target.scope(),"video_project_id":result["data"]["project"]["video_project_id"]})
        } else {
            data["novel"] = target.get_novel()?["novel"].clone();
            json!({"workspace_id":target.scope(),"novel_id":data["novel"]["novel_id"]})
        };
        project["created_workspace_ref"] = created.clone();
        project["revision"] = json!(
            integer(&project, "revision")?
                .checked_add(1)
                .ok_or_else(|| Error::new("hetu.budget_exceeded", "筹备修订超出上限。"))?
        );
        project["previous_sha256"] = json!(previous);
        project["updated_at"] = json!(now());
        let mut changes = Changes::new();
        let sha = Self::stage_project_record(&self.store, &project, &mut changes)?;
        for (field, value) in [
            ("project", project.clone()),
            ("revision", project["revision"].clone()),
            ("sha256", json!(sha)),
            ("created_workspace_ref", created.clone()),
        ] {
            data[field] = value;
        }
        let mut output = domain::success(action, self.scope(), data);
        output["operation"] = Self::operation(key, input_digest);
        changes.insert(op_path.into(), bytes(&json!({"operation_id":output["operation"]["id"],"action":action,"key":key,"input_digest":input_digest,"actor_scope":if self.author {"author"} else {"agent"},"result":output}))?);
        changes.insert(format!(".hetu/audit/{}.json",text(&output["operation"],"id")?),bytes(&json!({"action":action,"operation_id":output["operation"]["id"],"actor_ref":self.actor(),"created_workspace_ref":created,"created_at":now()}))?);
        self.store.transaction(&changes)?;
        Ok(output)
    }
}
