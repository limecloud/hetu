河图洛书 v0.10.0 更新创作工作台与双语官网，继续使用 Electron＋TypeScript 插件宿主＋Rust Core。

- 创作库采用原创山水插画，工作台使用官网纸色、玉色与山水灰的浅暗渐变及半透明表面。
- 作品首页突出封面、已有资料与简介；封面候选、协作设置、卷章目录和版本信息按需展开。
- 精简重复说明及空资料占位，修复启动刷新和作品打开时序，保留未保存稿、作者决定与原操作恢复。
- 支持减少透明度与增强对比度时切换实色表面。
- 官网增加中英文插件中心、真实包详情、插件使用与开发发布指南、博客及 GitHub 收录入口。
- 插件贡献生命周期接入固定版本 Cordis；安装并启用后可通过公共 SDK 复用核心能力，保留业务决定、固定来源、CAS 与原操作恢复。外部 Agent 继续使用精确作品连接。
- 插件拥有独立工作面与返回入口，宿主提供交接、正文跳转及文件导出服务；小说目录统计与章节改名复用核心数据。
- 更新界面风格 Skill 与插件设计文档；完整 Cordis 运行时迁移、独立小说规划插件及 DSH 兼容仍按专项验收。
- GitHub Actions 分别在 macOS arm64、Windows x64、Linux x64 构建、测试并打包，全部通过后统一发布。
- Mac 正式应用沿用 `run.limeai.hetu`，开发版使用 `run.limeai.hetu.dev`；Apple 签名、公证和恢复保护继续执行。

下载与安装：

- macOS 14+ Apple Silicon：打开 DMG，将 `Hetu.app` 拖入“应用程序”，或解压 ZIP。Mac 包经过 Developer ID 签名、Apple 公证与 Gatekeeper 检查。
- Windows 11 x64：解压 `windows-x64.zip`，运行 `Hetu.exe`。Windows 包未做代码签名。
- Linux x64：解压 `linux-x64.tar.gz`，运行目录内的 `./Hetu`。构建基线为 Ubuntu 22.04，需要桌面图形环境与 Electron 运行库；Linux 包未签名。

每个平台附带固定源码、文件摘要和签名状态的发行清单。解压时保留包内完整目录，CLI、MCP、App Server 及 Node 均随包提供。

覆盖应用不删除作者作品；作品继续从原目录打开。干净系统、发行版兼容、Intel Mac和完整视频制作等验收范围见仓库测试矩阵与执行计划。
