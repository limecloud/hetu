# Use creative plugins

An ensemble cast becomes hard to follow. A series of flashbacks makes the true order of events unclear. Add a relationship graph or a story timeline when it helps you inspect the work.

Browse the [creative plugin center](/en/plugins/). These tools extend the Hetu workspace. [Skills and client integration packages](skills.md) give your external Agent methods and a connection. Their installations are separate.

## 1. Describe what you need to understand

Start with a goal in your connected Agent conversation:

> Organize the main cast’s relationships for this work. Read only the material I authorize. Ask about uncertain connections. Save a relationship graph and read it back; do not change my manuscript, adopt text or finalize anything.

Or:

> Arrange the events in these three chapters as a timeline. Separate confirmed dates from estimates. Let me inspect it without changing the narrative order of the manuscript.

Your Agent checks actual installed capabilities and the work bound to this connection first. A catalog description cannot replace capability discovery.

## 2. Install the selected Hetu plugin

Manage packages under **Creative plugins** in the library, or ask your Agent to inspect, install and read back a package through Hetu’s machine interface following your explicit choice. Installation does not require a desktop window.

Check the source, version and features. A distribution contains built views, a manifest and necessary runtime files; a source folder is not the installable package. Plugin details link to source and build instructions for developers. Authors can ask their Agent to prepare the selected source.

The website catalog helps you choose. It does not inspect local installation state, execute downloads or grant permissions.

## 3. Identify the work for this task

A trusted plugin can use public host capabilities once installed and enabled, without a separate plugin grant for each work. Identify the work and task for your Agent; the external Agent’s work connection still requires its own authorization.

Plugins reuse Hetu’s work data and business rules. Manuscript adoption, finalization and spending remain your decisions. Check the source and changes before upgrading; an old package connection cannot invoke a replacement package.

If uncertain, say: “Show me what this task will read and write before I approve the scope.”

## 4. Inspect the result and give precise feedback

Check people, link direction and labels in a graph. Check dates, sequence and context in a timeline. A tidy arrangement does not establish that the story is consistent.

For example: “Qiao does not know Zhou’s identity yet. Change that connection to reflect what she currently knows.” Your Agent continues from the saved revision. Review the result or edit it yourself.

Ask it to read back saved data. If an operation times out, recover the original operation rather than creating another graph.

## 5. Let your Agent discover a newly installed plugin

In the existing conversation, ask: “Discover Hetu’s installed plugins again, check the capabilities permitted for this work, then continue.”

Hetu plugins are discovered through the existing CLI or MCP connection. They do not require a matching Codex plugin. Discovery reflects current installation and connection; it does not automatically inject tools into the model’s context. Updates to the client’s own Skills or integration package follow that client’s refresh requirements.

## 6. Disable a tool and keep the work

Disabling or uninstalling stops plugin calls. Saved professional data remains available through generic reading and export; specialized editing needs the appropriate plugin enabled. Uninstalling a tool does not delete a work.

For uncertain versions, permissions or results, keep the original references and follow [recovery guidance](troubleshooting.md). To make your own tool, read [Develop a creative plugin](plugin-development.md).
