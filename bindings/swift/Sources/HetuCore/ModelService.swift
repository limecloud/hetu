import CHetu
import Foundation

/// 供可信本机设置入口使用；CLI 只开放状态和登录交接，网络和凭据存储由共享 Core 处理。
public struct ModelServiceClient: Sendable {
    public init() {}
    public func request(_ action: String, input: [String: JSONValue] = [:]) async throws -> JSONValue {
        let bytes = try JSONValue.object(["action": .string(action), "input": .object(input)]).encoded()
        return try await Task.detached {
            var buffer = HetuBuffer(data: nil, size: 0)
            defer { hetu_buffer_free(&buffer) }
            let code = bytes.withUnsafeBytes { raw in
                hetu_model_service_request(raw.bindMemory(to: UInt8.self).baseAddress, UInt64(raw.count), &buffer)
            }
            guard code == 0 else { throw CoreError.boundary(code) }
            guard let data = buffer.data, buffer.size > 0, buffer.size <= 1024 * 1024 else { throw CoreError.invalidResponse }
            let result = try JSONDecoder().decode(JSONValue.self, from: Data(bytes: data, count: Int(buffer.size)))
            guard result["status"].string == "succeeded" else { throw CoreError.business(result) }
            return result["data"]
        }.value
    }
}
