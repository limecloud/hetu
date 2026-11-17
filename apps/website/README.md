> 本组件属于[河图洛书 Hetu Luoshu](../../README.md)，全局信息见根 README。

# 河图网站与控制台

## 本地开发

在仓库根目录安装锁定依赖后运行：

```bash
npm run dev
npm run check
npm run build
npm run preview --workspace @hetu/website
```

开发地址为 `http://127.0.0.1:4350`，构建预览为 `http://127.0.0.1:4351`。使用指南位于 `src/content/guides/zh-CN/` 与 `src/content/guides/en/`。首页 `/#prototype` 与 `/en/#prototype` 内嵌当前 Electron 客户端实图预览，可切换创作库、文稿、剧本与参考稿审核，并原位放大，不发布独立原型页面。构建读取根 `assets/`，不发布仓库 `docs/` 的工程文档；不编辑 `public/` 中生成的副本。

首页 `/#creation-workflow` 与 `/en/#creation-workflow` 展示接入、小说、剧本、短视频及返工交付的流程动画。完整流程位于 `/workflow/` 与 `/en/workflow/`，按作者、外部 Agent 和河图分别展示操作与成果，三类工程可独立开始。可选择 Codex、Claude Code、Cursor 或 WorkBuddy，复制各自的安装提示词；动画状态属于演示，不安装插件、不连接本机或调用生成服务。播放支持暂停、重播、逐步查看及减少动态效果。

客户端与 OpenAI、Anthropic、Gemini、DeepSeek、GLM、Kimi、Qwen、豆包、混元模型品牌分组展示，模型栏不代表内置路由或所有客户端均支持这些模型。原始 SVG、来源和 SHA-256 位于 `src/assets/agents/`；WorkBuddy 使用官网素材，其余图标来自固定版本的 LobeHub 品牌图标库，GLM 使用智谱品牌标识，许可证随文件保留。

首页成果示例使用六张连续镜头插画，进入视口播放一次后停止；意见比较只展示变化内容，保留原版与待审状态。动效共用一个播放焦点，支持手动浏览、暂停和减少动态效果。

展示图片、图标、下载及分享卡使用根 `assets/manifest.json` 核验摘要；作者指南的实际截图由本目录 `assets/guides/captures.json` 登记来源、尺寸与摘要。图片内容变化时，URL 的 `v` 参数随之更新；构建检查发布副本与摘要，防止旧 CDN 缓存继续显示旧图。

插件中心位于 `/plugins/` 与 `/en/plugins/`，精选场景由 `src/lib/plugins.ts` 维护，身份、名称、版本、许可和权限读取根 `plugins/*/plugin.json`。专业功能清单归各包的 `CAPABILITIES.md`，与 `integrations/catalog.json` 的客户端 Skills 套件分开。开发与发布指南在 `src/content/guides/{locale}/plugin-development.md` 和 `plugin-publishing.md`，收录表单归根 `.github/ISSUE_TEMPLATE/plugin-listing.yml`；目录不自动安装或授权。

## 浏览器验证

```bash
npm exec --workspace @hetu/website -- playwright install chromium
npm run test --workspace @hetu/website
```

测试前执行 `npm run build`。测试启动独立预览进程；使用已有 Chromium 时可设置 `PLAYWRIGHT_EXECUTABLE_PATH` 指向浏览器可执行文件。线上只读验证通过 `HETU_TEST_ORIGIN` 指定目标地址，不启动本地服务器。

## 模型服务配置

`/console/` 和 `/en/console/` 通过同源 `functions/api/hetu/[[path]].js` 连接 Cloud。`astro preview` 只预览静态页面；服务端测试使用隔离 SQLite 和模拟 OIDC／Models，不产生付费调用。在仓库根目录执行：

```bash
node --test apps/website/server/service.test.mjs
```

河图在 Cloud 中作为应用登记和上架。河图的 Console 页面、客户端连接、模型目录与本人调用记录由本仓库提供；Cloud Console 负责应用发现与打开入口，账号、费用和平台授权继续消费 Cloud 正式能力。按 Cloud 现有网页应用合同，在 `https://open.limeai.run` 合并 `cloud/web-application.json` 中的网页入口、管理入口及隐私／条款链接，不用该片段覆盖完整配置；应用资料、版本发布、上架审核及客户安装按该应用实际类型完成。

桌面与移动入口均为 `https://hetu.limeai.run/console/`，页面内可切换中文或英文。Cloud 的“打开应用”进入河图自己托管的控制台，不加载河图脚本到 Cloud 会话页面。该 JSON 是待登记的配置片段，不表示已经上架、安装或部署。

隐私政策位于 `/privacy/`，服务条款位于 `/terms/`，英文版本使用 `/en/` 前缀；内容由 `src/lib/legal.ts` 维护。

Pages 服务端须配置以下项目。缺项时模型 API 返回 `service_unconfigured`；本地创作与静态内容独立运行。

| 名称 | 含义 | 必填 |
| --- | --- | --- |
| `HETU_CLOUD_CONFIG` | 服务端 JSON，字段见下表 | 是 |
| `HETU_CLOUD_CLIENT_SECRET` | 对应环境 Web Client 的 Secret，仅存服务端 Secret | 是 |
| `HETU_CLOUD_ENCRYPTION_KEY` | 32 字节独立随机密钥的 Base64，用于会话加密 | 是 |
| `HETU_CLOUD_DB` | 独立 D1 binding；表结构由 `server/schema.sql` 声明 | 是 |

`HETU_CLOUD_CONFIG` 不进入 Astro 公共环境变量或静态制品：

| JSON 字段 | 含义 |
| --- | --- |
| `site_origin` | 河图精确 HTTPS Origin，当前为 `https://hetu.limeai.run` |
| `issuer` | 已登记的精确 OIDC Issuer，不由域名推导 |
| `client_id`、`application_id` | 当前环境 Web Client 与消费应用 |
| `environment`、`audience` | `sandbox` 或 `production` 及其精确 Models Audience |
| `api_origin` | 正式业务 API 的精确 HTTPS Origin |
| `console_url`、`open_url` | 经核验的 Console 账号完整入口及 `https://open.limeai.run` |
| `membership_audience` | 当前应用默认会员产品的完整 Audience，与 Models 独立，不由模型名称拼写 |
| `subscription_url` | 同一 Console Origin 的 `/billing/subscriptions?application=<APPLICATION_ID>&environment=<ENVIRONMENT>`，须绑定当前应用和环境 |
| `media_origins` | Cloud 私密媒体的 HTTPS Origin 白名单，不提供任意 URL 代理 |

Cloud Web Client 须登记精确回调 `https://hetu.limeai.run/api/hetu/auth/callback`，启用 Code + PKCE S256、`client_secret_basic`，按正式合同提供 `openid profile models.read models.generate models.images.read models.images.generate` 及对应 `lime_product` 资源。部署方需填写真实登记值，装配 D1 和 Secret 后部署；仓库不包含凭据或线上资源 ID。

“订阅与额度”通过独立的 `lime_product` 会员授权，申请 `openid profile commerce.membership.read`；回调绑定原网站会话和同一用户，服务端保存加密Token并读取正式 Commerce 本人会员接口。页面只返回方案、周期和额度，不下发Cloud Token。支付及订阅变更进入经校验的 Cloud 托管订阅页，在那里核对商品、金额及支付模式；返回河图后刷新会员，跳转不表示支付成功。客户端和 Agent 不执行支付。

会话有效期为Cloud Token有效期与一小时的较小值，过期重新连接；会员授权不延长原会话。同账号、环境可恢复原计划。服务端在线核验 UserInfo 的本人、Client、应用、环境、Audience 和撤销状态；网络超时仅查询原键。图片只使用临时生成，首版不上传参考图。Cloud 当前文字目录合同最多一个模型，超出时明确报合同不一致。作者自定义渠道在本机 Core 执行，不经过网站或使用平台额度。

## 发布

以已登录的 Cloudflare 账号执行：

```bash
npm run deploy:website
```

发布到 `hetu-website` 的生产 `main` 分支。配置由本目录 `wrangler.jsonc` 维护；域名、验证和恢复合同见[网站部署规范](../../docs/33-宣传网站与部署.md)。
