# 验证方法

按改动选择相关验证，既有通过且未受影响的范围不重复消耗模型轮次。Live测试有各自的环境和前置记录，先读脚本，不直接通配运行。

## 常用入口

从仓库根目录执行：

```bash
npm run build:desktop
npm run test:agent --workspace @hetu/desktop
npm run test:authoring --workspace @hetu/desktop
```

针对桌面用例，例如：

```bash
npm run test:e2e --workspace @hetu/desktop -- tests/agent-launch.spec.ts tests/agent-content.spec.ts
```

运行前核对测试使用的Core示例及二进制是否已构建。`shared-workbench.spec.ts`通过`HETU_ACCEPT_MCP_BINARY`选择机器制品，CLI和App Server从该二进制所在目录配套读取；隔离编译的两个示例可通过`HETU_ACCEPT_FIXTURE_DIRECTORY`指定，不能让安装版MCP混用另一份开发后端。`npm run test:plugins`会构建桌面、Rust助手并运行插件、Agent及视频意见恢复测试；视频恢复专项可用`npm run test:video --workspace @hetu/desktop`。根`npm run build`只构建官网。

核对专项确实消费了这些路径，不能仅凭环境变量已设置认定同源。桌面业务、媒体成果、首次打开、输入性能和共享视频恢复沿`apps/desktop/tests/acceptance-paths.ts`选择示例及机器二进制，保留Windows后缀；新增专项复用该入口，避免仍硬编码默认target目录而混入另一进程的制品。

开发版改用隔离制品时，同时核对创作库发现的CLI、正文读取的App Server与会话MCP。曾只替换App Server，默认target清空后作品始终禁用，字体专项尚未开始；应补齐测试实际启动环境中的配套入口，不能重试点击禁用作品或改产品的可用判断。包内验证则按安装目录解析，不继承开发覆盖值。

Node单元测试与Playwright E2E分别收集，后者使用`*.spec.ts`，避免把`*.test.ts`当作桌面用例执行。运行中的Playwright可能已加载旧测试源码；修复前置后先保留该轮结果，再启动新的定向或完整回归，不能用改过的行号误判旧日志。每轮使用独立输出目录，桌面测试运行期间不替换其构建产物。

共享React页面或样式变更时，冻结本轮源码后依次构建`npm run build:task-view`、嵌入资源的Rust消费者及用例所需fixture、桌面，再运行验收。只构建桌面不能证明独立MCP App资源已同步；也不能在MCP回归期间替换HTML或manifest，使旧二进制与新版磁盘资源混用。包内验收使用同一资源及源码摘要，旧包通过不覆盖后续增量。

桌面装配前复用Task View类型与资源复现检查；源码摘要同时覆盖其原始源码、构建脚本和本地页面制品，不能只登记最终HTML。主题验证同时覆盖继承宿主浅暗与显式白纸；以共享语义色板确定预期颜色，不从主题名称猜色值。

安装包清单与实际应用范围分开核对。macOS装配目录可能另含运行时解压生成的`__MACOSX`及同级文件，覆盖安装只复制`.app`；实际安装测试核对完整且非空的应用子树、全部文件／链接、图标和签名，不到`/Applications`寻找解压元数据。不得因这个夹具前置失败跳过应用本体核验或将业务失败改成通过。

长任务接续时，在新的安装验收前再次核对实际完整包体。曾先前记录为开发包，而当前路径实际已是公开签名发行；版本号相同也不能继续借用旧源码摘要。先保留覆盖被门禁拒绝的记录，按公开清单和签名识别现包，不确定替换时点就不将此前观察强归到某源码。明确当前包后才按原授权覆盖，新安装前后再次核对原用户索引；这不构成覆盖未知并行改动的许可。

## 按风险验证

| 改动 | 现有测试定位 | 必须观察的结果 |
| --- | --- | --- |
| 协议与会话 | `agent-session.test.ts`、`codex-session.test.ts`、`codex-terminal-bridge.test.ts` | 重复attempt不建第二轮，unknown不重发，错误线程/旧代次/并发占用拒绝，停止失败不显示完成 |
| 输出与输入 | `terminal-stream.test.ts`、`terminal-keys.test.ts`、`terminal-pty.test.ts` | 输出游标消重和缺段处理；原生PTY输入/尺寸；选择、粘贴、搜索不额外提交 |
| 随包原生PTY | `packaged.spec.ts`的Shell专项 | 从实际应用创建PTY，在原Shell内运行随包Node并回读真实行列；缩窗后行列变化，隐藏恢复保持原会话及代次，停止后旧输入拒绝。此测试不需要模型账号；每个平台分别运行，普通包体测试通过不替代本项 |
| 新引擎与业务配置 | `agent-engines.test.ts`、`agent-business.test.ts`、`creative-request.test.ts` | 模型来自真实能力，配置只在私有沙箱，跨作品迟到交接拒绝，只读/讨论不隐式写入 |
| 专业交接 | `professional-tools.test.ts`、`professional-tools.spec.ts`、MCP的`shared-workbench.spec.ts` | 方法只读不启动后端；目标变化拒绝迟到请求，包／能力摘要重新核对；实际专业动作经Core保存回读，unknown不重发且复制保留；仅草稿及无消息宿主准确降级 |
| 固定来源 | `agent-context.test.ts`、`agent-chat.spec.ts`、Core的`retained_plugin_results.rs` | 工作修订／批次／公开意见推进后旧引用保持，插件停用后稳定MCP可读取；异作、摘要错误、关闭任务和撤权拒绝，草稿保留 |
| 场次与视频来源 | `agent-structured-context.spec.ts`、`agent-context.test.ts` | 同名按集序／场序区分，长场次只附完整字节范围；搜索与分页、浅暗／窄窗、关闭后不继续读取、原失败步骤重试可用。改稿或改分集后重开保持旧引用，坏摘要零投递且保留草稿；协议夹具不等于真实模型或原生宿主验收 |
| 已有任务接续 | `agent-context.test.ts`、Task View的`feedback-continuation.spec.ts`与`real.spec.ts`图片专项 | 并发意见重读保留原话与区域；关闭重开仍固定旧意见，实际草稿不追加Enter；宿主unknown按意见保留，切换历史不变成可重发 |
| 工作稿与候选审阅 | Task View的`working-review.spec.ts`、`working-review-state.spec.ts`与`long-candidate.spec.ts` | 已保存而未提交的稿件仍可到达；固定历史、正文分页、原位置意见及同副本返工保持；目录重读保留选中名称，失败沿原游标／范围重试，关闭及切任务后迟到回包不复活旧阅读 |
| 跨入口执行 | `execution-mode.spec.ts`、Core的`execution_modes.rs` | CLI／MCP／桌面共享策略；集中确认、部分成功与CAS冲突、原方案重连恢复、成功修订不重复、同键异输入与篡改摘要拒绝 |
| 工作区专业执行 | `packages/plugin-host/tests/workspace-execution.test.ts`、Core的`execution_connection_tests` | auto无需管理授权；confirm动态只读／集中写入；嵌套原键及业务冲突不计完成；同根他作、错客户端／目录身份、旧能力及撤权拒绝 |
| 专业组合 | `packages/plugin-host/tests/creative-composition.test.ts`、`apps/task-view/tests/shared-workbench.spec.ts` | 两个实际包读取同一固定正文，规划不推进正式头；卸载后固定成果／原来源可读，基础写作继续，原MCP面板更新目录并保留导出 |
| 真实窗口 | `agent-launch.spec.ts`、`agent-content.spec.ts`、`agent-business.spec.ts`、`tui-navigation.spec.ts` | 正常/窄窗创建、目录/预览切换保持执行端；从作品范围选择进入铺满会话后，直接导航须恢复实际可见的创作库及原文，不以选中项、DOM存在或非忙碌代替；重开保留线程／代次／草稿，并排和焦点正确；错误可恢复 |
| MCP窄宽与可选宿主能力 | Task View的`workbench-reflow.spec.ts` | 320／480浅暗控件不被裁切，设置横纵Tab语义与键盘保持；嵌套Escape只关闭本层并返回原入口，未支持的原生窗口方法保持缺失且不发送RPC；固定原文与修订不变 |
| 分组键盘与界面放大 | `settings-navigation.spec.ts`及Task View的`workbench-reflow.spec.ts` | 全部分类按实际视觉顺序双向循环、Home／End、唯一Tab入口及面板关联；独立设置窗口100%／200%实际界面和MCP横纵布局分别验证，不能仅测前两个标签 |
| 表面失败恢复 | `agent-surface-recovery.spec.ts`、`codex-terminal-bridge.test.ts` | 双向失败恢复当前草稿且两端独立，关闭重开原线程；拒绝／断连／归属失败／关闭结束原就绪等待，不创建新轮次或重启原引擎 |
| 真实TUI/双表面 | `codex-tui-live.spec.ts`、`codex-terminal-interactions-live.spec.ts`、`codex-terminal-recovery-live.spec.ts` | 同一原生线程、唯一输入者、GUI/TUI独立草稿、客户端退出与引擎退出分别恢复 |
| 原生线程输入归属 | `codex-thread-ownership-live.spec.ts`、`codex-session.test.ts`及`fixtures/native-thread-engine.mjs` | 真实`/new`与`/resume`推进代次，旧页面草稿／输入／尺寸拒绝；挂起及拒绝目标恢复时冻结投递，失败保留原线程与独立草稿。原生PTY客户端不重建，恢复后实际输入可见且零模型轮次；终端重放完成后才开启输入 |
| 原生认证与渠道 | `codex-identity.test.ts`、`codex-session.test.ts`、`codex-authentication.spec.ts`及`fixtures/identity-engine.mjs` | 登录前不建线程；并发登录与页面重开复用原流程，成功后原线程及草稿保持。初始化前通知、核对中的身份变化、迟到完成及读取失败不放行；恢复原配置后明确重连。独立渠道无需OpenAI账号；记录和快照不含身份原文、凭据或登录链接，真实OAuth未执行时单列 |
| 完整业务 | `codex-creation-live.spec.ts`、`codex-lifecycle-live.spec.ts`、`codex-confirm-live.spec.ts`、`codex-results-live.spec.ts` | 原任务反馈返工、固定候选、确切决定、真实交付文件、Core回读；confirm不因auto夹具而被绕过 |
| 会话成果导航 | `session-results.test.ts`、`session-document-results.spec.ts`、`session-media-results.spec.ts` | 已知执行回执逐层核对，真实MCP保存后点击固定文稿／视频／专业历史；非首页、第二集、已有新版、停用、固定重试／刷新／比较及明确进入当前稿；返回原PTY／草稿保持，异作／Owner／摘要／撤权与unknown不成为可打开成果 |
| 集中确认及回执恢复 | `agent-confirm-live.spec.ts`、`fixtures/execution-receipt-proxy.mjs` | 真实模型先准备、明确QA决定后执行；多步部分完成、CAS拒绝、原线程重开、后端成功但一次回执未知，只查原计划且不重复写；成果经真实Core归属与固定修订核验 |
| 真实在途引擎崩溃 | `agent-crash-live.spec.ts`、`agent-surface-recovery.spec.ts` | Core已提交而真实回执暂扣时终止隔离引擎组；原工具未知、草稿、线程、原计划与对象保持；只查询一次原提交并恢复成果导航。断开后按钮／Enter／宿主send均不隐式恢复发送，明确重连后才恢复，整桌面崩溃另验 |
| 整桌面崩溃与跨实例代次 | `engine-guard.test.mjs`、`codex-session.test.ts`、`agent-engines.test.ts`、`agent-desktop-crash-live.spec.ts`及`agent-crash-live.spec.ts`的desktop模式 | 实际终止隔离主进程后旧引擎组退出，沿原会话恢复；启动前新输入及待答代次已落盘，崩溃前代次不能覆盖草稿或答复新请求；普通PTY同样验证跨实例旧输入与尺寸拒绝。空闲与在途分别记录，失败后沿原journal核对，不重发已提交业务 |
| 真实GUI业务 | `agent-gui-live.spec.ts` | 只读不建任务；已有精确作品准备参考稿；同一任务反馈返工、保留旧候选、等待采纳回执、固定修订交付 |
| 空库GUI与稳定接续 | `agent-creation-live.spec.ts`、Core的`execution_modes.rs` | 零作品讨论不写入；实际初始化／筹备创建均按原回执核验，原客户端新建登记和独立任务locator可到达；原键恢复、跨客户端、撤销不复活及confirm执行后才登记；原任务返工、确切QA采纳、固定交付和原线程重开分别取证 |
| 真实专业模型组合 | `agent-professional-live.spec.ts`、`fixtures/live-agent-round.ts` | 模型实际读取同包方法、精修及审校；同任务同副本接收QA意见并返工，字节／覆盖与旧记录分别核对；停用后Core固定读取及界面打开，包内新轮次真实核对相同插件Owner |

## 实机检查重点

异步重连须等待本次请求结束，再改变账号或渠道夹具。鼠标click返回及原有`changed`状态均不能证明本次IPC已完成：旧测试曾提前恢复账号，导致第一次重连合法进入ready，第二次点击等待已消失的按钮而失败。复用`codex-authentication.spec.ts`对实际`desktop:agent-session/start`的settled观察；先挂起一次调用，核对控件禁用和夹具未变，再释放并等待本次回包。夹具JSON使用同目录临时文件原子rename，避免读取半截；仅记录完成与返回／拒绝，不保存账号、令牌或登录URL。该方法适用于这个并发边界，不给所有测试加sleep或全局IPC桩。

真实宿主转发比直连多一层异步过程。写入已成功而目录可见断言超时，先从原操作、网络时序及失败截图判断提交和重读各到哪一步；副本已出现时不要再次点击复制。后续断言等待真实加载终态及目标出现，期限按实际桥接预算设定，并回读正文、固定来源和对象数量；不能只延长超时后省略业务核对。

定位刷新延迟时分开记录原提交、局部／全量刷新、目录及正文读取。比较前后耗时须使用同一Node与相同优化级别的native制品；混用开发与优化版只能诊断调用路径，不能证明整体提速。需要暂缓回包的测试分别记录后端完成和人为释放的时点，在这段时间实际输入、保存并切换作品，核对没有二次正文读取、重复写入或迟到覆盖。真实范围检查见`apps/task-view/tests/work-refresh.spec.ts`，跨实例登记与无关位置隔离见`apps/desktop/tests/library-state.spec.ts`。

- 同一版本、视口和内容对照；测量顶部占高、PTY字符画布、左右栏及浮层。10文档指定的大视口终端高度比例仅适用于无额外提示和搜索行的正常状态，不能用隐藏必要错误来达标。
- 先确认页面由主WebContents、iframe还是独立WebContentsView承载。专业插件使用独立`hetu-plugin://`页面，沿`application.windows()`定位实际表面；主页面截图可能只有外壳，不能据此判定插件空白。分别核对主窗口布局、子表面真实内容和可见边界，保存各自截图，不用错误的iframe选择器补造通过。
- 浅暗、窄窗、最大化、系统全屏、界面缩放和字体即时变化。布局切换后核对session/thread ID及输入代次，不能只比截图。
- Electron以`setZoomFactor`改变界面时，核对截图实际尺寸与窗口／DPR。曾在200%时Playwright截图只保留原生画面的左上区域，页面边界断言却正确；此情形沿确切设置窗口的`webContents.capturePage()`取完整PNG，再与`innerWidth/innerHeight`及实际输入行为对照。不要按裁切截图缩小产品，也不把网页截图外推原生全屏。
- 真实系统输入法、选择/复制/粘贴、搜索、菜单和弹窗焦点。模拟composition协议不能替代系统IME验收。
- 多级菜单还要测试连续斜向移动到子项边缘。曾出现按钮中心点击通过，而人手路径经过相邻父项使子菜单关闭；按实际父子几何、展开方向和有界指针容错处理，分别验证左右翻转、反向离开、明确点击与键盘接管。保留首轮事件和负例，不能用增加点击重试掩盖菜单消失。
- 键盘在原坐标重开菜单后，真实`pointermove`可能报告`movementX/Y=0`，iframe重排也有此现象；不能因此忽略该hover。组件回归须先核对键盘默认焦点，再用真实指针开子菜单，关闭及焦点返回后原位重开；记录零位移事件并保留左右／浅暗、连续斜向和禁用不执行。原始CI的hover返回与未展开截图、确定性本机负例及后续远端结果分别记录。
- 菜单的hover、键盘focus和实际按下分别核对计算样式。通用按钮规则曾盖掉菜单背景却保留白字，恢复蓝底后小字号仍只有约3.26:1，透明快捷键更低；须核对标签与快捷键各自的实际叠合颜色。复用`apps/desktop/tests/fixtures/rendered-contrast.ts`的浏览器探针并沿唯一共享主题修正，保留浅暗、左右、危险项、禁用及增强对比状态；数值通过不等于读屏或全部界面通过。
- 会话启动错误沿共享`[role=alert]`文字语义，主操作沿共享`.primary`状态，不用柔和危险背景色作为错误字色，也不另写仅覆盖默认态的主按钮。安装版曾分别只有约1.03:1错误文字及约1.1:1悬停主操作；`agent-launch-contrast.spec.ts`在真实窗口核对标签、快捷键和普通／悬停／按下，读取错误重试及关闭焦点保持，全程不创建引擎。夹具只证明界面和状态，不证明模型发现或认证服务可用。
- 宿主字体目录、CSS家族与实际字形分别核对。本机SFNT可同时返回中文别名与英文规范家族，而Chromium仅识别后者；目录保留别名搜索，预览及保存沿同一字体名称表映射到CSS家族。从目录选用后，即时显示和重开偏好均按规范家族断言，不能一处改成CSS名称而在恢复断言继续比较本地化展示名。不因文件存在或computed font-family含目标名称就宣称字形可用；用实际平台字体回读或等价字形证据核验，未知字体继续显示回退。不要将一次macOS名称映射推导到其他平台或所有文字覆盖。
- GUI历史向上阅读、加载更早、流式更新、新消息定位、返回位置及代码/表格/长URL。待答和失败不藏在折叠日志中，未知投递没有一键重发。

真实业务用隔离资料与精确作品范围；源代码夹具、真实引擎及已安装包分别记录。保留首轮失败和修复证据，不把定向复验表述为一次全量无失败。

长MCP旅程在连接前消费已请求的stderr管道，并记录传输错误与非预期关闭时点；诊断日志不含授权、请求正文或环境变量。断连后先回读原操作及领域对象，区分写入未执行、已经保存和只读刷新失败，不能再次点击写入来补界面。日志不足时保留不确定原因，不以随后成功推定偶发问题已解决。

rmcp 3.9.0会丢弃已取消请求的响应；验收不能继续等待该ID来测停止耗时。只读取消可在同连接发起后续读取，核对原结果不再交付、队列可继续及正常退出；后续读取的总耗时不等于取消延迟。写入仍沿原操作查询，不以无回包判断未执行或换键重发；不同SDK／协议版本先核对其实际取消语义。

Electron重开和退出验收优先复用`apps/desktop/tests/navigation.ts`的`closeApplication`。走作者正常关窗／退出路径，等待恢复稿落盘和引擎清理，在`will-quit`释放测试调试器；此后不保证还会执行`setImmediate`。释放调试器可能早于关闭请求返回，不能只因该请求连接断开就判断失败，仍以隔离子进程实际`exitCode=0`为准；`quit`事件也不能代替进程退出。失败时可用`observeApplicationShutdown`记录事件与句柄类型，不记录请求、环境、凭据或作品正文；不能靠强制终止让用例通过。资料恢复已通过但最后关闭超时，应分别记录业务结果与退出问题。

MCP浏览器宿主复用`apps/task-view/tests/workbench-host.ts`的幂等`close`：连接仍可用时先调用资源teardown，保存及释放完成后移除页面，最后关闭MCP与HTTP服务。曾在图片业务断言和result.json均完成后先断MCP，页面每2.5秒继续读取设置，导致HTTP keep-alive清理超时；trace中的故障注入500与随后Not connected分别统计。不能通过延长业务超时、忽略teardown错误或强杀进程使其通过。清理失败仍执行后续释放并报告失败，三入口业务及完整共享宿主回归分别验证。

两宿主已有相同菜单时，继续检查实际runtime分支；旧回退页不能作为当前共享React界面缺菜单的证据。创作库归档复用`work-archive.ts`，从固定WorkRef读取原领域记录及CAS，不另建归档存储，也不替换当前活动Core连接。`work-archive.test.ts`核对取消、同根三类作品、确认期间并发冲突和正文保持；Task View的`work-archive.spec.ts`覆盖三入口真实右键、恢复及再次打开。两类测试分工，避免每个宿主复制相同业务验证。

宿主发现测试分别统计模型可见工具与`ui.visibility=["app"]`的App专用入口；实际协商的模型确认另计，不用总目录数量代替精简模型预算。目录差异先回读官方实际结果，再与Core相同规则核对，不能只把失败上限加一。异步刷新时旧DOM可继续可见，点击返回不代表新批次就绪；挂起真实回包核对禁用和旧选择被拒绝，释放后等待固定新候选及启用态再操作，不靠sleep或重试掩盖。

## 原生外部宿主

共享工作台的stdio或浏览器回归不能代替实际原生宿主。先从本机应用元数据核对宿主路径、bundle ID与版本，不按旧产品名猜可执行文件。连接登记、原生插件目录可见、实际页面就绪及已有对话加载是四个结果；新进程可读新版不等于常驻对话已经热更新。沿当前安装CLI回读登记，保留`session_loaded`的真实值，不能由插件首屏可见改写它。

使用既有界面工具；通道不可用时，已获权的macOS原生AX可辅助界面验收。读取限定确切PID、唯一窗口及必要role/title，等待实际WebArea和目标内容就绪，启动菜单也可能在加载后才切换语言。AX动作返回success可能只打开菜单，不能证明按钮已经导航；若确需真实指针，先核对该控件的实际位置、尺寸及前台归属，再点击并查看真实像素与AX结果。不使用固定旧坐标，也不采集其他会话正文。

正常退出请求返回后，须确认原PID实际消失再重开，否则新启动可能被尚在进行的退出吞掉。保存启动前运行状态，仅恢复本轮确已改变的状态；不强关用户原有实例。持久截图裁成必要控件，裁剪后再次查看，避免错位裁图或泄露目录标题。

插件详情版本与创作库首屏只证明发现及启动。编辑、公开意见、确切采纳、原操作恢复和关闭重开仍各跑完整业务；原生宿主的模型对话不取代用户指定的当前对话业务入口。参见[原生首屏证据](../../../../docs/research/evidence/native-host-launch-2026-11-27.json)与[重连竞态证据](../../../../docs/research/evidence/authentication-ordering-2026-11-27.json)，历史结果不能替代新引擎或新平台验收。

原生界面业务可先由当前对话的公开CLI创建隔离作品，再在真实宿主阅读、编辑和保存，以独立CLI回读原字节及新修订；正常退出重开后同时核对可见正文、同一修订和旧不可变版本。目录中离屏节点可能仍有AX名称但尺寸为0，应先搜索到可见项，不点击猜测坐标。使用CGEvent键盘驱动时明确清除文字事件的modifier；曾因上一条Cmd导航影响而没有输入，先回读确认未写入再修正驱动，不能重复追加未知编辑。AX值会省略编辑器排版空行，完整原文仍以Core读取为准。具体成功、前置错误和剩余交互见[原生编辑证据](../../../../docs/research/evidence/native-host-edit-2026-11-27.json)。

## 系统输入与真实读屏

真实系统IME复用`agent-native-ime.spec.ts`并显式设置`HETU_LIVE_IME=1`。按隔离PID确认前台后才发送系统键盘，核对实际composition事件、原生TUI字符及GUI草稿，候选确认不产生模型消息。Sogou的Enter可能保留拼音，空格遵循实际选词；原生Shift松开可能切换中英态，不能把该行为或驱动激活失败当成产品错误。已有英文态仅在隔离窗口临时切换，最后反向操作并核对实际键盘输入源未变；Emoji等非键盘辅助项由系统动态登记，不作为切换依据。不修改系统快捷键或偏好，恢复检查失败时仍在finally关闭隔离应用。浏览器注入的换行与真实系统组合输入分开记录。

组合输入开始不代表目标候选已就绪。曾在安装版Space和数字键都提交拼音，而早先单次观察到第1候选后数字选词得到中文；后续固定包截图实际是第1项拼音、第2项中文，候选序号不能写死。浏览器`compositionend`若已是拼音，不能直接归咎PTY。空格按实际提交核对零发送，中文链路明确选中文候选，保留真实CJK字形、双方草稿及原线程断言。使用[只读候选探针](../scripts/inspect-macos-ime-candidate.swift)核对确切前台PID、指定输入法自己的可见窗口，以及目标词完整匹配且唯一的1～9序号；缺失或有歧义不选词。测试通过共享`fixtures/native-ime.ts`逐次核对前台后按实际序号发送物理数字键；`keystroke`数字曾追加进拼音，没有触发compositionend，不能作为物理选词替身。不修改用户词典或输入法设置。

macOS Vision只识别测试输入法窗口，默认临时图随调用清理，不采集其他应用、不切输入源、不发键盘或调用网络。诊断时可显式用`HETU_NATIVE_IME_DIAGNOSTICS`指向已存在的隔离证据目录，保留每个候选窗口的首张图片和本地OCR结果；核对实际候选及其序号后再定是否为产品问题，不将OCR猜测直接当作composition通过。编译完成后才启动依赖它的测试，读取失败／前台变化不计就绪，也不靠sleep或再次输入掩盖。

在已具备Swift命令行工具、现有屏幕读取权限且Sogou为当前输入源的macOS，从仓库根目录执行：

```bash
task_ime_dir="$(mktemp -d "${TMPDIR:-/tmp}/hetu-ime.XXXXXX")"
swiftc -O ".agents/skills/hetu-embedded-agent/scripts/inspect-macos-ime-candidate.swift" -o "$task_ime_dir/inspect-macos-ime-candidate"
HETU_NATIVE_IME_HELPER="$task_ime_dir/inspect-macos-ime-candidate" HETU_LIVE_IME=1 npm run test:e2e --workspace @hetu/desktop -- tests/agent-native-ime.spec.ts
```

共享桌面的其他程序改变前台或输入源时，保留本轮未完成结果，不循环抢焦点或强行改回输入法。只恢复本测试确已改变的临时状态，不能覆盖外部新的选择；源码、包内和实际安装的输入法结果分别记录。

选择器的无障碍检查沿`agent-launch-accessibility.spec.ts`，核对可访问名称中的当前值、单一Tab入口、标签与面板关联、搜索文本编辑及嵌套Escape焦点返回。曾出现Chromium的`aria-describedby`断言通过，但macOS原生`AXPopUpButton`仍只有“引擎”；当前值改为参与`aria-labelledby`后，原生`AXTitle`才包含确切选择。原生探针按隔离PID读取实际控件，不能用旁边静态文字存在代替按钮本身有名称。Chromium语义、原生AX和键盘通过仍不等于VoiceOver已通过。真实读屏按下述字幕取证方法显式运行，记录启动前状态并在finally恢复；旧脚本超时、首次使用与恢复检查失败保留，不静默开启系统脚本权限。启动应用后先等待真实页面就绪，再启用测试实例的辅助功能支持和IPC观察，避免初始化前修改造成假失败。

复用[只读macOS AX探针](../scripts/inspect-macos-ax.swift)：以`swiftc`编译到任务临时目录，将所得程序路径作为`HETU_NATIVE_AX_HELPER`传给选择器专项。程序接受确切隔离PID及可选匹配文字，默认“引擎”；按节点数、深度和读取期限限制遍历，仅输出匹配项。复选框的AXValue可能是数值0／1，不能将关闭状态误报为空；系统窗口也须先等待控件就绪。`trusted=false`、读取错误或遍历截断均须保留，空匹配不证明控件不存在；不申请权限、不启动读屏，也不把输出用于真实作品内容采集。

在已具备Swift命令行工具的macOS，从仓库根目录执行：

```bash
task_ax_dir="$(mktemp -d "${TMPDIR:-/tmp}/hetu-ax.XXXXXX")"
swiftc -O ".agents/skills/hetu-embedded-agent/scripts/inspect-macos-ax.swift" -o "$task_ax_dir/inspect-macos-ax"
HETU_NATIVE_AX_HELPER="$task_ax_dir/inspect-macos-ax" npm run test:e2e --workspace @hetu/desktop -- tests/agent-launch-accessibility.spec.ts
```

本机曾出现挂调试器时的退出停顿：无调试器的监督进程正常退出，挂调试器后原生点击也停顿。针对这一现场，可显式用`HETU_TEST_NATIVE_CLOSE=1`运行macOS专项：先解除测试连接，`app`路径向确切PID的`NSRunningApplication`请求正常`terminate`，`window`路径经已有辅助功能权限按PID及标题关闭主窗口，仍核对进程退出码及草稿恢复。不能默认关闭`window 1`：设置窗口在前时只会关设置，不能证明应用退出。该模式不使用`forceTerminate`、不改系统设置，也不按bundle ID关闭其他实例；其他平台与CI保持原驱动。测试方式和默认驱动失败分别记录，不能把本机专项通过扩大为所有自动化环境已修复。

已有`quit`事件而进程仍未退出时，诊断可记录主进程PID及ChildProcess句柄的PID、退出码与信号，按确切PID核对存活；不输出argv或环境。诊断后连续通过只能说明这些运行正常，不能在没有根因证据时宣称修复间歇性停顿。

隔离应用仍存活时可对确切PID采集有界原生线程栈。曾在正常原生退出专项中观察到`NSPersistentUIManager`与`CFPrefs`同步等待；这只描述该时点，不足以证明所有退出超时的首因。保留原测试失败和采集范围，不据此修改系统偏好、扩大等待或强制退出后计通过；原始栈可能含本机路径，公开证据只留必要摘要与脱敏观察。

Skills升级若因旧缓存摘要不同而拒绝，先比较固定市场包与缓存的文件集合及摘要。曾仅多出Python导入产生的`__pycache__/*.pyc`；核对全部源码未变且原计划尚未进入执行后，才按本次授权清理确切派生文件并沿原键继续。保留源码修改及未知结果保护，不忽略整个缓存目录或批量重装。通过导入方式验证随包Python脚本时使用`PYTHONDONTWRITEBYTECODE=1`，避免污染受校验包。

真实GUI测试需显式设置`HETU_LIVE_GUI=1`，并按脚本前置关系运行。其journal保留原作品、任务、线程和写入结果，恢复时先回读公开业务状态；不为一次断言失败清掉journal并新建重复任务。私有journal、会话凭据及本机认证不进入仓库证据，公开记录只保留必要引用、校验结果和验证边界。

集中确认专项使用自己的`HETU_LIVE_CONFIRM=1`开关，先读脚本及私有journal的完成阶段。后端提交成功后替换一次工具回执，能验证该未知结果的原计划查询，不能扩称整个传输崩溃恢复。隔离QA决定明确标记测试范围，不冒充作者认可创作内容；故障计数、原计划成功步骤、旧修订、对象数量及未隐式创建任务都要回读。

创建会话后等待模态框实际关闭、当前工作面结束加载且原连接就绪，再操作可见输入框；背后同名textarea可写入不等于用户能发送。原生用户消息可能先出现、稍后才分配`turn_id`，等待器沿本次唯一消息标记重新读取当前项，不冻结最初的空turn ID。发送前保存原attempt／标记与请求摘要；驱动等待失败后先恢复既有轮次，不能再次发送已完成请求。

观察在途崩溃时复用`dispatchLiveAgentRound`，仅发送并登记原消息；完整`liveAgentRound`等待ready和助手消息，不能用它把崩溃前的说明文字当作该业务已完成。`agent-crash-live.spec.ts`以`HETU_LIVE_CRASH=1`启用；`HETU_ASSERT_SEND_GUARD=1`额外在原线程执行不发模型请求的断开发送检查。重验先读其私有journal、故障计数和原Core计划，已完成轮次不重发。测试自身读取合同错误时记录实际已保存结果；正常关闭发生在崩溃注入前，不能声称已测崩溃，也不能把后来独立故障样本记成首轮无失败。

整个桌面故障沿同一脚本的`HETU_CRASH_TARGET=desktop`分支，空闲生命周期使用`HETU_LIVE_DESKTOP_CRASH=1`。先读当前脚本的源码／安装包选择参数及独立输出目录；这两类证据不混用。第一次迟到草稿已被错误接受时，先保留该失败，按journal恢复原测试草稿后继续核对原提交；不清空记录重新制造“首次通过”。新增引擎沿自身进程及恢复合同验证，不把Unix进程组结论推导到Windows。

真实专业组合使用`HETU_LIVE_PROFESSIONAL=1`显式启用，正常用户的已安装包只用于核验和复制到隔离安装Owner，不改变其启停或作品。目录绑定修复的源码旅程可用`HETU_PROFESSIONAL_SOURCE=1`，否则走`HETU_PACKAGED_APP`的实际包；journal已完成的模型轮次只回读，包内额外只读轮次须真正核对模型的插件目录及状态，不能用缓存的源码轮次冒充新包生效。测试驱动在调用发送前记录dispatching；进程中断后即使未发现原消息，也保留未核对状态，不自动再点发送。

若点击后没有预期交接，先记录`pointerdown/pointerup/click`、焦点、禁用状态及宿主IPC时序，区分事件未触发、请求被拒绝和后端等待。保留首次trace；后续成功只能证明该次旅程通过，不能据此宣称偶发根因已经修复。

多面板浏览器验收同时检查输入路由。辅助页关闭后曾出现主页面`innerHeight=1000`而`outerHeight=720`、原生点击未进入工作台iframe；仅激活页面或仅统一视口均未解除该现场。使用当前Playwright配套浏览器，为所有面板设定一致的context视口，并在关闭辅助页后明确激活主页面，先以最小真实宿主旅程验证按下、抬起及点击，再复验完整旅程。不以`click()`调用返回、截图正确或脚本触发按钮来代替真实事件；不为测试输入路由问题修改产品的侧栏切换语义。

若`browserType.launch`在业务开始前报告配套浏览器文件缺失，先补齐测试前置并保留原失败。需要隔离下载时，在安装浏览器和运行测试两端使用同一个任务专属`PLAYWRIGHT_BROWSERS_PATH`；只改下载目录会让测试继续查找旧缓存。不以不匹配的系统浏览器替代锁定SDK所需版本。

验证通知与点击的竞态时，真实按下指针，经官方AppBridge发送任务投影，等待该通知在iframe处理后再抬起；保存调用应仅出现一次。相同修订保留原意见及控件，不同修订继续阻止过期写入。使用协议通知的到达信号同步，不用固定sleep或脚本调用按钮click代替这段输入过程。

错误提示消失不代表重试已经完成：新的请求通常先清空错误，再等待后端。注入下一次延迟前，等待当前读取返回、内容就绪或相应按钮重新可用；否则测试可能把上一请求挂起，再等待一个永远不会启用的按钮。专业交接先等固定请求预览，再测试发送；发送控件尚未出现与宿主拒绝发送属于不同边界。将有界等待对齐实际机器超时，不靠增加固定sleep或重复点击。

加载状态须有明确终态，不能以“未连接且无数据”推断仍在加载。初始失败、断开和面板关闭后核对`aria-busy=false`，挂起真实读取再关闭并释放回包，确认内容和加载状态都不复活。键盘翻页实际触发原控件，返回后焦点仍可继续操作；载入覆盖不成为作者或Agent已阅读、理解或验证的证明。桌面和独立MCP需各自经过真实宿主桥接，不能用共享组件单测替代两条入口。

会话夹具使用隔离的原生线程标识，并在finally退出执行端。验证旧进程迟到事件时，从明确的退出／断连边界触发迟到输出；不能假设“发送后等待15ms”必然早于夹具的60ms定时器。等待真实消息或状态并设置有界期限，避免机器负载让已经合法到达的消息被误判为代次隔离失败。

终端专项先等renderer的确切代次和`data-terminal-input-ready=true`，进程已连接不等于屏幕回放完成。通过实际键盘链发送命令，浏览器`insertText`返回不证明xterm已投递；需要粘贴时验证原剪贴板入口。命令行回显也不证明命令已执行，采用确定性探针的独立数值输出并核对可见终端。Shell会在换行后插入OSC标题等控制序列，不要求原始字节中的结果紧挨换行；正则先用实际诊断核对转义，不能靠重复命令或延长等待掩盖断言错误。故障回放只留隔离测试输出，不采集用户其他终端。

原生线程接管拒绝后，错误状态可能先于占用及记录清理完成。核对“清理完成后的旧代次拒绝”时，等待原生客户端收到桥接拒绝回执；仅看到`uncertain`仍可能合法地处于交接冻结期，不能据此要求另一种错误文案或放开输入。

打包使用仓库 `npm run package:desktop -- ...` 的实际参数与返回制品路径。macOS从实际包的`Contents/Info.plist`读取`CFBundleExecutable`，不从应用显示名猜启动文件名；先构建所选用例需要的fixture。核对源码输入、随包及安装资源摘要、实际运行路径和签名；开发签名不冒充正式公证。macOS通过不推导Windows/Linux通过，未运行的平台明确记录。

成果证据记录引擎/版本/平台、会话与作品范围、执行过的动作、真实回读、恢复结果、截图和未测项。删去Token、私有授权、账号信息、正文或不必要的本机路径。业务完成与文学质量、作者认可分别说明。


### VoiceOver实际朗读

复用`fixtures/native-voiceover.ts`及[只读字幕探针](../scripts/inspect-macos-voiceover.swift)。要求当前macOS已有辅助功能和屏幕读取权限、字幕面板已启用；缺少条件、候选窗口不唯一或共享桌面被切走时保留未完成，不改系统设置或循环抢焦点。字幕窗口显示实际朗读内容的依据见[Apple官方指南](https://support.apple.com/guide/voiceover/unac078/10/mac/15.0)，实际窗口和本机系统版本仍须核对。

- `--processes`沿NSWorkspace读取系统宿主及实际可执行文件。AppleScript逐字段查询会遇到进程退出后的missing value；`VoiceOverStarter`与reader也共用bundle ID。真实reader可先于欢迎窗口短暂出现，需等首次使用完成且字幕实际输出，不能看到一次进程就算启动成功。
- 测试用系统Command-F5启动；首次使用进程实际为`VoiceOver Quickstart`／`com.apple.VoiceOverQuickstart`。只处理本次启动并核对PID的窗口，已有读屏不接管；finally核对本次进程归属并正常关闭，原失败和恢复失败分别记录，不强制终止或盲切开关。
- 字幕面板本机不暴露AX文字。探针只抓实际reader自己的唯一有界小面板，排除全屏光标层，并核对隔离前台、reader可执行文件和原生当前焦点。保留目标值的真实字幕图片与本地OCR；OCR和普通应用的AX名称分别取证，不能互相替代，也不外推所有版本的面板尺寸。
- 原生文本输入的名称可能位于AXDescription，AXTitle为空不代表缺少名称。`agent-native-voiceover.spec.ts`按真实GUI输入与TUI查找验证两种字段、实际字幕、Escape返回终端、GUI草稿及原线程保持；切换不发起模型请求。
- 焦点变化可能已经朗读新值，随后被帮助提示覆盖。先等待原生当前名称，再保存当时匹配的字幕；尚未读出才用VO-F4请求键盘焦点。不要丢掉实际匹配的瞬时字幕后反复读帮助提示。安装专项同时核对默认引擎和模型／强度更新，并在普通键盘回归前恢复读屏。

从仓库根目录执行；探针本身不输入键盘、不联网、不申请权限或切换偏好，默认临时图清理。测试的隔离输出目录明确传入后才保留诊断图片：

```bash
task_vo_dir="$(mktemp -d "${TMPDIR:-/tmp}/hetu-voiceover.XXXXXX")"
swiftc -O ".agents/skills/hetu-embedded-agent/scripts/inspect-macos-voiceover.swift" -o "$task_vo_dir/inspect-macos-voiceover"
"$task_vo_dir/inspect-macos-voiceover" --processes
HETU_LIVE_VOICEOVER=1 HETU_VOICEOVER_CAPTION_HELPER="$task_vo_dir/inspect-macos-voiceover" npm run test:e2e --workspace @hetu/desktop -- tests/agent-launch-accessibility.spec.ts
```

不开启live标志时只运行原页面语义和键盘测试，不能称真实读屏通过。字幕取证不证明音频品质、所有页面、其他读屏器或跨平台覆盖。
