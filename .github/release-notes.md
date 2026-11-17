河图洛书 v0.11.1 为专业插件提供统一的固定成果二进制导出服务。

- 插件经公共 SDK 导出 PNG、GLB、ZIP、WebM 和 MP4；三维、图片与预演逻辑由插件维护。
- 宿主核验当前作品、固定修订、字节摘要、格式签名和 32MiB 预算，原子保存到作者选择的目标。
- 取消、错误或上下文变化保留原文件；导出不代表资产选用或成片认可。
- 同步插件合同与机器能力地图，继续提供 macOS arm64、Windows x64 和 Linux x64 包。

下载与安装：

- macOS 14+ Apple Silicon：打开 DMG，将 `Hetu.app` 拖入“应用程序”，或解压 ZIP。Mac 包经过 Developer ID 签名、Apple 公证与 Gatekeeper 检查。
- Windows 11 x64：解压 `windows-x64.zip`，运行 `Hetu.exe`。Windows 包未做代码签名。
- Linux x64：解压 `linux-x64.tar.gz`，运行目录内的 `./Hetu`。构建基线为 Ubuntu 22.04，需要桌面图形环境与 Electron 运行库；Linux 包未签名。

每个平台附带固定源码、文件摘要和签名状态的发行清单。解压时保留包内完整目录，CLI、MCP、App Server 及 Node 均随包提供。

覆盖应用不删除作者作品；作品继续从原目录打开。干净系统、发行版兼容、Intel Mac和完整视频制作等验收范围见仓库测试矩阵与执行计划。
