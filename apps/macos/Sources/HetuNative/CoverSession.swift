import Foundation
import Observation
import HetuCore

/// 外部封面请求与作者选用分开；每次写入沿同一原操作恢复。
@MainActor @Observable public final class CoverSession {
    public private(set) var current: JSONValue = .null
    public private(set) var history: JSONValue = .null
    public private(set) var preview: JSONValue = .null
    public private(set) var requests: [JSONValue] = []
    public private(set) var nextCursor: String?
    public private(set) var candidates: JSONValue = .null
    public private(set) var preparationProjectID: String?
    public private(set) var preparationTasks: [JSONValue] = []
    public private(set) var preparationTask: JSONValue = .null
    public private(set) var preparationImports: [JSONValue] = []
    public private(set) var preparationCursor: String?
    public private(set) var preparationBusy = false
    public private(set) var pending: PendingStructureOperation?
    public var error: String?
    private let model: WorkspaceModel
    private let scopeID: String
    private var preparationProject: Workspace?
    public init(model: WorkspaceModel) {
        self.model = model; scopeID = model.workspaceID
        pending = model.pendingStructureOperations.first { $0.action.hasPrefix("hetu.covers.") }
    }
    public var held: Bool { pending != nil || preparationBusy || model.busy || !model.pendingStructureOperations.isEmpty }
    public func discardPreview() { preview = .null }
    public func refresh() async {
        if let value = await read("hetu.covers.get") {
            current = value; preparationProjectID = value["preparation_project_id"].string
        }
        await loadRequests()
        await loadPreparations()
        if preparationProject == nil { await findPreparationProject() }
    }
    public func inspectRevision(_ revision: Int) async {
        guard !held, revision > 0 else { return }
        history = .null
        if let value = await read("hetu.covers.get", input: ["revision": .integer(Int64(revision))]) { history = value }
    }
    public func restoreInspectedRevision() async -> Bool {
        guard !held, let revision = history["cover"]["revision"].integer,
              let latest = current["cover"]["revision"].integer, revision < latest else { return false }
        guard let value = await mutate("hetu.covers.select", input: [
            "source": .object(["kind": .string("asset"), "asset_ref": history["cover"]["asset_ref"]]),
            "expected_cover": current["expected_cover"], "presentation": history["cover"]["presentation"],
            "operation_key": .string(UUID().uuidString)
        ]) else { return false }
        current = value; history = .null; return true
    }
    public func loadRequests(append: Bool = false) async {
        var input: [String: JSONValue] = ["limit": .integer(20)]
        if append, let nextCursor { input["cursor"] = .string(nextCursor) }
        guard let value = await read("hetu.covers.list_requests", input: input) else { return }
        requests = (append ? requests : []) + value["requests"].array; nextCursor = value["next_cursor"].string
    }
    public func previewPrompt(book: JSONValue, design: JSONValue, language: String) async {
        preview = .null
        if let value = await read("hetu.covers.preview_prompt", input: ["book": book, "design": design, "language_tag": .string(language)]) { preview = value }
    }
    public func createRequest(prompt: String) async {
        guard !held, preview != .null else { return }
        var request = preview["request"].object; request["prompt"] = .string(prompt)
        if let value = await mutate("hetu.covers.create_request", input: ["request": .object(request), "operation_key": .string(UUID().uuidString)]) {
            preview = .null; await inspect(value["request"]["request_id"].string ?? "")
        }
    }
    public func inspect(_ requestID: String) async {
        if let value = await read("hetu.covers.list_candidates", input: ["request_id": .string(requestID)]) { candidates = value }
    }
    public func selectCandidate(_ value: JSONValue) async -> Bool {
        await select(source: .object(["kind": .string("candidate"), "reference": value["reference"]]),
            overlay: candidates["request"]["design"]["text_mode"].string == "background_only")
    }
    public func selectFile(_ file: URL, inspection: JSONValue, overlay: Bool) async -> Bool {
        await select(source: .object(["kind": .string("file"), "file_path": .string(file.path), "expected_file": .object(["sha256": inspection["sha256"], "size_bytes": inspection["size_bytes"]])]), overlay: overlay)
    }
    public func loadPreparationProject(_ url: URL) async {
        guard !held, let preparationProjectID else { return }
        preparationBusy = true; error = nil
        defer { preparationBusy = false }
        do {
            let source = try await Workspace.openCreationProject(at: url)
            let data = try await source.data("hetu.creation_projects.get", input: ["project_id": .string(preparationProjectID)])
            guard data["project"]["created_workspace_ref"]["workspace_id"].string == scopeID else {
                throw CreativeTaskError.invalidResult
            }
            let tasks = try await source.data("hetu.creative_tasks.list", input: ["limit": .integer(100)])
            guard model.workspaceID == scopeID else { throw CreativeTaskError.invalidResult }
            preparationProject = source
            preparationTasks = tasks["tasks"].array.filter { $0["task_kind"].string == "cover" }
            preparationTask = .null
        } catch { self.error = model.localizer.error(error) }
    }
    public func inspectPreparationTask(_ reference: JSONValue, submissionID: String? = nil) async {
        guard !held, let source = preparationProject else { return }
        preparationBusy = true; error = nil
        defer { preparationBusy = false }
        do {
            var input = ["task_ref": reference]
            if let submissionID { input["submission_id"] = .string(submissionID) }
            let result = try await source.data("hetu.interactions.get", input: input)
            guard model.workspaceID == scopeID else { throw CreativeTaskError.invalidResult }
            preparationTask = result
        } catch { self.error = model.localizer.error(error) }
    }
    public func importPreparation(_ candidate: JSONValue) async -> Bool {
        guard !held, let source = preparationProject,
              preparationTask["submission"]["candidates"].array.contains(candidate),
              candidate["kind"].string == "image" else { return false }
        let request = preparationTask["request"]
        let reference: JSONValue = .object(["task_ref": .object(["scope_ref": request["scope_ref"], "task_id": request["task_id"], "request_revision": request["request_revision"]]),
            "submission_id": preparationTask["submission"]["submission_id"], "candidate_id": candidate["candidate_id"]])
        guard await mutate("hetu.covers.import_preparation", input: ["project_path": .string(source.url.path), "candidate_ref": reference, "operation_key": .string(UUID().uuidString)]) != nil else { return false }
        await loadPreparations(); return true
    }
    public func loadPreparations(append: Bool = false) async {
        var input: [String: JSONValue] = ["limit": .integer(20)]
        if append, let preparationCursor { input["cursor"] = .string(preparationCursor) }
        guard let value = await read("hetu.covers.list_preparations", input: input) else { return }
        preparationImports = (append ? preparationImports : []) + value["imports"].array
        preparationCursor = value["next_cursor"].string
    }
    public func selectPreparation(_ item: JSONValue, overlay: Bool) async -> Bool {
        await select(source: .object(["kind": .string("preparation"), "reference": item["reference"]]), overlay: overlay)
    }
    private func findPreparationProject() async {
        guard let preparationProjectID, !held else { return }
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Hetu/CreationProjects", isDirectory: true)
        guard let folders = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]) else { return }
        for folder in folders.prefix(256) {
            let markerURL = folder.appendingPathComponent(".hetu-project.json")
            guard let attributes = try? folder.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]),
                  attributes.isDirectory == true, attributes.isSymbolicLink != true,
                  let markerAttributes = try? markerURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
                  markerAttributes.isRegularFile == true, markerAttributes.isSymbolicLink != true,
                  let size = markerAttributes.fileSize, size <= 16_384,
                  let marker = try? Data(contentsOf: markerURL), marker.count <= 16_384,
                  let value = try? JSONDecoder().decode(JSONValue.self, from: marker), value["project_id"].string == preparationProjectID else { continue }
            await loadPreparationProject(folder); return
        }
    }
    private func select(source: JSONValue, overlay: Bool) async -> Bool {
        guard !held else { return false }
        let presentation: JSONValue = .object(["crop_rect": .object(["x": .integer(0), "y": .integer(0), "width": .integer(1), "height": .integer(1)]),
            "title_overlay": .string(overlay ? model.title : ""), "author_overlay": .string(overlay ? model.novelMetadata["author_name"].string ?? "" : "")])
        guard let value = await mutate("hetu.covers.select", input: ["source": source, "expected_cover": current["expected_cover"], "presentation": presentation, "operation_key": .string(UUID().uuidString)]) else { return false }
        current = value; return true
    }
    public func retry() async {
        guard let pending else { return }
        if let value = await mutate(pending.action, input: pending.input) {
            if pending.action == "hetu.covers.select" { current = value }
            if pending.action == "hetu.covers.create_request" { await inspect(value["request"]["request_id"].string ?? "") }
            if pending.action == "hetu.covers.import_preparation" { await loadPreparations() }
        }
    }
    public func read(_ action: String, input: [String: JSONValue] = [:]) async -> JSONValue? {
        guard model.workspaceID == scopeID else { error = model.t("creative.error.scopeChanged"); return nil }
        error = nil
        return await model.workspaceAction(action, input: input, onFailure: { self.error = $0; _ = $1 })
    }
    private func mutate(_ action: String, input: [String: JSONValue]) async -> JSONValue? {
        guard model.workspaceID == scopeID else { error = model.t("creative.error.scopeChanged"); return nil }
        let operation = PendingStructureOperation(workspaceID: scopeID, action: action, input: input)
        guard pending == nil || pending == operation else { return nil }
        pending = operation; error = nil
        guard let value = await model.workspaceAction(action, input: input, onFailure: { message, terminal in self.error = message; if terminal { self.pending = nil } }) else { return nil }
        pending = nil; await loadRequests(); return value
    }
}
