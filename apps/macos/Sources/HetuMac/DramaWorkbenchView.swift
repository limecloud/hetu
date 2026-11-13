import SwiftUI
import HetuCore
import HetuNative

struct DramaSheet: Identifiable {
    let id = UUID()
    let value: JSONValue
}
struct DramaOperation {
    let action: String
    let input: [String: JSONValue]
}
struct DramaWorkbenchView: View {
    let model: WorkspaceModel
    let onOpenScript: (String) -> Void
    @State private var documentID = ""
    @State private var plots: [JSONValue] = []
    @State private var plotCursor: String?
    @State private var plotRevision = ""
    @State private var summaries: [JSONValue] = []
    @State private var cursor: String?
    @State private var result: JSONValue = .null
    @State private var blueprint: JSONValue = .null
    @State private var plot: JSONValue = .null
    @State private var comparison: JSONValue = .null
    @State private var comparisons: [JSONValue] = []
    @State private var comparisonCursor: String?
    @State private var error: String?
    @State private var buildSheet: DramaSheet?
    @State private var editSheet: DramaSheet?
    @State private var sourceSheet: DramaSheet?
    @State private var scriptSheet: DramaSheet?
    @State private var pending: DramaOperation?
    private var skeleton: JSONValue { result["skeleton"] }
    private var identity: String { skeleton["skeleton_id"].string ?? "" }
    private var hasPending: Bool { pending != nil || !model.pendingStructureOperations.isEmpty }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if pending != nil { Button(model.t("drama.retry")) { Task { await performPending() } } }
            if pending == nil, model.pendingStructureOperations.contains(where: { $0.action.hasPrefix("hetu.drama.") }) {
                Text(model.t("drama.pending_note")).foregroundStyle(.orange)
                ForEach(Array(model.pendingStructureOperations.filter { $0.action.hasPrefix("hetu.drama.") }.enumerated()), id: \.offset) { index, operation in
                    Button(model.t("drama.resume_pending", ["number": String(index + 1)])) {
                        pending = DramaOperation(action: operation.action, input: operation.input)
                        Task { await performPending() }
                    }
                }
            }
            Divider()
            HSplitView {
                history.frame(minWidth: 180, idealWidth: 220, maxWidth: 280)
                if skeleton == .null {
                    WorkbenchEmptyState(title: model.t("drama.empty"), detail: model.t("drama.empty_detail"), artwork: "drama-stage")
                } else { content.frame(minWidth: 380) }
            }
        }.padding(28).workbenchPage().disabled(model.busy)
        .task { documentID = model.documents.first?.id ?? ""; await loadHistory() }
        .onChange(of: documentID) { _, _ in Task { await loadPlots() } }
        .sheet(item: $buildSheet) { request in
            DramaBuildSheet(model: model, plot: request.value) { next in Task { await install(next); await loadHistory() } }
        }
        .sheet(item: $editSheet) { request in
            DramaEditorSheet(model: model, snapshot: result, blueprint: blueprint, plot: plot, request: request.value) { next in
                Task { await install(next); await loadHistory() }
            }
        }
        .sheet(item: $sourceSheet) { request in PlotSourceView(model: model, source: request.value) }
        .sheet(item: $scriptSheet) { request in
            DramaScriptSheet(model: model, snapshot: request.value, onOpen: onOpenScript)
        }
    }
    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            WorkbenchHeading(title: model.t("drama.workbench_title"), subtitle: model.t("drama.description"), artwork: skeleton == .null ? "" : "drama-stage") {
                Button(model.t("common.refresh")) { Task { await loadHistory(); await loadPlots(); if !identity.isEmpty { await read(skeleton) } } }.disabled(pending != nil)
            }
            HStack {
                Picker(model.t("plot.document"), selection: $documentID) {
                    Text(model.t("document.select")).tag("")
                    ForEach(model.documents) { Text($0.title).tag($0.id) }
                }.frame(maxWidth: 280)
                Picker(model.t("validation.plot_revision"), selection: $plotRevision) {
                    Text(model.t("plot.unspecified")).tag("")
                    ForEach(Array(plots.enumerated()), id: \.offset) { _, item in
                        Text(model.localizer.date(item["created_at"].string ?? "") + "  " + model.t("plot.summary", ["nodes": String(item["node_count"].integer ?? 0), "confirmed": String(item["confirmed_count"].integer ?? 0)])).tag(item["plot_revision_id"].string ?? "")
                    }
                }.frame(maxWidth: 380)
                Button(model.t("drama.build")) {
                    Task { if let next = await model.readPlot(plotRevision, onFailure: { error = $0 }) { buildSheet = DramaSheet(value: next["plot"]) } }
                }.disabled(plotRevision.isEmpty || hasPending)
            }.disabled(hasPending)
            if plotCursor != nil { Button(model.t("validation.more_plots")) { Task { await loadPlots(more: true) } } }
        }
    }
    private var history: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                Text(model.t("drama.history")).font(.headline)
                if summaries.isEmpty { Text(model.t("drama.no_history")).foregroundStyle(.secondary) }
                ForEach(Array(summaries.enumerated()), id: \.offset) { _, item in
                    Button { Task { await read(item) } } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(model.localizer.date(item["created_at"].string ?? ""))
                            Text(model.t("drama.revision", ["revision": String(item["revision"].integer ?? 0)]))
                            Text(model.t("drama.summary", ["episodes": String(item["episode_count"].integer ?? 0), "scenes": String(item["scene_count"].integer ?? 0)])).font(.caption)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                            .background(skeleton["skeleton_id"] == item["skeleton_id"] && skeleton["revision"] == item["revision"] ? Color.accentColor.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 6))
                    }.buttonStyle(.plain).disabled(pending != nil)
                }
                if cursor != nil { Button(model.t("plot.more")) { Task { await loadHistory(more: true) } } }
                let scripts = model.documents.filter { $0.kind == "drama_script" }
                if !scripts.isEmpty {
                    Divider().padding(.vertical, 8)
                    Text(model.t("drama.script")).font(.headline)
                    ForEach(scripts) { script in
                        Button { onOpenScript(script.id) } label: {
                            Label(script.title, systemImage: "doc.text")
                                .frame(maxWidth: .infinity, alignment: .leading).padding(8)
                        }.buttonStyle(.plain)
                    }
                }
            }.padding(.trailing, 10)
        }
    }
    private var content: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text(model.t("drama.revision", ["revision": String(skeleton["revision"].integer ?? 0)])).font(.headline)
                    Text(model.t("plot.coverage." + (skeleton["status"].string ?? "partial"))).font(.caption)
                    Spacer()
                    Button(model.t("script.create")) { scriptSheet = DramaSheet(value: result) }.disabled(hasPending)
                    Button(model.t("drama.add_episode")) { Task { await edit([.object(["type": .string("add_episode"), "index": .integer(Int64(skeleton["episodes"].array.count))])]) } }.disabled(hasPending)
                    Button(model.t("drama.compare")) { Task { await compare() } }.disabled(hasPending)
                }
                Text(model.t("drama.source_note", ["revision": String(skeleton["blueprint_revision"].integer ?? 0)])).font(.caption).foregroundStyle(.secondary)
                if result["stale"].bool == true { Label(model.t("drama.stale"), systemImage: "clock.badge.exclamationmark").foregroundStyle(.orange) }
                ForEach(Array(skeleton["episodes"].array.enumerated()), id: \.offset) { e, episode in
                    episodeView(episode, index: e)
                    Divider()
                }
                comparisonView
            }.padding(.leading, 14)
        }
    }
    private func episodeView(_ episode: JSONValue, index: Int) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(model.t("drama.episode", ["number": String(index + 1)]) + " " + (episode["title"].string ?? "")).font(.headline)
                Spacer()
                Button(model.t("common.edit")) { editSheet = DramaSheet(value: .object(["episode": episode])) }
                Button(model.t("drama.add_scene")) { Task { await edit([.object(["type": .string("add_scene"), "episode_id": episode["episode_id"], "index": .integer(Int64(episode["scenes"].array.count)), "plot_node_refs": .array([])])]) } }
            }.disabled(hasPending)
            ForEach(Array(episode["scenes"].array.enumerated()), id: \.offset) { s, scene in sceneView(scene, episode: episode, episodeIndex: index, index: s) }
        }
    }
    private func sceneView(_ scene: JSONValue, episode: JSONValue, episodeIndex: Int, index: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(model.t("drama.scene", ["episode": String(episodeIndex + 1), "scene": String(index + 1)])).font(.headline)
                Text(scene["title"].string ?? "")
                Spacer()
                Button(model.t("common.edit")) { editSheet = DramaSheet(value: .object(["scene": scene, "episode": episode])) }
                Button { Task { await move(scene, episode: episode, index: index - 1) } } label: { Image(systemName: "arrow.up") }.help(model.t("drama.move_up")).accessibilityLabel(model.t("drama.move_up")).disabled(index == 0)
                Button { Task { await move(scene, episode: episode, index: index + 1) } } label: { Image(systemName: "arrow.down") }.help(model.t("drama.move_down")).accessibilityLabel(model.t("drama.move_down")).disabled(index + 1 == episode["scenes"].array.count)
            }.disabled(hasPending)
            Text((scene["location_ref"].string.map { displayName(model, reference: $0, blueprint: blueprint) } ?? model.t("plot.unspecified")) + "  " + model.t("location." + (scene["interior_exterior"].string ?? "unknown")) + "  " + model.t("plot.time_of_day." + (scene["time_of_day"].string ?? "unknown")))
            Text(scene["character_refs"].array.compactMap(\.string).map { displayName(model, reference: $0, blueprint: blueprint) }.joined(separator: model.locale == "en" ? ", " : "、")).foregroundStyle(.secondary)
            if !scene["missing_fields"].array.isEmpty {
                Text(model.t("plot.missing_fields", ["fields": scene["missing_fields"].array.compactMap(\.string).map { model.t("drama.missing." + $0) }.joined(separator: model.locale == "en" ? ", " : "、")])).font(.caption).foregroundStyle(.orange)
            }
            if let note = scene["adaptation_note"].string, !note.isEmpty { Text(note).font(.caption).textSelection(.enabled) }
            DisclosureGroup(model.t("drama.sources", ["count": String(scene["source_refs"].array.count)])) {
                ForEach(Array(scene["source_refs"].array.enumerated()), id: \.offset) { _, source in
                    HStack(alignment: .top) {
                        Text(source["quote"].string ?? "").lineLimit(3).textSelection(.enabled)
                        Spacer()
                        Button(model.t("plot.source")) { sourceSheet = DramaSheet(value: source) }
                    }.font(.caption)
                }
            }
            Text(model.t("drama.no_generated_text")).font(.caption).foregroundStyle(.secondary)
        }.padding(22).background(WorkbenchPalette.page, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(WorkbenchPalette.line, lineWidth: 1))
            .accessibilityElement(children: .contain)
    }
    private var comparisonView: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.t("drama.comparisons")).font(.headline)
            Text(model.t("drama.comparison_note")).font(.caption).foregroundStyle(.secondary)
            ForEach(Array(comparisons.enumerated()), id: \.offset) { _, item in
                Button(model.localizer.date(item["created_at"].string ?? "") + "  " + model.t("drama.revision", ["revision": String(item["skeleton_ref"]["revision"].integer ?? 0)])) {
                    Task { if let next = await call("hetu.drama.get_comparison", ["comparison_id": item["comparison_id"]]) { await installComparison(next) } }
                }
            }
            if comparisonCursor != nil { Button(model.t("plot.more")) { Task { await loadComparisons(more: true) } } }
            if comparison != .null {
                if comparison["stale"].bool == true { Text(model.t("drama.comparison_stale")).foregroundStyle(.orange) }
                Text(model.t("drama.comparison_count", ["count": String(comparison["comparison"]["items"].array.count)]))
                ForEach(Array(comparison["comparison"]["items"].array.prefix(200).enumerated()), id: \.offset) { _, item in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(model.t("drama.diff." + (item["kind"].string ?? "unmapped"))).font(.headline)
                        if let label = comparisonSceneLabel(item) { Text(label).font(.caption) }
                        ForEach(Array(item["source_refs"].array.enumerated()), id: \.offset) { _, source in
                            Button(source["quote"].string ?? model.t("plot.source")) { sourceSheet = DramaSheet(value: source) }.buttonStyle(.link).lineLimit(2)
                        }
                        if !item["details"]["fields"].array.isEmpty {
                            Text(item["details"]["fields"].array.compactMap(\.string).map { model.t("drama.field." + $0) }.joined(separator: model.locale == "en" ? ", " : "、")).font(.caption)
                        }
                        if item["details"]["source_range"] != .null {
                            Text(model.t("drama.unmapped_note")).font(.caption).foregroundStyle(.secondary)
                            Button(model.t("plot.source")) { Task { await showRange(item["details"]["source_range"]) } }
                        }
                    }
                }
                if comparison["comparison"]["items"].array.count > 200 { Text(model.t("drama.comparison_limit")).font(.caption) }
            }
        }
    }
    private func call(_ action: String, _ input: [String: JSONValue]) async -> JSONValue? {
        await model.dramaAction(action, input: input, onFailure: { error = $0; _ = $1 })
    }
    private func comparisonSceneLabel(_ item: JSONValue) -> String? {
        for episode in skeleton["episodes"].array {
            if let scene = episode["scenes"].array.first(where: { $0["scene_id"] == item["scene_id"] }) {
                return model.t("drama.scene", ["episode": String(episode["episode_number"].integer ?? 0), "scene": String(scene["scene_number"].integer ?? 0)])
            }
        }
        return nil
    }
    private func showRange(_ range: JSONValue) async {
        guard let document = await model.readPlotSource(range, onFailure: { error = $0 }),
              let content = document["content"].string,
              let start = range["byte_start"].integer, let end = range["byte_end"].integer,
              start >= 0, end > start, end <= content.utf8.count else { return }
        let bytes = Array(content.utf8)
        guard let quote = String(bytes: bytes[Int(start)..<Int(end)], encoding: .utf8) else { error = model.t("error.hetu.invalid_source_ref"); return }
        var source = range.object; source["quote"] = .string(quote)
        sourceSheet = DramaSheet(value: .object(source))
    }
    private func loadPlots(more: Bool = false) async {
        guard !documentID.isEmpty else { plots = []; plotRevision = ""; return }
        if let page = await model.listPlots(documentID: documentID, cursor: more ? plotCursor : nil, onFailure: { error = $0 }) {
            plots = more ? plots + page["plots"].array : page["plots"].array; plotCursor = page["next_cursor"].string
            if !more { plotRevision = plots.first?["plot_revision_id"].string ?? "" }
        }
    }
    private func loadHistory(more: Bool = false) async {
        var input: [String: JSONValue] = ["limit": .integer(50)]
        if more, let cursor { input["cursor"] = .string(cursor) }
        if let page = await call("hetu.drama.list_skeletons", input) { summaries = more ? summaries + page["skeletons"].array : page["skeletons"].array; cursor = page["next_cursor"].string }
    }
    private func read(_ item: JSONValue) async {
        error = nil
        if let next = await call("hetu.drama.get_skeleton", ["skeleton_id": item["skeleton_id"], "revision": item["revision"]]) { await install(next) }
    }
    private func install(_ next: JSONValue) async {
        result = next; comparison = .null; comparisons = []; blueprint = .null; plot = .null
        if let revision = skeleton["blueprint_revision"].integer, let bp = await model.readBibleRevision(revision, onFailure: { error = $0 }) { blueprint = bp["blueprint"] }
        if let p = await model.readPlot(skeleton["plot_revision_id"].string ?? "", onFailure: { error = $0 }) { plot = p["plot"] }
        await loadComparisons()
    }
    private func loadComparisons(more: Bool = false) async {
        guard !identity.isEmpty else { return }
        var input: [String: JSONValue] = ["skeleton_id": .string(identity), "limit": .integer(50)]
        if more, let comparisonCursor { input["cursor"] = .string(comparisonCursor) }
        if let page = await call("hetu.drama.list_comparisons", input) { comparisons = more ? comparisons + page["comparisons"].array : page["comparisons"].array; comparisonCursor = page["next_cursor"].string }
    }
    private func installComparison(_ next: JSONValue) async {
        let reference = next["comparison"]["skeleton_ref"]
        if reference["skeleton_id"] != skeleton["skeleton_id"] || reference["revision"] != skeleton["revision"] || reference["sha256"] != result["sha256"] {
            guard let fixed = await call("hetu.drama.get_skeleton", ["skeleton_id": reference["skeleton_id"], "revision": reference["revision"]]) else { return }
            await install(fixed)
        }
        comparison = next
    }
    private func move(_ scene: JSONValue, episode: JSONValue, index: Int) async {
        await edit([.object(["type": .string("move_scene"), "scene_id": scene["scene_id"], "episode_id": episode["episode_id"], "index": .integer(Int64(index))])])
    }
    private func edit(_ changes: [JSONValue]) async {
        guard !hasPending else { return }
        pending = DramaOperation(action: "hetu.drama.edit_skeleton", input: ["skeleton_id": skeleton["skeleton_id"], "expected": .object(["revision": skeleton["revision"], "sha256": result["sha256"]]), "typed_changes": .array(changes), "operation_key": .string(UUID().uuidString)])
        await performPending()
    }
    private func compare() async {
        guard !hasPending else { return }
        var sources: [JSONValue] = []
        for source in skeleton["source_revisions"].array {
            guard let doc = await call("hetu.documents.get", ["document_id": source["document_id"]]) else { return }
            sources.append(.object(["document_id": source["document_id"], "revision_id": doc["revision"]["revision_id"], "sha256": doc["revision"]["sha256"], "source_format": doc["revision"]["source_format"], "size_bytes": doc["revision"]["size_bytes"]]))
        }
        pending = DramaOperation(action: "hetu.drama.compare", input: ["skeleton_ref": .object(["skeleton_id": skeleton["skeleton_id"], "revision": skeleton["revision"], "sha256": result["sha256"]]), "source_revisions": .array(sources), "save_result": .bool(true), "operation_key": .string(UUID().uuidString)])
        await performPending()
    }
    private func performPending() async {
        guard let operation = pending else { return }
        error = nil
        if let next = await model.dramaAction(operation.action, input: operation.input, onFailure: { error = $0; if $1 { pending = nil } }) {
            pending = nil
            if operation.action == "hetu.drama.compare" { await installComparison(next); await loadComparisons() }
            else if operation.action == "hetu.drama.create_script" {
                if let id = next["document"]["document_id"].string { onOpenScript(id) }
            } else { await install(next); await loadHistory() }
        }
    }
}
