import AppKit
import SwiftUI
import HetuCore
import HetuNative

struct CreativeTaskView: View {
    let model: WorkspaceModel
    @Environment(\.dismiss) private var dismiss
    @State private var session: CreativeTaskSession
    @State private var snapshot: JSONValue
    @State private var selection: NSRange
    @State private var ranges: [JSONValue]
    @State private var contextIDs: Set<String> = []
    @State private var includeBible = false
    @State private var client: AgentClient
    @State private var brief = ""
    @State private var prompt = ""
    @State private var copied = false
    @State private var connection = ""
    @State private var adoption: DramaSheet?
    @State private var installation = false
    init(model: WorkspaceModel, selection: NSRange) {
        self.model = model
        _session = State(initialValue: CreativeTaskSession(model: model))
        var document = model.loaded.object; document["content"] = .string(model.savedText)
        _snapshot = State(initialValue: .object(document))
        _selection = State(initialValue: selection)
        _client = State(initialValue: model.agentIntegration.association(for: model.workspaceID).client)
        let initial = model.needsProtection ? nil : SourceSpan(content: model.savedText, selection: selection)
        _ranges = State(initialValue: initial.map { [CreativeTaskInput.range($0)] } ?? [])
    }
    private var source: String { snapshot["content"].string ?? "" }
    private var task: JSONValue { session.task }
    private var held: Bool { session.held || model.busy }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(model.t("creative.title")).font(.title2)
                Spacer()
                Button(model.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction).disabled(session.pending != nil)
            }
            Text(model.title + " / " + model.documentTitle).foregroundStyle(.secondary)
            if let error = session.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if session.pending != nil { Button(model.t("drama.retry")) { Task { await session.retry() } } }
            HSplitView {
                ScrollView { VStack(alignment: .leading, spacing: 14) { preparation; history }.padding(.trailing, 12) }.frame(minWidth: 320, idealWidth: 360, maxWidth: 440)
                ScrollView { VStack(alignment: .leading, spacing: 14) { if task == .null { promptPreview } else { taskResult } }.frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 12) }.frame(minWidth: 380)
            }
        }.padding(24).frame(minWidth: 900, idealWidth: 1120, minHeight: 650, idealHeight: 800)
        .interactiveDismissDisabled(session.pending != nil)
        .task { await session.loadTasks() }
        .sheet(item: $adoption) { value in
            DraftAdoptionSheet(model: model, context: value.value) { id, before in
                Task { _ = await model.selectDocument(id, adoptionUndoBaseline: before) }
            }
        }
        .sheet(isPresented: $installation) {
            AgentInstallationSheet(settings: model.agentIntegration, workspaceID: model.workspaceID,
                association: AgentAssociation(client: client, suiteID: model.agentIntegration.association(for: model.workspaceID).suiteID),
                localizer: model.localizer, onSelection: { client = $0.client })
        }
    }
    private var preparation: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(model.t("creative.allowed")).font(.headline)
            if model.needsProtection {
                Text(model.t("creative.save_first")).font(.callout).foregroundStyle(.secondary)
                Button(model.t("document.save")) { Task { if await model.save() {
                    var document = model.loaded.object; document["content"] = .string(model.savedText)
                    snapshot = .object(document); ranges = []; session.discardPreview()
                } } }.disabled(held || model.isComposing)
            }
            NativeTextEditor(text: source, documentID: "creative-source-" + (snapshot["revision"]["revision_id"].string ?? ""), replacementVersion: 0,
                accessibleName: model.t("creative.allowed"), editable: false, onChange: { _ in }, onComposition: { _ in }, onSelection: { selection = $0 })
                .frame(height: 150)
            HStack {
                Button(model.t("creative.add_selection")) { addRange(empty: false) }.disabled(selection.length == 0 || ranges.count >= 16)
                Button(model.t("creative.insert_here")) { addRange(empty: true) }.disabled(selection.length != 0 || ranges.count >= 16)
                Button(model.t("creative.whole_chapter")) {
                    guard let span = SourceSpan(content: source, selection: NSRange(location: 0, length: source.utf16.count), allowEmpty: true) else { return }
                    ranges = [CreativeTaskInput.range(span)]; invalidate()
                }
            }.controlSize(.small).disabled(held)
            ForEach(Array(ranges.enumerated()), id: \.offset) { index, range in
                HStack(alignment: .top) {
                    Text(range["quote"].string == "" ? model.t("creative.insertion_point") : range["quote"].string ?? "").lineLimit(3).font(.caption)
                    Spacer()
                    Button { ranges.remove(at: index); invalidate() } label: { Image(systemName: "xmark.circle") }.buttonStyle(.plain).accessibilityLabel(model.t("common.remove"))
                }
            }
            Text(model.t("creative.reference_only")).font(.headline)
            Toggle(model.t("bible.title"), isOn: $includeBible).toggleStyle(.checkbox)
            ForEach(model.documents.filter { $0.id != model.documentID && $0.value["draft_source_id"] == .null }) { item in
                Toggle(item.title, isOn: Binding(get: { contextIDs.contains(item.id) }, set: { value in
                    if value { contextIDs.insert(item.id) } else { contextIDs.remove(item.id) }; invalidate()
                })).toggleStyle(.checkbox)
            }
            Text(model.t("creative.context_note")).font(.caption).foregroundStyle(.secondary)
            Picker(model.t("agent.client"), selection: $client) { ForEach(AgentClient.allCases, id: \.self) { Text(model.t($0.titleKey)).tag($0) } }
            Button(model.t("agent.install_title")) { installation = true }.controlSize(.small).disabled(held)
            Text(model.t("creative.request")).font(.headline)
            TextEditor(text: $brief).frame(height: 90).border(Color.secondary.opacity(0.2)).accessibilityLabel(model.t("creative.request"))
            Button(model.t("creative.preview_prompt")) { Task {
                session.startNew()
                await session.previewRevision(ranges: ranges, contextIDs: contextIDs, includeBible: includeBible, client: client, brief: brief)
                prompt = session.preview["prompt"].string ?? ""
            } }.disabled(held || model.needsProtection || model.isComposing || ranges.isEmpty || client == .none || brief.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .onChange(of: brief) { _, _ in invalidate() }
        .onChange(of: client) { _, _ in invalidate() }
        .onChange(of: includeBible) { _, _ in invalidate() }
    }
    private var promptPreview: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.t("creative.handoff_note")).foregroundStyle(.secondary)
            if session.preview != .null {
                Text(model.t("creative.prompt")).font(.headline)
                TextEditor(text: $prompt).frame(minHeight: 280).border(Color.secondary.opacity(0.2)).accessibilityLabel(model.t("creative.prompt"))
                DisclosureGroup(model.t("creative.outgoing")) {
                    Text(String(decoding: (try? session.preview["input_snapshot"].encoded(pretty: true)) ?? Data(), as: UTF8.self)).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                }
                Button(model.t("creative.prepare")) { Task { await session.prepare(prompt: prompt) } }.buttonStyle(WorkbenchButtonStyle(primary: true)).disabled(held || prompt.isEmpty)
            }
        }
    }
    private var history: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            HStack { Text(model.t("creative.history")).font(.headline); Spacer(); Button(model.t("creative.refresh")) { Task { await session.loadTasks() } } }
            ForEach(Array(session.tasks.enumerated()), id: \.offset) { _, item in
                Button { Task { await session.loadTask(item["task_ref"]) } } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item["brief"].string ?? "").lineLimit(2)
                        Text(model.t("creative.state." + (item["state"].string ?? "ready"))).font(.caption).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(.plain)
            }
            if session.nextCursor != nil { Button(model.t("creative.more")) { Task { await session.loadTasks(append: true) } } }
        }.disabled(held)
    }
    private var taskResult: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.t("creative.state." + (task["observation"]["state"].string ?? "ready"))).font(.headline)
            Text(task["request"]["brief"].string ?? "").textSelection(.enabled)
            Text(model.t("creative.handoff_note")).font(.callout).foregroundStyle(.secondary)
            HStack {
                Button(model.t("creative.copy_prompt")) { copyPrompt() }.disabled(task["observation"]["state"].string == "closed" || held)
                Button(model.t("creative.connection")) { copyConnection() }.disabled(held || task["observation"]["state"].string == "closed")
                Button(model.t("creative.refresh")) { Task { await session.loadTask(session.taskReference); await model.refresh() } }.disabled(held)
            }
            if copied { Text(model.t("creative.copied")).font(.caption).foregroundStyle(.secondary) }
            if !connection.isEmpty { Text(model.t("creative.connection_copied")).font(.caption).foregroundStyle(.secondary) }
            DisclosureGroup(model.t("creative.prompt")) { Text(task["request"]["prompt"].string ?? "").textSelection(.enabled) }
            HStack {
                Text(task["request"]["output_contract"]["relative_inbox"].string ?? "").font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                Button(model.t("creative.import_result")) { Task { await session.inspectInbox() } }.disabled(held || task["observation"]["state"].string == "closed")
            }
            if task["observation"]["submission_refs"].array.count > 1 {
                Menu(model.t("creative.batches")) {
                    ForEach(Array(task["observation"]["submission_refs"].array.enumerated()), id: \.offset) { index, item in
                        Button(String(index + 1)) { Task { await session.loadTask(session.taskReference, submissionID: item["submission_id"].string) } }
                    }
                }
            }
            if task["submission"]["complete"].bool == false { Text(task["submission"]["missing_items"].array.compactMap(\.string).joined(separator: "\n")).foregroundStyle(.secondary) }
            ForEach(Array(task["submission"]["candidates"].array.enumerated()), id: \.offset) { _, candidate in
                CreativeCandidateView(model: model, session: session, candidate: candidate) { adoption = DramaSheet(value: $0) }
                    .id(candidate["candidate_id"].string ?? "")
            }
            if task["observation"]["state"].string != "closed" {
                Button(model.t("creative.close_task"), role: .destructive) { Task { await session.close(reason: model.t("creative.closed_by_author")) } }.disabled(held)
                Text(model.t("creative.close_note")).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
    private func invalidate() { session.discardPreview(); copied = false; connection = "" }
    private func addRange(empty: Bool) {
        guard let span = SourceSpan(content: source, selection: selection, allowEmpty: empty), !empty || selection.length == 0 else { return }
        ranges.append(CreativeTaskInput.range(span)); invalidate()
    }
    private func copyPrompt() {
        let text = (task["request"]["prompt"].string ?? "") + "\nrequest_sha256: " + (task["request_sha256"].string ?? "")
        NSPasteboard.general.clearContents(); copied = NSPasteboard.general.setString(text, forType: .string)
        if copied { Task { await session.markCopied() } }
    }
    private func copyConnection() {
        var helper = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/hetu-mcp")
        if !FileManager.default.isExecutableFile(atPath: helper.path) {
            let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
            panel.message = model.t("creative.select_helper")
            guard panel.runModal() == .OK, let selected = panel.url else { return }; helper = selected
        }
        do {
            guard let workspace = model.workspace, let taskID = task["request"]["task_id"].string else { throw CreativeTaskError.invalidResult }
            connection = try TaskConnection.configuration(executable: helper, root: workspace.url, scope: .workspace, taskID: taskID)
            NSPasteboard.general.clearContents(); _ = NSPasteboard.general.setString(connection, forType: .string)
        } catch { session.showError(error) }
    }
}

private struct CreativeCandidateView: View {
    let model: WorkspaceModel
    let session: CreativeTaskSession
    let candidate: JSONValue
    let onManualAdoption: (JSONValue) -> Void
    @State private var selected: Set<Int> = []
    @State private var preview: JSONValue = .null
    private var stale: Bool { model.baseRevisionID != session.task["request"]["edit_scope"]["revision_id"].string || model.documentID != session.task["request"]["edit_scope"]["document_id"].string }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider()
            Text(candidate["title"].string ?? "").font(.headline)
            if stale { Text(model.t("creative.stale")).font(.callout).foregroundStyle(.orange) }
            ForEach(Array(candidate["patches"].array.enumerated()), id: \.offset) { index, patch in
                Toggle(isOn: Binding(get: { selected.contains(index) }, set: { value in
                    if value { selected.insert(index) } else { selected.remove(index) }; preview = .null
                })) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(patch["quote"].string == "" ? model.t("creative.insertion_point") : patch["quote"].string ?? "").foregroundStyle(.secondary)
                        Text(patch["replacement"].string ?? "").textSelection(.enabled)
                    }
                }.toggleStyle(.checkbox)
            }
            DisclosureGroup(model.t("creative.reference_version")) { Text(candidate["content"].string ?? "").textSelection(.enabled) }
            if candidate["draft_ref"] != .null {
                HStack {
                    Button(model.t("creative.preview_changes", ["count": String(selected.count)])) { Task { await prepare() } }
                        .disabled(selected.isEmpty || stale || model.needsProtection || model.isComposing || session.held || model.busy)
                    Button(model.t("creative.manual_compare")) { Task {
                        if let value = await session.read("hetu.drafts.get", input: ["draft_id": candidate["draft_ref"]["draft_id"]]) { onManualAdoption(value) }
                    } }.disabled(model.needsProtection || model.isComposing || session.held || model.busy)
                }
            }
            if preview != .null {
                Text(model.t("adoption.effect")).font(.headline)
                Text(preview["content"].string ?? "").textSelection(.enabled)
                Button(model.t("creative.adopt_selected")) { Task { await adopt() } }.buttonStyle(WorkbenchButtonStyle(primary: true))
                    .disabled(model.needsProtection || model.isComposing || session.held || model.busy)
            }
            Text(model.t("creative.adoption_note")).font(.caption).foregroundStyle(.secondary)
        }
    }
    private func prepare() async {
        preview = .null
        guard !model.needsProtection, !model.isComposing,
              let target = await session.read("hetu.documents.get", input: ["document_id": session.task["request"]["edit_scope"]["document_id"]]),
              let draft = await session.read("hetu.drafts.get", input: ["draft_id": candidate["draft_ref"]["draft_id"]]) else { return }
        do {
            let input = try CreativeTaskInput.patchAdoption(task: session.task, candidate: candidate, draft: draft, target: target, selected: selected)
            if let result = await session.read("hetu.drafts.preview_adoption", input: input) { preview = result }
        } catch { session.showError(error) }
    }
    private func adopt() async {
        guard !model.needsProtection, !model.isComposing else { session.showError(CreativeTaskError.saveRequired); return }
        let before = model.savedText
        if let value = await session.mutate("hetu.drafts.adopt", input: ["preview": preview["preview"], "operation_key": .string(UUID().uuidString)]),
           let id = value["document"]["document_id"].string {
            preview = .null; selected = []; _ = await model.selectDocument(id, adoptionUndoBaseline: before)
        } else if session.pending == nil { preview = .null }
    }
}
