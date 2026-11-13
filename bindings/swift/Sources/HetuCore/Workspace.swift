import CHetu
import Foundation

public enum EntryMode: String, Sendable { case author, agent }

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
    public let mode: EntryMode

    public static func open(at url: URL, mode: EntryMode, title: String? = nil, locale: String = "zh-CN", operationKey: String? = nil, authorizationURL: URL? = nil) async throws -> Workspace {
        try await Task.detached { try Workspace(at: url, mode: mode, title: title, locale: locale, operationKey: operationKey, authorizationURL: authorizationURL) }.value
    }
    private init(at url: URL, mode: EntryMode, title: String?, locale: String, operationKey: String?, authorizationURL: URL?) throws {
        guard hetu_abi_version() == 1 else { throw CoreError.boundary(-3) }
        var config: [String: JSONValue] = ["workspace_path": .string(url.path), "mode": .string(mode.rawValue)]
        if let authorizationURL { config["authorization_path"] = .string(authorizationURL.path) }
        if let title {
            guard let operationKey, !operationKey.isEmpty else { throw CoreError.invalidResponse }
            config["create"] = .object(["title": .string(title), "locale": .string(locale), "operation_key": .string(operationKey)])
        }
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
