import AppKit
import CryptoKit
import Foundation
import HetuCore
import HetuNative

private struct PreparationFailure: Error { let message: String }
private func checkPreparation(_ condition: Bool, _ message: String) throws {
    if !condition { throw PreparationFailure(message: message) }
}

enum CoverPreparationTests {
    @MainActor static func run(root: URL) async throws {
        let recovery = RecoveryStore(directory: root.appendingPathComponent("筹备封面恢复"))
        let planning = CreationProjectSession(locale: "zh-CN", directory: root.appendingPathComponent("封面筹备"), recovery: recovery)
        planning.brief = "灯塔小说，无字封面。"
        await planning.previewTask(kind: "cover", client: .codex, suiteID: "general")
        await planning.prepare(prompt: planning.preview["prompt"].string ?? "")
        guard let project = planning.workspace else { throw PreparationFailure(message: planning.error ?? "筹备未创建") }
        let task = planning.task, reference = planning.taskReference
        let image = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 128, pixelsHigh: 192, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 512, bitsPerPixel: 32)!
        let bytes = image.representation(using: .png, properties: [:])!
        let inbox = project.url.appendingPathComponent(task["request"]["output_contract"]["relative_inbox"].string!)
        try bytes.write(to: inbox.appendingPathComponent("cover.png"))
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let agent = try await Workspace.openCreationProject(at: project.url, mode: .agent, taskID: task["request"]["task_id"].string)
        _ = try await agent.data("hetu.creative_tasks.submit_result", input: ["task_ref": reference, "request_sha256": task["request_sha256"],
            "candidates": .array([.object(["kind": .string("image"), "title": .string("灯塔封面"), "source_format": .string("image"), "source_ref_indices": .array([]), "file_name": .string("cover.png"), "sha256": .string(digest)])]),
            "complete": .bool(true), "missing_items": .array([]), "provenance": .object(["client": .string("native-cover-test"), "skill_version": .string("1")]), "operation_key": .string("cover-preparation-submit")])
        planning.set("title", value: "雾港灯塔")
        planning.set("author_name", value: "南山")
        let target = root.appendingPathComponent("转入筹备封面的小说")
        guard await planning.createNovel(at: target, language: "zh-CN") != nil else { throw PreparationFailure(message: planning.error ?? "新书创建失败") }
        await planning.acknowledgeCreatedWorkspace()
        let library = LibraryStore(directory: root.appendingPathComponent("筹备封面书库"))
        let model = WorkspaceModel(locale: "zh-CN", recovery: recovery, library: library)
        try checkPreparation(await model.open(target), "未打开筹备创建的小说")
        let session = CoverSession(model: model)
        await session.refresh()
        try checkPreparation(session.preparationProjectID == planning.projectID, "封面页未发现建书来源")
        await session.loadPreparationProject(project.url)
        try checkPreparation(session.preparationTasks.count == 1, session.error ?? "未列出筹备封面任务")
        await session.inspectPreparationTask(reference)
        guard let candidate = session.preparationTask["submission"]["candidates"].array.first else { throw PreparationFailure(message: session.error ?? "未读到图片候选") }
        try checkPreparation(await session.importPreparation(candidate), session.error ?? "未转入筹备封面")
        try checkPreparation(session.current["cover"] == .null && session.preparationImports.count == 1, "转入自动选用了封面或没有保留素材")
        let imported = session.preparationImports[0]
        try checkPreparation(imported["record"]["source_ref"]["reference"]["task_ref"] == reference && imported["preview"]["width"].integer == 128 && imported["preview"]["height"].integer == 192, "来源或原图比例丢失")

        // 写入成功而窗口退出时，恢复沿原键读取回执，不依赖原筹备目录。
        let input: [String: JSONValue] = ["project_path": .string(project.url.path), "candidate_ref": imported["record"]["source_ref"]["reference"], "operation_key": .string("preparation-native-recovery")]
        let pending = PendingStructureOperation(workspaceID: model.workspaceID, action: "hetu.covers.import_preparation", input: input)
        try await recovery.writeOperation(pending)
        let direct = try await Workspace.open(at: target, mode: .author)
        _ = try await direct.data(pending.action, input: input)
        try FileManager.default.moveItem(at: project.url, to: project.url.appendingPathExtension("moved"))
        let restarted = WorkspaceModel(locale: "en", recovery: recovery, library: library)
        try checkPreparation(await restarted.open(target), "转入操作未恢复作品")
        let restored = CoverSession(model: restarted)
        await restored.refresh()
        await restored.retry()
        try checkPreparation(restored.pending == nil && restored.preparationImports.count == 1, restored.error ?? "原键恢复重复导入或丢失图片")
        try checkPreparation(await restored.selectPreparation(restored.preparationImports[0], overlay: true), restored.error ?? "源筹备移走后不能选用封面")
        try checkPreparation(restarted.cover["cover"]["source_ref"]["kind"].string == "creation_preparation" && restarted.cover["cover"]["presentation"]["title_overlay"].string == "雾港灯塔", "正式封面丢失筹备来源或作者排版")
        try checkPreparation(try await library.entries().first?.coverPreview != nil, "转入选用后书库未显示封面")
        print("筹备封面：正式书关联、等比预览、来源转入、独立选用、目录移动与原键恢复通过")
    }
}
