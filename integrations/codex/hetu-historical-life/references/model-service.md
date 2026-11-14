# 河图模型服务

作者选择河图模型服务处理文字或图片时读取本节。它是外部 Agent 的创作工具，不修改 Codex、Claude Code、WorkBuddy 自身的基础模型或账号。

## 连接与发现

先打开固定任务，使用 `hetu.models.list`，分别以 `kind: text|image` 读取作者当前渠道的目录、限制、计费方式和 `default_model_id`。平台渠道返回政策版本和 Credits 价格；自定义渠道返回 `billing.mode: provider`，没有可核定的金额。MCP 对应 `hetu_list_models`，CLI 使用同一动作：

```bash
hetu --client codex call hetu.models.list --input <任务输入文件>
```

客户端按作者实际宿主填写，输入包含 open 返回的完整 `task_ref`。未连接时引导作者在“设置 → 模型服务”选择河图平台或自定义渠道。平台渠道打开河图网站、核对验证码并确认，会员和支付由网站进入 Cloud 托管页面；自定义渠道由作者在本机设置 URL、密钥和模型代码。不要索取、读取或回显供应商及 Cloud 凭据，不因未连接阻断本地创作。这里的选择不修改外部 Agent 自身的基础模型。

## 固定计划与批准

1. 只用获权任务组织固定输入；文字 32 KiB、附加 instructions 8 KiB、图片提示 16 KiB，并遵守目录更小的限制。不扫描书库，不读取未保存内容。首版图片为文字生成图片，不提交参考图、视频或任意 URL。
2. 调用 `hetu.model_tasks.prepare` / `hetu_prepare_model_task`，提供 `kind`、`artifact_kind`、`model_id`、`prompt`、`title` 与原 `operation_key`。平台渠道另传当前目录的 `billing_policy_version`、`estimated_credits`；自定义渠道须传 `billing_mode: provider`，禁止填写虚构的政策或零 Credits。文字类型须属于任务输出合同，图片为 `artifact_kind: image`。
3. prepare 只在本机保存计划，不外发正文或扣费。把原 `plan_id` 告诉作者，请在原任务的“模型调用与费用确认”审阅完整输入及费用上限。Agent 不能调用作者批准动作、模拟点击或扩大预算。
4. 通过 `hetu.model_tasks.get` / `hetu_get_model_task` 查看批准状态，批准后再以 `hetu.model_tasks.submit` / `hetu_submit_model_task` 提交原计划。登录或默认模型选择不能代替本次内容与费用批准。

文字输出为闭合 `{text: string}`，不提供任意聊天、流式或工具调用。长输入由 Agent 在作者授权内拆分，每项计划分别批准；不要在工具内构造自动生成循环。默认模型变化不修改原计划。

## 恢复与收集

超时、取消等待、未知响应或进程重启后，先用 `hetu.model_tasks.get` 查询原 `plan_id`。重复 submit 对已提交计划也只查询。查不到不证明未执行，禁止换键、换计划或换模型再次付费。价格或余额冲突保留原计划，请作者核对费用和原结果后决定后续。

成功后调用 `hetu.model_tasks.collect` / `hetu_collect_model_task`。文字得到参考内容和固定任务文件；图片须通过大小、摘要、格式、尺寸和完整解码。重复收集返回同一文件，不重新下单。临时图片须在服务提供的有效期内收集，过期不重新生成。

按返回的 `next_action: hetu.creative_tasks.submit_result` 与原 output_contract 提交候选：文字用 content；图片用实际 file_name、sha256、`source_format: image`。改稿仍由 Agent 按 edit_scope 组织 patches，不把整篇生成内容覆盖作者原文。记录实际模型、计划 ID 与工具来源；作者独立采纳、选用封面及定稿。

账号、环境或自定义渠道配置变化后重读目录；原计划绑定精确渠道、地址与凭据版本，不静默切换或重发。自定义渠道仅接受直接交付的 Base64 图片；未提供原结果查询接口时，未知结果须由作者与供应商核对，河图不会重新发送。视频没有执行动作。
