# 扩展接入步骤

供下一次新增TUI或结构化GUI时使用。下列路径从仓库根目录定位；当前能力以实际源码及所选引擎的公开协议为准，不把本轮结果扩成所有引擎的保证。

## 先核对能力，再选择适配层

| 能力 | 当前复用点 | 对接判断 |
| --- | --- | --- |
| 原生终端 | `ProcessSession`、`CodexTerminal`、xterm | CLI能够在真实PTY运行；普通stdout管道不能代替交互终端 |
| 结构化对话 | `AgentSessionAdapter`、`CodexSession`、`agent-chat.tsx` | 有公开的消息、工具事件、待答、取消及错误协议才声明GUI支持 |
| 模型目录 | `EngineCatalog` | 来自真实发现结果；不把硬编码选项或终端文字当动态目录 |
| 线程恢复 | 原生协议、`session-storage.ts`、`SessionLease` | 需原生线程标识与恢复语义；PTY屏幕回放只恢复显示 |
| GUI/TUI切换 | `CodexSession`、`codex-terminal-bridge.ts` | 需同一服务/线程的安全接管协议；无此能力时不能假装无缝切换 |
| 作品业务 | `prepareBusinessContext`、既有CLI/MCP、Core成果回读 | 配置能加载不等于实际作品动作可执行，必须验证原Owner保存与回读 |

引擎身份和启动参数由`contracts/external-ai/providers.json`唯一维护，`engines.ts`负责实际安装发现。Codex保留受管App Server；Claude流式、ACP和Pi RPC经已接通驱动提供GUI，其余CLI使用真实PTY。目录、安装和协议握手是三个证据层。Shell不承接创作请求。

例如“新增一个只有CLI的引擎”只需接入探测、会话路由、真实PTY及所需业务配置；“为已有引擎增加GUI”才涉及结构化协议和消息投影；“让两个表面接续原线程”还需证明原生接管与唯一输入权。不要将三个目标捆成每次接入的前置。

## 接入前固定最小能力合同

在本次实施记录中写清下面的实际结果，沿用现有研究和进度文件，不另建能力登记系统。未知能力先保持未知，不能由另一个引擎的成功推断。

| 核对项 | 需要的实际依据 |
| --- | --- |
| 引擎身份 | 可执行文件、版本、平台／架构、公开文档及采集日期；认证是否就绪单独核对 |
| 启动与传输 | 确切argv、工作目录、PTY或结构化协议；区分CLI客户端和后端服务的生死 |
| 表面与输入权 | TUI／GUI实际支持、线程身份、接管／停止回执、当前唯一输入者；独立会话不显示为同一线程 |
| 投递与恢复 | 请求或attempt身份、受理回执、未知状态的查询方式、原线程恢复和草稿范围 |
| 业务与工具 | 当前WorkRef、机器客户端身份、稳定CLI/MCP配置入口、工具回执及Core固定成果回读 |
| 生命周期与包体 | 隐藏／重开／关闭的语义、原生依赖、helper布局、安装后实际运行路径及验证平台 |

引擎的结构化GUI、外部宿主的MCP App和独立原生GUI是不同接入面：分别核对协议、宿主桥接或明确的嵌入接口。仅能启动一个GUI进程，不代表它已经嵌入河图，也不代表它与TUI共享线程。优先复用可用的公开协议；当前没有机器接口时保留明确限制，不用屏幕文本推导协议事件或成果。

## 新增原生TUI

1. 在`contracts/external-ai/providers.json`登记实际引擎身份、命令、别名、原生参数和协议；复用`engines.ts`展示与探测，同时核对`session-storage.ts`的持久化校验，以及`machineClient`到Core既有客户端身份的映射。沿`command-resolution.ts`核对可执行文件、解释器及平台后缀；命令与参数分开传递，支持含空格路径。不通过启动登录Shell或修改全局PATH来探测安装。还须检查Rust的`local_settings/suites.rs`安装入口：桌面探测成功不代表该入口选中同一命令。PATH中的失效脚本可继续探测后续候选；作者显式指定的入口失效时明确报错，不静默改选。
2. 复用`session-manager.ts`与`ProcessSession`创建、选择和关闭会话，按引擎需要添加确切argv。原生程序仍处理登录、首次信任及自己的交互，不从屏幕关键词推断已登录、已生成或已保存。
3. 需要作品能力时，复用`external-ai-launch.ts`及`acp-launch-preparation.ts`适配该引擎正式支持的MCP配置入口和本地指令文件。只写会话沙箱，保留作者原账号及全局配置；MCP连接绑定实际客户端和当前`WorkRef`。普通CLI启动、目录可见、工具可调用及业务回读分别核对。
4. 请求先保存在原会话草稿，终端就绪后才明确放入。复用`insertDraft/pasteDraft`的代次、草稿版本及字节/控制字符检查，bracketed paste不追加Enter。首次信任提示期间不自动粘贴。
5. 保留现有终端布局、偏好及目录/预览配合。折叠、最大化和系统全屏只改变工作面；重新fit并传递真实行列，不新建会话。隐藏工作面不停止PTY，明确关闭才停止原执行端。

分别验证工作面隐藏后重连、关闭终端后重开，以及应用退出后重启。当前`ProcessSession.load()`恢复本机会话记录和草稿，`start()`在旧进程不存在时启动新进程，`recover()`不执行引擎原生线程恢复。新引擎若支持resume，须在其适配器核对原生线程身份及实际恢复结果；不能把同一河图session_id或保留的屏幕当作进程、模型上下文仍连续的证明。

## 新增结构化GUI或双表面

先按所选版本的公开协议核对初始化、认证、消息ID、增量、工具开始/结束、待答、取消、历史分页、重连及恢复。能力不足时说明该限制，不通过终端文本抓取填补结构化事件。

适配器只负责协议和会话状态；共用`AgentSessionEvent`及现有GUI投影。原生item/turn ID保持稳定，输出增量不等于一个新消息。待答、失败、unknown可见，未完成工具不会因重连快照被标为成功。草稿及上下文附加沿既有版本机制保存，发送受理不清除期间新输入。

当前`session-manager.ts`将Codex路由到`CodexSession`，其他GUI路由到`ExternalAgentSession`和已接通协议，TUI路由到`ProcessSession`。为新引擎提供GUI时一并接入实际驱动、启动准备、版本门槛、创建校验和可用操作，不能只将`chat`设为true。已有会话ID及选择索引保持原义，不为统一命名重写作者历史。

切换表面前核对轮次状态及唯一输入者；只有旧执行端释放后才接管。适配器若缺少线程恢复或安全接管能力，应保持实际支持的单表面，不以另起进程、回放屏幕或复制聊天冒充原线程。跨引擎可继续同一作品任务，但各自线程及认证保持独立。

GUI的“作品成果”来自工具回执中的固定引用与Core核验，不能从助手结尾文本提取“已完成”就显示保存成功。多次修改同一对象保留原修订与历史，采纳和定稿仍由作品决定合同处理。

接入外部GUI的MCP App时，共用作品应用用例并按宿主实际能力显示复制、草稿和明确发送；`messages`、`drafts`及`directSend`分别传递，不能因支持消息就显示直接发送。每个面板通过正式打开入口获得自己的App会话，作品事实可以互通，面板session token不能相互复用；关闭一个面板不应由测试夹具误关另一面板的执行会话。

## 外部执行、Bots与电脑

无窗口执行复用`AgentSessions`和同一会话类；稳定CLI/MCP经私密会话宿主发送，不能再实现一套推理循环或PTY。先发现 `hetu.sessions.request`、`hetu.bots.request`、`hetu.computer.request`的实际Schema，再核对原WorkRef、客户端、代次和操作键。正常作品业务继续用Core原动作，不以电脑点击弥补机器接口。

Bot配置固定角色与执行选择；新会话保存完整配置和bot_ref，旧会话不随配置更新。新派发持有配置及执行策略锁，普通sessions写动作拒绝Bot会话。停止、中断及原operation在停用、配置变化或confirm时仍可用，未知输入不因停止变成未发送。

电脑适配仅执行固定原生程序，不接受任意脚本。观察不弹权限；窗口和安全输入分别核验。快照不缓存像素，MCP真实image块与JSON元数据分开传输；动作前重新确认窗口/元素，送达后独立回读。接管、恢复及下一动作的观察资格分开检查；未知目标围栏不得清除。

当前外部执行confirm写入没有可信决定交付通道，保持拒绝；不能把引擎工具批准当河图决定或自行切auto。新平台按实际helper和系统能力实现，不按macOS成功外推。

## 将问题定位到实际边界

| 现象 | 优先核对 |
| --- | --- |
| 点击没有反应 | 当前可见控件的disabled、焦点、`pointerdown/up/click`和宿主IPC；目录刷新不应锁住无依赖的交接 |
| 启动即退出 | 确切binary/argv、shebang解释器、实际cwd、退出码与stderr；不输出私有环境变量或完整作品正文 |
| 屏幕卡住/重复 | PTY是否活着、协议是否断连、输出sequence/generation、回放完成前是否误发终端查询响应 |
| 输入去了旧会话 | 当前session/thread、WorkRef、generation及表面输入权；异步剪贴板返回后重新核对 |
| 最后一行裁切 | 单份内边距、实际容器尺寸、字体加载、xterm行列及DPR；GPU回退只换渲染器 |
| GUI说已保存但目录无成果 | 原工具回执、Core操作状态、固定成果引用及原Owner回读；沿原操作恢复，不重发 |
| 开发可用而安装包失败 | Electron/Node与native addon的实际平台/架构/ABI、`node-pty`相对布局及`spawn-helper`执行位 |

`apps/desktop/scripts/pty-helper.mjs`已兼容源码编译和预构建布局，打包沿`apps/desktop/scripts/package.mjs`携带真实模块。新增依赖前先核对现有实现，避免为同一PTY再引入另一套native栈。

## 证据与完成边界

按[验证方法](validation.md)选择测试，实际覆盖：创建启动、输入/粘贴、窗口几何、隐藏后恢复、断连及旧代次、业务读取/保存/返工、Core回读、同版安装包。只提供TUI的引擎不硬跑GUI切换；不使用模型轮次证明纯布局行为。

可参考[真实TUI业务历史](../../../../docs/research/evidence/codex-tui-lifecycle-2026-11-23.json)、[GUI与接入经验历史](../../../../docs/research/evidence/embedded-agent-gui-2026-11-24.json)、[固定来源选择器历史](../../../../docs/research/evidence/context-picker-2026-11-25.json)及[双表面失败恢复历史](../../../../docs/research/evidence/session-switch-recovery-2026-11-25.json)。它们帮助定位曾验证的实现及失败原因，不能替代新引擎、新版本或其他平台的实际验收。
