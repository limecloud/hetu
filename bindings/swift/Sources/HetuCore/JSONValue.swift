import Foundation

public enum JSONValue: Codable, Sendable, Equatable {
    case object([String: JSONValue]), array([JSONValue]), string(String), integer(Int64), number(Double), bool(Bool), null

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let v = try? value.decode(Bool.self) { self = .bool(v) }
        else if let v = try? value.decode(Int64.self) { self = .integer(v) }
        else if let v = try? value.decode(Double.self) { self = .number(v) }
        else if let v = try? value.decode(String.self) { self = .string(v) }
        else if let v = try? value.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try value.decode([String: JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .object(let v): try value.encode(v)
        case .array(let v): try value.encode(v)
        case .string(let v): try value.encode(v)
        case .integer(let v): try value.encode(v)
        case .number(let v): try value.encode(v)
        case .bool(let v): try value.encode(v)
        case .null: try value.encodeNil()
        }
    }
    public subscript(_ key: String) -> JSONValue {
        if case .object(let fields) = self { fields[key] ?? .null } else { .null }
    }
    public var string: String? { if case .string(let value) = self { value } else { nil } }
    public var integer: Int64? { if case .integer(let value) = self { value } else { nil } }
    public var bool: Bool? { if case .bool(let value) = self { value } else { nil } }
    public var array: [JSONValue] { if case .array(let value) = self { value } else { [] } }
    public var object: [String: JSONValue] { if case .object(let value) = self { value } else { [:] } }
    public func encoded(pretty: Bool = false) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = pretty ? [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes] : [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }
    public func requiringSuccess() throws -> JSONValue {
        guard self["status"].string == "succeeded" else { throw CoreError.business(self) }
        return self["data"]
    }
}
public enum CoreError: Error, LocalizedError, Sendable {
    case boundary(Int32), invalidResponse, business(JSONValue)
    public var errorDescription: String? {
        switch self {
        case .boundary(let code): "内核调用失败（\(code)）。"
        case .invalidResponse: "内核返回的数据无效。"
        case .business(let result): result["error"]["message"].string ?? "操作未完成。"
        }
    }
}
