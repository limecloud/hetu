# Mac source build for developers

This guide is for maintainers with a Mac development environment. Authors can [install a release package](install.md) or try the homepage workspace in [Quick start](getting-started.md). GitHub’s “Code → Download ZIP” provides source code that must be built first.

Read the README included with the source revision you choose. Its tool requirements and capabilities apply to that revision.

## 1. Get the source

Open the [GitHub source repository](https://github.com/limecloud/hetu), choose “Code → Download ZIP” and extract it. Or use Terminal:

```bash
git clone https://github.com/limecloud/hetu.git
cd "hetu"
```

For a ZIP download, type `cd` followed by a space in Terminal, drag the extracted project folder into the window, and press Return. Run the remaining commands from that folder.

Check [GitHub releases](https://github.com/limecloud/hetu/releases) for installer assets. A web demo, source archive or development signature is not a production installer. You do not need to upload a manuscript or model credentials to the website.

## 2. Prepare your development tools

The current Mac path targets macOS 14 or newer, with Apple silicon first. Building requires:

| Tool | Project requirement | Get it |
| --- | --- | --- |
| Xcode and macOS SDK | Swift 6.2 or newer, with native linker and signing tools | [Apple developer tools](https://developer.apple.com/xcode/) |
| Rust and Cargo | Rust 1.93.1, managed by an installed rustup | [Rust installation](https://www.rust-lang.org/tools/install) |
| Node.js and npm | Node.js `>=24.21.0 <26`, with `LICENSE` from the same installation | [Node.js downloads](https://nodejs.org/en/download) |
| Python | An available `python3` command | [Python for macOS](https://www.python.org/downloads/macos/) |

Node.js builds and packages on-demand task pages here. It is not a model service used by Hetu Luoshu. The launcher does not install or update system toolchains.

## 3. Check and launch the Mac app

Check the environment first:

```bash
./dev-mac.command --check
```

Once the tool check passes, run:

```bash
./dev-mac.command
```

The launcher installs locked project dependencies for task pages when needed, builds the pages, Rust core, MCP and Mac client, then opens `build/native/HetuDev.app`. The first build downloads dependencies; follow the actual output in Terminal.

You can also double-click `dev-mac.command` in Finder. To build without launching, use `./dev-mac.command --build-only`.

On success, you should see the Hetu Luoshu library. The source folder and your book folders are separate. Choose a location for your writing when you create a book.

## 4. Reopen and rebuild

Running `./dev-mac.command` again activates an already running development app and preserves its session. To rebuild, save your work, quit the development app normally, then run the launcher.

The development app uses local ad-hoc signing. Production signing, notarization and clean-system installation require separate verification. If macOS blocks an app, verify its source and release status; do not disable system protection or strip quarantine attributes.

## If launch fails

| What you see | What to do |
| --- | --- |
| A missing tool or version mismatch | Install the required tool and rerun `--check` |
| An unsuitable Node.js runtime or missing LICENSE | Point to an existing supported runtime: `./dev-mac.command --node-runtime "/your-node-installation/bin/node"` |
| Another development build is running | Let that build finish so two processes do not assemble the same resources |
| A build error in Terminal | Keep the first specific error and tool versions for a [GitHub issue](https://github.com/limecloud/hetu/issues). Do not attach manuscripts or credentials |

Continue with [Quick start](getting-started.md) to save a book plan, or follow [Your first task with Codex](codex-first-task.md).

## Advanced integration references

For automated handoffs, client configuration and capabilities, developers can read the repository documentation linked from the [source overview](https://github.com/limecloud/hetu#readme).
