import Foundation
import Observation
import CryptoKit
import Darwin
import HetuCore

public struct CreationProjectEntry: Identifiable, Sendable {
    public let id: String
    public let url: URL
    public let title: String
    public let brief: String
}

/// 筹备和正式作品使用不同句柄；选中候选只填写作者表单。
@MainActor @Observable public final class CreationProjectSession {
    public private(set) var workspace: Workspace?
    public private(set) var record: JSONValue = .null
    public private(set) var fields: [String: JSONValue] = [:]
    public var brief = "" { didSet { if brief != oldValue { preview = .null } } }
    public private(set) var projects: [CreationProjectEntry] = []
    public private(set) var preview: JSONValue = .null
    public private(set) var task: JSONValue = .null
    public private(set) var tasks: [JSONValue] = []
    public private(set) var nextCursor: String?
    public private(set) var pending: PendingStructureOperation?
    public private(set) var created: JSONValue = .null
    public private(set) var conflict: JSONValue = .null
    public private(set) var busy = false
    public var error: String?
    public let directory: URL
    private let recovery: RecoveryStore
    private let localizer: Localizer
    private let creationKey = UUID().uuidString
    private let creationDirectory: URL

    public init(locale: String, directory: URL? = nil, recovery: RecoveryStore = RecoveryStore()) {
        self.localizer = Localizer(locale: locale)
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Hetu/CreationProjects", isDirectory: true)
        self.creationDirectory = self.directory.appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true)
        self.recovery = recovery
    }
    public var projectID: String { record["project"]["project_id"].string ?? "" }
    public var expected: JSONValue { .object(["revision": record["revision"], "sha256": record["sha256"]]) }
    public var completed: Bool { record["project"]["created_workspace_ref"] != .null }
    public var held: Bool { pending != nil || record["pending_creation"] != .null }
    public var dirty: Bool { brief != (record["project"]["brief"].string ?? "") || JSONValue.object(fields) != (record == .null ? .object([:]) : record["project"]["selected_fields"]) }
    public var taskReference: JSONValue {
        .object(["scope_ref": task["request"]["scope_ref"], "task_id": task["request"]["task_id"], "request_revision": task["request"]["request_revision"]])
    }
    public func value(_ field: String) -> String { fields[field]?["value"].string ?? "" }
    public func set(_ field: String, value: String) {
        guard !busy, !held, !completed, ["title", "author_name", "genre", "synopsis", "outline"].contains(field) else { return }
        fields[field] = .object(["value": .string(value), "candidate_ref": fields[field]?["candidate_ref"] ?? .null])
        preview = .null
    }
    public func select(_ candidate: JSONValue, field: String) {
        guard !busy, !held, !completed, let content = candidate["content"].string,
              ["title", "author_name", "genre", "synopsis", "outline"].contains(field),
              task["submission"]["candidates"].array.contains(candidate) else { return }
        let reference: JSONValue = .object(["task_ref": taskReference, "submission_id": task["submission"]["submission_id"], "candidate_id": candidate["candidate_id"]])
        fields[field] = .object(["value": .string(content), "candidate_ref": reference]); preview = .null
    }
    public func showError(_ error: any Error) { self.error = (error as? CreativeTaskError).map { localizer.text($0.key) } ?? localizer.error(error) }

    public func loadProjects() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        do {
            guard FileManager.default.fileExists(atPath: directory.path) else { projects = []; return }
            let urls = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            var result: [CreationProjectEntry] = []
            for url in urls.prefix(256) {
                let attributes = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                guard attributes.isDirectory == true, attributes.isSymbolicLink != true,
                      FileManager.default.fileExists(atPath: url.appendingPathComponent(".hetu-project.json").path) else { continue }
                let source = try await Workspace.openCreationProject(at: url)
                let scope = try await source.data("hetu.capabilities.get")["scope_ref"]["id"]
                let data = try await source.data("hetu.creation_projects.get", input: ["project_id": scope])
                let pending = try await recovery.structureOperations(workspaceID: scope.string ?? "")
                guard data["project"]["created_workspace_ref"] == .null || !pending.isEmpty else { continue }
                result.append(CreationProjectEntry(id: scope.string ?? "", url: url,
                    title: data["project"]["selected_fields"]["title"]["value"].string ?? "", brief: data["project"]["brief"].string ?? ""))
            }
            projects = result.sorted { $0.url.lastPathComponent < $1.url.lastPathComponent }
        } catch { showError(error) }
    }
    public func open(_ url: URL) async {
        guard !busy, !held, !dirty else { return }
        busy = true; defer { busy = false }; error = nil
        do {
            let source = try await Workspace.openCreationProject(at: url)
            let scope = try await source.data("hetu.capabilities.get")["scope_ref"]["id"]
            let data = try await source.data("hetu.creation_projects.get", input: ["project_id": scope])
            let operations = try await recovery.structureOperations(workspaceID: scope.string ?? "")
            guard operations.count <= 1 else { throw CreativeTaskError.invalidResult }
            workspace = source; record = data; brief = data["project"]["brief"].string ?? ""; fields = data["project"]["selected_fields"].object
            pending = operations.first; task = .null; preview = .null; created = .null; conflict = .null
            try await fetchTasks()
        } catch { showError(error) }
    }
    @discardableResult public func save() async -> Bool {
        guard !busy, !held, !completed, conflict == .null else { return false }
        busy = true; defer { busy = false }; error = nil
        do {
            if workspace == nil {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                workspace = try await Workspace.openCreationProject(at: creationDirectory, brief: brief, locale: localizer.locale, operationKey: creationKey)
                let scope = try await workspace!.data("hetu.capabilities.get")["scope_ref"]["id"]
                record = try await workspace!.data("hetu.creation_projects.get", input: ["project_id": scope])
            }
            if dirty {
                guard let data = await mutate("hetu.creation_projects.save", input: ["project_id": .string(projectID), "expected": expected,
                    "brief": .string(brief), "selected_fields": .object(fields), "operation_key": .string(UUID().uuidString)]) else { return false }
                record = data
            }
            return true
        } catch { showError(error); return false }
    }
    public func reload() async {
        guard !busy, let workspace else { return }
        busy = true; defer { busy = false }; error = nil
        do {
            let value = try await workspace.data("hetu.creation_projects.get", input: ["project_id": .string(projectID)])
            let changed = value["project"]["selected_fields"] != record["project"]["selected_fields"] || value["project"]["brief"] != record["project"]["brief"]
            if dirty && changed { conflict = value }
            else {
                if !dirty { fields = value["project"]["selected_fields"].object; brief = value["project"]["brief"].string ?? "" }
                record = value
            }
            try await fetchTasks()
        }
        catch { showError(error) }
    }
    public func acceptConflictBaseline() {
        guard !busy, !held, conflict != .null else { return }
        record = conflict; conflict = .null; error = nil; preview = .null
    }
    public func previewTask(kind: String, client: AgentClient, suiteID: String) async {
        preview = .null
        guard client != .none, await save(), let workspace else { return }
        busy = true; defer { busy = false }
        do {
            let adapter = client == .claudeCode ? "claude-code" : client.rawValue
            let value = try await workspace.data("hetu.creative_tasks.preview_prompt", input: ["scope_ref": .object(["kind": .string("creation_project"), "id": .string(projectID)]),
                "task_kind": .string(kind), "brief": .string(brief), "input_refs": .array([]), "client_adapter": .string(adapter), "language_tag": .string(localizer.locale)])
            var fields = value.object
            if let suite = try AgentSuiteCatalog.bundled().suites.first(where: { $0.id == suiteID }) {
                let method = ["book_concept": "hetu-book-create", "outline": "hetu-outline", "cover": "hetu-cover"][kind] ?? "hetu-book-profile"
                let skill = suite.skillName(method, client: client)
                let instruction = localizer.locale == "en" ? "Use \(skill) from the author-selected package \(suite.pluginName)." : "请使用作者所选扩展包 \(suite.pluginName) 中的 \(skill) 工作流。"
                fields["prompt"] = .string(instruction + "\n\n" + (value["prompt"].string ?? ""))
            }
            preview = .object(fields)
        } catch { showError(error) }
    }
    public func prepare(prompt: String) async {
        guard !busy, !held, preview != .null else { return }
        busy = true; defer { busy = false }
        var input = preview["prepare_input"].object
        input["prompt"] = .string(prompt); input["operation_key"] = .string(UUID().uuidString)
        if let value = await mutate("hetu.creative_tasks.prepare", input: input) {
            task = value; preview = .null; await refreshRecord()
        }
    }
    public func loadTask(_ ref: JSONValue, submissionID: String? = nil) async {
        guard !busy, let workspace else { return }
        busy = true; defer { busy = false }; error = nil
        do {
            var input = ["task_ref": ref]; if let submissionID { input["submission_id"] = .string(submissionID) }
            task = try await workspace.data("hetu.interactions.get", input: input)
        } catch { showError(error) }
    }
    public func taskAction(_ action: String) async {
        guard !busy, !held, let workspace else { return }
        busy = true; defer { busy = false }
        do {
            var input: [String: JSONValue] = ["task_ref": taskReference, "operation_key": .string(UUID().uuidString)]
            switch action {
            case "hetu.creative_tasks.mark_copied": input["request_sha256"] = task["request_sha256"]
            case "hetu.creative_tasks.close": input["expected"] = task["expected"]; input["reason"] = .string(localizer.text("creative.closed_by_author"))
            case "hetu.creative_tasks.inspect_inbox":
                input["file_name"] = .string("result.json")
                input["manifest_sha256"] = .string(try taskInboxDigest(root: workspace.url, task: task))
            default: throw CreativeTaskError.invalidResult
            }
            if await mutate(action, input: input) != nil {
                task = try await workspace.data("hetu.interactions.get", input: ["task_ref": taskReference]); try await fetchTasks()
            }
        } catch { showError(error) }
    }
    public func createNovel(at url: URL, language: String) async -> JSONValue? {
        guard !value("title").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, await save() else { return nil }
        busy = true; defer { busy = false }
        let metadata: JSONValue = .object(["title": .string(value("title").trimmingCharacters(in: .whitespacesAndNewlines)), "author_name": .string(value("author_name")),
            "genre": .string(value("genre")), "synopsis": .string(value("synopsis")), "language_tag": .string(language), "status": .string("planning")])
        let result = await mutate("hetu.creation_projects.create_novel", input: ["project_id": .string(projectID), "expected": expected, "metadata": metadata,
            "target_path": .string(url.path), "operation_key": .string(UUID().uuidString)], keepReceipt: true)
        if let result { created = result; await refreshRecord() }
        return result
    }
    public func recover() async {
        guard !busy, let pending else { return }
        busy = true; defer { busy = false }
        let result = await mutate(pending.action, input: pending.input, keepReceipt: pending.action == "hetu.creation_projects.create_novel")
        if let result {
            if pending.action == "hetu.creation_projects.create_novel" { created = result }
            else if pending.action == "hetu.creation_projects.save" { record = result }
            else if pending.action == "hetu.creative_tasks.prepare" { task = result; preview = .null }
            await refreshRecord()
        }
    }
    public func acknowledgeCreatedWorkspace() async {
        guard created != .null, let pending, pending.action == "hetu.creation_projects.create_novel" else { return }
        do { try await recovery.removeOperation(pending); self.pending = nil } catch { showError(error) }
    }
    private func fetchTasks() async throws {
        guard let workspace else { return }
        let value = try await workspace.data("hetu.creative_tasks.list", input: ["limit": .integer(100)])
        tasks = value["tasks"].array; nextCursor = value["next_cursor"].string
    }
    public func loadMoreTasks() async {
        guard !busy, let workspace, let nextCursor else { return }
        busy = true; defer { busy = false }
        do {
            let value = try await workspace.data("hetu.creative_tasks.list", input: ["limit": .integer(100), "cursor": .string(nextCursor)])
            tasks += value["tasks"].array; self.nextCursor = value["next_cursor"].string
        } catch { showError(error) }
    }
    private func refreshRecord() async {
        guard let workspace else { return }
        do { record = try await workspace.data("hetu.creation_projects.get", input: ["project_id": .string(projectID)]); try await fetchTasks() }
        catch { showError(error) }
    }
    private func mutate(_ action: String, input: [String: JSONValue], keepReceipt: Bool = false) async -> JSONValue? {
        guard let workspace else { return nil }
        let operation = PendingStructureOperation(workspaceID: projectID, action: action, input: input)
        guard pending == nil || pending == operation else { return nil }
        error = nil
        do {
            try await recovery.writeOperation(operation); pending = operation
            let value = try await workspace.data(action, input: input)
            if !keepReceipt { try await recovery.removeOperation(operation); pending = nil }
            return value
        } catch {
            if case CoreError.business(let value) = error, value["status"].string == "blocked" {
                do { try await recovery.removeOperation(operation); pending = nil } catch { showError(error); return nil }
                if value["error"]["code"].string == "revision_conflict" {
                    conflict = (try? await workspace.data("hetu.creation_projects.get", input: ["project_id": .string(projectID)])) ?? .null
                }
            }
            showError(error); return nil
        }
    }
}

private func taskInboxDigest(root: URL, task: JSONValue) throws -> String {
    guard let id = task["request"]["task_id"].string, id.hasPrefix("task_"), UUID(uuidString: String(id.dropFirst(5))) != nil,
          task["request"]["output_contract"]["relative_inbox"].string == ".hetu/tasks/\(id)/inbox" else { throw CreativeTaskError.invalidResult }
    let file = root.appendingPathComponent(".hetu/tasks/\(id)/inbox/result.json")
    let fd = Darwin.open(file.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
    guard fd >= 0 else { throw CreativeTaskError.invalidResult }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true); defer { try? handle.close() }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1, info.st_size <= 16 * 1024 * 1024 else { throw CreativeTaskError.invalidResult }
    let bytes = try handle.read(upToCount: 16 * 1024 * 1024 + 1) ?? Data()
    guard bytes.count <= 16 * 1024 * 1024 else { throw CreativeTaskError.budgetExceeded }
    return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
}
