import CHetu
import Foundation

public enum EntryMode: String, Sendable { case author, agent }
public enum ContentScope: String, Sendable { case workspace, creationProject = "creation_project" }

// 句柄不向 View/CLI 暴露；仅由 Workspace actor 串行访问。
private final class CoreHandle: @unchecked Sendable {
    private let pointer: OpaquePointer
    init(_ pointer: OpaquePointer) { self.pointer = pointer }
    deinit { hetu_context_close(pointer) }
    func request(_ bytes: Data) throws -> JSONValue {
        var buffer = HetuBuffer(data: nil, size: 0)
        let code = bytes.withUnsafeBytes { raw in
            hetu_request(pointer, raw.bindMemory(to: UInt8.self).baseAddress, UInt64(raw.count), &buffer)
        }
        return try consume(&buffer, code: code)
    }
}
private func consume(_ buffer: inout HetuBuffer, code: Int32) throws -> JSONValue {
    defer { hetu_buffer_free(&buffer) }
    guard code == 0 else { throw CoreError.boundary(code) }
    guard let pointer = buffer.data, buffer.size > 0, buffer.size <= UInt64(Int.max) else { throw CoreError.invalidResponse }
    return try JSONDecoder().decode(JSONValue.self, from: Data(bytes: pointer, count: Int(buffer.size)))
}

public actor Workspace {
    private let handle: CoreHandle
    private let contractRevisions: [String: String]
    public nonisolated let url: URL
    public nonisolated let scopeKind: ContentScope
    public nonisolated let taskID: String?
    public let mode: EntryMode

    public static func open(at url: URL, mode: EntryMode, title: String? = nil, locale: String = "zh-CN", operationKey: String? = nil, authorizationURL: URL? = nil, taskID: String? = nil) async throws -> Workspace {
        var config: [String: JSONValue] = ["workspace_path": .string(url.path), "mode": .string(mode.rawValue)]
        if let authorizationURL { config["authorization_path"] = .string(authorizationURL.path) }
        if let taskID { config["task_id"] = .string(taskID) }
        if let title {
            guard let operationKey, !operationKey.isEmpty else { throw CoreError.invalidResponse }
            config["create"] = .object(["title": .string(title), "locale": .string(locale), "operation_key": .string(operationKey)])
        }
        let prepared = config
        return try await Task.detached { try Workspace(at: url, scopeKind: .workspace, taskID: taskID, mode: mode, config: prepared) }.value
    }

    public static func openCreationProject(at url: URL, mode: EntryMode = .author, brief: String? = nil, locale: String = "zh-CN", operationKey: String? = nil, authorizationURL: URL? = nil, taskID: String? = nil) async throws -> Workspace {
        var config: [String: JSONValue] = ["creation_project_path": .string(url.path), "mode": .string(mode.rawValue)]
        if let authorizationURL { config["authorization_path"] = .string(authorizationURL.path) }
        if let taskID { config["task_id"] = .string(taskID) }
        if let brief {
            guard let operationKey, !operationKey.isEmpty else { throw CoreError.invalidResponse }
            config["create_project"] = .object(["brief": .string(brief), "locale": .string(locale), "operation_key": .string(operationKey)])
        }
        let prepared = config
        return try await Task.detached { try Workspace(at: url, scopeKind: .creationProject, taskID: taskID, mode: mode, config: prepared) }.value
    }

    private init(at url: URL, scopeKind: ContentScope, taskID: String?, mode: EntryMode, config: [String: JSONValue]) throws {
        guard hetu_abi_version() == 1 else { throw CoreError.boundary(-3) }
        let bytes = try JSONValue.object(config).encoded()
        var pointer: OpaquePointer?
        var buffer = HetuBuffer(data: nil, size: 0)
        let code = bytes.withUnsafeBytes { raw in
            hetu_context_open(raw.bindMemory(to: UInt8.self).baseAddress, UInt64(raw.count), &pointer, &buffer)
        }
        do { _ = try consume(&buffer, code: code).requiringSuccess() }
        catch { if let pointer { hetu_context_close(pointer) }; throw error }
        guard let pointer else { throw CoreError.invalidResponse }
        let coreHandle = CoreHandle(pointer)
        self.handle = coreHandle
        self.url = url
        self.scopeKind = scopeKind
        self.taskID = taskID
        self.mode = mode
        let discovery = try JSONValue.object(["action": .string("hetu.capabilities.get"), "contract_revision": .string("1"), "input": .object([:])]).encoded()
        let catalog = try coreHandle.request(discovery).requiringSuccess()
        self.contractRevisions = Dictionary(uniqueKeysWithValues: catalog["actions"].array.compactMap { item in
            guard let name = item["name"].string, let revision = item["contract_revision"].string else { return nil }
            return (name, revision)
        })
    }
    public func request(_ action: String, input: [String: JSONValue] = [:]) throws -> JSONValue {
        let bytes = try JSONValue.object(["action": .string(action), "contract_revision": .string(contractRevisions[action] ?? "1"), "input": .object(input)]).encoded()
        return try handle.request(bytes)
    }
    public func data(_ action: String, input: [String: JSONValue] = [:], allowPartial: Bool = false) throws -> JSONValue {
        let result = try request(action, input: input)
        if allowPartial, result["status"].string == "partial" { return result["data"] }
        // 准备快照只返回待作者审阅的数据；其他 pending 结果不能当作成功。
        if action == "hetu.git.snapshot", input["phase"]?.string == "prepare", result["status"].string == "pending" { return result["data"] }
        return try result.requiringSuccess()
    }
}
