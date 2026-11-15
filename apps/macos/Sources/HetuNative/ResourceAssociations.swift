import Foundation
import Observation
import HetuCore

public struct ResourceEntityOption: Identifiable, Sendable {
    public let kind: String
    public let title: String
    public let reference: JSONValue
    public var id: String { kind + ":" + (reference["entity_id"].string ?? "") }

    public static func options(in snapshot: JSONValue, includeArchived: Bool = false) -> [Self] {
        let fields = [("character", "characters", "character_id", "name"), ("location", "locations", "location_id", "name"),
                      ("faction", "factions", "faction_id", "name"), ("event", "timeline", "event_id", "title"), ("world", "world", "entry_id", "title")]
        return fields.flatMap { kind, collection, idField, titleField in
            snapshot["blueprint"][collection].array.compactMap { entity -> Self? in
                guard includeArchived || entity["archived"].bool != true,
                      let id = entity[idField].string, let title = entity[titleField].string else { return nil }
                return Self(kind: kind, title: title, reference: .object([
                    "kind": .string(kind), "entity_id": .string(id), "blueprint_revision": snapshot["revision"], "blueprint_sha256": snapshot["sha256"]
                ]))
            }
        }
    }

}

/// 只读取关联目录与固定设定修订，不持有或修改作者正文。
@Observable @MainActor public final class ResourceAssociations {
    public private(set) var projects: [JSONValue] = []
    public private(set) var options: [ResourceEntityOption] = []
    public private(set) var snapshots: [String: JSONValue] = [:]
    public private(set) var cursor: String?
    public private(set) var loading = false
    public private(set) var error: String?
    private var scopeID = ""
    private var generation = UUID()
    private var pendingRequest: JSONValue = .null
    public init() {}

    public func load(model: WorkspaceModel, projectID: String? = nil, references: [JSONValue] = [], more: Bool = false) async {
        guard let workspace = model.workspace else { return }
        let scope = model.currentWorkID + "\n" + workspace.url.standardizedFileURL.path
        if scopeID != scope { projects = []; options = []; snapshots = [:]; cursor = nil; scopeID = scope }
        if more && cursor == nil { return }
        let request: JSONValue = .object(["scope": .string(scope), "project_id": projectID.map(JSONValue.string) ?? .null,
            "references": .array(references), "cursor": more ? cursor.map(JSONValue.string) ?? .null : .null])
        if loading && pendingRequest == request { return }
        pendingRequest = request
        let token = UUID(); generation = token
        let workID = model.currentWorkID
        func isCurrent() -> Bool {
            generation == token && model.currentWorkID == workID && model.workspace?.url.standardizedFileURL.path == workspace.url.standardizedFileURL.path
        }
        loading = true; defer { if generation == token { loading = false; pendingRequest = .null } }
        error = nil
        do {
            let current = try await workspace.data("hetu.blueprints.get", input: model.bibleInput())
            guard isCurrent() else { return }
            var fixedSnapshots = snapshots
            if let sha = current["sha256"].string { fixedSnapshots[sha] = current }
            var input: [String: JSONValue] = ["include_archived": .bool(true), "limit": .integer(200)]
            if more, let cursor { input["cursor"] = .string(cursor) }
            let page = try await workspace.data("hetu.drama.projects.list", input: input)
            guard isCurrent() else { return }
            var listed = more ? projects + page["projects"].array : page["projects"].array
            if let projectID, !projectID.isEmpty, !listed.contains(where: { $0["project"]["project_id"].string == projectID }) {
                listed.append(try await workspace.data("hetu.drama.projects.get", input: ["project_id": .string(projectID)]))
            }
            guard isCurrent() else { return }
            for reference in references {
                guard let revision = reference["blueprint_revision"].integer, let sha = reference["blueprint_sha256"].string else { throw AssociationError.invalidReference }
                if fixedSnapshots[sha] == nil {
                    let fixed = try await workspace.data("hetu.blueprints.get", input: ["revision": .integer(revision), "sha256": .string(sha)])
                    guard isCurrent() else { return }
                    fixedSnapshots[sha] = fixed
                }
                guard fixedSnapshots[sha]?["revision"].integer == revision, fixedSnapshots[sha]?["sha256"].string == sha else { throw AssociationError.invalidReference }
            }
            guard isCurrent() else { return }
            var seen: Set<String> = []
            projects = listed.filter { seen.insert($0["project"]["project_id"].string ?? "").inserted }
            cursor = page["next_cursor"].string
            snapshots = fixedSnapshots
            options = ResourceEntityOption.options(in: current)
        } catch { if isCurrent() { self.error = model.localizer.error(error) } }
    }

    public func title(for reference: JSONValue) -> String? {
        guard let snapshot = snapshot(for: reference) else { return nil }
        return ResourceEntityOption.options(in: snapshot, includeArchived: true).first {
            $0.reference["kind"] == reference["kind"] && $0.reference["entity_id"] == reference["entity_id"]
        }?.title
    }

    /// 同一人物跨修订可改名；不同作品中相同的实体编号不能合并。
    public func sameEntity(_ lhs: JSONValue, _ rhs: JSONValue) -> Bool {
        guard lhs["kind"] == rhs["kind"], lhs["entity_id"] == rhs["entity_id"],
              let left = snapshot(for: lhs), let right = snapshot(for: rhs) else { return false }
        return left["blueprint"]["blueprint_id"] == right["blueprint"]["blueprint_id"]
    }

    private func snapshot(for reference: JSONValue) -> JSONValue? {
        guard let revision = reference["blueprint_revision"].integer, let sha = reference["blueprint_sha256"].string,
              let snapshot = snapshots[sha], snapshot["revision"].integer == revision, snapshot["sha256"].string == sha else { return nil }
        return snapshot
    }

    private enum AssociationError: Error { case invalidReference }
}
