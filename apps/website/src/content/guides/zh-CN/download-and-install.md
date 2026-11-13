# Mac 源码版（开发者）

本页面向已经有 Mac 开发环境、能够使用构建工具的开发者，不是面向普通作者的安装教程。当前提供源码下载与开发启动，不提供正式安装包。作者可以先从[快速入门](getting-started.md)体验首页工作台。

下面的步骤使用 `0.3.0` 版本源码；请使用同一份源码中的说明。

## 1. 获取软件源码

打开 [0.3.0 源码](https://github.com/limecloud/hetu/tree/0.3.0)，通过“Code → Download ZIP”下载并解压；也可以在终端执行：

```bash
git clone --branch 0.3.0 https://github.com/limecloud/hetu.git
cd "hetu"
```

使用 ZIP 时，在终端输入 `cd` 和一个空格，再将解压后的项目文件夹拖入终端，按回车。接下来的命令都在这个目录执行。

[GitHub 发布记录](https://github.com/limecloud/hetu/releases)是安装制品的核对入口。不要把网页演示、源码压缩包或开发签名当作正式安装包，也无需通过官网提交作品或模型密钥。

## 2. 准备本机开发工具

当前 Mac 路线面向 macOS 14 或更新版本，优先 Apple silicon。构建前需要：

| 工具 | 项目要求 | 获取入口 |
| --- | --- | --- |
| Xcode 与 macOS SDK | Swift 6.2 或更新版本，包含本机链接与签名工具 | [Apple 开发工具](https://developer.apple.com/xcode/) |
| Rust 与 Cargo | Rust 1.93.1，通过已安装的 rustup 管理 | [Rust 安装说明](https://www.rust-lang.org/tools/install) |
| Node.js 与 npm | Node.js `>=24.21.0 <26`，同一安装中含 `LICENSE` | [Node.js 下载](https://nodejs.org/en/download) |
| Python | 可用的 `python3` | [Python 下载](https://www.python.org/downloads/macos/) |

Node.js 在这里用于构建和装配按需任务页面，不是河图洛书连接大模型的服务。启动脚本不会安装或更新系统工具链。

## 3. 检查并启动 Mac 端

先检查环境：

```bash
./dev-mac.command --check
```

看到“开发工具检查通过”后，运行：

```bash
./dev-mac.command
```

脚本会按需安装项目内锁定的任务页面依赖，构建页面、Rust 内核、MCP 与 Mac 客户端，然后打开 `build/native/HetuDev.app`。首次构建需要下载依赖，请在终端观察具体结果。

也可在 Finder 双击项目根目录的 `dev-mac.command`。只构建而不打开应用时使用 `./dev-mac.command --build-only`。

成功后应看到河图洛书书库。源码目录与作者作品目录分别管理；创建小说时再选择自己的作品保存位置。

## 4. 再次打开与更新

再次运行 `./dev-mac.command` 会激活已运行的开发版并保留当前会话。需要重新构建时，先保存作品并正常退出开发版，再运行脚本。

开发包使用本机 ad-hoc 签名，正式分发的签名、公证与干净系统安装单独验收。遇到系统安全提示时先核对来源和制品状态，不要通过关闭系统防护或删除隔离属性绕过。

## 启动不成功

| 看到的情况 | 下一步 |
| --- | --- |
| 提示缺少工具或版本不符 | 按提示补齐对应工具，再执行 `--check` |
| Node.js 或 LICENSE 不符合要求 | 指定已有合适版本：`./dev-mac.command --node-runtime "/你的Node安装目录/bin/node"` |
| 提示已有开发构建运行 | 等待原构建结束，避免两个进程同时装配资源 |
| 终端出现构建错误 | 保留首个具体错误与工具版本，向 [GitHub Issues](https://github.com/limecloud/hetu/issues)反馈；不要上传作品正文或凭据 |

接下来按[快速入门](getting-started.md)保存新书筹备，或直接跟随[用 Codex 跑通首个任务](codex-first-task.md)。

## 高级接入资料

开发者需要自动交接、客户端配置与能力说明时，请在仓库的[开发文档目录](https://github.com/limecloud/hetu/tree/main/docs)中阅读第 14 篇 Agent 接入设计和第 27 篇插件集成设计。
