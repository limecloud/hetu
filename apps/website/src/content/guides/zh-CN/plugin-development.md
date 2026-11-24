# 开发创作插件

## 从当前需要开始

扩展解决一个明确的专业问题，不复制正式稿、作者决定或全局任务。使用宿主公开能力，停用后保留可取回的通用成果及明确的专业格式。

河图插件是独立的 JS／TS 分发包，界面可以使用 React。宿主的 Rust 内核负责作品、修订、受限事务与作者决定；插件开发者无需编写 Rust 或 FFI，也不需要给 Codex 制作同名插件。

本篇从可运行脚手架出发。包格式、机器合同和权限的完整规范见仓库[插件设计文档](https://github.com/limecloud/hetu/tree/main/docs/plugin)，其中第20、21、22篇分别定义当前合同、能力发现和开发步骤。

## 1. 准备开发工具

需要 Node.js 25 与 npm，以及可运行的河图开发工具。维护宿主源码时，按 [GitHub 仓库的构建说明](https://github.com/limecloud/hetu#快速上手)完成前置检查并构建：

```bash
npm ci
npm run build:desktop
node "apps/desktop/dist/plugin-dev.mjs" --help
```

这里的构建生成插件开发工具；完整运行宿主还需要源码指南中的 Rust 制品。只开发插件时，使用已准备好的宿主与开发工具即可。

## 2. 创建独立工程

在河图仓库根目录执行，目标目录须不存在：

```bash
node "apps/desktop/dist/plugin-dev.mjs" create "$PWD/../hetu-character-notes" --id dev.local.character-notes --title "人物笔记"
```

脚手架生成 `plugin.json`、`CAPABILITIES.md`、React 视图、JS 后端、SDK 类型、构建脚本与许可文件。初始示例只统计明确输入的字符，便于先验证调用链路。

```bash
cd "../hetu-character-notes"
npm install
npm run build
```

## 3. 只声明实际需要的贡献

| 文件或入口 | 职责 |
| --- | --- |
| `plugin.json` | 身份、版本、Host API、依赖、权限、视图、数据 Schema 和动作输入 |
| `src/view.tsx` | 面向作者的界面，通过受限桥接调用能力 |
| `src/backend.mjs` | 可选的 JS 后端动作，不直接写作品文件 |
| `CAPABILITIES.md` | 本插件自己的用户目标、功能入口、权限、限制和验证步骤 |
| `dist/` | 构建后的完整分发包，安装时固定摘要 |

可以只提供视图或计算动作，无需强行增加数据存储。安装启用后通过公共 SDK 发现并复用核心服务，不另建小说目录或正式正文。需要专业数据时声明自己的类型与版本，通过共享数据动作保存；不要直写 `.hetu`，业务决定、CAS 与原操作恢复仍由核心核验。

## 4. 校验固定分发包

回到河图仓库根目录执行：

```bash
node "apps/desktop/dist/plugin-dev.mjs" validate "$PWD/../hetu-character-notes/dist"
```

结果包含包身份、版本、摘要与贡献摘要。校验不执行插件代码；通过格式校验仍需实际运行验证。不要在校验后修改同一份待安装目录。

使用隔离的演示作品测试，不在真实作者作品中制造验收数据。让 Agent 从实际能力发现开始，核对包摘要、安装基线与当前作品连接，再调用本包贡献；不要复制旧调用参数或伪造批准字段。

## 5. 跑通作者与 Agent 的同一份成果

至少检查：安装与能力发现、受限动作、保存后回读、关闭重开、并发冲突、原操作恢复、停用撤权、卸载后通用读取与导出。纯计算包不需要存储用例，但仍须验证动作输入、错误和卸载。

河图插件通过稳定的 `hetu.plugins.*` 入口管理、发现与调用。Agent 在安装或连接变化后重新查询实际能力，具体 Schema 以当前发现为准。历史授权入口只用于旧连接兼容，不是新插件的必经步骤。

## 6. 准备交付

把使用场景、完整分发包、许可、功能清单和对应版本的验证证据一起交付。权限变化、数据 Schema 变化与兼容要求写清楚。保持专业功能清单在插件包内维护，不复制到宿主能力地图。

下一步按[插件发布与上架](plugin-publishing.md)固定版本、准备来源与审核资料。
