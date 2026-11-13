# Work with external agents

Manual book creation and writing need no agent. Choose an external client and permissions only when assistance is useful.

## Current local connection

In the Mac client, open the same skills installer from Settings → AI collaboration, the new-book window, or beside the cover in Book details. Choose Codex or WorkBuddy, then the General or Military suite. Each genre suite includes setup, book creation, profile, outline, cover, drafting, revision and drama workflows.

Codex installation uses the local official CLI to register and enable the complete plugin, then checks its version and contents. WorkBuddy installation copies the complete suite into its personal skills directory, using distinct names for military workflows. Conflicting existing content is preserved and reported. Neither suite includes a model or generation service.

Client associations are saved per book. The default in Settings applies only to future books. Installation, skills version, plugin enablement, session loading and MCP connection are separate states. Finding files or finishing installation does not prove that a session loaded them or that a book is authorized. Start a new session as required by the host and verify its connection.

The source includes a standalone stdio MCP server bound to one author-selected book workspace. The host starts it locally; this website never connects to your writing. Build and launch instructions live in the GitHub repository.

Current tools read canon, submit reference drafts, organize plot and drama, validate evidence and handle fixed Git snapshots approved locally by the author. See [Integrations](/en/integrations/) for the current catalog. Installing an extension does not grant full disk or Git access.

## Hand off a task

The integration design covers choosing a client, installing an extension, copying a prompt and receiving candidates. Skills, Apps and task-local browser views need separate host verification. Hetu Luoshu provides no built-in chat or simulated generation progress.

Copy a bounded task to your selected client, such as:

> Read the selected first chapter and confirmed canon. Submit a reference for the inn passage. Keep characters and time relationships intact, explain new details, and do not modify canon, overwrite text or finalize on my behalf.

External clients provide models and services. This demo calls none and transfers no private files or keys.

## Results and recovery

Check input revisions, candidate content and citations. Even after review approval, the author chooses adoption scope and finalizes separately.

If a write receipt is missing, inspect the original operation before repeating it. Ending a local interaction does not delete books, erase history or undo completed author decisions.

Continue with [Checks and draft review](review.md).
