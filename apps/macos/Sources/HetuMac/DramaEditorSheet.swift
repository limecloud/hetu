import SwiftUI
import HetuCore
import HetuNative

func dramaOrderedNodes(_ plot: JSONValue) -> [JSONValue] {
    let order = Dictionary(uniqueKeysWithValues: plot["source_revisions"].array.enumerated().map { ($0.element["document_id"].string ?? "", $0.offset) })
    let nodes = plot["nodes"].array.filter { $0["verification"].string != "dismissed" }
    return nodes.sorted { a, b in
        let x = a["source_refs"].array.first ?? .null, y = b["source_refs"].array.first ?? .null
        let left: (Int, Int64, Int64, String) = (order[x["document_id"].string ?? ""] ?? 0, x["byte_start"].integer ?? 0, x["byte_end"].integer ?? 0, a["node_id"].string ?? "")
        let right: (Int, Int64, Int64, String) = (order[y["document_id"].string ?? ""] ?? 0, y["byte_start"].integer ?? 0, y["byte_end"].integer ?? 0, b["node_id"].string ?? "")
        return left < right
    }
}
@MainActor func dramaNodeLabel(_ node: JSONValue, model: WorkspaceModel) -> String {
    model.t("plot.kind." + (node["kind"].string ?? "action")) + "  " + String((node["source_refs"].array.first?["quote"].string ?? "").prefix(60)).replacingOccurrences(of: "\n", with: " ")
}
struct DramaBuildSheet: View {
    let model: WorkspaceModel
    let plot: JSONValue
    let onSaved: (JSONValue) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var anchors: Set<String> = []
    @State private var pending: [String: JSONValue]?
    @State private var error: String?
    private var nodes: [JSONValue] { dramaOrderedNodes(plot) }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.t("drama.build")).font(.title2)
            Text(model.t("drama.build_note")).foregroundStyle(.secondary)
            Text(model.t("drama.anchors_note")).font(.callout)
            Text(model.t("plot.coverage." + (plot["coverage"]["status"].string ?? "partial"))).font(.caption)
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(nodes.enumerated()), id: \.offset) { index, node in
                        Toggle(isOn: Binding(get: { anchors.contains(node["node_id"].string ?? "") }, set: { value in
                            if value { anchors.insert(node["node_id"].string ?? "") } else { anchors.remove(node["node_id"].string ?? "") }
                        })) {
                            Text("\(index + 1). " + dramaNodeLabel(node, model: model)).lineLimit(2)
                        }
                    }
                }.disabled(pending != nil)
            }
            HStack {
                Button(model.t("common.cancel")) { dismiss() }.keyboardShortcut(.cancelAction).disabled(pending != nil)
                Spacer()
                Button(model.t(pending == nil ? "drama.build" : "drama.retry")) { Task { await save() } }.keyboardShortcut(.defaultAction)
            }
        }.padding(24).frame(width: 680, height: 600).disabled(model.busy).interactiveDismissDisabled(pending != nil)
    }
    private func save() async {
        if pending == nil {
            pending = ["plot_revision_id": plot["plot_revision_id"], "blueprint_revision": plot["blueprint_revision"], "episode_options": .object(["episode_start_node_ids": .array(nodes.compactMap { node in guard let id = node["node_id"].string, anchors.contains(id) else { return nil }; return .string(id) })]), "operation_key": .string(UUID().uuidString)]
        }
        guard let input = pending else { return }
        error = nil
        if let next = await model.dramaAction("hetu.drama.build_skeleton", input: input, onFailure: { error = $0; if $1 { pending = nil } }) { pending = nil; onSaved(next); dismiss() }
    }
}

struct DramaEditorSheet: View {
    let model: WorkspaceModel
    let snapshot: JSONValue
    let blueprint: JSONValue
    let plot: JSONValue
    let request: JSONValue
    let onSaved: (JSONValue) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var location = ""
    @State private var interior = "unknown"
    @State private var day = "unknown"
    @State private var characters: Set<String> = []
    @State private var note = ""
    @State private var refs: [String] = []
    @State private var targetEpisode = ""
    @State private var targetIndex = 0
    @State private var splitAnchor = ""
    @State private var error: String?
    @State private var pending: [String: JSONValue]?
    private var skeleton: JSONValue { snapshot["skeleton"] }
    private var scene: JSONValue { request["scene"] }
    private var episode: JSONValue { request["episode"] }
    private var editingScene: Bool { scene != .null }
    private var episodes: [JSONValue] { skeleton["episodes"].array }
    private var sceneIndex: Int { episode["scenes"].array.firstIndex { $0["scene_id"] == scene["scene_id"] } ?? 0 }
    private var episodeIndex: Int { episodes.firstIndex { $0["episode_id"] == episode["episode_id"] } ?? 0 }
    private var availableNodes: [JSONValue] {
        let taken = Set(episodes.flatMap { $0["scenes"].array }.filter { $0["scene_id"] != scene["scene_id"] }.flatMap { $0["plot_node_refs"].array.compactMap(\.string) })
        return dramaOrderedNodes(plot).filter { !taken.contains($0["node_id"].string ?? "") }
    }
    private var targetMaximum: Int {
        guard let target = episodes.first(where: { $0["episode_id"].string == targetEpisode }) else { return 0 }
        return max(0, target["scenes"].array.count - (target["episode_id"] == episode["episode_id"] ? 1 : 0))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.t(editingScene ? "drama.edit_scene" : "drama.edit_episode")).font(.title2)
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    TextField(model.t("drama.field.title"), text: $title)
                    if editingScene { sceneFields } else { episodeFields }
                }.disabled(pending != nil)
            }
            HStack {
                Button(model.t("common.cancel")) { dismiss() }.keyboardShortcut(.cancelAction).disabled(pending != nil)
                Spacer()
                Button(model.t(pending == nil ? "common.save" : "drama.retry")) { Task { await save(ordinaryChanges()) } }.keyboardShortcut(.defaultAction)
            }
        }.padding(24).frame(width: 700, height: 720).disabled(model.busy).interactiveDismissDisabled(pending != nil)
        .task {
            title = (editingScene ? scene : episode)["title"].string ?? ""
            location = scene["location_ref"].string ?? ""; interior = scene["interior_exterior"].string ?? "unknown"; day = scene["time_of_day"].string ?? "unknown"
            characters = Set(scene["character_refs"].array.compactMap(\.string)); note = scene["adaptation_note"].string ?? ""; refs = scene["plot_node_refs"].array.compactMap(\.string)
            targetEpisode = episode["episode_id"].string ?? ""; targetIndex = editingScene ? sceneIndex : episodeIndex
        }
        .onChange(of: targetEpisode) { _, _ in targetIndex = min(targetIndex, targetMaximum) }
    }
    private var sceneFields: some View {
        VStack(alignment: .leading, spacing: 14) {
            Picker(model.t("drama.field.location_ref"), selection: $location) {
                Text(model.t("plot.unspecified")).tag("")
                ForEach(entityChoices(model, .location, blueprint: blueprint)) { Text($0.name).tag($0.id) }
            }
            Picker(model.t("drama.field.interior_exterior"), selection: $interior) {
                ForEach(["interior", "exterior", "mixed", "unknown"], id: \.self) { Text(model.t("location." + $0)).tag($0) }
            }
            Picker(model.t("drama.field.time_of_day"), selection: $day) {
                ForEach(PlotFields.times, id: \.self) { Text(model.t("plot.time_of_day." + $0)).tag($0) }
            }
            MultipleReferences(title: model.t("drama.field.character_refs"), choices: entityChoices(model, .character, blueprint: blueprint), selected: $characters, model: model)
            TextField(model.t("drama.adaptation_note"), text: $note, axis: .vertical).lineLimit(3...5)
            Picker(model.t("drama.target_episode"), selection: $targetEpisode) {
                ForEach(Array(episodes.enumerated()), id: \.offset) { index, ep in Text(model.t("drama.episode", ["number": String(index + 1)])).tag(ep["episode_id"].string ?? "") }
            }
            Stepper(model.t("drama.target_position", ["number": String(targetIndex + 1)]), value: $targetIndex, in: 0...targetMaximum)
            mapping
            Divider()
            Text(model.t("drama.structure_note")).font(.caption).foregroundStyle(.secondary)
            Picker(model.t("drama.split_at"), selection: $splitAnchor) {
                Text(model.t("plot.unspecified")).tag("")
                ForEach(scene["plot_node_refs"].array.dropFirst().compactMap(\.string), id: \.self) { id in
                    if let node = plot["nodes"].array.first(where: { $0["node_id"].string == id }) { Text(dramaNodeLabel(node, model: model)).tag(id) }
                }
            }
            HStack {
                Button(model.t("drama.split_scene")) { Task { await save([.object(["type": .string("split_scene"), "scene_id": scene["scene_id"], "at_node_id": .string(splitAnchor)])]) } }.disabled(splitAnchor.isEmpty)
                if sceneIndex + 1 < episode["scenes"].array.count {
                    Button(model.t("drama.merge_next")) { Task { await save([.object(["type": .string("merge_scene"), "scene_id": scene["scene_id"], "with_scene_id": episode["scenes"].array[sceneIndex + 1]["scene_id"]])]) } }
                }
                Button(model.t("drama.omit_scene"), role: .destructive) { Task { await save([.object(["type": .string("remove_scene"), "scene_id": scene["scene_id"]])]) } }
            }
        }
    }
    private var mapping: some View {
        DisclosureGroup(model.t("drama.mapping")) {
            VStack(alignment: .leading, spacing: 8) {
                Text(model.t("drama.mapping_note")).font(.caption).foregroundStyle(.secondary)
                ForEach(Array(refs.enumerated()), id: \.offset) { index, id in
                    HStack {
                        if let node = plot["nodes"].array.first(where: { $0["node_id"].string == id }) { Text(dramaNodeLabel(node, model: model)).lineLimit(2) }
                        Spacer()
                        Button { refs.swapAt(index, index - 1) } label: { Image(systemName: "arrow.up") }.disabled(index == 0).help(model.t("drama.move_up")).accessibilityLabel(model.t("drama.move_up"))
                        Button { refs.swapAt(index, index + 1) } label: { Image(systemName: "arrow.down") }.disabled(index + 1 == refs.count).help(model.t("drama.move_down")).accessibilityLabel(model.t("drama.move_down"))
                    }
                }
                ForEach(Array(availableNodes.enumerated()), id: \.offset) { _, node in
                    let id = node["node_id"].string ?? ""
                    Toggle(dramaNodeLabel(node, model: model), isOn: Binding(get: { refs.contains(id) }, set: { on in if on { refs.append(id) } else { refs.removeAll { $0 == id } } }))
                }
            }
        }
    }
    private var episodeFields: some View {
        VStack(alignment: .leading, spacing: 14) {
            Stepper(model.t("drama.target_position", ["number": String(targetIndex + 1)]), value: $targetIndex, in: 0...max(0, episodes.count - 1))
            Divider()
            Text(model.t("drama.structure_note")).font(.caption).foregroundStyle(.secondary)
            Picker(model.t("drama.split_at"), selection: $splitAnchor) {
                Text(model.t("plot.unspecified")).tag("")
                ForEach(Array(episode["scenes"].array.dropFirst().enumerated()), id: \.offset) { index, s in
                    Text(model.t("drama.scene_label", ["number": String(index + 2)])).tag(s["scene_id"].string ?? "")
                }
            }
            HStack {
                Button(model.t("drama.split_episode")) { Task { await save([.object(["type": .string("split_episode"), "episode_id": episode["episode_id"], "at_scene_id": .string(splitAnchor)])]) } }.disabled(splitAnchor.isEmpty)
                if episodeIndex + 1 < episodes.count {
                    Button(model.t("drama.merge_next_episode")) { Task { await save([.object(["type": .string("merge_episode"), "episode_id": episode["episode_id"], "with_episode_id": episodes[episodeIndex + 1]["episode_id"]])]) } }
                }
            }
        }
    }
    private func ordinaryChanges() -> [JSONValue] {
        if editingScene {
            var changes: [JSONValue] = [
                .object(["type": .string("update_scene"), "scene_id": scene["scene_id"], "title": .string(title), "location_ref": location.isEmpty ? .null : .string(location), "interior_exterior": .string(interior), "time_of_day": .string(day), "character_refs": .array(characters.sorted().map(JSONValue.string)), "adaptation_note": .string(note)]),
                .object(["type": .string("set_scene_nodes"), "scene_id": scene["scene_id"], "plot_node_refs": .array(refs.map(JSONValue.string))])
            ]
            if targetEpisode != episode["episode_id"].string || targetIndex != sceneIndex { changes.append(.object(["type": .string("move_scene"), "scene_id": scene["scene_id"], "episode_id": .string(targetEpisode), "index": .integer(Int64(targetIndex))])) }
            return changes
        }
        var changes: [JSONValue] = [.object(["type": .string("update_episode"), "episode_id": episode["episode_id"], "title": .string(title)])]
        if targetIndex != episodeIndex { changes.append(.object(["type": .string("move_episode"), "episode_id": episode["episode_id"], "index": .integer(Int64(targetIndex))])) }
        return changes
    }
    private func save(_ changes: [JSONValue]) async {
        if pending == nil { pending = ["skeleton_id": skeleton["skeleton_id"], "expected": .object(["revision": skeleton["revision"], "sha256": snapshot["sha256"]]), "typed_changes": .array(changes), "operation_key": .string(UUID().uuidString)] }
        guard let input = pending else { return }
        error = nil
        if let next = await model.dramaAction("hetu.drama.edit_skeleton", input: input, onFailure: { error = $0; if $1 { pending = nil } }) { pending = nil; onSaved(next); dismiss() }
    }
}
