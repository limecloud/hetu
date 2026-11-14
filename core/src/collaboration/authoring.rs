//! 从零筹备的有限授权。只分配全新受管目录，不接管已有作品，也不授予采纳与定稿权。
use super::*;

const PROJECT_ACTIONS: &[&str] = &[
    "hetu.capabilities.get",
    "hetu.operations.get",
    "hetu.creation_projects.get",
    "hetu.creation_projects.save",
    "hetu.creation_projects.create_novel",
    "hetu.creation_projects.create_drama",
    "hetu.creative_tasks.preview_prompt",
    "hetu.creative_tasks.prepare",
];
const WORKSPACE_ACTIONS: &[&str] = &[
    "hetu.capabilities.get",
    "hetu.operations.get",
    "hetu.workspaces.get",
    "hetu.novels.get",
    "hetu.documents.list",
    "hetu.documents.get",
    "hetu.documents.create",
    "hetu.drama.projects.create",
    "hetu.drama.projects.get",
    "hetu.drama.projects.list",
    "hetu.drama.episodes.create",
    "hetu.drama.episodes.get",
    "hetu.creative_tasks.preview_prompt",
    "hetu.creative_tasks.prepare",
];
pub(crate) fn management_action(action: &str) -> bool {
    PROJECT_ACTIONS.contains(&action) || WORKSPACE_ACTIONS.contains(&action)
}
fn reference_schema() -> Value {
    json!({"type":"object","additionalProperties":false,"required":["grant_id","scope_ref"],"properties":{"grant_id":{"type":"string","pattern":"^[0-9a-f]{64}$"},"scope_ref":{"type":"object","additionalProperties":false,"required":["kind","id"],"properties":{"kind":{"enum":["workspace","creation_project"]},"id":{"type":"string","maxLength":64}}}}})
}
pub(super) fn extend_catalog(actions: &mut Vec<Value>) {
    for mut action in Kernel::management_action_catalog()
        .as_array()
        .unwrap()
        .iter()
        .cloned()
    {
        action["input_schema"]["properties"]["management_ref"] = reference_schema();
        action["input_schema"]["required"]
            .as_array_mut()
            .unwrap()
            .push(json!("management_ref"));
        action["authorization"] = json!("new_managed_scope");
        if let Some(existing) = actions
            .iter_mut()
            .find(|existing| existing["name"] == action["name"])
        {
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
    Ok(value)
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
    }
    if let Some(name) = action {
        ensure(
            if project {
                PROJECT_ACTIONS
            } else {
                WORKSPACE_ACTIONS
            }
            .contains(&name),
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
    pub(super) fn execute_authoring(&self, request: &Value) -> Result<Value> {
        let action = text(request, "action")?;
        if action == "hetu.creation_projects.create" {
            return self.begin_creation(&request["input"]);
        }
        let reference = &request["input"]["management_ref"];
        let binding = json!({"directory":self.directory.canonicalize()?,"client_adapter":self.client,"grant_id":reference["grant_id"],"kind":reference["scope_ref"]["kind"]});
        let grant = record(&binding)?;
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
        let kernel = Kernel::open_managed(config, binding.clone())?;
        ensure(
            reference["scope_ref"]["id"] == kernel.scope(),
            "forbidden",
            "管理引用与作品身份不一致。",
        )?;
        let mut routed = request.clone();
        routed["input"]
            .as_object_mut()
            .unwrap()
            .remove("management_ref");
        if matches!(
            action,
            "hetu.creation_projects.create_novel" | "hetu.creation_projects.create_drama"
        ) {
            workspace_binding(&binding, Path::new(text(&routed["input"], "target_path")?))?;
        }
        let mut result = kernel.request(routed);
        if result["status"] != "succeeded" {
            return Ok(result);
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
                        item
                    })
                    .collect::<Vec<_>>()
            );
        }
        result["data"]["management_ref"] = reference.clone();
        if matches!(
            action,
            "hetu.creation_projects.create_novel" | "hetu.creation_projects.create_drama"
        ) {
            let target_binding =
                workspace_binding(&binding, Path::new(text(&grant, "target_path")?))?;
            let target = Kernel::open_managed(
                json!({"mode":"agent","workspace_path":grant["target_path"]}),
                target_binding.clone(),
            )?;
            result["data"]["workspace_management_ref"] = management_ref(&target_binding, &target);
        }
        if action == "hetu.creative_tasks.prepare" {
            let fixed = &result["data"]["task_ref"];
            kernel.authorize_collaboration(&json!({"task_ref":fixed,"client_adapter":self.client,"collaboration_path":self.directory,"operation_key":format!("managed-task-{}", text(fixed,"task_id")?)}), false)?;
            result["data"]["task_locator"] = locator(fixed)?;
        }
        Ok(result)
    }
}

impl Kernel {
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
