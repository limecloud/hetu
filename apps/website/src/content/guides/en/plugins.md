# Use creative plugins

An ensemble cast becomes hard to follow. A series of flashbacks makes the true order of events unclear. Add a relationship graph or a story timeline when it helps you inspect the work.

Browse the [creative plugin center](/en/plugins/). These tools extend the Hetu workspace. [Skills and client integration packages](skills.md) give your external Agent methods and a connection. Their installations are separate.

## 1. Describe what you need to understand

Start with a goal in your connected Agent conversation:

> Organize the main cast’s relationships for this work. Read only the material I authorize. Ask about uncertain connections. Save a relationship graph and read it back; do not change my manuscript, adopt text or finalize anything.

Or:

> Arrange the events in these three chapters as a timeline. Separate confirmed dates from estimates. Let me inspect it without changing the narrative order of the manuscript.

Your Agent checks actual installed capabilities and the work bound to this connection first. A catalog description cannot replace capability discovery.

For a long novel, choose [Novel Planner](/en/plugins/novel-planner/) and ask:

> Read the novel’s existing plans before organizing each volume’s goal, theme, conflict, turning points and detailed plot. Preserve my decisions, save and read back the results. Do not change, adopt or finalize manuscript text.

For blocking and camera choices, use [Director Stage](/en/plugins/director-stage/):

> Block the station dialogue with white models. Show the two people on opposite sides of the table, then compare a wide shot and a close-up. Produce previs, keep the old version and delay the close-up by half a second. The previs checks space and pacing; it is not approval of a final film.

## 2. Install the selected Hetu plugin

Manage packages under **Creative plugins** in the library, or ask your Agent to inspect, install and read back a package through Hetu’s machine interface following your explicit choice. Installation does not require a desktop window.

Check the source, version and features. A distribution contains built views, a manifest and necessary runtime files; a source folder is not the installable package. Plugin details link to source and build instructions for developers. Authors can ask their Agent to prepare the selected source.

Novel Planner’s detail page links to its preview release and verified platforms. Give the page to your Agent to download the fixed runtime package, verify digests, extract it and install through Hetu. Building source is unnecessary. Rediscover capabilities afterward to confirm the actual version.

The website catalog helps you choose. It does not inspect local installation state, execute downloads or grant permissions.

## 3. Identify the work for this task

A trusted plugin can use public host capabilities once installed and enabled, without a separate plugin grant for each work. Identify the work and task for your Agent; the external Agent’s work connection still requires its own authorization.

Plugins reuse Hetu’s work data and business rules. Manuscript adoption, finalization and spending remain your decisions. Check the source and changes before upgrading; an old package connection cannot invoke a replacement package.

If uncertain, say: “Show me what this task will read and write before I approve the scope.”

## 4. Inspect the result and give precise feedback

Check people, link direction and labels in a graph. Check dates, sequence and context in a timeline. A tidy arrangement does not establish that the story is consistent.

In Novel Planner, use the volume list to read volume information, plans and detailed plots, then inspect linked characters, places and clues. Work records show actual steps and status; a stop request still needs acknowledgment from the external Agent.

For example: “Qiao does not know Zhou’s identity yet. Change that connection to reflect what she currently knows.” Your Agent continues from the saved revision. Review the result or edit it yourself.

Ask it to read back saved data. If an operation times out, recover the original operation rather than creating another graph.

Director Stage connects a floor plan, actual 3D framing and shot dialogue in one scene. Change only shot three’s blocking while preserving neighboring shots; estimated dialogue timing, geometric occlusion and explicit axis checks flag issues for review. Identify a person, camera or frame for the Agent to revise from a fixed scene. Dragging and numeric editing are optional. Previs does not establish final actor identity, materials or exact model reproduction.

## 5. Let your Agent discover a newly installed plugin

In the existing conversation, ask: “Discover Hetu’s installed plugins again, check the capabilities permitted for this work, then continue.”

Hetu plugins are discovered through the existing CLI or MCP connection. They do not require a matching Codex plugin. Discovery reflects current installation and connection; it does not automatically inject tools into the model’s context. Updates to the client’s own Skills or integration package follow that client’s refresh requirements.

## 6. Disable a tool and keep the work

Disabling or uninstalling stops plugin calls. Saved professional data remains available through generic reading and export; specialized editing needs the appropriate plugin enabled. Uninstalling a tool does not delete a work.

For uncertain versions, permissions or results, keep the original references and follow [recovery guidance](troubleshooting.md). To make your own tool, read [Develop a creative plugin](plugin-development.md).

## From a plan to the next draft

[Prose Studio](/en/plugins/prose-studio/) records your preferences and evidence; [Novel Review](/en/plugins/novel-review/) tracks coverage and concerns across six domains; [Novel Atlas](/en/plugins/novel-atlas/) presents linked views of people, relationships, places and events. Choose what helps; none requires the other two.

Ask your Agent to read existing work and plans, state its actual reading scope, compare two directions and their costs, then prepare a candidate using your preferences. Continue from specific feedback, read the revised candidate and recheck the original concern before marking it resolved.

Novel Planner also compares future directions, story time and narrative order, and what a character knows at a particular event. Unknown time stays unknown; a planned direction is not an event that has occurred. Novel Atlas exports offline HTML without full chapters and remains readable without scripts or a network.

## Connect research, characters and analysis

[Story Research](/en/plugins/story-research/) organizes questions, observations, support and counterevidence. [Character Lab](/en/plugins/character-lab/) develops motivation hypotheses, interviews, dialogue trials and arcs. [Story Analysis](/en/plugins/story-analysis/) tracks reading coverage, scenes, signals and evidence-linked findings. Use each independently or connect them around the same novel.

Ask your Agent to research why Lin stays at the station, separate source facts from inferences and counterevidence, compare two motivations in Character Lab, then analyze their consequences for the next chapter. Read existing book, volume and chapter plans before preparing a candidate. Revise from feedback and read the new draft before rechecking the concern. Keep fixed handoff evidence; canon, adoption and finalization remain your decisions.

Review sources before conclusions, distinguish facts from hypotheses, and check reading coverage before findings. Simulated readers are not real reader feedback, name mentions do not establish appearances, and a new draft alone does not resolve a concern.

## More forms for the same work

Character cards, branching stories, series, translations, recordings and book files can build on an existing work. Install the tools needed for your current question.

| Goal | Plugin | What to review |
| --- | --- | --- |
| Exchange character cards and lorebooks | [Lorebook Bridge](/en/plugins/lorebook-bridge/) | Characters, entries, mappings and conversion notes |
| Compare choices and endings | [Interactive Fiction](/en/plugins/interactive-fiction/) | Playable routes, variables and version-bound saves |
| Organize sequels and side stories | [Series Organizer](/en/plugins/series-organizer/) | Reading order, appearances and target works |
| Translate and revise | [Story Translation](/en/plugins/story-translation/) | Alignments, terms, gaps and feedback |
| Listen for prose and dialogue issues | [Readthrough](/en/plugins/readthrough/) | Actual recordings, mapped text and interval feedback |
| Prepare readable manuscript files | [Book Export](/en/plugins/book-export/) | Contents, notes, illustrations and actual files |

For example:

> Read this novel and its existing artifacts. Build two playable routes from the chosen sequence. Prepare an English draft of one route, review it by passage and record feedback. Use only recordings I provide or explicitly authorize. Compile chosen fixed drafts into book files and inspect complete files without adopting or finalizing my manuscript.

Every handoff keeps its source version. New upstream drafts do not silently change earlier translations, audio mappings or deliveries. Inspect their impact before updating.

## Continue and review a long work

- [Novel Planner](/en/plugins/novel-planner/): review earlier chapters, inspect event order, character knowledge and change impact, then prepare the next outline and candidate.
- [Prose Studio](/en/plugins/prose-studio/): select preferences for the current character, chapter and scene; resolve conflicts and use explicitly chosen revisions as samples.
- [Novel Review](/en/plugins/novel-review/): select fixed sources and author dictionaries, check repeated sentences and evidenced state changes, then recheck each concern in the new draft.
- [Novel Atlas](/en/plugins/novel-atlas/): explore maps, routes, growth and relationship stages, object transfers and actual reading coverage, including an offline atlas.

Try: “Review the first two volumes and prepare the next opening. Express Lin’s fear through action. After revision, check when she learned the code, then update the atlas. Keep unread and uncertain material explicit.”

## From a story to more forms

Choose a tool for the question at hand. Keep adaptations separate from the original, preserve reader comments, and use actual images and recordings.

- [Adaptation Studio](/en/plugins/adaptation-studio/)：Review mappings and their reasons alongside the original and target, then ask your Agent to revise a specific unit.
- [Reader Review](/en/plugins/reader-review/)：Read original comments and coverage before decisions. Old feedback belongs to its fixed draft; recheck revisions explicitly.
- [Comic Studio](/en/plugins/comic-studio/)：Read complete rendered pages, check order, balloons and art, then identify the panel to change.
- [Audio Drama](/en/plugins/audio-drama/)：Listen to complete dialogue and mixes. Leave interval notes and recheck their position when the timeline changes.

For example: “Plan how these chapters become one episode while keeping the sender a mystery. Share fixed excerpts, revise from returned feedback, then arrange this scene as two comic pages and a short dialogue. Use my supplied images and recordings; confirm costs separately.”
