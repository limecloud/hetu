# 内核 ABI 与 CLI 合同

ABI 主版本为 `1`，领域 Schema 为 `1.0.0`；CLI／MCP 公开结果采用 AXI `0.2.1` 及逐动作合同修订。应用动作与签名见[30](30-应用API详细设计.md)。

## 1. C ABI 边界

C++ 内核通过 `extern "C"` 提供不透明上下文／任务句柄、显式长度 UTF-8 缓冲和定长整数。初始按 JSON 用例请求保持桥接简单，性能原型证明存在瓶颈后再为热路径增加专用接口；不导出整个 C++ 对象模型。

最小接口族：

| 接口 | 语义 |
| --- | --- |
| `hetu_abi_version` | 查询 ABI 与兼容范围，不打开项目 |
| `hetu_context_open / close` | 绑定工作区、入口身份与授权上下文 |
| `hetu_request` | 执行有界同步查询，返回结果缓冲 |
| `hetu_task_start / poll / cancel / release` | 长任务、进度、取消及生命周期 |
| `hetu_buffer_free` | 释放 Core 分配的输出缓冲 |

正式头文件需固定调用约定、导出宏、结构尺寸、所有权、线程与空指针行为。所有导出函数捕获异常并映射稳定错误；内存不足也不能跨 ABI 抛出。长度使用明确宽度并检查溢出，不暴露 STL、`bool` 布局、C++ 引用或平台 `long`。

上下文不允许任意线程并发写同一对象；任务查询和取消的线程安全语义在头文件明确。关闭上下文先停止接收任务，收敛或保留持久操作，再释放资源；不可释放仍在被调用方使用的缓冲。

## 2. 用例请求与结果

请求由版本、方法、参数、预期输入修订与操作键构成。身份由可信入口组装，不从业务 JSON 接收 `is_author=true` 或 `approved=true`。CLI JSON 与 MCP structuredContent 采用同一 AXI 结果投影；内核内部错误类型不直接泄漏为第二套公开封装。

```json
{
  "spec_version": "0.2.1",
  "kind": "result",
  "action": "hetu.drafts.submit",
  "contract_revision": "1",
  "status": "blocked",
  "context": {
    "scope_id": "workspace_33333333-3333-4333-8333-333333333333"
  },
  "error": {
    "code": "revision_conflict",
    "message": "输入版本已变化，请读取当前版本后比较。",
    "resolution": {"kind": "read", "action": "hetu.documents.get"}
  }
}
```

公开状态为 `succeeded|pending|blocked|failed|partial|cancelled|unknown`；“待作者批准”放在 `data.approval_state`，不新增 AXI 顶层枚举。异步任务身份放在 `data.task_id`，原操作放在 `operation`。报告含问题仍可任务成功；工具执行失败与作品存在冲突是两种不同结果。

内核错误短名按下表管理；公开 AXI 错误优先复用其标准码，其余使用 `hetu.` 命名空间，例如 `hetu.blueprint_locked`。`operation_unknown` 对外映射 `result_unknown` 并提供原操作恢复动作。AXI 为本团队草案，不是 MCP 官方标准，采用映射和证据见[27](27-Agent与Codex插件集成设计.md)。

## 3. 错误分类

| 错误码 | 含义与处理 |
| --- | --- |
| `invalid_input, schema_unsupported` | 纠正参数或使用匹配版本，不自动改写数据 |
| `permission_denied, capability_unavailable` | 展示授权或平台限制，不隐式提权 |
| `workspace_busy, recovery_required` | 等待占用结束或恢复原事务 |
| `revision_conflict, stale_evidence` | 重新读取并比较，原确认不可复用 |
| `blueprint_locked, author_confirmation_required` | 需要作者在可信入口操作 |
| `path_out_of_scope, unsafe_path` | 目标不合法，不能用相对路径变体绕过 |
| `io_failure, integrity_failure` | 保留原数据与损坏证据 |
| `budget_exceeded, cancelled` | 明确已覆盖范围与是否已产生持久结果 |
| `git_conflict, non_fast_forward, authentication_failed` | 回到 Git 审阅或凭据流程 |
| `operation_unknown` | 查询原操作并核对副作用，不能自动重试 |

## 4. Swift 跨平台 CLI

CLI 使用一套 Swift 源码，负责参数、帮助、能力发现、交互和 JSON 编解码，通过共享 Swift Bridge 调用 C ABI。领域规则、持久化、Git 与 Bundle 不在 Swift 重写。可优先评估 Swift ArgumentParser，依赖版本及 Windows 可构建性在 M0 冻结。

使用 Foundation 的跨平台子集；POSIX `/dev/tty`、Darwin 信号与 `isatty` 不能直接当作 Windows 行为。终端适配分别处理 POSIX TTY／信号和 Windows Console／Ctrl+C、UTF-8、非交互 stdin 与重定向。命令表、Schema 和退出码保持一致。

Windows 原生编译产出 `hetu.exe`，macOS 产出 `hetu`，分别构建和签名；不是一个二进制通吃。Windows 必须打包所需 Swift runtime、C ABI DLL 及其依赖，在无 Swift／Xcode／.NET／GUI 的干净用户环境独立运行。Linux 作为后续 CLI 目标，不计 V1 桌面支持。

M0 必须验证双端：SwiftPM → C ABI → C++ 工作区读写、中文／空格路径、JSON 管道、TTY 确认、取消、崩溃后原操作查询、凭据接口和无开发环境启动。未通过前该方案是目标选择，不能宣传已支持 Windows。MCP 不嵌入 CLI 进程，继续使用独立 C++ Server。

## 5. CLI 命令面

| 命令组 | 目标能力 | 副作用 |
| --- | --- | --- |
| `hetu capabilities` | 平台、合同、参数和可用性发现 | 只读 |
| `hetu workspace init/open/inspect` | 创建、检查与打开 | init 写入新目录 |
| `hetu blueprint show/edit/lock/unlock` | 作者设定集维护 | edit／lock／unlock 需可信作者入口 |
| `hetu document list/show/save` | 修订与正文管理 | save 创建修订并 CAS 更新 |
| `hetu draft submit/list/show` | 提交、查询草稿 | submit 仅写草稿 |
| `hetu plot extract` | 对已有修订提取节点 | 可选保存派生结果 |
| `hetu drama skeleton/compare` | 骨架与原著比较 | 保存候选，不覆盖定稿 |
| `hetu validate` | 校验与覆盖报告 | 可选保存报告 |
| `hetu review list/show/decide` | 人工审核与批注 | decide 需作者确认 |
| `hetu git status/diff/log` | 版本观察 | 只读 |
| `hetu git snapshot/branch/switch/merge/fetch/pull/push` | 本地和远端协作 | 按具体目标确认 |
| `hetu bundle preview/export/verify` | 交付选集、导出与摘要检查 | export 创建新包 |
| `hetu operation show` | 原操作状态和恢复证据 | 只读 |

参数、帮助与能力发现由同一正式合同生成。CLI 支持无桌面进程的核心人工闭环，Agent 会话不得借 CLI 获取作者权限。

## 6. CLI 输出与交互

`--json` 的 stdout 只有一个 UTF-8 结果对象，诊断与进度写 stderr；长任务可显式选择 NDJSON 事件流，每条有类型与任务 ID。默认人类输出可本地化，JSON 字段和错误码不本地化。

`--locale zh-CN|en` 控制帮助和人类消息，默认 zh-CN；语言切换不影响作品内容、动作名和机器字段。完整规则见[31](31-国际化与中文体验.md)。

退出码：`0` 成功，`2` 输入错误，`3` 权限或确认缺失，`4` 冲突／过期，`5` I/O／完整性／执行失败，`6` 部分或取消，`7` 未知副作用，`8` 不支持。作品诊断有 error finding 时 `validate` 可用独立的 `--fail-on` 规则返回非零，报告仍需正常输出，不伪装为引擎崩溃。

无交互终端且没有可信作者确认的高风险操作返回 `author_confirmation_required`。不存在模型可传入的通用 `--yes`、假审核人或万能批准布尔值。操作确认与工作区授权、系统文件权限分别管理。
