import AppKit
import SwiftUI
import HetuCore
import HetuNative

struct ArtworkLibraryView: View {
    let model: WorkspaceModel
    var entityRef: String? = nil
    var documentID: String? = nil
    var filterCategory: String? = nil
    var embedded = false
    @Environment(\.scenePhase) private var phase
    private var library: ArtworkLibrarySession { model.artworkLibrary }
    @State private var category = "all"
    @State private var query = ""
    @State private var selected: ArtworkItem?
    @State private var coverSelection: CoverSession?
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
                Text(model.t(filterCategory == "cover" ? "artwork.covers" : filterCategory == "character" ? "artwork.character_images" : "artwork.library")).font(.system(size: 20, weight: .semibold))
                Spacer()
                if !embedded { TextField(model.t("artwork.search"), text: $query).textFieldStyle(.roundedBorder).frame(maxWidth: 220) }
                Button(model.t("common.refresh")) { Task { await library.load(model: model); await refreshCoverSelection() } }.disabled(library.loading)
                ArtworkAgentButton(model: model, entityRef: entityRef, documentID: documentID)
            }
            if embedded { TextField(model.t("artwork.search"), text: $query).textFieldStyle(.roundedBorder).frame(maxWidth: 240) }
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
            if let error = coverSelection?.error { Text(error).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.danger).textSelection(.enabled) }
            if coverSelection?.pending != nil { Button(model.t("drama.retry")) { Task { await coverSelection?.retry() } } }
            if library.loading { ProgressView().controlSize(.small) }
            if visible.isEmpty && !library.loading {
                VStack(spacing: 12) {
                    Image(systemName: "photo.on.rectangle.angled").font(.system(size: 20)).foregroundStyle(WorkbenchPalette.muted)
                    Text(model.t(library.error == nil ? "artwork.empty" : "artwork.load_failed")).font(.system(size: 14)).foregroundStyle(WorkbenchPalette.muted)
                    ArtworkAgentButton(model: model, entityRef: entityRef, documentID: documentID)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 190, maximum: 250), spacing: 20, alignment: .top)], alignment: .leading, spacing: 24) {
                        ForEach(visible) { item in
                            VStack(alignment: .leading, spacing: 10) {
                            Button { selected = item } label: {
                                VStack(alignment: .leading, spacing: 9) {
                                    ArtworkThumbnail(item: item).frame(height: 218)
                                    Text(item.candidate["title"].string ?? "").font(.system(size: 14, weight: .semibold)).lineLimit(2, reservesSpace: true)
                                    HStack {
                                        Text(model.t(item.imageView.map { "artwork.view." + $0 } ?? "artwork.category." + item.category))
                                        Spacer()
                                        Text("\(item.candidate["width"].integer ?? 0) × \(item.candidate["height"].integer ?? 0)")
                                    }.font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                                }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                            if item.taskKind == "cover" {
                                if item.isCurrentCover(model.cover) {
                                    Label(model.t("cover.selected"), systemImage: "checkmark.circle.fill")
                                        .font(.system(size: 12)).foregroundStyle(WorkbenchPalette.jade)
                                } else {
                                    Button(model.t("cover.use")) { Task {
                                        let overlay = !(model.cover["cover"]["presentation"]["title_overlay"].string ?? "").isEmpty
                                        _ = await coverSelection?.selectTaskCandidate(item.coverReference, overlay: overlay)
                                    } }.disabled(model.busy || coverSelection == nil || coverSelection?.held == true)
                                }
                            }
                            }
                        }
                    }.padding(.vertical, 4)
                    if library.nextCursor != nil { Button(model.t("creative.more")) { Task { await library.load(model: model, more: true) } }.padding(.vertical, 16).disabled(library.loading) }
                }
            }
        }.padding(embedded ? 0 : 24).workbenchPage()
        .task(id: model.workspaceID) { coverSelection = nil; await library.load(model: model); await refreshCoverSelection() }
        .onChange(of: phase) { _, phase in if phase == .active && !library.loading { Task { await library.load(model: model); await refreshCoverSelection() } } }
        .sheet(item: $selected, onDismiss: { Task { await library.load(model: model); await refreshCoverSelection() } }) { ArtworkDetailSheet(model: model, item: $0) }
    }
    private func refreshCoverSelection() async {
        guard library.items.contains(where: { $0.taskKind == "cover" }) else { return }
        if coverSelection == nil { coverSelection = CoverSession(model: model) }
        await coverSelection?.refresh()
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
    @State private var selectedCandidateID: String
    private var images: [ArtworkItem] { ArtworkItem.latest(session.task) }
    private var focused: ArtworkItem? { images.first { $0.id == selectedCandidateID } ?? images.first }
    init(model: WorkspaceModel, item: ArtworkItem) {
        self.model = model; self.item = item
        _session = State(initialValue: CreativeTaskSession(model: model))
        _selectedCandidateID = State(initialValue: item.id)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text((focused ?? item).candidate["title"].string ?? "").font(.system(size: 20, weight: .semibold))
                Spacer()
                Button(model.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction)
            }
            HSplitView {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if let focused {
                            CreativeImageCandidate(model: model, session: session, candidate: focused.candidate, maxHeight: 580)
                        }
                        if images.count > 1 {
                            ScrollView(.horizontal) {
                                HStack(alignment: .top, spacing: 12) {
                                    ForEach(images) { image in
                                        Button { selectedCandidateID = image.id } label: {
                                            VStack(spacing: 6) {
                                                ArtworkThumbnail(item: image).frame(width: 88, height: 100)
                                                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(focused?.id == image.id ? WorkbenchPalette.jade : .clear, lineWidth: 0.5))
                                                Text(model.t(image.imageView.map { "artwork.view." + $0 } ?? "artwork.category." + image.category)).font(.system(size: 12))
                                            }
                                        }.buttonStyle(.plain).accessibilityLabel(image.candidate["title"].string ?? "")
                                            .accessibilityAddTraits(focused?.id == image.id ? [.isSelected] : [])
                                    }
                                }.padding(.vertical, 4)
                            }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.trailing, 16)
                }.frame(minWidth: 440)
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text(model.t("artwork.reference")).font(.system(size: 14, weight: .semibold))
                        let record = session.task["submission"]
                        Text(record["provenance"]["model"].string ?? item.provenance["model"].string ?? "").font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                        Text(model.localizer.date(record["received_at"].string ?? item.receivedAt)).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                        if let view = focused?.imageView { Text(model.t("artwork.view." + view)).font(.system(size: 14)) }
                        ForEach(Array((focused?.candidate["subject_refs"].array ?? []).enumerated()), id: \.offset) { _, ref in
                            Text(subjectName(ref)).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
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
                            read: { await session.read($0, input: $1) }, save: { await session.mutate("hetu.task_feedback.save", input: $0) }, preferredCandidateID: focused?.id)
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
        Button { Task { await copy() } } label: { Label(model.t(copied ? "artwork.copied" : "artwork.agent"), systemImage: copied ? "checkmark" : "sparkles") }.disabled(model.busy)
    }
    private func copy() async {
        var target: [String: JSONValue] = [:]
        if let reference = model.workReference { target["work_ref"] = reference.value }
        if let entityRef { target["entity_ref"] = .string(entityRef); target["blueprint_revision"] = model.bible["blueprint"]["revision"] }
        if let documentID { target["document_id"] = .string(documentID); if model.documentID == documentID { target["revision_id"] = .string(model.baseRevisionID) } }
        guard let workspace = model.workspace?.url,
              let context = await model.workspaceAction("hetu.handoffs.get", input: ["view_kind": .string("artwork"), "object_ref": .object(target)], onFailure: { model.message = $0; _ = $1 }) else { return }
        do {
            let helper = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/hetu")
            guard FileManager.default.isExecutableFile(atPath: helper.path) else { model.message = model.t("handoff.cli_missing"); return }
            let selected = model.agentIntegration.association(for: model.workspaceID).client
            let adapter = selected == .claudeCode ? "claude-code" : selected == .other || selected == .none ? "generic" : selected.rawValue
            var authorization: [String: JSONValue] = ["client_adapter": .string(adapter), "operation_key": .string(UUID().uuidString)]
            if let reference = model.workReference { authorization["work_ref"] = reference.value }
            guard let grant = await model.workspaceAction("hetu.collaboration.authorize_workspace", input: authorization, onFailure: { model.message = $0; _ = $1 }) else { return }
            let text = model.t("artwork.agent_prompt") + "\n" + (try PageHandoff.prompt(context: context, workspace: workspace, executable: helper, locale: model.locale, suite: model.agentIntegration.association(for: model.workspaceID).suiteID, clientAdapter: adapter, managementRef: grant["management_ref"]))
            NSPasteboard.general.clearContents(); copied = NSPasteboard.general.setString(text, forType: .string)
        } catch { model.message = model.localizer.error(error) }
    }
}

/// 正文和剧本侧栏展示明确关联的插图，不把整份参考设定中的图片自动挂到每一章。
struct RelatedArtworkStrip: View {
    let model: WorkspaceModel
    let documentID: String
    @Environment(\.scenePhase) private var phase
    private var library: ArtworkLibrarySession { model.artworkLibrary }
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
    @State private var category = "character"
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(entityTitle(model, kind, entity)).font(.system(size: 20, weight: .semibold))
                Spacer()
                PageAgentButton(model: model, page: "entity", object: .object(["entity_ref": entity[kind.idKey], "blueprint_revision": model.bible["revision"]]))
                Button(model.t("common.close")) { dismiss() }.keyboardShortcut(.cancelAction)
            }
            DisclosureGroup(model.t("artwork.subject_details")) {
                ScrollView { HistoricalEntityDetails(model: model, kind: kind, entity: entity, blueprint: model.bible["blueprint"]) }.frame(maxHeight: 180)
            }
            if kind == .character {
                Picker(model.t("artwork.character_sections"), selection: $category) {
                    Text(model.t("artwork.character_images")).tag("character")
                    Text(model.t("artwork.costume_images")).tag("costume")
                    Text(model.t("artwork.related_illustrations")).tag("illustration")
                }.pickerStyle(.segmented).labelsHidden()
                ArtworkLibraryView(model: model, entityRef: entity[kind.idKey].string, filterCategory: category)
            } else {
                ArtworkLibraryView(model: model, entityRef: entity[kind.idKey].string)
            }
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
