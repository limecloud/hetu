import Foundation
import Observation
import HetuCore

/// 只呈现已登记使用位置的版本变化，不推断语义影响或改写历史关联。
public struct ResourceUsageImpact: Identifiable, Sendable {
    public let entry: JSONValue
    public init(_ entry: JSONValue) { self.entry = entry }
    public var id: String { entry["usage"]["usage_id"].string ?? "" }
    public var usage: JSONValue { entry["usage"] }
    public var archived: Bool { usage["archived"].bool == true }
    public var resourceChanged: Bool { entry["stale_resource"].bool == true }
    public var sourceChanged: Bool { entry["stale_source"].bool == true }
    public var needsReview: Bool { !archived && (resourceChanged || sourceChanged) }
}

public struct ResourceImpactSummary: Sendable {
    public let usages: [ResourceUsageImpact]
    public let hasMore: Bool
    public init(entries: [JSONValue], hasMore: Bool) {
        usages = entries.map(ResourceUsageImpact.init).filter { !$0.archived }
        self.hasMore = hasMore
    }
    public var reviewCount: Int { usages.filter(\.needsReview).count }
    public func visible(needsReviewOnly: Bool) -> [ResourceUsageImpact] {
        needsReviewOnly ? usages.filter(\.needsReview) : usages
    }
}

/// 比较只读快照；当前稿指本次读取的已保存修订，不复用旧引用坐标定位新稿。
@Observable @MainActor public final class ResourceImpactSession {
    public private(set) var fixedResource: JSONValue = .null
    public private(set) var currentResource: JSONValue = .null
    public private(set) var fixedDocument: JSONValue = .null
    public private(set) var currentDocument: JSONValue = .null
    public private(set) var loading = false
    public private(set) var error: String?
    public var ready: Bool { fixedResource != .null && currentResource != .null && fixedDocument != .null && currentDocument != .null }
    private var generation = UUID()
    public init() {}

    public func load(model: WorkspaceModel, impact: ResourceUsageImpact) async {
        let request = UUID()
        generation = request
        fixedResource = .null; currentResource = .null; fixedDocument = .null; currentDocument = .null
        error = nil
        guard let workspace = model.workspace else { loading = false; return }
        let scope = model.workspaceID
        let reference = impact.usage["resource_ref"]
        let source = impact.usage["target_ref"]
        loading = true
        defer { if generation == request { loading = false } }
        do {
            let fixed = try await workspace.data("hetu.resources.get", input: ["resource_id": reference["resource_id"], "revision": reference["revision"]])
            guard generation == request, model.workspaceID == scope else { return }
            guard fixed["sha256"] == reference["sha256"] else { error = model.t("resources.impact.invalid_reference"); return }
            let previousText = try await workspace.data("hetu.documents.get", input: ["document_id": source["document_id"], "revision_id": source["revision_id"]])
            guard generation == request, model.workspaceID == scope else { return }
            let bytes = Array((previousText["content"].string ?? "").utf8)
            guard let start = source["byte_start"].integer, let end = source["byte_end"].integer,
                  let byteStart = Int(exactly: start), let byteEnd = Int(exactly: end),
                  byteStart >= 0, byteEnd >= byteStart, byteEnd <= bytes.count,
                  String(bytes: bytes[..<byteStart], encoding: .utf8) != nil,
                  String(bytes: bytes[byteStart..<byteEnd], encoding: .utf8) == source["quote"].string else {
                error = model.t("error.hetu.invalid_source_ref"); return
            }
            let latest = try await workspace.data("hetu.resources.get", input: ["resource_id": reference["resource_id"]])
            guard generation == request, model.workspaceID == scope else { return }
            let currentText = try await workspace.data("hetu.documents.get", input: ["document_id": source["document_id"]])
            guard generation == request, model.workspaceID == scope else { return }
            fixedResource = fixed; currentResource = latest
            fixedDocument = previousText; currentDocument = currentText
        } catch { if generation == request, model.workspaceID == scope { self.error = model.localizer.error(error) } }
    }
}
