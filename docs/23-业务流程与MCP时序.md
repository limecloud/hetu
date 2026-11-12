# 业务流程与 MCP 时序

本章描述系统职责、业务流程及成功与异常时序。精确字段以数据与 MCP 合同为准。

## 1. 系统上下文与整体架构

```mermaid
flowchart TD
    author["作者与编剧"] --> macApp["macOS 原生客户端 SwiftUI 与 AppKit"]
    author --> winApp["Windows 原生客户端 WinUI 3"]
    author --> swiftCli["跨平台 Swift CLI"]
    macApp --> cAbi["稳定 C ABI"]
    winApp --> cAbi
    swiftCli --> cAbi
    cAbi --> core["共享 C++ 应用内核"]
    agent["外部 Codex 或 WorkBuddy"] --> mcp["本地 C++ MCP Server"]
    mcp --> core
    core --> blueprint["设定集与作者锁"]
    core --> engines["规则抽取与一致性校验"]
    core --> review["草稿与人工审核"]
    core --> git["libgit2 版本管理"]
    core --> bundle["IP Bundle 与标准格式导出"]
    core --> workspace["独立 IP 内容工作区"]
    git --> remote["用户选择的 GitHub 或 Gitee"]
    author --> optionalPlugin["独立可选多媒体调度插件"]
    optionalPlugin --> provider["用户选择的第三方生成服务商"]
    optionalPlugin --> importReview["受限素材导入与审核"]
    importReview --> core
```

软件源码与内容工作区不同；图中插件为 P2，不是默认安装依赖。Server 可由宿主启动，不依赖 GUI 常驻，也不承诺宿主退出后 stdio 进程仍在运行。

## 2. 用户业务主流程

```mermaid
flowchart TD
    startNode(["开始"]) --> openWorkspace["新建或打开 IP 工作区"]
    openWorkspace --> chooseInput{"内容来自哪里"}
    chooseInput -->|"作者"| manualText["手工写作或导入已有稿件"]
    chooseInput -->|"已授权 Agent"| agentDraft["外部生成后提交草稿"]
    manualText --> candidates["发现人物与场景候选"]
    agentDraft --> candidates
    candidates --> authorChoice{"作者是否采纳建议"}
    authorChoice -->|"采纳"| editBlueprint["作者编辑设定集并按需锁定"]
    authorChoice -->|"保留现状"| keepBlueprint["保留当前设定集版本"]
    editBlueprint --> extract["从已有文本抽取并校正节点"]
    keepBlueprint --> extract
    extract --> skeleton["生成结构骨架并保留缺项"]
    skeleton --> fill["作者或外部 Agent 填写剧本草稿"]
    fill --> validate["校验结构与设定集并报告覆盖"]
    validate --> review["作者在原生端或受支持面板审核"]
    review --> decision{"审核决定"}
    decision -->|"要求修改"| fill
    decision -->|"驳回"| retainDraft["保留历史草稿和理由"]
    retainDraft --> fill
    decision -->|"通过"| approved["生成定稿修订"]
    approved --> chooseVersion{"是否创建 Git 快照"}
    chooseVersion -->|"是"| snapshot["确认确切范围后提交"]
    chooseVersion -->|"否"| exportPreview["选择标准格式与交付内容"]
    snapshot --> choosePush{"是否推送指定远端"}
    choosePush -->|"是"| push["另行确认并核对推送结果"]
    choosePush -->|"否"| exportPreview
    push --> exportPreview
    exportPreview --> bundle["导出并核验 IP Bundle"]
    bundle --> finishNode(["完成本次交付"])
```

纯手工路径无需模型、网络或 MCP Apps。驳回回路表示作者可以继续修改，不表示河图自动运行 Agent。

## 3. MCP 调用与草稿审核时序

```mermaid
sequenceDiagram
    actor author as 作者
    participant host as 外部 Agent 宿主
    participant server as Hetu MCP Server
    participant core as C++ 内核与存储
    participant desktop as 原生审核入口
    author->>host: 在既定授权范围内处理当前 IP
    host->>server: 协议发现与版本能力检查
    server-->>host: 支持的协议工具与资源
    host->>server: hetu_read_blueprint
    server->>core: 核验读取范围并取设定集快照
    core-->>host: 设定集修订摘要与锁状态
    host->>server: 读取授权原文资源
    server-->>host: 确切文档修订
    host->>server: hetu_extract_plot
    server->>core: 对已有文本做规则提取
    core-->>host: 节点候选来源与覆盖
    host->>host: 在外部 Agent 内部生成文本
    host->>server: hetu_write_draft 与原操作键
    server->>core: 查原键再校验首次写入前提
    core->>core: 保存不可变草稿并登记诊断任务
    core-->>host: 草稿与原操作引用
    desktop->>core: 查询草稿和诊断
    core-->>desktop: 当前输入版本覆盖与问题
    author->>desktop: 审阅后决定
    alt 作者通过且证据有效
        desktop->>core: 对固定版本记录通过
        core->>core: 事务写入定稿和审核记录
        core-->>desktop: 已定稿修订
    else 作者要求修改或驳回
        desktop->>core: 保存理由与批注
        core-->>desktop: 已记录审核结果
    end
    host->>server: 查询原草稿及审核资源
    server-->>host: 实际决定与允许读取的批注
```

2026-07-28 协议使用 `server/discover` 与每请求元数据；旧宿主若采用 legacy 初始化需单独适配和验收，不能在同一版本图里混用两套握手。资源变化通知不等于宿主自动继续生成。

## 4. MCP Apps 审核与回退

```mermaid
sequenceDiagram
    actor author as 作者
    participant host as 支持 Apps 的宿主
    participant app as 受限审核 App
    participant server as Hetu MCP Server
    participant core as 业务内核
    host->>server: 获取工具描述与 UI 资源
    server-->>host: UI 资源引用和结构化结果
    host->>app: 初始化受管桥接并交付获权数据
    author->>app: 查看差异与填写审核意见
    app->>host: 请求提交当前版本审核意图
    host->>server: 转发受允许调用
    server->>core: 核验身份范围和版本
    alt 具有已验证的作者交互与授权
        core->>core: 保存审核决定
        core-->>app: 经宿主返回已记录决定
    else 信任边界或宿主能力不足
        core-->>app: 返回待作者确认和原记录
        author->>core: 在可信桌面或 CLI 完成确认
    end
    host->>server: 按原对象回读结果
    server-->>host: 实际业务状态
```

Apps 关闭不取消业务任务，UI 保存成功不代表宿主已经发起下一轮对话。

## 5. 幂等与应答丢失恢复

```mermaid
sequenceDiagram
    participant client as CLI 或 Agent
    participant core as 应用内核
    participant disk as 工作区持久存储
    client->>core: 原键 K 与固定输入 I
    core->>disk: 加锁并查询原 K
    alt 原记录存在
        disk-->>core: 原输入摘要和结果
        core-->>client: 同输入返回原结果或异输入冲突
    else 首次请求
        core->>core: 校验当前权限修订及前置条件
        core->>disk: 同一事务保存业务效果与原操作
        disk-->>core: 提交完成
        core--xclient: 应答丢失
        client->>core: 按原键 K 查询
        core->>disk: 重新授权后读取原操作
        disk-->>client: 原回执与当前可观察结果
    end
```

## 6. 证据过期与定稿状态

```mermaid
stateDiagram-v2
    [*] --> submitted: 草稿持久化
    submitted --> inReview: 作者开始审阅
    inReview --> changesRequested: 要求修改
    inReview --> rejected: 驳回
    inReview --> approved: 证据有效且作者通过
    inReview --> staleReview: 设定集或源文改变
    staleReview --> inReview: 重算并重新审阅
    changesRequested --> superseded: 新草稿接替
    rejected --> superseded: 另起新草稿
    approved --> [*]: 保留批准修订
```

`staleReview` 为审核上下文状态，不是新增 Draft 持久状态；报告版本与草稿生命周期分开。

## 7. 标准格式交付流程

```mermaid
flowchart LR
    source["Markdown 小说与 Fountain 剧本"] --> parse["解析为带来源的叙事结构"]
    parse --> validate["校验结构引用与所选 profile"]
    validate --> complete{"满足正式交稿要求"}
    complete -->|"否"| gaps["列出缺项或生成标记清楚的审阅稿"]
    complete -->|"是"| render["生成 TXT DOCX PDF 等目标格式"]
    render --> inspect["格式检查与渲染核验"]
    inspect --> manifest["记录输入产物摘要与转换报告"]
    manifest --> bundle["打包 IP Bundle"]
```

## 8. Git 同步与冲突流程

```mermaid
flowchart TD
    status["检查 HEAD 工作树与未保存编辑"] --> preview["显示精确文件与目标分支"]
    preview --> confirm{"作者是否确认本次操作"}
    confirm -->|"否"| stop["保持原状"]
    confirm -->|"是"| recheck["锁内重新核对输入"]
    recheck --> changed{"输入是否变化"}
    changed -->|"是"| preview
    changed -->|"否"| action["执行快照或指定同步"]
    action --> result{"结果"}
    result -->|"明确成功"| receipt["保存实际提交与远端证据"]
    result -->|"冲突"| resolve["三方审阅并验证引用"]
    resolve --> preview
    result -->|"推送结果未知"| inspect["按原 ref 与 commit 核对"]
    inspect --> receipt
    inspect -->|"仍无法确认"| unknown["保留 unknown 及人工核对入口"]
```
