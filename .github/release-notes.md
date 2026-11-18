河图洛书 v0.12.1 支持专业插件的本地派生音视频预览。

- 插件工作面可播放经完整文件核验的本地Blob媒体，确定性混音可以直接试听。
- 固定作品素材仍使用受管媒体入口；不增加网络、任意本机文件或脚本权限。
- 保留稳定CLI/MCP的精简发现、分块回读与原操作恢复。

下载与安装：

- macOS 14+ Apple Silicon：打开 DMG，将 `Hetu.app` 拖入“应用程序”，或解压 ZIP。Mac 包经过 Developer ID 签名、Apple 公证与 Gatekeeper 检查。
- Windows 11 x64：解压 `windows-x64.zip`，运行 `Hetu.exe`。Windows 包未做代码签名。
- Linux x64：解压 `linux-x64.tar.gz`，运行目录内的 `./Hetu`。构建基线为 Ubuntu 22.04，需要桌面图形环境与 Electron 运行库；Linux 包未签名。

每个平台附带固定源码、文件摘要和签名状态的发行清单。解压时保留包内完整目录，CLI、MCP、App Server 及 Node 均随包提供。

覆盖应用不删除作者作品；作品继续从原目录打开。干净系统、发行版兼容、Intel Mac和完整视频制作等验收范围见仓库测试矩阵与执行计划。

- 修正大能力清单的中文跨管道分块解码，保持发现、摘要与实际调用一致。
