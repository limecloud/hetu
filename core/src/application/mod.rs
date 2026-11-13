use crate::domain::{
    self, Error, Result, blueprint, checked_id, digest, ensure, id, now, plot, validation,
};
use crate::infrastructure::store::Store;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::OnceLock;
mod creation;
mod creative_tasks;
mod document_lifecycle;
mod drafts;
mod dramas;
mod git;
mod media;
mod novels;
mod plots;
mod reports;
mod reviews;
mod scripts;

type Changes = BTreeMap<String, Vec<u8>>;
const PACKAGES: [&str; 4] = ["novel", "drama", "music-cue", "visual-prompt"];
const AUTHOR: &str = "actor_00000000-0000-4000-8000-000000000001";
const AGENT: &str = "actor_00000000-0000-4000-8000-000000000002";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenConfig {
    workspace_path: Option<String>,
    creation_project_path: Option<String>,
    mode: Mode,
    create: Option<CreateConfig>,
    create_project: Option<creation::CreateProjectConfig>,
    task_id: Option<String>,
    authorization_path: Option<std::path::PathBuf>,
}
#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Mode {
    Author,
    Agent,
}
#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct CreateConfig {
    title: String,
    locale: String,
    operation_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    creation_source: Option<Value>,
}

pub struct Kernel {
    store: Store,
    config: Value,
    config_sha: String,
    author: bool,
    workspace_path: std::path::PathBuf,
    authorization_path: Option<std::path::PathBuf>,
    task_id: Option<String>,
}

fn catalog() -> &'static Value {
    static ACTIONS: OnceLock<Value> = OnceLock::new();
    ACTIONS.get_or_init(|| {
        let mut catalog: Value =
            serde_json::from_str(include_str!("../../../contracts/actions.json"))
                .expect("embedded action catalog");
        for action in catalog["actions"].as_array_mut().unwrap() {
            if let Some(reference) = action["input_schema_ref"].as_str() {
                if let Some(definition) =
                    reference.strip_prefix("schemas/novel.schema.json#/$defs/")
                {
                    action["input_schema"] = domain::novel::definition(definition);
                    action.as_object_mut().unwrap().remove("input_schema_ref");
                    continue;
                }
                if let Some(definition) =
                    reference.strip_prefix("schemas/media.schema.json#/$defs/")
                {
                    action["input_schema"] = domain::media::definition(definition);
                    action.as_object_mut().unwrap().remove("input_schema_ref");
                    continue;
                }
                if let Some(definition) =
                    reference.strip_prefix("schemas/document-lifecycle.schema.json#/$defs/")
                {
                    action["input_schema"] = document_lifecycle::definition(definition);
                    action.as_object_mut().unwrap().remove("input_schema_ref");
                    continue;
                }
                if let Some(definition) =
                    reference.strip_prefix("schemas/creative-task.schema.json#/$defs/")
                {
                    action["input_schema"] = creative_tasks::definition(definition);
                    action.as_object_mut().unwrap().remove("input_schema_ref");
                    continue;
                }
                let source = match reference {
                    "schemas/git-snapshot-input.schema.json" => {
                        include_str!("../../../contracts/schemas/git-snapshot-input.schema.json")
                    }
                    "schemas/review-begin-input.schema.json" => {
                        include_str!("../../../contracts/schemas/review-begin-input.schema.json")
                    }
                    "schemas/review-validate-input.schema.json" => {
                        include_str!("../../../contracts/schemas/review-validate-input.schema.json")
                    }
                    "schemas/review-decide-input.schema.json" => {
                        include_str!("../../../contracts/schemas/review-decide-input.schema.json")
                    }
                    "schemas/draft-submit-input.schema.json" => {
                        include_str!("../../../contracts/schemas/draft-submit-input.schema.json")
                    }
                    "schemas/blueprint-save-input.schema.json" => {
                        include_str!("../../../contracts/schemas/blueprint-save-input.schema.json")
                    }
                    "schemas/blueprint-preview-input.schema.json" => include_str!(
                        "../../../contracts/schemas/blueprint-preview-input.schema.json"
                    ),
                    "schemas/plot-extract-input.schema.json" => {
                        include_str!("../../../contracts/schemas/plot-extract-input.schema.json")
                    }
                    "schemas/plot-correct-input.schema.json" => {
                        include_str!("../../../contracts/schemas/plot-correct-input.schema.json")
                    }
                    "schemas/validation-run-input.schema.json" => {
                        include_str!("../../../contracts/schemas/validation-run-input.schema.json")
                    }
                    "schemas/finding-disposition-input.schema.json" => include_str!(
                        "../../../contracts/schemas/finding-disposition-input.schema.json"
                    ),
                    "schemas/drama-build-input.schema.json" => {
                        include_str!("../../../contracts/schemas/drama-build-input.schema.json")
                    }
                    "schemas/drama-edit-input.schema.json" => {
                        include_str!("../../../contracts/schemas/drama-edit-input.schema.json")
                    }
                    "schemas/drama-compare-input.schema.json" => {
                        include_str!("../../../contracts/schemas/drama-compare-input.schema.json")
                    }
                    "schemas/drama-script-input.schema.json" => {
                        include_str!("../../../contracts/schemas/drama-script-input.schema.json")
                    }
                    _ => panic!("unregistered embedded input schema"),
                };
                let mut input = serde_json::from_str(source).expect("embedded input schema");
                if reference.starts_with("schemas/blueprint-") {
                    input = blueprint::bundle(input);
                } else if reference.starts_with("schemas/plot-")
                    || reference == "schemas/review-validate-input.schema.json"
                {
                    input = plot::bundle(input);
                }
                action["input_schema"] = input;
                action.as_object_mut().unwrap().remove("input_schema_ref");
            }
        }
        catalog
    })
}

fn bytes(value: &Value) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec_pretty(value)?)
}
fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::new("invalid_input", format!("缺少或无效字段：{field}")))
}
fn integer(value: &Value, field: &str) -> Result<u64> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| Error::new("invalid_input", format!("缺少或无效字段：{field}")))
}
fn stage_blueprint_snapshot(store: &Store, bp: &Value, changes: &mut Changes) -> Result<()> {
    let revision = integer(bp, "revision")?;
    let path = format!("shared/blueprint-revisions/{revision}.json");
    let record = format!(".hetu/blueprints/{revision}.json");
    store.directory("shared/blueprint-revisions")?;
    store.directory(".hetu/blueprints")?;
    let content = bytes(bp)?;
    let descriptor = json!({"schema_version":"1.0.0","blueprint_id":bp["blueprint_id"],"revision":revision,"path":path,"sha256":digest(&content)});
    let has_content = store.exists(&path)?;
    let has_record = store.exists(&record)?;
    ensure(
        has_content == has_record,
        "hetu.integrity_failure",
        "设定集历史修订记录不完整，保留文件并停止写入。",
    )?;
    if has_content {
        ensure(
            store.read(&path)? == content && store.json(&record)? == descriptor,
            "hetu.integrity_failure",
            "设定集历史修订已被改写，不能覆盖历史。",
        )?;
    } else {
        changes.insert(path, content);
        changes.insert(record, bytes(&descriptor)?);
    }
    Ok(())
}
fn schema(value: &Value, schema: &Value) -> Result<()> {
    let validator = jsonschema::validator_for(schema)
        .map_err(|_| Error::new("hetu.integrity_failure", "内置输入合同无效。"))?;
    if let Some(error) = validator.iter_errors(value).next() {
        return Err(Error::new(
            "invalid_input",
            format!("输入不符合合同：{}", error.instance_path),
        ));
    }
    Ok(())
}
fn validate_action_input(action: &str, input: &Value) -> Result<()> {
    static VALIDATORS: OnceLock<BTreeMap<String, jsonschema::Validator>> = OnceLock::new();
    let validators = VALIDATORS.get_or_init(|| {
        catalog()["actions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| {
                (
                    item["name"].as_str().unwrap().to_owned(),
                    jsonschema::validator_for(&item["input_schema"])
                        .expect("embedded action validator"),
                )
            })
            .collect()
    });
    if let Some(error) = validators[action].iter_errors(input).next() {
        return Err(Error::new(
            "invalid_input",
            format!("输入不符合合同：{}", error.instance_path),
        ));
    }
    Ok(())
}
fn operation_path(action: &str, key: &str, author: bool) -> String {
    format!(
        ".hetu/operations/{}.json",
        digest(format!(
            "{}\0{action}\0{key}",
            if author { "author" } else { "agent" }
        ))
    )
}

impl Kernel {
    /// 只供可信入口组装；业务请求中不能提供 mode、actor 或作者批准。
    pub fn open(config: Value) -> Result<Self> {
        let options: OpenConfig = serde_json::from_value(config)?;
        if options.creation_project_path.is_some() {
            ensure(
                options.workspace_path.is_none() && options.create.is_none(),
                "invalid_input",
                "筹备与作品范围必须二选一。",
            )?;
            return Self::open_creation_project(options);
        }
        ensure(
            options.create_project.is_none(),
            "invalid_input",
            "创建筹备必须选择筹备目录。",
        )?;
        let workspace_path = options.workspace_path.as_deref().unwrap_or("");
        ensure(
            !workspace_path.is_empty(),
            "invalid_input",
            "请选择工作区。",
        )?;
        let path = Path::new(workspace_path);
        let author = options.mode == Mode::Author;
        if let Some(create) = &options.create {
            ensure(author, "forbidden", "Agent 不能创建或任意选择工作区。")?;
            ensure(
                !create.title.trim().is_empty() && create.title.chars().count() <= 200,
                "invalid_input",
                "作品名称不能为空或超过 200 字。",
            )?;
            ensure(
                matches!(create.locale.as_str(), "zh-CN" | "en"),
                "invalid_input",
                "作品语言无效。",
            )?;
            ensure(
                !create.operation_key.is_empty() && create.operation_key.len() <= 128,
                "invalid_input",
                "创建工作区需要有效操作键。",
            )?;
            if let Some(metadata) = &create.metadata {
                schema(metadata, &domain::novel::definition("metadata"))?;
                domain::novel::validate_metadata(metadata)?;
                ensure(
                    metadata["title"] == create.title && metadata["language_tag"] == create.locale,
                    "invalid_input",
                    "作品初始资料与创建名称、语言不一致。",
                )?;
            }
            if let Some(source) = &create.creation_source {
                schema(source, &creative_tasks::definition("creation_source"))?;
            }
            if !path.exists() {
                std::fs::create_dir(path)?;
            }
        }
        let store = Store::open(path)?;
        let empty = std::fs::read_dir(path)?.next().is_none();
        if empty {
            ensure(
                options.create.is_some(),
                "not_found",
                "此目录不是河图洛书工作区。",
            )?;
            store.directory(".hetu/transactions")?;
            store.directory(".hetu/operations")?;
        } else if store.exists(".heturc.json")? {
            let config = store.json(".heturc.json")?;
            ensure(
                config["schema_version"] == "1.0.0"
                    && config["blueprint_path"] == "shared/blueprint.json",
                "unsupported_version",
                "此目录不是支持的河图洛书工作区。",
            )?;
            for path in [
                ".hetu/transactions",
                ".hetu/operations",
                ".hetu/audit",
                ".hetu/cache",
            ] {
                store.directory(path)?;
            }
            for package in PACKAGES {
                for child in ["documents", "drafts"] {
                    store.directory(&format!("packages/{package}/{child}"))?;
                }
            }
        }
        let _lock = store.lock()?;
        store.recover()?;
        if empty {
            let create = options.create.as_ref().unwrap();
            let config = json!({"schema_version":"1.0.0","workspace_id":id("workspace"),"title":create.title,"locale":create.locale,"blueprint_path":"shared/blueprint.json","novel_path":"packages/novel/novel.json","packages":PACKAGES});
            for directory in ["shared", "exports", ".hetu/audit", ".hetu/cache"] {
                store.directory(directory)?;
            }
            for package in PACKAGES {
                for child in ["documents", "drafts"] {
                    store.directory(&format!("packages/{package}/{child}"))?;
                }
            }
            for path in [
                "novel/outlines",
                "novel/annotations",
                "novel/plot",
                "drama/skeletons",
                "drama/comparisons",
                "drama/reports",
                "music-cue/cues",
                "music-cue/assets",
                "visual-prompt/cues",
                "visual-prompt/assets",
            ] {
                store.directory(&format!("packages/{path}"))?;
            }
            let blueprint = json!({"schema_version":"1.0.0","blueprint_id":id("blueprint"),"revision":1,"lock":{"locked":false,"changed_at":now(),"actor_ref":AUTHOR},"characters":[],"factions":[],"locations":[],"timeline":[],"world":[],"rules":[]});
            let bp_bytes = bytes(&blueprint)?;
            let action = "hetu.workspaces.create";
            let input = serde_json::to_value(create)?;
            let input_digest = Self::input_digest(&input)?;
            let mut receipt = domain::success(
                action,
                config["workspace_id"].as_str().unwrap(),
                json!({"workspace":config}),
            );
            let op = Self::operation(&create.operation_key, &input_digest);
            receipt["operation"] = op.clone();
            let mut changes = Changes::new();
            novels::stage_initial_novel(
                &store,
                &config["workspace_id"],
                create.metadata.clone().unwrap_or_else(|| json!({"title":create.title,"author_name":"","synopsis":"","genre":"","language_tag":create.locale,"status":"planning"})),
                Vec::new(),
                &mut changes,
            )?;
            stage_blueprint_snapshot(&store, &blueprint, &mut changes)?;
            changes.insert(".heturc.json".into(), bytes(&config)?);
            if let Some(source) = &create.creation_source {
                changes.insert(".hetu/creation-source.json".into(), bytes(source)?);
            }
            changes.insert("shared/blueprint.json".into(), bp_bytes.clone());
            changes.insert(
                ".hetu/blueprint-head.json".into(),
                bytes(&json!({"revision":1,"sha256":digest(&bp_bytes)}))?,
            );
            changes.insert(
                ".gitignore".into(),
                b".hetu/transactions/\n.hetu/cache/\n.hetu/git/\n.hetu/operations/\n.hetu/audit/\n.hetu/workspace.lock\nexports/\n.DS_Store\n"
                    .to_vec(),
            );
            changes.insert(operation_path(action, &create.operation_key, true), bytes(&json!({"operation_id":op["id"],"action":action,"actor_scope":"author","key":create.operation_key,"input_digest":input_digest,"result":receipt}))?);
            store.transaction(&changes)?;
        }
        let config_bytes = store.read(".heturc.json")?;
        let config: Value = serde_json::from_slice(&config_bytes)?;
        ensure(
            config["schema_version"] == "1.0.0",
            "unsupported_version",
            "工作区格式版本不受支持。",
        )?;
        checked_id(text(&config, "workspace_id")?, "workspace")?;
        ensure(
            config["blueprint_path"] == "shared/blueprint.json"
                && (config["novel_path"].is_null()
                    || config["novel_path"] == "packages/novel/novel.json")
                && config["packages"] == json!(PACKAGES),
            "hetu.integrity_failure",
            "内容包与设定集路径不符合工作区合同。",
        )?;
        if let Some(create) = options.create {
            let original = store.json(&operation_path(
                "hetu.workspaces.create",
                &create.operation_key,
                true,
            ))?;
            ensure(
                original["input_digest"] == Self::input_digest(&serde_json::to_value(&create)?)?,
                "idempotency_conflict",
                "此目录已创建，原操作参数不一致。",
            )?;
        }
        let kernel = Self {
            store,
            config,
            config_sha: digest(config_bytes),
            author,
            workspace_path: path.canonicalize()?,
            authorization_path: options.authorization_path,
            task_id: options.task_id,
        };
        kernel.blueprint()?;
        kernel.check_task_session()?;
        Ok(kernel)
    }
    pub fn scope(&self) -> &str {
        self.config[if self.is_creation_project() {
            "project_id"
        } else {
            "workspace_id"
        }]
        .as_str()
        .unwrap()
    }
    pub fn scope_kind(&self) -> &str {
        if self.is_creation_project() {
            "creation_project"
        } else {
            "workspace"
        }
    }
    pub fn bound_task(&self) -> Option<&str> {
        self.task_id.as_deref()
    }
    fn is_creation_project(&self) -> bool {
        self.config.get("project_id").is_some()
    }
    fn config_path(&self) -> &str {
        if self.is_creation_project() {
            ".hetu-project.json"
        } else {
            ".heturc.json"
        }
    }
    fn action_available(&self, action: &Value) -> bool {
        let name = action["name"].as_str().unwrap_or("");
        let in_scope = action["scopes"]
            .as_array()
            .map_or(!self.is_creation_project(), |scopes| {
                scopes.iter().any(|s| s == self.scope_kind())
            });
        in_scope
            && if self.task_id.is_some() {
                creative_tasks::TASK_ACTIONS.contains(&name)
            } else {
                self.author
                    || !name.starts_with("hetu.creative_tasks.")
                        && !name.starts_with("hetu.interactions.")
            }
    }
    fn operation_record_path(&self, action: &str, key: &str) -> String {
        match &self.task_id {
            Some(task) => operation_path(action, &format!("{task}\0{key}"), self.author),
            None => operation_path(action, key, self.author),
        }
    }
    pub fn request(&self, request: Value) -> Value {
        let action = request
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("hetu.request.invalid")
            .to_owned();
        let mut output = match self.execute(&request) {
            Ok(value) => value,
            Err(error) => domain::failure(&action, self.scope(), &error),
        };
        if let Some(metadata) = catalog()["actions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["name"] == action)
        {
            output["contract_revision"] = metadata["contract_revision"].clone();
        }
        output
    }
    fn input_digest(input: &Value) -> Result<String> {
        let mut fixed = input.clone();
        if let Some(object) = fixed.as_object_mut() {
            object.remove("operation_key");
        }
        Ok(format!(
            "sha256:{}",
            digest(serde_json_canonicalizer::to_vec(&fixed)?)
        ))
    }
    fn operation(key: &str, input_digest: &str) -> Value {
        json!({"id":id("op"),"key":key,"input_digest":input_digest,"recover_action":"hetu.operations.get"})
    }
    fn execute(&self, request: &Value) -> Result<Value> {
        schema(
            request,
            &json!({"type":"object","additionalProperties":false,"required":["action","contract_revision","input"],"properties":{"action":{"type":"string"},"contract_revision":{"type":"string"},"input":{"type":"object"}}}),
        )?;
        let action = text(request, "action")?;
        let metadata = catalog()["actions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["name"] == action)
            .ok_or_else(|| Error::new("hetu.capability_unavailable", "此构建尚未实现该动作。"))?;
        ensure(
            self.action_available(metadata),
            "forbidden",
            "此连接没有该范围或任务的操作权限。",
        )?;
        ensure(
            request["contract_revision"] == metadata["contract_revision"],
            "unsupported_version",
            "动作合同修订不受支持，请重新读取能力目录。",
        )?;
        let input = &request["input"];
        validate_action_input(action, input)?;
        ensure(
            !metadata["author_only"].as_bool().unwrap() || self.author,
            "forbidden",
            "此动作仅允许作者在可信本机入口操作。",
        )?;
        let _lock = self.store.lock()?;
        self.store.recover()?;
        ensure(
            digest(self.store.read(self.config_path())?) == self.config_sha,
            "revision_conflict",
            "工作区配置被外部修改，请重新打开并审阅。",
        )?;
        self.check_task_session()?;
        let write = metadata["effect"] != "read"
            && !(action == "hetu.plot.extract" && input["save_result"] == false)
            && !(action == "hetu.drama.compare" && input["save_result"] == false)
            && !(action == "hetu.validation.run" && input["save_report"] == false);
        let key = if write {
            text(input, "operation_key")?
        } else {
            ""
        };
        let input_digest = Self::input_digest(input)?;
        let op_path = self.operation_record_path(action, key);
        // 原键先于 CAS。成功后重复请求不因当前修订已前进而失去回执。
        if write && self.store.exists(&op_path)? {
            let previous = self.store.json(&op_path)?;
            self.check_operation_task(&previous)?;
            ensure(
                previous["result"]["contract_revision"] == metadata["contract_revision"],
                "idempotency_conflict",
                "原操作属于其他合同修订，请查询原回执，不重新执行。",
            )?;
            ensure(
                previous["input_digest"] == input_digest,
                "idempotency_conflict",
                "原操作键已绑定其他输入，不能复用。",
            )?;
            return Ok(previous["result"].clone());
        }
        if action == "hetu.git.snapshot" && input["phase"] == "execute" {
            return self.execute_git_snapshot(input, &op_path, &input_digest);
        }
        if action == "hetu.creation_projects.create_novel" {
            return self.execute_create_novel(input, &op_path, &input_digest);
        }
        let mut changes = Changes::new();
        let data = self.dispatch(action, input, &mut changes)?;
        let mut output = domain::success(action, self.scope(), data);
        output["contract_revision"] = metadata["contract_revision"].clone();
        if action == "hetu.git.snapshot" && input["phase"] == "prepare" {
            output["status"] = json!("pending");
        }
        if matches!(
            action,
            "hetu.plot.extract" | "hetu.plot.correct" | "hetu.plot.get"
        ) && output["data"]["plot"]["coverage"]["status"] == "partial"
        {
            output["status"] = json!("partial");
        }
        if matches!(
            action,
            "hetu.validation.run"
                | "hetu.reports.get"
                | "hetu.reviews.validate"
                | "hetu.documents.validate"
        ) && output["data"]["report"]["status"] == "partial"
        {
            output["status"] = json!("partial");
        }
        if action.starts_with("hetu.drama.")
            && (output["data"]["skeleton"]["status"] == "partial"
                || output["data"]["comparison"]["status"] == "partial")
        {
            output["status"] = json!("partial");
        }
        if action.starts_with("hetu.drama.")
            && output["data"]["mapping"]["coverage_status"] == "partial"
        {
            output["status"] = json!("partial");
        }
        if write {
            let operation = Self::operation(key, &input_digest);
            output["operation"] = operation.clone();
            let record = json!({"operation_id":operation["id"],"action":action,"key":key,"input_digest":input_digest,"actor_scope":if self.author { "author" } else { "agent" },"result":output});
            let mut record = record;
            if let Some(task) = &self.task_id {
                record["task_id"] = json!(task);
            }
            changes.insert(op_path, bytes(&record)?);
            changes.insert(format!(".hetu/audit/{}.json", operation["id"].as_str().unwrap()), bytes(&json!({"schema_version":"1.0.0","operation_id":operation["id"],"action":action,"actor_ref":self.actor(),"input_digest":input_digest,"created_at":now(),"status":output["status"]}))?);
            self.store.transaction(&changes)?;
        }
        Ok(output)
    }
    fn actor(&self) -> &str {
        if self.author { AUTHOR } else { AGENT }
    }
    fn blueprint(&self) -> Result<Value> {
        let bytes = self.store.read("shared/blueprint.json")?;
        let head = self.store.json(".hetu/blueprint-head.json")?;
        ensure(
            head["sha256"] == digest(&bytes),
            "hetu.integrity_failure",
            "设定集被外部修改，请审阅差异，不自动信任或覆盖。",
        )?;
        let bp: Value = serde_json::from_slice(&bytes)?;
        ensure(
            bp["revision"] == head["revision"],
            "hetu.integrity_failure",
            "设定集修订不一致。",
        )?;
        self.validate_blueprint(&bp)?;
        Ok(bp)
    }
    fn validate_blueprint(&self, bp: &Value) -> Result<()> {
        blueprint::validate(bp)?;
        let mut sources = BTreeMap::new();
        for source in blueprint::source_refs(bp) {
            let document = checked_id(text(source, "document_id")?, "doc")?;
            let revision = checked_id(text(source, "revision_id")?, "rev")?;
            let key = (document, revision);
            if !sources.contains_key(&key) {
                sources.insert(key.clone(), self.document_content(&key.0, Some(&key.1))?);
            }
            let content = sources[&key]["content"].as_str().unwrap();
            let start = usize::try_from(integer(source, "byte_start")?)
                .map_err(|_| Error::new("hetu.invalid_source_ref", "来源范围超过支持上限。"))?;
            let end = usize::try_from(integer(source, "byte_end")?)
                .map_err(|_| Error::new("hetu.invalid_source_ref", "来源范围超过支持上限。"))?;
            ensure(
                content.get(start..end) == source["quote"].as_str(),
                "hetu.invalid_source_ref",
                "来源范围必须位于完整 UTF-8 字符边界，且原文引句完全一致。",
            )?;
        }
        for rule in bp["rules"].as_array().unwrap() {
            for reference in rule["scope"]["document_ids"].as_array().unwrap() {
                self.document(reference.as_str().unwrap())?;
            }
        }
        Ok(())
    }
    fn blueprint_revision(&self, revision: Option<u64>) -> Result<(Value, String)> {
        let current = self.blueprint()?;
        let number = revision.unwrap_or(integer(&current, "revision")?);
        if current["revision"] == number {
            return Ok((current, digest(self.store.read("shared/blueprint.json")?)));
        }
        ensure(
            self.store
                .entries("shared")?
                .iter()
                .any(|entry| entry == "blueprint-revisions"),
            "not_found",
            "此设定集历史修订不存在。",
        )?;
        let path = format!("shared/blueprint-revisions/{number}.json");
        let record = self
            .store
            .json(&format!(".hetu/blueprints/{number}.json"))?;
        let content = self.store.read(&path)?;
        let sha = digest(&content);
        ensure(
            record["path"] == path
                && record["revision"] == number
                && record["blueprint_id"] == current["blueprint_id"]
                && record["sha256"] == sha,
            "hetu.integrity_failure",
            "设定集历史记录与摘要不一致。",
        )?;
        let bp: Value = serde_json::from_slice(&content)?;
        ensure(
            bp["revision"] == number && bp["blueprint_id"] == current["blueprint_id"],
            "hetu.integrity_failure",
            "历史设定集的身份或修订不一致。",
        )?;
        self.validate_blueprint(&bp)?;
        Ok((bp, sha))
    }
    fn expected_blueprint(&self, expected: &Value) -> Result<Value> {
        let bp = self.blueprint()?;
        let sha = digest(self.store.read("shared/blueprint.json")?);
        ensure(
            expected["revision"] == bp["revision"] && expected["sha256"] == sha,
            "revision_conflict",
            "设定集版本已变化，请重新比较。",
        )?;
        Ok(bp)
    }
    fn save_blueprint(&self, bp: &Value, changes: &mut Changes) -> Result<()> {
        self.validate_blueprint(bp)?;
        let bp_bytes = bytes(bp)?;
        ensure(
            bp_bytes.len() <= 16 * 1024 * 1024,
            "hetu.budget_exceeded",
            "设定集超过当前读取与保存预算。",
        )?;
        stage_blueprint_snapshot(&self.store, &self.blueprint()?, changes)?;
        stage_blueprint_snapshot(&self.store, bp, changes)?;
        changes.insert(
            ".hetu/blueprint-head.json".into(),
            bytes(&json!({"revision":bp["revision"],"sha256":digest(&bp_bytes)}))?,
        );
        changes.insert("shared/blueprint.json".into(), bp_bytes);
        Ok(())
    }
    fn dispatch(&self, action: &str, input: &Value, changes: &mut Changes) -> Result<Value> {
        match action {
            "hetu.capabilities.get" => Ok(
                json!({"abi_version":1,"schema_version":"1.0.0","scope_ref":{"kind":self.scope_kind(),"id":self.scope()},"task_id":self.task_id,"actions":catalog()["actions"].as_array().unwrap().iter().filter(|a|self.action_available(a)).collect::<Vec<_>>(),"entry_mode":if self.author { "author" } else { "agent" }}),
            ),
            "hetu.creation_projects.get" => self.get_creation_project(input),
            "hetu.creation_projects.save" => self.save_creation_project(input, changes),
            "hetu.creative_tasks.preview_prompt" => self.preview_creative_task(input),
            "hetu.creative_tasks.prepare" => self.prepare_creative_task(input, changes),
            "hetu.creative_tasks.get" => self.get_creative_task(input),
            "hetu.creative_tasks.list" => self.list_creative_tasks(input),
            "hetu.creative_tasks.submit_result" => self.submit_creative_result(input, changes),
            "hetu.creative_tasks.inspect_inbox" => self.inspect_task_inbox(input, changes),
            "hetu.creative_tasks.close" => self.close_creative_task(input, changes),
            "hetu.creative_tasks.mark_copied" => self.mark_task_copied(input, changes),
            "hetu.interactions.get" => self.get_task_interaction(input),
            "hetu.interactions.save_selection" => self.save_task_selection(input, changes),
            "hetu.workspaces.get" | "hetu.workspaces.list" => Ok(json!({"workspace":self.config})),
            "hetu.novels.get" => self.get_novel(),
            "hetu.novels.initialize" => self.initialize_novel(input, changes),
            "hetu.novels.update" => self.update_novel(input, changes, false),
            "hetu.novels.save_structure" => self.update_novel(input, changes, true),
            "hetu.git.status" => self.git_status(),
            "hetu.git.diff" => self.git_diff(input),
            "hetu.git.snapshot_diff" => self.git_snapshot_diff(input),
            "hetu.git.log" => self.git_log(input),
            "hetu.git.get_snapshot" => self.get_git_snapshot(input),
            "hetu.git.list_snapshots" => self.list_git_snapshots(input),
            "hetu.git.init" => self.git_init(input),
            "hetu.git.snapshot" => self.prepare_git_snapshot(input, changes),
            "hetu.git.approve_snapshot" => self.approve_git_snapshot(input),
            "hetu.assets.inspect" => self.inspect_asset(input),
            "hetu.assets.import" => self.import_asset(input, changes),
            "hetu.assets.update" => self.update_asset(input, changes),
            "hetu.assets.get" => self.get_asset(input),
            "hetu.assets.list" => self.list_media(input, "asset"),
            "hetu.cues.save" => self.save_cue(input, changes),
            "hetu.cues.get" => self.get_cue(input),
            "hetu.cues.list" => self.list_media(input, "cue"),
            "hetu.blueprints.get" => {
                let (bp, sha) =
                    self.blueprint_revision(input.get("revision").and_then(Value::as_u64))?;
                Ok(json!({"blueprint":bp,"revision":bp["revision"],"sha256":sha}))
            }
            "hetu.blueprints.preview_change" | "hetu.blueprints.save" => {
                let current = self.expected_blueprint(&input["expected"])?;
                ensure(
                    current["lock"]["locked"] == false,
                    "hetu.blueprint_locked",
                    "请先由作者解锁设定集。",
                )?;
                let (bp, impact) =
                    blueprint::apply(&current, input["typed_changes"].as_array().unwrap())?;
                self.validate_blueprint(&bp)?;
                if action.ends_with(".save") {
                    self.save_blueprint(&bp, changes)?;
                }
                Ok(
                    json!({"blueprint":bp,"revision":bp["revision"],"sha256":digest(bytes(&bp)?),"impact":impact,"preview":action.ends_with(".preview_change")}),
                )
            }
            "hetu.blueprints.lock" | "hetu.blueprints.unlock" => {
                let mut bp = self.expected_blueprint(&input["expected"])?;
                bp["revision"] = json!(integer(&bp, "revision")?.checked_add(1).ok_or_else(
                    || Error::new("hetu.budget_exceeded", "设定集修订超过支持上限。")
                )?);
                bp["lock"] = json!({"locked":action.ends_with(".lock"),"changed_at":now(),"actor_ref":self.actor(),"reason":input.get("reason").cloned().unwrap_or(json!(""))});
                self.save_blueprint(&bp, changes)?;
                Ok(json!({"blueprint":bp,"revision":bp["revision"],"sha256":digest(bytes(&bp)?)}))
            }
            "hetu.documents.create" => self.create_document(input, changes),
            "hetu.documents.list" => {
                let mut documents = Vec::new();
                for package in ["novel", "drama"] {
                    for name in self
                        .store
                        .entries(&format!("packages/{package}/documents"))?
                    {
                        checked_id(&name, "doc")?;
                        let doc = self.store.json(&format!(
                            "packages/{package}/documents/{name}/document.json"
                        ))?;
                        if input.get("kind").is_none_or(|kind| *kind == doc["kind"]) {
                            documents.push(doc);
                        }
                    }
                }
                documents.sort_by_key(|d| d["created_at"].as_str().unwrap_or("").to_string());
                Ok(json!({"documents":documents,"next_cursor":null}))
            }
            "hetu.documents.get" => self.document_content(
                text(input, "document_id")?,
                input.get("revision_id").and_then(Value::as_str),
            ),
            "hetu.documents.save" => self.save_document(input, changes),
            "hetu.drafts.preview_adoption" => self.preview_adoption(input),
            "hetu.drafts.adopt" => self.adopt_draft(input, changes),
            "hetu.documents.validate" => self.validate_document(input, changes),
            "hetu.documents.preview_finalization" => self.preview_finalization(input),
            "hetu.documents.finalize" => self.finalize_document(input, changes),
            "hetu.documents.withdraw_finalization" => self.withdraw_finalization(input, changes),
            "hetu.documents.lifecycle" => self.document_lifecycle(input),
            "hetu.drafts.submit" => self.submit_draft(input, changes),
            "hetu.drafts.submit_current" => self.submit_current(input, changes),
            "hetu.reviews.begin" => self.begin_review(input, changes),
            "hetu.reviews.get" => self.get_review(input),
            "hetu.reviews.list" => self.list_reviews(input),
            "hetu.reviews.decide" => self.decide_review(input, changes),
            "hetu.reviews.validate" => self.validate_review(input, changes),
            "hetu.drafts.list" => {
                let mut drafts = Vec::new();
                for package in PACKAGES {
                    if input.get("package").is_some_and(|p| p != package) {
                        continue;
                    }
                    for name in self.store.entries(&format!("packages/{package}/drafts"))? {
                        checked_id(&name, "draft")?;
                        let draft = self.draft_content(&name)?["draft"].clone();
                        if input
                            .get("state")
                            .is_none_or(|state| *state == draft["state"])
                        {
                            drafts.push(draft);
                        }
                    }
                }
                Ok(json!({"drafts":drafts,"next_cursor":null}))
            }
            "hetu.drafts.get" => self.draft_content(text(input, "draft_id")?),
            "hetu.plot.extract" => self.extract_plot(input, changes),
            "hetu.plot.correct" => self.correct_plot(input, changes),
            "hetu.plot.get" => {
                let plot = self.read_plot(text(input, "plot_revision_id")?)?;
                self.plot_result(&plot, true)
            }
            "hetu.plot.list" => self.list_plots(input),
            "hetu.drama.build_skeleton" => self.build_skeleton(input, changes),
            "hetu.drama.get_skeleton" => self.get_skeleton(input),
            "hetu.drama.list_skeletons" => self.list_skeletons(input),
            "hetu.drama.edit_skeleton" => self.edit_skeleton(input, changes),
            "hetu.drama.compare" => self.compare_drama(input, changes),
            "hetu.drama.get_comparison" => self.get_comparison(input),
            "hetu.drama.list_comparisons" => self.list_comparisons(input),
            "hetu.drama.create_script" => self.create_script(input, changes),
            "hetu.drama.get_script_mapping" => self.get_script_mapping(input),
            "hetu.validation.run" => self.run_validation(input, changes),
            "hetu.reports.get" => {
                let report = self.read_report(text(input, "report_id")?)?;
                self.report_result(&report, true)
            }
            "hetu.reports.list" => self.list_reports(input),
            "hetu.findings.disposition" => self.disposition(input, changes),
            "hetu.operations.get" => {
                let record = if let Some(op_id) = input.get("operation_id").and_then(Value::as_str)
                {
                    checked_id(op_id, "op")?;
                    let mut found = None;
                    for name in self.store.entries(".hetu/operations")? {
                        let record = self.store.json(&format!(".hetu/operations/{name}"))?;
                        if record["operation_id"] == op_id
                            && record["actor_scope"] == if self.author { "author" } else { "agent" }
                        {
                            found = Some(record);
                            break;
                        }
                    }
                    found.ok_or_else(|| Error::new("not_found", "此范围内没有该原操作。"))?
                } else {
                    self.store.json(
                        &self.operation_record_path(text(input, "action")?, text(input, "key")?),
                    )?
                };
                self.check_operation_task(&record)?;
                Ok(json!({"original_result":record["result"]}))
            }
            _ => Err(Error::new("hetu.capability_unavailable", "动作尚未实现。")),
        }
    }
    fn document_root(&self, document_id: &str) -> Result<String> {
        checked_id(document_id, "doc")?;
        for package in ["novel", "drama"] {
            if self
                .store
                .entries(&format!("packages/{package}/documents"))?
                .iter()
                .any(|name| name == document_id)
            {
                return Ok(format!("packages/{package}/documents/{document_id}"));
            }
        }
        Err(Error::new("not_found", "文档不存在。"))
    }
    fn document(&self, document_id: &str) -> Result<Value> {
        if let Some(source) = self.draft_source(document_id)? {
            return Ok(source["document"].clone());
        }
        self.store.json(&format!(
            "{}/document.json",
            self.document_root(document_id)?
        ))
    }
    fn document_content(&self, document_id: &str, revision_id: Option<&str>) -> Result<Value> {
        if let Some(source) = self.draft_source(document_id)? {
            ensure(
                revision_id.is_none_or(|r| source["revision"]["revision_id"] == r),
                "not_found",
                "草稿证据不包含该修订。",
            )?;
            return Ok(source);
        }
        let root = self.document_root(document_id)?;
        let document = self.document(document_id)?;
        self.verify_lifecycle_head(&document)?;
        let rev_id = revision_id.unwrap_or(text(&document, "current_revision_id")?);
        checked_id(rev_id, "rev")?;
        let revision = self
            .store
            .json(&format!("{root}/revisions/{rev_id}.json"))?;
        ensure(
            revision["document_id"] == document_id && revision["revision_id"] == rev_id,
            "hetu.integrity_failure",
            "修订归属无效。",
        )?;
        let extension = if revision["source_format"] == "fountain" {
            "fountain"
        } else {
            "md"
        };
        let expected_path = format!("{root}/revisions/{rev_id}.{extension}");
        ensure(
            revision["content_path"] == expected_path,
            "hetu.integrity_failure",
            "修订路径不符合规范。",
        )?;
        let content = self.store.read(&expected_path)?;
        ensure(
            revision["sha256"] == digest(&content) && revision["size_bytes"] == content.len(),
            "hetu.integrity_failure",
            "不可变正文已被修改，保留原文件并停止依赖此修订。",
        )?;
        let content = String::from_utf8(content)
            .map_err(|_| Error::new("hetu.integrity_failure", "正文不是 UTF-8。"))?;
        Ok(json!({"document":document,"revision":revision,"content":content}))
    }
    fn stage_revision(
        &self,
        document: &mut Value,
        content: &str,
        parent: Option<&str>,
        changes: &mut Changes,
    ) -> Result<Value> {
        let doc_id = text(document, "document_id")?;
        let package = if document["kind"] == "drama_script" {
            "drama"
        } else {
            "novel"
        };
        let root = format!("packages/{package}/documents/{doc_id}");
        let rev_id = id("rev");
        let ext = if document["source_format"] == "fountain" {
            "fountain"
        } else {
            "md"
        };
        let path = format!("{root}/revisions/{rev_id}.{ext}");
        let mut revision = json!({"schema_version":"1.0.0","revision_id":rev_id,"document_id":doc_id,"source_format":document["source_format"],"content_path":path,"sha256":digest(content),"size_bytes":content.len(),"created_at":now(),"actor_ref":self.actor()});
        if let Some(parent) = parent {
            revision["parent_revision_id"] = json!(parent);
            let previous = self
                .store
                .json(&format!("{root}/revisions/{parent}.json"))?;
            revision["origin_kind"] = json!("author");
            if let Some(contributions) = previous.get("contribution_refs") {
                revision["contribution_refs"] = contributions.clone();
            }
        } else {
            revision["origin_kind"] = json!("author");
        }
        changes.insert(path, content.as_bytes().to_vec());
        changes.insert(format!("{root}/revisions/{rev_id}.json"), bytes(&revision)?);
        document["current_revision_id"] = json!(rev_id);
        changes.insert(format!("{root}/document.json"), bytes(document)?);
        Ok(revision)
    }
    fn create_document(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let drama = input["kind"] == "drama_script";
        ensure(
            input["source_format"] == if drama { "fountain" } else { "markdown" },
            "invalid_input",
            "剧本使用 Fountain，其他正文使用 Markdown。",
        )?;
        let mut document = json!({"schema_version":"1.0.0","document_id":id("doc"),"kind":input["kind"],"title":input["title"],"source_format":input["source_format"],"language_tag":input.get("language_tag").unwrap_or(&self.config["locale"]),"created_at":now()});
        let revision =
            self.stage_revision(&mut document, text(input, "content")?, None, changes)?;
        if document["kind"] == "novel_chapter" {
            self.append_novel_chapter(&document, input.get("volume_id"), changes)?;
        }
        Ok(json!({"document":document,"revision":revision}))
    }
    fn save_document(&self, input: &Value, changes: &mut Changes) -> Result<Value> {
        let doc_id = text(input, "document_id")?;
        let current = self.document_content(doc_id, None)?;
        let mut document = current["document"].clone();
        ensure(
            document["draft_source_id"].is_null(),
            "forbidden",
            "草稿证据只读；改写请提交新草稿。",
        )?;
        ensure(
            document["current_revision_id"] == input["base_revision_id"],
            "revision_conflict",
            "正文已有新修订，保留编辑内容并比较差异。",
        )?;
        ensure(
            document["source_format"] == input["source_format"],
            "invalid_input",
            "不能通过保存隐式改变正文格式。",
        )?;
        let revision = self.stage_revision(
            &mut document,
            text(input, "content")?,
            Some(text(input, "base_revision_id")?),
            changes,
        )?;
        Ok(json!({"document":document,"revision":revision}))
    }
}

impl Kernel {
    fn record_page(&self, input: &Value, mut records: Vec<Value>, field: &str) -> Result<Value> {
        records.sort_by(|a, b| {
            b["created_at"]
                .as_str()
                .cmp(&a["created_at"].as_str())
                .then_with(|| b.to_string().cmp(&a.to_string()))
        });
        let mut query = input.clone();
        query.as_object_mut().unwrap().remove("cursor");
        query.as_object_mut().unwrap().remove("limit");
        let fingerprint = digest(serde_json::to_vec(
            &json!({"scope":self.scope(),"field":field,"query":query,"records":records}),
        )?);
        let start = if let Some(cursor) = input["cursor"].as_str() {
            let (hash, offset) = cursor
                .split_once(':')
                .ok_or_else(|| Error::new("cursor_invalid", "分页游标无效。"))?;
            let at = offset
                .parse::<usize>()
                .map_err(|_| Error::new("cursor_invalid", "分页游标无效。"))?;
            ensure(
                hash == fingerprint && at > 0 && at < records.len(),
                "cursor_invalid",
                "列表或筛选已变化，请重新查询。",
            )?;
            at
        } else {
            0
        };
        let end = start
            .saturating_add(input["limit"].as_u64().unwrap_or(50) as usize)
            .min(records.len());
        Ok(
            json!({field:&records[start..end],"next_cursor":(end<records.len()).then(||format!("{fingerprint}:{end}"))}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_input_uses_rfc8785_utf16_order_and_ecmascript_numbers() {
        let input = json!({"\u{e000}":2,"😀":1,"operation_key":"ignored"});
        assert_eq!(
            Kernel::input_digest(&input).unwrap(),
            "sha256:04208f6cdb854e2ab1b07dd3633a39dec854344fe72824cf7f2fdb4e2e33129e"
        );
        let input: Value = serde_json::from_str(r#"{"x":1e30,"n":-0.0}"#).unwrap();
        assert_eq!(
            Kernel::input_digest(&input).unwrap(),
            "sha256:9cd4d5340382ae8f7f8e7862600e6c7b46054f9343bc15cbcd937ccee9c14d09"
        );
    }
}
