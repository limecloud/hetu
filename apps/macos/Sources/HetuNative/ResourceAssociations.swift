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

    public static func sameEntity(_ lhs: JSONValue, _ rhs: JSONValue) -> Bool {
        lhs["kind"] == rhs["kind"] && lhs["entity_id"] == rhs["entity_id"]
    }
}

/// 只读取关联目录与固定设定修订，不持有或修改作者正文。
@Observable @MainActor public final class ResourceAssociations {
    public private(set) var projects: [JSONValue] = []
    public private(set) var options: [ResourceEntityOption] = []
    public private(set) var snapshots: [Int64: JSONValue] = [:]
    public private(set) var cursor: String?
    public private(set) var loading = false
    public private(set) var error: String?
    private var workspaceID = ""
    public init() {}

    public func load(model: WorkspaceModel, projectID: String? = nil, references: [JSONValue] = [], more: Bool = false) async {
        guard !loading, let workspace = model.workspace else { return }
        let scope = model.workspaceID
        loading = true; defer { loading = false }
        if workspaceID != scope { projects = []; options = []; snapshots = [:]; cursor = nil; workspaceID = scope }
        error = nil
        do {
            let current = try await workspace.data("hetu.blueprints.get")
            guard model.workspaceID == scope else { return }
            snapshots[current["revision"].integer ?? 0] = current
            options = ResourceEntityOption.options(in: current)
            var input: [String: JSONValue] = ["include_archived": .bool(true), "limit": .integer(200)]
            if more, let cursor { input["cursor"] = .string(cursor) }
            let page = try await workspace.data("hetu.drama.projects.list", input: input)
            guard model.workspaceID == scope else { return }
            var listed = more ? projects + page["projects"].array : page["projects"].array
            if let projectID, !projectID.isEmpty, !listed.contains(where: { $0["project"]["project_id"].string == projectID }) {
                listed.append(try await workspace.data("hetu.drama.projects.get", input: ["project_id": .string(projectID)]))
            }
            guard model.workspaceID == scope else { return }
            var seen: Set<String> = []
            projects = listed.filter { seen.insert($0["project"]["project_id"].string ?? "").inserted }
            cursor = page["next_cursor"].string
            for reference in references {
                guard let revision = reference["blueprint_revision"].integer else { continue }
                if snapshots[revision] == nil {
                    let fixed = try await workspace.data("hetu.blueprints.get", input: ["revision": .integer(revision)])
                    guard model.workspaceID == scope else { return }
                    snapshots[revision] = fixed
                }
                guard snapshots[revision]?["sha256"] == reference["blueprint_sha256"] else { throw AssociationError.invalidReference }
            }
        } catch { if model.workspaceID == scope { self.error = model.localizer.error(error) } }
    }

    public func title(for reference: JSONValue) -> String? {
        guard let revision = reference["blueprint_revision"].integer, let snapshot = snapshots[revision], snapshot["sha256"] == reference["blueprint_sha256"] else { return nil }
        return ResourceEntityOption.options(in: snapshot, includeArchived: true).first { ResourceEntityOption.sameEntity($0.reference, reference) }?.title
    }

    private enum AssociationError: Error { case invalidReference }
}
