# Hetu Luoshu

> A free, open-source local workspace for independent authors and small studios moving between manuscripts, screenplays and production references.

[中文](README.md) / [Global site](https://hetu.limeai.run/en/) / [Try the workspace](https://hetu.limeai.run/en/#prototype)

## Overview

A manuscript carries an author’s voice. A production needs playable scenes, continuity references and a handoff collaborators can continue. Hetu connects that work through structured story material, fixed sources, separate candidate drafts, versions and author decisions.

**As AI grows more capable, let it work with the body of work you build over time. Let every generated draft become something you can understand, choose from and continue developing.**

**Your taste, judgment and creative voice stay at the center.** Every author and screenwriter deserves respect. Story engineering makes the creative process visible, organized and easier to revise; it does not prescribe artistic choices. Read [our approach to creative ownership](https://hetu.limeai.run/en/blog/authors-at-the-center/).

Bring your chosen external Agent to organize material, create drafts and perform scoped operations through Skills, CLI and MCP. Hetu preserves queryable, actionable and recoverable project state. The native app puts reading, comparison, review and author decisions first, with direct editing whenever you choose. Your Agent prepares the project details so you can focus on creative judgment.

| Entrance | Purpose |
| --- | --- |
| MCP | Scoped project and task access, candidate submission and feedback |
| CLI | Capability discovery, constrained operations and original-result recovery |
| Skills | Task methods and genre guidance for an external Agent |
| Native app | Writing, source inspection, asset selection and author finalization |

These entrances share the core, workspace permissions and revisions. General agents already invest in reasoning, context management, tool execution and recovery. Hetu focuses on durable creative material rather than an embedded Agent runtime, chat loop or model API. Host support is verified separately for installation, Skills, MCP, Apps and actual tasks.

Current genre-method packages are written in Chinese; the English catalog explains their scope. An English interface does not imply every installed method is localized for global markets.

The project workflows distinguish original manuscripts, original scripts, adaptations of your own book, licensed sources, public-domain editions and existing drafts. See [project starting points](https://hetu.limeai.run/en/docs/creative-paths/) to begin with your own material.

An original screenplay is an independent work. It does not require a source novel or a placeholder book. Adaptations retain their own source requirements.

The software is free under [Apache-2.0](LICENSE). Your creative content retains its own rights and stays in its own workspace. External agents and generation services have separate pricing and terms. Filming, external generation, editing and distribution happen in the tools and teams you choose.

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
