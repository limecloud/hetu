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
    public private(set) var cover: JSONValue = .null
    public private(set) var libraryEntries: [LibraryEntry] = []
    public private(set) var currentWork: JSONValue = .null
    public private(set) var availableWorks: [JSONValue] = []
    public private(set) var documents: [DocumentItem] = []
    public private(set) var drafts: [JSONValue] = []
    public private(set) var pendingStructureOperations: [PendingStructureOperation] = []
    public private(set) var activeDeliveryOperations: Set<String> = []
    public private(set) var loaded: JSONValue = .null
    public private(set) var text = ""
    public private(set) var savedText = ""
    public private(set) var baseRevisionID = ""
    public private(set) var busy = false
    public private(set) var writeLocked = false
    public private(set) var isComposing = false
    public private(set) var saving = false
    public var editorSuspended = false
    public var message: String?
    public private(set) var conflict: JSONValue = .null
    public private(set) var recoveryCandidates: [RecoveryEntry] = []
    public private(set) var pendingSave: PendingSave?
    public private(set) var statistics = TextStatistics.count("")
    public private(set) var replacementVersion = 0
    public private(set) var adoptionUndoBaseline: String?
    public private(set) var requestedSelection: SourceSelection?
    public var showSearch = false
    public let windowID = UUID()
    public let agentIntegration: AgentIntegrationSettings
    public let artworkLibrary = ArtworkLibrarySession()
    @ObservationIgnored private let recovery: RecoveryStore
    @ObservationIgnored private let preferences: UserDefaults
    @ObservationIgnored private let authorizationURL: URL?
    @ObservationIgnored private let library: LibraryStore
    @ObservationIgnored private var recoveryTask: Task<Void, Never>?
    @ObservationIgnored private var statisticsTask: Task<Void, Never>?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var loadingLibrary = false

    public init(locale: String? = nil, recovery: RecoveryStore = RecoveryStore(), preferences: UserDefaults = .standard, authorizationURL: URL? = nil, library: LibraryStore = LibraryStore()) {
        self.preferences = preferences
        self.agentIntegration = AgentIntegrationSettings(preferences: preferences)
        self.locale = locale ?? preferences.string(forKey: "Hetu.locale") ?? "zh-CN"
        self.recovery = recovery
        self.authorizationURL = authorizationURL
        self.library = library
    }
    public var title: String { currentWork["summary"]["title"].string ?? novel["novel"]["metadata"]["title"].string ?? info["workspace"]["title"].string ?? t("brand.name") }
    public var novelMetadata: JSONValue { novel["novel"]["metadata"] }
    public var volumes: [JSONValue] { novel["novel"]["volumes"].array }
    public var chapters: [JSONValue] { novel["novel"]["chapters"].array }
    public var orderedChapters: [DocumentItem] { chapters.compactMap { c in documents.first { $0.id == c["document_id"].string } } }
    public var workspaceID: String { info["workspace"]["workspace_id"].string ?? "" }
    public var workReference: WorkReference? { try? WorkReference(currentWork["summary"]["work_ref"]) }
    public var currentWorkID: String { workReference?.id ?? workspaceID }
    public var workType: String { workReference?.kind ?? info["workspace"]["work_type"].string ?? "novel" }
    public var documentID: String { loaded["document"]["document_id"].string ?? "" }
    public var documentTitle: String { loaded["document"]["title"].string ?? "" }
    public var dirty: Bool { text != savedText }
    public var needsProtection: Bool { dirty || pendingSave != nil }
    public var locked: Bool { bible["blueprint"]["lock"]["locked"].bool ?? false }
    public var bibleInitialized: Bool { bible["blueprint"]["blueprint_id"].string != nil }
    private func bibleInput(_ input: [String: JSONValue] = [:]) -> [String: JSONValue] {
        var fields = input
        if let reference = workReference { fields["work_ref"] = reference.value }
        return fields
    }
    public func t(_ key: String, _ parameters: [String: String] = [:]) -> String { localizer.text(key, parameters) }
    public func report(_ error: any Error) {
        if case CoreError.business(let result) = error, result["error"]["code"].string == "hetu.workspace_busy" { writeLocked = true }
        message = localizer.error(error)
    }

    // 调用方先完成未保存内容决策；只有成功打开新上下文后才替换当前项目。
    @discardableResult public func open(_ url: URL, title: String? = nil, expectedWorkspaceID: String? = nil, workReference: WorkReference? = nil) async -> Bool {
        guard !busy else { return false }
        busy = true; defer { busy = false }
        do {
            let next = try await Workspace.open(at: url, mode: .author, title: title, locale: locale, operationKey: title == nil ? nil : UUID().uuidString, authorizationURL: authorizationURL)
            let info = try await next.data("hetu.workspaces.get")
            if let expectedWorkspaceID, info["workspace"]["workspace_id"].string != expectedWorkspaceID { throw LibraryStore.LibraryError.wrongWorkspace }
            let works = try await WorkCatalog.list(in: next, includeArchived: true)
            let selected: JSONValue?
            if let workReference {
                guard let exact = works.first(where: { $0["work_ref"] == workReference.value }) else { throw LibraryStore.LibraryError.changedWork }
                selected = exact
            } else {
                selected = works.first { $0["work_ref"]["kind"] == info["workspace"]["work_type"] } ?? works.first
            }
            let current: JSONValue
            if let selected { current = try await next.data("hetu.works.get", input: ["work_ref": selected["work_ref"]]) }
            else { current = .null }
            let novel = try await next.data("hetu.novels.get")
            let cover = novel["initialized"].bool == true ? await readCover(next) : .null
            let bible = try await next.data("hetu.blueprints.get", input: selected.map { ["work_ref": $0["work_ref"]] } ?? [:])
            let documents = try await next.data("hetu.documents.list")
            let drafts = try await next.data("hetu.drafts.list")
            let pendingOperations = try await recovery.structureOperations(workspaceID: info["workspace"]["workspace_id"].string ?? "")
            let entries = try await registerProjections(workspace: next, info: info, works: works, novel: novel, cover: cover, selected: selected?["work_ref"], opened: true)
            recoveryTask?.cancel(); statisticsTask?.cancel()
            self.workspace = next; self.info = info; self.bible = bible; self.novel = novel; self.libraryEntries = entries
            self.currentWork = current; self.availableWorks = works
            artworkLibrary.reset()
            writeLocked = info["access"]["write_available"].bool == false
            self.cover = workType == "novel" ? cover : .null
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
            info = try await workspace.data("hetu.workspaces.get")
            writeLocked = info["access"]["write_available"].bool == false
            bible = try await workspace.data("hetu.blueprints.get", input: bibleInput())
            novel = try await workspace.data("hetu.novels.get")
            cover = novel["initialized"].bool == true ? await readCover(workspace) : .null
            documents = try await workspace.data("hetu.documents.list")["documents"].array.map(DocumentItem.init)
            drafts = try await workspace.data("hetu.drafts.list")["drafts"].array
            try await updateLibraryProjection()
        } catch { report(error) }
    }
    public func refreshWriteAccess() async {
        guard !busy, let workspace else { return }
        let scope = workspaceID
        guard let status = try? await workspace.data("hetu.workspaces.get"), scope == workspaceID else { return }
        let wasLocked = writeLocked
        writeLocked = status["access"]["write_available"].bool == false
        if wasLocked && !writeLocked {
            let selected = documentID
            await refresh()
            // 作者已有输入仍留在缓冲，后续保存继续经过修订比较。
            if !selected.isEmpty, !needsProtection, !isComposing { _ = await selectDocument(selected) }
        }
    }
    public func monitorWriteAccess() async {
        let scope = workspaceID
        while !Task.isCancelled, scope == workspaceID {
            await refreshWriteAccess()
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
        }
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
        requestedSelection = nil
        adoptionUndoBaseline = nil
        loaded = .null; text = ""; savedText = ""; baseRevisionID = ""; conflict = .null
        pendingSave = nil; recoveryCandidates = []; statistics = TextStatistics.count(""); replacementVersion += 1
    }
    public func edit(_ value: String, documentID expectedID: String? = nil) {
        if let expectedID, expectedID != documentID { return }
        guard !documentID.isEmpty, !writeLocked else { return }
        text = value; scheduleStatistics()
        recoveryTask?.cancel()
        guard !isComposing else { return }
        let token = generation
        recoveryTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(400)) } catch { return }
            guard let self, token == self.generation else { return }
            _ = await self.persistRecovery()
            guard self.preferences.object(forKey: "Hetu.editor.autosave") as? Bool != false else { return }
            do { try await Task.sleep(for: .milliseconds(1200)) } catch { return }
            guard token == self.generation, !self.isComposing, !self.busy, !self.writeLocked,
                  self.conflict == .null, self.recoveryCandidates.isEmpty, self.dirty else { return }
            self.recoveryTask = nil
            _ = await self.save()
        }
    }
    public func selectText(_ range: NSRange, in snapshot: String) -> Bool {
        guard text == snapshot, let span = SourceSpan(content: text, selection: range),
              let selection = SourceSelection(content: text, byteStart: span.byteStart, byteEnd: span.byteEnd, quote: span.quote) else { return false }
        requestedSelection = selection; return true
    }
    @discardableResult public func replaceText(snapshot: String, matches: [TextMatch], replacement: String) -> Bool {
        guard !busy, !isComposing, !writeLocked, text == snapshot,
              let result = TextSearch.replacing(text, matches: matches, with: replacement) else { return false }
        return replaceBuffer(snapshot: snapshot, with: result)
    }
    @discardableResult public func replaceBuffer(snapshot: String, with result: String) -> Bool {
        guard !busy, !isComposing, !writeLocked, text == snapshot, !result.contains("\0") else { return false }
        adoptionUndoBaseline = text; edit(result); replacementVersion += 1
        return true
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
        guard !busy, !writeLocked, !isComposing, let workspace, !documentID.isEmpty else { return false }
        guard needsProtection else { return true }
        busy = true; saving = true
        var saved = false
        defer {
            busy = false; saving = false
            if saved && dirty { edit(text) }
        }
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
            saved = true
            do { try await updateLibraryProjection() } catch { report(error) }
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
        guard !busy, !writeLocked, let workspace else { return false }
        busy = true; defer { busy = false }
        do {
            bible = try await workspace.data("hetu.blueprints.save", input: bibleInput(["expected": expectedBible, "typed_changes": .array(changes), "operation_key": .string(UUID().uuidString)]))
            return true
        } catch { reportBible(error, onFailure: onFailure); return false }
    }
    public func previewBibleChanges(_ changes: [JSONValue]) async -> JSONValue? {
        guard !busy, let workspace else { return nil }
        busy = true; defer { busy = false }
        do { return try await workspace.data("hetu.blueprints.preview_change", input: bibleInput(["expected": expectedBible, "typed_changes": .array(changes)])) }
        catch { reportBible(error); return nil }
    }
    public func readBibleRevision(_ revision: Int64, onFailure: ((String) -> Void)? = nil) async -> JSONValue? {
        guard !busy, let workspace else { return nil }
        busy = true; defer { busy = false }
        do { return try await workspace.data("hetu.blueprints.get", input: bibleInput(["revision": .integer(revision)])) }
        catch { reportBible(error, onFailure: onFailure); return nil }
    }
    private func reportBible(_ error: any Error, onFailure: ((String) -> Void)? = nil) {
        let text: String
        if case CoreError.business(let result) = error, result["error"]["code"].string == "revision_conflict" { text = t("error.bible_conflict") }
        else { text = localizer.error(error) }
        if let onFailure { onFailure(text) } else { message = text }
    }
    private var expectedBible: JSONValue { .object(["blueprint_id": bible["blueprint"]["blueprint_id"], "revision": bible["revision"], "sha256": bible["sha256"]]) }
    @discardableResult public func setLocked(_ value: Bool, reason: String, onFailure: ((String) -> Void)? = nil) async -> Bool {
        guard !busy, !writeLocked, let workspace else { return false }
        busy = true; defer { busy = false }
        do {
            bible = try await workspace.data(value ? "hetu.blueprints.lock" : "hetu.blueprints.unlock", input: bibleInput(["expected": expectedBible, "reason": .string(reason), "operation_key": .string(UUID().uuidString)]))
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
            let bp = try await workspace.data("hetu.blueprints.get", input: bibleInput())
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
        if writeLocked && input["operation_key"] != nil { onFailure(t("workspace.read_only"), true); return nil }
        let scopeID = workspaceID
        let export = ["hetu.documents.export", "hetu.bundles.export"].contains(action)
        var ownsBusy = true
        busy = true; defer { if ownsBusy { busy = false } }
        let operation = input["operation_key"] == nil ? nil : PendingStructureOperation(workspaceID: scopeID, action: action, input: input)
        let activeKey = export ? operation.map { $0.workspaceID + ":" + $0.action + ":" + $0.id } : nil
        if let activeKey, activeDeliveryOperations.contains(activeKey) { return nil }
        if let activeKey { activeDeliveryOperations.insert(activeKey) }
        defer { if let activeKey { activeDeliveryOperations.remove(activeKey) } }
        if let operation, pendingStructureOperations.contains(where: { $0 != operation }) { onFailure(t("review.pending"), true); return nil }
        do {
            if let operation { try await recovery.writeOperation(operation); pendingStructureOperations = try await recovery.structureOperations(workspaceID: scopeID) }
            let worker: Workspace
            if export {
                // 独立句柄避免压缩占住编辑器的 Workspace actor；恢复记录先于长任务持久化。
                worker = try await Workspace.open(at: workspace.url, mode: .author, authorizationURL: authorizationURL)
                busy = false; ownsBusy = false
            } else { worker = workspace }
            let value = try await worker.data(action, input: input, allowPartial: true)
            if !export, (["hetu.drama.create_script", "hetu.drama.episodes.create", "hetu.drama.episodes.update", "hetu.drama.projects.attach"].contains(action) || action.hasPrefix("hetu.documents.")) {
                documents = try await workspace.data("hetu.documents.list")["documents"].array.map(DocumentItem.init)
                if ["hetu.drama.episodes.update", "hetu.drama.projects.attach"].contains(action), let current = documents.first(where: { $0.id == documentID }) {
                    // 分集资料更新只刷新展示归属，不替换正文缓冲或保存基线。
                    var document = loaded["document"].object
                    document["title"] = current.value["title"]
                    document["drama_episode_id"] = current.value["drama_episode_id"]
                    var fields = loaded.object; fields["document"] = .object(document); loaded = .object(fields)
                }
            }
            if ["hetu.documents.finalize", "hetu.documents.withdraw_finalization"].contains(action), value["document"]["document_id"].string == documentID {
                var fields = loaded.object; fields["document"] = value["document"]; loaded = .object(fields)
            }
            if action.hasPrefix("hetu.reviews.") || action.hasPrefix("hetu.drafts.") {
                documents = try await workspace.data("hetu.documents.list")["documents"].array.map(DocumentItem.init)
                drafts = try await workspace.data("hetu.drafts.list")["drafts"].array
            }
            if action.hasPrefix("hetu.novels.") || action == "hetu.documents.create" || action == "hetu.documents.import" || action == "hetu.drafts.adopt" {
                novel = try await workspace.data("hetu.novels.get")
            }
            if action == "hetu.covers.select" {
                cover = try await workspace.data("hetu.covers.get")
            }
            if let operation {
                try await recovery.removeOperation(operation)
                if workspaceID == scopeID { pendingStructureOperations = try await recovery.structureOperations(workspaceID: scopeID) }
                if workspaceID == scopeID {
                    do { try await updateLibraryProjection() } catch { report(error) }
                }
            }
            return value
        }
        catch {
            let terminal: Bool
            if case CoreError.business(let result) = error { terminal = result["status"].string == "blocked" }
            else { terminal = false }
            if terminal, let operation {
                do {
                    try await recovery.removeOperation(operation)
                    if workspaceID == scopeID { pendingStructureOperations = try await recovery.structureOperations(workspaceID: scopeID) }
                }
                catch { onFailure(t("error.recovery"), false); return nil }
            }
            if DeliverySession.isDeliveryAction(action), case CoreError.business(let result) = error,
               ["revision_conflict", "hetu.stale_evidence"].contains(result["error"]["code"].string ?? "") {
                onFailure(t("delivery.inputs_changed"), terminal)
            } else { onFailure(localizer.error(error), terminal) }
            return nil
        }
    }
    public func isDeliveryRunning(_ operation: PendingStructureOperation) -> Bool {
        activeDeliveryOperations.contains(operation.workspaceID + ":" + operation.action + ":" + operation.id)
    }
    private func plotData(_ action: String, input: [String: JSONValue], onFailure: (String) -> Void) async -> JSONValue? {
        guard !busy, let workspace else { return nil }
        busy = true; defer { busy = false }
        do { return try await workspace.data(action, input: input, allowPartial: true) }
        catch { onFailure(localizer.error(error)); return nil }
    }
    // 接纳有限机器新建的作品与作者选择的路径，不扫描用户文件系统。
    public func loadLibrary() async {
        guard !loadingLibrary else { return }
        loadingLibrary = true; defer { loadingLibrary = false }
        do {
            libraryEntries = try await library.entries()
            try await library.receiveCreatedWorks()
            libraryEntries = try await library.refreshProperties()
        } catch { report(error) }
    }
    @discardableResult public func openLibraryEntry(_ entry: LibraryEntry) async -> Bool {
        do { return await open(try await library.resolve(entry), expectedWorkspaceID: entry.workspaceID, workReference: entry.workReference) }
        catch { report(error); return false }
    }
    public func trashLibraryEntry(_ entry: LibraryEntry, confirmingTitle: String) async throws {
        guard !busy, workspace == nil else { throw LibraryStore.LibraryError.busy }
        busy = true; defer { busy = false }
        libraryEntries = try await library.trash(entry, confirmingTitle: confirmingTitle)
        let recent = recentURLs.filter { $0.standardizedFileURL.path != entry.path }.map(\.path)
        preferences.set(recent, forKey: "Hetu.recent")
    }
    public func removeLibraryEntry(_ entry: LibraryEntry) async {
        guard !busy, workspace == nil else { return }
        do { libraryEntries = try await library.removeRegistration(entry) }
        catch { report(error) }
    }
    public func libraryDeletionScope(_ entry: LibraryEntry) async throws -> [JSONValue] {
        let url = try await library.resolve(entry)
        let target = try await Workspace.open(at: url, mode: .author)
        let identity = try await target.data("hetu.workspaces.get")
        guard identity["workspace"]["workspace_id"].string == entry.workspaceID else { throw LibraryStore.LibraryError.wrongWorkspace }
        return try await WorkCatalog.list(in: target, includeArchived: true)
    }
    /// 共用目录只归档所选项目，正文、关系和其他项目均保留。
    public func archiveLibraryEntry(_ entry: LibraryEntry, confirmingTitle: String) async throws {
        guard !busy, workspace == nil else { throw LibraryStore.LibraryError.busy }
        guard !entry.title.isEmpty, confirmingTitle == entry.title else { throw LibraryStore.LibraryError.confirmationMismatch }
        busy = true; defer { busy = false }
        let url = try await library.resolve(entry)
        let target = try await Workspace.open(at: url, mode: .author)
        let works = try await WorkCatalog.list(in: target, includeArchived: true)
        let matches = works.filter { summary in
            if let reference = entry.workReference { return summary["work_ref"] == reference.value }
            return summary["work_ref"]["kind"].string == entry.contentType
        }
        guard matches.count == 1, let summary = matches.first, summary["title"].string == entry.title,
              summary["work_ref"]["workspace_id"].string == entry.workspaceID else { throw LibraryStore.LibraryError.changedWork }
        let reference = try WorkReference(summary["work_ref"])
        let read = try await target.data("hetu.works.get", input: ["work_ref": reference.value])
        guard read["summary"]["fixed_ref"] == summary["fixed_ref"] else { throw LibraryStore.LibraryError.changedWork }
        let record = read["record"]
        let expected: JSONValue = .object(["revision": record["revision"], "sha256": summary["fixed_ref"]["sha256"]])
        var metadata: JSONValue = .object(["title": summary["title"], "status": .string("archived")])
        if reference.kind == "novel" {
            var profile = record["metadata"].object; profile["status"] = .string("archived"); metadata = .object(profile)
            _ = try await target.data("hetu.novels.update", input: ["expected": expected, "metadata": metadata, "operation_key": .string(UUID().uuidString)])
        } else {
            let idKey = reference.kind == "drama" ? "project_id" : "video_project_id"
            var fixed = expected.object; fixed[idKey] = .string(reference.objectID)
            var input: [String: JSONValue] = ["project_ref": .object(fixed), "title": record["title"], "archived": .bool(true), "operation_key": .string(UUID().uuidString)]
            input[reference.kind == "drama" ? "description" : "brief"] = record[reference.kind == "drama" ? "description" : "brief"]
            _ = try await target.data(reference.kind == "drama" ? "hetu.drama.projects.update" : "hetu.video.projects.update", input: input)
        }
        let updated = try await target.data("hetu.works.get", input: ["work_ref": reference.value])
        libraryEntries = try await library.register(url: target.url, workspaceID: entry.workspaceID, metadata: metadata,
            chapterCount: entry.chapterCount, opened: false, workType: reference.kind, properties: updated["summary"], workReference: reference)
    }
    // 调用方先完成关闭/切换作品共用的未保存内容保护。
    public func returnToLibrary() async {
        guard !busy else { return }
        recoveryTask?.cancel(); statisticsTask?.cancel(); generation = UUID(); resetDocument()
        workspace = nil; info = .null; bible = .null; novel = .null; cover = .null
        currentWork = .null; availableWorks = []
        documents = []; drafts = []; pendingStructureOperations = []
        await loadLibrary()
    }
    private func updateLibraryProjection() async throws {
        guard let workspace else { return }
        info = try await workspace.data("hetu.workspaces.get")
        let works = try await WorkCatalog.list(in: workspace, includeArchived: true)
        let reference = workReference?.value
        if let reference { currentWork = try await workspace.data("hetu.works.get", input: ["work_ref": reference]) }
        availableWorks = works
        libraryEntries = try await registerProjections(workspace: workspace, info: info, works: works, novel: novel, cover: cover, selected: reference, opened: false)
    }
    private func registerProjections(workspace: Workspace, info: JSONValue, works: [JSONValue], novel: JSONValue, cover: JSONValue, selected: JSONValue?, opened: Bool) async throws -> [LibraryEntry] {
        var entries = try await library.entries()
        for summary in works {
            let reference = try WorkReference(summary["work_ref"])
            let isNovel = reference.kind == "novel"
            let metadata: JSONValue = isNovel ? novel["novel"]["metadata"] : .object(["title": summary["title"], "status": .string(summary["archived"].bool == true ? "archived" : "planning")])
            entries = try await library.register(url: workspace.url, workspaceID: reference.workspaceID, metadata: metadata,
                chapterCount: isNovel ? novel["novel"]["chapters"].array.count : 0, opened: opened && selected == reference.value,
                cover: isNovel ? cover : .null, workType: reference.kind, properties: summary, workReference: reference)
        }
        // 空的旧工作区保持可打开；不为了登记而创建空小说或剧本。
        if works.isEmpty {
            entries = try await library.register(url: workspace.url, workspaceID: info["workspace"]["workspace_id"].string ?? "",
                metadata: .object(["title": info["workspace"]["title"]]), chapterCount: 0, opened: opened,
                workType: info["workspace"]["work_type"].string ?? "novel", properties: info["properties"])
        } else {
            entries = try await library.finishObjectAdmission(workspaceID: info["workspace"]["workspace_id"].string ?? "")
        }
        return entries
    }
    private func readCover(_ workspace: Workspace) async -> JSONValue {
        do { return try await workspace.data("hetu.covers.get") }
        catch { return .object(["error": .string(localizer.error(error))]) }
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
