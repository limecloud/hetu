# 河图洛书 Hetu Luoshu

> 让 AI 围绕你的作品持续创作。面向小说、剧本与叙事视频的本地创作工作台。

[English](README.en.md) / [官网](https://hetu.limeai.run) / [在线体验](https://hetu.limeai.run/#prototype) / [使用指南](https://hetu.limeai.run/docs/)

## 简介

从一个片段、一部小说或一份剧本开始。你决定作品方向，熟悉的 AI 推进具体工作；稿件、设定、素材和修改意见围绕同一作品接续。河图洛书面向小说作者、编剧与短剧创作者，保存作品、设定、资料、修订和作者决定，让外部Agent的成果可阅读、观看、比较并继续创作。

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
| MCP App | 在支持的宿主内使用同一工作台阅读、编辑、比较和审核，直接打开本机登记作品 |
| CLI | 按需发现能力、只读诊断版本、调用受限动作、分块回读原操作与恢复任务 |
| Skills | 为作者选用的外部 Agent 提供题材方法与任务步骤 |
| 桌面客户端 | 选择已安装引擎，在内嵌终端表达目标；在作品旁阅读、比较、提意见与作决定，随时手动编辑 |

桌面终端在创建面板中选择本机Shell、Codex、Claude Code、Gemini CLI或OpenCode，创建后直接连接PTY。引擎使用各自本机安装与认证，模型按实际发现能力选择；Codex可在聊天和终端间切换并恢复原线程，其他原生CLI在终端中管理模型与会话。终端字体、字号、主题和滚动设置位于“设置 → AI协作”。具体交互见[会话工作面](docs/10-原生客户端与交互设计.md#codex-会话工作面与设置)。

稳定 MCP 默认使用精简工具目录，通过 `hetu_call_action` 调用已发现动作；需要完整目录可使用 `hetu-mcp --client codex --all-tools`。CLI 使用 `hetu --client codex doctor` 查看运行与随包方法版本。接入、分块读取和任务接续见[机器合同](docs/13-内核ABI与CLI合同.md#机器发现诊断与有界恢复)。

在河图的“设置 → AI协作”中展开“外部客户端、MCP App与Skills接入”，“安装到 Codex Desktop”分别提供“安装 MCP App”和“安装 Skills 套件”。确认固定安装方案后由河图完成安装，再刷新或重启 Codex Desktop。MCP App 与桌面使用同一创作库和工作台，点击已登记作品直接进入阅读与编辑，无需逐作品授权或复制接入请求。采纳、定稿等决定仍展示固定结果并确认；外部 Agent 的机器范围独立管理。安装登记与当前 GUI 已加载分别显示。

这些入口共用内核、作品、权限与修订。通用 Agent 的推理、上下文管理、工具调度和执行恢复需要长期投入，Codex、Claude Code、WorkBuddy 等产品专注于此。河图提供它们可以操作的创作软件；可选文字与图片模型通过河图网站服务端连接 Lime Cloud，作者批准内容外发与任务费用范围。也可在本机配置自定义渠道，由 CLI／MCP 封装供外部 Agent 调用；密钥只保存在本机私密存储。推理与工具循环由所选Agent引擎负责，Core负责获权作品操作；外部MCP App与独立桌面的职责见[双入口设计](docs/27-Agent与Codex插件集成设计.md#11-双入口协作)。

## 何时使用

需要跨会话接续作品、固定修改依据、比较方案或组织交付时使用河图。临时问答、起名和试一句对白，当前 Agent 与普通文件足够时直接完成；查询已有作品只读即可。无需先建完整设定、大纲或导入全部资料。

## 角色分流

- 开始写作 → [快速入门](https://hetu.limeai.run/docs/getting-started/)、[选择创作路径](https://hetu.limeai.run/docs/creative-paths/)。
- 使用外部 Agent → [接入指南](https://hetu.limeai.run/docs/agents/)、[Skills 选择与安装](https://hetu.limeai.run/docs/skills/)。
- 了解改编与创作方法 → [博客](https://hetu.limeai.run/blog/)、[市场与创作者价值研究](docs/research/12-故事改编市场与创作者价值研究.md)。
- 功能 Review 与 AI 导航 → [MCP／CLI／Skills 能力地图](docs/40-机器能力地图与Review清单.md)、[机器可读索引](contracts/capability-map.json)。
- 开发与维护 → [工程文档](docs/README.md)、[总体架构](docs/03-总体技术架构.md)、[Monorepo 规范](docs/04-Monorepo与开发规范.md)。

## 快速上手

### 下载与安装

从 [GitHub Release](https://github.com/limecloud/hetu/releases/latest) 下载对应平台的 Electron 包：

- macOS 14+ Apple Silicon：打开 DMG，将 `Hetu.app` 拖入“应用程序”，或解压 ZIP。应用经过 Developer ID 签名与 Apple 公证。
- Windows 11 x64：解压 Windows ZIP，运行 `Hetu.exe`。当前包未做代码签名。
- Linux x64：解压 Linux `tar.gz`，运行目录内的 `./Hetu`。构建基线为 Ubuntu 22.04，需系统图形环境与 Electron 运行库；当前包未签名。

各平台附带 SHA-256 校验文件和发行清单。发布流程、平台验收范围与签名配置见[构建分发](docs/21-构建分发与运维.md#61-github-actions)。

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

小说、剧本和视频的基础工作面随应用提供，无需额外安装创作插件；专业插件用于扩展规划、检查和制作能力。分层与默认产品验收见[架构说明](docs/39-Electron与插件优先重构架构.md#无额外插件的基础产品)。

使用 Rust 工具链和 Node.js 25。创作库登记既有作品，并在刷新时接纳外部 Agent 新建的小说、剧本和视频。独立插件包由CLI／MCP或“创作插件”安装，作品权限另行授予。

```bash
npm ci
cargo build --locked -p hetu-app-server -p hetu-plugin-cli -p hetu-cli -p hetu-mcp
npm run build:desktop
npm run start:desktop
```

`npm run package:desktop` 装配独立开发应用，输出路径见命令返回的清单。插件开发合同、独立 CLI/MCP、隔离配置及测试命令见[插件开发入口](docs/plugin/20-首期可执行合同与开发入口.md)。

河图专业插件安装在河图，外部Agent经稳定机器入口动态发现与调用，无需逐包安装Codex插件。数据格式与热插拔合同见[核心格式与动态能力发现](docs/plugin/21-核心格式与动态能力发现.md)。

Electron 的非敏感偏好与所选创作方法通过“本机设置”审阅，CLI/MCP 复用独立本机服务。开发隔离可用 `HETU_LOCAL_SETTINGS_DIR` 指向绝对目录；模型渠道使用独立的 `HETU_MODEL_SERVICE_DIR`。桌面调试的 `HETU_DESKTOP_PROFILE` 同时隔离本机设置和模型渠道。套件资源来自 `integrations/catalog.json` 和 `integrations/codex/`，随开发应用装配；安装状态与当前外部 Agent 会话加载分别核对。

“AI 协作”中的“焦点随鼠标移动”默认关闭，对应共享设置 `preferences.agent_session.terminal_focus_on_hover`；开启后鼠标进入在线终端时聚焦输入，查找、表单和弹窗保留焦点。

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
npm run test:authoring --workspace @hetu/desktop
cargo test --locked --workspace --jobs 2
```

网站测试所需浏览器见[网站说明](apps/website/README.md)，Electron 构建与分发见[构建规范](docs/21-构建分发与运维.md)。

GitHub Actions 的 `CI` 执行 Electron、Rust 与网页测试；`Electron release` 从 `main` 手动构建三平台下载包，推送匹配版本的 `v*.*.*` 标签时，在全部平台验证通过后发布 GitHub Release，再发布同版本 `@limecloud/hetu` 到 npmjs。Mac 包执行签名与公证。发布凭据与制品下载方式见[构建规范](docs/21-构建分发与运维.md#61-github-actions)。

## 配置与接入

终端自动查找已安装的客户端。需要指定入口时，可设置`HETU_CODEX_BIN`、`HETU_CLAUDE_CODE_BIN`、`HETU_GEMINI_BIN`、`HETU_OPENCODE_BIN`或`HETU_SHELL_BIN`，值为本机可执行文件路径。

作品内容工作区与软件源码分开存放。外部 Agent 的客户端与题材 Skills 可在作品资料的“AI 协作”中选择，在“设置 → AI 协作”中管理默认客户端。

独立 MCP Server 为所选客户端提供稳定入口，每次业务调用使用作者给出的任务引用：

```bash
npm install -g @limecloud/hetu
hetu --version
hetu-mcp --client codex
```

npm 启动器需要 Node.js 22.12+，支持 macOS 14+ Apple Silicon。首次运行获取对应版本的官方运行时并验证摘要、签名和公证，无需打开桌面窗口。免安装调用和 MCP 配置见[启动器说明](packages/npm-cli/README.md)。Electron 随包工具位于 `Contents/Resources/bin/`；独立 Rust 构建产物位于 `target/debug/`。

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
