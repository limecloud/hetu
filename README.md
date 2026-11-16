# 河图洛书 Hetu Luoshu

> 免费开源的本地小说、剧本与视频创作工作台。MCP、CLI、Skills 与原生界面并列为一等入口。

[English](README.en.md) / [官网](https://hetu.limeai.run) / [在线体验](https://hetu.limeai.run/#prototype) / [使用指南](https://hetu.limeai.run/docs/)

## 简介

从创作库分别进入小说、剧本和视频，也可以沿固定来源从原著继续改编、从剧本继续制作。河图洛书面向小说作者、编剧与短剧创作者，保存作品、设定、资料、修订和作者决定，让外部Agent的成果可阅读、观看、比较并继续创作。

**让越来越强的 AI，围绕作者持续积累的作品工作；让每一次生成，都有机会成为可理解、可选择、可继续创作的成果。**

**你的品味、判断与创意，始终是作品的中心。** 每位小说作者和编剧都有独一无二的表达，值得尊重。小说与剧本工程化让创作更系统、更可视，让创意更好管理；不以 AI 代替人的创作判断。详见[创作主张](https://hetu.limeai.run/blog/authors-at-the-center/)。

- **创作库**：小说、剧本、视频独立创建并按需关联，不要求先建小说或同属一个IP。
- **设定与原著**：维护人物、世界规则与时间关系，核对剧情和改编所用的原文依据。
- **参考稿与定稿**：比较方案、批注返工、局部采纳；审核、采纳与作者定稿分别确认。
- **制作与交付**：按需要预演，查看实际音画、提出位置意见，按固定版本组织成片与工程交付；[设计与重构计划](docs/38-创作工作台重构执行计划.md)。
- **本地优先**：作品保存在自己的目录，支持手工创作；软件开源不意味着作者作品公开。

外部 Agent 通过 Skills + CLI/MCP 围绕作品开展资料整理、创作和业务操作；河图洛书保存可查询、可操作、可恢复的作品事实。桌面客户端首先供作者阅读、观看、比较、审核与决定，其次供手动编辑优化。资料由 Agent 准备，作者把时间用于创作取舍。

| 入口 | 用途 |
| --- | --- |
| MCP | 在授权范围内查询作品与任务、提交候选、读取反馈；Server 可独立运行 |
| CLI | 发现工作区能力、调用受限动作、回读原操作结果 |
| Skills | 为作者选用的外部 Agent 提供题材方法与任务步骤 |
| 桌面客户端 | 优先审阅成果、比较差异与确认决定；随时手动编辑优化 |

这些入口共用内核、作品、权限与修订。通用 Agent 的推理、上下文管理、工具调度和执行恢复需要长期投入，Codex、Claude Code、WorkBuddy 等产品专注于此。河图提供它们可以操作的创作软件；可选文字与图片模型通过河图网站服务端连接 Lime Cloud，作者逐计划批准内容外发和费用。也可在本机配置自定义渠道，由 CLI／MCP 封装供外部 Agent 调用；密钥只保存在本机私密存储。不内置聊天或自动生成循环。

## 角色分流

- 开始写作 → [快速入门](https://hetu.limeai.run/docs/getting-started/)、[选择创作路径](https://hetu.limeai.run/docs/creative-paths/)。
- 使用外部 Agent → [接入指南](https://hetu.limeai.run/docs/agents/)、[Skills 选择与安装](https://hetu.limeai.run/docs/skills/)。
- 了解改编与创作方法 → [博客](https://hetu.limeai.run/blog/)、[市场与创作者价值研究](docs/research/12-故事改编市场与创作者价值研究.md)。
- 开发与维护 → [工程文档](docs/README.md)、[总体架构](docs/03-总体技术架构.md)、[Monorepo 规范](docs/04-Monorepo与开发规范.md)。

## 快速上手

### 下载与安装

从 [GitHub Release](https://github.com/limecloud/hetu/releases/latest) 下载 Electron Mac DMG 或 ZIP。支持 macOS 14 及以上的 Apple Silicon Mac；打开 DMG，将 `Hetu.app` 拖入“应用程序”。正式安装包经过 Developer ID 签名与 Apple 公证，随包提供 `SHA256SUMS` 和 `release-manifest.json`。发布流程与签名配置见[构建分发](docs/21-构建分发与运维.md#61-github-actions)。

### 源码构建前置条件

- Electron Mac 开发版：macOS 14+、Rust 1.93.1、Xcode Command Line Tools、Python 3、Node.js `>=25 <26` 与 npm；Node 安装须保留 `LICENSE`。
- 网站及本地任务页面：Node.js `>=24.21.0 <26` 与 npm。

以下命令均在仓库根目录执行。Rust 工具链由 `rust-toolchain.toml` 指定，依赖由锁文件固定。

### 一键构建并运行 Electron 客户端

```bash
./dev-mac.command --check
./dev-mac.command
```

也可在 Finder 中双击 `dev-mac.command`。脚本按需安装锁定依赖，构建共享任务页面并装配 Electron 独立开发应用，打开 `output/electron-packages/` 下本次生成的 `.app`，具体路径见终端输出。一键入口仅支持 Electron。`--check` 只检查工具链，`--build-only` 只构建；`--node-runtime` 可指定已有 Node 可执行文件。再次启动会激活已运行的 Electron 开发版，重新编译前先正常退出开发版。

在书库新建作品或打开已有作品目录。写作、设定与修改由作者管理，外部 Agent 按需参与。详细操作见[使用指南](https://hetu.limeai.run/docs/)。

### 运行网站

```bash
npm ci
npm run dev
```

访问 `http://127.0.0.1:4350`。网页演示使用示例作品，刷新后重置，不读取本地稿件。

### Electron 插件工作台源码入口

使用 Rust 工具链和 Node.js 25。创作库登记既有作品，并在刷新时接纳外部 Agent 新建的小说、剧本和视频。独立插件包由“创作插件”安装，作品权限另行授予。

```bash
npm ci
cargo build --locked -p hetu-app-server -p hetu-plugin-cli -p hetu-cli -p hetu-mcp
npm run build:desktop
npm run start:desktop
```

`npm run package:desktop` 装配独立开发应用，输出路径见命令返回的清单。插件开发合同、独立 CLI/MCP、隔离配置及测试命令见[插件开发入口](docs/plugin/20-首期可执行合同与开发入口.md)。

Electron 的非敏感偏好与所选创作方法通过“本机设置”审阅，CLI/MCP 复用独立本机服务。开发隔离可用 `HETU_LOCAL_SETTINGS_DIR` 指向绝对目录；模型渠道使用独立的 `HETU_MODEL_SERVICE_DIR`。桌面调试的 `HETU_DESKTOP_PROFILE` 同时隔离本机设置和模型渠道。套件资源来自 `integrations/catalog.json` 和 `integrations/codex/`，随开发应用装配；安装状态与当前外部 Agent 会话加载分别核对。

### 构建与测试

独立 Rust CLI 与 MCP 共用 Core，可单独构建和运行：

```bash
cargo build --locked --jobs 2 --package hetu-cli --package hetu-mcp
"target/debug/hetu" --client codex collaboration inspect
cargo test --locked --jobs 2 --package hetu-cli
```

CLI 参数与本机设置接入边界见[CLI 合同](docs/13-内核ABI与CLI合同.md)。

```bash
npm run check
npm run build
npm run test --workspace @hetu/website
python3 "tools/build-native.py" --test
```

网站测试所需浏览器见[网站说明](apps/website/README.md)，原生构建与分发见[构建规范](docs/21-构建分发与运维.md)。

GitHub Actions 的 `CI` 执行原生与网页测试；`macOS signed package` 从 `main` 手动构建签名、公证的 Mac 下载包，推送匹配版本的 `v*.*.*` 标签时构建并发布 GitHub Release。所需 Secrets 与制品下载方式见[构建规范](docs/21-构建分发与运维.md#61-github-actions)。

## 配置与接入

作品内容工作区与软件源码分开存放。外部 Agent 的客户端与题材 Skills 可在作品资料的“AI 协作”中选择，在“设置 → AI 协作”中管理默认客户端。

独立 MCP Server 为所选客户端提供稳定入口，每次业务调用使用作者给出的任务引用：

```bash
npm install -g @limecloud/hetu
hetu --version
hetu-mcp --client codex
```

npm 启动器需要 Node.js 22.12+，支持 macOS 14+ Apple Silicon。首次运行获取对应版本的官方运行时并验证摘要、签名和公证，无需打开桌面窗口。免安装调用和 MCP 配置见[启动器说明](packages/npm-cli/README.md)。原生随包工具的源码构建产物为 `build/native/bin/hetu` 和 `build/native/bin/hetu-mcp`；独立 Rust 构建产物位于 `target/debug/`。

MCP Server 的构建、权限与宿主配置见[MCP 接入规范](docs/14-MCP与Agent接入.md)；CLI 参数见[CLI 合同](docs/13-内核ABI与CLI合同.md)；插件、Skills 与 MCP Apps 见[Agent 集成说明](docs/27-Agent与Codex插件集成设计.md)。外部 Agent 自身的模型账号由其客户端管理。河图可选模型服务可用 `hetu model-service login` 取得网站验证入口，完成后运行 `hetu model-service poll`，状态用 `hetu model-service status` 查询；也可在“设置 → 模型服务”连接网站账号，或添加 HTTPS 自定义渠道、密钥和文字／图片模型代码。设置页面只配置服务。河图作为应用在 Cloud 登记，Cloud Console 的应用入口打开河图网站自有 `/console/`；页面及河图功能由本项目提供，服务端消费 Cloud 开放平台，账号与费用复用平台能力。接入配置见[网站说明](apps/website/README.md)；自定义渠道凭据不进入作品或 Agent 返回。

## 部署说明

官网与河图控制台位于 `apps/website/`，静态产物位于 `apps/website/dist/`，模型接入由同目录 Pages Functions 提供；网站不承担作者工作区的存储或代理。发布配置见 `apps/website/wrangler.jsonc`，操作见[网站部署说明](docs/33-宣传网站与部署.md)。

## 边界

- 一致性检查核对有证据的事实与结构，复杂人物动机和文学表达由作者判断。
- 参考稿审核不覆盖正文；采纳与定稿是独立的作者操作。
- 作品权限约束河图受管入口，不能限制其他拥有同级文件权限的程序。
- 外部 Agent 和生成服务有各自的费用与条款；拍摄、外部生成、剪辑与发行由所选工具和团队完成。

## 协作方式

提交问题时说明使用场景、复现步骤、工具版本与预期结果，使用演示资料并移除私人稿件和凭据。贡献代码前阅读 `AGENTS.md` 和[文档入口](docs/README.md)，按变更范围运行对应检查，保留无关改动。

软件采用 [Apache-2.0](LICENSE) 许可证。作者作品、外部参考资料与素材保留各自权利，详见[许可说明](docs/22-插件生态开源许可与商业化.md)。
