import Foundation
import Observation
import CryptoKit
import HetuCore

public enum CreativeTaskError: Error {
    case scopeChanged, saveRequired, invalidSelection, missingClient, invalidResult, budgetExceeded
    public var key: String { "creative.error." + String(describing: self) }
}

public enum CreativeTaskInput {
    public static func range(_ span: SourceSpan) -> JSONValue {
        .object(["byte_start": .integer(Int64(span.byteStart)), "byte_end": .integer(Int64(span.byteEnd)), "quote": .string(span.quote)])
    }

    public static func revision(scopeID: String, document: JSONValue, ranges: [JSONValue], context: [JSONValue], client: AgentClient, brief: String, locale: String) throws -> [String: JSONValue] {
        guard client != .none else { throw CreativeTaskError.missingClient }
        guard let documentID = document["document"]["document_id"].string,
              let revisionID = document["revision"]["revision_id"].string, !ranges.isEmpty else { throw CreativeTaskError.invalidSelection }
        let adapter = client == .claudeCode ? "claude-code" : client.rawValue
        let source: JSONValue = .object(["kind": .string("document"), "document_id": .string(documentID), "revision_id": .string(revisionID)])
        return ["scope_ref": .object(["kind": .string("workspace"), "id": .string(scopeID)]), "task_kind": .string("revision"),
            "brief": .string(brief), "input_refs": .array([source] + context), "client_adapter": .string(adapter), "language_tag": .string(locale == "en" ? "en" : "zh-CN"),
            "edit_scope": .object(["document_id": .string(documentID), "revision_id": .string(revisionID), "ranges": .array(ranges)])]
    }

    /// 从确切候选选择改动，再复用作者采纳用例；从不按旧行号套用到新正文。
    public static func patchAdoption(task: JSONValue, candidate: JSONValue, draft: JSONValue, target: JSONValue, selected: Set<Int>) throws -> [String: JSONValue] {
        let request = task["request"], edit = request["edit_scope"]
        guard target["document"]["document_id"] == edit["document_id"], target["revision"]["revision_id"] == edit["revision_id"],
              candidate["draft_ref"]["draft_id"] == draft["draft"]["draft_id"], candidate["sha256"] == draft["draft"]["content_sha256"],
              let original = target["content"].string, let source = candidate["content"].string, !source.isEmpty,
              !selected.isEmpty else { throw CreativeTaskError.invalidSelection }
        let patches = candidate["patches"].array
        guard selected.allSatisfy({ patches.indices.contains($0) }) else { throw CreativeTaskError.invalidSelection }
        let ordered = patches.enumerated().sorted { ($0.element["byte_start"].integer ?? -1) < ($1.element["byte_start"].integer ?? -1) }
        var result = Array(original.utf8)
        var upperBound = result.count + 1
        for (index, patch) in ordered.reversed() {
            guard let startValue = patch["byte_start"].integer, let endValue = patch["byte_end"].integer,
                  let start = Int(exactly: startValue), let end = Int(exactly: endValue),
                  start >= 0, end >= start, end <= original.utf8.count, end < upperBound,
                  let quote = patch["quote"].string, let replacement = patch["replacement"].string,
                  String(bytes: Array(original.utf8)[start..<end], encoding: .utf8) == quote else { throw CreativeTaskError.invalidSelection }
            upperBound = start + 1
            if selected.contains(index) { result.replaceSubrange(start..<end, with: replacement.utf8) }
        }
        guard let content = String(bytes: result, encoding: .utf8) else { throw CreativeTaskError.invalidSelection }
        let sourceRange: JSONValue = .object(["byte_start": .integer(0), "byte_end": .integer(Int64(source.utf8.count)), "quote": .string(source)])
        let targetRange: JSONValue = .object(["byte_start": .integer(0), "byte_end": .integer(Int64(original.utf8.count)), "quote": .string(original)])
        return ["draft_ref": .object(["draft_id": draft["draft"]["draft_id"], "revision": draft["draft"]["revision"], "sha256": draft["draft"]["content_sha256"]]),
            "target_ref": .object(["document_id": target["document"]["document_id"], "revision_id": target["revision"]["revision_id"], "sha256": target["revision"]["sha256"]]),
            "new_document": .null, "selected_ranges": .array([.object(["source": sourceRange, "target": targetRange, "replacement": .string(content)])])]
    }
}

@MainActor @Observable public final class CreativeTaskSession {
    public private(set) var preview: JSONValue = .null
    public private(set) var task: JSONValue = .null
    public private(set) var tasks: [JSONValue] = []
    public private(set) var nextCursor: String?
    public private(set) var pending: PendingStructureOperation?
    public var error: String?
    private let model: WorkspaceModel
    private let scopeID: String
    public init(model: WorkspaceModel) {
        self.model = model; scopeID = model.workspaceID
        pending = model.pendingStructureOperations.first { $0.action.hasPrefix("hetu.creative_tasks.") }
    }
    public var held: Bool { pending != nil || !model.pendingStructureOperations.isEmpty }
    public func discardPreview() { preview = .null }
    public func startNew() { guard !held else { return }; task = .null; preview = .null }
    public func showError(_ error: any Error) { self.error = (error as? CreativeTaskError).map { model.t($0.key) } ?? model.localizer.error(error) }

    public func previewRevision(ranges: [JSONValue], contextIDs: Set<String>, includeBible: Bool, client: AgentClient, brief: String) async {
        error = nil; preview = .null
        do {
            guard model.workspaceID == scopeID else { throw CreativeTaskError.scopeChanged }
            guard !model.needsProtection, !model.isComposing else { throw CreativeTaskError.saveRequired }
            let document = model.loaded
            var context: [JSONValue] = []
            for item in model.documents where contextIDs.contains(item.id) && item.id != model.documentID {
                guard let value = await read("hetu.documents.get", input: ["document_id": .string(item.id)]) else { return }
                context.append(.object(["kind": .string("document"), "document_id": .string(item.id), "revision_id": value["revision"]["revision_id"]]))
            }
            if includeBible { context.append(.object(["kind": .string("blueprint"), "revision": model.bible["blueprint"]["revision"]])) }
            guard model.loaded == document, !model.needsProtection, !model.isComposing else { throw CreativeTaskError.saveRequired }
            let input = try CreativeTaskInput.revision(scopeID: scopeID, document: document, ranges: ranges, context: context, client: client, brief: brief, locale: model.locale)
            if let value = await read("hetu.creative_tasks.preview_prompt", input: input) {
                var fields = value.object
                let association = model.agentIntegration.association(for: scopeID)
                if let suite = try AgentSuiteCatalog.bundled().suites.first(where: { $0.id == association.suiteID }) {
                    let skillName = suite.skillName("hetu-revise", client: client)
                    let instruction = model.locale == "en"
                        ? "Use the \(skillName) workflow from the author-selected package \(suite.pluginName) (\(model.t(suite.titleKey))). This records the selection, not a verified installed version."
                        : "请使用作者所选扩展包 \(suite.pluginName)（\(model.t(suite.titleKey))）内的 \(skillName) 工作流。此处记录所选套件，不表示已验证安装版本。"
                    fields["prompt"] = .string(instruction + "\n\n" + (value["prompt"].string ?? ""))
                }
                preview = .object(fields)
            }
        } catch { showError(error) }
    }

    public func prepare(prompt: String) async {
        guard pending == nil, preview != .null else { return }
        var input = preview["prepare_input"].object
        input["prompt"] = .string(prompt); input["operation_key"] = .string(UUID().uuidString)
        _ = await mutate("hetu.creative_tasks.prepare", input: input)
    }
    public func retry() async {
        guard let pending else { return }
        _ = await mutate(pending.action, input: pending.input)
    }
    public func loadTasks(append: Bool = false) async {
        var input: [String: JSONValue] = ["limit": .integer(20)]
        if append, let nextCursor { input["cursor"] = .string(nextCursor) }
        guard let value = await read("hetu.creative_tasks.list", input: input) else { return }
        tasks = (append ? tasks : []) + value["tasks"].array
        nextCursor = value["next_cursor"].string
    }
    public func loadTask(_ reference: JSONValue, submissionID: String? = nil) async {
        var input = ["task_ref": reference]
        if let submissionID { input["submission_id"] = .string(submissionID) }
        if let value = await read("hetu.creative_tasks.get", input: input) { task = value }
    }
    public var taskReference: JSONValue {
        .object(["scope_ref": task["request"]["scope_ref"], "task_id": task["request"]["task_id"], "request_revision": task["request"]["request_revision"]])
    }
    public func markCopied() async {
        _ = await mutate("hetu.creative_tasks.mark_copied", input: ["task_ref": taskReference, "request_sha256": task["request_sha256"], "operation_key": .string(UUID().uuidString)])
    }
    public func close(reason: String) async {
        _ = await mutate("hetu.creative_tasks.close", input: ["task_ref": taskReference, "expected": task["expected"], "reason": .string(reason), "operation_key": .string(UUID().uuidString)])
    }
    public func inspectInbox() async {
        do {
            guard model.workspaceID == scopeID, let workspace = model.workspace,
                  let relative = task["request"]["output_contract"]["relative_inbox"].string,
                  relative == ".hetu/tasks/\(task["request"]["task_id"].string ?? "")/inbox" else { throw CreativeTaskError.scopeChanged }
            let url = workspace.url.appendingPathComponent(relative).appendingPathComponent("result.json")
            let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
            let bytes = try handle.read(upToCount: 16 * 1024 * 1024 + 1) ?? Data()
            guard bytes.count <= 16 * 1024 * 1024 else { throw CreativeTaskError.budgetExceeded }
            let sha = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            _ = await mutate("hetu.creative_tasks.inspect_inbox", input: ["task_ref": taskReference, "file_name": .string("result.json"), "manifest_sha256": .string(sha), "operation_key": .string(UUID().uuidString)])
        } catch { showError(error) }
    }
    public func read(_ action: String, input: [String: JSONValue]) async -> JSONValue? {
        guard model.workspaceID == scopeID else { showError(CreativeTaskError.scopeChanged); return nil }
        error = nil
        return await model.workspaceAction(action, input: input) { message, _ in self.error = message }
    }
    public func mutate(_ action: String, input: [String: JSONValue]) async -> JSONValue? {
        guard model.workspaceID == scopeID else { showError(CreativeTaskError.scopeChanged); return nil }
        let operation = PendingStructureOperation(workspaceID: scopeID, action: action, input: input)
        guard pending == nil || pending == operation else { return nil }
        pending = operation; error = nil
        guard let value = await model.workspaceAction(action, input: input, onFailure: { message, terminal in
            self.error = message; if terminal { self.pending = nil }
        }) else { return nil }
        pending = nil
        if action == "hetu.creative_tasks.prepare" { task = value; preview = .null }
        else if input["task_ref"] != nil { await loadTask(input["task_ref"]!) }
        await loadTasks()
        return value
    }
}

public enum TaskConnection {
    public static func configuration(executable: URL, root: URL, scope: ContentScope, taskID: String) throws -> String {
        guard executable.isFileURL, root.isFileURL, executable.path.hasPrefix("/"), root.path.hasPrefix("/"),
              FileManager.default.isExecutableFile(atPath: executable.path), taskID.hasPrefix("task_"),
              UUID(uuidString: String(taskID.dropFirst(5))) != nil else { throw CreativeTaskError.invalidResult }
        let value: JSONValue = .object(["mcpServers": .object(["hetu-task": .object(["command": .string(executable.path),
            "args": .array([.string(scope == .workspace ? "--workspace" : "--creation-project"), .string(root.path), .string("--task"), .string(taskID)])])])])
        return String(decoding: try value.encoded(pretty: true), as: UTF8.self)
    }
}
