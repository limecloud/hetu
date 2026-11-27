//! Bot配置只固定角色与外部执行选择，不持有作品权限或提供方凭据。
use super::{Error, Result, digest, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Execution {
    pub provider_id: String,
    pub surface: String,
    pub model_id: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub name: String,
    pub purpose: String,
    pub execution: Execution,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bot {
    pub bot_id: String,
    pub revision: u64,
    pub status: String,
    pub work_ref: Value,
    pub config: Config,
}

impl Config {
    pub fn parse(value: Value) -> Result<Self> {
        let config: Self = serde_json::from_value(value)?;
        for (text, max, multiline) in [
            (&config.name, 100, false),
            (&config.purpose, 8000, true),
            (&config.execution.provider_id, 80, false),
            (&config.execution.model_id, 255, false),
        ] {
            ensure(
                !text.trim().is_empty()
                    && text.chars().count() <= max
                    && !text.chars().any(|character| {
                        character.is_control() && !(multiline && matches!(character, '\n' | '\r' | '\t'))
                    }),
                "invalid_input",
                "Bot配置为空、超出预算或包含控制字符。",
            )?;
        }
        ensure(
            matches!(config.execution.surface.as_str(), "gui" | "tui"),
            "invalid_input",
            "Bot会话表面无效。",
        )?;
        Ok(config)
    }
}
impl Bot {
    pub fn reference(&self) -> Result<Value> {
        Ok(
            json!({"bot_id":self.bot_id,"revision":self.revision,"sha256":digest(serde_json_canonicalizer::to_vec(self)?)}),
        )
    }
    pub fn validate(&self) -> Result<()> {
        super::checked_id(&self.bot_id, "bot")?;
        ensure(
            self.revision > 0 && matches!(self.status.as_str(), "active" | "paused" | "archived"),
            "hetu.integrity_failure",
            "Bot身份、修订或生命周期无效。",
        )?;
        Config::parse(serde_json::to_value(&self.config)?)?;
        Ok(())
    }
    pub fn transition(&mut self, method: &str) -> Result<()> {
        self.status = match (method, self.status.as_str()) {
            ("pause", "active") => "paused",
            ("resume", "paused") => "active",
            ("archive", "active" | "paused") => "archived",
            ("restore", "archived") => "paused",
            _ => {
                return Err(Error::new(
                    "revision_conflict",
                    "Bot当前生命周期不接受此转换。",
                ));
            }
        }
        .into();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn config_rejects_credentials_and_restore_does_not_resume() {
        let mut config = json!({"name":"审阅助手","purpose":"核对固定章节\n保留作者意见","execution":{"provider_id":"codex","surface":"gui","model_id":"fixed-model"}});
        config["execution"]["api_key"] = json!("forbidden");
        assert!(Config::parse(config.clone()).is_err());
        config["execution"]
            .as_object_mut()
            .unwrap()
            .remove("api_key");
        let mut bot = Bot {
            bot_id: super::super::id("bot"),
            revision: 1,
            status: "active".into(),
            work_ref: Value::Null,
            config: Config::parse(config).unwrap(),
        };
        bot.transition("archive").unwrap();
        bot.transition("restore").unwrap();
        assert_eq!(bot.status, "paused");
        assert!(bot.transition("restore").is_err());
        bot.transition("resume").unwrap();
        assert_eq!(bot.status, "active");
    }
}
