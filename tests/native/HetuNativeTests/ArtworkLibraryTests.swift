import AppKit
import Foundation
import HetuCore
import HetuNative

enum ArtworkLibraryTests {
    struct Failure: Error { let message: String }
    static func require(_ value: Bool, _ message: String) throws { if !value { throw Failure(message: message) } }
    /// 测量真实 SDK 和共享界面状态；书库投影、恢复数据与偏好全部隔离。
    @MainActor static func performance(root: URL, workspaceURL: URL) async throws {
        let name = "run.limeai.hetu.artwork.performance.\(UUID().uuidString)"
        let prefs = UserDefaults(suiteName: name)!
        defer { prefs.removePersistentDomain(forName: name) }
        let model = WorkspaceModel(recovery: RecoveryStore(directory: root.appendingPathComponent("Recovery")), preferences: prefs,
            library: LibraryStore(directory: root.appendingPathComponent("Library")))
        let clock = ContinuousClock()
        var rows: [[String: JSONValue]] = []
        func record(_ step: String, _ start: ContinuousClock.Instant, images: Int = 0) {
            let elapsed = start.duration(to: clock.now).components
            let seconds = Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18
            rows.append(["step": .string(step), "seconds": .number(seconds), "images": .integer(Int64(images))])
        }
        var start = clock.now
        try require(await model.open(workspaceURL), "性能作品未打开：\(model.message ?? "")")
        record("workspace_open", start)
        for step in ["first_library", "refresh_library", "entity_library"] {
            start = clock.now
            await model.artworkLibrary.load(model: model)
            try require(model.artworkLibrary.error == nil, "性能图片读取失败")
            record(step, start, images: model.artworkLibrary.items.count)
        }
        print(String(decoding: try JSONValue.array(rows.map(JSONValue.object)).encoded(pretty: true), as: UTF8.self))
    }
    @MainActor static func run(root: URL) async throws {
        let name = "run.limeai.hetu.artwork.\(UUID().uuidString)"
        let prefs = UserDefaults(suiteName: name)!
        prefs.set(false, forKey: "Hetu.editor.autosave")
        defer { prefs.removePersistentDomain(forName: name) }
        let model = WorkspaceModel(recovery: RecoveryStore(directory: root.appendingPathComponent("图片恢复")), preferences: prefs,
            library: LibraryStore(directory: root.appendingPathComponent("图片书库")))
        try require(await model.open(root.appendingPathComponent("图片作品"), title: "渡口"), "图片作品未创建")
        guard let documentID = await model.createDocument(title: "夜渡", kind: "novel_chapter"), let workspace = model.workspace else { throw Failure(message: "章节未创建") }
        try require(await model.selectDocument(documentID), "章节未打开")
        model.edit("岸上的两盏油灯。"); try require(await model.save(), "正文未保存")
        let ref: JSONValue = .object(["kind": .string("document"), "document_id": .string(documentID), "revision_id": .string(model.baseRevisionID)])
        let preview = try await workspace.data("hetu.image_tasks.preview_prompt", input: ["scope_ref": .object(["kind": .string("workspace"), "id": .string(model.workspaceID)]),
            "task_kind": .string("artwork"), "brief": .string("夜渡插图"), "input_refs": .array([ref]), "client_adapter": .string("codex"), "language_tag": .string("zh-CN"), "candidate_limit": .integer(1)])
        var prepare = preview["prepare_input"].object; prepare["operation_key"] = .string("library-task")
        let task = try await workspace.data("hetu.image_tasks.prepare", input: prepare)
        let inbox = workspace.url.appendingPathComponent(task["request"]["output_contract"]["relative_inbox"].string!)
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 180, pixelsHigh: 120, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 720, bitsPerPixel: 32)!
        let data = bitmap.representation(using: .png, properties: [:])!
        try data.write(to: inbox.appendingPathComponent("scene.png"))
        let inspection = try await workspace.data("hetu.covers.inspect_file", input: ["file_path": .string(inbox.appendingPathComponent("scene.png").path)])
        let candidate: JSONValue = .object(["kind": .string("image"), "title": .string("夜渡"), "source_format": .string("image"), "source_ref_indices": .array([.integer(0)]),
            "file_name": .string("scene.png"), "sha256": inspection["sha256"], "image_category": .string("illustration"), "subject_refs": .array([ref])])
        func submit(_ key: String) async throws -> JSONValue {
            try await workspace.data("hetu.creative_tasks.submit_result", input: ["task_ref": task["task_ref"], "request_sha256": task["request_sha256"], "candidates": .array([candidate]), "complete": .bool(true), "missing_items": .array([]), "provenance": .object(["client": .string("test"), "skill_version": .string("1")]), "operation_key": .string(key)])
        }
        let first = try await submit("library-first")
        let second = try await submit("library-second")
        let library = model.artworkLibrary
        model.edit("作者尚未保存的修改")
        await library.load(model: model)
        try require(library.error == nil && library.items.count == 1, "图片未加载或把历史批次铺满")
        let item = library.items[0]
        try require(item.submissionID == second["submission"]["submission_id"].string && item.submissionID != first["submission"]["submission_id"].string, "未默认最新批次")
        try require(item.category == "illustration" && item.matches(document: documentID) && !item.matches(document: "another") && !item.matches(entity: documentID), "图片分类或对象关联错误")
        try require(item.preview["width"].integer == 180 && item.preview["height"].integer == 120 && item.preview["base64"].string != nil, "未读取内核验证的等比图片预览")
        try require(model.dirty && model.text == "作者尚未保存的修改", "图片读取覆盖了作者缓冲")
        let historical = try await workspace.data("hetu.interactions.get", input: ["task_ref": task["task_ref"], "submission_id": first["submission"]["submission_id"]])
        try require(ArtworkItem.latest(historical).first?.submissionID == first["submission"]["submission_id"].string, "历史图片不能独立回读")
        async let firstRefresh: Void = library.load(model: model)
        async let secondRefresh: Void = library.load(model: model)
        _ = await (firstRefresh, secondRefresh)
        try require(library.items.count == 1 && !library.loading && library.error == nil, "共享图片刷新未合并或未完成")
        let person = "character_11111111-1111-4111-8111-111111111111"
        let bible = try await workspace.data("hetu.blueprints.get")
        let saved = try await workspace.data("hetu.blueprints.save", input: ["expected": .object(["revision": bible["revision"], "sha256": bible["sha256"]]),
            "typed_changes": .array([.object(["type": .string("upsert_character"), "entity": .object(["character_id": .string(person), "name": .string("林舟"), "aliases": .array([]), "description": .string("船工"), "traits": .array([]), "facts": .array([]), "archived": .bool(false)])])]), "operation_key": .string("library-person")])
        let personRef: JSONValue = .object(["kind": .string("entity"), "entity_ref": .string(person), "blueprint_revision": saved["revision"]])
        let personPreview = try await workspace.data("hetu.image_tasks.preview_prompt", input: ["scope_ref": .object(["kind": .string("workspace"), "id": .string(model.workspaceID)]),
            "task_kind": .string("artwork"), "brief": .string("林舟单人形象与三视图"), "input_refs": .array([.object(["kind": .string("blueprint"), "revision": saved["revision"]])]), "client_adapter": .string("codex"), "language_tag": .string("zh-CN"), "candidate_limit": .integer(4)])
        var personPrepare = personPreview["prepare_input"].object; personPrepare["operation_key"] = .string("library-person-task")
        let personTask = try await workspace.data("hetu.image_tasks.prepare", input: personPrepare)
        let personInbox = workspace.url.appendingPathComponent(personTask["request"]["output_contract"]["relative_inbox"].string!)
        try data.write(to: personInbox.appendingPathComponent("person.png"))
        let views = ["back", "three_view", "side", "front"]
        let group: [JSONValue] = views.map { view in .object(["kind": .string("image"), "title": .string(view), "source_format": .string("image"), "source_ref_indices": .array([.integer(0)]), "file_name": .string("person.png"), "sha256": inspection["sha256"], "image_category": .string("character"), "image_view": .string(view), "subject_refs": .array([personRef])]) }
        _ = try await workspace.data("hetu.creative_tasks.submit_result", input: ["task_ref": personTask["task_ref"], "request_sha256": personTask["request_sha256"], "candidates": .array(group), "complete": .bool(true), "missing_items": .array([]), "provenance": .object(["client": .string("test"), "skill_version": .string("1")]), "operation_key": .string("library-views")])
        await library.load(model: model)
        let people = library.items.filter { $0.matches(entity: person) }
        try require(people.count == 4 && Set(people.compactMap(\.imageView)) == Set(views), "角色图组或视角丢失")
        try require(ArtworkItem.primaryImage(in: people, entity: person, category: "character")?.imageView == "front", "角色卡片未优先单人正面")
        try require(ArtworkItem.primaryImage(in: people.filter { $0.imageView != "front" }, entity: person, category: "character") == nil, "三视图或背面冒充人物主图")
        try require(ArtworkItem.primaryImage(in: library.items, entity: person, category: "scene") == nil, "角色图冒充场景")
        try require(model.dirty && model.text == "作者尚未保存的修改", "加载角色图组覆盖未保存稿")
        // 损坏原图是读取失败，不能显示成“没有图片”。
        try Data("broken".utf8).write(to: workspace.url.appendingPathComponent(item.candidate["relative_path"].string!))
        await library.load(model: model)
        try require(library.error != nil, "损坏图片被伪装为空结果")
        model.edit(model.savedText)
        try require(await model.open(root.appendingPathComponent("另一部作品"), title: "另一部"), "作品切换失败")
        try require(library.items.isEmpty && library.error == nil, "作品切换未立即清空共享图片")
        await library.load(model: model)
        try require(library.items.isEmpty && library.error == nil, "作品切换残留旧图片或错误")
        print("图片库检查通过：最新/历史批次、文档关联、单人主图与四张视图、真实解码比例、损坏失败、未保存稿与作品隔离")
    }
}
