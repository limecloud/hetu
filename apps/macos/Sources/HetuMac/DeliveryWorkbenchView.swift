import AppKit
import SwiftUI
import UniformTypeIdentifiers
import HetuCore
import HetuNative

struct DeliveryWorkbenchView: View {
    let model: WorkspaceModel
    @State private var session: DeliverySession
    @State private var exportKind = "novel_chapter"
    @State private var attachmentKind: DeliveryAttachmentKind = .skeletons
    init(model: WorkspaceModel) {
        self.model = model
        let session = DeliverySession(model: model)
        _session = State(initialValue: session)
        _exportKind = State(initialValue: session.profile == "hetu-screenplay-zh/1" ? "drama_script" : "novel_chapter")
    }
    private var selectedKind: String { session.mode == .importDocument ? session.importKind : exportKind }
    private var isDrama: Bool { selectedKind == "drama_script" }
    private var formats: [String] {
        if session.mode == .importDocument { return isDrama ? ["fountain", "docx"] : ["txt", "markdown", "docx"] }
        return isDrama ? ["docx", "pdf", "fountain", "txt"] : ["docx", "pdf", "txt", "markdown"]
    }
    private var documents: [DocumentItem] {
        let chapters = model.orderedChapters
        return selectedKind == "novel_chapter" ? chapters : model.documents.filter { $0.kind == "drama_script" }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(model.t("delivery.title")).font(.system(size: 20, weight: .semibold))
            Picker(model.t("delivery.operation"), selection: $session.mode) {
                Text(model.t("delivery.import")).tag(DeliveryMode.importDocument)
                Text(model.t("delivery.export")).tag(DeliveryMode.exportDocuments)
                Text(model.t("delivery.bundle")).tag(DeliveryMode.bundle)
            }.pickerStyle(.segmented).disabled(session.held)
            if let error = session.error { Text(error).foregroundStyle(WorkbenchPalette.warningInk).textSelection(.enabled) }
            if let pending = session.pending {
                HStack {
                    if model.isDeliveryRunning(pending) { ProgressView().controlSize(.small); Text(model.t("delivery.running")) }
                    else { Button(model.t("delivery.resume")) { Task { await session.retry() } }.disabled(session.busy || model.busy) }
                }
            }
            HSplitView {
                ScrollView { VStack(alignment: .leading, spacing: 16) {
                    if session.mode == .importDocument { importForm } else { exportForm }
                    Button(model.t("delivery.preview")) { Task { await session.prepare() } }
                        .disabled(!session.canPrepare)
                }.padding(.trailing, 16).frame(maxWidth: .infinity, alignment: .leading) }.frame(minWidth: 280, idealWidth: 350, maxWidth: 420)
                ScrollView { VStack(alignment: .leading, spacing: 16) { preview; result }.padding(.leading, 16).frame(maxWidth: .infinity, alignment: .leading) }.frame(minWidth: 360)
            }
        }.font(.system(size: 14)).padding(28).workbenchPage()
        .onChange(of: session.mode) { _, _ in normalizeFormat() }
        .onChange(of: session.importKind) { _, _ in normalizeFormat() }
        .onChange(of: exportKind) { _, _ in session.selectedDocuments = []; normalizeFormat() }
    }
    private var importForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker(model.t("document.kind"), selection: $session.importKind) {
                Text(model.t("delivery.novel")).tag("novel_chapter")
                Text(model.t("delivery.drama")).tag("drama_script")
            }
            Button(model.t("delivery.choose_file")) { chooseFile() }.disabled(session.held)
            if let file = session.importFile { Text(file.lastPathComponent).textSelection(.enabled) }
            TextField(model.t("document.title"), text: $session.importTitle).textFieldStyle(.roundedBorder)
            formatFields
            Picker(model.t("delivery.language"), selection: $session.importLanguage) { Text("简体中文").tag("zh-CN"); Text("English").tag("en") }
            if !isDrama, !model.volumes.isEmpty {
                Picker(model.t("delivery.volume"), selection: $session.importVolumeID) {
                    Text(model.t("delivery.no_volume")).tag(String?.none)
                    ForEach(model.volumes.indices, id: \.self) { index in
                        Text(model.volumes[index]["title"].string ?? "").tag(model.volumes[index]["volume_id"].string)
                    }
                }
            }
        }.disabled(session.held)
    }
    private var exportForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            if session.mode == .exportDocuments {
                Picker(model.t("document.kind"), selection: $exportKind) {
                    Text(model.t("delivery.novel")).tag("novel_chapter")
                    Text(model.t("delivery.drama")).tag("drama_script")
                }
                formatFields
                Toggle(model.t("delivery.use_finalized"), isOn: $session.useFinalizedRevisions)
            } else {
                Picker(model.t("delivery.bundle_profile"), selection: $session.bundleProfile) {
                    Text(model.t("delivery.production")).tag("production_delivery")
                    Text(model.t("delivery.review")).tag("review_delivery")
                }
                Text(model.t("delivery.reading_formats")).font(.system(size: 16, weight: .semibold))
                HStack {
                    ForEach(["docx", "pdf", "txt"], id: \.self) { format in
                        Toggle(model.t("delivery.format." + format), isOn: Binding(get: { session.readingFormats.contains(format) }, set: { if $0 { session.readingFormats.insert(format) } else { session.readingFormats.remove(format) } }))
                    }
                }
            }
            HStack {
                Text(model.t("delivery.documents")).font(.system(size: 16, weight: .semibold))
                Spacer()
                if !session.isSingleDocumentExport {
                    Button(model.t("git.select_all")) { session.selectedDocuments = Set(availableDocuments.map(\.id)) }.controlSize(.small)
                }
                Button(model.t("git.select_none")) { session.selectedDocuments = [] }.controlSize(.small)
            }
            if availableDocuments.isEmpty { Text(model.t("delivery.no_documents")).foregroundStyle(WorkbenchPalette.muted) }
            ForEach(availableDocuments) { document in
                Toggle(isOn: Binding(get: { session.selectedDocuments.contains(document.id) }, set: {
                    if $0 {
                        if session.isSingleDocumentExport { session.selectedDocuments = [document.id] }
                        else { session.selectedDocuments.insert(document.id) }
                    } else { session.selectedDocuments.remove(document.id) }
                })) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(document.title)
                        HStack(spacing: 8) {
                            if session.mode == .bundle { Text(model.t(document.kind == "drama_script" ? "delivery.drama" : "delivery.novel")) }
                            Text(model.t(document.value["approved_revision_id"] == .null ? "delivery.working" : "delivery.finalized_available"))
                        }.font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                    }
                }
            }
            Text(model.t("delivery.selected_count", ["count": String(session.selectedDocuments.count)])).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
            if session.mode == .bundle { attachmentForm }
        }.disabled(session.held)
    }
    private var availableDocuments: [DocumentItem] {
        session.mode == .bundle ? model.orderedChapters + model.documents.filter { $0.kind == "drama_script" } : documents
    }
    private var formatFields: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker(model.t("delivery.format"), selection: $session.format) {
                ForEach(formats, id: \.self) { format in Text(model.t("delivery.format." + format)).tag(format) }
            }
            if session.format == "docx" || session.format == "pdf" {
                LabeledContent(model.t("delivery.layout"), value: model.t(isDrama ? "delivery.layout.screenplay" : "delivery.layout.novel"))
            }
        }
    }
    private var attachmentForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider()
            Text(model.t("delivery.attachments")).font(.system(size: 16, weight: .semibold))
            Label(model.t("bible.title"), systemImage: "checkmark").foregroundStyle(WorkbenchPalette.muted)
            Picker(model.t("delivery.attachment_type"), selection: $attachmentKind) {
                ForEach(DeliveryAttachmentKind.allCases, id: \.self) { kind in Text(model.t("delivery.attachment." + kind.rawValue)).tag(kind) }
            }.onChange(of: attachmentKind) { _, kind in Task {
                if kind == .comparisons, session.attachments[.skeletons] == nil { await session.loadAttachments(.skeletons) }
                if kind != .comparisons, session.attachments[kind] == nil { await session.loadAttachments(kind) }
            } }
            if attachmentKind == .comparisons { comparisonFilter }
            Button(model.t("common.refresh")) { Task { await session.loadAttachments(attachmentKind) } }
            ForEach(Array((session.attachments[attachmentKind] ?? []).enumerated()), id: \.offset) { index, item in
                Toggle(isOn: Binding(get: { session.selectedAttachments[attachmentKind, default: []].contains(attachmentKind.identity(item)) }, set: { on in
                    var ids = session.selectedAttachments[attachmentKind, default: []]
                    if on { ids.insert(attachmentKind.identity(item)) } else { ids.remove(attachmentKind.identity(item)) }
                    session.selectedAttachments[attachmentKind] = ids
                })) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item["title"].string ?? model.t("delivery.item_number", ["type": model.t("delivery.attachment." + attachmentKind.rawValue), "number": String(index + 1)]))
                        if attachmentKind == .assets, item["delivery_eligible"].bool == false {
                            Text(model.t("delivery.asset_metadata_only")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.warningInk)
                        } else if let date = item["created_at"].string ?? item["updated_at"].string {
                            Text(model.localizer.date(date)).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted)
                        }
                    }
                }
            }
            if session.cursors[attachmentKind] != nil { Button(model.t("creative.more")) { Task { await session.loadAttachments(attachmentKind, append: true) } } }
        }
    }
    private var comparisonFilter: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker(model.t("delivery.comparison_skeleton"), selection: $session.comparisonSkeletonID) {
                Text(model.t("delivery.choose_skeleton")).tag(String?.none)
                ForEach(Array(comparisonSkeletons.enumerated()), id: \.offset) { index, skeleton in
                    Text(model.t("delivery.skeleton_number", ["number": String(index + 1)]) + " " + model.localizer.date(skeleton["created_at"].string ?? "")).tag(skeleton["skeleton_id"].string)
                }
            }.onChange(of: session.comparisonSkeletonID) { _, id in if id != nil { Task { await session.loadAttachments(.comparisons) } } }
            if session.cursors[.skeletons] != nil {
                Button(model.t("creative.more")) { Task { await session.loadAttachments(.skeletons, append: true) } }
            }
        }
    }
    private var comparisonSkeletons: [JSONValue] {
        var seen: Set<String> = []
        return (session.attachments[.skeletons] ?? []).filter { seen.insert($0["skeleton_id"].string ?? "").inserted }
    }
    @ViewBuilder private var preview: some View {
        if session.busy, session.pending == nil { ProgressView().controlSize(.small) }
        if session.preview != .null {
            Text(model.t("delivery.preview_title")).font(.system(size: 16, weight: .semibold))
            if session.mode == .importDocument {
                let content = session.preview["converted"]["content"].string ?? ""
                Text(String(content.prefix(16_000))).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                if content.count > 16_000 { Text(model.t("delivery.preview_truncated")).font(.system(size: 12)).foregroundStyle(WorkbenchPalette.muted) }
                notices(session.preview["converted"]["warnings"], title: "delivery.notices")
                notices(session.preview["converted"]["losses"], title: "delivery.losses")
            } else {
                fixedDocuments
                DisclosureGroup(model.t("delivery.files", ["count": String(session.preview["files"].array.count)])) {
                    ForEach(Array(session.preview["files"].array.enumerated()), id: \.offset) { _, file in
                        HStack {
                            Text(file["path"].string ?? "").lineLimit(2).textSelection(.enabled)
                            Spacer()
                            Text(model.localizer.byteCount(file["size_bytes"].integer ?? 0)).foregroundStyle(WorkbenchPalette.muted)
                        }
                    }
                }
                notices(session.preview["warnings"], title: "delivery.notices")
                notices(session.preview["exclusions"], title: "delivery.exclusions")
                notices(session.preview["blockers"], title: "delivery.blockers")
            }
            Button(model.t(session.mode == .importDocument ? "delivery.confirm_import" : "delivery.confirm_export")) { Task {
                _ = await session.commit(acknowledgement: model.t("delivery.author_ack"))
            } }.buttonStyle(WorkbenchButtonStyle(primary: true)).disabled(!session.canCommit)
        }
    }
    private var fixedDocuments: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(session.preview["inputs"]["document_refs"].array.enumerated()), id: \.offset) { _, reference in
                HStack {
                    Text(model.documents.first { $0.id == reference["document_id"].string }?.title ?? model.t("entity.unavailable"))
                    Spacer()
                    Text(model.t(reference["finalization_ref"] == .null ? "delivery.working" : "delivery.finalized")).foregroundStyle(WorkbenchPalette.muted)
                }
            }
            Divider()
        }
    }
    @ViewBuilder private var result: some View {
        if session.result != .null {
            Text(model.t("delivery.completed")).font(.system(size: 16, weight: .semibold))
            if let url = session.resultURL {
                Button(model.t("delivery.reveal")) { NSWorkspace.shared.activateFileViewerSelecting([url]) }
            } else if let title = session.result["document"]["title"].string { Text(title) }
            if session.result["bundle_id"].string != nil {
                Button(model.t("delivery.verify")) { Task { await session.verifyResult() } }.disabled(session.held)
                if session.verification["verified"].bool == true { Label(model.t("delivery.verified"), systemImage: "checkmark.circle") }
            }
        }
    }
    @ViewBuilder private func notices(_ value: JSONValue, title: String) -> some View {
        let messages = noticeMessages(value)
        if !messages.isEmpty {
            Text(model.t(title)).font(.system(size: 16, weight: .semibold))
            ForEach(Array(messages.enumerated()), id: \.offset) { _, message in Text(message).foregroundStyle(WorkbenchPalette.warningInk).textSelection(.enabled) }
        }
    }
    private func noticeMessages(_ value: JSONValue) -> [String] {
        if case .array(let values) = value { return values.flatMap(noticeMessages) }
        var messages: [String] = []
        if let code = value["code"].string, value["message"].string != nil || model.localizer.hasTranslation(for: "delivery.notice." + code) {
            let key = "delivery.notice." + code
            let translated = model.t(key)
            let title = value["title"].string ?? model.documents.first { $0.id == value["document_id"].string }?.title
            let message = model.localizer.hasTranslation(for: key) ? translated : (model.locale == "en" ? model.t("delivery.notice.other") : value["message"].string ?? "")
            messages.append(title.map { $0 + ": " + message } ?? message)
        } else if value["reason"].string != nil {
            messages.append(model.t(value["asset_ref"] == .null ? "delivery.excluded_private" : "delivery.asset_metadata_only"))
        }
        for field in ["warnings", "losses", "report"] { if value[field] != .null { messages += noticeMessages(value[field]) } }
        var seen: Set<String> = []
        return messages.filter { seen.insert($0).inserted }
    }
    private func normalizeFormat() {
        session.profile = isDrama ? "hetu-screenplay-zh/1" : "hetu-novel-zh/1"
        if !formats.contains(session.format) { session.format = formats.first ?? "txt" }
    }
    private func chooseFile() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.canChooseFiles = true; panel.allowsMultipleSelection = false
        panel.allowedContentTypes = ["txt", "md", "markdown", "fountain", "docx"].compactMap { UTType(filenameExtension: $0) }
        guard panel.runModal() == .OK, let url = panel.url else { return }
        session.chooseFile(url); normalizeFormat()
    }
}
