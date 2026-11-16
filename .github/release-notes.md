河图洛书 v0.9.0 使用 Electron＋TypeScript 插件宿主＋Rust Core，沿用 Mac 正式应用标识 `run.limeai.hetu`。

- 移除 Swift/SwiftUI 原生客户端、Swift CLI、C ABI 桥接及专属构建测试。
- 修复基础样式缺失导致的启动页布局异常，保留完整创作库、作品工作面和浅暗主题。
- 更新机器能力地图、精确作品授权、导入与原操作恢复、本机设置及插件安装管理。
- 共享双语词库独立维护；Apple 签名、公证和恢复保护继续执行。
- GitHub Actions 分别在 macOS arm64、Windows x64、Linux x64 构建、测试并打包，全部通过后统一发布。
- 更新安装、构建、开发与验收文档；开发版使用 `run.limeai.hetu.dev`，本机安装包与官方发行包分别标识。

下载与安装：

- macOS 14+ Apple Silicon：打开 DMG，将 `Hetu.app` 拖入“应用程序”，或解压 ZIP。Mac 包经过 Developer ID 签名、Apple 公证与 Gatekeeper 检查。
- Windows 11 x64：解压 `windows-x64.zip`，运行 `Hetu.exe`。Windows 包未做代码签名。
- Linux x64：解压 `linux-x64.tar.gz`，运行目录内的 `./Hetu`。构建基线为 Ubuntu 22.04，需要桌面图形环境与 Electron 运行库；Linux 包未签名。

每个平台附带固定源码、文件摘要和签名状态的发行清单。解压时保留包内完整目录，CLI、MCP、App Server 及 Node 均随包提供。

覆盖应用不删除作者作品；作品继续从原目录打开。干净系统、发行版兼容、Intel Mac和完整视频制作等验收范围见仓库测试矩阵与执行计划。
