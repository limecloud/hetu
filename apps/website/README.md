> 本组件属于[河图 Hetu](../../README.md)，全局信息见根 README。

# 宣传网站

## 本地开发

在仓库根目录安装锁定依赖后运行：

```bash
npm run dev
npm run check
npm run build
npm run preview --workspace @hetu/website
```

开发地址为 `http://127.0.0.1:4350`，构建预览为 `http://127.0.0.1:4351`。使用指南位于 `src/content/guides/zh-CN/` 与 `src/content/guides/en/`。首页 `/#prototype` 与 `/en/#prototype` 内嵌当前 macOS 布局的交互演示，不发布独立原型页面。构建读取根 `assets/`，不发布仓库 `docs/` 的工程文档；不编辑 `public/` 中生成的副本。

## 浏览器验证

```bash
npm exec --workspace @hetu/website -- playwright install chromium
npm run test --workspace @hetu/website
```

测试前执行 `npm run build`。测试启动独立预览进程；使用已有 Chromium 时可设置 `PLAYWRIGHT_EXECUTABLE_PATH` 指向浏览器可执行文件。线上只读验证通过 `HETU_TEST_ORIGIN` 指定目标地址，不启动本地服务器。

## 发布

以已登录的 Cloudflare 账号执行：

```bash
npm run deploy:website
```

发布到 `hetu-website` 的生产 `main` 分支。配置由本目录 `wrangler.jsonc` 维护；域名、验证和恢复合同见[网站部署规范](../../docs/33-宣传网站与部署.md)。
