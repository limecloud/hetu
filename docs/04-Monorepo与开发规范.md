# Monorepo 与开发规范

软件源码与作者内容分开管理。内容工作区规范见[07](07-工作区与持久化设计.md)。

## 1. 软件源码布局

```text
hetu/
  apps/
    website/                  # Astro 双语宣传网站，独立 Cloudflare Pages 制品
    macos/                    # SwiftUI、AppKit、Swift 桥接与平台组装
    windows/                  # WinUI 3、Presentation、C# 桥接与平台组装
    cli/                      # 跨平台 Swift 独立命令入口
    mcp/                      # Rust stdio MCP Server
    review-app/               # 建书、候选比较与批注的 MCP Apps 资源
    interaction-web/          # 按需 Node.js 本地页面与受限动作代理
  packages/
    interaction-ui/           # Apps 与本地页面共享的局部交互组件
  core/                       # Rust library，输出 rlib 与 cdylib
    src/domain/               # 设定集、节点、草稿、审核
    src/application/          # 用例与任务
    src/engines/              # 规则抽取、校验与骨架
    src/formats/              # Markdown、Fountain、DOCX 与交付适配
    src/infrastructure/       # 文件、事务、Git、ZIP
    bindings/c/               # 版本化 C ABI
  bindings/swift/              # CLI 与 macOS 共享的 Swift C ABI 包装
  contracts/
    actions.json              # 已实现动作、权限、副作用与输入合同
    schemas/                  # 持久化与公开输入输出 JSON Schema
    tools/                    # MCP 工具合同
    fixtures/                 # 跨入口正负样本
  integrations/
    skills/                   # 宿主无关的专用 Skill 方法源，按需打包
    codex/hetu/               # Codex Plugin、连接定义及生成的 Skills
    workbuddy/                # WorkBuddy Skills 与 MCP 适配
    claude-code/              # Claude Code Skills 与 MCP 适配
  assets/
    design/                   # 共享语义 token
    localization/             # 文案唯一来源
    brand/                    # 品牌与授权来源
  tools/                      # 合同、绑定、资源生成与验证
  tests/                      # 内核、集成、跨端、宿主、恢复
  docs/                       # 本系列
  Cargo.toml                  # Rust workspace 构建入口
  Cargo.lock                  # 固定完整 Rust 依赖图
  rust-toolchain.toml          # Rust 工具链版本
  Package.swift               # Swift CLI 与桥接的跨平台构建入口
```

上述为软件工程的模块归属规范，构建只声明实际存在的 target。内容工作区的 `packages/novel`、`packages/drama` 属于作者作品，软件仓库的 `packages/interaction-ui` 属于产品代码；它们具有不同根和生命周期。作者小说不能写入软件仓库或成为编译依赖。

## 2. 依赖规则

Domain 不依赖 Application、Infrastructure 或任何入口。Application 调用 Domain 与必要接口，Infrastructure 实现接口，入口负责组装。引擎不能调用 UI 或外部模型，原生平台层不能维护第二套设定集校验器。

Swift 与 C# 绑定消费 C ABI；C ABI 只暴露句柄、定长标量与明确所有权的 UTF-8 数据。禁止 Rust 所有权类型、panic 或编译器对象布局跨 ABI。公开字段语义唯一维护于合同，生成绑定不得手工修改。

Swift CLI target 不引用 SwiftUI、AppKit、Keychain 专属应用代码或 C# 工程；平台终端与凭据经必要适配处理，文件、Git 和业务仍由共享内核执行。Cargo 先构建并 staging C ABI 库与模块头，再由 SwiftPM 消费，不维护两份 Rust 构建参数。

Node.js 页面仅作为按需 UI 适配器，通过明确白名单的本机 IPC 消费同一应用用例；不直接改 JSON、正文或审核文件，不引入模型 SDK。Apps 与普通网页分别实现宿主桥接和本机 HTTP 桥接，共享候选组件、任务类型和双语文案。专用 Skills 从共同方法源打包，宿主差异只在安装、元数据、调用语法及工具映射中维护，生成目录不反向覆盖源文件。

## 3. 共享来源

| 来源 | 消费者 | 一致性检查 |
| --- | --- | --- |
| `contracts/actions.json` 与 `contracts/schemas/` | Rust、Swift、C#、CLI、MCP | 动作发现、输入校验、共享正负夹具 |
| `contracts/tools/` | MCP discovery、帮助与文档投影 | 工具输入输出与实现逐项比对 |
| `assets/design/` | SwiftUI 常量、XAML 资源 | 确定性生成与无差异检查 |
| `assets/localization/` | String Catalog、RESW、CLI 文案 | 键、占位符、回退与复数检查 |
| `contracts/fixtures/` | 各入口和平台 | 相同语义结果，平台差异单独记录 |

V1 完整提供简体中文与英文，默认简体中文；机器字段、错误码与枚举不本地化。共享 token 表达语义，不强制两个平台使用相同字体、窗口控件或系统交互。

## 4. 开发纪律

- KISS：先做软件任务入口、外部交接到人工验收的完整切片；本机局部网页按需启动，不引入必装网络后端。
- YAGNI：按真实功能建工程，不预建移动端、云同步、插件市场或通用 DSL。
- DRY：数据规则、错误、状态机与资源唯一维护；两端只保留平台差异。
- SOLID：领域判断、存储、原生系统和表现职责分开，接口围绕用例需求建立。
- 修改前读取相关合同和工作树，保留无关及用户已有改动；不顺手重构。
- 未经明确要求不提交、推送、建分支或 PR；文档设计 Git 能力不构成执行授权。

## 5. 变更完成条件

涉及公开字段时同步 Schema、消费者、样例及兼容策略；涉及安全与业务语义时同步正负夹具与对应需求验收；平台缺失的能力记录为未实现／未验证，不以另一平台结果代替。

构建、测试和资源生成命令由工程入口维护，使用指南引用该入口，避免重复维护命令。工具链锁定与分发合同见[21](21-构建分发与运维.md)。
