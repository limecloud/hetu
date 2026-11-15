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
    public var imageView: String? { candidate["image_view"].string }
    public var coverReference: JSONValue {
        .object(["task_ref": taskRef, "submission_id": .string(submissionID), "candidate_id": candidate["candidate_id"]])
    }
    public func isCurrentCover(_ cover: JSONValue) -> Bool {
        taskKind == "cover" && cover["cover"]["source_ref"]["kind"].string == "creative_task"
            && cover["cover"]["source_ref"]["reference"] == coverReference
    }
    /// 角色封面只用单人形象，三视图和情节插图留在各自图组中。
    public static func primaryImage(in items: [ArtworkItem], entity: String, category: String) -> ArtworkItem? {
        items.filter { item in
            item.category == category && item.matches(entity: entity)
                && (category != "character" || item.imageView == nil || ["portrait", "front"].contains(item.imageView ?? ""))
        }.sorted { a, b in
            func rank(_ item: ArtworkItem) -> Int { item.imageView == "portrait" ? 0 : item.imageView == "front" ? 1 : 2 }
            return rank(a) == rank(b) ? a.receivedAt > b.receivedAt : rank(a) < rank(b)
        }.first
    }
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
    public func reset() {
        generation = UUID(); scopeID = ""; items = []; nextCursor = nil; error = nil; loading = false
    }
    public func load(model: WorkspaceModel, more: Bool = false) async {
        guard let workspace = model.workspace else { reset(); return }
        let scope = model.currentWorkID + "\n" + workspace.url.standardizedFileURL.path
        // 多个对象页共用一份读取，切换角色和关闭详情不清空已有缩略图。
        if scopeID == scope && loading { return }
        if scopeID != scope { reset(); scopeID = scope }
        if more && nextCursor == nil { return }
        let token = UUID(); generation = token
        let workspaceID = model.workspaceID
        let workID = model.currentWorkID
        loading = true; error = nil
        defer { if generation == token { loading = false } }
        var pageCursor = more ? nextCursor : nil
        var found: [ArtworkItem] = []
        do {
            // 跳过文字任务页，最多取得一页图片；其余通过“加载更多”继续。
            repeat {
                var input: [String: JSONValue] = ["limit": .integer(20)]
                if let reference = model.workReference { input["work_ref"] = reference.value }
                if let pageCursor { input["cursor"] = .string(pageCursor) }
                let page = try await workspace.data("hetu.creative_tasks.list", input: input)
                guard generation == token, model.workspaceID == workspaceID, model.currentWorkID == workID else { return }
                for row in page["tasks"].array where ["cover", "artwork"].contains(row["task_kind"].string ?? "") && (row["submission_count"].integer ?? 0) > 0 {
                    let view = try await workspace.data("hetu.interactions.get", input: ["task_ref": row["task_ref"]])
                    guard generation == token, model.workspaceID == workspaceID, model.currentWorkID == workID else { return }
                    found += ArtworkItem.latest(view)
                }
                pageCursor = page["next_cursor"].string
            } while found.isEmpty && pageCursor != nil
            guard generation == token, model.workspaceID == workspaceID, model.currentWorkID == workID else { return }
            if !more { items = [] }
            items += found.filter { item in !items.contains { $0.id == item.id } }
            items.sort { $0.receivedAt > $1.receivedAt }
            nextCursor = pageCursor
        } catch {
            guard generation == token, model.workspaceID == workspaceID, model.currentWorkID == workID else { return }
            items = []; nextCursor = nil
            self.error = model.localizer.error(error)
        }
    }
}
