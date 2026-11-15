import AppKit
import SwiftUI
import HetuCore
import HetuNative

struct CreativeTaskView: View {
    let model: WorkspaceModel
    let initialTaskRef: JSONValue
    let targetDocumentID: String?
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
    @State private var kind: CreativeTaskKind
    @State private var includeCurrent = false
    init(model: WorkspaceModel, selection: NSRange = NSRange(location: 0, length: 0), kind: CreativeTaskKind = .revision, initialTaskRef: JSONValue = .null, targetDocumentID: String? = nil) {
        self.model = model
        self.initialTaskRef = initialTaskRef; self.targetDocumentID = targetDocumentID
        _kind = State(initialValue: kind)
        _session = State(initialValue: CreativeTaskSession(model: model, targetDocumentID: targetDocumentID))
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
    private var contextTitle: String {
        if let targetDocumentID, let document = model.documents.first(where: { $0.id == targetDocumentID }) {
            return model.title + " / " + document.title
        }
        return model.documentID.isEmpty ? model.title : model.title + " / " + model.documentTitle
    }
    private var availableKinds: [CreativeTaskKind] {
        if targetDocumentID != nil { return [.dramaDraft] }
        let draft: CreativeTaskKind = model.workType == "drama" || model.loaded["document"]["source_format"].string == "fountain" ? .dramaDraft : .chapterDraft
        return (model.documentID.isEmpty ? [] : [.revision]) + [draft, .outline, .bookProfile, .cover, .artwork]
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(model.t("creative.title")).font(.system(size: 20, weight: .semibold))
                Spacer()
                PageAgentButton(model: model, page: model.documentID.isEmpty ? "book" : "document", object: model.documentID.isEmpty ? .object([:]) : .object(["document_id": .string(model.documentID), "revision_id": .string(model.baseRevisionID)]))
                Button(model.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction).disabled(session.pending != nil)
            }
            Text(contextTitle).foregroundStyle(WorkbenchPalette.muted)
            if let error = session.error { Text(error).foregroundStyle(WorkbenchPalette.danger).textSelection(.enabled) }
            if session.pending != nil { Button(model.t("drama.retry")) { Task { await session.retry() } } }
            HSplitView {
                ScrollView { VStack(alignment: .leading, spacing: 14) { history; DisclosureGroup(model.t("creative.manual_setup")) { preparation } }.padding(.trailing, 12) }.frame(minWidth: 320, idealWidth: 360, maxWidth: 440)
                ScrollView { VStack(alignment: .leading, spacing: 14) { if task == .null { promptPreview } else { taskResult } }.frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 12) }.frame(minWidth: 380)
            }
        }.padding(24).frame(minWidth: 900, idealWidth: 1120, minHeight: 650, idealHeight: 800)
        .interactiveDismissDisabled(session.pending != nil)
        .task {
            await session.loadTasks()
            if initialTaskRef != .null { await session.loadTask(initialTaskRef) }
            else if let latest = session.tasks.first(where: { $0["task_kind"].string == kind.rawValue }) { await session.loadTask(latest["task_ref"]) }
        }
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
            Picker(model.t("creative.kind"), selection: $kind) {
                ForEach(availableKinds) { value in Text(model.t(value.titleKey)).tag(value) }
            }.disabled(held)
            if model.needsProtection {
                Text(model.t("creative.save_first")).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.muted)
                Button(model.t("document.save")) { Task { if await model.save() {
                    var document = model.loaded.object; document["content"] = .string(model.savedText)
                    snapshot = .object(document); ranges = []; session.discardPreview()
                } } }.disabled(held || model.isComposing)
            }
            if kind == .revision {
            Text(model.t("creative.allowed")).font(.system(size: 14, weight: .semibold))
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
                    Text(range["quote"].string == "" ? model.t("creative.insertion_point") : range["quote"].string ?? "").lineLimit(3).font(.system(size: 12))
                    Spacer()
                    Button { ranges.remove(at: index); invalidate() } label: { Image(systemName: "xmark.circle") }.buttonStyle(.plain).accessibilityLabel(model.t("common.remove"))
                }
            }
            }
            Text(model.t("creative.reference_only")).font(.system(size: 14, weight: .semibold))
            if kind != .revision && !model.documentID.isEmpty {
                Toggle(model.documentTitle, isOn: $includeCurrent).toggleStyle(.checkbox)
            }
            Toggle(model.t("bible.title"), isOn: $includeBible).toggleStyle(.checkbox)
            HStack {
                Button(model.t("creative.context.select_all")) {
                    contextIDs = Set(model.documents.filter { $0.id != model.documentID && $0.value["draft_source_id"] == .null }.map(\.id)); invalidate()
                }.disabled(model.documents.filter { $0.id != model.documentID && $0.value["draft_source_id"] == .null }.count > (includeBible ? 98 : 99))
                Button(model.t("creative.context.clear")) { contextIDs = []; invalidate() }.disabled(contextIDs.isEmpty)
            }.controlSize(.small)
            ForEach(model.documents.filter { $0.id != model.documentID && $0.value["draft_source_id"] == .null }) { item in
                Toggle(item.title, isOn: Binding(get: { contextIDs.contains(item.id) }, set: { value in
                    if value { contextIDs.insert(item.id) } else { contextIDs.remove(item.id) }; invalidate()
                })).toggleStyle(.checkbox)
            }
            Text(model.t("creative.context_note")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
            Picker(model.t("agent.client"), selection: $client) { ForEach(AgentClient.allCases, id: \.self) { Text(model.t($0.titleKey)).tag($0) } }
            Button(model.t("agent.install_title")) { installation = true }.controlSize(.small).disabled(held)
            Text(model.t(kind == .revision ? "creative.request" : "creative.writing_request")).font(.system(size: 14, weight: .semibold))
            TextEditor(text: $brief).frame(height: 90).overlay(Rectangle().stroke(WorkbenchPalette.muted.opacity(0.2), lineWidth: 0.5)).accessibilityLabel(model.t(kind == .revision ? "creative.request" : "creative.writing_request"))
            Button(model.t("creative.preview_prompt")) { Task {
                session.startNew()
                await session.previewWriting(kind: kind, ranges: ranges, contextIDs: contextIDs, includeBible: includeBible, includeCurrent: includeCurrent, client: client, brief: brief)
                prompt = session.preview["prompt"].string ?? ""
            } }.disabled(held || model.needsProtection || model.isComposing || (kind == .revision && ranges.isEmpty) || client == .none || brief.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .onChange(of: brief) { _, _ in invalidate() }
        .onChange(of: client) { _, _ in invalidate() }
        .onChange(of: includeBible) { _, _ in invalidate() }
        .onChange(of: includeCurrent) { _, _ in invalidate() }
        .onChange(of: kind) { _, _ in invalidate() }
    }
    private var promptPreview: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.t("creative.handoff_note")).foregroundStyle(WorkbenchPalette.muted)
            if session.preview != .null {
                Text(model.t("creative.prompt")).font(.system(size: 14, weight: .semibold))
                TextEditor(text: $prompt).frame(minHeight: 280).overlay(Rectangle().stroke(WorkbenchPalette.muted.opacity(0.2), lineWidth: 0.5)).accessibilityLabel(model.t("creative.prompt"))
                DisclosureGroup(model.t("creative.outgoing")) {
                    Text(String(decoding: (try? session.preview["input_snapshot"].encoded(pretty: true)) ?? Data(), as: UTF8.self)).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                }
                Button(model.t("creative.prepare")) { Task { await session.prepare(prompt: prompt) } }.buttonStyle(WorkbenchButtonStyle(primary: true)).disabled(held || prompt.isEmpty)
            }
        }
    }
    private var history: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            HStack { Text(model.t("creative.history")).font(.system(size: 14, weight: .semibold)); Spacer(); Button(model.t("creative.refresh")) { Task { await session.loadTasks() } } }
            ForEach(Array(session.tasks.enumerated()), id: \.offset) { _, item in
                Button { Task { await session.loadTask(item["task_ref"]) } } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item["brief"].string ?? "").lineLimit(2)
                        Text(model.t("creative.state." + (item["state"].string ?? "ready"))).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(.plain)
            }
            if session.nextCursor != nil { Button(model.t("creative.more")) { Task { await session.loadTasks(append: true) } } }
        }.disabled(held)
    }
    private var taskResult: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.t("creative.state." + (task["observation"]["state"].string ?? "ready"))).font(.system(size: 14, weight: .semibold))
            ModelPlanReviewView(task: task, locale: model.locale, held: held,
                read: { await session.read($0, input: $1) }, approve: { await session.mutate("hetu.model_tasks.approve", input: $0) })
            if task["observation"]["submission_refs"].array.count > 1 {
                Menu(model.t("creative.batches")) {
                    ForEach(Array(task["observation"]["submission_refs"].array.enumerated()), id: \.offset) { index, item in
                        Button(String(index + 1)) { Task { await session.loadTask(session.taskReference, submissionID: item["submission_id"].string) } }
                    }
                }
            }
            if task["submission"]["complete"].bool == false { Text(task["submission"]["missing_items"].array.compactMap(\.string).joined(separator: "\n")).foregroundStyle(WorkbenchPalette.muted) }
            ForEach(Array(task["submission"]["candidates"].array.enumerated()), id: \.offset) { _, candidate in
                if candidate["kind"].string == "image" {
                    CreativeImageCandidate(model: model, session: session, candidate: candidate)
                } else {
                CreativeCandidateView(model: model, session: session, candidate: candidate) { adoption = DramaSheet(value: $0) }
                    .id(candidate["candidate_id"].string ?? "")
                }
            }
            TaskContinuationView(task: task, locale: model.locale, held: held,
                read: { await session.read($0, input: $1) }, save: { await session.mutate("hetu.task_feedback.save", input: $0) })
                .id(task["request"]["task_id"].string)
            DisclosureGroup(model.t("creative.connection_details")) {
                Text(task["request"]["brief"].string ?? "").textSelection(.enabled)
                Text(model.t("creative.handoff_note")).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.muted)
                HStack {
                    Button(model.t("creative.copy_prompt")) { copyPrompt() }.disabled(task["observation"]["state"].string == "closed" || held)
                    Button(model.t("creative.connection")) { copyConnection() }.disabled(held || task["observation"]["state"].string == "closed")
                    Button(model.t("creative.refresh")) { Task { await session.loadTask(session.taskReference); await model.refresh() } }.disabled(held)
                }
                if copied { Text(model.t("creative.copied")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted) }
                if !connection.isEmpty { Text(model.t("creative.connection_copied")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted) }
                DisclosureGroup(model.t("creative.prompt")) { Text(task["request"]["prompt"].string ?? "").textSelection(.enabled) }
                if let root = model.workspace?.url {
                    LocalTaskViewControls(root: root, scope: .workspace, taskRef: session.taskReference,
                        brief: task["request"]["brief"].string ?? "", locale: model.locale, closed: task["observation"]["state"].string == "closed")
                }
                HStack {
                    Text(task["request"]["output_contract"]["relative_inbox"].string ?? "").font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                    Button(model.t("creative.import_result")) { Task { await session.inspectInbox() } }.disabled(held || task["observation"]["state"].string == "closed")
                }
                if task["observation"]["state"].string != "closed" {
                    Divider()
                    Button(model.t("creative.close_task"), role: .destructive) { Task { await session.close(reason: model.t("creative.closed_by_author")) } }.disabled(held)
                    Text(model.t("creative.close_note")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                }
            }
        }
    }
    private func invalidate() { session.discardPreview(); copied = false; connection = "" }
    private func addRange(empty: Bool) {
        guard let span = SourceSpan(content: source, selection: selection, allowEmpty: empty), !empty || selection.length == 0 else { return }
        ranges.append(CreativeTaskInput.range(span)); invalidate()
    }
    private func copyPrompt() {
        Task {
            guard await session.authorizeAccess() else { return }
            let text = (task["request"]["prompt"].string ?? "") + "\nrequest_sha256: " + (task["request_sha256"].string ?? "")
            NSPasteboard.general.clearContents(); copied = NSPasteboard.general.setString(text, forType: .string)
            if copied { await session.markCopied() }
        }
    }
    private func copyConnection() {
        var helper = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/hetu-mcp")
        if !FileManager.default.isExecutableFile(atPath: helper.path) {
            let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
            panel.message = model.t("creative.select_helper")
            guard panel.runModal() == .OK, let selected = panel.url else { return }; helper = selected
        }
        do {
            guard let client = task["request"]["client_adapter"].string else { throw CreativeTaskError.invalidResult }
            connection = try TaskConnection.configuration(executable: helper, clientAdapter: client)
            NSPasteboard.general.clearContents(); _ = NSPasteboard.general.setString(connection, forType: .string)
        } catch { session.showError(error) }
    }
}

struct CreativeImageCandidate: View {
    let model: WorkspaceModel
    let session: CreativeTaskSession
    let candidate: JSONValue
    let maxHeight: CGFloat
    @State private var covers: CoverSession
    @State private var overlay = false
    private var isCover: Bool { session.task["request"]["task_kind"].string == "cover" }
    private var reference: JSONValue { .object(["task_ref": session.taskReference, "submission_id": session.task["submission"]["submission_id"], "candidate_id": candidate["candidate_id"]]) }
    private var selectedCover: Bool { model.cover["cover"]["source_ref"]["kind"].string == "creative_task" && model.cover["cover"]["source_ref"]["reference"] == reference }
    init(model: WorkspaceModel, session: CreativeTaskSession, candidate: JSONValue, maxHeight: CGFloat = 320) {
        self.model = model; self.session = session; self.candidate = candidate; self.maxHeight = maxHeight
        _covers = State(initialValue: CoverSession(model: model))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider()
            Text(candidate["title"].string ?? "").font(.system(size: 14, weight: .semibold))
            if let value = session.task["image_previews"].array.first(where: { $0["candidate_id"] == candidate["candidate_id"] }),
               let raw = value["base64"].string, let data = Data(base64Encoded: raw), let image = NSImage(data: data) {
                if isCover {
                    BookCoverView(title: model.title, author: model.novelMetadata["author_name"].string ?? "", identity: model.workspaceID,
                        imageData: data, titleOverlay: overlay ? model.title : "", authorOverlay: overlay ? model.novelMetadata["author_name"].string ?? "" : "")
                        .frame(height: maxHeight).accessibilityElement().accessibilityLabel(candidate["title"].string ?? "")
                } else {
                    Image(nsImage: image).resizable().scaledToFit().frame(maxHeight: maxHeight).frame(maxWidth: .infinity).accessibilityLabel(candidate["title"].string ?? "")
                }
            }
            if isCover {
                if selectedCover {
                    Label(model.t("cover.selected"), systemImage: "checkmark.circle.fill").font(.system(size: 12)).foregroundStyle(WorkbenchPalette.jade)
                }
                Toggle(model.t("cover.add_text"), isOn: $overlay)
                Button(model.t("cover.use")) { Task {
                    if await covers.selectTaskCandidate(reference, overlay: overlay) { await model.refresh() }
                } }.buttonStyle(WorkbenchButtonStyle(primary: true)).disabled(session.held || covers.held || model.busy || (selectedCover && overlay == !(model.cover["cover"]["presentation"]["title_overlay"].string ?? "").isEmpty))
                if let error = covers.error { Text(error).foregroundStyle(WorkbenchPalette.danger).textSelection(.enabled) }
                if covers.pending != nil { Button(model.t("drama.retry")) { Task { await covers.retry(); await model.refresh() } } }
            }
        }.task(id: candidate["candidate_id"].string) {
            if isCover {
                await covers.refresh()
                overlay = selectedCover && !(model.cover["cover"]["presentation"]["title_overlay"].string ?? "").isEmpty
            }
        }
    }
}

private struct CreativeCandidateView: View {
    let model: WorkspaceModel
    let session: CreativeTaskSession
    let candidate: JSONValue
    let onManualAdoption: (JSONValue) -> Void
    @State private var selected: Set<Int> = []
    @State private var preview: JSONValue = .null
    private var stale: Bool { session.task["request"]["task_kind"].string == "revision" && (model.baseRevisionID != session.task["request"]["edit_scope"]["revision_id"].string || model.documentID != session.task["request"]["edit_scope"]["document_id"].string) }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider()
            Text(candidate["title"].string ?? "").font(.system(size: 14, weight: .semibold))
            if stale { Text(model.t("creative.stale")).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.warningInk) }
            ForEach(Array(candidate["patches"].array.enumerated()), id: \.offset) { index, patch in
                Toggle(isOn: Binding(get: { selected.contains(index) }, set: { value in
                    if value { selected.insert(index) } else { selected.remove(index) }; preview = .null
                })) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(patch["quote"].string == "" ? model.t("creative.insertion_point") : patch["quote"].string ?? "").foregroundStyle(WorkbenchPalette.muted)
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
                Text(model.t("adoption.effect")).font(.system(size: 14, weight: .semibold))
                Text(preview["content"].string ?? "").textSelection(.enabled)
                Button(model.t("creative.adopt_selected")) { Task { await adopt() } }.buttonStyle(WorkbenchButtonStyle(primary: true))
                    .disabled(model.needsProtection || model.isComposing || session.held || model.busy)
            }
            Text(model.t("creative.adoption_note")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
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
