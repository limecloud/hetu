河图洛书 v0.12.0 改进外部 Agent 的能力发现、长稿回读和任务接续。

- 稳定 MCP 默认提供 12 个工具，按需发现动作与 Schema，通过通用入口调用；完整目录模式和旧工具名继续核验原授权。
- 长稿、候选和原操作支持固定版本分块读取，MCP 回包有明确预算，写入成功后的大结果保留恢复输入。
- 新增只读 `doctor` 诊断与任务接续记录，支持冲突检测、关闭重开和原键恢复，保留作者采纳与定稿权。
- 45 套 Skills 方法更新至 0.3.10，中英文接入指南同步。
- GitHub Actions 在三平台正式运行时发布后发布 `@limecloud/hetu`，校验源码、版本、签名公证及 npm 包摘要。

下载与安装：

- macOS 14+ Apple Silicon：打开 DMG，将 `Hetu.app` 拖入“应用程序”，或解压 ZIP。Mac 包经过 Developer ID 签名、Apple 公证与 Gatekeeper 检查。
- Windows 11 x64：解压 `windows-x64.zip`，运行 `Hetu.exe`。Windows 包未做代码签名。
- Linux x64：解压 `linux-x64.tar.gz`，运行目录内的 `./Hetu`。构建基线为 Ubuntu 22.04，需要桌面图形环境与 Electron 运行库；Linux 包未签名。

每个平台附带固定源码、文件摘要和签名状态的发行清单。解压时保留包内完整目录，CLI、MCP、App Server 及 Node 均随包提供。

覆盖应用不删除作者作品；作品继续从原目录打开。干净系统、发行版兼容、Intel Mac和完整视频制作等验收范围见仓库测试矩阵与执行计划。

- 修正大能力清单的中文跨管道分块解码，保持发现、摘要与实际调用一致。
