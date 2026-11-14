import Foundation
import Observation
import CryptoKit
import HetuCore

public enum CreativeTaskError: Error {
    case scopeChanged, saveRequired, invalidSelection, missingClient, invalidResult, budgetExceeded
    public var key: String { "creative.error." + String(describing: self) }
}

public enum CreativeTaskKind: String, CaseIterable, Identifiable {
    case revision, chapterDraft = "chapter_draft", dramaDraft = "drama_draft", outline, bookProfile = "book_profile", cover, artwork
    public var id: String { rawValue }
    public var titleKey: String { "creative.kind." + rawValue }
    public var skillName: String {
        switch self {
        case .revision: "hetu-revise"
        case .chapterDraft: "hetu-draft"
        case .dramaDraft: "hetu-drama"
        case .outline: "hetu-outline"
        case .bookProfile: "hetu-book-profile"
        case .cover: "hetu-cover"
        case .artwork: "hetu-artwork"
        }
    }
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
        await previewWriting(kind: .revision, ranges: ranges, contextIDs: contextIDs, includeBible: includeBible, includeCurrent: true, client: client, brief: brief)
    }
    public func previewWriting(kind: CreativeTaskKind, ranges: [JSONValue] = [], contextIDs: Set<String>, includeBible: Bool, includeCurrent: Bool, client: AgentClient, brief: String) async {
        error = nil; preview = .null
        do {
            guard model.workspaceID == scopeID else { throw CreativeTaskError.scopeChanged }
            guard client != .none else { throw CreativeTaskError.missingClient }
            guard !model.needsProtection, !model.isComposing else { throw CreativeTaskError.saveRequired }
            let document = model.loaded
            var context: [JSONValue] = []
            for item in model.documents where contextIDs.contains(item.id) && (kind != .revision || item.id != model.documentID) {
                guard let value = await read("hetu.documents.get", input: ["document_id": .string(item.id)]) else { return }
                context.append(.object(["kind": .string("document"), "document_id": .string(item.id), "revision_id": value["revision"]["revision_id"]]))
            }
            if includeBible { context.append(.object(["kind": .string("blueprint"), "revision": model.bible["blueprint"]["revision"]])) }
            if kind != .revision && includeCurrent && !model.documentID.isEmpty && !contextIDs.contains(model.documentID) {
                context.insert(.object(["kind": .string("document"), "document_id": .string(model.documentID), "revision_id": document["revision"]["revision_id"]]), at: 0)
            }
            guard model.loaded == document, !model.needsProtection, !model.isComposing else { throw CreativeTaskError.saveRequired }
            let input: [String: JSONValue]
            if kind == .revision {
                input = try CreativeTaskInput.revision(scopeID: scopeID, document: document, ranges: ranges, context: context, client: client, brief: brief, locale: model.locale)
            } else {
                input = ["scope_ref": .object(["kind": .string("workspace"), "id": .string(scopeID)]), "task_kind": .string(kind.rawValue),
                    "brief": .string(brief), "input_refs": .array(context), "client_adapter": .string(client == .claudeCode ? "claude-code" : client.rawValue), "language_tag": .string(model.locale == "en" ? "en" : "zh-CN")]
            }
            if let value = await read("hetu.creative_tasks.preview_prompt", input: input) {
                var fields = value.object
                let association = model.agentIntegration.association(for: scopeID)
                if let suite = try AgentSuiteCatalog.bundled().suites.first(where: { $0.id == association.suiteID }) {
                    let skillName = suite.skillName(kind.skillName, client: client)
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
    @discardableResult public func authorizeAccess() async -> Bool {
        guard let client = task["request"]["client_adapter"].string,
              task["request"]["task_id"].string != nil else { return false }
        return await mutate("hetu.collaboration.authorize", input: ["task_ref": taskReference,
            "client_adapter": .string(TaskConnection.adapter(client)), "operation_key": .string(UUID().uuidString)]) != nil
    }
    public func previewResources(references: [JSONValue], editableIDs: [String], allowCreate: Bool, client: AgentClient, brief: String) async {
        guard !held, client != .none else { return }
        error = nil; preview = .null
        let adapter = client == .claudeCode ? "claude-code" : client.rawValue
        let input: [String: JSONValue] = ["scope_ref": .object(["kind": .string("workspace"), "id": .string(scopeID)]),
            "task_kind": .string("resource_organize"), "brief": .string(brief), "input_refs": .array([]),
            "client_adapter": .string(adapter), "language_tag": .string(model.locale == "en" ? "en" : "zh-CN"),
            "resource_scope": .object(["resource_refs": .array(references), "editable_resource_ids": .array(editableIDs.map(JSONValue.string)), "allow_create": .bool(allowCreate)])]
        guard var value = await read("hetu.creative_tasks.preview_prompt", input: input) else { return }
        if let suite = try? AgentSuiteCatalog.bundled().suites.first(where: { $0.id == model.agentIntegration.association(for: scopeID).suiteID }) {
            let name = suite.skillName("hetu-resources", client: client)
            let instruction = model.locale == "en" ? "Use \(name) from the author-selected package \(suite.pluginName)." : "请使用作者所选扩展包 \(suite.pluginName) 内的 \(name) 工作流。"
            var fields = value.object; fields["prompt"] = .string(instruction + "\n\n" + (value["prompt"].string ?? "")); value = .object(fields)
        }
        preview = value
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
        if let value = await read("hetu.interactions.get", input: input) { task = value }
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
    public static func adapter(_ client: String) -> String { client == "other" ? "generic" : client }
    public static func configuration(executable: URL, clientAdapter: String) throws -> String {
        let clientAdapter = adapter(clientAdapter)
        guard executable.isFileURL, executable.path.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: executable.path),
              ["codex", "claude-code", "workbuddy", "generic"].contains(clientAdapter) else { throw CreativeTaskError.invalidResult }
        if clientAdapter == "codex" {
            // JSON 字符串的转义也是 TOML basic string 的合法子集；路径不能用 Shell 插值。
            let quoted = String(decoding: try JSONValue.string(executable.path).encoded(), as: UTF8.self)
            return "[mcp_servers.hetu]\ncommand = \(quoted)\nargs = [\"--client\", \"codex\"]\n"
        }
        let value: JSONValue = .object(["mcpServers": .object(["hetu": .object(["command": .string(executable.path),
            "args": .array([.string("--client"), .string(clientAdapter)])])])])
        return String(decoding: try value.encoded(pretty: true), as: UTF8.self)
    }
}
