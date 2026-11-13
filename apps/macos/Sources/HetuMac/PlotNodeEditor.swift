import SwiftUI
import HetuCore
import HetuNative

struct PlotNodeEditor: View {
    let model: WorkspaceModel
    let plot: JSONValue
    let blueprint: JSONValue
    let node: JSONValue
    let onSaved: (JSONValue, String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var fields = PlotNodeForm()
    @State private var error: String?
    @State private var operationKey = UUID().uuidString
    @State private var sourceIndex = 0
    @State private var sourceDocument: JSONValue = .null
    @State private var selectedSpan: SourceSpan?
    private var adding: Bool { node == .null }
    private var sourceRef: JSONValue {
        guard let selectedSpan else { return .null }
        return .object(["document_id": sourceDocument["document"]["document_id"], "revision_id": sourceDocument["revision"]["revision_id"], "byte_start": .integer(Int64(selectedSpan.byteStart)), "byte_end": .integer(Int64(selectedSpan.byteEnd)), "quote": .string(selectedSpan.quote)])
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.t(adding ? "plot.add_node" : "plot.correct_node")).font(.title2)
            Text(model.t("plot.correction_note")).font(.callout).foregroundStyle(.secondary)
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if adding { sourcePicker }
                    else { SourceEvidenceView(model: model, sources: node["source_refs"].array) }
                    PlotNodeFieldsView(model: model, blueprint: blueprint, fields: $fields)
                    if !adding {
                        Text(model.t("plot.method." + (node["extraction_method"].string ?? "author_annotation"))).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            HStack {
                Button(model.t("common.cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(model.t("common.save")) { Task { await save() } }.keyboardShortcut(.defaultAction)
                    .disabled(model.busy || (adding && (selectedSpan == nil || (selectedSpan?.quote.utf8.count ?? 0) > 16384)))
            }
        }.padding(24).frame(width: 700, height: 720).disabled(model.busy)
        .task { if adding { await loadSource() } else { fields = PlotNodeForm(node) } }
        .onChange(of: sourceIndex) { _, _ in Task { await loadSource() } }
    }
    private var sourcePicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker(model.t("plot.original_document"), selection: $sourceIndex) {
                ForEach(Array(plot["source_revisions"].array.enumerated()), id: \.offset) { index, source in
                    Text(model.documents.first { $0.id == source["document_id"].string }?.title ?? model.t("entity.unavailable")).tag(index)
                }
            }
            Text(model.t("plot.select_excerpt")).font(.caption).foregroundStyle(.secondary)
            if sourceDocument != .null {
                NativeTextEditor(text: sourceDocument["content"].string ?? "", documentID: sourceDocument["revision"]["revision_id"].string ?? "", replacementVersion: 0, accessibleName: model.t("plot.source_body"), editable: false, onChange: { _ in }, onComposition: { _ in }, onSelection: { range in
                    selectedSpan = SourceSpan(content: sourceDocument["content"].string ?? "", selection: range)
                }).frame(height: 180).border(Color.secondary.opacity(0.2))
            }
            if let selectedSpan {
                Text(selectedSpan.quote).font(.callout).lineLimit(3).textSelection(.enabled)
                if selectedSpan.quote.utf8.count > 16384 { Text(model.t("plot.excerpt_too_large")).foregroundStyle(.red) }
            }
        }
    }
    private func loadSource() async {
        selectedSpan = nil; sourceDocument = .null
        let sources = plot["source_revisions"].array
        guard sources.indices.contains(sourceIndex) else { return }
        if let loaded = await model.readPlotSource(sources[sourceIndex], onFailure: { error = $0 }) { sourceDocument = loaded }
    }
    private func save() async {
        error = nil
        var correction = fields.value.object
        correction["type"] = .string(adding ? "add_node" : "update_node")
        if adding { correction["source_ref"] = sourceRef } else { correction["node_id"] = node["node_id"] }
        if let next = await model.correctPlot(plot["plot_revision_id"].string ?? "", corrections: [.object(correction)], operationKey: operationKey, onFailure: { error = $0 }) {
            let reference = adding ? next["plot"]["nodes"].array.last?["node_id"].string ?? "" : node["node_id"].string ?? ""
            onSaved(next, reference); dismiss()
        }
    }
}

struct PlotNodeForm {
    var kind = "action"
    var entities: Set<String> = []
    var location = ""
    var time = ""
    var speaker = ""
    var timeOfDay = "unknown"
    var verification = "needs_author_review"
    var annotation = PlotAnnotationForm()
    init() {}
    init(_ node: JSONValue) {
        kind = node["kind"].string ?? "action"; entities = Set(node["entity_refs"].array.compactMap(\.string))
        location = node["location_ref"].string ?? ""; time = node["time_ref"].string ?? ""; speaker = node["speaker_ref"].string ?? ""
        timeOfDay = node["time_of_day"].string ?? "unknown"; verification = node["verification"].string ?? "needs_author_review"
        annotation = PlotAnnotationForm(node["annotation"])
    }
    var value: JSONValue {
        .object(["kind": .string(kind), "entity_refs": .array(entities.sorted().map(JSONValue.string)), "location_ref": location.isEmpty ? .null : .string(location), "time_ref": time.isEmpty ? .null : .string(time), "speaker_ref": speaker.isEmpty || kind != "dialogue" ? .null : .string(speaker), "time_of_day": .string(timeOfDay), "verification": .string(verification), "annotation": annotation.value])
    }
}

struct PlotNodeFieldsView: View {
    let model: WorkspaceModel
    let blueprint: JSONValue
    @Binding var fields: PlotNodeForm
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker(model.t("plot.classification"), selection: $fields.kind) {
                ForEach(PlotFields.kinds, id: \.self) { Text(model.t("plot.kind." + $0)).tag($0) }
            }
            MultipleReferences(title: model.t("plot.entity_refs"), choices: entityChoices(model, .character, blueprint: blueprint) + entityChoices(model, .faction, blueprint: blueprint), selected: $fields.entities, model: model)
            referencePicker("plot.location", selection: $fields.location, choices: entityChoices(model, .location, blueprint: blueprint))
            referencePicker("plot.story_time", selection: $fields.time, choices: entityChoices(model, .event, blueprint: blueprint))
            if fields.kind == "dialogue" {
                referencePicker("plot.speaker", selection: $fields.speaker, choices: entityChoices(model, .character, blueprint: blueprint))
                Text(model.t("plot.speaker_note")).font(.caption).foregroundStyle(.secondary)
            }
            Picker(model.t("plot.time_of_day"), selection: $fields.timeOfDay) {
                ForEach(PlotFields.times, id: \.self) { Text(model.t("plot.time_of_day." + $0)).tag($0) }
            }
            Picker(model.t("plot.verification"), selection: $fields.verification) {
                ForEach(PlotFields.verification, id: \.self) { Text(model.t("plot.verification." + $0)).tag($0) }
            }
            PlotAnnotationFields(model: model, blueprint: blueprint, form: $fields.annotation, entities: fields.entities)
        }
        .onChange(of: fields.speaker) { _, reference in if !reference.isEmpty { fields.entities.insert(reference) } }
    }
    private func referencePicker(_ key: String, selection: Binding<String>, choices: [EntityChoice]) -> some View {
        Picker(model.t(key), selection: selection) {
            Text(model.t("plot.unspecified")).tag("")
            ForEach(choices) { Text($0.name).tag($0.id) }
        }
    }
}

struct PlotEdgeEditor: View {
    let model: WorkspaceModel
    let plot: JSONValue
    let onSaved: (JSONValue) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var from = ""
    @State private var to = ""
    @State private var relation = "causes"
    @State private var error: String?
    @State private var operationKey = UUID().uuidString
    private var nodes: [JSONValue] { plot["nodes"].array }
    private var evidence: [JSONValue] { nodes.first { $0["node_id"].string == from }?["source_refs"].array ?? [] }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(model.t("plot.add_edge")).font(.title2)
            Text(model.t("plot.edge_evidence_note")).foregroundStyle(.secondary)
            nodePicker("plot.edge_from", selection: $from)
            nodePicker("plot.edge_to", selection: $to)
            Picker(model.t("plot.edge_relation"), selection: $relation) {
                ForEach(["causes", "narrative_next", "story_before"], id: \.self) { Text(model.t("plot.relation." + $0)).tag($0) }
            }
            SourceEvidenceView(model: model, sources: evidence)
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button(model.t("common.cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(model.t("common.save")) {
                    Task {
                        error = nil
                        let correction: JSONValue = .object(["type": .string("add_edge"), "from_node_id": .string(from), "to_node_id": .string(to), "relation": .string(relation), "source_refs": .array(evidence)])
                        if let next = await model.correctPlot(plot["plot_revision_id"].string ?? "", corrections: [correction], operationKey: operationKey, onFailure: { error = $0 }) { onSaved(next); dismiss() }
                    }
                }.disabled(from.isEmpty || to.isEmpty || from == to || model.busy)
            }
        }.padding(24).frame(width: 640).disabled(model.busy)
        .onAppear { from = nodes.first?["node_id"].string ?? ""; to = nodes.dropFirst().first?["node_id"].string ?? "" }
    }
    private func nodePicker(_ key: String, selection: Binding<String>) -> some View {
        Picker(model.t(key), selection: selection) {
            ForEach(Array(nodes.enumerated()), id: \.offset) { index, node in
                Text("\(index + 1). " + model.t("plot.kind." + (node["kind"].string ?? "action")) + " · " + String((node["source_refs"].array.first?["quote"].string ?? "").prefix(36))).tag(node["node_id"].string ?? "")
            }
        }
    }
}
