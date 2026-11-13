import SwiftUI
import HetuCore
import HetuNative

struct NovelDetailsView: View {
    let model: WorkspaceModel
    @State private var editing = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                WorkbenchHeading(title: model.t("novel.details"), subtitle: model.t("novel.details_description"), artwork: "") {
                    Button(model.t(model.novel["initialized"].bool == true ? "common.edit" : "novel.initialize")) { editing = true }
                        .buttonStyle(WorkbenchButtonStyle(primary: true))
                }
                if model.novel["initialized"].bool != true {
                    Label(model.t("novel.initialize_detail"), systemImage: "info.circle").foregroundStyle(WorkbenchPalette.muted)
                }
                HStack(alignment: .top, spacing: 32) {
                    BookCoverView(title: model.title, author: model.novelMetadata["author_name"].string ?? "", identity: model.workspaceID).frame(width: 168, height: 252)
                    VStack(alignment: .leading, spacing: 18) {
                        Text(model.title).font(.system(size: 28, weight: .medium, design: .serif)).textSelection(.enabled)
                        LabeledContent(model.t("novel.author"), value: model.novelMetadata["author_name"].string.flatMap { $0.isEmpty ? nil : $0 } ?? model.t("library.no_author"))
                        LabeledContent(model.t("novel.genre"), value: model.novelMetadata["genre"].string ?? "")
                        LabeledContent(model.t("novel.status"), value: model.t("novel.status." + (model.novelMetadata["status"].string ?? "planning")))
                        LabeledContent(model.t("novel.language"), value: model.novelMetadata["language_tag"].string ?? model.locale)
                        LabeledContent(model.t("novel.structure"), value: model.t("novel.structure_count", ["volumes": String(model.volumes.count), "chapters": String(model.chapters.count)]))
                    }.frame(maxWidth: 500, alignment: .leading)
                }
                Divider()
                Text(model.t("novel.synopsis")).font(.headline)
                Text(model.novelMetadata["synopsis"].string.flatMap { $0.isEmpty ? nil : $0 } ?? model.t("novel.no_synopsis"))
                    .foregroundStyle(WorkbenchPalette.muted).lineSpacing(7).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                if let url = model.workspace?.url {
                    Divider()
                    LabeledContent(model.t("novel.folder")) { Text(url.path).textSelection(.enabled).font(.callout).foregroundStyle(WorkbenchPalette.muted) }
                }
            }.padding(36).frame(maxWidth: 980, alignment: .leading).frame(maxWidth: .infinity, alignment: .leading)
        }.workbenchPage()
            .sheet(isPresented: $editing) { NovelMetadataSheet(model: model) }
    }
}

private struct NovelMetadataSheet: View {
    let model: WorkspaceModel
    let expected: JSONValue
    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var author: String
    @State private var genre: String
    @State private var synopsis: String
    @State private var language: String
    @State private var status: String
    @State private var discarding = false
    let initial: JSONValue
    init(model: WorkspaceModel) {
        self.model = model
        expected = .object(["revision": model.novel["revision"], "sha256": model.novel["sha256"]])
        let metadata = model.novel["initialized"].bool == true ? model.novelMetadata : .object(["title": .string(model.title), "author_name": .string(""), "genre": .string(""), "synopsis": .string(""), "language_tag": .string(model.locale), "status": .string("planning")])
        initial = metadata
        _title = State(initialValue: metadata["title"].string ?? "")
        _author = State(initialValue: metadata["author_name"].string ?? "")
        _genre = State(initialValue: metadata["genre"].string ?? "")
        _synopsis = State(initialValue: metadata["synopsis"].string ?? "")
        _language = State(initialValue: metadata["language_tag"].string ?? "zh-CN")
        _status = State(initialValue: metadata["status"].string ?? "planning")
    }
    private var metadata: JSONValue { .object(["title": .string(title), "author_name": .string(author), "genre": .string(genre), "synopsis": .string(synopsis), "language_tag": .string(language), "status": .string(status)]) }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(model.t(model.novel["initialized"].bool == true ? "novel.details" : "novel.initialize")).font(.title2)
            Form {
                TextField(model.t("workspace.title"), text: $title)
                TextField(model.t("novel.author"), text: $author)
                TextField(model.t("novel.genre"), text: $genre)
                Picker(model.t("novel.status"), selection: $status) {
                    ForEach(["planning", "writing", "completed", "archived"], id: \.self) { Text(model.t("novel.status." + $0)).tag($0) }
                }
                TextField(model.t("novel.language"), text: $language)
            }
            Text(model.t("novel.synopsis")).font(.headline)
            TextEditor(text: $synopsis).font(.body).frame(height: 160).border(WorkbenchPalette.line)
            if model.novel["initialized"].bool != true { Text(model.t("novel.initialize_detail")).font(.callout).foregroundStyle(.secondary) }
            HStack {
                Button(model.t("common.cancel")) { if metadata != initial { discarding = true } else { dismiss() } }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(model.t(model.novel["initialized"].bool == true ? "novel.save_details" : "novel.initialize")) {
                    Task { if await model.saveNovelMetadata(metadata, expected: expected) { dismiss() } }
                }.keyboardShortcut(.defaultAction).disabled(model.busy || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 560).interactiveDismissDisabled(metadata != initial || model.busy)
            .confirmationDialog(model.t("novel.discard"), isPresented: $discarding) { Button(model.t("novel.discard_confirm"), role: .destructive) { dismiss() } }
    }
}

struct NovelStructureSheet: View {
    let model: WorkspaceModel
    let expected: JSONValue
    let initialVolumes: [JSONValue]
    let initialChapters: [JSONValue]
    @Environment(\.dismiss) private var dismiss
    @State private var volumes: [JSONValue]
    @State private var chapters: [JSONValue]
    @State private var volumeTitle = ""
    @State private var discarding = false
    init(model: WorkspaceModel) {
        self.model = model
        expected = .object(["revision": model.novel["revision"], "sha256": model.novel["sha256"]])
        initialVolumes = model.volumes; initialChapters = model.chapters
        _volumes = State(initialValue: model.volumes); _chapters = State(initialValue: model.chapters)
    }
    private var dirty: Bool { volumes != initialVolumes || chapters != initialChapters }
    private func ordered() -> [JSONValue] {
        ([JSONValue.null] + volumes.map { $0["volume_id"] }).flatMap { group in chapters.filter { $0["volume_id"] == group } }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(model.t("novel.manage_structure")).font(.title2)
            Text(model.t("novel.structure_detail")).foregroundStyle(.secondary).font(.callout)
            HStack {
                TextField(model.t("novel.volume_title"), text: $volumeTitle)
                Button(model.t("novel.add_volume")) {
                    volumes.append(.object(["volume_id": .string("volume_" + UUID().uuidString.lowercased()), "title": .string(volumeTitle)])); volumeTitle = ""
                }.disabled(volumeTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    group(.null)
                    ForEach(Array(volumes.enumerated()), id: \.offset) { index, _ in
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                TextField(model.t("novel.volume_title"), text: Binding(get: { volumes[index]["title"].string ?? "" }, set: { value in var v = volumes[index].object; v["title"] = .string(value); volumes[index] = .object(v) }))
                                Button { volumes.swapAt(index, index - 1) } label: { Image(systemName: "arrow.up") }.disabled(index == 0).help(model.t("novel.move_up"))
                                Button { volumes.swapAt(index, index + 1) } label: { Image(systemName: "arrow.down") }.disabled(index == volumes.count - 1).help(model.t("novel.move_down"))
                            }
                            group(volumes[index]["volume_id"])
                        }
                    }
                }.padding(.vertical, 8)
            }.frame(minHeight: 240, maxHeight: 440)
            HStack {
                Button(model.t("common.cancel")) { if dirty { discarding = true } else { dismiss() } }.keyboardShortcut(.cancelAction)
                Spacer()
                Button(model.t("novel.save_structure")) { Task { if await model.saveNovelStructure(volumes: volumes, chapters: ordered(), expected: expected) { dismiss() } } }
                    .keyboardShortcut(.defaultAction).disabled(model.busy || !dirty || volumes.contains { ($0["title"].string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
            }
        }.padding(24).frame(width: 680).interactiveDismissDisabled(dirty || model.busy)
            .confirmationDialog(model.t("novel.discard"), isPresented: $discarding) { Button(model.t("novel.discard_confirm"), role: .destructive) { dismiss() } }
    }
    private func group(_ volumeID: JSONValue) -> some View {
        let rows = chapters.indices.filter { chapters[$0]["volume_id"] == volumeID }
        return VStack(alignment: .leading, spacing: 8) {
            if volumeID == .null { Text(model.t("novel.unassigned")).font(.headline) }
            ForEach(Array(rows.enumerated()), id: \.element) { position, index in
                HStack(spacing: 10) {
                    Text(model.documents.first { $0.id == chapters[index]["document_id"].string }?.title ?? model.t("draft.untitled")).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    Picker(model.t("novel.volume"), selection: Binding(get: { chapters[index]["volume_id"].string ?? "" }, set: { value in
                        var c = chapters[index].object; c["volume_id"] = value.isEmpty ? .null : .string(value); chapters[index] = .object(c)
                    })) {
                        Text(model.t("novel.unassigned")).tag("")
                        ForEach(Array(volumes.enumerated()), id: \.offset) { _, volume in Text(volume["title"].string ?? "").tag(volume["volume_id"].string ?? "") }
                    }.labelsHidden().frame(width: 160)
                    Button { chapters.swapAt(index, rows[position - 1]) } label: { Image(systemName: "arrow.up") }.disabled(position == 0).help(model.t("novel.move_up"))
                    Button { chapters.swapAt(index, rows[position + 1]) } label: { Image(systemName: "arrow.down") }.disabled(position == rows.count - 1).help(model.t("novel.move_down"))
                }.padding(.vertical, 4)
            }
            if rows.isEmpty { Text(model.t("novel.volume_empty")).font(.caption).foregroundStyle(.secondary) }
        }
    }
}
