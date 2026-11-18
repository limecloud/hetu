//! 开放插件适配层：包和生命周期由 TS 宿主管理，业务规则复用 Core。
use super::*;

impl Kernel {
    pub(crate) fn execute_open_plugin(&self, action: &str, input: &Value) -> Result<Value> {
        let binding = self
            .management_grant
            .as_ref()
            .ok_or_else(|| Error::new("forbidden", "机器入口须沿当前作品连接。"))?;
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
        runtime["management_binding"] = binding.clone();
        if action == "hetu.plugins.invoke" && input.get("view").is_some() {
            let capabilities = crate::plugin_settings::request(
                binding["client_adapter"].as_str().unwrap_or(""),
                "hetu.plugins.capabilities", &runtime,
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
        crate::plugin_settings::request(
            binding["client_adapter"].as_str().unwrap_or(""),
            action,
            &runtime,
        )
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
