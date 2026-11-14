import AppKit
import Foundation
import HetuCore
import HetuNative

enum ArtworkLibraryTests {
    struct Failure: Error { let message: String }
    static func require(_ value: Bool, _ message: String) throws { if !value { throw Failure(message: message) } }
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
        let library = ArtworkLibrarySession()
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
        // 损坏原图是读取失败，不能显示成“没有图片”。
        try Data("broken".utf8).write(to: workspace.url.appendingPathComponent(item.candidate["relative_path"].string!))
        await library.load(model: model)
        try require(library.error != nil, "损坏图片被伪装为空结果")
        model.edit(model.savedText)
        try require(await model.open(root.appendingPathComponent("另一部作品"), title: "另一部"), "作品切换失败")
        await library.load(model: model)
        try require(library.items.isEmpty && library.error == nil, "作品切换残留旧图片或错误")
        print("图片库检查通过：最新/历史批次、文档关联、真实解码比例、损坏失败、未保存稿与作品隔离")
    }
}
