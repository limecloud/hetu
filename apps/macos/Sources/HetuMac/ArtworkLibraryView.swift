import AppKit
import SwiftUI
import HetuCore
import HetuNative

struct ArtworkLibraryView: View {
    let model: WorkspaceModel
    var entityRef: String? = nil
    var documentID: String? = nil
    var filterCategory: String? = nil
    @Environment(\.scenePhase) private var phase
    @State private var library = ArtworkLibrarySession()
    @State private var category = "all"
    @State private var query = ""
    @State private var selected: ArtworkItem?
    private let categories = ["all", "cover", "character", "scene", "prop", "illustration", "costume", "other"]
    private var visible: [ArtworkItem] {
        library.items.filter { item in
            (entityRef == nil && documentID == nil || item.matches(entity: entityRef, document: documentID))
                && (filterCategory == nil || item.category == filterCategory)
                && (category == "all" || item.category == category)
                && (query.isEmpty || (item.candidate["title"].string ?? "").localizedStandardContains(query))
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(model.t(filterCategory == "cover" ? "artwork.covers" : "artwork.library")).font(.system(size: 20, weight: .semibold))
                Spacer()
                TextField(model.t("artwork.search"), text: $query).textFieldStyle(.roundedBorder).frame(maxWidth: 220)
                Button(model.t("common.refresh")) { Task { await library.load(model: model) } }.disabled(library.loading)
                ArtworkAgentButton(model: model, entityRef: entityRef, documentID: documentID)
            }
            if filterCategory == nil {
            HStack(spacing: 8) {
                ForEach(categories, id: \.self) { value in
                    Button { category = value } label: {
                        Text(model.t("artwork.category." + value)).font(.system(size: 14, weight: category == value ? .semibold : .regular))
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .foregroundStyle(category == value ? WorkbenchPalette.jade : WorkbenchPalette.muted)
                            .background(category == value ? WorkbenchPalette.jadeSoft : .clear, in: RoundedRectangle(cornerRadius: 6))
                    }.buttonStyle(.plain).accessibilityAddTraits(category == value ? [.isSelected] : [])
                }
                Spacer(minLength: 0)
            }
            }
            if let error = library.error { Text(error).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.danger).textSelection(.enabled) }
            if library.loading { ProgressView().controlSize(.small) }
            if visible.isEmpty && !library.loading {
                VStack(spacing: 12) {
                    Image(systemName: "photo.on.rectangle.angled").font(.system(size: 20)).foregroundStyle(WorkbenchPalette.muted)
                    Text(model.t(library.error == nil ? "artwork.empty" : "artwork.load_failed")).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.muted)
                    ArtworkAgentButton(model: model, entityRef: entityRef, documentID: documentID)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 190, maximum: 250), spacing: 20)], alignment: .leading, spacing: 24) {
                        ForEach(visible) { item in
                            Button { selected = item } label: {
                                VStack(alignment: .leading, spacing: 9) {
                                    ArtworkThumbnail(item: item).frame(height: 218)
                                    Text(item.candidate["title"].string ?? "").font(.system(size: 14, weight: .semibold)).lineLimit(2)
                                    HStack {
                                        Text(model.t("artwork.category." + item.category))
                                        Spacer()
                                        Text("\(item.candidate["width"].integer ?? 0) × \(item.candidate["height"].integer ?? 0)")
                                    }.font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                                }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                        }
                    }.padding(.vertical, 4)
                    if library.nextCursor != nil { Button(model.t("creative.more")) { Task { await library.load(model: model, more: true) } }.padding(.vertical, 16).disabled(library.loading) }
                }
            }
        }.padding(24).workbenchPage()
        .task(id: model.workspaceID) { await library.load(model: model) }
        .onChange(of: phase) { _, phase in if phase == .active && !library.loading { Task { await library.load(model: model) } } }
        .sheet(item: $selected, onDismiss: { Task { await library.load(model: model) } }) { ArtworkDetailSheet(model: model, item: $0) }
    }
}

struct ArtworkThumbnail: View {
    let item: ArtworkItem
    var body: some View {
        ZStack {
            Rectangle().fill(WorkbenchPalette.page)
            if let raw = item.preview["base64"].string, let data = Data(base64Encoded: raw), let image = NSImage(data: data) {
                Image(nsImage: image).resizable().scaledToFit().padding(8)
            } else { Image(systemName: "photo").foregroundStyle(WorkbenchPalette.muted) }
        }.clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(WorkbenchPalette.line, lineWidth: 0.5))
            .accessibilityLabel(item.candidate["title"].string ?? "")
    }
}

struct ArtworkDetailSheet: View {
    let model: WorkspaceModel
    let item: ArtworkItem
    @Environment(\.dismiss) private var dismiss
    @State private var session: CreativeTaskSession
    init(model: WorkspaceModel, item: ArtworkItem) {
        self.model = model; self.item = item
        _session = State(initialValue: CreativeTaskSession(model: model))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(item.candidate["title"].string ?? "").font(.system(size: 20, weight: .semibold))
                Spacer()
                Button(model.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction)
            }
            HSplitView {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(Array(session.task["submission"]["candidates"].array.enumerated()), id: \.offset) { _, candidate in
                            CreativeImageCandidate(model: model, session: session, candidate: candidate, maxHeight: 640)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.trailing, 16)
                }.frame(minWidth: 440)
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text(model.t("artwork.reference")).font(.system(size: 14, weight: .semibold))
                        let record = session.task["submission"]
                        Text(record["provenance"]["model"].string ?? item.provenance["model"].string ?? "").font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                        Text(model.localizer.date(record["received_at"].string ?? item.receivedAt)).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                        ForEach(Array(session.task["submission"]["candidates"].array.enumerated()), id: \.offset) { _, candidate in
                            ForEach(Array(candidate["subject_refs"].array.enumerated()), id: \.offset) { _, ref in
                                Text(subjectName(ref)).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                            }
                        }
                        if session.task["observation"]["submission_refs"].array.count > 1 {
                            Menu(model.t("creative.batches")) {
                                ForEach(Array(session.task["observation"]["submission_refs"].array.enumerated()), id: \.offset) { index, batch in
                                    Button(model.t("artwork.version", ["number": String(index + 1)])) { Task { await session.loadTask(item.taskRef, submissionID: batch["submission_id"].string) } }
                                }
                            }
                        }
                        Divider()
                        TaskContinuationView(task: session.task, locale: model.locale, held: session.held || model.busy,
                            read: { await session.read($0, input: $1) }, save: { await session.mutate("hetu.task_feedback.save", input: $0) })
                        if let error = session.error { Text(error).foregroundStyle(WorkbenchPalette.danger).font(.system(size: 12)).textSelection(.enabled) }
                    }.padding(.leading, 16).frame(maxWidth: .infinity, alignment: .leading)
                }.frame(minWidth: 290, idealWidth: 330, maxWidth: 400)
            }
        }.padding(24).frame(minWidth: 850, idealWidth: 1050, minHeight: 650, idealHeight: 800)
        .task { await session.loadTask(item.taskRef, submissionID: item.submissionID) }
    }
    private func subjectName(_ ref: JSONValue) -> String {
        if let entity = ref["entity_ref"].string { return displayName(model, reference: entity) }
        return model.documents.first { $0.id == ref["document_id"].string }?.title ?? model.t("entity.unavailable")
    }
}

struct ArtworkAgentButton: View {
    @State private var copied = false
    let model: WorkspaceModel
    var entityRef: String? = nil
    var documentID: String? = nil
    var body: some View {
        Button { copy() } label: { Label(model.t(copied ? "artwork.copied" : "artwork.agent"), systemImage: copied ? "checkmark" : "sparkles") }
    }
    private func copy() {
        var target: [String: JSONValue] = ["scope_ref": .object(["kind": .string("workspace"), "id": .string(model.workspaceID)])]
        if let entityRef { target["entity_ref"] = .string(entityRef); target["blueprint_revision"] = model.bible["blueprint"]["revision"] }
        if let documentID { target["document_id"] = .string(documentID); if model.documentID == documentID { target["revision_id"] = .string(model.baseRevisionID) } }
        let context = String(decoding: (try? JSONValue.object(target).encoded(pretty: true)) ?? Data(), as: UTF8.self)
        let text = model.t("artwork.agent_prompt") + "\n" + context + "\n" + (model.workspace?.url.path ?? "")
        NSPasteboard.general.clearContents(); copied = NSPasteboard.general.setString(text, forType: .string)
    }
}

/// 正文和剧本侧栏展示明确关联的插图，不把整份参考设定中的图片自动挂到每一章。
struct RelatedArtworkStrip: View {
    let model: WorkspaceModel
    let documentID: String
    @Environment(\.scenePhase) private var phase
    @State private var library = ArtworkLibrarySession()
    @State private var selected: ArtworkItem?
    private var images: [ArtworkItem] { library.items.filter { $0.matches(document: documentID) } }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack { Text(model.t("artwork.related")).font(.system(size: 14, weight: .semibold)); Spacer(); ArtworkAgentButton(model: model, documentID: documentID).labelStyle(.iconOnly) }
            if let error = library.error { Text(error).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.danger) }
            if images.isEmpty { Text(model.t("artwork.no_related")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted) }
            ForEach(images) { item in
                Button { selected = item } label: { ArtworkThumbnail(item: item).frame(height: 150) }.buttonStyle(.plain)
                Text(item.candidate["title"].string ?? "").font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
            }
            if library.nextCursor != nil { Button(model.t("creative.more")) { Task { await library.load(model: model, more: true) } }.font(.system(size: 12)) }
        }.task(id: model.workspaceID + documentID) { await library.load(model: model) }
        .onChange(of: phase) { _, phase in if phase == .active && !library.loading { Task { await library.load(model: model) } } }
        .sheet(item: $selected) { ArtworkDetailSheet(model: model, item: $0) }
    }
}

struct EntityArtworkSheet: View {
    let model: WorkspaceModel
    let kind: BibleKind
    let entity: JSONValue
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(entityTitle(model, kind, entity)).font(.system(size: 20, weight: .semibold))
                Spacer()
                Button(model.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction)
            }
            DisclosureGroup(model.t("artwork.subject_details")) {
                ScrollView { HistoricalEntityDetails(model: model, kind: kind, entity: entity, blueprint: model.bible["blueprint"]) }.frame(maxHeight: 180)
            }
            ArtworkLibraryView(model: model, entityRef: entity[kind.idKey].string)
        }.padding(24).frame(minWidth: 920, idealWidth: 1080, minHeight: 650, idealHeight: 780)
    }
}

struct ArtworkLibrarySheet: View {
    let model: WorkspaceModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(alignment: .trailing, spacing: 0) {
            Button(model.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction).padding(16)
            ArtworkLibraryView(model: model)
        }.frame(minWidth: 940, idealWidth: 1100, minHeight: 650, idealHeight: 800)
    }
}
