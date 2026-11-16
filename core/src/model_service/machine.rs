//! 模型设置的会话入口复用同一私密Store；密钥只经输入进入凭据文件。
use super::*;

fn visible(settings: &Value) -> Result<Value> {
    let mut view = json!({});
    for key in [
        "origin",
        "account_ref",
        "expires_at",
        "defaults",
        "channels",
        "custom_channels",
    ] {
        view[key] = settings[key].clone();
    }
    view["connected"] = json!(
        settings["token"].is_string()
            && settings["expires_at"]
                .as_i64()
                .is_some_and(|t| t > time::OffsetDateTime::now_utc().unix_timestamp())
    );
    view["settings_sha256"] = json!(plan_digest(settings)?);
    Ok(view)
}
impl ModelService {
    pub(super) fn stage_machine_receipt(
        &self,
        settings: &Value,
        changes: &mut BTreeMap<String, Vec<u8>>,
    ) -> Result<()> {
        if let Some(decision) = &self.machine_decision {
            ensure(
                plan_digest(&self.settings()?)? == decision["expected_sha256"],
                "revision_conflict",
                "模型设置已变化，请重新读取当前状态。",
            )?;
            changes.insert(text(decision,"path")?.to_owned(), encoded(&json!({"input_sha256":decision["input_sha256"],"decision":decision["audit"],"result":visible(settings)?}))?);
        }
        Ok(())
    }
    pub fn machine_request(&mut self, client: &str, action: &str, input: &Value) -> Result<Value> {
        ensure(
            matches!(client, "codex" | "claude-code" | "workbuddy" | "generic"),
            "invalid_input",
            "客户端无效。",
        )?;
        if action == "hetu.model_settings.inspect" {
            let _guard = self.store.read_lock()?;
            return visible(&self.settings()?);
        }
        let key = text(input, "operation_key")?;
        ensure(
            !key.is_empty() && key.len() <= 128,
            "invalid_input",
            "操作键无效。",
        )?;
        let path = format!(
            "machine-operations/{}.json",
            domain::digest(encoded(&json!([client, key]))?)
        );
        let input_sha = plan_digest(input)?;
        {
            let _guard = self.store.read_lock()?;
            if self.store.exists(&path)? {
                let receipt = self.store.json(&path)?;
                if action == "hetu.model_settings.update" {
                    ensure(
                        receipt["input_sha256"] == input_sha,
                        "idempotency_conflict",
                        "原设置键已绑定其他输入。",
                    )?;
                }
                return Ok(receipt["result"].clone());
            }
        }
        ensure(
            action == "hetu.model_settings.update",
            "not_found",
            "尚无此设置操作回执。",
        )?;
        let method = text(input, "method")?;
        ensure(
            matches!(
                method,
                "custom_save" | "channel_select" | "select" | "disconnect"
            ),
            "invalid_input",
            "机器设置只支持渠道保存、渠道选择、模型选择和断开连接。",
        )?;
        ensure(
            !text(input, "authorization_note")?.trim().is_empty(),
            "invalid_input",
            "须如实记录作者的设置选择。",
        )?;
        self.store.directory("machine-operations")?;
        self.machine_decision = Some(
            json!({"path":path,"input_sha256":input_sha,"expected_sha256":input["expected_sha256"],"audit":{"client_adapter":client,"confirmation_channel":"agent_conversation","authorization_note":input["authorization_note"],"method":method,"recorded_at":domain::now()}}),
        );
        let changed = self.author_request(method, &input["settings"]);
        self.machine_decision = None;
        changed?;
        let _guard = self.store.read_lock()?;
        Ok(self.store.json(&path)?["result"].clone())
    }
}
