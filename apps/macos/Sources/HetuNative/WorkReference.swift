import Foundation
import HetuCore

/// 创作库定位具体对象；同一个目录中的不同对象不共享登记身份。
public struct WorkReference: Codable, Hashable, Sendable, Identifiable {
    public let workspaceID: String
    public let kind: String
    public let objectID: String
    public var id: String { workspaceID + "/" + kind + "/" + objectID }
    public var value: JSONValue { .object(["workspace_id": .string(workspaceID), "kind": .string(kind), "object_id": .string(objectID)]) }
    public init(_ value: JSONValue) throws {
        guard let workspaceID = value["workspace_id"].string,
              let kind = value["kind"].string, let objectID = value["object_id"].string,
              Self.validID(workspaceID, prefix: "workspace"),
              ["novel", "drama", "video"].contains(kind), Self.validID(objectID, prefix: kind) else { throw LibraryStore.LibraryError.invalidRecord }
        self.workspaceID = workspaceID; self.kind = kind; self.objectID = objectID
    }
    public var isValid: Bool {
        Self.validID(workspaceID, prefix: "workspace") && ["novel", "drama", "video"].contains(kind) && Self.validID(objectID, prefix: kind)
    }
    private static func validID(_ value: String, prefix: String) -> Bool {
        value.hasPrefix(prefix + "_") && UUID(uuidString: String(value.dropFirst(prefix.count + 1))) != nil
    }
}

public enum WorkCatalog {
    /// 分页读取内核投影，不按目录名、标题或作品类型配置猜身份。
    public static func list(in workspace: Workspace, includeArchived: Bool = false) async throws -> [JSONValue] {
        var works: [JSONValue] = [], cursor: String?, visited = Set<String>()
        repeat {
            var input: [String: JSONValue] = ["limit": .integer(100), "include_archived": .bool(includeArchived)]
            if let cursor { input["cursor"] = .string(cursor) }
            let page = try await workspace.data("hetu.works.list", input: input)
            works += page["works"].array
            cursor = page["next_cursor"].string
            if let cursor, !visited.insert(cursor).inserted { throw CoreError.invalidResponse }
        } while cursor != nil
        return works
    }
}
