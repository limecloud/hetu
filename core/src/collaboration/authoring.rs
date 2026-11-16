//! 精确作品授权与独立建书筹备；所有范围均不授予采纳与定稿权。
use super::*;

const PROJECT_ACTIONS: &[&str] = &[
    "hetu.capabilities.get",
    "hetu.operations.get",
    "hetu.creation_projects.get",
    "hetu.creation_projects.save",
    "hetu.creation_projects.create_novel",
    "hetu.creation_projects.create_drama",
    "hetu.creation_projects.create_video",
    "hetu.creative_tasks.preview_prompt",
    "hetu.creative_tasks.prepare",
];
const WORKSPACE_ACTIONS: &[&str] = &[
    "hetu.capabilities.get",
    "hetu.operations.get",
    "hetu.workspaces.get",
    "hetu.novels.get",
    "hetu.blueprints.get",
    "hetu.documents.list",
    "hetu.documents.get",
    "hetu.documents.create",
    "hetu.drama.projects.create",
    "hetu.drama.projects.get",
    "hetu.drama.projects.list",
    "hetu.drama.episodes.create",
    "hetu.drama.episodes.get",
    "hetu.works.list",
    "hetu.works.get",
    "hetu.work_links.list",
    "hetu.work_links.get",
    "hetu.video.projects.create",
    "hetu.video.projects.get",
    "hetu.video.episodes.create",
    "hetu.video.episodes.get",
    "hetu.creative_tasks.preview_prompt",
    "hetu.creative_tasks.prepare",
];
// 已有作品授权只开放读取、方案和有界检查；具体变更仍须作者批准固定方案。
const REVIEW_ACTIONS: &[&str] = &[
    "hetu.plugin_access.authorize",
    "hetu.plugin_access.record_migration_decision",
    "hetu.plugin_access.inspect",
    "hetu.plugin_access.revoke",
    "hetu.works.list",
    "hetu.works.get",
    "hetu.work_links.list",
    "hetu.work_links.get",
    "hetu.video.projects.get",
    "hetu.video.episodes.get",
    "hetu.capabilities.get",
    "hetu.operations.get",
    "hetu.workspaces.get",
    "hetu.novels.get",
    "hetu.documents.list",
    "hetu.documents.get",
    "hetu.documents.history",
    "hetu.drafts.list",
    "hetu.creative_tasks.list",
    "hetu.outlines.get",
    "hetu.blueprints.get",
    "hetu.blueprints.preview_change",
    "hetu.drama.projects.list",
    "hetu.drama.projects.get",
    "hetu.drama.episodes.get",
    "hetu.drama.build_skeleton",
    "hetu.drama.compare",
    "hetu.resources.list",
    "hetu.resources.get",
    "hetu.resource_usages.list",
    "hetu.assets.list",
    "hetu.assets.get",
    "hetu.assets.inspect",
    "hetu.cues.list",
    "hetu.cues.get",
    "hetu.plot.extract",
    "hetu.plot.list",
    "hetu.plot.get",
    "hetu.validation.run",
    "hetu.reports.list",
    "hetu.reports.get",
    "hetu.reviews.list",
    "hetu.reviews.get",
    "hetu.reviews.validate",
    "hetu.drafts.get",
    "hetu.drafts.preview_adoption",
    "hetu.documents.preview_finalization",
    "hetu.documents.lifecycle",
    "hetu.covers.get",
    "hetu.creative_tasks.preview_prompt",
    "hetu.git.status",
    "hetu.git.diff",
    "hetu.git.log",
    "hetu.git.list_snapshots",
    "hetu.git.get_snapshot",
    "hetu.git.snapshot_diff",
    "hetu.bundles.verify",
    "hetu.git.snapshot",
    "hetu.git.record_snapshot_decision",
    "hetu.image_tasks.preview_prompt",
    "hetu.git.references",
    "hetu.git.read_version",
    "hetu.git.merge_preview",
    "hetu.findings.suggest",
    "hetu.findings.suggestions",
    "hetu.documents.preview_import",
    "hetu.documents.preview_export",
    "hetu.bundles.preview",
    "hetu.drama.get_skeleton",
    "hetu.drama.list_skeletons",
    "hetu.drama.get_comparison",
    "hetu.drama.list_comparisons",
    "hetu.drama.get_script_mapping",
    "hetu.handoffs.get",
    "hetu.agent_operations.prepare",
    "hetu.agent_operations.catalog",
    "hetu.agent_operations.record_decision",
    "hetu.agent_operations.list",
    "hetu.agent_operations.get",
    "hetu.agent_operations.execute",
    "hetu.import_authorizations.register",
    "hetu.import_authorizations.get",
    "hetu.import_authorizations.revoke",
];
pub(crate) fn management_action(action: &str) -> bool {
    PROJECT_ACTIONS.contains(&action)
        || WORKSPACE_ACTIONS.contains(&action)
        || REVIEW_ACTIONS.contains(&action)
}
fn reference_schema() -> Value {
    json!({"type":"object","additionalProperties":false,"required":["grant_id","scope_ref"],"properties":{"grant_id":{"type":"string","pattern":"^[0-9a-f]{64}$"},"grant_revision":{"type":"integer","minimum":1},"scope_ref":{"type":"object","additionalProperties":false,"required":["kind","id"],"properties":{"kind":{"enum":["workspace","creation_project"]},"id":{"type":"string","maxLength":64}}}}})
}
pub(super) fn extend_catalog(actions: &mut Vec<Value>) {
    for mut action in Kernel::management_action_catalog()
        .as_array()
        .unwrap()
        .iter()
        .cloned()
    {
        action["input_schema"]["properties"]["management_ref"] = reference_schema();
        if action["name"] == "hetu.work_links.get" {
            action["input_schema"]["properties"]["related_management_ref"] = reference_schema();
        }
        action["input_schema"]
            .as_object_mut()
            .unwrap()
            .entry("required")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .unwrap()
            .push(json!("management_ref"));
        action["authorization"] = json!("new_managed_scope");
        if let Some(existing) = actions
            .iter_mut()
            .find(|existing| existing["name"] == action["name"])
        {
            // oneOf 的两个分支各自保留 Schema 资源边界，局部 $defs 不指向组合根。
            let name = action["name"].as_str().unwrap();
            existing["input_schema"]["$id"] = json!(format!("urn:hetu:collaboration:{name}:task"));
            action["input_schema"]["$id"] =
                json!(format!("urn:hetu:collaboration:{name}:management"));
            existing["input_schema"] =
                json!({"type":"object","oneOf":[existing["input_schema"], action["input_schema"]]});
            existing["authorization"] = json!("task_or_new_managed_scope");
        } else {
            actions.push(action);
        }
    }
}
fn record_path(client: &str, grant_id: &str) -> Result<String> {
    client_valid(client)?;
    ensure(
        grant_id.len() == 64
            && grant_id
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
        "forbidden",
        "新建授权引用无效。",
    )?;
    Ok(format!("management/{client}/{grant_id}.json"))
}
fn record(binding: &Value) -> Result<Value> {
    let store = Store::open(Path::new(text(binding, "directory")?))?;
    let _guard = store.read_lock()?;
    let value = store
        .json(&record_path(
            text(binding, "client_adapter")?,
            text(binding, "grant_id")?,
        )?)
        .map_err(|_| Error::new("forbidden", "此客户端没有该新建范围的授权。"))?;
    ensure(
        value["revoked"] == false && value["client_adapter"] == binding["client_adapter"],
        "forbidden",
        "新建授权不可用或已撤销。",
    )?;
    if let Some(expires) = value["expires_at"].as_i64() {
        ensure(
            time::OffsetDateTime::now_utc().unix_timestamp() < expires,
            "forbidden",
            "作品授权已过期。",
        )?;
    }
    if value["authorized_workspace"] == true {
        ensure(
            value["grant_revision"] == binding["grant_revision"],
            "forbidden",
            "作品授权已变化，请重新交接。",
        )?;
    }
    Ok(value)
}
pub(crate) fn granted_work(binding: &Value) -> Result<Option<Value>> {
    let grant = record(binding)?;
    Ok(grant
        .get("work_ref")
        .filter(|value| value.is_object())
        .cloned())
}
fn work_action_allowed(name: &str, reference: &Value) -> bool {
    if reference["kind"] == "video"
        && matches!(
            name,
            "hetu.documents.preview_import"
                | "hetu.documents.preview_export"
                | "hetu.bundles.preview"
                | "hetu.bundles.verify"
        )
    {
        return false;
    }
    if reference["kind"] == "video"
        && matches!(
            name,
            "hetu.documents.list" | "hetu.documents.get" | "hetu.documents.history"
        )
    {
        return false;
    }
    matches!(
        name,
        "hetu.drafts.list"
            | "hetu.reviews.list"
            | "hetu.reviews.get"
            | "hetu.reviews.validate"
            | "hetu.plot.extract"
            | "hetu.plot.get"
            | "hetu.plot.list"
            | "hetu.validation.run"
            | "hetu.reports.get"
            | "hetu.reports.list"
            | "hetu.findings.suggest"
            | "hetu.findings.suggestions"
            | "hetu.drama.build_skeleton"
            | "hetu.drama.get_skeleton"
            | "hetu.drama.list_skeletons"
            | "hetu.drama.compare"
            | "hetu.drama.get_comparison"
            | "hetu.drama.list_comparisons"
            | "hetu.drama.get_script_mapping"
            | "hetu.plugin_access.record_migration_decision"
            | "hetu.plugin_access.authorize"
            | "hetu.plugin_access.inspect"
            | "hetu.plugin_access.revoke"
            | "hetu.capabilities.get"
            | "hetu.operations.get"
            | "hetu.workspaces.get"
            | "hetu.works.list"
            | "hetu.works.get"
            | "hetu.work_links.list"
            | "hetu.work_links.get"
            | "hetu.handoffs.get"
            | "hetu.novels.get"
            | "hetu.import_authorizations.register"
            | "hetu.import_authorizations.get"
            | "hetu.import_authorizations.revoke"
            | "hetu.drama.projects.get"
            | "hetu.drama.projects.list"
            | "hetu.drama.episodes.get"
            | "hetu.documents.list"
            | "hetu.documents.get"
            | "hetu.documents.history"
            | "hetu.documents.preview_finalization"
            | "hetu.documents.lifecycle"
            | "hetu.drafts.get"
            | "hetu.drafts.preview_adoption"
            | "hetu.covers.get"
            | "hetu.outlines.get"
            | "hetu.creative_tasks.list"
            | "hetu.resources.list"
            | "hetu.resources.get"
            | "hetu.resource_usages.list"
            | "hetu.assets.list"
            | "hetu.assets.get"
            | "hetu.assets.inspect"
            | "hetu.cues.list"
            | "hetu.cues.get"
            | "hetu.video.projects.get"
            | "hetu.video.episodes.get"
            | "hetu.blueprints.get"
            | "hetu.blueprints.preview_change"
            | "hetu.documents.preview_import"
            | "hetu.documents.preview_export"
            | "hetu.bundles.preview"
            | "hetu.bundles.verify"
            | "hetu.git.status"
            | "hetu.git.diff"
            | "hetu.git.log"
            | "hetu.git.read_version"
            | "hetu.git.list_snapshots"
            | "hetu.git.get_snapshot"
            | "hetu.git.snapshot_diff"
            | "hetu.git.snapshot"
            | "hetu.git.record_snapshot_decision"
            | "hetu.creative_tasks.preview_prompt"
            | "hetu.image_tasks.preview_prompt"
            | "hetu.agent_operations.prepare"
            | "hetu.agent_operations.catalog"
            | "hetu.agent_operations.record_decision"
            | "hetu.agent_operations.list"
            | "hetu.agent_operations.get"
            | "hetu.agent_operations.execute"
    )
}
pub(crate) fn check_management(binding: &Value, root: &Path, action: Option<&str>) -> Result<()> {
    let grant = record(binding)?;
    let project = binding["kind"] == "creation_project";
    ensure(
        project || binding["kind"] == "workspace",
        "forbidden",
        "管理范围无效。",
    )?;
    let expected = Path::new(text(
        &grant,
        if project {
            "project_path"
        } else {
            "target_path"
        },
    )?);
    ensure(root == expected, "forbidden", "管理授权不属于该目录。")?;
    // 禁止用目录替换或链接把受管范围转移到既有作品。
    ensure(
        root.parent()
            .is_some_and(|p| p.canonicalize().ok().as_deref() == Some(p)),
        "hetu.unsafe_path",
        "管理目录的父路径已变化。",
    )?;
    if let Ok(metadata) = std::fs::symlink_metadata(root) {
        ensure(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "hetu.unsafe_path",
            "管理目录不能是链接或文件。",
        )?;
        if grant["root_identity"].is_object() {
            let identity = crate::infrastructure::platform::identity(root)?;
            ensure(
                grant["root_identity"]["device"] == identity.0
                    && grant["root_identity"]["inode"] == identity.1,
                "forbidden",
                "作品目录身份已变化，请重新授权。",
            )?;
        }
    }
    if let Some(name) = action {
        ensure(
            !grant["work_ref"].is_object() || work_action_allowed(name, &grant["work_ref"]),
            "forbidden",
            "此对象授权不包含工作区级能力。",
        )?;
        ensure(
            if project {
                PROJECT_ACTIONS
            } else if grant["authorized_workspace"] == true {
                REVIEW_ACTIONS
            } else {
                WORKSPACE_ACTIONS
            }
            .contains(&name)
                || !project
                    && grant["authorized_workspace"] != true
                    && REVIEW_ACTIONS.contains(&name),
            "forbidden",
            "该授权不允许此动作。",
        )?;
    }
    Ok(())
}
pub(crate) fn workspace_binding(binding: &Value, target: &Path) -> Result<Value> {
    let grant = record(binding)?;
    ensure(
        binding["kind"] == "creation_project" && target == Path::new(text(&grant, "target_path")?),
        "forbidden",
        "新建授权仅允许预留的新作品目录。",
    )?;
    let mut result = binding.clone();
    result["kind"] = json!("workspace");
    check_management(&result, target, None)?;
    Ok(result)
}
fn management_ref(binding: &Value, kernel: &Kernel) -> Value {
    json!({"grant_id":binding["grant_id"],"scope_ref":{"kind":kernel.scope_kind(),"id":kernel.scope()}})
}

impl CollaborationHub {
    fn begin_creation(&self, input: &Value) -> Result<Value> {
        std::fs::create_dir_all(&self.directory)?;
        let directory = self.directory.canonicalize()?;
        let store = Store::open(&directory)?;
        for path in [
            ".hetu/transactions",
            ".hetu/operations",
            "managed/projects",
            "managed/works",
        ] {
            store.directory(path)?;
        }
        let grant_id = digest(format!(
            "{}\0{}",
            self.client,
            text(input, "operation_key")?
        ));
        let path = record_path(&self.client, &grant_id)?;
        let input_sha = digest(serde_json_canonicalizer::to_vec(input)?);
        let guard = store.lock()?;
        store.recover()?;
        let mut grant = if store.exists(&path)? {
            let previous = store.json(&path)?;
            ensure(
                previous["input_sha256"] == input_sha,
                "idempotency_conflict",
                "原筹备操作键已绑定其他输入。",
            )?;
            ensure(
                previous["revoked"] == false,
                "forbidden",
                "本次新建授权已撤销。",
            )?;
            if let Some(receipt) = previous.get("receipt") {
                return Ok(receipt.clone());
            }
            previous
        } else {
            let project_path = directory.join("managed/projects").join(&grant_id);
            let target_path = directory.join("managed/works").join(&grant_id);
            ensure(
                !project_path.try_exists()? && !target_path.try_exists()?,
                "forbidden",
                "有限新建不能接管已存在的目录。",
            )?;
            let value = json!({"schema_version":"1.0.0","client_adapter":self.client,"input_sha256":input_sha,"project_path":project_path,"target_path":target_path,"revoked":false});
            store.transaction(&BTreeMap::from([(path.clone(), encoded(&value)?)]))?;
            value
        };
        drop(guard);
        let binding = json!({"directory":directory,"client_adapter":self.client,"grant_id":grant_id,"kind":"creation_project"});
        let kernel = Kernel::open_managed(
            json!({"mode":"agent","creation_project_path":grant["project_path"],"create_project":input}),
            binding.clone(),
        )?;
        let result = kernel.creation_start_receipt(text(input, "operation_key")?)?;
        ensure(
            result["status"] == "succeeded",
            "hetu.io_failure",
            "筹备已分配，请沿原键恢复。",
        )?;
        let mut receipt = result;
        receipt["action"] = json!("hetu.creation_projects.create");
        receipt["data"]["management_ref"] = management_ref(&binding, &kernel);
        receipt["data"]["project_path"] = grant["project_path"].clone();
        receipt["data"]["target_path"] = grant["target_path"].clone();
        receipt["data"]["directory_policy"] = json!("new_managed_directory_only");
        let _guard = store.lock()?;
        store.recover()?;
        ensure(
            store.json(&path)?["revoked"] == false,
            "forbidden",
            "本次新建授权已撤销。",
        )?;
        grant["receipt"] = receipt.clone();
        store.transaction(&BTreeMap::from([(path, encoded(&grant)?)]))?;
        Ok(receipt)
    }
    fn open_management_reference(&self, reference: &Value) -> Result<(Kernel, Value, Value)> {
        let mut binding = json!({"directory":self.directory.canonicalize()?,"client_adapter":self.client,"grant_id":reference["grant_id"],"grant_revision":reference["grant_revision"],"kind":reference["scope_ref"]["kind"]});
        let grant = record(&binding)?;
        if grant["work_ref"].is_object() {
            binding["work_ref"] = grant["work_ref"].clone();
        }
        let root = &grant[if binding["kind"] == "creation_project" {
            "project_path"
        } else {
            "target_path"
        }];
        let mut config = json!({"mode":"agent"});
        config[if binding["kind"] == "creation_project" {
            "creation_project_path"
        } else {
            "workspace_path"
        }] = root.clone();
        if grant["git_authorization_path"].is_string() {
            config["authorization_path"] = grant["git_authorization_path"].clone();
        }
        let kernel = Kernel::open_managed(config, binding.clone())?;
        ensure(
            reference["scope_ref"]["id"] == kernel.scope(),
            "forbidden",
            "管理引用与作品身份不一致。",
        )?;
        ensure(
            grant["workspace_id"].is_null() || grant["workspace_id"] == kernel.scope(),
            "forbidden",
            "作品身份与原授权不一致。",
        )?;
        Ok((kernel, binding, grant))
    }

    fn read_related_profile(&self, reference: &Value, view: &mut Value) -> Result<()> {
        let fixed = view["link"][if view["direction"] == "incoming" {
            "source_ref"
        } else {
            "target_ref"
        }]
        .clone();
        ensure(
            reference["scope_ref"]["kind"] == "workspace"
                && reference["scope_ref"]["id"] == fixed["work_ref"]["workspace_id"],
            "forbidden",
            "关联作品授权不属于所需工作区。",
        )?;
        let (related, related_binding, _) = self.open_management_reference(reference)?;
        let read = |revision: Option<&Value>| -> Value {
            let mut input = json!({"work_ref":fixed["work_ref"]});
            if let Some(revision) = revision {
                input["revision"] = revision.clone();
            }
            related
                .request(json!({"action":"hetu.works.get","contract_revision":"1","input":input}))
        };
        // 每次都在另一份精确授权中读取；不能临时扩大当前 Kernel 的对象范围。
        let current_response = read(None);
        let fixed_response = read(Some(&fixed["revision_ref"]["revision"]));
        for response in [&current_response, &fixed_response] {
            if response["status"] != "succeeded" {
                ensure(
                    response["error"]["code"] != "forbidden",
                    "forbidden",
                    "关联作品授权不覆盖所需对象或已不可用。",
                )?;
                view["related_status"] = json!("unavailable");
                view["related_has_newer_revision"] = Value::Null;
                view["related_current_archived"] = Value::Null;
                view["related_read_requires_authorization"] = json!(false);
                view["related_work"] = Value::Null;
                view["related_error"] = response["error"].clone();
                return Ok(());
            }
        }
        let current = &current_response["data"];
        let fixed_work = &fixed_response["data"];
        ensure(
            fixed_work["summary"]["fixed_ref"] == fixed,
            "hetu.integrity_failure",
            "关联依据的历史摘要不一致。",
        )?;
        record(&related_binding)?;
        view["related_title"] = fixed_work["summary"]["title"].clone();
        view["related_status"] = json!("available");
        view["related_has_newer_revision"] = json!(current["summary"]["fixed_ref"] != fixed);
        view["related_current_archived"] = current["summary"]["archived"].clone();
        view["related_read_requires_authorization"] = json!(false);
        view["related_error"] = Value::Null;
        view["related_work"] = fixed_work.clone();
        Ok(())
    }

    pub(super) fn execute_authoring(&self, request: &Value) -> Result<Value> {
        let action = text(request, "action")?;
        if action == "hetu.creation_projects.create" {
            return self.begin_creation(&request["input"]);
        }
        let reference = &request["input"]["management_ref"];
        let (kernel, binding, grant) = self.open_management_reference(reference)?;
        let mut routed = request.clone();
        routed["input"]
            .as_object_mut()
            .unwrap()
            .remove("management_ref");
        let related_reference = if action == "hetu.work_links.get" {
            routed["input"]
                .as_object_mut()
                .unwrap()
                .remove("related_management_ref")
        } else {
            None
        };
        if matches!(
            action,
            "hetu.creation_projects.create_novel"
                | "hetu.creation_projects.create_drama"
                | "hetu.creation_projects.create_video"
        ) {
            workspace_binding(&binding, Path::new(text(&routed["input"], "target_path")?))?;
        }
        let mut result = kernel.request(routed);
        if result["status"] != "succeeded" {
            return Ok(result);
        }
        if let Some(related_reference) = related_reference {
            self.read_related_profile(&related_reference, &mut result["data"])?;
            record(&binding)?;
        }
        if action == "hetu.capabilities.get" {
            let available = result["data"]["actions"].clone();
            result["data"]["actions"] = json!(
                self.catalog()
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|item| available
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|actual| actual["name"] == item["name"]))
                    .cloned()
                    .map(|mut item| {
                        if item["authorization"] == "task_or_new_managed_scope" {
                            item["input_schema"] = item["input_schema"]["oneOf"][1].clone();
                            item["authorization"] = json!("new_managed_scope");
                        }
                        if grant["work_ref"].is_object()
                            && matches!(
                                item["name"].as_str(),
                                Some(
                                    "hetu.documents.list"
                                        | "hetu.creative_tasks.list"
                                        | "hetu.resources.list"
                                        | "hetu.assets.list"
                                        | "hetu.assets.inspect"
                                        | "hetu.cues.list"
                                        | "hetu.documents.preview_import"
                                        | "hetu.documents.preview_export"
                                        | "hetu.bundles.preview"
                                        | "hetu.bundles.verify"
                                        | "hetu.git.status"
                                        | "hetu.git.diff"
                                        | "hetu.git.log"
                                        | "hetu.git.read_version"
                                        | "hetu.git.list_snapshots"
                                        | "hetu.git.get_snapshot"
                                        | "hetu.git.snapshot_diff"
                                        | "hetu.git.snapshot"
                                        | "hetu.git.record_snapshot_decision"
                                )
                            )
                        {
                            item["input_schema"]["properties"]["work_ref"]["const"] =
                                grant["work_ref"].clone();
                            item["input_schema"]["required"]
                                .as_array_mut()
                                .unwrap()
                                .push(json!("work_ref"));
                        }
                        if grant["work_ref"].is_object()
                            && matches!(
                                item["name"].as_str(),
                                Some("hetu.assets.inspect" | "hetu.documents.preview_import")
                            )
                        {
                            item["input_schema"]["properties"]
                                .as_object_mut()
                                .unwrap()
                                .remove("file_path");
                            item["input_schema"]
                                .as_object_mut()
                                .unwrap()
                                .remove("oneOf");
                            item["input_schema"]["required"]
                                .as_array_mut()
                                .unwrap()
                                .push(json!("inline_source"));
                        }
                        item
                    })
                    .collect::<Vec<_>>()
            );
            if grant["work_ref"].is_object() {
                result["data"]["work_ref"] = grant["work_ref"].clone();
            }
        }
        result["data"]["management_ref"] = reference.clone();
        if matches!(
            action,
            "hetu.creation_projects.create_novel"
                | "hetu.creation_projects.create_drama"
                | "hetu.creation_projects.create_video"
        ) {
            let target_binding =
                workspace_binding(&binding, Path::new(text(&grant, "target_path")?))?;
            let target = Kernel::open_managed(
                json!({"mode":"agent","workspace_path":grant["target_path"]}),
                target_binding.clone(),
            )?;
            result["data"]["workspace_management_ref"] = management_ref(&target_binding, &target);
            let store = Store::open(&self.directory)?;
            let _guard = store.lock()?;
            store.recover()?;
            let path = record_path(&self.client, text(&binding, "grant_id")?)?;
            let mut latest = store.json(&path)?;
            ensure(latest["revoked"] == false, "forbidden", "新建授权已撤销。")?;
            latest["created_workspace"] = json!({"workspace_id":target.scope(),"path":grant["target_path"],
                "management_ref":result["data"]["workspace_management_ref"]});
            store.transaction(&BTreeMap::from([(path, encoded(&latest)?)]))?;
        }
        if action == "hetu.creative_tasks.prepare" {
            let fixed = &result["data"]["task_ref"];
            kernel.authorize_collaboration(&json!({"task_ref":fixed,"client_adapter":self.client,"collaboration_path":self.directory,"operation_key":format!("managed-task-{}", text(fixed,"task_id")?)}), false)?;
            result["data"]["task_locator"] = locator(fixed)?;
        }
        if action == "hetu.agent_operations.execute"
            && result["data"]["result"]["task_ref"].is_object()
        {
            let fixed = &result["data"]["result"]["task_ref"];
            kernel.authorize_collaboration(&json!({"task_ref":fixed,"client_adapter":self.client,"collaboration_path":self.directory,
                "operation_key":format!("managed-task-{}", text(fixed,"task_id")?)}), false)?;
            result["data"]["task_locator"] = locator(fixed)?;
        }
        Ok(result)
    }

    pub(super) fn created_works(&self, input: &Value) -> Result<Value> {
        let mut works = Vec::new();
        if !self.directory.try_exists()? {
            return Ok(json!({"works":[],"next_cursor":null}));
        }
        let store = Store::open(&self.directory)?;
        let _guard = store.read_lock()?;
        let folder = format!("management/{}", self.client);
        if !store.entries("")?.iter().any(|name| name == "management")
            || !store
                .entries("management")?
                .iter()
                .any(|name| name == &self.client)
        {
            return Ok(json!({"works":[],"next_cursor":null}));
        }
        for name in store.entries(&folder)? {
            let grant = store.json(&format!("{folder}/{name}"))?;
            if grant["revoked"] == false
                && grant["client_adapter"] == self.client
                && grant["created_workspace"].is_object()
            {
                works.push(grant["created_workspace"].clone());
            }
        }
        works.sort_by(|a, b| a["workspace_id"].as_str().cmp(&b["workspace_id"].as_str()));
        let offset = input["cursor"]
            .as_str()
            .map(str::parse::<usize>)
            .transpose()
            .map_err(|_| Error::new("invalid_input", "分页引用无效。"))?
            .unwrap_or(0);
        let limit = input["limit"].as_u64().unwrap_or(50) as usize;
        let end = offset.saturating_add(limit).min(works.len());
        let next = if end < works.len() {
            json!(end.to_string())
        } else {
            Value::Null
        };
        Ok(
            json!({"works":works.into_iter().skip(offset).take(limit).collect::<Vec<_>>(),"next_cursor":next}),
        )
    }
}

impl Kernel {
    pub(crate) fn workspace_access(&self, input: &Value) -> Result<Value> {
        ensure(
            self.is_author(),
            "forbidden",
            "作品授权状态仅供可信作者入口读取。",
        )?;
        let client = text(input, "client_adapter")?;
        client_valid(client)?;
        let directory = input["collaboration_path"]
            .as_str()
            .map(PathBuf::from)
            .map(Ok)
            .unwrap_or_else(default_directory)?;
        let grant_id = self.work_grant_id(client, input.get("work_ref"))?;
        let reference =
            json!({"grant_id":grant_id,"scope_ref":{"kind":"workspace","id":self.scope()}});
        if !directory.try_exists()? {
            return Ok(json!({"authorized":false,"client_adapter":client}));
        }
        let store = Store::open(&directory)?;
        let _guard = store.read_lock()?;
        let path = record_path(client, &grant_id)?;
        if !store.exists(&path)? {
            return Ok(json!({"authorized":false,"client_adapter":client}));
        }
        let grant = store.json(&path)?;
        let mut reference = reference;
        reference["grant_revision"] = grant["grant_revision"].clone();
        let current = grant["revoked"] == false
            && grant["target_path"] == json!(self.root_path())
            && grant["workspace_id"] == self.scope()
            && grant["expires_at"]
                .as_i64()
                .is_none_or(|at| at > time::OffsetDateTime::now_utc().unix_timestamp());
        Ok(
            json!({"authorized":current,"management_ref":reference,"client_adapter":client,"expires_at":grant["expires_at"]}),
        )
    }
    pub(crate) fn authorize_workspace(&self, input: &Value) -> Result<Value> {
        ensure(
            self.is_author() && self.scope_kind() == "workspace",
            "forbidden",
            "只有可信作者入口可以授权当前作品。",
        )?;
        let client = text(input, "client_adapter")?;
        client_valid(client)?;
        let directory = input["collaboration_path"]
            .as_str()
            .map(PathBuf::from)
            .map(Ok)
            .unwrap_or_else(default_directory)?;
        ensure(
            directory.is_absolute() && !directory.starts_with(self.root_path()),
            "hetu.unsafe_path",
            "授权目录必须位于作品之外。",
        )?;
        std::fs::create_dir_all(&directory)?;
        let directory = directory.canonicalize()?;
        ensure(
            !directory.starts_with(self.root_path()),
            "hetu.unsafe_path",
            "授权目录不能链接到作品内部。",
        )?;
        let store = Store::open(&directory)?;
        store.directory(".hetu/transactions")?;
        let _guard = store.lock()?;
        store.recover()?;
        let grant_id = self.work_grant_id(client, input.get("work_ref"))?;
        let path = record_path(client, &grant_id)?;
        let expires = input.get("expires_at").cloned().unwrap_or(Value::Null);
        if let Some(value) = expires.as_i64() {
            ensure(
                value > time::OffsetDateTime::now_utc().unix_timestamp(),
                "invalid_input",
                "授权到期时间必须晚于现在。",
            )?;
        }
        let previous = if store.exists(&path)? {
            store.json(&path)?
        } else {
            Value::Null
        };
        let identity = crate::infrastructure::platform::identity(self.root_path())?;
        let identity = json!({"device":identity.0,"inode":identity.1});
        let revision = if previous["revoked"] == false
            && previous["expires_at"] == expires
            && previous["target_path"] == json!(self.root_path())
            && previous["root_identity"] == identity
            && previous["git_authorization_path"] == json!(self.custom_git_authorization_path())
        {
            previous["grant_revision"].as_u64().unwrap_or(0).max(1)
        } else {
            previous["grant_revision"]
                .as_u64()
                .unwrap_or(0)
                .checked_add(1)
                .ok_or_else(|| Error::new("hetu.budget_exceeded", "授权修订超过支持上限。"))?
        };
        let mut grant = json!({"schema_version":"1.0.0","client_adapter":client,"target_path":self.root_path(),
            "workspace_id":self.scope(),"authorized_workspace":true,"grant_revision":revision,"expires_at":expires,"revoked":false});
        grant["root_identity"] = identity;
        if let Some(directory) = self.custom_git_authorization_path() {
            grant["git_authorization_path"] = json!(directory);
        }
        if let Some(reference) = input.get("work_ref") {
            grant["work_ref"] = reference.clone();
        }
        store.transaction(&BTreeMap::from([(path, encoded(&grant)?)]))?;
        Ok(
            json!({"management_ref":{"grant_id":grant_id,"grant_revision":revision,"scope_ref":{"kind":"workspace","id":self.scope()}},
            "client_adapter":client,"revoked":false,"allowed_actions":REVIEW_ACTIONS.iter().filter(|name| !input["work_ref"].is_object() || work_action_allowed(name, &input["work_ref"])).collect::<Vec<_>>()}),
        )
    }
    fn work_grant_id(&self, client: &str, reference: Option<&Value>) -> Result<String> {
        if let Some(reference) = reference {
            self.work_record(reference, None)?;
            Ok(digest(format!(
                "work\0{}\0{}\0{}\0{client}",
                self.scope(),
                text(reference, "kind")?,
                text(reference, "object_id")?
            )))
        } else {
            Ok(digest(format!("workspace\0{}\0{client}", self.scope())))
        }
    }
    pub(crate) fn revoke_management(&self, input: &Value) -> Result<Value> {
        ensure(
            self.is_author(),
            "forbidden",
            "只有可信作者入口可以撤销作品管理授权。",
        )?;
        let directory = input["collaboration_path"]
            .as_str()
            .map(PathBuf::from)
            .map(Ok)
            .unwrap_or_else(default_directory)?;
        let store = Store::open(&directory)?;
        let _guard = store.lock()?;
        store.recover()?;
        let grant_id = text(input, "grant_id")?;
        let path = record_path(text(input, "client_adapter")?, grant_id)?;
        let mut grant = store.json(&path)?;
        ensure(
            Path::new(text(
                &grant,
                if self.scope_kind() == "workspace" {
                    "target_path"
                } else {
                    "project_path"
                },
            )?) == self.root_path(),
            "forbidden",
            "该新建授权不属于当前作品。",
        )?;
        grant["revoked"] = json!(true);
        store.transaction(&BTreeMap::from([(path, encoded(&grant)?)]))?;
        Ok(json!({"grant_id":grant_id,"revoked":true,"includes_derived_tasks":true}))
    }
}
