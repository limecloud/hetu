# 河图洛书模型服务接入

范围：文字与图片；视频仅记 `TODO.md`。河图提供设置与 CLI/MCP 生成封装，外部 Agent 执行生成任务；支持用户自定义渠道和 Cloud 平台渠道。河图 website 提供自己的 Console，作为合作应用登记至 Cloud。Cloud 是本团队中台，允许修复试点接入暴露的通用 CLI、授权及平台问题；shou 和 doutu 作为参考。沿用户授权完成应用登记、授权及图片测试，真实付款先核对商品、金额和支付模式；提交、推送及部署另按对应仓库要求处理。

## 接入边界

调用链为：外部 Agent → Hetu MCP／CLI → Core 固定任务计划 → hetu website 同源服务端 → Cloud 开放平台正式 Models API。账号与费用由 website 链接到经配置核验的 Cloud Console；开放平台入口为 `https://open.limeai.run`。

自定义渠道为：外部 Agent → Hetu MCP／CLI → Core 固定计划 → 作者配置的 HTTPS OpenAI 兼容渠道。密钥在本机私密目录保存，作品计划只记录引用和配置摘要。自定义渠道没有 Cloud 报价，作者须明确批准供应商单次计费；发送标记先落盘，未知结果只回读本机原操作，不自动重发。

website 保留 Astro 静态页面，通过 Cloudflare Pages Functions 增加 `/api/hetu/*`。它拥有本站会话、客户端配对与原操作键映射；Cloud 拥有身份和业务授权、供应商密钥、模型目录、计费及执行结果；Core 拥有本地任务、作者批准、参考候选、正文、采纳及定稿。网站不成为本机文件代理或云端书库。

## 作者与 Agent 流程

1. 作者在河图“设置 → 模型服务”打开 website，登录 Cloud、核对本机验证码并显式确认客户端。
2. website 服务端执行 Code + PKCE、ID Token 签名与在线 UserInfo 核验；本机只取得河图受限连接凭据。
3. 作者分别选择文字与图片默认模型。目录、限制与价格来自 Cloud 当前正式合同，不包含供应商密钥。
4. Agent 用完整任务引用读取目录并 prepare 固定计划；prepare 仅保存本机内容预览，不发送正文。
5. 作者在原任务“模型调用与费用确认”批准固定输入；Cloud 渠道确认单次 Credits 上限，自定义渠道确认供应商单次计费。Agent 无作者批准权。
6. submit 在网络请求前持久保存原计划与操作键；网络执行不占作品锁，返回后重验任务及账号。
7. 未知结果只 GET 原操作，不换键重发。collect 校验文字或图片，保存原任务 inbox 文件；Agent 按现有任务合同提交候选，作者独立采纳和定稿。

Hetu 作为应用在 Cloud 上架。Cloud Console 的应用卡通过已登记的网页入口打开河图自有控制台；页面与功能由 Hetu 交付，不在 Cloud 新增河图专属模块。登记片段为 `apps/website/cloud/web-application.json`，桌面与移动均进入 `https://hetu.limeai.run/console/`。

## 具体实现入口

| 层 | 入口 |
| --- | --- |
| Website | `apps/website/functions/api/hetu/[[path]].js` 与 `apps/website/server/` |
| 河图控制台 | `apps/website/src/components/HetuConsole.astro`、中英 `/console/` |
| 本机连接 | `core/src/model_service.rs`；Swift `ModelServiceClient` |
| 固定计划 | `core/src/application/model_tasks.rs`、`contracts/schemas/model-service.schema.json` |
| 原生设置和批准 | `apps/macos/Sources/HetuMac/ModelServiceSettings.swift` |
| Agent 合同 | `contracts/actions.json`、`contracts/tools/catalog.json`、共享 Skills 源 |

## 当前边界

- 文字是 Cloud 的 `structured-json.v1`，河图使用闭合 `{text: string}`；不是聊天、流式或工具调用接口。
- 图片通过临时生成和私密下载取得，完整解码后交付；首版只接受文字提示，不上传参考图。
- Cloud 文字 Catalog 的现行正式合同最多一个模型；实际目录超出时报告合同不一致，不擅改 Cloud 或静默截断。
- 登录会话最长一小时，过期后重新连接。同一账号和环境可沿原计划恢复，默认模型变化不修改原计划。
- 本地创作不要求联网；Agent 自身基础模型和账号不由河图设置修改。

## 发布所缺配置

website 需要实际 Web Client、消费应用、环境、Issuer、Models Audience、独立 Membership Audience、API Origin、Console 完整入口、绑定应用／环境的托管订阅 URL、媒体 Origin 白名单、独立 D1 binding、Client Secret 和独立会话加密密钥。精确字段及回调见 `apps/website/README.md`。仓库不得填猜测的应用 ID 或凭据。

已使用发布版 LimeCloud CLI 完成原设备授权，创建河图合作应用并更新配置至 revision 2，登记河图自有 `/console/` 网页入口。应用仍为 draft，不等于已经上架。Sandbox confidential Client 创建意图保存在 Cloud 仓库忽略目录，原错误响应未完整保存；后续列表为空，不能据此换键重发。CLI 源码已修复普通命令自动续期，真实管理调用已复用原授权续期；修复尚未发布到 npm。

网站已实现独立会员 Audience 的本人读取，以及绑定应用／环境的 Cloud 托管订阅入口；不复制商业事实或在 Agent 工具内发起支付。会员方案、真实支付、两条渠道实际出图及已登记 Client／Audience 的线上验证由用户于2026-11-15明确推迟。隔离测试、构建与本地运行不能替代这些验收。

## 本地验证 · 2026-11-15

- 最新 Core 模型专项10项通过，覆盖两种渠道的作者独立批准、固定输入、计费边界、未知结果零重发、账号／任务隔离及完整图片解码。两个 HTTP Client 均显式关闭自动重试。
- MCP stdio 串行17项通过，包含模型工具发现与任务权限边界。首轮并行有5项超过10秒响应期限；串行复核未修改产品或测试超时，全部通过。
- Website 服务端13项、会员与账号中英浏览器10项通过；会员桌面与手机截图已核对。Website 构建、Pages Functions 编译及原生 `HetuMac`、`HetuCLI` 构建通过。
- Skills、原生双语资源与文档校验通过。真实图片生成和真实订阅付款均未执行，视频仍在 `TODO.md`。
- Cloud CLI 自动续期专项7项、图片回归30项通过，源码包构建通过。服务端已补受控管理CLI固定24小时窗口，刷新不移动截止时间，网页空闲计时独立；原中央会话绝对到期及撤销仍生效。隔离MySQL/race的12项顶层专项通过，精确边界及接近24小时的刷新使用服务端原授权时间推进，未实际等待一天。旧授权不自动延长，发布后新期限需新的本人设备授权；当前未联调或部署。
- 两仓保留现有并行改动，本轮未提交、推送、部署或发布 CLI；本机默认安装尚未替换为本轮源码制品。
- 本轮4368预览服务和独立MySQL测试进程已停止，保留本地验证产物。
