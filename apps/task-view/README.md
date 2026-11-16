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

构建输出为 `apps/mcp/resources/task-view.html` 与同目录的 `task-view.manifest.json`。产物与源码摘要一起入库，直接编译 Rust 内核和独立 MCP 不需要 Node.js，也不在作者机器上安装前端依赖。修改前端源码后须先重新构建；Electron构建入口核对产物摘要，随包提供独立Node.js runtime。

本地宿主输出到 `apps/task-view/resources/local/`，包含固定页面、AppBridge、Node.js服务、许可与摘要清单，用于本地桥接的隔离测试。Electron直接装配同源任务面板；普通编辑和独立MCP不启动本地页面服务。Node服务只接受可信父进程的私有stdio配置，不能从公开命令行指定作品路径或作者身份。

页面会话失效时清空任务内容；已保存意见保留在原任务中。实际宿主接入与权限由各宿主能力和当前连接决定。

## 交互边界

- 任务连接且宿主声明 Apps MIME 能力时，`hetu_open_task_view` 关联 `ui://hetu/task-view/1`；无 Apps 能力时保留同一工具的数据结果。
- 面板只读取绑定任务、保存偏好与查询原操作。正式正文、设定、封面选用及定稿由作者在可信桌面端确认。
- HTML 内置脚本、样式和第三方许可，不加载外部 CDN，不申请设备或剪贴板权限。封面缩略图由 Core 核验、解码和等比缩放，以本机数据展示。
- 保存结果未确认时保留原操作键，先查询原回执。任务变化时保留未保存意见，作者显式读取最新结果后重新比较。
- 普通浏览器直接打开该 HTML 不获得业务访问权；Node.js 配对页面使用独立的传输与会话合同。

协议与授权见[接入规范](../../docs/14-MCP与Agent接入.md)。自动化桥接与stdio集成测试不替代 Codex、WorkBuddy 等指定版本宿主的实机兼容验收。
