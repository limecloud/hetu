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
    mcp/                      # C++ stdio MCP Server
    review-app/               # P1 MCP Apps 资源，独立前端工具链
  core/
    include/hetu/             # C++ 内部公共接口
    src/domain/               # 设定集、节点、草稿、审核
    src/application/          # 用例与任务
    src/engines/              # 规则抽取、校验与骨架
    src/formats/              # Markdown、Fountain、DOCX 与交付适配
    src/infrastructure/       # 文件、事务、Git、ZIP
    bindings/c/               # 版本化 C ABI
  bindings/swift/              # CLI 与 macOS 共享的 Swift C ABI 包装
  contracts/
    schemas/                  # 持久化与公开输入输出 JSON Schema
    tools/                    # MCP 工具合同
    fixtures/                 # 跨入口正负样本
  integrations/codex/hetu/   # Codex 插件清单、连接与 skills
  assets/
    design/                   # 共享语义 token
    localization/             # 文案唯一来源
    brand/                    # 品牌与授权来源
  tools/                      # 合同、绑定、资源生成与验证
  tests/                      # 内核、集成、跨端、宿主、恢复
  docs/                       # 本系列
  CMakeLists.txt              # 实施阶段的 C++ 构建入口
  Package.swift               # Swift CLI 与桥接的跨平台构建入口
```

`packages/novel`、`packages/drama` 是作者工作区中的内容包，不是软件代码模块。不要为了名称相似将小说写入软件仓库，或把内容工作区变成编译依赖。

## 2. 依赖规则

Domain 不依赖 Application、Infrastructure 或任何入口。Application 调用 Domain 与必要接口，Infrastructure 实现接口，入口负责组装。引擎不能调用 UI 或外部模型，原生平台层不能维护第二套设定集校验器。

Swift 与 C# 绑定消费 C ABI；C ABI 只暴露句柄、定长标量与明确所有权的 UTF-8 数据。禁止 STL、C++ 异常或编译器对象布局跨 ABI。公开字段语义唯一维护于合同，生成绑定不得手工修改。

Swift CLI target 不引用 SwiftUI、AppKit、Keychain 专属应用代码或 C# 工程；平台终端与凭据经必要适配处理，文件、Git 和业务仍由共享内核执行。CMake 先构建并 staging C ABI 库与模块头，再由 SwiftPM 消费，不维护两份 C++ 构建参数。

## 3. 共享来源

| 来源 | 消费者 | 一致性检查 |
| --- | --- | --- |
| `contracts/schemas/` | C++、Swift、C#、CLI、MCP | 生成校验器／类型、共享正负夹具 |
| `contracts/tools/` | MCP discovery、帮助与文档投影 | 工具输入输出与实现逐项比对 |
| `assets/design/` | SwiftUI 常量、XAML 资源 | 确定性生成与无差异检查 |
| `assets/localization/` | String Catalog、RESW、CLI 文案 | 键、占位符、回退与复数检查 |
| `contracts/fixtures/` | 各入口和平台 | 相同语义结果，平台差异单独记录 |

V1 完整提供简体中文与英文，默认简体中文；机器字段、错误码与枚举不本地化。共享 token 表达语义，不强制两个平台使用相同字体、窗口控件或系统交互。

## 4. 开发纪律

- KISS：先做建工作区到导出的最小闭环，不增加网络后端。
- YAGNI：按真实功能建工程，不预建移动端、云同步、插件市场或通用 DSL。
- DRY：数据规则、错误、状态机与资源唯一维护；两端只保留平台差异。
- SOLID：领域判断、存储、原生系统和表现职责分开，接口围绕用例需求建立。
- 修改前读取相关合同和工作树，保留无关及用户已有改动；不顺手重构。
- 未经明确要求不提交、推送、建分支或 PR；文档设计 Git 能力不构成执行授权。

## 5. 变更完成条件

涉及公开字段时同步 Schema、消费者、样例及兼容策略；涉及安全与业务语义时同步正负夹具与对应需求验收；平台缺失的能力记录为未实现／未验证，不以另一平台结果代替。

构建、测试和资源生成命令由工程入口维护，使用指南引用该入口，避免重复维护命令。工具链锁定与分发合同见[21](21-构建分发与运维.md)。
