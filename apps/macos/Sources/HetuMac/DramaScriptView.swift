import SwiftUI
import HetuCore
import HetuNative

struct DramaScriptSheet: View {
    let model: WorkspaceModel
    let snapshot: JSONValue
    let onOpen: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var language = "zh-CN"
    @State private var pending: [String: JSONValue]?
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(model.t("script.create")).font(.title2)
            Text(model.t("script.create_note")).foregroundStyle(.secondary)
            Text(model.t("drama.revision", ["revision": String(snapshot["skeleton"]["revision"].integer ?? 0)])).font(.caption)
            if snapshot["stale"].bool == true || snapshot["is_head"].bool == false { Text(model.t("script.old_structure")).foregroundStyle(.orange) }
            TextField(model.t("document.title"), text: $title).textFieldStyle(.roundedBorder).disabled(pending != nil)
            Picker(model.t("document.language"), selection: $language) {
                Text(model.t("language.chinese")).tag("zh-CN")
                Text(model.t("language.english")).tag("en")
            }.disabled(pending != nil)
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if pending != nil { Text(model.t("drama.pending_note")).font(.caption).foregroundStyle(.orange) }
            HStack {
                Button(model.t("common.cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(model.t(pending == nil ? "script.create" : "drama.retry")) { Task { await create() } }
                    .keyboardShortcut(.defaultAction).disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 520).disabled(model.busy)
        .onAppear { language = model.locale }
    }
    private func create() async {
        if pending == nil {
            pending = ["skeleton_ref": .object(["skeleton_id": snapshot["skeleton"]["skeleton_id"], "revision": snapshot["skeleton"]["revision"], "sha256": snapshot["sha256"]]), "title": .string(title), "language_tag": .string(language), "operation_key": .string(UUID().uuidString)]
        }
        guard let input = pending else { return }
        error = nil
        if let result = await model.dramaAction("hetu.drama.create_script", input: input, onFailure: { error = $0; if $1 { pending = nil } }), let id = result["document"]["document_id"].string {
            pending = nil; dismiss(); onOpen(id)
        }
    }
}

struct ScriptMappingView: View {
    let model: WorkspaceModel
    let documentID: String
    @Environment(\.dismiss) private var dismiss
    @State private var result: JSONValue = .null
    @State private var skeleton: JSONValue = .null
    @State private var error: String?
    @State private var sourceSheet: DramaSheet?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.t("script.mapping")).font(.title2)
            Text(model.t("script.mapping_note")).foregroundStyle(.secondary)
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if result["stale"].bool == true { Text(model.t("script.mapping_stale")).foregroundStyle(.orange) }
            if result["mapping"] != .null {
                Text(model.t("drama.revision", ["revision": String(result["mapping"]["skeleton_ref"]["revision"].integer ?? 0)])).font(.caption)
                if result["mapping"]["coverage_status"].string == "partial" { Text(model.t("plot.coverage.partial")).foregroundStyle(.orange) }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(Array(result["mapping"]["scenes"].array.enumerated()), id: \.offset) { _, scene in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(model.t("drama.scene", ["episode": String(scene["episode_number"].integer ?? 0), "scene": String(scene["scene_number"].integer ?? 0)])).font(.headline)
                                Text(scene["quote"].string ?? "").textSelection(.enabled)
                                Button(model.t("script.initial_heading")) {
                                    sourceSheet = DramaSheet(value: .object(["document_id": result["mapping"]["document_id"], "revision_id": result["mapping"]["revision_id"], "byte_start": scene["byte_start"], "byte_end": scene["byte_end"], "quote": scene["quote"], "initial_script_heading": .bool(true)]))
                                }
                                let original = skeleton["episodes"].array.flatMap { $0["scenes"].array }.first { $0["scene_id"] == scene["scene_id"] }
                                if let original {
                                    if !original["missing_fields"].array.isEmpty {
                                        Text(model.t("plot.missing_fields", ["fields": original["missing_fields"].array.compactMap(\.string).map { model.t("drama.missing." + $0) }.joined(separator: model.locale == "en" ? ", " : "、")])).font(.caption).foregroundStyle(.orange)
                                    }
                                    ForEach(Array(original["source_refs"].array.enumerated()), id: \.offset) { _, source in
                                        Button(source["quote"].string ?? model.t("plot.source")) { sourceSheet = DramaSheet(value: source) }.buttonStyle(.link).lineLimit(2)
                                    }
                                }
                                Divider()
                            }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            HStack {
                Button(model.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(model.t("common.refresh")) { Task { await load() } }
            }
        }.padding(24).frame(width: 700, height: 540).disabled(model.busy)
        .task { await load() }
        .sheet(item: $sourceSheet) { request in PlotSourceView(model: model, source: request.value, noteKey: request.value["initial_script_heading"].bool == true ? "script.source_fixed" : "plot.source_fixed") }
    }
    private func load() async {
        error = nil; result = .null; skeleton = .null
        guard let next = await model.dramaAction("hetu.drama.get_script_mapping", input: ["document_id": .string(documentID)], onFailure: { error = $0; _ = $1 }) else { return }
        let reference = next["mapping"]["skeleton_ref"]
        guard let structure = await model.dramaAction("hetu.drama.get_skeleton", input: ["skeleton_id": reference["skeleton_id"], "revision": reference["revision"]], onFailure: { error = $0; _ = $1 }) else { return }
        result = next; skeleton = structure["skeleton"]
    }
}
