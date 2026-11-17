# Publish and list a plugin

GitHub provides source hosting, release notes, issue tracking and listing collaboration. The website catalog provides discovery. Hetu’s local manager validates, installs, enables and disables packages. Trusted enabled plugins reuse the public host SDK; external Agent work connections remain separate. Publishing source, listing a tool, installing it and completing a task require separate evidence.

## 1. Prepare a verifiable version

Follow the [development guide](plugin-development.md), build a complete distribution and validate it. Keep the manifest, `CAPABILITIES.md` and license inside the package, with documentation matching actual contributions.

Describe the creative problem, supported host and systems, permissions, external service costs and data migration or reading path. Release a new version for changed behavior, permissions or schemas. Do not replace a version with different bytes.

## 2. Pin source and distribution

Keep source in a repository you maintain and identify its exact commit. Provide built files through a verifiable release source such as GitHub Releases. Record both the downloadable artifact digest and the extracted package validation digest; they identify different things and are not interchangeable.

The runtime package contains built views and required dependencies. Authors should not need to run npm build scripts during installation. npm can manage development dependencies, but publishing an npm package does not establish one-click npm installation support in Hetu.

Download your own release, extract it into a fresh directory and validate it against the tested package. Exclude credentials, real manuscripts and permission records.

## 3. Request a catalog listing

Use the [GitHub plugin listing form](https://github.com/limecloud/hetu/issues/new?template=plugin-listing.yml). Continue updates in the original request; catalog changes go through code review.

Include the plugin ID and exact version, source commit, release channel, artifact URL, both digests, file size, license, maintainer contact, use case, localized descriptions, host capability usage, compatibility evidence and an installation plus real-task check. Use demo material and identify its tested version.

Use categories and tags for related genres rather than listing renamed duplicates of one tool. A separate plugin should have a clear capability or maintenance boundary.

## 4. Review and catalog presentation

Maintainers check source, package format, permissions, runtime compatibility and creative use separately. Describe the level actually checked. A repository or download count does not establish safety, quality or usability.

The website curates entries and does not perform installation. Users choose the exact package; external Agent work connections are checked independently. A Hetu plugin does not need a corresponding Codex plugin.

Maintainers record external fixed releases in `apps/website/src/data/plugin-listings.json`, organize author scenarios in `src/lib/plugins.ts` and link capability lists at exact plugin commits. Use `capabilities_path` for a capability list in a subdirectory and `homepage` for an independent website. Catalog builds do not execute external code. Download, extraction and package digest verification need separate evidence. [Shanhai](/en/plugins/shanhai/) and [Novel Planner](/en/plugins/novel-planner/) are independent examples.

## 5. Maintain updates and withdrawal

For each update, provide changes, permission differences, migration behavior, downgrade boundaries and new validation evidence. Old-version evidence is not inherited. An older program must not force an outdated schema onto newer data.

For a serious issue, identify affected versions and request withdrawal from recommendations. Preserve reading and safe export for existing users. When ending maintenance, provide source and format documentation, state maintenance status and keep user data intact.

Repository [plugin documents](https://github.com/limecloud/hetu/tree/main/docs/plugin) 22–24 define the complete development, release, review and governance process.
