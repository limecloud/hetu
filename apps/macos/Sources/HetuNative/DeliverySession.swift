import Foundation
import Observation
import HetuCore

public enum DeliveryMode: String, CaseIterable, Sendable { case importDocument, exportDocuments, bundle }
public enum DeliveryAttachmentKind: String, CaseIterable, Sendable {
    case skeletons, reports, comparisons, cues, assets
    public var action: String {
        switch self {
        case .skeletons: "hetu.drama.list_skeletons"
        case .reports: "hetu.reports.list"
        case .comparisons: "hetu.drama.list_comparisons"
        case .cues: "hetu.cues.list"
        case .assets: "hetu.assets.list"
        }
    }
    public var idKey: String {
        switch self { case .skeletons: "skeleton_id"; case .reports: "report_id"; case .comparisons: "comparison_id"; case .cues: "cue_id"; case .assets: "asset_id" }
    }
    public var referenceKey: String {
        switch self { case .skeletons: "skeleton_refs"; case .reports: "report_refs"; case .comparisons: "comparison_refs"; case .cues: "cue_refs"; case .assets: "asset_refs" }
    }
    public func identity(_ record: JSONValue) -> String {
        (record[idKey].string ?? "") + ":" + String(record["revision"].integer ?? 0)
    }
}

/// 导入、格式导出与交付包复用固定预览；作者执行与未知结果恢复沿同一操作键。
@MainActor @Observable public final class DeliverySession {
    public var mode: DeliveryMode = .importDocument { didSet { if mode != oldValue { invalidate() } } }
    public var format = "txt" { didSet {
        if format != oldValue {
            invalidate()
            if isSingleDocumentExport, selectedDocuments.count > 1 {
                selectedDocuments = Set(selectedInDocumentOrder.prefix(1).map(\.id))
            }
        }
    } }
    public var profile = "hetu-novel-zh/1" { didSet { if profile != oldValue { invalidate() } } }
    public var bundleProfile = "production_delivery" { didSet { if bundleProfile != oldValue { invalidate() } } }
    public var useFinalizedRevisions = false { didSet { if useFinalizedRevisions != oldValue { invalidate() } } }
    public var readingFormats: Set<String> = ["docx", "pdf"] { didSet { if readingFormats != oldValue { invalidate() } } }
    public var selectedDocuments: Set<String> = [] { didSet { if selectedDocuments != oldValue { invalidate() } } }
    public var selectedAttachments: [DeliveryAttachmentKind: Set<String>] = [:] { didSet { if selectedAttachments != oldValue { invalidate() } } }
    public var comparisonSkeletonID: String? { didSet {
        if comparisonSkeletonID != oldValue {
            attachments[.comparisons] = nil; cursors[.comparisons] = nil; selectedAttachments[.comparisons] = []; invalidate()
        }
    } }
    public var importKind = "novel_chapter" { didSet { if importKind != oldValue { invalidate() } } }
    public var importTitle = "" { didSet { if importTitle != oldValue { invalidate() } } }
    public var importLanguage: String { didSet { if importLanguage != oldValue { invalidate() } } }
    public var importVolumeID: String? { didSet { if importVolumeID != oldValue { invalidate() } } }
    public private(set) var importFile: URL?
    public private(set) var preview: JSONValue = .null
    public private(set) var result: JSONValue = .null
    public private(set) var verification: JSONValue = .null
    public private(set) var attachments: [DeliveryAttachmentKind: [JSONValue]] = [:]
    public private(set) var cursors: [DeliveryAttachmentKind: String] = [:]
    public private(set) var pending: PendingStructureOperation?
    public private(set) var busy = false
    public var error: String?
    private let model: WorkspaceModel
    private let scopeID: String
    private var selectionGeneration = UUID()

    public init(model: WorkspaceModel) {
        self.model = model; scopeID = model.workspaceID; importLanguage = model.locale
        pending = model.pendingStructureOperations.first { Self.isDeliveryAction($0.action) }
        if let pending { restorePresentation(pending) }
    }
    private func restorePresentation(_ operation: PendingStructureOperation) {
        let fixed = operation.input["preview"] ?? .null
        let request = fixed["request"]
        switch operation.action {
        case "hetu.documents.import":
            mode = .importDocument
            importKind = operation.input["kind"]?.string ?? importKind
            importTitle = operation.input["title"]?.string ?? ""
            importLanguage = operation.input["language_tag"]?.string ?? importLanguage
            importVolumeID = operation.input["volume_id"]?.string
            if let path = request["file_path"].string { importFile = URL(fileURLWithPath: path) }
        case "hetu.documents.export":
            mode = .exportDocuments
            selectedDocuments = Set(request["revision_refs"].array.compactMap { $0["document_id"].string })
        default:
            mode = .bundle
            bundleProfile = request["profile"].string ?? bundleProfile
            selectedDocuments = Set(request["selection"]["document_refs"].array.compactMap { $0["document_id"].string })
            if request["reading_formats"] != .null { readingFormats = Set(request["reading_formats"].array.compactMap(\.string)) }
        }
        if mode != .bundle {
            format = request["format"].string ?? format
            profile = request["profile"].string ?? profile
        }
        preview = fixed
    }
    public static func isDeliveryAction(_ action: String) -> Bool {
        ["hetu.documents.import", "hetu.documents.export", "hetu.bundles.export"].contains(action)
    }
    public var held: Bool { model.workspace == nil || model.workspaceID != scopeID || busy || model.busy || pending != nil || !model.pendingStructureOperations.isEmpty }
    public var isSingleDocumentExport: Bool { mode == .exportDocuments && format == "fountain" }
    public var canPrepare: Bool {
        !held && (mode == .importDocument ? importFile != nil && !importTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty : !selectedDocuments.isEmpty && selectedDocuments.count <= (isSingleDocumentExport ? 1 : 128))
    }
    public var canCommit: Bool { !held && preview != .null && (mode == .importDocument || preview["eligible"].bool == true) }
    public var selectedInDocumentOrder: [DocumentItem] {
        let chapters = model.orderedChapters
        let chapterIDs = Set(chapters.map(\.id))
        return (chapters + model.documents.filter { !chapterIDs.contains($0.id) }).filter {
            selectedDocuments.contains($0.id) && ["novel_chapter", "drama_script"].contains($0.kind)
        }
    }
    public func invalidate() {
        preview = .null; result = .null; verification = .null; selectionGeneration = UUID()
    }
    public func chooseFile(_ url: URL) {
        guard !held else { return }
        importFile = url; invalidate()
        let ext = url.pathExtension.lowercased()
        format = ["md": "markdown", "markdown": "markdown", "txt": "txt", "fountain": "fountain", "docx": "docx"][ext] ?? "txt"
        if importTitle.isEmpty { importTitle = url.deletingPathExtension().lastPathComponent }
        if format == "fountain" { importKind = "drama_script"; profile = "hetu-screenplay-zh/1" }
        else if format == "txt" || format == "markdown" { importKind = "novel_chapter"; profile = "hetu-novel-zh/1" }
    }
    public func loadAttachments(_ kind: DeliveryAttachmentKind, append: Bool = false) async {
        guard !held else { return }
        guard kind != .comparisons || comparisonSkeletonID != nil else { error = model.t("delivery.choose_skeleton"); return }
        busy = true; defer { busy = false }; error = nil
        let skeletonID = comparisonSkeletonID
        do {
            var input: [String: JSONValue] = ["limit": .integer(50)]
            if kind == .comparisons { input["skeleton_id"] = skeletonID.map(JSONValue.string) }
            if append, let cursor = cursors[kind] { input["cursor"] = .string(cursor) }
            let page = try await read(kind.action, input: input)
            guard kind != .comparisons || comparisonSkeletonID == skeletonID else { return }
            if !append { selectedAttachments[kind] = [] }
            attachments[kind] = (append ? attachments[kind] ?? [] : []) + page[kind.rawValue].array
            cursors[kind] = page["next_cursor"].string
            invalidate()
        } catch { show(error) }
    }
    public func prepare() async {
        guard canPrepare else { return }
        busy = true; defer { busy = false }; error = nil; preview = .null; result = .null; verification = .null
        let generation = selectionGeneration
        do {
            let output: JSONValue
            switch mode {
            case .importDocument:
                guard let importFile else { return }
                output = try await read("hetu.documents.preview_import", input: ["file_path": .string(importFile.path), "format": .string(format), "profile": .string(profile)])
            case .exportDocuments, .bundle:
                let refs = try await documentReferences()
                if mode == .exportDocuments {
                    output = try await read("hetu.documents.preview_export", input: ["revision_refs": .array(refs), "format": .string(format), "profile": .string(profile)])
                } else {
                    let bible = try await read("hetu.blueprints.get")
                    var selection: [String: JSONValue] = ["blueprint_ref": .object(["revision": bible["blueprint"]["revision"], "sha256": bible["sha256"]]), "document_refs": .array(refs)]
                    for kind in DeliveryAttachmentKind.allCases {
                        var selected: [JSONValue] = []
                        for item in attachments[kind] ?? [] where selectedAttachments[kind, default: []].contains(kind.identity(item)) {
                            if kind == .reports {
                                selected.append(try await read("hetu.reports.get", input: ["report_id": item["report_id"]])["reference"])
                            } else if kind == .comparisons {
                                selected.append(.object(["comparison_id": item["comparison_id"], "sha256": item["sha256"]]))
                            } else {
                                selected.append(.object([kind.idKey: item[kind.idKey], "revision": item["revision"], "sha256": item["sha256"]]))
                            }
                        }
                        selection[kind.referenceKey] = .array(selected)
                    }
                    output = try await read("hetu.bundles.preview", input: ["selection": .object(selection), "profile": .string(bundleProfile), "reading_formats": .array(readingFormats.sorted().map(JSONValue.string))])
                }
            }
            guard selectionGeneration == generation else { return }
            preview = output["preview"]
        } catch { show(error) }
    }
    private func documentReferences() async throws -> [JSONValue] {
        guard selectedInDocumentOrder.count == selectedDocuments.count else { throw CreativeTaskError.invalidResult }
        var refs: [JSONValue] = []
        for document in selectedInDocumentOrder {
            let finalized = mode == .bundle && bundleProfile == "production_delivery" || mode == .exportDocuments && useFinalizedRevisions
            guard finalized || !(model.documentID == document.id && model.needsProtection) else { throw DeliveryError.unsaved }
            let head = try await read("hetu.documents.get", input: ["document_id": .string(document.id)])
            let data: JSONValue
            if finalized, let approved = head["document"]["approved_revision_id"].string {
                data = try await read("hetu.documents.get", input: ["document_id": .string(document.id), "revision_id": .string(approved)])
            } else {
                if mode == .exportDocuments, finalized { throw DeliveryError.noFinalization }
                data = head
            }
            guard data["document"]["draft_source_id"] == .null else { throw CreativeTaskError.invalidResult }
            refs.append(.object(["document_id": .string(document.id), "revision_id": data["revision"]["revision_id"], "sha256": data["revision"]["sha256"], "finalization_ref": head["document"]["finalization_ref"]]))
        }
        return refs
    }
    public func commit(acknowledgement: String) async -> Bool {
        guard canCommit, !acknowledgement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        var input: [String: JSONValue] = ["preview": preview, "acknowledgement": .string(acknowledgement), "operation_key": .string(UUID().uuidString)]
        let action: String
        switch mode {
        case .importDocument:
            action = "hetu.documents.import"
            input["kind"] = .string(importKind); input["title"] = .string(importTitle.trimmingCharacters(in: .whitespacesAndNewlines)); input["language_tag"] = .string(importLanguage)
            if importKind == "novel_chapter" { input["volume_id"] = importVolumeID.map(JSONValue.string) ?? .null }
        case .exportDocuments: action = "hetu.documents.export"
        case .bundle: action = "hetu.bundles.export"
        }
        return await perform(PendingStructureOperation(workspaceID: scopeID, action: action, input: input))
    }
    public func retry() async { if let pending { _ = await perform(pending) } }
    private func perform(_ operation: PendingStructureOperation) async -> Bool {
        guard !busy, model.workspaceID == scopeID, pending == nil || pending == operation else { return false }
        pending = operation; busy = true; error = nil; defer { busy = false }
        guard let value = await model.workspaceAction(operation.action, input: operation.input, onFailure: { message, terminal in
            self.error = message
            if terminal { self.pending = nil; self.invalidate() }
        }) else { return false }
        pending = nil; result = value; preview = .null; verification = .null
        return true
    }
    public func verifyResult() async {
        guard !held, let bundleID = result["bundle_id"].string else { return }
        busy = true; defer { busy = false }; error = nil; verification = .null
        do { verification = try await read("hetu.bundles.verify", input: ["bundle_id": .string(bundleID)]) }
        catch { show(error) }
    }
    public var resultURL: URL? {
        guard let root = model.workspace?.url, model.workspaceID == scopeID, let path = result["path"].string,
              path.hasPrefix("exports/"), !path.split(separator: "/").contains(where: { $0 == ".." || $0 == "." }) else { return nil }
        return root.appendingPathComponent(path)
    }
    private func read(_ action: String, input: [String: JSONValue] = [:]) async throws -> JSONValue {
        guard model.workspaceID == scopeID, let workspace = model.workspace else { throw CreativeTaskError.invalidResult }
        let data = try await workspace.data(action, input: input, allowPartial: true)
        guard model.workspaceID == scopeID else { throw CreativeTaskError.invalidResult }
        return data
    }
    private func show(_ error: any Error) {
        if let error = error as? DeliveryError {
            self.error = model.t(error == .unsaved ? "delivery.unsaved" : "delivery.no_finalization")
        } else { self.error = model.localizer.error(error) }
    }
    private enum DeliveryError: Error, Equatable { case unsaved, noFinalization }
}
