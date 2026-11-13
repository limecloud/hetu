import AppKit
import SwiftUI
import UniformTypeIdentifiers
import HetuCore
import HetuNative

struct AssetEditorSheet: View {
    let model: WorkspaceModel
    let initial: JSONValue
    let onSaved: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var fileURL: URL?
    @State private var inspection: JSONValue = .null
    @State private var title = ""
    @State private var sourceType = "author_supplied"
    @State private var creator = ""
    @State private var uri = ""
    @State private var rights = "unknown"
    @State private var redistribute = false
    @State private var statement = ""
    @State private var pending: [String: JSONValue]?
    @State private var error: String?
    private var editing: Bool { initial["asset"] != .null }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(model.t(editing ? "media.edit_asset" : "media.import")).font(.title2)
            ScrollView {
                Form {
                    if !editing {
                        Button(model.t("media.choose_file")) { Task { await chooseFile() } }
                        if inspection != .null {
                            LabeledContent(model.t("media.original_filename"), value: inspection["original_filename"].string ?? "")
                            LabeledContent(model.t("media.file_size"), value: model.localizer.byteCount(inspection["size_bytes"].integer ?? 0))
                            LabeledContent(model.t("media.file_type"), value: inspection["media_type"].string ?? "")
                            Text(model.t("media.signature_note")).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    TextField(model.t("media.name"), text: $title)
                    Picker(model.t("media.source_type"), selection: $sourceType) {
                        ForEach(["author_supplied", "third_party", "external_agent"], id: \.self) { item in Text(model.t("media.source_type." + item)).tag(item) }
                    }
                    TextField(model.t("media.creator_statement"), text: $creator, axis: .vertical).lineLimit(2...5)
                    TextField(model.t("media.source_uri"), text: $uri)
                    Text(model.t("media.source_uri_note")).font(.caption).foregroundStyle(.secondary)
                    Picker(model.t("media.rights_status"), selection: $rights) {
                        ForEach(["unknown", "reference_only", "author_owned", "licensed"], id: \.self) { item in Text(model.t("media.rights." + item)).tag(item) }
                    }
                    Toggle(model.t("media.redistribute"), isOn: $redistribute).disabled(!["author_owned", "licensed"].contains(rights))
                    TextField(model.t("media.rights_statement"), text: $statement, axis: .vertical).lineLimit(2...5)
                    Text(model.t("media.rights_note")).font(.caption).foregroundStyle(.secondary)
                }.formStyle(.grouped).disabled(pending != nil)
            }
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if pending != nil { Text(model.t("drama.pending_note")).font(.caption).foregroundStyle(.orange) }
            HStack {
                Button(model.t("common.cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(model.t(pending == nil ? "media.save" : "drama.retry")) { Task { await save() } }.keyboardShortcut(.defaultAction)
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (!editing && inspection == .null) || (redistribute && statement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            }
        }.padding(24).frame(width: 620, height: 640).disabled(model.busy).interactiveDismissDisabled(model.busy)
        .onAppear {
            if editing {
                let asset = initial["asset"]
                title = asset["title"].string ?? ""; sourceType = asset["source"]["source_type"].string ?? "author_supplied"
                creator = asset["source"]["creator_statement"].string ?? ""; uri = asset["source"]["source_uri"].string ?? ""
                rights = asset["rights_status"].string ?? "unknown"; redistribute = asset["redistribution_allowed"].bool ?? false; statement = asset["rights_statement"].string ?? ""
            }
        }
        .onChange(of: rights) { _, rights in if !["author_owned", "licensed"].contains(rights) { redistribute = false } }
    }
    private func chooseFile() async {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        panel.allowedContentTypes = ["png", "jpg", "jpeg", "gif", "webp", "wav", "flac", "mp3", "ogg", "m4a", "mp4", "mov"].compactMap { UTType(filenameExtension: $0) }
        guard panel.runModal() == .OK, let url = panel.url else { return }
        fileURL = nil; inspection = .null; error = nil
        if let checked = await model.workspaceAction("hetu.assets.inspect", input: ["file_path": .string(url.path)], onFailure: { error = $0; _ = $1 }) {
            fileURL = url; inspection = checked
            if title.isEmpty { title = url.deletingPathExtension().lastPathComponent }
        }
    }
    private func save() async {
        if pending == nil {
            var source: [String: JSONValue] = ["source_type": .string(sourceType), "creator_statement": .string(creator)]
            let link = uri.trimmingCharacters(in: .whitespacesAndNewlines)
            if !link.isEmpty { source["source_uri"] = .string(link) }
            var input: [String: JSONValue] = ["title": .string(title), "source": .object(source), "rights_status": .string(rights), "redistribution_allowed": .bool(redistribute), "rights_statement": .string(statement), "operation_key": .string(UUID().uuidString)]
            if editing {
                input["asset_id"] = initial["asset"]["asset_id"]
                input["expected"] = .object(["revision": initial["asset"]["revision"], "sha256": initial["sha256"]])
            } else {
                guard let fileURL else { return }
                input["file_path"] = .string(fileURL.path)
                input["expected_file"] = .object(["sha256": inspection["sha256"], "size_bytes": inspection["size_bytes"]])
            }
            pending = input
        }
        guard let input = pending else { return }
        error = nil
        if let saved = await model.workspaceAction(editing ? "hetu.assets.update" : "hetu.assets.import", input: input, onFailure: { error = $0; if $1 { pending = nil } }), let id = saved["asset"]["asset_id"].string {
            pending = nil; dismiss(); onSaved(id)
        }
    }
}

struct CueEditorSheet: View {
    let model: WorkspaceModel
    let initial: JSONValue
    let defaultKind: String
    let onSaved: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var description = ""
    @State private var kind = "visual"
    @State private var archived = false
    @State private var references: [JSONValue] = []
    @State private var assets: [JSONValue] = []
    @State private var sources: [JSONValue] = []
    @State private var addSource = false
    @State private var pending: [String: JSONValue]?
    @State private var error: String?
    private var editing: Bool { initial["cue"] != .null }
    init(model: WorkspaceModel, initial: JSONValue, defaultKind: String, onSaved: @escaping (String) -> Void) {
        self.model = model; self.initial = initial; self.defaultKind = defaultKind; self.onSaved = onSaved
        _kind = State(initialValue: initial["cue"]["kind"].string ?? defaultKind)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(model.t(editing ? "media.edit_cue" : "media.new_cue")).font(.title2)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    TextField(model.t("media.name"), text: $title).textFieldStyle(.roundedBorder)
                    Picker(model.t("media.kind"), selection: $kind) {
                        Text(model.t("media.kind.music")).tag("music"); Text(model.t("media.kind.visual")).tag("visual")
                    }.disabled(editing)
                    Text(model.t("media.description")).font(.headline)
                    TextEditor(text: $description).frame(minHeight: 90).border(.quaternary).accessibilityLabel(model.t("media.description"))
                    HStack { Text(model.t("media.narrative_refs")).font(.headline); Spacer(); Button(model.t("media.add_source")) { addSource = true } }
                    Text(model.t("media.narrative_note")).font(.caption).foregroundStyle(.secondary)
                    ForEach(Array(sources.enumerated()), id: \.offset) { index, source in
                        HStack(alignment: .top) {
                            Text(source["quote"].string ?? "").lineLimit(4).textSelection(.enabled)
                            Spacer()
                            Button(model.t("media.remove")) { sources.remove(at: index) }
                        }
                    }
                    Divider()
                    Text(model.t("media.linked_assets")).font(.headline)
                    if assets.isEmpty { Text(model.t("media.no_assets")).foregroundStyle(.secondary) }
                    ForEach(Array(assets.enumerated()), id: \.offset) { _, asset in assetChoice(asset) }
                    Toggle(model.t("media.archived"), isOn: $archived)
                }.padding(4).disabled(pending != nil)
            }
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if pending != nil { Text(model.t("drama.pending_note")).font(.caption).foregroundStyle(.orange) }
            HStack {
                Button(model.t("common.cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(model.t(pending == nil ? "media.save" : "drama.retry")) { Task { await save() } }.keyboardShortcut(.defaultAction)
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 640, height: 650).disabled(model.busy).interactiveDismissDisabled(model.busy)
        .task {
            if editing {
                let cue = initial["cue"]
                title = cue["title"].string ?? ""; description = cue["description"].string ?? ""; kind = cue["kind"].string ?? "visual"
                archived = cue["archived"].bool ?? false; references = cue["asset_refs"].array; sources = cue["narrative_refs"].array
            } else { kind = defaultKind }
            await loadAssets()
        }
        .onChange(of: kind) { _, _ in if !editing { references = []; Task { await loadAssets() } } }
        .sheet(isPresented: $addSource) { CueSourceSheet(model: model) { ref in if !sources.contains(ref) { sources.append(ref) } } }
    }
    private func assetChoice(_ asset: JSONValue) -> some View {
        let selected = references.first { $0["asset_id"] == asset["asset_id"] }
        let current: JSONValue = .object(["asset_id": asset["asset_id"], "revision": asset["revision"], "sha256": asset["sha256"]])
        return VStack(alignment: .leading, spacing: 4) {
            Toggle(asset["title"].string ?? "", isOn: Binding(get: { selected != nil }, set: { on in
                references.removeAll { $0["asset_id"] == asset["asset_id"] }; if on { references.append(current) }
            }))
            Text(model.t("media.rights." + (asset["rights_status"].string ?? "unknown"))).font(.caption).foregroundStyle(.secondary)
            if let selected, selected != current {
                HStack {
                    Text(model.t("media.asset_stale")).font(.caption).foregroundStyle(.orange)
                    Button(model.t("media.use_current_asset")) { references.removeAll { $0["asset_id"] == asset["asset_id"] }; references.append(current) }
                }
            }
        }
    }
    private func loadAssets() async {
        assets = []; error = nil
        var cursor: String?
        repeat {
            var input: [String: JSONValue] = ["kind": .string(kind), "limit": .integer(100)]
            if let cursor { input["cursor"] = .string(cursor) }
            guard let page = await model.workspaceAction("hetu.assets.list", input: input, onFailure: { error = $0; _ = $1 }) else { return }
            assets += page["assets"].array; cursor = page["next_cursor"].string
        } while cursor != nil
    }
    private func save() async {
        if pending == nil {
            var input: [String: JSONValue] = ["kind": .string(kind), "title": .string(title), "description": .string(description), "archived": .bool(archived), "narrative_refs": .array(sources), "asset_refs": .array(references), "operation_key": .string(UUID().uuidString)]
            if editing {
                input["cue_id"] = initial["cue"]["cue_id"]
                input["expected"] = .object(["revision": initial["cue"]["revision"], "sha256": initial["sha256"]])
            }
            pending = input
        }
        guard let input = pending else { return }
        error = nil
        if let saved = await model.workspaceAction("hetu.cues.save", input: input, onFailure: { error = $0; if $1 { pending = nil } }), let id = saved["cue"]["cue_id"].string {
            pending = nil; dismiss(); onSaved(id)
        }
    }
}

private struct CueSourceSheet: View {
    let model: WorkspaceModel
    let onAdd: (JSONValue) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var documentID = ""
    @State private var result: JSONValue = .null
    @State private var span: SourceSpan?
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.t("media.add_source")).font(.title2)
            Text(model.t("media.select_quote")).foregroundStyle(.secondary)
            Picker(model.t("media.source_document"), selection: $documentID) {
                Text(model.t("media.choose_document")).tag("")
                ForEach(model.documents) { document in Text(document.title).tag(document.id) }
            }
            if let error { Text(error).foregroundStyle(.red) }
            if result != .null {
                NativeTextEditor(text: result["content"].string ?? "", documentID: result["revision"]["revision_id"].string ?? "", replacementVersion: 0, accessibleName: model.t("media.select_quote"), editable: false, onChange: { _ in }, onComposition: { _ in }, onSelection: { selection in
                    span = SourceSpan(content: result["content"].string ?? "", selection: selection)
                })
            } else { ContentUnavailableView(model.t("media.choose_document"), systemImage: "doc.text") }
            HStack {
                Button(model.t("common.cancel")) { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                if let span { Text(model.t("media.selected_count", ["count": String(span.quote.count)])).font(.caption) }
                Button(model.t("media.add_source")) {
                    guard let span else { return }
                    onAdd(.object(["document_id": result["document"]["document_id"], "revision_id": result["revision"]["revision_id"], "byte_start": .integer(Int64(span.byteStart)), "byte_end": .integer(Int64(span.byteEnd)), "quote": .string(span.quote)])); dismiss()
                }.disabled(span == nil || (span?.quote.unicodeScalars.count ?? 0) > 16000).keyboardShortcut(.defaultAction)
            }
        }.padding(24).frame(width: 720, height: 540).disabled(model.busy)
        .onChange(of: documentID) { _, id in Task {
            span = nil; result = .null; error = nil
            if !id.isEmpty { result = await model.workspaceAction("hetu.documents.get", input: ["document_id": .string(id)], onFailure: { error = $0; _ = $1 }) ?? .null }
        } }
    }
}
