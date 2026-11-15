> 本组件属于 [河图洛书](../../README.md)，全局信息见根 README。

# @limecloud/hetu

为外部 AI Agent 提供 `hetu` CLI 与 `hetu-mcp` Server，业务由河图共享原生内核执行。支持 macOS 14+ 的 Apple Silicon Mac，启动器需要 Node.js 22.12+。

```bash
npm install -g @limecloud/hetu
hetu --version
hetu --client codex collaboration inspect
hetu-mcp --client codex
```

也可使用 `npx --package @limecloud/hetu hetu --client codex collaboration inspect`。首次调用将版本一致的官方 `Hetu.app` 复制到私有缓存，或从 GitHub Release 下载精确版本，校验 SHA-256、官方签名与 Apple 公证后完成原子安装。运行时位于 `~/Library/Caches/Hetu/npm/`；后续调用读取安装回执并直接启动。该目录沿用本机账号权限保护，请勿修改其中的运行时与回执。不要求桌面窗口运行；npm 安装阶段不联网下载运行时，不在本机编译。

MCP 客户端可将命令配置为 `npx`，参数为 `--yes --package @limecloud/hetu hetu-mcp --client codex`。其他客户端使用其实际适配器名称，见[接入合同](../../docs/14-MCP与Agent接入.md)。启动诊断写入 stderr，stdout 保留给原生 CLI／MCP；原生参数、stdin、退出码与取消信号直接转发。

可选环境变量 `HETU_APP_PATH` 指向精确版本的官方 `Hetu.app`；指定路径同样必须通过身份、版本、签名及公证检查。模型渠道配置、任务授权和作者确认沿用河图原生合同。

平台模型连接使用 `hetu model-service login` 取得验证链接和验证码，作者在浏览器核验并连接后，用 `hetu model-service poll` 查询原连接；`hetu model-service status` 查看本机状态。登录无需作品，不返回凭据，也不代表批准生成费用。
