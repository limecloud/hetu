import Foundation
import Observation
import HetuCore

/// 图片库和对象页使用同一固定候选，关联是展示信息，不表示作者已选用。
public struct ArtworkItem: Identifiable, Sendable {
    public let taskRef: JSONValue
    public let submissionID: String
    public let taskKind: String
    public let candidate: JSONValue
    public let preview: JSONValue
    public let provenance: JSONValue
    public let receivedAt: String
    public var id: String { candidate["candidate_id"].string ?? "" }
    public var category: String { taskKind == "cover" ? "cover" : candidate["image_category"].string ?? "other" }
    public func matches(entity: String? = nil, document: String? = nil) -> Bool {
        candidate["subject_refs"].array.contains { ref in
            (entity != nil && ref["kind"].string == "entity" && ref["entity_ref"].string == entity)
                || (document != nil && ref["kind"].string == "document" && ref["document_id"].string == document)
        }
    }
    public static func latest(_ view: JSONValue) -> [ArtworkItem] {
        let kind = view["request"]["task_kind"].string ?? ""
        guard ["cover", "artwork"].contains(kind) else { return [] }
        let ref: JSONValue = .object(["scope_ref": view["request"]["scope_ref"], "task_id": view["request"]["task_id"], "request_revision": view["request"]["request_revision"]])
        return view["submission"]["candidates"].array.filter { $0["kind"].string == "image" }.map { candidate in
            ArtworkItem(taskRef: ref, submissionID: view["submission"]["submission_id"].string ?? "", taskKind: kind, candidate: candidate,
                preview: view["image_previews"].array.first { $0["candidate_id"] == candidate["candidate_id"] } ?? .null,
                provenance: view["submission"]["provenance"], receivedAt: view["submission"]["received_at"].string ?? "")
        }
    }
}

@MainActor @Observable public final class ArtworkLibrarySession {
    public private(set) var items: [ArtworkItem] = []
    public private(set) var error: String?
    public private(set) var loading = false
    public private(set) var nextCursor: String?
    private var generation = UUID()
    private var scopeID = ""
    public init() {}
    public func load(model: WorkspaceModel, more: Bool = false) async {
        let token = UUID(); generation = token
        let scope = model.workspaceID
        if scopeID != scope || !more { items = []; nextCursor = nil }; scopeID = scope
        guard let workspace = model.workspace else { return }
        loading = true; error = nil
        defer { if generation == token { loading = false } }
        var pageCursor = nextCursor
        var found: [ArtworkItem] = []
        do {
            // 跳过文字任务页，最多取得一页图片；其余通过“加载更多”继续。
            repeat {
                var input: [String: JSONValue] = ["limit": .integer(20)]
                if let pageCursor { input["cursor"] = .string(pageCursor) }
                let page = try await workspace.data("hetu.creative_tasks.list", input: input)
                guard generation == token, model.workspaceID == scope else { return }
                for row in page["tasks"].array where ["cover", "artwork"].contains(row["task_kind"].string ?? "") && (row["submission_count"].integer ?? 0) > 0 {
                    let view = try await workspace.data("hetu.interactions.get", input: ["task_ref": row["task_ref"]])
                    guard generation == token, model.workspaceID == scope else { return }
                    found += ArtworkItem.latest(view)
                }
                pageCursor = page["next_cursor"].string
            } while found.isEmpty && pageCursor != nil
            guard generation == token, model.workspaceID == scope else { return }
            items += found.filter { item in !items.contains { $0.id == item.id } }
            items.sort { $0.receivedAt > $1.receivedAt }
            nextCursor = pageCursor
        } catch {
            guard generation == token, model.workspaceID == scope else { return }
            self.error = model.localizer.error(error)
        }
    }
}
