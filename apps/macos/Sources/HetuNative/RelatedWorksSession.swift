import Foundation
import Observation
import HetuCore

/// 列表读取关系投影，详情才读取获权的固定资料；不把“打开新版”当作更新依据。
public struct RelatedWork: Identifiable, Sendable {
    public let value: JSONValue
    public let id: String
    public let reference: WorkReference
    public let fixedReference: JSONValue
    public var title: String? { value["related_title"].string }
    public var archived: Bool { value["link"]["archived"].bool == true }
    public init(_ value: JSONValue) throws {
        guard let id = value["link"]["link_id"].string, id.hasPrefix("worklink_"),
              UUID(uuidString: String(id.dropFirst(9))) != nil,
              let revision = value["link"]["revision"].integer, revision > 0,
              ["incoming", "outgoing"].contains(value["direction"].string ?? ""),
              let sha = value["sha256"].string, sha.count == 64, sha.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
              ["available", "requires_authorization", "unavailable"].contains(value["related_status"].string ?? "") else { throw CoreError.invalidResponse }
        self.id = id; self.value = value
        fixedReference = value["link"][value["direction"].string == "incoming" ? "source_ref" : "target_ref"]
        reference = try WorkReference(fixedReference["work_ref"])
    }
}

@MainActor @Observable public final class RelatedWorksSession {
    public private(set) var items: [RelatedWork] = []
    public private(set) var detail: JSONValue = .null
    public private(set) var selectedID: String?
    public private(set) var nextCursor: String?
    public private(set) var loading = false
    public private(set) var detailLoading = false
    public private(set) var error: (any Error)?
    public private(set) var detailError: (any Error)?
    private var scopeID = ""
    private var generation = UUID()
    private var detailGeneration = UUID()
    private var cursors: Set<String> = []
    public init() {}
    public func reset() {
        generation = UUID(); detailGeneration = UUID(); scopeID = ""; cursors = []
        items = []; detail = .null; selectedID = nil; nextCursor = nil
        loading = false; detailLoading = false; error = nil; detailError = nil
    }
    public func back() {
        detailGeneration = UUID(); selectedID = nil; detail = .null; detailError = nil; detailLoading = false
    }
    public func load(in workspace: Workspace, reference: WorkReference, includeArchived: Bool = false, more: Bool = false) async {
        let scope = workspace.url.standardizedFileURL.path + "\n" + reference.id + "\n" + String(includeArchived)
        if scope != scopeID { reset(); scopeID = scope }
        guard !loading, !more || nextCursor != nil else { return }
        let token = UUID(); generation = token
        loading = true; error = nil
        defer { if generation == token { loading = false } }
        do {
            var input: [String: JSONValue] = ["work_ref": reference.value, "include_archived": .bool(includeArchived), "limit": .integer(50)]
            if more, let nextCursor { input["cursor"] = .string(nextCursor) }
            let page = try await workspace.data("hetu.work_links.list", input: input)
            guard generation == token else { return }
            let rows = try page["links"].array.map(RelatedWork.init)
            let cursor = page["next_cursor"].string
            if let cursor, more && cursors.contains(cursor) { throw CoreError.invalidResponse }
            if !more { cursors = [] }
            if let cursor { cursors.insert(cursor) }
            items = more ? items + rows.filter { row in !items.contains { $0.id == row.id } } : rows
            nextCursor = cursor
            if !more, let selectedID {
                let revision = detail["link"]["revision"].integer
                await select(selectedID, revision: revision, in: workspace, reference: reference)
            }
        } catch {
            guard generation == token else { return }
            self.error = error
        }
    }
    public func select(_ linkID: String, revision: Int64? = nil, in workspace: Workspace, reference: WorkReference) async {
        let token = UUID(); detailGeneration = token
        selectedID = linkID; detail = .null; detailError = nil; detailLoading = true
        defer { if detailGeneration == token { detailLoading = false } }
        do {
            var input: [String: JSONValue] = ["work_ref": reference.value, "link_id": .string(linkID)]
            if let revision { input["revision"] = .integer(revision) }
            let view = try await workspace.data("hetu.work_links.get", input: input)
            guard detailGeneration == token else { return }
            let row = try RelatedWork(view)
            guard row.id == linkID, revision == nil || view["link"]["revision"].integer == revision else { throw CoreError.invalidResponse }
            detail = view
        } catch {
            guard detailGeneration == token else { return }
            detailError = error
        }
    }
}
