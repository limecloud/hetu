# 河图 Hetu

> 面向网文作者与 IP 工作室的 IP 工程化工作台。设定有据，创作有序。

## 简介

河图围绕作者维护的 IP 设定集设计小说、短剧、乐律与视觉线索的组织方式，以及一致性检查、剧情抽取、Git、MCP 与交付流程。核心设计不内置模型或生成 API，作者负责最终审核。

`v0.1.0` 交付系列规范、品牌资源、可运行的双语官网和交互原型。原生内核与客户端以专项设计和验收矩阵定义实现范围。

本仓库是软件源码 Monorepo，用户创作的 IP 内容工作区独立存放。宣传网站位于 `apps/website/`，产品与工程规范位于 `docs/`，品牌资产位于 `assets/`。交互原型不连接真实工作区，应用安装包独立于设计材料交付。

## 角色分流

- 品牌与原型评审 → [设计总览](design/index.html)、[双语官网](https://hetu.limeai.run)、[交互原型](design/workbench.html)。
- 产品与作者评审 → [产品需求 PRD](docs/01-产品需求PRD.md)。
- 开发与架构评审 → [文档入口](docs/README.md)、[总体架构](docs/03-总体技术架构.md)。
- 领域与接口评审 → [领域设计](docs/28-领域设计与边界上下文.md)、[数据设计](docs/29-数据字典与Schema设计.md)、[API 设计](docs/30-应用API详细设计.md)。
- 中文与英文体验 → [国际化规范](docs/31-国际化与中文体验.md)。
- 原生客户端开发 → [macOS 方案](docs/11-macOS原生实施方案.md)、[Windows 方案](docs/12-Windows原生实施方案.md)。
- 官网开发与发布 → [宣传网站](apps/website/README.md)、[部署规范](docs/33-宣传网站与部署.md)。

## 快速上手

网站使用 Node.js `>=24.21.0 <26` 与 npm。以下命令在仓库根目录执行：

```bash
npm ci
npm run dev
```

访问 `http://127.0.0.1:4350`。`npm run check` 执行类型检查，`npm run build` 构建静态产物并检查链接、双语资源与文件限制。浏览器验收命令见[网站说明](apps/website/README.md)。

原生模块目录按[Monorepo 规范](docs/04-Monorepo与开发规范.md)组织；网站构建不依赖原生工具链。产品功能和平台范围以 PRD 及原生验收规范为准。

## 部署说明

官网地址为 [hetu.limeai.run](https://hetu.limeai.run)，公开[中英文使用指南](https://hetu.limeai.run/docs/)，工程文档保留在仓库 `docs/`。网站以 `apps/website/dist/` 为独立 Cloudflare Pages 制品。发布配置见 `apps/website/wrangler.jsonc`，操作与验证见[部署规范](docs/33-宣传网站与部署.md)。网站不包含正文上传、生成 API、账号或数据库。

## 边界

确定性规则只对有证据的结构与约束给出结论；人物性格、动机与复杂 OOC 问题保留作者判断。MCP 设定集锁约束河图受管入口，不能阻止具有同级文件权限的程序直接改写文件。

## 协作方式

需求、合同、实现与验收分别管理，文档归属见[治理规范](docs/24-文档治理架构决策与风险.md)。许可证为 [Apache-2.0](LICENSE)，详见[许可与商业化](docs/22-插件生态开源许可与商业化.md)。
