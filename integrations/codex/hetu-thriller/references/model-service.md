# 河图模型服务

作者选择河图模型服务处理文字或图片时读取本节。它是外部 Agent 的创作工具，不修改 Codex、Claude Code、WorkBuddy 自身的基础模型或账号。

## 连接与发现

先打开固定任务，使用 `hetu.models.list`，分别以 `kind: text|image` 读取作者当前渠道的目录、限制、计费方式和 `default_model_id`。平台渠道返回政策版本和 Credits 价格；自定义渠道返回 `billing.mode: provider`，没有可核定的金额。MCP 对应 `hetu_list_models`，CLI 使用同一动作：

```bash
hetu --client codex call hetu.models.list --input <任务输入文件>
```

读取目录和准备计划可显式传 `channel_id: cloud` 或作者已配置的渠道 ID；省略时使用作者默认渠道。显式选择只固定本次计划，不改客户端全局设置。原计划的查询、提交和收集始终沿其固定渠道身份继续。

客户端按作者实际宿主填写，输入包含 open 返回的完整 `task_ref`。平台未连接或过期时，先运行 `hetu model-service status`，需要登录时运行 `hetu model-service login`，在当前对话给出返回的验证链接和验证码，请作者在浏览器核验并连接；作者告知完成后运行 `hetu model-service poll` 查询原连接，再沿原任务继续，不重复发起登录。也可由作者在“设置 → 模型服务”连接。会员和支付由网站进入 Cloud 托管页面；自定义渠道由作者在本机设置 URL、密钥和模型代码。不要索取、读取或回显供应商及 Cloud 凭据，不因未连接阻断本地创作；登录不代表批准生成费用。这里的选择不修改外部 Agent 自身的基础模型。

## 固定计划与批准

1. 只用获权任务组织固定输入；文字 32 KiB、附加 instructions 8 KiB、图片提示 16 KiB，并遵守目录更小的限制。不扫描书库，不读取未保存内容。首版图片为文字生成图片，不提交参考图、视频或任意 URL。
2. 调用 `hetu.model_tasks.prepare` / `hetu_prepare_model_task`，提供 `kind`、`artifact_kind`、`model_id`、`prompt`、`title` 与原 `operation_key`。平台渠道另传当前目录的 `billing_policy_version`、`estimated_credits`；自定义渠道须传 `billing_mode: provider`，禁止填写虚构的政策或零 Credits。文字类型须属于任务输出合同，图片为 `artifact_kind: image`。
3. 授权在当前 Agent 对话闭环。作者已明确允许的任务与预算，通过 `hetu_authorize_model_usage`（CLI：`hetu.model_tasks.authorize_usage`）登记完整 `task_ref`、首个 `plan_id`、实际 `authorization_note` 与固定操作键；`authorization` 指定 `channels: current|configured`、请求数上限 `max_requests` 和／或 Credits 上限 `max_credits`。仅作者明确完全授权时用 `unrestricted: true`，不附加上限。自定义渠道金额不可核定，使用请求数上限或明确完全授权。登记不发请求或扣费，不伪造作者未给出的授权，不把登录当成费用授权。
4. 原授权范围内连续准备并提交计划，不逐图确认，不要求回客户端审批。Core 在提交意图同一事务预留授权额度；达到上限以 `hetu.model_authorization_exhausted` 返回，本次未发送，Agent 在当前对话请求追加额度，再登记新授权键并提交原未发送计划。没有充分授权时先在对话交互；支持宿主 form elicitation 的 `hetu_request_model_confirmation` 可辅助确认单次或任务额度，不能代答宿主。作者取消或拒绝时不执行。

文字输出为闭合 `{text: string}`，不提供任意聊天、流式或工具调用。长输入由 Agent 在作者授权内拆分，每项保存固定计划并消费同一任务授权额度；不要在工具内构造自动生成循环。默认模型变化不修改原计划。

## 恢复与收集

超时、取消等待、未知响应或进程重启后，先用 `hetu.model_tasks.get` 查询原 `plan_id`。重复 submit 对已提交计划也只查询。查不到不证明未执行，禁止换键、换计划或换模型再次付费。价格或余额冲突保留原计划，请作者核对费用和原结果后决定后续。

成功后调用 `hetu.model_tasks.collect` / `hetu_collect_model_task`。文字得到参考内容和固定任务文件；图片须通过大小、摘要、格式、尺寸和完整解码。重复收集返回同一文件，不重新下单。临时图片须在服务提供的有效期内收集，过期不重新生成。

`hetu.credits_insufficient` 表示余额不足，Agent 在当前对话提示充值并提供相应渠道的账户入口，不让作者重填生成表单。作者告知已经充值后，先 get 原计划：仍未知或 reconciling 时继续查询，不能据充值推断原请求没执行；明确余额不足、`billing.state: released|not_reserved` 且 `recovery.resume_allowed: true` 时，可用原完整输入 prepare，增加 `resume_from_plan_id` 并保留新的固定操作键。Core 只允许原计划有一个关联恢复计划；已有 `replacement_plan_id` 时沿它继续。未扣费余额失败释放本地授权预留，恢复沿原任务授权执行，无需重新批准；授权上限与账户余额分别核验，充值不扩大原预算。充值尚未到账时继续明确提示余额不足，不循环创建新请求。

按返回的 `next_action: hetu.creative_tasks.submit_result` 与原 output_contract 提交候选：文字用 content；图片用实际 file_name、sha256、`source_format: image`。改稿仍由 Agent 按 edit_scope 组织 patches，不把整篇生成内容覆盖作者原文。记录实际模型、计划 ID 与工具来源；作者独立采纳、选用封面及定稿。

账号、环境或自定义渠道配置变化后重读目录；原计划绑定精确渠道、地址与凭据版本，不静默切换或重发。自定义渠道仅接受直接交付的 Base64 图片；未提供原结果查询接口时，未知结果须由作者与供应商核对，河图不会重新发送。视频没有执行动作。
