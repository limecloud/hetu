use super::*;
use hetu_core::collaboration::CollaborationHub;
use std::time::Duration;
use tokio::sync::OwnedSemaphorePermit;

pub const TOOL: &str = "hetu_request_model_confirmation";

pub fn input_schema(base: &JsonObject) -> JsonObject {
    let mut schema = Value::Object(base.clone());
    let contract: Value = serde_json::from_str(include_str!(
        "../../../contracts/schemas/model-service.schema.json"
    ))
    .expect("embedded model service schema");
    schema["properties"]["authorization"] = contract["$defs"]["usage_authorization"].clone();
    schema.as_object().unwrap().clone()
}

pub fn available(context: &RequestContext<RoleServer>) -> bool {
    context
        .protocol_version()
        .is_some_and(|v| v == ProtocolVersion::V_2025_06_18)
        && context
            .client_capabilities()
            .and_then(|c| c.elicitation)
            .is_some_and(|e| e.form.is_some() || e.url.is_none())
}

pub async fn request(
    hub: Arc<CollaborationHub>,
    mut arguments: JsonObject,
    context: RequestContext<RoleServer>,
    permit: OwnedSemaphorePermit,
) -> Result<CallToolResponse, ErrorData> {
    if !available(&context) {
        return Err(ErrorData::invalid_request(
            "宿主未提供表单确认能力，请在当前Agent对话确认范围后登记任务额度授权。",
            None,
        ));
    }
    let authorization = arguments.remove("authorization");
    let args = Value::Object(arguments);
    // 先经普通业务入口验证完整参数，拒绝 approved 等调用方自报决定。
    let prepared = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let checked = hub.request(json!({"action":"hetu.model_tasks.get","contract_revision":"1","input":args}));
        if checked["status"] != "succeeded" { return Err(checked); }
        let result = hub.prepare_model_confirmation(&args["task_ref"], args["plan_id"].as_str().unwrap())
            .and_then(|confirmation| if let Some(policy) = authorization { confirmation.with_task_authorization(policy) } else { Ok(confirmation) });
        result.map_err(|error| json!({"spec_version":"0.2.1","kind":"result","action":"hetu.model_tasks.get","contract_revision":"1","status":"failed","context":{"scope_id":args["task_ref"]["scope_ref"]["id"]},"error":{"code":error.code,"message":error.message,"resolution":{"kind":"read","action":"hetu.model_tasks.get"}}}))
    }).await.map_err(|_| ErrorData::internal_error("确认上下文准备中断，请查询原计划。", None))?;
    let confirmation = match prepared {
        Ok(value) => value,
        Err(failure) => return Ok(CallToolResult::structured_error(failure).into()),
    };
    let record = confirmation.record();
    let requested = &record["requested_authorization"];
    let task_authorization = requested.is_object();
    if (task_authorization && requested["existing"].is_null())
        || (!task_authorization && record["approval"].is_null() && record["submitted"] == false)
    {
        let plan = &record["plan"];
        let billing = if plan["billing_mode"] == "provider" {
            "供应商对此单次请求计费，河图无法核定金额。".to_owned()
        } else {
            format!(
                "本次费用上限：{} Credits。",
                plan["estimated_credits"].as_str().unwrap_or("")
            )
        };
        let mut message = format!(
            "固定计划\n模型：{}\n渠道：{}\n次数：1\n{}\n完整外发输入：\n{}\n{}\n计划：{}\n摘要：{}",
            plan["payload"]["model_id"].as_str().unwrap_or(""),
            plan["connection"]["origin"].as_str().unwrap_or(""),
            billing,
            plan["payload"]["prompt"]
                .as_str()
                .or(plan["payload"]["input"].as_str())
                .unwrap_or(""),
            plan["payload"]["instructions"].as_str().unwrap_or(""),
            plan["plan_id"].as_str().unwrap_or(""),
            record["plan_sha256"].as_str().unwrap_or("")
        );
        if task_authorization {
            message = format!(
                "确认本任务的连续生成授权。\n额度：{}\n允许渠道：{}\n同一任务与类型内的模型和固定输入可由 Agent 按用户目标调整；额度内连续执行，不逐图确认。\n完全授权时持续执行至任务完成或账户／供应商额度不足；余额不足在当前对话提示充值。追加授权只在达到上限时请求。未知请求保留额度预留并沿原计划恢复。\n以下是当前首个计划：\n{}",
                requested["limits"],
                requested["connections"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|c| c["origin"].as_str().unwrap_or(""))
                    .collect::<Vec<_>>()
                    .join("、"),
                message
            );
        }
        let schema = ElicitationSchema::from_json_schema(json!({
            "type":"object","properties":{"confirm":{"type":"boolean","title":"确认以上任务范围与额度授权"}},"required":["confirm"]
        }).as_object().unwrap().clone()).map_err(|_| ErrorData::internal_error("确认合同无效。", None))?;
        let answer = tokio::select! {
            _ = context.ct.cancelled() => return Err(ErrorData::invalid_request("确认已取消，原计划未批准。", None)),
            answer = context.peer.create_elicitation_with_timeout(ElicitRequestParams::FormElicitationParams {
                meta: None, message, requested_schema: schema,
            }, Some(Duration::from_secs(300))) => answer,
        }.map_err(|_| ErrorData::invalid_request("宿主确认未完成，原计划未批准；请沿原计划查询。", None))?;
        if answer.action != ElicitationAction::Accept
            || answer
                .content
                .as_ref()
                .is_none_or(|v| v != &json!({"confirm":true}))
        {
            let mut data = record.clone();
            data["confirmation_status"] = json!("not_approved");
            return Ok(CallToolResult::structured(json!({"spec_version":"0.2.1","kind":"result","action":"hetu.model_tasks.get","contract_revision":"1","status":"succeeded","context":{"scope_id":plan["task_ref"]["scope_ref"]["id"]},"data":data})).into());
        }
    }
    // 用户决定只来自上述宿主响应；等待期间的撤权、计划或渠道变化由 Core 再次校验。
    let result = tokio::task::spawn_blocking(move || confirmation.confirm())
        .await
        .map_err(|_| ErrorData::internal_error("确认回执未知，请读取原计划，勿重复生成。", None))?
        .map_err(|error| ErrorData::invalid_request(error.message, None))?;
    Ok(CallToolResult::structured(result).into())
}
