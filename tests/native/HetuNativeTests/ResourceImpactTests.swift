import Foundation
import HetuCore
import HetuNative

enum ResourceImpactTests {
    struct Failure: Error { let message: String }
    static func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure(message: message) }
    }
    @MainActor static func run(root: URL) async throws {
        let preferencesName = "run.limeai.hetu.impact.\(UUID().uuidString)"
        let preferences = UserDefaults(suiteName: preferencesName)!
        preferences.set(false, forKey: "Hetu.editor.autosave")
        defer { preferences.removePersistentDomain(forName: preferencesName) }
        let model = WorkspaceModel(recovery: RecoveryStore(directory: root.appendingPathComponent("影响核对恢复")), preferences: preferences,
            library: LibraryStore(directory: root.appendingPathComponent("影响核对书库")))
        try require(await model.open(root.appendingPathComponent("影响核对作品"), title: "渡口旧衣"), "无法创建影响核对作品")
        guard let documentID = await model.createDocument(title: "第一章", kind: "novel_chapter"), let workspace = model.workspace else {
            throw Failure(message: "无法创建影响核对章节")
        }
        try require(await model.selectDocument(documentID), "无法打开影响核对章节")
        let original = "渡口🌿\r\n她穿着父亲留下的灰色旧外套。"
        model.edit(original)
        try require(await model.save(), "无法保存关联时的正文")
        let document = try await workspace.data("hetu.documents.get", input: ["document_id": .string(documentID)])
        let fields: [String: JSONValue] = ["title": .string("父亲的旧外套"), "category": .string("prop"), "body": .string("灰色立领，右袖破损。"),
            "tags": .array([]), "project_id": .null, "entity_refs": .array([]), "source_notes": .string("作者设定")]
        var create = fields; create["operation_key"] = .string("impact-resource")
        let resource = try await workspace.data("hetu.resources.create", input: create)
        let resourceID = resource["resource"]["resource_id"]
        let reference: JSONValue = .object(["resource_id": resourceID, "revision": resource["resource"]["revision"], "sha256": resource["sha256"]])
        let source: JSONValue = .object(["document_id": .string(documentID), "revision_id": document["revision"]["revision_id"],
            "byte_start": .integer(0), "byte_end": .integer(Int64(original.utf8.count)), "quote": .string(original)])
        _ = try await workspace.data("hetu.resource_usages.save", input: ["resource_ref": reference, "target_ref": source, "role": .string("衣着连续性"), "archived": .bool(false), "operation_key": .string("impact-link")])
        func usages() async throws -> [JSONValue] {
            try await workspace.data("hetu.resource_usages.list", input: ["resource_id": resourceID])["usages"].array
        }
        let initial = try await usages()
        try require(ResourceImpactSummary(entries: initial, hasMore: false).reviewCount == 0, "未变的固定引用被当成待核对")
        var update = fields
        update["resource_id"] = resourceID; update["body"] = .string("灰色立领，左袖破损。")
        update["expected"] = .object(["revision": resource["resource"]["revision"], "sha256": resource["sha256"]])
        update["operation_key"] = .string("impact-resource-update")
        let latest = try await workspace.data("hetu.resources.update", input: update)
        let resourceChanged = try await usages()
        let changed = ResourceUsageImpact(resourceChanged[0])
        try require(changed.resourceChanged && !changed.sourceChanged && changed.needsReview, "资料变化和正文变化未区分")
        let session = ResourceImpactSession()
        await session.load(model: model, impact: changed)
        try require(session.ready && session.error == nil && session.fixedResource["resource"] == resource["resource"] && session.currentResource["resource"] == latest["resource"], "比较没有分别固定旧资料与读取新版")
        try require(session.fixedDocument == session.currentDocument && session.fixedDocument["content"].string == original, "只改资料却改动了正文")

        model.edit("新的已保存正文。\n" + original)
        try require(await model.save(), "无法保存新正文")
        let savedRevision = model.baseRevisionID
        model.edit("作者仍在修改，不能被比较覆盖。")
        let buffer = model.text
        let bothChanged = try await usages()
        let both = ResourceUsageImpact(bothChanged[0])
        try require(both.sourceChanged && both.resourceChanged, "正文更新后没有保留两种独立变化")
        await session.load(model: model, impact: both)
        try require(session.ready && session.fixedDocument["content"].string == original && session.currentDocument["content"].string == "新的已保存正文。\n" + original, "比较读到了未保存缓冲或套用了旧稿")
        try require(model.text == buffer && model.dirty && model.baseRevisionID == savedRevision, "核对变化覆盖或保存了作者缓冲")
        let after = try await usages()
        try require(after == bothChanged, "核对变化改写了历史关联或标成已确认")

        var archivedEntry = both.entry.object
        var archivedUsage = both.usage.object; archivedUsage["archived"] = .bool(true)
        archivedEntry["usage"] = .object(archivedUsage)
        let summary = ResourceImpactSummary(entries: initial + bothChanged + [.object(archivedEntry)], hasMore: true)
        try require(summary.hasMore && summary.usages.count == 2 && summary.reviewCount == 1 && summary.visible(needsReviewOnly: true).count == 1, "分页摘要把未加载或已归档使用计入待核对")

        var invalidUsage = both.usage.object
        var invalidRef = reference.object; invalidRef["sha256"] = .string(String(repeating: "0", count: 64))
        invalidUsage["resource_ref"] = .object(invalidRef)
        await session.load(model: model, impact: ResourceUsageImpact(.object(["usage": .object(invalidUsage)])))
        try require(!session.ready && session.error != nil && session.fixedDocument == .null, "错误固定摘要仍显示成功或上一轮比较")
        var invalidSource = source.object; invalidSource["quote"] = .string("不存在的原句")
        invalidUsage = both.usage.object; invalidUsage["target_ref"] = .object(invalidSource)
        await session.load(model: model, impact: ResourceUsageImpact(.object(["usage": .object(invalidUsage)])))
        try require(!session.ready && session.error != nil && model.text == buffer, "无效原文引用没有拒绝或影响作者缓冲")
        invalidSource = source.object; invalidSource["byte_start"] = .integer(7); invalidSource["byte_end"] = .integer(10); invalidSource["quote"] = .string("🌿")
        invalidUsage["target_ref"] = .object(invalidSource)
        await session.load(model: model, impact: ResourceUsageImpact(.object(["usage": .object(invalidUsage)])))
        try require(!session.ready && session.error != nil, "接受了 Emoji 内部的无效字节坐标")
        invalidSource = source.object; invalidSource["byte_start"] = .integer(6); invalidSource["byte_end"] = .integer(6); invalidSource["quote"] = .string("")
        invalidUsage["target_ref"] = .object(invalidSource)
        await session.load(model: model, impact: ResourceUsageImpact(.object(["usage": .object(invalidUsage)])))
        try require(session.ready && session.error == nil, "合法的空引用锚点无法核对")
        print("资料影响核对：两类版本变化、固定快照、Unicode 原文、分页边界、归档过滤、错误引用及未保存稿保护通过")
    }
}
