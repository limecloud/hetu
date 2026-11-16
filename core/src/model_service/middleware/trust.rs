use crate::domain::{Result, ensure};
use serde_json::Value;

/// 自定义渠道只执行已经明确批准供应商计费的固定请求。
pub(in crate::model_service) struct TrustMiddleware;

impl TrustMiddleware {
    pub(in crate::model_service) fn pre_check(input: &Value) -> Result<()> {
        ensure(
            input["provider_billing_accepted"] == true,
            "hetu.author_confirmation_required",
            "请作者明确批准供应商单次计费。",
        )
    }
}
