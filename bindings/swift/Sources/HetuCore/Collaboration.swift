import CHetu
import Foundation

/// 稳定连接配置只固定客户端；每项业务显式携带任务引用。
public struct CollaborationClient: Sendable {
    public let clientAdapter: String
    public let directory: URL?
    public init(clientAdapter: String, directory: URL? = nil) {
        self.clientAdapter = clientAdapter; self.directory = directory
    }
    public func request(_ action: String, input: [String: JSONValue] = [:]) async throws -> JSONValue {
        var config: [String: JSONValue] = ["client_adapter": .string(clientAdapter),
            "request": .object(["action": .string(action), "contract_revision": .string("1"), "input": .object(input)])]
        if let directory { config["directory"] = .string(directory.path) }
        let bytes = try JSONValue.object(config).encoded()
        return try await Task.detached {
            var buffer = HetuBuffer(data: nil, size: 0)
            defer { hetu_buffer_free(&buffer) }
            let code = bytes.withUnsafeBytes { raw in
                hetu_collaboration_request(raw.bindMemory(to: UInt8.self).baseAddress, UInt64(raw.count), &buffer)
            }
            guard code == 0 else { throw CoreError.boundary(code) }
            guard let data = buffer.data, buffer.size > 0, buffer.size <= 16 * 1024 * 1024 else { throw CoreError.invalidResponse }
            return try JSONDecoder().decode(JSONValue.self, from: Data(bytes: data, count: Int(buffer.size)))
        }.value
    }
}
