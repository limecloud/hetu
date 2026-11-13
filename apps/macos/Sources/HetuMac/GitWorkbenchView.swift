import SwiftUI
import HetuCore
import HetuNative

struct GitWorkbenchView: View {
    let model: WorkspaceModel
    @SceneStorage private var message: String
    @AppStorage("Hetu.git.authorName") private var authorName = ""
    @AppStorage("Hetu.git.authorEmail") private var authorEmail = ""
    @State private var status: JSONValue = .null
    @State private var selected: Set<String> = []
    @State private var tab = "changes"
    @State private var branch = "main"
    @State private var records: [JSONValue] = []
    @State private var cursor: String?
    @State private var error: String?
    @State private var pending: DramaOperation?
    @State private var preview: DramaSheet?
    @State private var difference: DramaSheet?
    @State private var confirmInit = false
    private var held: Bool { pending != nil || !model.pendingStructureOperations.isEmpty }
    init(model: WorkspaceModel) {
        self.model = model
        _message = SceneStorage(wrappedValue: "", "Hetu.git.message." + model.workspaceID)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            WorkbenchHeading(title: model.t("git.title"), subtitle: model.t("git.description"), artwork: status["initialized"].bool == true ? "review-desk" : "") {
                Button(model.t("common.refresh")) { Task { await load() } }.disabled(pending != nil)
            }
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if pending != nil { Button(model.t("drama.retry")) { Task { await perform() } } }
            if status["initialized"].bool == false {
                Text(model.t("git.init_note")).foregroundStyle(.secondary)
                TextField(model.t("git.branch"), text: $branch).textFieldStyle(.roundedBorder).frame(maxWidth: 320)
                Button(model.t("git.init")) { confirmInit = true }.disabled(held || branch.isEmpty)
                    .buttonStyle(WorkbenchButtonStyle(primary: true))
                WorkbenchEmptyState(title: model.t("git.no_history"), detail: model.t("git.empty_detail"), artwork: "review-desk")
            } else if status["initialized"].bool == true {
                Text(status["head"]["reference"].string?.replacingOccurrences(of: "refs/heads/", with: "") ?? model.t("git.detached")).font(.headline)
                Text(status["head"]["commit_id"].string ?? model.t("git.first_commit")).font(.caption.monospaced()).textSelection(.enabled)
                Text(model.t("git.index_note")).font(.caption).foregroundStyle(.secondary)
                Picker(model.t("git.section"), selection: $tab) {
                    Text(model.t("git.changes")).tag("changes")
                    Text(model.t("git.previews")).tag("previews")
                    Text(model.t("git.history")).tag("history")
                }.pickerStyle(.segmented)
                if tab == "changes" { changes } else { history }
            } else { ProgressView() }
        }.padding(28).workbenchPage().disabled(model.busy)
        .task { await load(resetSelection: true) }
        .onChange(of: tab) { _, _ in Task { await loadRecords() } }
        .confirmationDialog(model.t("git.init_confirm"), isPresented: $confirmInit) {
            Button(model.t("git.init")) {
                pending = DramaOperation(action: "hetu.git.init", input: ["branch": .string(branch), "operation_key": .string(UUID().uuidString)])
                Task { await perform() }
            }
            Button(model.t("common.cancel"), role: .cancel) {}
        } message: { Text(model.t("git.init_note")) }
        .sheet(item: $preview, onDismiss: { Task { await load() } }) { request in
            GitSnapshotReviewSheet(model: model, snapshotID: request.value.string ?? "")
        }
        .sheet(item: $difference) { request in GitDifferenceSheet(model: model, path: request.value.string ?? "") }
    }
    private var changes: some View {
        HSplitView {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Button(model.t("git.select_all")) { selected = Set(paths) }.disabled(held)
                    Button(model.t("git.select_none")) { selected = [] }.disabled(held)
                    Spacer()
                }
                if paths.isEmpty { Text(model.t("git.clean")).foregroundStyle(.secondary) }
                ScrollView {
                  LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(status["changes"].array.enumerated()), id: \.offset) { _, item in
                        let path = item["path"].string ?? ""
                        HStack {
                            Toggle(isOn: Binding(get: { selected.contains(path) }, set: { if $0 { selected.insert(path) } else { selected.remove(path) } })) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(path).lineLimit(2)
                                    if item["staged"].bool == true { Text(model.t("git.also_staged")).font(.caption).foregroundStyle(.secondary) }
                                }
                            }.disabled(held)
                            Spacer()
                            if let size = item["size_bytes"].integer { Text(model.localizer.byteCount(size)).font(.caption).foregroundStyle(.secondary) }
                            Button(model.t("git.diff")) { difference = DramaSheet(value: .string(path)) }.buttonStyle(.borderless).accessibilityLabel(model.t("git.diff_file", ["path": path]))
                        }
                        Divider()
                    }
                  }.padding(.vertical, 4)
                }
            }.frame(minWidth: 280)
            VStack(alignment: .leading, spacing: 12) {
                Text(model.t("git.snapshot")).font(.headline)
                TextField(model.t("git.author_name"), text: $authorName).textFieldStyle(.roundedBorder)
                TextField(model.t("git.author_email"), text: $authorEmail).textFieldStyle(.roundedBorder)
                Text(model.t("git.identity_note")).font(.caption).foregroundStyle(.secondary)
                TextField(model.t("git.message"), text: $message, axis: .vertical).lineLimit(3...6).textFieldStyle(.roundedBorder)
                Text(model.t("git.selected_count", ["count": String(selected.count)])).font(.caption)
                Button(model.t("git.prepare")) {
                    pending = DramaOperation(action: "hetu.git.snapshot", input: ["phase": .string("prepare"), "expected_head": status["head"], "message": .string(message), "author": .object(["name": .string(authorName), "email": .string(authorEmail)]), "selected_paths": .array(selected.sorted().map(JSONValue.string)), "operation_key": .string(UUID().uuidString)])
                    Task { await perform() }
                }.disabled(held || selected.isEmpty || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || authorName.isEmpty || authorEmail.isEmpty)
                Text(model.t("git.prepare_note")).font(.caption).foregroundStyle(.secondary)
                Spacer()
            }.disabled(held).padding(.leading, 16).frame(minWidth: 240, idealWidth: 300, maxWidth: 360)
        }
    }
    private var history: some View {
        VStack(alignment: .leading) {
            if records.isEmpty { Text(model.t(tab == "history" ? "git.no_history" : "git.no_previews")).foregroundStyle(.secondary) }
            ScrollView {
              LazyVStack(alignment: .leading, spacing: 8) {
                ForEach(Array(records.enumerated()), id: \.offset) { _, record in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(record["message"].string ?? "").lineLimit(3).textSelection(.enabled)
                        Text((record["author"]["name"].string ?? "") + " <" + (record["author"]["email"].string ?? "") + ">").font(.caption).foregroundStyle(.secondary)
                        if let timestamp = record["timestamp"].integer { Text(Date(timeIntervalSince1970: Double(timestamp)), style: .date).font(.caption).foregroundStyle(.secondary) }
                        if tab == "previews" {
                            Button(model.t("git.open_preview")) { preview = DramaSheet(value: record["snapshot_id"]) }.buttonStyle(.borderless)
                        } else { Text(record["commit_id"].string ?? "").font(.caption.monospaced()).textSelection(.enabled) }
                    }.padding(.vertical, 4).accessibilityElement(children: .contain)
                    Divider()
                }
              }.frame(maxWidth: .infinity, alignment: .leading)
            }
            if cursor != nil { Button(model.t("plot.more")) { Task { await loadRecords(more: true) } } }
        }
    }
    private var paths: [String] { status["changes"].array.compactMap { $0["path"].string } }
    private func load(resetSelection: Bool = false) async {
        error = nil
        guard let next = await model.workspaceAction("hetu.git.status", input: [:], onFailure: { error = $0; _ = $1 }) else { return }
        status = next
        selected = resetSelection ? Set(paths) : selected.intersection(paths)
        if tab != "changes", status["initialized"].bool == true { await loadRecords() }
    }
    private func loadRecords(more: Bool = false) async {
        guard tab != "changes", status["initialized"].bool == true else { return }
        var input: [String: JSONValue] = ["limit": .integer(30)]
        if more, let cursor { input["cursor"] = .string(cursor) }
        let action = tab == "history" ? "hetu.git.log" : "hetu.git.list_snapshots"
        guard let next = await model.workspaceAction(action, input: input, onFailure: { error = $0; _ = $1 }) else { return }
        let rows = next[tab == "history" ? "commits" : "snapshots"].array
        records = more ? records + rows : rows
        cursor = next["next_cursor"].string
    }
    private func perform() async {
        guard let operation = pending else { return }; error = nil
        guard let result = await model.workspaceAction(operation.action, input: operation.input, onFailure: { error = $0; if $1 { pending = nil } }) else { return }
        pending = nil
        if let id = result["snapshot"]["snapshot_id"].string { preview = DramaSheet(value: .string(id)) }
        await load(resetSelection: operation.action == "hetu.git.init")
    }
}

struct GitSnapshotReviewSheet: View {
    let model: WorkspaceModel
    let snapshotID: String
    @Environment(\.dismiss) private var dismiss
    @State private var context: JSONValue = .null
    @State private var completed: JSONValue = .null
    @State private var error: String?
    @State private var confirmed = false
    @State private var pending: DramaOperation?
    @State private var difference: DramaSheet?
    private var snapshot: JSONValue { context["snapshot"] }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.t("git.review")).font(.title2)
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if completed != .null {
                Label(model.t("git.committed"), systemImage: "checkmark.circle")
                Text(completed["commit_id"].string ?? "").font(.caption.monospaced()).textSelection(.enabled)
            } else if snapshot != .null {
                Text(snapshot["message"].string ?? "").font(.headline).textSelection(.enabled)
                Text((snapshot["author"]["name"].string ?? "") + " <" + (snapshot["author"]["email"].string ?? "") + ">").textSelection(.enabled)
                Text(snapshot["head"]["reference"].string ?? model.t("git.detached")).font(.caption)
                Text(snapshot["head"]["commit_id"].string ?? model.t("git.first_commit")).font(.caption.monospaced()).textSelection(.enabled)
                Text(model.t("git.digest") + ": " + (context["snapshot_sha256"].string ?? "")).font(.caption.monospaced()).textSelection(.enabled)
                if context["is_current"].bool == false { Text(model.t("git.stale")).foregroundStyle(.orange) }
                Text(model.t("git.selected_count", ["count": String(snapshot["selection"].array.count)])).font(.headline)
                ScrollView {
                  LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(snapshot["selection"].array.enumerated()), id: \.offset) { _, item in
                        HStack {
                            Text(item["path"].string ?? "").textSelection(.enabled)
                            Spacer()
                            if item["after_oid"] == .null { Text(model.t("git.deleted")).font(.caption) }
                            Button(model.t("git.diff")) { difference = DramaSheet(value: item["path"]) }.buttonStyle(.borderless).accessibilityLabel(model.t("git.diff_file", ["path": item["path"].string ?? ""]))
                        }.accessibilityElement(children: .contain)
                        Divider()
                    }
                  }
                }.frame(minHeight: 130)
                DisclosureGroup(model.t("git.excluded_count", ["count": String(snapshot["excluded_changes"].array.count)])) {
                    ScrollView { Text(snapshot["excluded_changes"].array.compactMap { $0["path"].string }.joined(separator: "\n")).font(.caption).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled) }.frame(maxHeight: 90)
                }
                Text(model.t("git.confirm_note")).font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Button(model.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                if pending != nil { Button(model.t("drama.retry")) { Task { await perform() } } }
                else if completed == .null {
                    Button(model.t("common.refresh")) { Task { await load() } }
                    Button(model.t("git.approve_commit")) { confirmed = true }.disabled(context["is_current"].bool != true || !model.pendingStructureOperations.isEmpty)
                }
            }
        }.padding(24).frame(width: 720, height: 600).disabled(model.busy).interactiveDismissDisabled(model.busy)
        .task { await load() }
        .confirmationDialog(model.t("git.commit_confirm"), isPresented: $confirmed) {
            Button(model.t("git.approve_commit")) {
                pending = DramaOperation(action: "hetu.git.approve_snapshot", input: ["snapshot_id": .string(snapshotID), "snapshot_sha256": context["snapshot_sha256"], "operation_key": .string(UUID().uuidString)])
                Task { await perform() }
            }
            Button(model.t("common.cancel"), role: .cancel) {}
        } message: { Text(model.t("git.confirm_note")) }
        .sheet(item: $difference) { request in GitDifferenceSheet(model: model, path: request.value.string ?? "", snapshotID: snapshotID) }
    }
    private func load() async {
        error = nil
        if let result = await model.workspaceAction("hetu.git.get_snapshot", input: ["snapshot_id": .string(snapshotID)], onFailure: { error = $0; _ = $1 }) { context = result; completed = result["execution"] }
    }
    private func perform() async {
        guard let operation = pending else { return }; error = nil
        guard let result = await model.workspaceAction(operation.action, input: operation.input, onFailure: { error = $0; if $1 { pending = nil } }) else { return }
        if operation.action == "hetu.git.approve_snapshot" {
            pending = DramaOperation(action: "hetu.git.snapshot", input: ["phase": .string("execute"), "snapshot_id": .string(snapshotID), "operation_key": .string(UUID().uuidString)])
            await perform()
        } else { completed = result; pending = nil }
    }
}

struct GitDifferenceSheet: View {
    let model: WorkspaceModel
    let path: String
    var snapshotID: String?
    @Environment(\.dismiss) private var dismiss
    @State private var result: JSONValue = .null
    @State private var difference: RevisionDifference?
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.t("git.diff")).font(.title2)
            Text(path).font(.headline).textSelection(.enabled)
            if let error { Text(error).foregroundStyle(.red) }
            if result != .null {
                HStack {
                    Text(model.t("git.before_size", ["size": model.localizer.byteCount(result["before_size"].integer ?? 0)]))
                    Text(model.t("git.after_size", ["size": model.localizer.byteCount(result["after_size"].integer ?? 0)]))
                }.font(.caption).foregroundStyle(.secondary)
                if result["binary"].bool == true || result["truncated"].bool == true { Text(model.t("git.binary_note")).foregroundStyle(.secondary) }
                else if let difference {
                    if !difference.withinBudget || difference.totalChanges > difference.changes.count { Text(model.t("git.diff_budget")).font(.caption).foregroundStyle(.orange) }
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 4) {
                            ForEach(difference.changes) { item in
                                Text((item.added ? "+ " : "− ") + String(item.line) + "  " + item.text).font(.system(.caption, design: .monospaced)).foregroundStyle(item.added ? .green : .red).textSelection(.enabled)
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                    DisclosureGroup(model.t("review.side_by_side")) {
                        HSplitView {
                            ScrollView { Text(result["before"].string ?? "").textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                            ScrollView { Text(result["after"].string ?? "").textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                        }.frame(height: 190)
                    }
                }
            }
            Spacer(minLength: 0)
            Button(model.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction)
        }.padding(24).frame(width: 820, height: 600).task {
            var input: [String: JSONValue] = ["path": .string(path)]
            if let snapshotID { input["snapshot_id"] = .string(snapshotID) }
            if let data = await model.workspaceAction(snapshotID == nil ? "hetu.git.diff" : "hetu.git.snapshot_diff", input: input, onFailure: { error = $0; _ = $1 }) {
                result = data
                let before = data["before"].string ?? "", after = data["after"].string ?? ""
                if data["binary"].bool == false, data["truncated"].bool == false { difference = await Task.detached { RevisionDifference.compare(before: before, after: after) }.value }
            }
        }
    }
}
