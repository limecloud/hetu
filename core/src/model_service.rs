//! 河图产品服务与作者自定义渠道；凭据只进入本机私密存储，不向 Agent 返回。
mod custom;
mod middleware;
use crate::domain::{self, Error, Result, digest, ensure};
use crate::infrastructure::store::Store;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum MediaKind {
    Text,
    Image,
}

impl MediaKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            MediaKind::Text => "text",
            MediaKind::Image => "image",
        }
    }
    pub fn from_str(s: &str) -> Result<Self> {
        match s {
            "text" => Ok(MediaKind::Text),
            "image" => Ok(MediaKind::Image),
            _ => Err(Error::new("invalid_input", "模型种类无效。")),
        }
    }
}

const ORIGIN: &str = "https://hetu.limeai.run";
const JSON_LIMIT: u64 = 256 * 1024;
fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value[field]
        .as_str()
        .ok_or_else(|| Error::new("invalid_input", "模型连接缺少必要字段。"))
}
mod machine;
pub struct ModelService {
    store: Store,
    machine_decision: Option<Value>,
}
fn encoded(value: &Value) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(value)?)
}
pub(crate) fn default_directory() -> Result<PathBuf> {
    if let Some(directory) = std::env::var_os("HETU_MODEL_SERVICE_DIR") {
        let path = PathBuf::from(directory);
        ensure(
            path.is_absolute(),
            "invalid_input",
            "模型服务目录必须为绝对路径。",
        )?;
        return Ok(path);
    }
    Ok(crate::collaboration::default_directory()?
        .parent()
        .ok_or_else(|| Error::new("missing_context", "缺少本机用户目录。"))?
        .join("ModelService"))
}
impl ModelService {
    pub fn open(directory: &Path) -> Result<Self> {
        std::fs::create_dir_all(directory)?;
        let store = Store::open(directory)?;
        store.directory(".hetu/transactions")?;
        Ok(Self {
            store,
            machine_decision: None,
        })
    }
    pub fn open_default() -> Result<Self> {
        Self::open(&default_directory()?)
    }
    fn settings(&self) -> Result<Value> {
        if self.store.exists("connection.json")? {
            self.store.json("connection.json")
        } else {
            Ok(json!({"origin":ORIGIN,"defaults":{"text":"","image":""}}))
        }
    }
    fn save(&self, settings: &Value) -> Result<()> {
        let mut changes = BTreeMap::from([("connection.json".into(), encoded(settings)?)]);
        self.stage_machine_receipt(settings, &mut changes)?;
        self.store.transaction(&changes)
    }
    pub(crate) fn identity_for(&self, kind: MediaKind) -> Result<Value> {
        self.identity_for_channel(kind, None)
    }
    pub(crate) fn identity_for_channel(
        &self,
        kind: MediaKind,
        channel: Option<&str>,
    ) -> Result<Value> {
        let _lock = self.store.read_lock()?;
        let settings = self.settings()?;
        match channel {
            None => self.selected_identity(&settings, kind),
            Some("cloud") => Self::settings_identity(&settings),
            Some(channel) => custom::identity(&settings, channel),
        }
    }
    pub(crate) fn authorization_connections(
        &self,
        kind: MediaKind,
        configured: bool,
    ) -> Result<Vec<Value>> {
        let _lock = self.store.read_lock()?;
        let settings = self.settings()?;
        if !configured {
            return Ok(vec![self.selected_identity(&settings, kind)?]);
        }
        let mut connections = Vec::new();
        if settings["token"].is_string() {
            connections.push(Self::settings_identity(&settings)?);
        }
        if let Some(channels) = settings["custom_channels"].as_object() {
            for (channel, profile) in channels {
                if profile["models"][kind.as_str()]
                    .as_array()
                    .is_some_and(|models| !models.is_empty())
                {
                    connections.push(custom::identity(&settings, channel)?);
                }
            }
        }
        ensure(
            !connections.is_empty(),
            "hetu.model_connection_required",
            "请先连接模型渠道。",
        )?;
        Ok(connections)
    }
    fn selected_identity(&self, settings: &Value, kind: MediaKind) -> Result<Value> {
        let channel = settings["channels"][kind.as_str()]
            .as_str()
            .unwrap_or("cloud");
        if channel == "cloud" {
            Self::settings_identity(settings)
        } else {
            custom::identity(settings, channel)
        }
    }
    fn settings_identity(settings: &Value) -> Result<Value> {
        ensure(
            settings["token"].is_string(),
            "hetu.model_connection_required",
            "请在设置的模型服务中连接河图账号。",
        )?;
        ensure(
            settings["account_ref"]
                .as_str()
                .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                && matches!(
                    settings["environment"].as_str(),
                    Some("sandbox" | "production")
                ),
            "hetu.integrity_failure",
            "模型连接缺少已验证的账号及环境。",
        )?;
        Ok(
            json!({"origin":settings["origin"],"account_ref":settings["account_ref"],"environment":settings["environment"]}),
        )
    }
    fn request_raw(
        &self,
        method: &str,
        path: &str,
        input: Option<&Value>,
        token: Option<&str>,
        origin: &str,
    ) -> Result<reqwest::blocking::Response> {
        let url = url::Url::parse(origin)
            .map_err(|_| Error::new("invalid_input", "河图服务地址无效。"))?;
        ensure(
            url.scheme() == "https"
                && url.origin().ascii_serialization() == origin
                && url.username().is_empty()
                && url.password().is_none(),
            "invalid_input",
            "河图服务必须使用精确 HTTPS Origin。",
        )?;
        let client = reqwest::blocking::Client::builder()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(110))
            .build()
            .map_err(|_| {
                Error::new("hetu.model_service_unavailable", "无法初始化河图服务连接。")
            })?;
        let mut request = client.request(
            method
                .parse()
                .map_err(|_| Error::new("invalid_input", "请求方法无效。"))?,
            format!("{origin}/api/hetu{path}"),
        );
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(input) = input {
            request = request.json(input);
        }
        let response = request.send().map_err(|_| {
            Error::new(
                "hetu.model_service_unavailable",
                "服务未返回确定结果；已提交任务须沿原计划查询，不要重新生成。",
            )
        })?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let value: Value =
                serde_json::from_reader(response.take(JSON_LIMIT)).unwrap_or(Value::Null);
            let code = value["error"]["code"]
                .as_str()
                .unwrap_or("service_unavailable");
            return Err(Error::new(
                match code {
                    "login_required" => "hetu.model_connection_required",
                    "budget_exceeded" => "hetu.budget_exceeded",
                    "credits_insufficient" => "hetu.credits_insufficient",
                    "policy_or_balance_changed" => "hetu.model_policy_changed",
                    "service_unconfigured" => "hetu.model_service_unconfigured",
                    "catalog_contract_mismatch" => "hetu.model_catalog_mismatch",
                    _ if status == 403 => "forbidden",
                    _ => "hetu.model_service_unavailable",
                },
                if code == "credits_insufficient" {
                    "河图平台余额不足，请在当前Agent对话提示充值，并提供河图账户入口 https://hetu.limeai.run/console/ 。充值后先查询原计划，确认终态后再决定新请求。"
                } else {
                    "模型服务请求未完成；请检查连接、权限和额度，已提交计划只沿原操作恢复。"
                },
            ));
        }
        Ok(response)
    }
    fn public_request(
        &self,
        method: &str,
        path: &str,
        input: Option<&Value>,
        settings: &Value,
    ) -> Result<Value> {
        let response = self.request_raw(
            method,
            path,
            input,
            settings["token"].as_str(),
            text(settings, "origin")?,
        )?;
        Ok(serde_json::from_reader(response.take(JSON_LIMIT))?)
    }
    pub(crate) fn api(
        &self,
        method: &str,
        path: &str,
        input: Option<&Value>,
        expected: &Value,
    ) -> Result<Value> {
        if expected["channel"] == "custom" {
            return self.custom_api(method, path, input, expected);
        }
        let settings = {
            let _lock = self.store.read_lock()?;
            self.settings()?
        };
        ensure(
            Self::settings_identity(&settings)? == *expected,
            "forbidden",
            "模型计划属于其他账号、环境或河图服务连接。",
        )?;
        self.public_request(method, path, input, &settings)
    }
    pub(crate) fn image(&self, key: &str, expected: &Value) -> Result<Vec<u8>> {
        if expected["channel"] == "custom" {
            return self.custom_image(key, expected);
        }
        let settings = {
            let _lock = self.store.read_lock()?;
            self.settings()?
        };
        ensure(
            Self::settings_identity(&settings)? == *expected,
            "forbidden",
            "图片属于其他账号或环境。",
        )?;
        let mut response = self.request_raw(
            "GET",
            &format!("/operations/{key}/image"),
            None,
            settings["token"].as_str(),
            text(&settings, "origin")?,
        )?;
        let maximum = 20 * 1024 * 1024;
        let mut bytes = Vec::new();
        response
            .by_ref()
            .take(maximum + 1)
            .read_to_end(&mut bytes)?;
        ensure(
            bytes.len() as u64 <= maximum,
            "hetu.budget_exceeded",
            "图片超过 20 MiB。",
        )?;
        Ok(bytes)
    }
    pub fn author_request(&self, action: &str, input: &Value) -> Result<Value> {
        match action {
            "inspect" => {
                let _lock = self.store.read_lock()?;
                let settings = self.settings()?;
                Ok(
                    json!({"connected":settings["token"].is_string() && settings["expires_at"].as_i64().is_some_and(|expires| expires > time::OffsetDateTime::now_utc().unix_timestamp()),"origin":settings["origin"],"account_ref":settings["account_ref"],"defaults":settings["defaults"],"channels":settings["channels"],"custom_channels":settings["custom_channels"],"pending":settings.get("pending").map(|v| json!({"verification_uri":v["verification_uri"],"verification_code":v["verification_code"]})),"expires_at":settings["expires_at"]}),
                )
            }
            "connect" => {
                let snapshot = {
                    let _lock = self.store.read_lock()?;
                    self.settings()?
                };
                let mut settings = snapshot.clone();
                let paired = self.public_request(
                    "POST",
                    "/connections",
                    Some(&json!({"label":"Hetu Luoshu"})),
                    &json!({"origin":ORIGIN}),
                )?;
                let uri = text(&paired, "verification_uri")?;
                ensure(
                    uri.starts_with(&format!("{ORIGIN}/console/?connect=")),
                    "hetu.integrity_failure",
                    "连接确认地址不属于河图。",
                )?;
                settings["pending"] = paired;
                let _lock = self.store.lock()?;
                ensure(
                    self.settings()? == snapshot,
                    "revision_conflict",
                    "连接已变化，请重新读取。",
                )?;
                self.save(&settings)?;
                drop(_lock);
                self.author_request("inspect", &json!({}))
            }
            "poll" => {
                let snapshot = {
                    let _lock = self.store.read_lock()?;
                    self.settings()?
                };
                let mut settings = snapshot.clone();
                let pending = &settings["pending"];
                let id = text(pending, "id")?;
                ensure(
                    id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()),
                    "hetu.integrity_failure",
                    "连接票据无效。",
                )?;
                let connected = self.public_request(
                    "POST",
                    &format!("/connections/{id}/poll"),
                    Some(&json!({"secret":pending["secret"]})),
                    &json!({"origin":ORIGIN}),
                )?;
                if connected["status"] == "pending" {
                    return Ok(json!({"status":"pending"}));
                }
                settings["token"] = connected["token"].clone();
                settings["expires_at"] = connected["expires_at"].clone();
                let session = self.public_request("GET", "/session", None, &settings)?;
                if settings["account_ref"] != session["account_ref"]
                    || settings["environment"] != session["environment"]
                {
                    settings["defaults"] = json!({"text":"","image":""});
                }
                settings["account_ref"] = session["account_ref"].clone();
                settings["environment"] = session["environment"].clone();
                settings.as_object_mut().unwrap().remove("pending");
                let _lock = self.store.lock()?;
                ensure(
                    self.settings()? == snapshot,
                    "revision_conflict",
                    "连接已变化，请重新读取。",
                )?;
                self.save(&settings)?;
                drop(_lock);
                self.author_request("inspect", &json!({}))
            }
            "catalog" => {
                let kind = MediaKind::from_str(text(input, "kind")?)?;
                self.api(
                    "GET",
                    &format!("/models/{}", kind.as_str()),
                    None,
                    &self.identity_for(kind)?,
                )
            }
            "select" => {
                let kind = MediaKind::from_str(text(input, "kind")?)?;
                let snapshot = {
                    let _lock = self.store.read_lock()?;
                    self.settings()?
                };
                let mut settings = snapshot.clone();
                let catalog = self.author_request("catalog", input)?;
                ensure(
                    catalog["items"]
                        .as_array()
                        .is_some_and(|items| items.iter().any(|v| v["id"] == input["model_id"])),
                    "invalid_input",
                    "请选择当前可用模型。",
                )?;
                settings["defaults"][kind.as_str()] = input["model_id"].clone();
                let _lock = self.store.lock()?;
                ensure(
                    self.settings()? == snapshot,
                    "revision_conflict",
                    "连接已变化，请重新读取。",
                )?;
                self.save(&settings)?;
                Ok(json!({"defaults":settings["defaults"]}))
            }
            "disconnect" => {
                let _lock = self.store.lock()?;
                let mut settings = self.settings()?;
                for key in [
                    "token",
                    "account_ref",
                    "environment",
                    "pending",
                    "expires_at",
                ] {
                    settings.as_object_mut().unwrap().remove(key);
                }
                self.save(&settings)?;
                Ok(json!({"connected":false}))
            }
            "custom_save" => self.save_custom(input),
            "channel_select" => {
                let kind = MediaKind::from_str(text(input, "kind")?)?;
                let channel = text(input, "channel_id")?;
                let _lock = self.store.lock()?;
                let mut settings = self.settings()?;
                ensure(
                    channel == "cloud" || settings["custom_channels"][channel].is_object(),
                    "invalid_input",
                    "请选择已有模型渠道。",
                )?;
                if !settings["channels"].is_object() {
                    settings["channels"] = json!({});
                }
                settings["channels"][kind.as_str()] = json!(channel);
                settings["defaults"][kind.as_str()] = json!("");
                self.save(&settings)?;
                Ok(json!({"channels":settings["channels"]}))
            }
            _ => Err(Error::new("invalid_input", "模型设置动作无效。")),
        }
    }
    pub fn request(value: Value) -> Value {
        let result = (|| {
            let service = Self::open_default()?;
            service.author_request(text(&value, "action")?, &value["input"])
        })();
        match result {
            Ok(data) => domain::success("hetu.model_service.settings", "local", data),
            Err(error) => domain::failure("hetu.model_service.settings", "local", &error),
        }
    }
}

pub(crate) fn plan_digest(value: &Value) -> Result<String> {
    Ok(digest(serde_json_canonicalizer::to_vec(value)?))
}
