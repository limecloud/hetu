> 本组件属于[河图洛书](../../README.md)，全局信息见根 README。

# 任务局部交互

本组件提供 MCP Apps 的参考方案比较面板及按需本地页面。页面通过官方 `@modelcontextprotocol/ext-apps` SDK 与宿主交互，支持书名／简介／大纲比较、局部改稿差异、封面预览及意见保存。界面提供中文和英文。

## 构建与检查

在仓库根目录使用根 `package.json` 声明的 Node.js 版本和已安装的 Rust 工具链：

```bash
npm ci
npm run build:task-view
npm run check --workspace @hetu/task-view
npm run test:task-view
```

测试使用 Playwright。可通过 `PLAYWRIGHT_EXECUTABLE_PATH` 指定本机浏览器；测试构建 `hetu-mcp` 与临时作品夹具，在浏览器沙箱中运行官方桥接并回读真实 stdio 保存结果。截图、跟踪和测试报告输出到根 `build/task-view/`。

构建输出为 `apps/mcp/resources/task-view.html` 与同目录的 `task-view.manifest.json`。产物与源码摘要一起入库，直接编译 Rust 内核和独立 MCP 不需要 Node.js，也不在作者机器上安装前端依赖。修改前端源码后须先重新构建；Mac 构建入口核对产物及源码摘要，并装配本机已有的 Node.js runtime。

本地宿主输出到 `apps/task-view/resources/local/`，包含固定页面、官方 AppBridge 宿主、同一 Apps HTML、Node.js 服务、许可与摘要清单。Mac 构建把该目录作为 SwiftPM 资源打包，并装配已有的受支持 Node.js runtime 及其许可；普通编辑和独立 MCP 无需启动 Node。Node 子进程只接受原生父进程的私有 stdio 配置，不能从命令行传入任意作品路径或作者身份。

在 Mac 改稿任务面板启动任务页面后，可在软件内打开或复制普通页面地址到 Agent 的本机浏览器。浏览器请求配对，作者在原生端核对六位码后批准。页面只查看此任务、保存偏好及查询原保存结果；停止页面、退出该任务视图或关闭任务即撤销旧访问。浏览器不可达本机回环地址时，使用原生任务面板或 MCP 文本结果。

## 交互边界

- 任务连接且宿主声明 Apps MIME 能力时，`hetu_open_task_view` 关联 `ui://hetu/task-view/1`；无 Apps 能力时保留同一工具的数据结果。
- 面板只读取绑定任务、保存偏好与查询原操作。正式正文、设定、封面选用及定稿由作者在原生端确认。
- HTML 内置脚本、样式和第三方许可，不加载外部 CDN，不申请设备或剪贴板权限。封面缩略图由 Core 核验、解码和等比缩放，以本机数据展示。
- 保存结果未确认时保留原操作键，先查询原回执。任务变化时保留未保存意见，作者显式读取最新结果后重新比较。
- 普通浏览器直接打开该 HTML 不获得业务访问权；Node.js 配对页面使用独立的传输与会话合同。

协议与授权见[接入规范](../../docs/14-MCP与Agent接入.md)。自动化桥接与原生 stdio 集成测试不替代 Codex、WorkBuddy 等指定版本宿主的实机兼容验收。
