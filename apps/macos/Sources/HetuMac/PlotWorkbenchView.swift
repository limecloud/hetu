import SwiftUI
import HetuCore
import HetuNative

enum PlotFields {
    static let kinds = ["scene", "action", "dialogue", "conflict_candidate", "foreshadow_candidate"]
    static let times = ["day", "night", "dawn", "dusk", "unknown"]
    static let verification = ["needs_author_review", "confirmed", "dismissed"]
}
private struct PlotSheetValue: Identifiable {
    let id = UUID()
    let value: JSONValue
}

struct PlotWorkbenchView: View {
    let model: WorkspaceModel
    var fixedSource: JSONValue = .null
    var initialPlotRevisionID = ""
    @State private var documentID = ""
    @State private var summaries: [JSONValue] = []
    @State private var cursor: String?
    @State private var result: JSONValue = .null
    @State private var blueprint: JSONValue = .null
    @State private var error: String?
    @State private var nodeRequest: PlotSheetValue?
    @State private var edgeSheet = false
    @State private var sourceRequest: PlotSheetValue?
    @State private var highlightedNode = ""
    @State private var skippedLimit = 100
    @State private var validationInput: [String: JSONValue]?
    @State private var validationMessage: String?
    private var plot: JSONValue { result["plot"] }
    private var nodes: [JSONValue] { plot["nodes"].array }
    private var revisionID: String { plot["plot_revision_id"].string ?? "" }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if let validationMessage { Text(validationMessage).foregroundStyle(.secondary) }
            Divider()
            HSplitView {
                revisionList.frame(minWidth: 180, idealWidth: 220, maxWidth: 280)
                if result == .null { WorkbenchEmptyState(title: model.t("plot.empty"), detail: model.t("plot.empty_detail"), artwork: "story-world") }
                else { plotContent.frame(minWidth: 340) }
            }
        }.padding(28).workbenchPage()
        .task {
            if documentID.isEmpty { documentID = fixedSource["document_id"].string ?? model.documents.first?.id ?? "" }
            await reload()
            if !initialPlotRevisionID.isEmpty { await read(initialPlotRevisionID) }
        }
        .onChange(of: documentID) { _, _ in result = .null; blueprint = .null; Task { await reload() } }
        .sheet(item: $nodeRequest) { request in
            PlotNodeEditor(model: model, plot: plot, blueprint: blueprint, node: request.value) { updated, id in
                highlightedNode = id; Task { await install(updated); await reload() }
            }
        }
        .sheet(isPresented: $edgeSheet) {
            PlotEdgeEditor(model: model, plot: plot) { updated in Task { await install(updated); await reload() } }
        }
        .sheet(item: $sourceRequest) { request in PlotSourceView(model: model, source: request.value) }
    }
    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            WorkbenchHeading(title: model.t("plot.title"), subtitle: model.t("plot.description"), artwork: result == .null ? "" : "story-world") {
                Button(model.t("common.refresh")) { Task { await reload(); if !revisionID.isEmpty { await read(revisionID) } } }
            }
            HStack {
                if fixedSource != .null {
                    Text(model.t("review.fixed_draft"))
                    Spacer()
                    Button(model.t(validationInput == nil ? "review.validate_annotations" : "drama.retry")) { Task { await validateAnnotations() } }.disabled(revisionID.isEmpty || model.busy)
                } else {
                Picker(model.t("plot.document"), selection: $documentID) {
                    Text(model.t("document.select")).tag("")
                    ForEach(model.documents) { item in Text(item.title).tag(item.id) }
                }.frame(maxWidth: 380)
                Button(model.t("plot.extract")) {
                    Task {
                        error = nil
                        if let next = await model.extractPlot(documentID: documentID, onFailure: { error = $0 }) { await install(next); await reload() }
                    }
                }.disabled(documentID.isEmpty || model.busy)
                }
            }
            if fixedSource == .null { Text(model.t("plot.saved_source")).font(.caption).foregroundStyle(.secondary) }
        }
    }
    private var revisionList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                Text(model.t("plot.revisions")).font(.headline)
                if summaries.isEmpty { Text(model.t("plot.no_revisions")).foregroundStyle(.secondary) }
                ForEach(Array(summaries.enumerated()), id: \.offset) { _, item in
                    Button { Task { await read(item["plot_revision_id"].string ?? "") } } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(dateLabel(item["created_at"].string ?? ""))
                            Text(model.t("plot.summary", ["nodes": String(item["node_count"].integer ?? 0), "confirmed": String(item["confirmed_count"].integer ?? 0)])).font(.caption)
                            Text(model.t("plot.coverage." + (item["coverage_status"].string ?? "partial"))).font(.caption)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                            .background(revisionID == item["plot_revision_id"].string ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
                    }.buttonStyle(.plain)
                }
                if cursor != nil { Button(model.t("plot.more")) { Task { await reload(more: true) } } }
            }.padding(.trailing, 10)
        }
    }
    private var plotContent: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    coverage
                    HStack {
                        Text(model.t("plot.nodes")).font(.headline)
                        Spacer()
                        Button(model.t("plot.add_node")) { nodeRequest = PlotSheetValue(value: .null) }
                        Button(model.t("plot.add_edge")) { edgeSheet = true }.disabled(nodes.count < 2)
                    }
                    if nodes.isEmpty { Text(model.t("plot.no_nodes")).foregroundStyle(.secondary) }
                    ForEach(Array(nodes.enumerated()), id: \.offset) { index, node in
                        nodeRow(node, index: index).id(node["node_id"].string ?? "")
                        Divider()
                    }
                    edges
                    skipped
                }.padding(.leading, 14)
            }.onChange(of: revisionID) { _, _ in if !highlightedNode.isEmpty { proxy.scrollTo(highlightedNode, anchor: .center) } }
        }
    }
    private var coverage: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(model.t("plot.coverage." + (plot["coverage"]["status"].string ?? "partial"))).font(.headline)
            Text(model.t("plot.coverage_detail", ["bytes": String(plot["coverage"]["scanned_bytes"].integer ?? 0), "revision": String(plot["blueprint_revision"].integer ?? 0)])).font(.caption).foregroundStyle(.secondary)
            if plot["coverage"]["budget_stop"] != .null {
                Text(model.t("plot.budget." + (plot["coverage"]["budget_stop"]["reason"].string ?? "max_output"))).foregroundStyle(.orange)
            }
            if result["stale"].bool == true {
                Label(model.t("plot.stale"), systemImage: "clock.badge.exclamationmark").foregroundStyle(.orange)
            }
            Text(model.t("plot.candidates_note")).font(.caption).foregroundStyle(.secondary)
        }.textSelection(.enabled)
    }
    private func nodeRow(_ node: JSONValue, index: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("\(index + 1). " + model.t("plot.kind." + (node["kind"].string ?? "action"))).font(.headline)
                Text(model.t("plot.verification." + (node["verification"].string ?? "needs_author_review"))).foregroundStyle(.secondary)
                Spacer()
                Button(model.t("plot.source")) { sourceRequest = PlotSheetValue(value: node["source_refs"].array.first ?? .null) }.buttonStyle(.borderless)
                Button(model.t("common.edit")) { highlightedNode = node["node_id"].string ?? ""; nodeRequest = PlotSheetValue(value: node) }.buttonStyle(.borderless)
            }
            Text(node["source_refs"].array.compactMap { $0["quote"].string }.joined(separator: "\n")).lineLimit(4).textSelection(.enabled)
            let names = node["entity_candidates"].array.map { displayName(model, reference: $0["entity_ref"].string ?? "", blueprint: blueprint) }
            if !names.isEmpty { Text(model.t("plot.candidate_names", ["names": Array(Set(names)).sorted().joined(separator: model.locale == "en" ? ", " : "、")])).font(.caption).foregroundStyle(.secondary) }
            let unknown = node["unresolved_names"].array.compactMap { $0["name"].string }.joined(separator: model.locale == "en" ? ", " : "、")
            if !unknown.isEmpty { Text(model.t("plot.unknown_names", ["names": unknown])).font(.caption).foregroundStyle(.secondary) }
            if !node["entity_refs"].array.isEmpty {
                Text(model.t("plot.confirmed_names", ["names": node["entity_refs"].array.compactMap(\.string).map { displayName(model, reference: $0, blueprint: blueprint) }.joined(separator: model.locale == "en" ? ", " : "、")])).font(.caption)
            }
            let missing = node["missing_prerequisites"].array.compactMap(\.string).map { model.t("plot.missing." + $0) }
            if !missing.isEmpty { Text(model.t("plot.missing_fields", ["fields": missing.joined(separator: model.locale == "en" ? ", " : "、")])).font(.caption).foregroundStyle(.secondary) }
        }.padding(.vertical, 4).accessibilityElement(children: .contain)
    }
    private var edges: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.t("plot.edges")).font(.headline)
            Text(model.t("plot.edges_note")).font(.caption).foregroundStyle(.secondary)
            ForEach(Array(plot["edges"].array.enumerated()), id: \.offset) { _, edge in
                HStack {
                    Text(edgeLabel(edge)).font(.callout)
                    Spacer()
                    Button(model.t("plot.remove_edge"), role: .destructive) {
                        Task {
                            error = nil
                            if let next = await model.correctPlot(revisionID, corrections: [.object(["type": .string("remove_edge"), "edge_id": edge["edge_id"]])], operationKey: UUID().uuidString, onFailure: { error = $0 }) { await install(next); await reload() }
                        }
                    }.buttonStyle(.borderless)
                }
            }
        }
    }
    private var skipped: some View {
        DisclosureGroup(model.t("plot.skipped", ["count": String(plot["coverage"]["unparsed_ranges"].array.count)])) {
            ForEach(Array(plot["coverage"]["unparsed_ranges"].array.prefix(skippedLimit).enumerated()), id: \.offset) { _, item in
                Text(model.t("plot.skip." + (item["reason"].string ?? "no_structural_signal")) + "  \(item["byte_start"].integer ?? 0)…\(item["byte_end"].integer ?? 0)").font(.caption).frame(maxWidth: .infinity, alignment: .leading)
            }
            if skippedLimit < plot["coverage"]["unparsed_ranges"].array.count { Button(model.t("plot.more")) { skippedLimit += 100 } }
        }
    }
    private func edgeLabel(_ edge: JSONValue) -> String {
        let from = (nodes.firstIndex { $0["node_id"] == edge["from_node_id"] } ?? 0) + 1
        let to = (nodes.firstIndex { $0["node_id"] == edge["to_node_id"] } ?? 0) + 1
        return "\(from) → \(to)  " + model.t("plot.relation." + (edge["relation"].string ?? "narrative_next")) + "  " + model.t("plot.verification." + (edge["verification"].string ?? "needs_author_review"))
    }
    private func dateLabel(_ value: String) -> String { model.localizer.date(value) }
    private func validateAnnotations() async {
        if validationInput == nil {
            validationInput = ["plot_revision_id": .string(revisionID), "rule_set_version": .string("1"), "options": .object([:]), "save_report": .bool(true), "operation_key": .string(UUID().uuidString)]
        }
        guard let input = validationInput else { return }; error = nil
        if await model.workspaceAction("hetu.validation.run", input: input, onFailure: { error = $0; if $1 { validationInput = nil } }) != nil {
            validationInput = nil; validationMessage = model.t("review.annotations_validated")
        }
    }
    private func reload(more: Bool = false) async {
        guard !documentID.isEmpty else { summaries = []; cursor = nil; return }
        error = nil
        if let list = await model.listPlots(documentID: documentID, cursor: more ? cursor : nil, onFailure: { error = $0 }) {
            summaries = more ? summaries + list["plots"].array : list["plots"].array; cursor = list["next_cursor"].string
        }
    }
    private func read(_ id: String) async {
        error = nil
        if let next = await model.readPlot(id, onFailure: { error = $0 }) { await install(next) }
    }
    private func install(_ next: JSONValue) async {
        guard let revision = next["plot"]["blueprint_revision"].integer,
              let bible = await model.readBibleRevision(revision, onFailure: { error = $0 }) else { return }
        result = next; blueprint = bible["blueprint"]; skippedLimit = 100
    }
}

private extension ISO8601DateFormatter {
    static var fractional: ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return formatter
    }
}

struct PlotSourceView: View {
    let model: WorkspaceModel
    let source: JSONValue
    var noteKey = "plot.source_fixed"
    @Environment(\.dismiss) private var dismiss
    @State private var document: JSONValue = .null
    @State private var selection: SourceSelection?
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.t("plot.source")).font(.title2)
            Text(model.t(noteKey)).foregroundStyle(.secondary)
            if let error { Text(error).foregroundStyle(.red) }
            if document != .null {
                Text(document["document"]["title"].string ?? "").font(.headline)
                Text(document["revision"]["revision_id"].string ?? "").font(.caption).textSelection(.enabled)
                NativeTextEditor(text: document["content"].string ?? "", documentID: document["revision"]["revision_id"].string ?? "", replacementVersion: 0, accessibleName: model.t("plot.source_body"), editable: false, selection: selection, onChange: { _ in }, onComposition: { _ in })
            }
            HStack {
                Button(model.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(model.t("plot.locate")) { locate() }.disabled(document == .null)
            }
        }.padding(24).frame(width: 760, height: 560)
        .task {
            if let loaded = await model.readPlotSource(source, onFailure: { error = $0 }) { document = loaded; locate() }
        }
    }
    private func locate() {
        guard let start = source["byte_start"].integer, let end = source["byte_end"].integer else { return }
        selection = SourceSelection(content: document["content"].string ?? "", byteStart: Int(start), byteEnd: Int(end), quote: source["quote"].string ?? "")
        if selection == nil { error = model.t("error.hetu.invalid_source_ref") }
    }
}
