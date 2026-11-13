import Foundation
import Observation
import HetuCore

public struct DocumentItem: Identifiable, Sendable {
    public let value: JSONValue
    public var id: String { value["document_id"].string ?? "" }
    public var title: String { value["title"].string ?? "" }
    public var kind: String { value["kind"].string ?? "" }
}

@MainActor @Observable
public final class WorkspaceModel {
    public var locale: String { didSet { preferences.set(locale, forKey: "Hetu.locale") } }
    public var localizer: Localizer { Localizer(locale: locale) }
    public private(set) var workspace: Workspace?
    public private(set) var info: JSONValue = .null
    public private(set) var bible: JSONValue = .null
    public private(set) var novel: JSONValue = .null
    public private(set) var libraryEntries: [LibraryEntry] = []
    public private(set) var documents: [DocumentItem] = []
    public private(set) var drafts: [JSONValue] = []
    public private(set) var pendingStructureOperations: [PendingStructureOperation] = []
    public private(set) var loaded: JSONValue = .null
    public private(set) var text = ""
    public private(set) var savedText = ""
    public private(set) var baseRevisionID = ""
    public private(set) var busy = false
    public private(set) var isComposing = false
    public var editorSuspended = false
    public var message: String?
    public private(set) var conflict: JSONValue = .null
    public private(set) var recoveryCandidates: [RecoveryEntry] = []
    public private(set) var pendingSave: PendingSave?
    public private(set) var statistics = TextStatistics.count("")
    public private(set) var replacementVersion = 0
    public private(set) var adoptionUndoBaseline: String?
    public let windowID = UUID()
    @ObservationIgnored private let recovery: RecoveryStore
    @ObservationIgnored private let preferences: UserDefaults
    @ObservationIgnored private let authorizationURL: URL?
    @ObservationIgnored private let library: LibraryStore
    @ObservationIgnored private var recoveryTask: Task<Void, Never>?
    @ObservationIgnored private var statisticsTask: Task<Void, Never>?
    @ObservationIgnored private var generation = UUID()

    public init(locale: String? = nil, recovery: RecoveryStore = RecoveryStore(), preferences: UserDefaults = .standard, authorizationURL: URL? = nil, library: LibraryStore = LibraryStore()) {
        self.preferences = preferences
        self.locale = locale ?? preferences.string(forKey: "Hetu.locale") ?? "zh-CN"
        self.recovery = recovery
        self.authorizationURL = authorizationURL
        self.library = library
    }
    public var title: String { novel["novel"]["metadata"]["title"].string ?? info["workspace"]["title"].string ?? "Hetu" }
    public var novelMetadata: JSONValue { novel["novel"]["metadata"] }
    public var volumes: [JSONValue] { novel["novel"]["volumes"].array }
    public var chapters: [JSONValue] { novel["novel"]["chapters"].array }
    public var orderedChapters: [DocumentItem] { chapters.compactMap { c in documents.first { $0.id == c["document_id"].string } } }
    public var workspaceID: String { info["workspace"]["workspace_id"].string ?? "" }
    public var documentID: String { loaded["document"]["document_id"].string ?? "" }
    public var documentTitle: String { loaded["document"]["title"].string ?? "" }
    public var dirty: Bool { text != savedText }
    public var needsProtection: Bool { dirty || pendingSave != nil }
    public var locked: Bool { bible["blueprint"]["lock"]["locked"].bool ?? false }
    public func t(_ key: String, _ parameters: [String: String] = [:]) -> String { localizer.text(key, parameters) }
    public func report(_ error: any Error) { message = localizer.error(error) }

    // 调用方先完成未保存内容决策；只有成功打开新上下文后才替换当前项目。
    @discardableResult public func open(_ url: URL, title: String? = nil, expectedWorkspaceID: String? = nil) async -> Bool {
        guard !busy else { return false }
        busy = true; defer { busy = false }
        do {
            let next = try await Workspace.open(at: url, mode: .author, title: title, locale: locale, operationKey: title == nil ? nil : UUID().uuidString, authorizationURL: authorizationURL)
            let info = try await next.data("hetu.workspaces.get")
            if let expectedWorkspaceID, info["workspace"]["workspace_id"].string != expectedWorkspaceID { throw LibraryStore.LibraryError.wrongWorkspace }
            let novel = try await next.data("hetu.novels.get")
            let bible = try await next.data("hetu.blueprints.get")
            let documents = try await next.data("hetu.documents.list")
            let drafts = try await next.data("hetu.drafts.list")
            let pendingOperations = try await recovery.structureOperations(workspaceID: info["workspace"]["workspace_id"].string ?? "")
            let metadata = novel["initialized"].bool == true ? novel["novel"]["metadata"] : .object(["title": info["workspace"]["title"]])
            let entries = try await library.register(url: url, workspaceID: info["workspace"]["workspace_id"].string ?? "", metadata: metadata, chapterCount: novel["novel"]["chapters"].array.count)
            recoveryTask?.cancel(); statisticsTask?.cancel()
            self.workspace = next; self.info = info; self.bible = bible; self.novel = novel; self.libraryEntries = entries
            self.documents = documents["documents"].array.map(DocumentItem.init)
            self.drafts = drafts["drafts"].array
            pendingStructureOperations = pendingOperations
            generation = UUID(); resetDocument()
            remember(url)
            return true
        } catch { report(error); return false }
    }
    public func refresh() async {
        guard !busy, let workspace else { return }
        busy = true; defer { busy = false }
        do {
            bible = try await workspace.data("hetu.blueprints.get")
            novel = try await workspace.data("hetu.novels.get")
            documents = try await workspace.data("hetu.documents.list")["documents"].array.map(DocumentItem.init)
            drafts = try await workspace.data("hetu.drafts.list")["drafts"].array
            try await updateLibraryProjection()
        } catch { report(error) }
    }
    @discardableResult public func selectDocument(_ id: String, adoptionUndoBaseline: String? = nil) async -> Bool {
        guard !busy, let workspace else { return false }
        busy = true; defer { busy = false }
        do {
            let result = try await workspace.data("hetu.documents.get", input: ["document_id": .string(id)])
            let entries = try await recovery.list(workspaceID: workspaceID, documentID: id)
            recoveryTask?.cancel(); resetDocument()
            loaded = result; savedText = result["content"].string ?? ""; text = savedText
            self.adoptionUndoBaseline = adoptionUndoBaseline
            baseRevisionID = result["revision"]["revision_id"].string ?? ""
            recoveryCandidates = entries.filter { $0.content != savedText || $0.pendingSave != nil }
            replacementVersion += 1; scheduleStatistics()
            return true
        } catch { report(error); return false }
    }
    public func clearDocument() { recoveryTask?.cancel(); resetDocument() }
    private func resetDocument() {
        adoptionUndoBaseline = nil
        loaded = .null; text = ""; savedText = ""; baseRevisionID = ""; conflict = .null
        pendingSave = nil; recoveryCandidates = []; statistics = TextStatistics.count(""); replacementVersion += 1
    }
    public func edit(_ value: String, documentID expectedID: String? = nil) {
        if let expectedID, expectedID != documentID { return }
        guard !documentID.isEmpty else { return }
        text = value; scheduleStatistics()
        recoveryTask?.cancel()
        guard !isComposing else { return }
        let token = generation
        recoveryTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(400)) } catch { return }
            guard let self, token == self.generation else { return }
            _ = await self.persistRecovery()
        }
    }
    public func setComposition(_ value: Bool) {
        guard value != isComposing else { return }
        isComposing = value
        if !value { edit(text) }
    }
    private func scheduleStatistics() {
        statisticsTask?.cancel()
        let content = text
        statisticsTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            let result = await Task.detached(priority: .utility) { TextStatistics.count(content) }.value
            guard !Task.isCancelled, let self, self.text == content else { return }
            self.statistics = result
        }
    }
    private func entry() -> RecoveryEntry {
        RecoveryEntry(workspaceID: workspaceID, documentID: documentID, windowID: windowID, baseRevisionID: baseRevisionID, title: documentTitle, content: text, pendingSave: pendingSave)
    }
    @discardableResult public func persistRecovery() async -> Bool {
        guard !documentID.isEmpty else { return true }
        let snapshot = entry()
        do {
            if needsProtection { try await recovery.write(snapshot) }
            else { try await recovery.remove(snapshot, ifContentMatches: snapshot.content) }
            if snapshot.documentID == documentID, snapshot.workspaceID == workspaceID,
               snapshot.content != text || snapshot.pendingSave != pendingSave || snapshot.baseRevisionID != baseRevisionID {
                return await persistRecovery()
            }
            return true
        } catch { message = t("error.recovery"); return false }
    }
    @discardableResult public func restore(_ candidate: RecoveryEntry) async -> Bool {
        guard !busy, candidate.workspaceID == workspaceID, candidate.documentID == documentID else { return false }
        let snapshot = RecoveryEntry(workspaceID: workspaceID, documentID: documentID, windowID: windowID, baseRevisionID: candidate.baseRevisionID, title: documentTitle, content: candidate.content, pendingSave: candidate.pendingSave)
        do { try await recovery.write(snapshot) } catch { message = t("error.recovery"); return false }
        text = candidate.content; pendingSave = candidate.pendingSave
        // 恢复基线不能偷偷升级；先让原键结果和 CAS 决定下一步。
        baseRevisionID = candidate.baseRevisionID
        recoveryCandidates = []; replacementVersion += 1; scheduleStatistics()
        return true
    }
    public func hideRecoveryCandidates() { recoveryCandidates = [] }

    @discardableResult public func save() async -> Bool {
        guard !busy, !isComposing, let workspace, !documentID.isEmpty else { return false }
        guard needsProtection else { return true }
        busy = true; defer { busy = false }
        recoveryTask?.cancel()
        let pending = pendingSave ?? PendingSave(operationKey: UUID().uuidString, baseRevisionID: baseRevisionID, content: text)
        pendingSave = pending
        guard await persistRecovery() else { return false }
        do {
            let result = try await workspace.data("hetu.documents.save", input: [
                "document_id": .string(documentID), "base_revision_id": .string(pending.baseRevisionID),
                "source_format": loaded["document"]["source_format"], "content": .string(pending.content),
                "operation_key": .string(pending.operationKey)
            ])
            loaded = result; savedText = pending.content; baseRevisionID = result["revision"]["revision_id"].string ?? ""
            pendingSave = nil; conflict = .null
            // 保存期间的新输入仍在编辑缓冲，不被旧保存回调覆盖。
            return await persistRecovery()
        } catch {
            if case CoreError.business(let result) = error,
               result["status"].string == "blocked" {
                pendingSave = nil
                if result["error"]["code"].string == "revision_conflict" {
                    conflict = (try? await workspace.data("hetu.documents.get", input: ["document_id": .string(documentID)])) ?? .null
                }
            }
            _ = await persistRecovery(); report(error); return false
        }
    }
    public func acceptConflictBaseline() async {
        guard !busy, conflict != .null else { return }
        loaded = conflict; savedText = conflict["content"].string ?? ""
        baseRevisionID = conflict["revision"]["revision_id"].string ?? ""; conflict = .null
        _ = await persistRecovery()
    }
    @discardableResult public func createDocument(title: String, kind: String) async -> String? {
        let result = await workspaceAction("hetu.documents.create", input: [
                "kind": .string(kind), "title": .string(title), "source_format": .string(kind == "drama_script" ? "fountain" : "markdown"),
                "content": .string(""), "operation_key": .string(UUID().uuidString)
            ], onFailure: { self.message = $0; _ = $1 })
        return result?["document"]["document_id"].string
    }
    @discardableResult public func saveCharacter(id: String?, name: String, aliases: [String], description: String, traits: [String]) async -> Bool {
        let old = bible["blueprint"]["characters"].array.first { $0["character_id"].string == id }
        let character: JSONValue = .object([
            "character_id": .string(id ?? "character_" + UUID().uuidString.lowercased()), "name": .string(name),
            "aliases": .array(aliases.map(JSONValue.string)), "description": .string(description),
            "traits": .array(traits.map(JSONValue.string)), "facts": old?["facts"] ?? .array([]), "archived": old?["archived"] ?? .bool(false)
        ])
        return await saveBibleChanges([.object(["type": .string("upsert_character"), "entity": character])])
    }
    @discardableResult public func saveBibleChanges(_ changes: [JSONValue], onFailure: ((String) -> Void)? = nil) async -> Bool {
        guard !busy, let workspace else { return false }
        busy = true; defer { busy = false }
        do {
            bible = try await workspace.data("hetu.blueprints.save", input: ["expected": expectedBible, "typed_changes": .array(changes), "operation_key": .string(UUID().uuidString)])
            return true
        } catch { reportBible(error, onFailure: onFailure); return false }
    }
    public func previewBibleChanges(_ changes: [JSONValue]) async -> JSONValue? {
        guard !busy, let workspace else { return nil }
        busy = true; defer { busy = false }
        do { return try await workspace.data("hetu.blueprints.preview_change", input: ["expected": expectedBible, "typed_changes": .array(changes)]) }
        catch { reportBible(error); return nil }
    }
    public func readBibleRevision(_ revision: Int64, onFailure: ((String) -> Void)? = nil) async -> JSONValue? {
        guard !busy, let workspace else { return nil }
        busy = true; defer { busy = false }
        do { return try await workspace.data("hetu.blueprints.get", input: ["revision": .integer(revision)]) }
        catch { reportBible(error, onFailure: onFailure); return nil }
    }
    private func reportBible(_ error: any Error, onFailure: ((String) -> Void)? = nil) {
        let text: String
        if case CoreError.business(let result) = error, result["error"]["code"].string == "revision_conflict" { text = t("error.bible_conflict") }
        else { text = localizer.error(error) }
        if let onFailure { onFailure(text) } else { message = text }
    }
    private var expectedBible: JSONValue { .object(["revision": bible["revision"], "sha256": bible["sha256"]]) }
    @discardableResult public func setLocked(_ value: Bool, reason: String, onFailure: ((String) -> Void)? = nil) async -> Bool {
        guard !busy, let workspace else { return false }
        busy = true; defer { busy = false }
        do {
            bible = try await workspace.data(value ? "hetu.blueprints.lock" : "hetu.blueprints.unlock", input: ["expected": expectedBible, "reason": .string(reason), "operation_key": .string(UUID().uuidString)])
            return true
        } catch { reportBible(error, onFailure: onFailure); return false }
    }
    public func readDraft(_ id: String) async -> JSONValue? {
        guard !busy, let workspace else { return nil }
        busy = true; defer { busy = false }
        do { return try await workspace.data("hetu.drafts.get", input: ["draft_id": .string(id)]) }
        catch { report(error); return nil }
    }
    public func listPlots(documentID: String, cursor: String? = nil, onFailure: (String) -> Void) async -> JSONValue? {
        var input: [String: JSONValue] = ["document_id": .string(documentID), "limit": .integer(50)]
        if let cursor { input["cursor"] = .string(cursor) }
        return await plotData("hetu.plot.list", input: input, onFailure: onFailure)
    }
    public func readPlot(_ revision: String, onFailure: (String) -> Void) async -> JSONValue? {
        await plotData("hetu.plot.get", input: ["plot_revision_id": .string(revision)], onFailure: onFailure)
    }
    public func extractPlot(documentID: String, onFailure: (String) -> Void) async -> JSONValue? {
        guard !busy, let workspace else { return nil }
        busy = true; defer { busy = false }
        do {
            let document = try await workspace.data("hetu.documents.get", input: ["document_id": .string(documentID)])
            let bp = try await workspace.data("hetu.blueprints.get")
            bible = bp
            return try await workspace.data("hetu.plot.extract", input: [
                "document_revisions": .array([.object(["document_id": .string(documentID), "revision_id": document["revision"]["revision_id"], "sha256": document["revision"]["sha256"]])]),
                "blueprint_revision": bp["revision"], "options": .object([:]), "save_result": .bool(true), "operation_key": .string(UUID().uuidString)
            ], allowPartial: true)
        } catch { onFailure(localizer.error(error)); return nil }
    }
    public func correctPlot(_ revision: String, corrections: [JSONValue], operationKey: String, onFailure: (String) -> Void) async -> JSONValue? {
        await plotData("hetu.plot.correct", input: ["plot_revision_id": .string(revision), "corrections": .array(corrections), "operation_key": .string(operationKey)], onFailure: onFailure)
    }
    public func runValidation(plotRevision: String, operationKey: String, onFailure: (String) -> Void) async -> JSONValue? {
        await plotData("hetu.validation.run", input: ["plot_revision_id": .string(plotRevision), "rule_set_version": .string("1"), "options": .object([:]), "save_report": .bool(true), "operation_key": .string(operationKey)], onFailure: onFailure)
    }
    public func listReports(plotRevision: String, cursor: String? = nil, onFailure: (String) -> Void) async -> JSONValue? {
        var input: [String: JSONValue] = ["plot_revision_id": .string(plotRevision), "limit": .integer(50)]
        if let cursor { input["cursor"] = .string(cursor) }
        return await plotData("hetu.reports.list", input: input, onFailure: onFailure)
    }
    public func readReport(_ id: String, onFailure: (String) -> Void) async -> JSONValue? {
        await plotData("hetu.reports.get", input: ["report_id": .string(id)], onFailure: onFailure)
    }
    public func recordDisposition(report: JSONValue, findingID: String, expectedRevision: Int64, disposition: String, reason: String, operationKey: String, onFailure: (String) -> Void) async -> Bool {
        await plotData("hetu.findings.disposition", input: ["report_id": report["report_id"], "finding_id": .string(findingID), "expected_inputs": report["input_snapshot"], "expected_disposition_revision": .integer(expectedRevision), "disposition": .string(disposition), "reason": .string(reason), "operation_key": .string(operationKey)], onFailure: onFailure) != nil
    }
    public func readPlotSource(_ source: JSONValue, onFailure: (String) -> Void) async -> JSONValue? {
        guard !busy, let workspace else { return nil }
        busy = true; defer { busy = false }
        do { return try await workspace.data("hetu.documents.get", input: ["document_id": source["document_id"], "revision_id": source["revision_id"]]) }
        catch { onFailure(localizer.error(error)); return nil }
    }
    public func dramaAction(_ action: String, input: [String: JSONValue], onFailure: (String, Bool) -> Void) async -> JSONValue? {
        await workspaceAction(action, input: input, onFailure: onFailure)
    }
    public func workspaceAction(_ action: String, input: [String: JSONValue], onFailure: (String, Bool) -> Void) async -> JSONValue? {
        guard !busy, let workspace else { return nil }
        busy = true; defer { busy = false }
        let operation = input["operation_key"] == nil ? nil : PendingStructureOperation(workspaceID: workspaceID, action: action, input: input)
        if let operation, pendingStructureOperations.contains(where: { $0 != operation }) { onFailure(t("review.pending"), true); return nil }
        do {
            if let operation { try await recovery.writeOperation(operation); pendingStructureOperations = try await recovery.structureOperations(workspaceID: workspaceID) }
            let value = try await workspace.data(action, input: input, allowPartial: true)
            if action == "hetu.drama.create_script" || action.hasPrefix("hetu.documents.") {
                documents = try await workspace.data("hetu.documents.list")["documents"].array.map(DocumentItem.init)
            }
            if ["hetu.documents.finalize", "hetu.documents.withdraw_finalization"].contains(action), value["document"]["document_id"].string == documentID {
                var fields = loaded.object; fields["document"] = value["document"]; loaded = .object(fields)
            }
            if action.hasPrefix("hetu.reviews.") || action.hasPrefix("hetu.drafts.") {
                documents = try await workspace.data("hetu.documents.list")["documents"].array.map(DocumentItem.init)
                drafts = try await workspace.data("hetu.drafts.list")["drafts"].array
            }
            if action.hasPrefix("hetu.novels.") || action == "hetu.documents.create" || action == "hetu.drafts.adopt" {
                novel = try await workspace.data("hetu.novels.get")
                try await updateLibraryProjection()
            }
            if let operation { try await recovery.removeOperation(operation); pendingStructureOperations = try await recovery.structureOperations(workspaceID: workspaceID) }
            return value
        }
        catch {
            let terminal: Bool
            if case CoreError.business(let result) = error { terminal = result["status"].string == "blocked" }
            else { terminal = false }
            if terminal, let operation {
                do { try await recovery.removeOperation(operation); pendingStructureOperations = try await recovery.structureOperations(workspaceID: workspaceID) }
                catch { onFailure(t("error.recovery"), false); return nil }
            }
            onFailure(localizer.error(error), terminal); return nil
        }
    }
    private func plotData(_ action: String, input: [String: JSONValue], onFailure: (String) -> Void) async -> JSONValue? {
        guard !busy, let workspace else { return nil }
        busy = true; defer { busy = false }
        do { return try await workspace.data(action, input: input, allowPartial: true) }
        catch { onFailure(localizer.error(error)); return nil }
    }
    // 只记录作者通过系统选择器打开的路径；不扫描用户文件系统。
    public func loadLibrary() async {
        do { libraryEntries = try await library.entries() } catch { report(error) }
    }
    @discardableResult public func openLibraryEntry(_ entry: LibraryEntry) async -> Bool {
        do { return await open(try await library.resolve(entry), expectedWorkspaceID: entry.workspaceID) }
        catch { report(error); return false }
    }
    // 调用方先完成关闭/切换作品共用的未保存内容保护。
    public func returnToLibrary() async {
        guard !busy else { return }
        recoveryTask?.cancel(); statisticsTask?.cancel(); generation = UUID(); resetDocument()
        workspace = nil; info = .null; bible = .null; novel = .null
        documents = []; drafts = []; pendingStructureOperations = []
        await loadLibrary()
    }
    private func updateLibraryProjection() async throws {
        guard let workspace else { return }
        let metadata = novel["initialized"].bool == true ? novelMetadata : .object(["title": info["workspace"]["title"]])
        libraryEntries = try await library.register(url: workspace.url, workspaceID: workspaceID, metadata: metadata, chapterCount: chapters.count, opened: false)
    }
    public func saveNovelMetadata(_ metadata: JSONValue, expected: JSONValue? = nil) async -> Bool {
        let initialized = novel["initialized"].bool == true
        var input: [String: JSONValue] = ["metadata": metadata, "operation_key": .string(UUID().uuidString)]
        if initialized { input["expected"] = expected ?? .object(["revision": novel["revision"], "sha256": novel["sha256"]]) }
        return await workspaceAction(initialized ? "hetu.novels.update" : "hetu.novels.initialize", input: input, onFailure: { self.message = $0; _ = $1 }) != nil
    }
    public func saveNovelStructure(volumes: [JSONValue], chapters: [JSONValue], expected: JSONValue? = nil) async -> Bool {
        await workspaceAction("hetu.novels.save_structure", input: ["expected": expected ?? .object(["revision": novel["revision"], "sha256": novel["sha256"]]), "volumes": .array(volumes), "chapters": .array(chapters), "operation_key": .string(UUID().uuidString)], onFailure: { self.message = $0; _ = $1 }) != nil
    }
    public var recentURLs: [URL] { (preferences.stringArray(forKey: "Hetu.recent") ?? []).map { URL(fileURLWithPath: $0) } }
    private func remember(_ url: URL) {
        let paths = ([url.path] + recentURLs.map(\.path)).reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
        preferences.set(Array(paths.prefix(10)), forKey: "Hetu.recent")
    }
}
