import Darwin
import Foundation
import HetuCore
import HetuNative

enum LibraryPropertiesTests {
    struct Failure: Error { let message: String }
    static func require(_ value: Bool, _ message: String) throws { if !value { throw Failure(message: message) } }

    @MainActor static func run(root: URL, preferences: UserDefaults) async throws {
        let libraryURL = root.appendingPathComponent("属性书库")
        let library = LibraryStore(directory: libraryURL, collaborationDirectory: root.appendingPathComponent("属性验收协作"))
        let model = WorkspaceModel(recovery: RecoveryStore(directory: root.appendingPathComponent("属性恢复")), preferences: preferences, library: library)
        let url = root.appendingPathComponent("删除验收作品 " + UUID().uuidString)
        try require(await model.open(url, title: "雾港来信 删除验收"), "未建立隔离作品")
        let initial = model.libraryEntries[0]
        try require(initial.createdAt != nil && initial.createdAt == initial.updatedAt, "书库未读取真实创建与更新时间")
        guard let chapter = await model.createDocument(title: "第一章", kind: "novel_chapter"), await model.selectDocument(chapter) else { throw Failure(message: "未创建测试正文") }
        model.edit("只用于删除验收的演示正文。")
        try require(await model.save(), "正文未保存")
        let entry = model.libraryEntries[0]
        try require(entry.createdAt == initial.createdAt && entry.updatedAt != initial.updatedAt, "保存未刷新时间投影")
        let opened = entry.lastOpenedAt
        _ = try await model.workspace!.data("hetu.documents.create", input: ["title": .string("外部修改"), "kind": .string("novel_chapter"), "source_format": .string("markdown"), "content": .string("独立入口提交。"), "operation_key": .string("external-write")])
        await model.returnToLibrary()
        let refreshed = model.libraryEntries[0]
        try require(refreshed.updatedAt != entry.updatedAt && refreshed.createdAt == entry.createdAt && refreshed.lastOpenedAt == opened, "书库刷新没有取得外部更新，或误改最近打开时间")

        // 旧版本书库没有时间缓存，读取兼容并从作品事实重建。
        let catalogURL = libraryURL.appendingPathComponent("library.json")
        var catalog = try JSONSerialization.jsonObject(with: Data(contentsOf: catalogURL)) as! [String: Any]
        var entries = catalog["entries"] as! [[String: Any]]
        entries[0].removeValue(forKey: "createdAt"); entries[0].removeValue(forKey: "updatedAt")
        catalog["entries"] = entries
        try JSONSerialization.data(withJSONObject: catalog).write(to: catalogURL, options: .atomic)
        try require(try await library.entries()[0].createdAt == nil, "旧书库缺时间字段无法读取")
        await model.loadLibrary()
        try require(model.libraryEntries[0].createdAt == initial.createdAt, "旧书库时间未重建")
        let current = model.libraryEntries[0]

        do { _ = try await library.trash(current, confirmingTitle: "雾港来信"); throw Failure(message: "不完整作品名仍删除") }
        catch LibraryStore.LibraryError.confirmationMismatch {}
        let afterMismatch = try await library.entries()
        try require(FileManager.default.fileExists(atPath: url.path) && afterMismatch.count == 1, "错误确认产生副作用")

        let lock = Darwin.open(url.appendingPathComponent(".hetu/workspace.lock").path, O_RDWR)
        try require(lock >= 0 && flock(lock, LOCK_EX | LOCK_NB) == 0, "无法占用测试锁")
        do { _ = try await library.trash(current, confirmingTitle: current.title); throw Failure(message: "写入期间仍删除") }
        catch LibraryStore.LibraryError.busy {}
        flock(lock, LOCK_UN); Darwin.close(lock)

        // 同一路径被另一作品占用时，旧登记不能删除新作品。
        let moved = root.appendingPathComponent("原作品暂存")
        try FileManager.default.moveItem(at: url, to: moved)
        _ = try await Workspace.open(at: url, mode: .author, title: "另一部作品", operationKey: "replacement")
        do { _ = try await library.trash(current, confirmingTitle: current.title); throw Failure(message: "目录替换后仍删除") }
        catch LibraryStore.LibraryError.changedWork {}
        catch LibraryStore.LibraryError.wrongWorkspace {}
        let replacement = root.appendingPathComponent("替换目录保留")
        try FileManager.default.moveItem(at: url, to: replacement)
        try FileManager.default.moveItem(at: moved, to: url)

        // 表单打开后书名变更，缓存里的旧书名不再构成删除确认。
        let renamed = try await Workspace.open(at: url, mode: .author)
        let novel = try await renamed.data("hetu.novels.get")
        var metadata = novel["novel"]["metadata"].object
        metadata["title"] = .string("临时改名用于确认校验")
        let renamedNovel = try await renamed.data("hetu.novels.update", input: ["metadata": .object(metadata), "expected": .object(["revision": novel["revision"], "sha256": novel["sha256"]]), "operation_key": .string("rename-before-delete")])
        do { _ = try await library.trash(current, confirmingTitle: current.title); throw Failure(message: "旧标题仍可确认删除") }
        catch LibraryStore.LibraryError.changedWork {}
        metadata["title"] = .string(current.title)
        _ = try await renamed.data("hetu.novels.update", input: ["metadata": .object(metadata), "expected": .object(["revision": renamedNovel["revision"], "sha256": renamedNovel["sha256"]]), "operation_key": .string("restore-title")])

        // 真实移入系统废纸篓，只操作本测试新建作品；随后立即放回并验证内容。
        var identity = stat()
        try require(lstat(url.path, &identity) == 0, "未读取隔离目录身份")
        let stale = try await Workspace.open(at: url, mode: .author)
        try await model.trashLibraryEntry(current, confirmingTitle: current.title)
        try require(model.libraryEntries.isEmpty && !FileManager.default.fileExists(atPath: url.path), "移动完成后未移除登记")
        var bookmarkStale = false
        let trashed = try URL(resolvingBookmarkData: current.location, options: [.withoutUI, .withoutMounting], relativeTo: nil, bookmarkDataIsStale: &bookmarkStale)
        try require(FileManager.default.fileExists(atPath: trashed.path), "废纸篓内找不到原作品")
        // 模拟移动成功后客户端中断，目录身份和原书签必须足以恢复移除登记。
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        let entryObject = try JSONSerialization.jsonObject(with: encoder.encode(current))
        catalog = ["schemaVersion": "1.0.0", "entries": [entryObject], "pendingDeletion": [
            "entry": entryObject, "device": Int(identity.st_dev), "inode": identity.st_ino,
            "trashDirectory": trashed.deletingLastPathComponent().absoluteString]]
        try JSONSerialization.data(withJSONObject: catalog).write(to: catalogURL, options: .atomic)
        let recovered = try await LibraryStore(directory: libraryURL).entries()
        try require(recovered.isEmpty, "移动成功后未恢复书库登记")
        do {
            _ = try await stale.data("hetu.documents.create", input: ["title": .string("旧窗口禁止写入"), "kind": .string("novel_chapter"), "source_format": .string("markdown"), "content": .string(""), "operation_key": .string("stale-after-trash")])
            throw Failure(message: "删除后旧窗口仍能写入")
        } catch CoreError.business(let result) { try require(result["error"]["code"].string == "hetu.workspace_moved", "旧窗口返回错误类型不准确") }
        try FileManager.default.moveItem(at: trashed, to: url)
        try require(await model.open(url), "废纸篓放回后无法重开")
        try require(await model.selectDocument(chapter) && model.text == "只用于删除验收的演示正文。", "放回作品后正文丢失")
        print("作品属性与删除：创建/更新/最近打开、外部更新刷新、旧缓存、完整书名/改名确认、写锁、目录替换、真实废纸篓与放回、中断恢复、旧窗口写入拒绝全部通过")
    }
}
