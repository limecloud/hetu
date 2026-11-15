# Hetu Luoshu

> A free, open-source local workspace for independent authors and small studios working across novels, scripts and video projects.

[中文](README.md) / [Global site](https://hetu.limeai.run/en/) / [Try the workspace](https://hetu.limeai.run/en/#prototype)

## Overview

Start with a novel, script or video project in the library. Link fixed source versions when adapting or moving into production; no placeholder novel is required. Hetu preserves story material, revisions and author decisions so drafts and media remain understandable, comparable and ready to develop further.

**As AI grows more capable, let it work with the body of work you build over time. Let every generated draft become something you can understand, choose from and continue developing.**

**Your taste, judgment and creative voice stay at the center.** Every author and screenwriter deserves respect. Story engineering makes the creative process visible, organized and easier to revise; it does not prescribe artistic choices. Read [our approach to creative ownership](https://hetu.limeai.run/en/blog/authors-at-the-center/).

Bring your chosen external Agent to organize material, create drafts and perform scoped operations through Skills, CLI and MCP. Hetu preserves queryable, actionable and recoverable project state. The native app puts reading, watching, comparison, review and author decisions first, with direct editing whenever you choose. Your Agent prepares the project details so you can focus on creative judgment.

| Entrance | Purpose |
| --- | --- |
| MCP | Scoped project and task access, candidate submission and feedback |
| CLI | Capability discovery, constrained operations and original-result recovery |
| Skills | Task methods and genre guidance for an external Agent |
| Native app | Writing, source inspection, asset selection and author finalization |

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

## Run the source

The website demo uses sample data and resets on reload. Follow the steps below to run the website or build the local Mac app.

For the website, use Node.js `>=24.21.0 <26` and npm. Run from the repository root:

```bash
npm ci
npm run dev
```

Open `http://127.0.0.1:4350`. `npm run check` checks types; `npm run build` builds and validates static output. Browser checks are documented in [the website README](apps/website/README.md).

For the macOS development app, use Rust `1.93.1`, Swift `6.2+`, a macOS SDK and the Node.js version above:

```bash
./dev-mac.command
```

The script checks local tools, builds and opens `build/native/HetuDev.app`. `--check` checks prerequisites; `--build-only` builds without opening the app. The development app uses ad-hoc signing. See the [developer guide](https://hetu.limeai.run/en/docs/download-and-install/) for the detailed source path.

## Boundaries

Deterministic checks require evidence and cannot settle literary taste or complex characterization. Reference review, manuscript adoption and finalization are separate decisions. Managed workspace permissions do not constrain other programs with the same filesystem access.

Market statistics are dated evidence. Downloads are not unique viewers, store purchases are not creator income and market totals do not forecast an individual project. Definitions and sources are maintained in [the evidence dataset](assets/research/story-market.json).

## Contributing

Requirements, contracts, implementation and acceptance have separate responsibilities. Start with the [documentation index](docs/README.md) and the repository’s `AGENTS.md`. Keep software source separate from author content, preserve existing changes and verify the affected surface before proposing changes.
