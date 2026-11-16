import Foundation
import HetuCore
import HetuNative

enum RelatedWorksTests {
    struct Failure: Error { let message: String }
    private static func check(_ value: Bool, _ message: String) throws { if !value { throw Failure(message: message) } }
    @MainActor static func run(root: URL) async throws {
        let workspace = try await Workspace.open(at: root.appendingPathComponent("关联版本"), mode: .author, title: "旧站原著", operationKey: "init")
        let works = try await WorkCatalog.list(in: workspace)
        let source = works[0]["fixed_ref"]
        let novelReference = try WorkReference(source["work_ref"])
        let drama = try await workspace.data("hetu.drama.projects.create", input: ["title": .string("旧站改编"), "operation_key": .string("drama")])
        let all = try await WorkCatalog.list(in: workspace)
        guard let target = all.first(where: { $0["work_ref"]["object_id"] == drama["project"]["project_id"] })?["fixed_ref"] else { throw Failure(message: "缺少剧本身份") }
        let reference = try WorkReference(target["work_ref"])
        let linked = try await workspace.data("hetu.work_links.create", input: ["source_ref": source, "target_ref": target, "relation": .string("adaptation"), "operation_key": .string("link")])
        let id = linked["link"]["link_id"].string!
        let session = RelatedWorksSession()
        await session.load(in: workspace, reference: reference)
        try check(session.error == nil && session.items.count == 1 && session.items[0].title == "旧站原著", "关联列表没有消费固定标题")
        await session.select(id, in: workspace, reference: reference)
        try check(session.detailError == nil && session.detail["related_work"]["summary"]["fixed_ref"] == source, "关联详情未读取固定原著版本")
        let handoff = try await workspace.data("hetu.handoffs.get", input: ["view_kind": .string("related_works"), "object_ref": .object(["work_ref": reference.value, "link_id": .string(id), "link_revision": .integer(1)])])
        try check(handoff["fixed_refs"].array.contains { $0["kind"].string == "work_link" && $0["sha256"] == linked["sha256"] }, "详情交接丢失关联身份和摘要")
        let novel = try await workspace.data("hetu.novels.get", input: [:])
        var metadata = novel["novel"]["metadata"].object
        metadata["title"] = .string("原著新版书名"); metadata["synopsis"] = .string("新版简介仍不会改写旧依据。")
        _ = try await workspace.data("hetu.novels.update", input: ["metadata": .object(metadata), "expected": .object(["revision": novel["revision"], "sha256": novel["sha256"]]), "operation_key": .string("rename")])
        await session.load(in: workspace, reference: reference)
        try check(session.items[0].title == "旧站原著" && session.detail["related_title"].string == "旧站原著" && session.detail["related_has_newer_revision"].bool == true, "来源更新被当成旧关联自动更新")
        let updated = try await workspace.data("hetu.works.get", input: ["work_ref": source["work_ref"]])
        let next = try await workspace.data("hetu.work_links.update_source", input: ["work_ref": reference.value, "link_ref": .object(["link_id": .string(id), "revision": .integer(1), "sha256": linked["sha256"]]), "source_ref": updated["summary"]["fixed_ref"], "target_ref": target, "operation_key": .string("advance")])
        await session.load(in: workspace, reference: reference)
        try check(session.detail["link"]["revision"].integer == 1 && session.detail["current_link_ref"]["revision"].integer == 2, "刷新抢走了正在阅读的旧关联版本")
        await session.select(id, in: workspace, reference: reference)
        try check(session.detail["related_title"].string == "原著新版书名" && session.detail["related_work"]["record"]["metadata"]["synopsis"].string == "新版简介仍不会改写旧依据。", "当前关联没有按显式更新显示固定资料")
        session.back()
        try check(session.selectedID == nil && session.detail == .null && session.items.count == 1, "返回关联列表丢失列表或留下详情")
        _ = try await workspace.data("hetu.work_links.set_archived", input: ["work_ref": reference.value, "link_ref": .object(["link_id": .string(id), "revision": .integer(2), "sha256": next["sha256"]]), "archived": .bool(true), "operation_key": .string("remove")])
        await session.load(in: workspace, reference: reference)
        try check(session.items.isEmpty && session.error == nil, "默认列表仍显示已解除关联")
        await session.load(in: workspace, reference: reference, includeArchived: true)
        try check(session.items.count == 1 && session.items[0].archived, "已解除关联无法按需查看")
        await session.select(id, revision: 1, in: workspace, reference: reference)
        try check(session.detail["sha256"] == linked["sha256"] && session.detail["link"]["archived"].bool == false, "已解除关联覆盖了旧状态")
        await session.load(in: workspace, reference: novelReference)
        try check(session.selectedID == nil && session.detail == .null, "切换对象留下上一作品的关联详情")
        await session.select("worklink_00000000-0000-4000-8000-000000000000", in: workspace, reference: novelReference)
        try check(session.detailError != nil && session.detail == .null, "读取失败仍呈现上一条关联详情")
        session.reset()
        try check(session.error == nil && session.detailError == nil && session.items.isEmpty, "重置没有清理关联读取状态")
        try await navigation(root: root, workspace: workspace, source: novelReference, target: reference, linkID: id)
        print("关联作品：固定资料、列表与详情分层、历史阅读保持、解除筛选、准确交接、窗口连续往返和跨对象清理通过")
    }
    @MainActor private static func navigation(root: URL, workspace: Workspace, source: WorkReference, target: WorkReference, linkID: String) async throws {
        let domain = "run.limeai.hetu.related-navigation-tests.\(UUID().uuidString)"
        let preferences = UserDefaults(suiteName: domain)!
        defer { preferences.removePersistentDomain(forName: domain) }
        let model = WorkspaceModel(recovery: RecoveryStore(directory: root.appendingPathComponent("导航恢复")), preferences: preferences,
            library: LibraryStore(directory: root.appendingPathComponent("导航登记"), collaborationDirectory: root.appendingPathComponent("导航授权")))
        try check(await model.open(workspace.url, workReference: target), "导航无法打开确切目标对象")
        let targetSession = model.relatedWorksSession()
        await targetSession.load(in: model.workspace!, reference: target, includeArchived: true)
        await targetSession.select(linkID, revision: 1, in: model.workspace!, reference: target)
        let oldDetail = targetSession.detail
        try check(targetSession.selectedID == linkID && oldDetail["link"]["revision"].integer == 1, "未固定离开前的关联历史")
        try check(await model.openRelatedWork(source), "无法打开关联来源")
        try check(model.workReference == source && model.relatedReturnDestination?.reference == target, "返回入口丢失确切目标身份")
        try check(model.relatedWorksSession() !== targetSession && model.relatedWorksSession().detail == .null, "另一作品看到了目标的关联阅读状态")
        try check(await model.openRelatedWork(target), "连续查看关联失败")
        try check(model.relatedReturnDestinations.count == 2, "连续关联没有分别保留返回路径")
        try check(await model.returnFromRelatedWork() && model.workReference == source, "第一次返回跳过了上一作品")
        try check(await model.returnFromRelatedWork() && model.workReference == target && model.relatedReturnDestination == nil, "第二次返回未恢复初始作品")
        try check(model.relatedWorksSession() === targetSession && targetSession.includesArchived, "返回后丢失了历史会话或已解除筛选")
        await targetSession.load(in: model.workspace!, reference: target, includeArchived: targetSession.includesArchived)
        try check(targetSession.detail["link"] == oldDetail["link"] && targetSession.detail["sha256"] == oldDetail["sha256"], "返回刷新将固定旧关系跳到新版")
        try check(await model.openRelatedWork(source), "负例前无法恢复关联来源")
        var missing = target.value.object; missing["object_id"] = .string("drama_\(UUID().uuidString.lowercased())")
        let absent = try WorkReference(.object(missing))
        try check(!(await model.openRelatedWork(absent)), "不存在的关联对象被打开")
        try check(model.workReference == source && model.relatedReturnDestinations.count == 1 && model.relatedReturnDestination?.reference == target,
            "失败的打开破坏了当前对象或返回路径")
        try check(await model.open(workspace.url, workReference: target) && model.relatedReturnDestination == nil, "从外部另开作品仍沿用旧返回路径")
        await model.returnToLibrary()
        try check(model.relatedReturnDestination == nil && model.workspace == nil, "返回创作库没有清理窗口关联返回入口")
    }
}
