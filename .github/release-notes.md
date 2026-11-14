河图洛书 v0.4.2 提供通过 Developer ID 签名和 Apple 公证的 Mac 安装包。

- 支持 macOS 14 及以上的 Apple Silicon Mac；下载 DMG 后将 `Hetu.app` 拖入“应用程序”。也可下载 ZIP 解压使用。
- 应用、独立助手和随包 Node.js 使用同一开发者团队签名；App 与 DMG 分别通过 Apple 公证、票据装订和 Gatekeeper 检查。
- 随下载提供 `SHA256SUMS` 和 `release-manifest.json`，记录版本、源码与最终文件摘要。
- 保留 v0.4.0 的作者书库、小说与剧本编辑、外部 Agent 协作和交付能力。作品目录独立于程序，升级前请备份重要作品。

本版提供 macOS arm64 安装包；Intel Mac 和 Windows 安装包不在本版范围内。软件不内置模型 API，外部 Agent 与宿主兼容分别验收。
