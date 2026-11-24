# Develop a creative plugin

## Start with what you need

An extension solves a concrete professional problem without copying manuscript, decision or global task ownership. Use host capabilities and preserve retrievable results when disabled.

A Hetu plugin is an independent JavaScript or TypeScript distribution, with React available for views. The host’s Rust core owns work identity, revisions, scoped transactions and author decisions. Plugin authors do not need Rust, FFI or a matching Codex plugin.

This guide starts with the working scaffold. The repository’s [plugin documentation](https://github.com/limecloud/hetu/tree/main/docs/plugin) defines the full contract; documents 20, 21 and 22 cover the executable subset, discovery and development.

## 1. Prepare the tools

Use Node.js 25, npm and the Hetu development tools. When building the host from source, follow the [GitHub repository instructions](https://github.com/limecloud/hetu#快速上手), then run from the repository root:

```bash
npm ci
npm run build:desktop
node "apps/desktop/dist/plugin-dev.mjs" --help
```

This builds the plugin development tools. Running the complete host also requires the Rust artifacts described in the repository instructions. Plugin-only development can use a prepared host and tool distribution.

## 2. Create an independent project

From the Hetu repository root, choose a destination that does not exist:

```bash
node "apps/desktop/dist/plugin-dev.mjs" create "$PWD/../hetu-character-notes" --id dev.local.character-notes --title "Character notes"
```

The scaffold includes a manifest, `CAPABILITIES.md`, a React view, JS backend, SDK types, build script and license. Its initial action counts explicitly supplied characters to verify the call chain.

```bash
cd "../hetu-character-notes"
npm install
npm run build
```

## 3. Declare only the contributions you need

| File or entry | Responsibility |
| --- | --- |
| `plugin.json` | Identity, version, Host API, dependencies, permissions, views, data schemas and action input |
| `src/view.tsx` | Author-facing view using the scoped host bridge |
| `src/backend.mjs` | Optional JS actions; no direct work-file writes |
| `CAPABILITIES.md` | This plugin’s goals, features, permissions, limitations and checks |
| `dist/` | Built distribution pinned by package digest at installation |

A view or computation does not need its own storage. Once installed and enabled, use the public SDK to discover and reuse core services instead of maintaining a second novel directory or manuscript. For professional data, declare your own types and schema versions and use shared data actions. Do not write `.hetu` directly; Core still checks business decisions, CAS and recovery through the original operation.

## 4. Validate the distribution

Return to the Hetu repository root:

```bash
node "apps/desktop/dist/plugin-dev.mjs" validate "$PWD/../hetu-character-notes/dist"
```

The result reports identity, version, digest and contributions. Validation does not execute package code; runtime checks remain necessary. Do not modify a distribution after validating it for installation.

Test against isolated demo works. Have your Agent discover actual capabilities, inspect the package and installation baseline, and check the current work connection before invoking contributions. Do not copy obsolete payloads or fabricate approval fields.

## 5. Verify the same result in the UI and Agent connection

Cover installation, discovery, scoped execution, save and read-back, close and reopen, conflicts, recovery through the original operation, disable and revocation, and generic export after uninstall. Stateless computation packages can omit storage cases but still need input, error and uninstall checks.

The stable `hetu.plugins.*` entry points manage, discover and invoke plugins. Rediscover after installation or connection changes, and use the schemas returned by the running version. Legacy permission entry points support old connections; new plugins do not need them.

## 6. Prepare the handoff

Deliver the use case, complete built package, license, capability list and evidence for that version. Explain permission changes, schema changes and compatibility. Keep professional feature documentation in the plugin rather than copying it into the host’s capability map.

Continue with [Publish and list a plugin](plugin-publishing.md).
