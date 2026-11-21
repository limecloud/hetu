use super::*;
use crate::model_service::{MediaKind, ModelService, plan_digest};
mod approval;
mod authorization;
mod collection;
mod execution;
mod plans;
mod recovery;

#[cfg(test)]
mod tests;

pub(super) fn definition(name: &str) -> Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    let source = SCHEMA.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../contracts/schemas/model-service.schema.json"
        ))
        .expect("embedded model service schema")
    });
    domain::schema::definition(source, name)
}

fn folder(reference: &Value) -> Result<String> {
    Ok(format!(
        ".hetu/tasks/{}/models",
        checked_id(text(reference, "task_id")?, "task")?
    ))
}
fn path(reference: &Value, plan_id: &str) -> Result<String> {
    Ok(format!(
        "{}/{}.json",
        folder(reference)?,
        checked_id(plan_id, "model")?
    ))
}
fn credits(value: &Value) -> Result<u128> {
    value
        .as_str()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| Error::new("invalid_input", "额度必须为非负整数字符串。"))
}
fn plan_connection(service: &ModelService, plan: &Value) -> Result<Value> {
    service.identity_for_channel(MediaKind::from_str(text(plan, "kind")?)?, plan["channel_id"].as_str())
}
impl Kernel {
    pub(super) fn dispatch_model_local(
        &self,
        action: &str,
        input: &Value,
        changes: &mut Changes,
    ) -> Result<Value> {
        self.model_context(&input["task_ref"])?;
        match action {
            "hetu.model_tasks.authorize_usage" => {
                self.register_conversation_model_authorization(input, changes)
            }
            "hetu.model_tasks.list" => self.list_model_plans(&input["task_ref"]),
            "hetu.model_tasks.prepare" => self.prepare_model_plan(input, changes),
            "hetu.model_tasks.approve" => {
                ensure(self.has_workspace_authority(), "forbidden", "当前连接没有模型执行权限。")?;
                self.approve_model_plan_record(input, changes)
            }
            _ => Err(Error::new("invalid_input", "模型计划动作无效。")),
        }
    }
}
