import Foundation
import HetuCore
import HetuNative

enum WorkCatalogTests {
    struct Failure: Error { let message: String }
    private static func check(_ value: Bool, _ message: String) throws { if !value { throw Failure(message: message) } }
    @MainActor static func run(root: URL, preferences: UserDefaults) async throws {
        let url = root.appendingPathComponent("同名的三种创作")
        let workspace = try await Workspace.open(at: url, mode: .author, title: "雨夜旧站", operationKey: "init")
        let drama = try await workspace.data("hetu.drama.projects.create", input: ["title": .string("雨夜旧站"), "operation_key": .string("drama")])
        let video = try await workspace.data("hetu.video.projects.create", input: ["title": .string("雨夜旧站"), "brief": .string("独立视频"), "language_tag": .string("zh-CN"), "operation_key": .string("video")])
        let works = try await WorkCatalog.list(in: workspace)
        try check(works.count == 3, "同根三类创作未完整列出")
        let library = LibraryStore(directory: root.appendingPathComponent("创作库"), collaborationDirectory: root.appendingPathComponent("隔离客户端授权"))
        let model = WorkspaceModel(preferences: preferences, library: library)
        try check(await model.open(url), "不能打开已有多对象工作区")
        let entries = try await library.entries()
        try check(entries.count == 3 && Set(entries.map(\.id)).count == 3 && Set(entries.map(\.contentType)) == ["novel", "drama", "video"], "创作库按目录或标题错误合并了对象")
        try check(entries.first { $0.contentType == "novel" }?.lastOpenedAt != nil
            && entries.filter { $0.contentType != "novel" }.allSatisfy { $0.lastOpenedAt == nil }, "打开一个对象改变了同根其他对象的最近打开时间")
        for entry in entries {
            try check(await model.openLibraryEntry(entry), "不能打开精确创作对象")
            try check(model.workReference == entry.workReference && model.workType == entry.contentType, "同根切换未切换工作面身份")
        }
        let original = model.currentWork
        let wrong = try WorkReference(.object(["workspace_id": .string(model.workspaceID), "kind": .string("video"), "object_id": .string("video_00000000-0000-4000-8000-000000000000")]))
        try check(!(await model.open(url, workReference: wrong)) && model.currentWork == original, "无效对象破坏了当前工作面")
        model.message = nil
        let selected = entries.first { $0.contentType == "drama" }!
        do { _ = try await library.trash(selected, confirmingTitle: selected.title); throw Failure(message: "删除单对象移动了共用目录") }
        catch LibraryStore.LibraryError.multipleWorks { }
        try check(FileManager.default.fileExists(atPath: url.path), "共用根目录被移走")
        _ = try await library.removeRegistration(selected)
        let afterRemoval = try await library.entries()
        try check(afterRemoval.count == 2, "移除登记影响其他对象")
        let dramaRead = try await workspace.data("hetu.drama.projects.get", input: ["project_id": drama["project"]["project_id"]])
        try check(dramaRead["project"]["archived"].bool == false, "移除登记修改了剧本内容")
        await model.returnToLibrary()
        try check(await model.open(url), "移除登记后不能打开根目录")
        try check(model.libraryEntries.count == 2, "后台刷新恢复了作者移除的登记")
        try check(await model.openLibraryEntry(selected), "不能明确重新打开移除的对象")
        try check(model.libraryEntries.count == 3, "明确重新打开未恢复该对象登记")
        let readVideo = try await workspace.data("hetu.video.projects.get", input: ["video_project_id": video["project"]["video_project_id"]])
        try check(readVideo["project"] == video["project"], "登记操作修改了视频项目")
        await model.returnToLibrary()
        try await model.archiveLibraryEntry(selected, confirmingTitle: selected.title)
        let archived = try await workspace.data("hetu.drama.projects.get", input: ["project_id": drama["project"]["project_id"]])
        try check(archived["project"]["archived"].bool == true && model.libraryEntries.first { $0.id == selected.id }?.status == "archived", "归档未落在精确剧本对象")
        let videoAfterArchive = try await workspace.data("hetu.video.projects.get", input: ["video_project_id": video["project"]["video_project_id"]])
        try check(videoAfterArchive["project"] == video["project"] && FileManager.default.fileExists(atPath: url.path), "归档影响同根视频或移走根目录")
        print("创作库：同根三类同名身份、精确切换、错误回读保护、单对象删除拒绝、登记移除与明确恢复通过")
    }
}
