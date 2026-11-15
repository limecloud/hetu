import Foundation
import HetuCore

/// 只提供连接状态和浏览器登录交接；不开放密钥设置或模型费用批准。
enum ModelServiceCommand {
    static func run(_ arguments: [String]) async throws -> JSONValue {
        guard arguments.count == 1, ["status", "login", "poll"].contains(arguments[0]) else {
            throw HetuCLI.CLIError.input
        }
        let client = ModelServiceClient()
        let data: JSONValue
        switch arguments[0] {
        case "login":
            data = try await client.request("connect")
        case "poll":
            let current = try await client.request("inspect")
            if current["pending"]["verification_uri"].string == nil {
                // 没有待验证连接时直接回读状态，不重复登录或创建连接。
                data = current
            } else {
                let polled = try await client.request("poll")
                data = polled["status"].string == "pending" ? current : polled
            }
        default:
            data = try await client.request("inspect")
        }
        var visible: [String: JSONValue] = [:]
        for key in ["connected", "origin", "account_ref", "expires_at"] {
            visible[key] = data[key]
        }
        if let uri = data["pending"]["verification_uri"].string {
            visible["pending"] = .object([
                "verification_uri": .string(uri),
                "verification_code": data["pending"]["verification_code"],
            ])
        }
        let expired = data["expires_at"].integer.map { Double($0) <= Date().timeIntervalSince1970 } ?? false
        let state = visible["pending"] != nil ? "pending" : data["connected"].bool == true ? "connected" : expired ? "expired" : "disconnected"
        visible["connection_state"] = .string(state)
        if state != "connected" {
            visible["next_action"] = .string("hetu model-service " + (state == "pending" ? "poll" : "login"))
        }
        return .object([
            "spec_version": .string("0.2.1"), "kind": .string("result"),
            "action": .string("hetu.model_service.settings"), "contract_revision": .string("1"),
            "status": .string("succeeded"), "context": .object(["scope_id": .string("local")]),
            "data": .object(visible),
        ])
    }
}
