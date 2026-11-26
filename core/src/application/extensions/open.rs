//! 开放插件适配层：包和生命周期由 TS 宿主管理，业务规则复用 Core。
use super::*;

impl Kernel {
    pub(crate) fn execute_open_plugin(&self, action: &str, input: &Value, cancelled: &dyn Fn()->bool) -> Result<Value> {
        self.work_record(&input["work_ref"], None)?;
        if let Some(work) = self.granted_work()? {
            ensure(
                work == input["work_ref"],
                "forbidden",
                "插件调用与连接作品不一致。",
            )?;
        }
        let mut runtime = input.clone();
        runtime["workspace_directory"] = json!(self.workspace_path);
        if self.workspace_execution {
            let identity = crate::infrastructure::platform::identity(&self.workspace_path)?;
            runtime["execution_binding"] = json!({"client_adapter":self.execution_client.as_deref().unwrap_or("generic"),
                "work_ref":input["work_ref"],"workspace_id":self.scope(),"root_identity":{"device":identity.0,"inode":identity.1}});
        } else {
            runtime["management_binding"] = self.management_grant.as_ref()
                .ok_or_else(|| Error::new("forbidden", "机器入口须沿当前作品连接。"))?.clone();
        }
        if action == "hetu.plugins.invoke" && input.get("view").is_some() {
            let capabilities = crate::plugin_settings::request_cancellable(
                runtime.get("execution_binding").unwrap_or(&runtime["management_binding"])["client_adapter"].as_str().unwrap_or(""),
                "hetu.plugins.capabilities", &runtime, cancelled,
            )?;
            ensure(capabilities["invocation_projection_version"] == 1,
                "hetu.capability_unavailable", "当前插件宿主未提供调用前只读投影检查。")?;
            ensure(capabilities["capabilities_sha256"] == input["capabilities_sha256"],
                "hetu.stale_evidence", "插件能力已变化，请重新发现。")?;
            let target = &input["action"];
            ensure(["actions", "data_actions", "core_actions", "resource_actions"].iter().any(|group|
                capabilities[*group].as_array().is_some_and(|items| items.iter().any(|item|
                    (item["id"] == *target || item["name"] == *target) && item["effect"] == "read"))),
                "invalid_input", "结果投影只允许只读动作，不能重新执行写入。")?;
        }
        crate::plugin_settings::request_cancellable(
            runtime.get("execution_binding").unwrap_or(&runtime["management_binding"])["client_adapter"].as_str().unwrap_or(""),
            action,
            &runtime,
            cancelled,
        )
    }

    pub(crate) fn plugin_invocation_is_read(&self, input: &Value) -> Result<bool> {
        let capability = self.execute_open_plugin("hetu.plugins.capabilities", &json!({
            "work_ref":input["work_ref"],"plugin_id":input["plugin_id"],"package_sha256":input["package_sha256"]}), &|| false)?;
        ensure(capability["capabilities_sha256"] == input["capabilities_sha256"],
            "hetu.stale_evidence", "插件能力已变化，请重新发现。")?;
        for group in ["actions", "data_actions", "core_actions", "resource_actions"] {
            if let Some(action) = capability[group].as_array().and_then(|items| items.iter()
                .find(|item| item["id"] == input["action"] || item["name"] == input["action"])) {
                return Ok(action["effect"] == "read");
            }
        }
        Err(Error::new("hetu.capability_unavailable", "插件未声明该动作。"))
    }

    /// 私有宿主连接继承当前执行范围，不能变为作者或同根其他作品。
    pub fn open_plugin_execution(workspace: &Path, binding: &Value) -> Result<Self> {
        closed(binding, &["client_adapter", "work_ref", "workspace_id", "root_identity"], &[])?;
        closed(&binding["root_identity"], &["device", "inode"], &[])?;
        schema(&binding["work_ref"], &works::definition("work_ref"))?;
        let mut kernel = Self::open_execution_as(json!({"workspace_path":workspace,"mode":"agent"}), text(binding,"client_adapter")?)?;
        let identity = crate::infrastructure::platform::identity(&kernel.workspace_path)?;
        ensure(binding["workspace_id"] == kernel.scope()
            && binding["root_identity"] == json!({"device":identity.0,"inode":identity.1}),
            "forbidden", "插件执行连接不属于当前工作区身份。")?;
        kernel.work_record(&binding["work_ref"], None)?;
        kernel.execution_work = Some(binding["work_ref"].clone());
        Ok(kernel)
    }

    /// 上下文是宿主装配的数据合同，不是单独的插件授权。
    fn open_plugin_context(&self, context: &Value) -> Result<Value> {
        closed(
            context,
            &["plugin_id", "package_sha256", "work_ref", "types"],
            &[],
        )?;
        plugin_id(text(context, "plugin_id")?)?;
        sha(text(context, "package_sha256")?)?;
        schema(&context["work_ref"], &works::definition("work_ref"))?;
        self.work_record(&context["work_ref"], None)?;
        if let Some(work) = self.granted_work()? {
            ensure(
                work == context["work_ref"],
                "forbidden",
                "当前连接属于其他作品。",
            )?;
        }
        let types = context["types"]
            .as_array()
            .ok_or_else(|| Error::new("invalid_input", "插件类型须为数组。"))?;
        ensure(
            types.len() <= 16,
            "hetu.budget_exceeded",
            "插件类型超过预算。",
        )?;
        let mut seen = std::collections::BTreeSet::new();
        for kind in types {
            closed(kind, &["kind", "schema_version", "schema"], &[])?;
            ensure(
                seen.insert(text(kind, "kind")?)
                    && !text(kind, "kind")?.is_empty()
                    && !text(kind, "schema_version")?.is_empty(),
                "invalid_input",
                "插件类型重复或无效。",
            )?;
            ensure(
                bytes(&kind["schema"])?.len() <= 32768,
                "hetu.budget_exceeded",
                "插件 Schema 超过预算。",
            )?;
            jsonschema::validator_for(&kind["schema"])
                .map_err(|_| Error::new("invalid_input", "插件 Schema 无效。"))?;
        }
        let mut descriptor = context.clone();
        descriptor["access_mode"] = json!("open");
        // 旧存储与游标算法仍消费这些内部字段；不创建或读取插件授权记录。
        descriptor["grant_id"] = json!(digest(bytes(context)?));
        descriptor["permissions"] = json!(["objects.read", "objects.write", "work.read"]);
        Ok(descriptor)
    }

    pub fn open_plugin_request(&self, params: Value) -> Value {
        let action = params["request"]["action"]
            .as_str()
            .unwrap_or("hetu.plugins.request")
            .to_owned();
        let run = || -> Result<Value> {
            closed(&params, &["context", "request"], &[])?;
            ensure(
                bytes(&params)?.len() <= LIMIT,
                "hetu.budget_exceeded",
                "插件请求超过 1MiB。",
            )?;
            let context = self.open_plugin_context(&params["context"])?;
            let mut request = params["request"].clone();
            request_schema(&request)?;
            if action == "hetu.plugins.catalog" {
                let core = self.request(
                    json!({"action":"hetu.capabilities.get","contract_revision":"1","input":{}}),
                );
                ensure(
                    core["status"] == "succeeded",
                    "hetu.capability_unavailable",
                    "核心能力发现失败。",
                )?;
                return Ok(domain::success(
                    &action,
                    self.scope(),
                    json!({
                        "host_api":"1", "access_mode":"open", "plugin_id":context["plugin_id"],
                        "package_sha256":context["package_sha256"], "work_ref":context["work_ref"],
                        "types":context["types"], "actions":action_catalog()["actions"],
                        "core_actions":core["data"]["actions"]
                    }),
                ));
            }
            if action.starts_with("hetu.extensions.") {
                ensure(
                    request["input"].get("work_ref").is_none()
                        || request["input"]["work_ref"] == context["work_ref"],
                    "invalid_input",
                    "插件数据请求与上下文作品不一致。",
                )?;
                request["input"]["work_ref"] = context["work_ref"].clone();
                return self.extension_data(
                    &context["work_ref"],
                    text(&context, "plugin_id")?,
                    &action,
                    &request["input"],
                    Some(&context),
                    None,
                );
            }
            // 只在领域 Schema 声明该字段时提供默认作品，不向旧合同塞入额外字段。
            if let Some(metadata) = catalog()["actions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|a| a["name"] == action)
            {
                if metadata["input_schema"]["properties"]
                    .get("work_ref")
                    .is_some()
                    && request["input"].get("work_ref").is_none()
                {
                    request["input"]["work_ref"] = context["work_ref"].clone();
                }
            }
            // 作者视图的插件上下文也固定作品，不能借可信入口读取同根其他作品任务。
            if action == "hetu.creative_tasks.get" {
                self.check_task_work_access(&request["input"], &context["work_ref"])?;
            }
            Ok(self.request(request))
        };
        run().unwrap_or_else(|e| domain::failure(&action, self.scope(), &e))
    }

    /// 无窗口入口沿原客户端连接装配；不会将 Agent 转为作者身份。
    pub fn open_plugin_kernel(workspace: &Path, management: Option<Value>) -> Result<Self> {
        match management {
            Some(binding) => {
                Self::open_managed(json!({"workspace_path":workspace,"mode":"agent"}), binding)
            }
            None => Self::open(json!({"workspace_path":workspace,"mode":"author"})),
        }
    }
}

#[cfg(test)]
mod execution_connection_tests {
    use super::*;

    fn ok(result: Value) -> Value {
        assert_eq!(result["status"], "succeeded", "{result}");
        result["data"].clone()
    }

    #[test]
    fn private_execution_connection_keeps_agent_and_exact_work_without_management_records() {
        let directory = tempfile::tempdir().unwrap();
        let kernel = Kernel::open(json!({"mode":"author","workspace_path":directory.path(),
            "create":{"title":"执行连接","locale":"zh-CN","operation_key":"create"}})).unwrap();
        let work = ok(kernel.request(json!({"action":"hetu.works.list","contract_revision":"1","input":{}})))["works"][0]["work_ref"].clone();
        let identity = crate::infrastructure::platform::identity(directory.path()).unwrap();
        let binding = json!({"client_adapter":"codex","work_ref":work,"workspace_id":kernel.scope(),
            "root_identity":{"device":identity.0,"inode":identity.1}});
        let plugin = Kernel::open_plugin_execution(directory.path(), &binding).unwrap();
        assert!(!plugin.is_author());
        assert!(plugin.management_binding().is_none());
        let context = json!({"plugin_id":"org.hetu.execution-test","package_sha256":"a".repeat(64),"work_ref":work,"types":[]});
        let request = |action: &str, input: Value| plugin.open_plugin_request(json!({"context":context,
            "request":{"action":action,"contract_revision":"1","input":input}}));
        let document = ok(request("hetu.documents.create",json!({"kind":"novel_chapter","title":"正文", "source_format":"markdown",
            "content":"保持Agent身份。","operation_key":"document"})));
        assert_eq!(document["revision"]["actor_ref"], AGENT);
        let other = ok(kernel.request(json!({"action":"hetu.drama.projects.create","contract_revision":"1",
            "input":{"title":"同根剧本","mode":"original","operation_key":"drama"}})));
        let denied = request("hetu.drama.projects.get", json!({"project_id":other["project"]["project_id"]}));
        assert_eq!(denied["error"]["code"], "forbidden");
        for (field, value) in [("workspace_id",json!("workspace_wrong")),("client_adapter",json!("author")),
            ("root_identity",json!({"device":identity.0,"inode":identity.1.saturating_add(1)}))] {
            let mut changed = binding.clone(); changed[field] = value;
            assert!(Kernel::open_plugin_execution(directory.path(), &changed).is_err(), "{field}");
        }
        let mut changed = binding;
        changed["work_ref"]["object_id"] = json!("novel_00000000-0000-4000-8000-000000000000");
        assert!(Kernel::open_plugin_execution(directory.path(), &changed).is_err());
    }
}
