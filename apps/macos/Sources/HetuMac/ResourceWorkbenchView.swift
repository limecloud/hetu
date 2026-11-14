import SwiftUI
import HetuCore
import HetuNative

struct ResourceWorkbenchView: View {
    let model: WorkspaceModel
    @State private var category = ""
    @State private var state = ""
    @State private var records: [JSONValue] = []
    @State private var cursor: String?
    @State private var selected = ""
    @State private var result: JSONValue = .null
    @State private var usages: [JSONValue] = []
    @State private var usageCursor: String?
    @State private var usageLoading = false
    @State private var usageError: String?
    @State private var reviewOnly = false
    @State private var usageRequest = UUID()
    @State private var selectionRequest = UUID()
    @State private var impact: ResourceUsageImpact?
    @State private var error: String?
    @State private var editor: DramaSheet?
    @State private var usageEditor: DramaSheet?
    @State private var source: DramaSheet?
    @State private var agent = false
    @State private var artworkTask = false
    @State private var projectFilter = "*"
    @State private var associations = ResourceAssociations()
    private let categories = ["character", "location", "prop", "research", "artwork", "media"]
    private var canWrite: Bool { !model.busy && !model.writeLocked && model.pendingStructureOperations.isEmpty }
    private var record: JSONValue { result["resource"] }
    private var impacts: ResourceImpactSummary { ResourceImpactSummary(entries: usages, hasMore: usageCursor != nil) }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            WorkbenchHeading(title: model.t("resources.title"), artwork: "") {
                Button(model.t("resources.organize")) { agent = true }.disabled(!canWrite)
                Button(model.t("artwork.library")) { artworkTask = true }.disabled(!canWrite)
                Button(model.t("common.refresh")) { Task { await associations.load(model: model); await load(); if !selected.isEmpty { await choose(selected) } } }
                Button(model.t("resources.new")) { editor = DramaSheet(value: .null) }
                    .buttonStyle(WorkbenchButtonStyle(primary: true)).disabled(!canWrite)
            }
            if let error { Text(error).foregroundStyle(WorkbenchPalette.danger).textSelection(.enabled) }
            HStack {
                Picker(model.t("resources.project"), selection: $projectFilter) {
                    Text(model.t("resources.project_all")).tag("*")
                    Text(model.t("resources.project_shared")).tag("")
                    ForEach(Array(associations.projects.enumerated()), id: \.offset) { _, entry in
                        Text(entry["project"]["title"].string ?? "").tag(entry["project"]["project_id"].string ?? "")
                    }
                }.frame(maxWidth: 360)
                if associations.cursor != nil { Button(model.t("resources.more_projects")) { Task { await associations.load(model: model, more: true) } }.disabled(associations.loading) }
            }
            if let error = associations.error { Text(error).foregroundStyle(WorkbenchPalette.danger) }
            HSplitView {
                VStack(alignment: .leading, spacing: 8) {
                    categoryButton("", key: "resources.all")
                    ForEach(categories, id: \.self) { categoryButton($0, key: "resources.category." + $0) }
                    Spacer()
                    Picker(model.t("resources.status"), selection: $state) {
                        Text(model.t("resources.active")).tag("")
                        ForEach(["draft", "adopted", "archived"], id: \.self) { Text(model.t("resources.state." + $0)).tag($0) }
                    }
                }.padding(.trailing, 12).frame(minWidth: 140, idealWidth: 160, maxWidth: 200)
                VStack {
                    if records.isEmpty { Text(model.t("resources.empty")).foregroundStyle(WorkbenchPalette.muted).padding() }
                    List {
                        ForEach(Array(records.enumerated()), id: \.offset) { _, item in
                            Button { Task { await choose(item["resource_id"].string ?? "") } } label: {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(item["title"].string ?? "").fontWeight(selected == item["resource_id"].string ? .semibold : .regular)
                                    Text(model.t("resources.state." + (item["state"].string ?? "draft"))).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                                    if !item["tags"].array.isEmpty { Text(item["tags"].array.compactMap(\.string).joined(separator: "、")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted) }
                                }.padding(.vertical, 4).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                            }.buttonStyle(.plain).accessibilityAddTraits(selected == item["resource_id"].string ? [.isSelected] : [])
                        }
                    }.scrollContentBackground(.hidden)
                    if cursor != nil { Button(model.t("plot.more")) { Task { await load(more: true) } } }
                }.frame(minWidth: 190, idealWidth: 240, maxWidth: 320)
                if result == .null {
                    WorkbenchEmptyState(title: model.t("resources.select"), detail: "", artwork: "media-collection").frame(minWidth: 330)
                } else { detail.frame(minWidth: 330, maxWidth: .infinity) }
            }
        }.padding(24).workbenchPage()
        .task(id: "\(model.workspaceID)-\(category)-\(state)-\(projectFilter)") { selectionRequest = UUID(); selected = ""; result = .null; clearUsages(); await load() }
        .task(id: model.workspaceID) { await associations.load(model: model) }
        .sheet(item: $editor) { value in
            ResourceEditorSheet(model: model, initial: value.value, category: category.isEmpty ? "research" : category) { saved in
                Task { await load(); await choose(saved["resource"]["resource_id"].string ?? "") }
            }
        }
        .sheet(item: $usageEditor) { value in ResourceUsageSheet(model: model, resource: value.value) { Task { await loadUsages() } } }
        .sheet(item: $source) { value in PlotSourceView(model: model, source: value.value) }
        .sheet(item: $impact, onDismiss: { Task { await loadUsages() } }) { value in ResourceImpactReviewSheet(model: model, impact: value) }
        .sheet(isPresented: $agent, onDismiss: { Task { await load(); if !selected.isEmpty { await choose(selected) } } }) { ResourceTaskSheet(model: model) }
        .sheet(isPresented: $artworkTask) { ArtworkLibrarySheet(model: model) }
    }
    private func categoryButton(_ value: String, key: String) -> some View {
        Button { category = value } label: {
            Text(model.t(key)).frame(maxWidth: .infinity, alignment: .leading).padding(9)
                .foregroundStyle(category == value ? WorkbenchPalette.jade : WorkbenchPalette.ink)
                .background(category == value ? WorkbenchPalette.jade.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 6))
        }.buttonStyle(.plain).accessibilityAddTraits(category == value ? [.isSelected] : [])
    }
    private var detail: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text(record["title"].string ?? "").font(.system(size: 20, weight: .semibold))
                    Spacer()
                    Button(model.t("common.edit")) { editor = DramaSheet(value: result) }.disabled(!canWrite || result["is_head"].bool == false || record["state"].string == "archived")
                }
                HStack {
                    Text(model.t("resources.state." + (record["state"].string ?? "draft")))
                    Text(model.t("drama.revision", ["revision": String(record["revision"].integer ?? 1)])).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                    Spacer()
                    if record["state"].string == "draft" { Button(model.t("resources.adopt")) { Task { await changeState("adopt") } }.disabled(!canWrite || result["is_head"].bool == false) }
                    if record["state"].string != "archived" { Button(model.t("resources.archive")) { Task { await changeState("archive") } }.disabled(!canWrite || result["is_head"].bool == false) }
                }
                ObjectTimestampsView(localizer: model.localizer, record: record)
                Text(record["body"].string ?? "").textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                if let notes = record["source_notes"].string, !notes.isEmpty {
                    Text(model.t("resources.source_notes")).font(.system(size: 14, weight: .semibold))
                    Text(notes).textSelection(.enabled)
                }
                ResourceLinksView(model: model, resource: record).id(selected + ":" + String(record["revision"].integer ?? 0))
                HStack {
                    Button(model.t("media.previous")) { Task { await choose(selected, revision: (record["revision"].integer ?? 1) - 1) } }.disabled((record["revision"].integer ?? 1) <= 1)
                    if result["is_head"].bool == false {
                        Text(model.t("media.historical")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                        Button(model.t("media.latest")) { Task { await choose(selected) } }
                    }
                }
                Divider()
                usageSection
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 16)
        }
    }
    private var usageSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(model.t("resources.usages")).font(.system(size: 14, weight: .semibold))
                Spacer()
                if usageLoading { ProgressView().controlSize(.small).accessibilityLabel(model.t("common.working")) }
                Button(model.t("resources.link_usage")) { usageEditor = DramaSheet(value: result) }.disabled(!canWrite || record["state"].string == "archived")
            }
            if !usageLoading && usageError == nil {
                Text(model.t(impacts.hasMore ? "resources.impact.partial_summary" : "resources.impact.summary", ["count": String(impacts.usages.count), "review": String(impacts.reviewCount)]))
                    .font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
            }
            Picker(model.t("resources.impact.filter"), selection: $reviewOnly) {
                Text(model.t("resources.impact.all")).tag(false)
                Text(model.t("resources.impact.review")).tag(true)
            }.pickerStyle(.segmented).frame(maxWidth: 320)
            if let usageError {
                Text(usageError).foregroundStyle(WorkbenchPalette.danger).textSelection(.enabled)
                Button(model.t("common.refresh")) { Task { await loadUsages() } }.disabled(usageLoading)
            } else if !usageLoading && impacts.visible(needsReviewOnly: reviewOnly).isEmpty {
                Text(model.t(reviewOnly ? "resources.impact.no_review" : "resources.impact.empty"))
                    .font(.system(size: 14)).foregroundStyle(WorkbenchPalette.muted)
            }
            ForEach(impacts.visible(needsReviewOnly: reviewOnly)) { item in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(documentTitle(item)).font(.system(size: 14, weight: .semibold))
                            Text(item.usage["role"].string ?? "").font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                        }
                        Spacer()
                        Button(model.t("resources.impact.compare")) { impact = item }.disabled(model.busy)
                    }
                    if let quote = item.usage["target_ref"]["quote"].string, !quote.isEmpty {
                        Button(quote) { source = DramaSheet(value: item.usage["target_ref"]) }
                            .buttonStyle(.link).lineLimit(3).multilineTextAlignment(.leading)
                    }
                    if item.resourceChanged { impactReason("resources.impact.resource_changed") }
                    if item.sourceChanged { impactReason("resources.impact.source_changed") }
                    Divider()
                }
            }
            if impacts.hasMore { Button(model.t("plot.more")) { Task { await loadUsages(more: true) } }.disabled(usageLoading) }
        }
    }
    private func impactReason(_ key: String) -> some View {
        Label(model.t(key), systemImage: "clock.badge.exclamationmark")
            .font(.system(size: 12)).foregroundStyle(WorkbenchPalette.warningInk)
    }
    private func documentTitle(_ item: ResourceUsageImpact) -> String {
        model.documents.first { $0.id == item.usage["target_ref"]["document_id"].string }?.title ?? model.t("resources.impact.document")
    }
    private func call(_ action: String, _ input: [String: JSONValue]) async -> JSONValue? {
        await model.workspaceAction(action, input: input, onFailure: { error = $0; _ = $1 })
    }
    private func load(more: Bool = false) async {
        var input: [String: JSONValue] = ["limit": .integer(50)]
        if !category.isEmpty { input["category"] = .string(category) }
        if !state.isEmpty { input["state"] = .string(state) }
        if projectFilter != "*" { input["project_id"] = projectFilter.isEmpty ? .null : .string(projectFilter) }
        if more, let cursor { input["cursor"] = .string(cursor) }
        if let next = await call("hetu.resources.list", input) { records = more ? records + next["resources"].array : next["resources"].array; cursor = next["next_cursor"].string }
    }
    private func choose(_ id: String, revision: Int64? = nil) async {
        let request = UUID(); selectionRequest = request
        let scope = model.workspaceID
        var input: [String: JSONValue] = ["resource_id": .string(id)]
        if let revision { input["revision"] = .integer(revision) }
        if let next = await call("hetu.resources.get", input), selectionRequest == request, model.workspaceID == scope {
            if selected != id { reviewOnly = false }
            clearUsages(); result = next; selected = id; await loadUsages()
        }
    }
    private func clearUsages() {
        usageRequest = UUID(); usages = []; usageCursor = nil; usageError = nil; usageLoading = false
    }
    private func loadUsages(more: Bool = false) async {
        guard !selected.isEmpty, !usageLoading, let workspace = model.workspace else { return }
        let request = UUID(); usageRequest = request
        let resourceID = selected; let scope = model.workspaceID
        usageLoading = true; usageError = nil
        defer { if usageRequest == request { usageLoading = false } }
        var input: [String: JSONValue] = ["resource_id": .string(resourceID), "limit": .integer(50)]
        if more { guard let usageCursor else { return }; input["cursor"] = .string(usageCursor) }
        do {
            let next = try await workspace.data("hetu.resource_usages.list", input: input)
            guard usageRequest == request, selected == resourceID, model.workspaceID == scope else { return }
            usages = more ? usages + next["usages"].array : next["usages"].array
            usageCursor = next["next_cursor"].string
        } catch {
            if usageRequest == request, selected == resourceID, model.workspaceID == scope { usageError = model.localizer.error(error) }
        }
    }
    private func changeState(_ action: String) async {
        if await call("hetu.resources." + action, ["resource_id": record["resource_id"], "expected": .object(["revision": record["revision"], "sha256": result["sha256"]]), "operation_key": .string(UUID().uuidString)]) != nil { await load(); await choose(selected) }
    }
}

private struct ResourceEditorSheet: View {
    let model: WorkspaceModel
    let initial: JSONValue
    let onSaved: (JSONValue) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var session: RecordMutationSession
    @State private var title: String
    @State private var category: String
    @State private var bodyText: String
    @State private var tags: String
    @State private var notes: String
    @State private var projectID: String
    @State private var references: [JSONValue]
    @State private var associations = ResourceAssociations()
    @State private var composing = false
    @State private var baseline: JSONValue
    @State private var closing = false
    init(model: WorkspaceModel, initial: JSONValue, category: String, onSaved: @escaping (JSONValue) -> Void) {
        self.model = model; self.initial = initial; self.onSaved = onSaved
        _session = State(initialValue: RecordMutationSession(model: model))
        _title = State(initialValue: initial["resource"]["title"].string ?? "")
        _category = State(initialValue: initial["resource"]["category"].string ?? category)
        _bodyText = State(initialValue: initial["resource"]["body"].string ?? "")
        _tags = State(initialValue: initial["resource"]["tags"].array.compactMap(\.string).joined(separator: "、"))
        _notes = State(initialValue: initial["resource"]["source_notes"].string ?? "")
        _projectID = State(initialValue: initial["resource"]["project_id"].string ?? "")
        _references = State(initialValue: initial["resource"]["entity_refs"].array)
        _baseline = State(initialValue: initial)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(model.t(initial == .null ? "resources.new" : "common.edit")).font(.system(size: 20, weight: .semibold))
            if let error = session.error { Text(error).foregroundStyle(WorkbenchPalette.danger).textSelection(.enabled) }
            if session.error != nil, initial != .null, session.pending == nil {
                RecordConflictView(model: model, action: "hetu.resources.get", input: ["resource_id": initial["resource"]["resource_id"]], object: "resource", baseline: $baseline)
            }
            ScrollView { VStack(alignment: .leading, spacing: 14) {
                TextField(model.t("resources.name"), text: $title)
                Picker(model.t("resources.category"), selection: $category) {
                    ForEach(["character", "location", "prop", "research", "artwork", "media"], id: \.self) { Text(model.t("resources.category." + $0)).tag($0) }
                }
                Text(model.t("resources.body")).font(.system(size: 14, weight: .semibold))
                NativeTextEditor(text: bodyText, documentID: "resource-" + (initial["resource"]["resource_id"].string ?? "new"), replacementVersion: 0,
                    accessibleName: model.t("resources.body"), editable: session.pending == nil, onChange: { bodyText = $0 }, onComposition: { composing = $0 }, onSelection: { _ in }).frame(height: 220)
                TextField(model.t("resources.tags"), text: $tags)
                TextField(model.t("resources.source_notes"), text: $notes, axis: .vertical).lineLimit(3...6)
                ResourceLinksEditor(model: model, catalog: associations, projectID: $projectID, references: $references)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(2) }.disabled(session.pending != nil)
            HStack {
                Button(model.t("common.cancel")) { if dirty { closing = true } else { dismiss() } }.keyboardShortcut(.cancelAction).disabled(session.pending != nil)
                Spacer()
                Button(model.t(session.pending == nil ? "common.save" : "drama.retry")) { Task { await save() } }.keyboardShortcut(.defaultAction)
                    .disabled(model.busy || model.writeLocked || composing || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 720, height: min(740, max(400, WorkspaceWindowLayout.mainVisibleFrame.height - 100)))
        .interactiveDismissDisabled(session.pending != nil || dirty)
        .task { await associations.load(model: model, projectID: projectID, references: references) }
        .confirmationDialog(model.t("records.discard_question"), isPresented: $closing) {
            Button(model.t("records.discard"), role: .destructive) { dismiss() }
            Button(model.t("common.cancel"), role: .cancel) {}
        }
    }
    private var dirty: Bool { title != (initial["resource"]["title"].string ?? "") || bodyText != (initial["resource"]["body"].string ?? "") || notes != (initial["resource"]["source_notes"].string ?? "") || tags != initial["resource"]["tags"].array.compactMap(\.string).joined(separator: "、") || category != (initial["resource"]["category"].string ?? category) || projectID != (initial["resource"]["project_id"].string ?? "") || references != initial["resource"]["entity_refs"].array }
    private func save() async {
        let values = tags.components(separatedBy: CharacterSet(charactersIn: "、,，")).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        var seen: Set<String> = []
        let unique = values.filter { seen.insert($0).inserted }.map(JSONValue.string)
        var input: [String: JSONValue] = ["title": .string(title), "category": .string(category), "body": .string(bodyText), "tags": .array(unique),
            "source_notes": .string(notes), "project_id": projectID.isEmpty ? .null : .string(projectID),
            "entity_refs": .array(references), "operation_key": .string(UUID().uuidString)]
        let action: String
        if initial == .null { action = "hetu.resources.create" }
        else { action = "hetu.resources.update"; input["resource_id"] = baseline["resource"]["resource_id"]; input["expected"] = .object(["revision": baseline["resource"]["revision"], "sha256": baseline["sha256"]]) }
        if let saved = await session.save(action, input: input) { onSaved(saved); dismiss() }
    }
}

private struct ResourceUsageSheet: View {
    let model: WorkspaceModel
    let resource: JSONValue
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var session: RecordMutationSession
    @State private var documentID = ""
    @State private var document: JSONValue = .null
    @State private var selection = NSRange(location: 0, length: 0)
    @State private var role = ""
    init(model: WorkspaceModel, resource: JSONValue, onSaved: @escaping () -> Void) {
        self.model = model; self.resource = resource; self.onSaved = onSaved
        _session = State(initialValue: RecordMutationSession(model: model))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(model.t("resources.link_usage")).font(.system(size: 20, weight: .semibold))
            if let error = session.error { Text(error).foregroundStyle(WorkbenchPalette.danger) }
            Picker(model.t("plot.document"), selection: $documentID) {
                Text(model.t("document.select")).tag("")
                ForEach(model.documents.filter { $0.value["draft_source_id"] == .null }) { Text($0.title).tag($0.id) }
            }.disabled(session.pending != nil || model.busy)
            NativeTextEditor(text: document["content"].string ?? "", documentID: document["document"]["document_id"].string ?? "", replacementVersion: 0, accessibleName: model.t("resources.select_range"), editable: false,
                onChange: { _ in }, onComposition: { _ in }, onSelection: { selection = $0 }).frame(height: 300)
            TextField(model.t("resources.usage_role"), text: $role).disabled(session.pending != nil)
            HStack {
                Button(model.t("common.cancel")) { dismiss() }.disabled(session.pending != nil).keyboardShortcut(.cancelAction)
                Spacer()
                Button(model.t(session.pending == nil ? "common.save" : "drama.retry")) { Task { await save() } }.keyboardShortcut(.defaultAction)
                    .disabled(model.busy || model.writeLocked || selection.length == 0 || role.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 720).interactiveDismissDisabled(session.pending != nil)
        .task(id: documentID) {
            selection = NSRange(location: 0, length: 0); document = .null
            let requestedID = documentID
            if !requestedID.isEmpty, let loaded = await model.workspaceAction("hetu.documents.get", input: ["document_id": .string(requestedID)], onFailure: { session.error = $0; _ = $1 }), documentID == requestedID {
                document = loaded
            }
        }
    }
    private func save() async {
        guard let span = SourceSpan(content: document["content"].string ?? "", selection: selection) else { return }
        let target: JSONValue = .object(["document_id": document["document"]["document_id"], "revision_id": document["revision"]["revision_id"],
            "byte_start": .integer(Int64(span.byteStart)), "byte_end": .integer(Int64(span.byteEnd)), "quote": .string(span.quote)])
        let input: [String: JSONValue] = ["resource_ref": .object(["resource_id": resource["resource"]["resource_id"], "revision": resource["resource"]["revision"], "sha256": resource["sha256"]]),
            "target_ref": target, "role": .string(role), "archived": .bool(false), "operation_key": .string(UUID().uuidString)]
        if await session.save("hetu.resource_usages.save", input: input) != nil { onSaved(); dismiss() }
    }
}
