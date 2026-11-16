# Hetu Luoshu

> A free, open-source local workspace for independent authors and small studios working across novels, scripts and video projects.

[中文](README.md) / [Global site](https://hetu.limeai.run/en/) / [Try the workspace](https://hetu.limeai.run/en/#prototype)

## Overview

Start with a novel, script or video project in the library. Link fixed source versions when adapting or moving into production; no placeholder novel is required. Hetu preserves story material, revisions and author decisions so drafts and media remain understandable, comparable and ready to develop further.

**As AI grows more capable, let it work with the body of work you build over time. Let every generated draft become something you can understand, choose from and continue developing.**

**Your taste, judgment and creative voice stay at the center.** Every author and screenwriter deserves respect. Story engineering makes the creative process visible, organized and easier to revise; it does not prescribe artistic choices. Read [our approach to creative ownership](https://hetu.limeai.run/en/blog/authors-at-the-center/).

Bring your chosen external Agent to organize material, create drafts and perform scoped operations through Skills, CLI and MCP. Hetu preserves queryable, actionable and recoverable project state. The desktop app puts reading, watching, comparison, review and author decisions first, with direct editing whenever you choose. Your Agent prepares the project details so you can focus on creative judgment.

| Entrance | Purpose |
| --- | --- |
| MCP | Scoped project and task access, candidate submission and feedback |
| CLI | Capability discovery, constrained operations and original-result recovery |
| Skills | Task methods and genre guidance for an external Agent |
| Desktop app | Writing, source inspection, asset selection and author finalization |

These entrances share the core, workspace permissions and revisions. General agents already invest in reasoning, context management, tool execution and recovery. Hetu focuses on durable creative material rather than an embedded Agent runtime, chat loop or model API. Host support is verified separately for installation, Skills, MCP, Apps and actual tasks.

Current genre-method packages are written in Chinese; the English catalog explains their scope. An English interface does not imply every installed method is localized for global markets.

The project workflows distinguish original manuscripts, original scripts, adaptations of your own book, licensed sources, public-domain editions and existing drafts. See [project starting points](https://hetu.limeai.run/en/docs/creative-paths/) to begin with your own material.

Novels, scripts and video projects have independent identities and optional fixed source links. A video can start from a brief, storyboard or existing media without a placeholder book or script. See the [workbench design](docs/37-创作库与小说剧本视频设计.md) and [reconstruction plan](docs/38-创作工作台重构执行计划.md) for scope and acceptance criteria.

The software is free under [Apache-2.0](LICENSE). Your creative content retains its own rights and stays in its own workspace. External agents and generation services have separate pricing and terms. Your external Agent drives generation and editing tools. Hetu organizes the resulting media, review and handoff; publishing, distribution and subsequent operations are outside this scope.

## Where to start

- Authors: [Quick start](https://hetu.limeai.run/en/docs/getting-started/) and [adaptation guide](https://hetu.limeai.run/en/docs/adaptation/).
- Independent studios: [The adaptation journal](https://hetu.limeai.run/en/blog/), with global mobile-drama evidence and practical handoff questions.
- Agent users: [Integrations](https://hetu.limeai.run/en/integrations/) and [connection guide](https://hetu.limeai.run/en/docs/agents/).
- Developers: [Engineering documentation](docs/README.md) in Chinese and the source-build steps below.

Download the Electron package for your platform from [GitHub Releases](https://github.com/limecloud/hetu/releases/latest):

- macOS 14+ on Apple Silicon: open the DMG and drag `Hetu.app` into Applications, or extract the ZIP. The app is Developer ID signed and Apple notarized.
- Windows 11 x64: extract the Windows ZIP and run `Hetu.exe`. The package is unsigned.
- Linux x64: extract the Linux `tar.gz` and run `./Hetu`. The build baseline is Ubuntu 22.04; a graphical desktop and Electron runtime libraries are required. The package is unsigned.

Each platform includes a release manifest and SHA-256 checksums. Keep the complete extracted directory, including the bundled CLI, MCP server and Node runtime.

## Run the source

The website demo uses sample data and resets on reload. Follow the steps below to run the website or build the local Mac app.

For the website, use Node.js `>=24.21.0 <26` and npm. Run from the repository root:

```bash
npm ci
npm run dev
```

Open `http://127.0.0.1:4350`. `npm run check` checks types; `npm run build` builds and validates static output. Browser checks are documented in [the website README](apps/website/README.md).

For the Electron macOS development app, use Rust `1.93.1`, Xcode Command Line Tools, Python 3 and Node.js `>=25 <26` with npm and its installation's `LICENSE`:

```bash
./dev-mac.command
```

You can also double-click `dev-mac.command` in Finder. The launcher installs locked dependencies when needed, builds the shared task pages and packages an Electron development app under `output/electron-packages/`, then opens the generated `.app`. Its exact path appears in Terminal. The one-click launcher supports Electron only. `--check` checks prerequisites; `--build-only` builds without opening; `--node-runtime` selects an existing Node executable. Running it again activates the running Electron development app; quit normally before rebuilding. The app uses ad-hoc signing. See the [developer guide](https://hetu.limeai.run/en/docs/download-and-install/) for details.

The standalone Rust CLI and MCP server use the same Core without starting the desktop app:

```bash
cargo build --locked --jobs 2 --package hetu-cli --package hetu-mcp
"target/debug/hetu" --locale en --help
"target/debug/hetu" --client codex collaboration inspect
cargo test --locked --jobs 2 --package hetu-cli
```

See the [CLI contract](docs/13-内核ABI与CLI合同.md) for command parameters and the host-owned local settings boundary.

The Electron plugin workbench uses the Rust toolchain and Node.js 25:

```bash
npm ci
cargo build --locked -p hetu-app-server -p hetu-plugin-cli -p hetu-cli -p hetu-mcp
npm run build:desktop
npm run start:desktop
```

Register existing workspaces in the creative library, or refresh it to accept novels, screenplays and videos created by an external Agent. Install prebuilt packages through the plugin page and grant workspace access separately. Run `npm run package:desktop` to assemble a separate development application; its output manifest identifies the artifact. See the [plugin development contract](docs/plugin/20-首期可执行合同与开发入口.md) for the scoped CLI/MCP runtime and tests.

Use an absolute `HETU_LOCAL_SETTINGS_DIR` for isolated preferences and `HETU_MODEL_SERVICE_DIR` for isolated model channels. A development instance launched with `HETU_DESKTOP_PROFILE` isolates both stores under that profile. API keys remain in local private storage.

## Boundaries

Deterministic checks require evidence and cannot settle literary taste or complex characterization. Reference review, manuscript adoption and finalization are separate decisions. Managed workspace permissions do not constrain other programs with the same filesystem access.

Market statistics are dated evidence. Downloads are not unique viewers, store purchases are not creator income and market totals do not forecast an individual project. Definitions and sources are maintained in [the evidence dataset](assets/research/story-market.json).

## Contributing

Requirements, contracts, implementation and acceptance have separate responsibilities. Start with the [documentation index](docs/README.md) and the repository’s `AGENTS.md`. Keep software source separate from author content, preserve existing changes and verify the affected surface before proposing changes.
