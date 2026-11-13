# AXI 采用研究

资料版本日期：2026-11-13。来源为 AXI 0.2.1 规范与 Schema，公开入口为 [AXI 文档](https://limecloud.github.io/axi/)。源码与 Schema 来源以仓库相对路径和摘要标识，不依赖本机 checkout。

## 规范与参考来源

| 路径 | 用途 |
| --- | --- |
| `README.md` | 规范版本、参考代码与集成边界 |
| `content/specification/0.2.1/model.md`、`results.md` | 五种文档、封闭字段、effect 与证据状态 |
| `content/specification/0.2.1/recovery.md`、`discovery.md` | 原键／输入摘要、重放顺序、有界发现与修订 |
| `content/schemas/0.2.1/axi.schema.json` | result、error、context、operation 的真实 Schema |
| `content/develop/mcp.md` | AXI structuredContent 与 MCP 包装的区别 |
| `content/ecosystem/codex/plugins.md`、`interfaces.md` | 插件、桥接、原生扩展与宿主边界 |
| `content/ecosystem/mcp-apps.md`、`content/reference/adoption.md` | UI 不等于事实、采用与证据台账 |
| `content/ecosystem/claude-code/index.md`、`content/ecosystem/workbuddy/index.md` | 各宿主的 Skills、连接及浏览器边界，不从同名能力推导兼容 |

## 采用范围

河图洛书计划采用 AXI JSON result／page 与精确 action 元数据；业务状态、诊断、版本和格式继续由 Hetu Schema 拥有。封装字段包括 spec_version、kind、action、contract_revision、context、operation、data 与 error；不在顶层随意增加 operation_id 或 pending_approval 枚举。

恢复必须先重新授权并查原键，再对首次执行做 CAS；否则成功写入后的同键重放会因版本已变化而被误判。固定输入摘要需发布规范化规则和跨语言向量，幂等记录与事务效果一起保存。

错误优先复用 AXI 标准码；领域码命名空间为 `hetu.`。unknown 使用 result_unknown 与 recover 方向，不把没有查到记录自动解释为未发生外部副作用。

交互设计采纳同任务、同事实源：Skills 负责方法，MCP 提供动态能力，Apps／本地网页记录局部选择，Core 保存唯一决定。河图洛书的具体入口为软件准备任务、用户复制到所选客户端，生成只在客户端进行；按需 Node.js 页面是河图洛书自己的适配实现，不能把 AXI 的设计说明当作现成网页服务。

## 事实与限制

AXI 当前是本团队设计草案，不是 MCP 官方规范或行业认证。参考实现是本地审核例子，不能直接宣称已经提供河图洛书的 Server、Apps 和插件。Hetu 的采用清单需要逐项映射要求 ID、实现、正负例、制品与证据。

引入 Schema 时固定来源与摘要，保留许可归属，由共享合同生成消费者；河图洛书不维护改名复制的 AXI 规范或相邻路径运行依赖。
