# Download and install

Try a review in the [homepage workspace](/en/#prototype) first if you prefer. The desktop client keeps your own novels, scripts and videos on your computer.

## Get an installer from the release page

Open [GitHub Releases](https://github.com/limecloud/hetu/releases/latest), read the selected version’s notes and download the package for your system. Installing a release package requires no development tools.

- **macOS 14 or newer, Apple Silicon**: download the DMG or ZIP with `macos-arm64` in its name. Open the DMG and drag `Hetu.app` into Applications, or extract the ZIP and open the app.
- **Windows 11, x64**: download the ZIP with `windows-x64` in its name. Extract the complete folder and run `Hetu.exe`.
- **Linux, x64**: download the TAR.GZ with `linux-x64` in its name. Extract the complete folder and run `./Hetu` inside it.

Mac packages are Developer ID signed and Apple notarized. Windows and Linux packages are unsigned. The Linux build baseline is Ubuntu 22.04 and requires a desktop environment and Electron runtime libraries.

Release attachments include checksums and a package manifest for verification. Keep the complete extracted folder; do not move only the executable. The repository’s “Code → Download ZIP” is source code and needs to be built. Use the release notes for the features and controls in the version you install.

## Continue existing work

Back up important work before upgrading. Keep existing project folders, tasks and revisions, then open the same project. An application update should not require importing a novel again or creating duplicate projects.

For a first task, give a connected Agent a small goal. Let it organize the proposal and save the result, then return to review without filling in all project details first. See [Quick start](getting-started.md).

## If installation fails

Check the system version, processor, download source and selected release. If the system blocks the app, retain the message and verify its checksum and signing status; on Mac, check notarization too. Do not disable system protections to bypass it.

For a [GitHub issue](https://github.com/limecloud/hetu/issues), include the system version, app version and exact message. Exclude manuscripts and credentials.
