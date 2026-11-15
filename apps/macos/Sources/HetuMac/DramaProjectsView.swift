import SwiftUI
import HetuCore
import HetuNative

struct DramaWorkbenchView: View {
    let model: WorkspaceModel
    let onOpenScript: (String) -> Void
    @State private var projects: [JSONValue] = []
    @State private var cursor: String?
    @State private var selected = ""
    @State private var result: JSONValue = .null
    @State private var selectedEpisode = ""
    @State private var episode: JSONValue = .null
    @State private var error: String?
    @State private var includeArchived = false
    @State private var projectEditor: DramaSheet?
    @State private var episodeEditor: DramaSheet?
    @State private var skeletons = false
    @State private var creativeTask = false
    private var project: JSONValue { result["project"] }
    private var canWrite: Bool { !model.busy && !model.writeLocked && model.pendingStructureOperations.isEmpty }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            WorkbenchHeading(title: model.t("drama.workbench_title"), artwork: "") {
                PageAgentButton(model: model, page: "episode", object: handoffObject)
                Button(model.t("creative.title")) { creativeTask = true }.disabled(model.busy)
                Button(model.t("drama.skeletons")) { skeletons = true }
                Button(model.t("common.refresh")) { Task { await load(); if !selected.isEmpty { await choose(selected) } } }
                Button(model.t("drama.project_new")) { projectEditor = DramaSheet(value: .null) }
                    .buttonStyle(WorkbenchButtonStyle(primary: true)).disabled(!canWrite)
            }
            if let error { Text(error).foregroundStyle(WorkbenchPalette.danger).textSelection(.enabled) }
            HSplitView {
                projectList.frame(minWidth: 180, idealWidth: 220, maxWidth: 280)
                if result == .null {
                    WorkbenchEmptyState(title: model.t("drama.project_select"), detail: "", artwork: "drama-stage")
                } else {
                    episodeList.frame(minWidth: 210, idealWidth: 250, maxWidth: 340)
                    episodeDetail.frame(minWidth: 330, maxWidth: .infinity)
                }
            }
        }.padding(24).workbenchPage()
        .task(id: includeArchived) { await load() }
        .sheet(isPresented: $creativeTask) { CreativeTaskView(model: model, kind: .dramaDraft) }
        .sheet(item: $projectEditor) { value in
            DramaProjectEditor(model: model, initial: value.value) { saved in Task { await load(); await choose(saved["project"]["project_id"].string ?? "") } }
        }
        .sheet(item: $episodeEditor) { value in
            DramaEpisodeEditor(model: model, projectResult: result, initial: value.value) { saved in
                Task { await choose(selected); await chooseEpisode(saved["episode"]["episode_id"].string ?? "") }
            }
        }
        .sheet(isPresented: $skeletons) {
            VStack(spacing: 0) {
                HStack { Spacer(); Button(model.t("common.close")) { skeletons = false } }.padding(16)
                DramaSkeletonWorkbenchView(model: model) { id in skeletons = false; onOpenScript(id) }
            }.frame(minWidth: 1060, idealWidth: 1200, minHeight: 700, idealHeight: 820)
        }
    }
    private var projectList: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle(model.t("drama.show_archived"), isOn: $includeArchived).toggleStyle(.checkbox)
            List {
                ForEach(Array(projects.enumerated()), id: \.offset) { _, entry in
                    let record = entry["project"]
                    Button { Task { await choose(record["project_id"].string ?? "") } } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(record["title"].string ?? "").fontWeight(selected == record["project_id"].string ? .semibold : .regular)
                            Text(model.t("drama.mode." + (record["mode"].string ?? "original"))).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 5).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityAddTraits(selected == record["project_id"].string ? [.isSelected] : [])
                }
            }.scrollContentBackground(.hidden)
            if let cursor, !cursor.isEmpty { Button(model.t("plot.more")) { Task { await load(more: true) } } }
        }.padding(.trailing, 10)
    }
    private var episodeList: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(project["title"].string ?? "").font(.system(size: 14, weight: .semibold))
                Spacer()
                Button { projectEditor = DramaSheet(value: result) } label: { Image(systemName: "pencil") }
                    .help(model.t("common.edit")).accessibilityLabel(model.t("common.edit")).disabled(!canWrite)
            }
            if project["mode"].string == "adaptation", project["source_refs"].array.isEmpty {
                Text(model.t("drama.source_pending")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.warningInk)
            }
            DisclosureGroup(model.t("properties.project")) {
                ObjectTimestampsView(localizer: model.localizer, record: project).padding(.top, 8)
            }.font(.system(size: 12))
            Button(model.t("drama.episode_new")) { episodeEditor = DramaSheet(value: .null) }.disabled(!canWrite || project["archived"].bool == true)
            List {
                ForEach(Array(result["episodes"].array.enumerated()), id: \.offset) { index, entry in
                    let record = entry["episode"]
                    Button { Task { await chooseEpisode(record["episode_id"].string ?? "") } } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(model.t("drama.episode", ["number": String(index + 1)])).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                            Text(record["title"].string ?? "").fontWeight(selectedEpisode == record["episode_id"].string ? .semibold : .regular)
                            if record["archived"].bool == true { Text(model.t("media.archived")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted) }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityAddTraits(selectedEpisode == record["episode_id"].string ? [.isSelected] : [])
                }
            }.scrollContentBackground(.hidden)
        }.padding(.horizontal, 12)
    }
    private var episodeDetail: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if episode == .null {
                    Text(model.t("drama.episode_select")).foregroundStyle(WorkbenchPalette.muted)
                    Text(project["description"].string ?? "").textSelection(.enabled)
                } else {
                    let record = episode["episode"]
                    HStack {
                        Text(record["title"].string ?? "").font(.system(size: 20, weight: .semibold))
                        Spacer()
                        Button(model.t("drama.episode_edit")) { episodeEditor = DramaSheet(value: episode) }.disabled(!canWrite || episode["is_head"].bool == false || project["archived"].bool == true)
                        Button(model.t("drama.open_script")) { if let id = record["document_id"].string { onOpenScript(id) } }
                    }
                    ObjectTimestampsView(localizer: model.localizer, record: record, updatedLabel: "properties.metadata_updated")
                    Text(model.t("drama.episode_plan")).font(.system(size: 14, weight: .semibold))
                    Text(record["plan"].string.flatMap { $0.isEmpty ? nil : $0 } ?? model.t("drama.plan_empty")).textSelection(.enabled)
                    Divider()
                    HStack {
                        Button(model.t("drama.move_up")) { Task { await move(-1) } }.disabled(!canMove(-1))
                        Button(model.t("drama.move_down")) { Task { await move(1) } }.disabled(!canMove(1))
                        Spacer()
                        Text(model.t("drama.revision", ["revision": String(record["revision"].integer ?? 1)])).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                    }
                    HStack {
                        Button(model.t("media.previous")) { Task { await chooseEpisode(selectedEpisode, revision: (record["revision"].integer ?? 1) - 1) } }.disabled((record["revision"].integer ?? 1) <= 1)
                        if episode["is_head"].bool == false {
                            Text(model.t("media.historical")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                            Button(model.t("media.latest")) { Task { await chooseEpisode(selectedEpisode) } }
                        }
                    }
                }
                let loose = model.documents.filter { $0.kind == "drama_script" && $0.value["drama_episode_id"] == .null && $0.value["draft_source_id"] == .null }
                if !loose.isEmpty {
                    Divider()
                    Text(model.t("drama.unassigned")).font(.system(size: 14, weight: .semibold))
                    ForEach(loose) { item in
                        HStack {
                            Button(item.title) { onOpenScript(item.id) }.buttonStyle(.link)
                            Spacer()
                            Button(model.t("drama.attach")) { Task { await attach(item) } }.disabled(!canWrite || project["archived"].bool == true)
                        }
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 16)
        }
    }
    private var projectRef: JSONValue { .object(["project_id": project["project_id"], "revision": project["revision"], "sha256": result["sha256"]]) }
    private var handoffObject: JSONValue {
        var fields: [String: JSONValue] = [:]
        if !selected.isEmpty { fields["project_id"] = .string(selected) }
        if !selectedEpisode.isEmpty { fields["episode_id"] = .string(selectedEpisode); if episode["episode"]["revision"].integer != nil { fields["revision"] = episode["episode"]["revision"] } }
        return .object(fields)
    }
    private func call(_ action: String, _ input: [String: JSONValue]) async -> JSONValue? {
        await model.workspaceAction(action, input: input, onFailure: { error = $0; _ = $1 })
    }
    private func load(more: Bool = false) async {
        error = nil
        var input: [String: JSONValue] = ["include_archived": .bool(includeArchived), "limit": .integer(50)]
        if more, let cursor { input["cursor"] = .string(cursor) }
        if let next = await call("hetu.drama.projects.list", input) { projects = more ? projects + next["projects"].array : next["projects"].array; cursor = next["next_cursor"].string }
        if selected.isEmpty, let first = projects.first { await choose(first["project"]["project_id"].string ?? "") }
    }
    private func choose(_ id: String) async {
        guard let next = await call("hetu.drama.projects.get", ["project_id": .string(id)]) else { return }
        result = next; selected = id
        let ids = next["episodes"].array.compactMap { $0["episode"]["episode_id"].string }
        let target = ids.contains(selectedEpisode) ? selectedEpisode : ids.first ?? ""
        episode = .null; selectedEpisode = target
        if !target.isEmpty { await chooseEpisode(target) }
    }
    private func chooseEpisode(_ id: String, revision: Int64? = nil) async {
        var input: [String: JSONValue] = ["episode_id": .string(id)]
        if let revision { input["revision"] = .integer(revision) }
        if let next = await call("hetu.drama.episodes.get", input) { episode = next; selectedEpisode = id }
    }
    private func canMove(_ delta: Int) -> Bool {
        guard canWrite, project["archived"].bool != true, episode["is_head"].bool != false,
              let index = project["episode_refs"].array.firstIndex(of: .string(selectedEpisode)) else { return false }
        return project["episode_refs"].array.indices.contains(index + delta)
    }
    private func move(_ delta: Int) async {
        guard canMove(delta), let index = project["episode_refs"].array.firstIndex(of: .string(selectedEpisode)) else { return }
        var ids = project["episode_refs"].array; ids.swapAt(index, index + delta)
        if await call("hetu.drama.episodes.reorder", ["project_ref": projectRef, "episode_refs": .array(ids), "operation_key": .string(UUID().uuidString)]) != nil { await choose(selected); await load() }
    }
    private func attach(_ item: DocumentItem) async {
        if await call("hetu.drama.projects.attach", ["project_ref": projectRef, "document_id": .string(item.id), "title": .string(item.title), "plan": .string(""), "operation_key": .string(UUID().uuidString)]) != nil { await choose(selected) }
    }
}

private struct DramaProjectEditor: View {
    let model: WorkspaceModel
    let initial: JSONValue
    let onSaved: (JSONValue) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var session: RecordMutationSession
    @State private var title: String
    @State private var description: String
    @State private var mode: String
    @State private var archived: Bool
    @State private var baseline: JSONValue
    @State private var closing = false
    @State private var composing = false
    init(model: WorkspaceModel, initial: JSONValue, onSaved: @escaping (JSONValue) -> Void) {
        self.model = model; self.initial = initial; self.onSaved = onSaved
        _session = State(initialValue: RecordMutationSession(model: model))
        _title = State(initialValue: initial["project"]["title"].string ?? "")
        _description = State(initialValue: initial["project"]["description"].string ?? "")
        _mode = State(initialValue: initial["project"]["mode"].string ?? "original")
        _archived = State(initialValue: initial["project"]["archived"].bool ?? false)
        _baseline = State(initialValue: initial)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(model.t(initial == .null ? "drama.project_new" : "common.edit")).font(.system(size: 20, weight: .semibold))
            PageAgentButton(model: model, page: "drama", object: initial == .null ? .object([:]) : .object(["project_id": initial["project"]["project_id"]]))
            if let error = session.error { Text(error).foregroundStyle(WorkbenchPalette.danger).textSelection(.enabled) }
            if session.error != nil, initial != .null, session.pending == nil {
                RecordConflictView(model: model, action: "hetu.drama.projects.get", input: ["project_id": initial["project"]["project_id"]], object: "project", baseline: $baseline)
            }
            Group {
            TextField(model.t("drama.project_name"), text: $title)
            Picker(model.t("drama.project_mode"), selection: $mode) {
                Text(model.t("drama.mode.original")).tag("original"); Text(model.t("drama.mode.adaptation")).tag("adaptation")
            }.disabled(initial != .null || session.pending != nil)
            Text(model.t("novel.synopsis")).font(.system(size: 14, weight: .semibold))
            NativeTextEditor(text: description, documentID: "project-" + (initial["project"]["project_id"].string ?? "new"), replacementVersion: 0,
                accessibleName: model.t("novel.synopsis"), editable: session.pending == nil,
                onChange: { description = $0 }, onComposition: { composing = $0 }).frame(height: 180)
            if initial != .null { Toggle(model.t("drama.archive_project"), isOn: $archived) }
            }.disabled(session.pending != nil)
            HStack {
                Button(model.t("common.cancel")) { if dirty { closing = true } else { dismiss() } }.disabled(session.pending != nil).keyboardShortcut(.cancelAction)
                Spacer()
                Button(model.t(session.pending == nil ? "common.save" : "drama.retry")) { Task { await save() } }
                    .keyboardShortcut(.defaultAction).disabled(model.busy || model.writeLocked || composing || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 600).interactiveDismissDisabled(session.pending != nil || dirty)
        .confirmationDialog(model.t("records.discard_question"), isPresented: $closing) {
            Button(model.t("records.discard"), role: .destructive) { dismiss() }
            Button(model.t("common.cancel"), role: .cancel) {}
        }
    }
    private var dirty: Bool { title != (initial["project"]["title"].string ?? "") || description != (initial["project"]["description"].string ?? "") || archived != (initial["project"]["archived"].bool ?? false) }
    private func save() async {
        var input: [String: JSONValue] = ["title": .string(title), "description": .string(description), "operation_key": .string(UUID().uuidString)]
        let action: String
        if initial == .null { action = "hetu.drama.projects.create"; input["mode"] = .string(mode) }
        else {
            action = "hetu.drama.projects.update"; input["archived"] = .bool(archived)
            input["project_ref"] = .object(["project_id": baseline["project"]["project_id"], "revision": baseline["project"]["revision"], "sha256": baseline["sha256"]])
        }
        if let next = await session.save(action, input: input) { onSaved(next); dismiss() }
    }
}

private struct DramaEpisodeEditor: View {
    let model: WorkspaceModel
    let projectResult: JSONValue
    let initial: JSONValue
    let onSaved: (JSONValue) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var session: RecordMutationSession
    @State private var title: String
    @State private var plan: String
    @State private var archived: Bool
    @State private var baseline: JSONValue
    @State private var projectBaseline: JSONValue
    @State private var closing = false
    @State private var composing = false
    init(model: WorkspaceModel, projectResult: JSONValue, initial: JSONValue, onSaved: @escaping (JSONValue) -> Void) {
        self.model = model; self.projectResult = projectResult; self.initial = initial; self.onSaved = onSaved
        _session = State(initialValue: RecordMutationSession(model: model))
        _title = State(initialValue: initial["episode"]["title"].string ?? "")
        _plan = State(initialValue: initial["episode"]["plan"].string ?? "")
        _archived = State(initialValue: initial["episode"]["archived"].bool ?? false)
        _baseline = State(initialValue: initial)
        _projectBaseline = State(initialValue: projectResult)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(model.t(initial == .null ? "drama.episode_new" : "drama.episode_edit")).font(.system(size: 20, weight: .semibold))
            PageAgentButton(model: model, page: "episode", object: initial == .null ? .object(["project_id": projectResult["project"]["project_id"]]) : .object(["project_id": projectResult["project"]["project_id"], "episode_id": initial["episode"]["episode_id"], "revision": initial["episode"]["revision"]]))
            if let error = session.error { Text(error).foregroundStyle(WorkbenchPalette.danger).textSelection(.enabled) }
            if session.error != nil, initial != .null, session.pending == nil {
                RecordConflictView(model: model, action: "hetu.drama.episodes.get", input: ["episode_id": initial["episode"]["episode_id"]], object: "episode", baseline: $baseline)
            }
            if session.error != nil, initial == .null, session.pending == nil {
                RecordConflictView(model: model, action: "hetu.drama.projects.get", input: ["project_id": projectResult["project"]["project_id"]], object: "project", baseline: $projectBaseline)
            }
            Group {
            TextField(model.t("drama.episode_name"), text: $title)
            Text(model.t("drama.episode_plan")).font(.system(size: 14, weight: .semibold))
            NativeTextEditor(text: plan, documentID: "episode-" + (initial["episode"]["episode_id"].string ?? "new"), replacementVersion: 0,
                accessibleName: model.t("drama.episode_plan"), editable: session.pending == nil,
                onChange: { plan = $0 }, onComposition: { composing = $0 }).frame(height: 220)
            if initial != .null { Toggle(model.t("drama.archive_episode"), isOn: $archived) }
            }.disabled(session.pending != nil)
            HStack {
                Button(model.t("common.cancel")) { if dirty { closing = true } else { dismiss() } }.disabled(session.pending != nil).keyboardShortcut(.cancelAction)
                Spacer()
                Button(model.t(session.pending == nil ? "common.save" : "drama.retry")) { Task { await save() } }.keyboardShortcut(.defaultAction)
                    .disabled(model.busy || model.writeLocked || composing || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 640).interactiveDismissDisabled(session.pending != nil || dirty)
        .confirmationDialog(model.t("records.discard_question"), isPresented: $closing) {
            Button(model.t("records.discard"), role: .destructive) { dismiss() }
            Button(model.t("common.cancel"), role: .cancel) {}
        }
    }
    private var dirty: Bool { title != (initial["episode"]["title"].string ?? "") || plan != (initial["episode"]["plan"].string ?? "") || archived != (initial["episode"]["archived"].bool ?? false) }
    private func save() async {
        let projectRef: JSONValue = baseline["project_ref"] == .null ? .object(["project_id": projectBaseline["project"]["project_id"], "revision": projectBaseline["project"]["revision"], "sha256": projectBaseline["sha256"]]) : baseline["project_ref"]
        var input: [String: JSONValue] = ["project_ref": projectRef,
            "title": .string(title), "plan": .string(plan), "operation_key": .string(UUID().uuidString)]
        let action: String
        if initial == .null { action = "hetu.drama.episodes.create"; input["language_tag"] = .string(model.locale == "en" ? "en" : "zh-CN") }
        else {
            action = "hetu.drama.episodes.update"; input["episode_id"] = initial["episode"]["episode_id"]; input["archived"] = .bool(archived)
            input["expected"] = .object(["revision": baseline["episode"]["revision"], "sha256": baseline["sha256"]])
        }
        if let next = await session.save(action, input: input) { onSaved(next); dismiss() }
    }
}
