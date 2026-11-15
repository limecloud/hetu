import AppKit
import Foundation
import HetuCore
import HetuNative

private struct CoverTestFailure: Error { let message: String }
private func coverCheck(_ condition: Bool, _ message: String) throws { if !condition { throw CoverTestFailure(message: message) } }

enum CoverTests {
    @MainActor static func run(root: URL) async throws {
        let recovery = RecoveryStore(directory: root.appendingPathComponent("封面恢复"))
        let library = LibraryStore(directory: root.appendingPathComponent("封面书库"))
        let model = WorkspaceModel(locale: "zh-CN", recovery: recovery, library: library)
        let workspace = root.appendingPathComponent("封面作品")
        try coverCheck(await model.open(workspace, title: "雾港"), "封面测试未创建作品")
        let image = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 64, pixelsHigh: 96, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 256, bitsPerPixel: 32)!
        let path = root.appendingPathComponent("中文封面 🌿.png")
        try image.representation(using: .png, properties: [:])!.write(to: path)
        let session = CoverSession(model: model)
        await session.refresh()
        guard let inspected = await session.read("hetu.covers.inspect_file", input: ["file_path": .string(path.path)]) else { throw CoverTestFailure(message: session.error ?? "未检查图片") }
        try coverCheck(inspected["width"].integer == 64 && inspected["height"].integer == 96, "原生图片检查未使用实际尺寸")
        try coverCheck(await session.selectFile(path, inspection: inspected, overlay: true), "未选用作者图片")
        try coverCheck(model.cover["cover"]["revision"].integer == 1 && model.cover["cover"]["presentation"]["title_overlay"].string == "雾港", "选用未更新原生模型或文字")
        let entries = try await library.entries()
        try coverCheck(entries.first?.coverPreview != nil && entries.first?.coverTitle == "雾港", "书库未持久化可重建封面投影")
        let reopen = WorkspaceModel(locale: "en", recovery: recovery, library: library)
        try coverCheck(await reopen.open(workspace), "封面作品未重新打开")
        try coverCheck(reopen.cover["cover"] == model.cover["cover"], "重启后封面或文字改变")
        let secondSession = CoverSession(model: reopen)
        await secondSession.refresh()
        try coverCheck(await secondSession.selectFile(path, inspection: inspected, overlay: false), "另一窗口选用失败")
        try coverCheck(!(await session.selectFile(path, inspection: inspected, overlay: true)) && session.error != nil, "过期窗口覆盖新封面")
        await session.refresh()
        await session.inspectRevision(1)
        try coverCheck(session.history["cover"]["presentation"]["title_overlay"].string == "雾港", "历史预览丢失原文字排版")
        try coverCheck(await session.restoreInspectedRevision(), "未选用历史封面")
        try coverCheck(session.current["cover"]["revision"].integer == 3 && session.current["cover"]["presentation"]["title_overlay"].string == "雾港", "历史选用未建立新版本或改变了原排版")
        await session.inspectRevision(2)
        try coverCheck(session.history["cover"]["presentation"]["title_overlay"].string == "", "选用历史封面覆盖了旧版本")
        let input: [String: JSONValue] = ["source": .object(["kind": .string("asset"), "asset_ref": session.current["cover"]["asset_ref"]]), "expected_cover": session.current["expected_cover"], "presentation": session.current["cover"]["presentation"], "operation_key": .string("cover-native-recovery")]
        let pending = PendingStructureOperation(workspaceID: model.workspaceID, action: "hetu.covers.select", input: input)
        try await recovery.writeOperation(pending)
        let direct = try await Workspace.open(at: workspace, mode: .author)
        let committed = try await direct.data(pending.action, input: input)
        let restarted = WorkspaceModel(locale: "zh-CN", recovery: recovery, library: library)
        try coverCheck(await restarted.open(workspace), "封面未知操作未恢复作品")
        let recovered = CoverSession(model: restarted)
        try coverCheck(recovered.pending == pending, "未发现原封面操作")
        await recovered.retry()
        try coverCheck(recovered.pending == nil && recovered.current["cover"] == committed["cover"], "未知选用未沿原键恢复或重复增版")
        try coverCheck(try await recovery.structureOperations(workspaceID: model.workspaceID).isEmpty, "封面恢复未清理原操作")
        let beforePreview = restarted.cover["cover"]
        _ = await recovered.read("hetu.covers.inspect_file", input: ["file_path": .string(path.path)])
        try coverCheck(restarted.cover["cover"] == beforePreview, "本地图片预览意外替换当前封面")
        // 候选固定到任务和批次；读取、取消与外部返稿都不代表作者已经选用。
        let taskPreview = try await direct.data("hetu.image_tasks.preview_prompt", input: ["scope_ref": .object(["kind": .string("workspace"), "id": .string(model.workspaceID)]),
            "task_kind": .string("cover"), "brief": .string("雾港小说封面"), "input_refs": .array([]), "client_adapter": .string("codex"), "language_tag": .string("zh-CN"), "candidate_limit": .integer(1)])
        var prepare = taskPreview["prepare_input"].object; prepare["operation_key"] = .string("cover-picker-task")
        let task = try await direct.data("hetu.image_tasks.prepare", input: prepare)
        let inbox = workspace.appendingPathComponent(task["request"]["output_contract"]["relative_inbox"].string!)
        try FileManager.default.copyItem(at: path, to: inbox.appendingPathComponent("cover.png"))
        let result = try await direct.data("hetu.creative_tasks.submit_result", input: ["task_ref": task["task_ref"], "request_sha256": task["request_sha256"],
            "candidates": .array([.object(["kind": .string("image"), "title": .string("雾港封面候选"), "source_format": .string("image"), "source_ref_indices": .array([]), "file_name": .string("cover.png"), "sha256": inspected["sha256"]])]),
            "complete": .bool(true), "missing_items": .array([]), "provenance": .object(["client": .string("cover-picker-test"), "skill_version": .string("1")]), "operation_key": .string("cover-picker-submit")])
        let view = try await direct.data("hetu.interactions.get", input: ["task_ref": task["task_ref"], "submission_id": result["submission"]["submission_id"]])
        guard let item = ArtworkItem.latest(view).first else { throw CoverTestFailure(message: "封面候选未出现在图片库") }
        try coverCheck(!item.isCurrentCover(restarted.cover) && restarted.cover["cover"] == beforePreview, "候选回传或预览自动选用了封面")
        await recovered.refresh()
        try coverCheck(await recovered.selectTaskCandidate(item.coverReference, overlay: false), recovered.error ?? "未选用固定封面候选")
        try coverCheck(item.isCurrentCover(restarted.cover), "选用后没有识别当前候选")
        var anotherBatch = restarted.cover.object
        var cover = restarted.cover["cover"].object
        var source = restarted.cover["cover"]["source_ref"].object
        var reference = restarted.cover["cover"]["source_ref"]["reference"].object; reference["submission_id"] = .string("another-batch")
        source["reference"] = .object(reference); cover["source_ref"] = .object(source); anotherBatch["cover"] = .object(cover)
        try coverCheck(!item.isCurrentCover(.object(anotherBatch)), "其他批次被误标为当前封面")
        await recovered.inspectRevision(Int(beforePreview["revision"].integer!))
        try coverCheck(await recovered.restoreInspectedRevision() && !item.isCurrentCover(restarted.cover), "恢复历史后候选仍误标为当前封面")
        print("封面：原图核验、作者选用、历史恢复、书库显示、重启、双窗口CAS与原键恢复通过")
        try await CoverPreparationTests.run(root: root)
    }
}
