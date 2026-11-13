import Foundation
import HetuCore
import HetuNative

private struct CreativeTestFailure: Error { let message: String }
private func creativeCheck(_ condition: Bool, _ message: String) throws {
    if !condition { throw CreativeTestFailure(message: message) }
}

enum CreativeTaskTests {
    @MainActor static func run(root: URL) async throws {
        let directory = root.appendingPathComponent("受限改稿")
        let recovery = RecoveryStore(directory: root.appendingPathComponent("改稿恢复"))
        let name = "run.limeai.hetu.creative-tests.\(UUID().uuidString)"
        let preferences = UserDefaults(suiteName: name)!
        defer { preferences.removePersistentDomain(forName: name) }
        let model = WorkspaceModel(locale: "zh-CN", recovery: recovery, preferences: preferences, library: LibraryStore(directory: root.appendingPathComponent("改稿书库")))
        try creativeCheck(await model.open(directory, title: "雾港"), "未打开改稿作品")
        guard let documentID = await model.createDocument(title: "第一章", kind: "novel_chapter"), await model.selectDocument(documentID), let workspace = model.workspace else { throw CreativeTestFailure(message: "未创建改稿章节") }
        model.agentIntegration.associate(AgentAssociation(client: .codex, suiteID: "military"), with: model.workspaceID)
        let original = "灯亮了。\r\n🌿对白保持。"
        model.edit(original)
        let session = CreativeTaskSession(model: model)
        await session.previewRevision(ranges: [], contextIDs: [], includeBible: false, client: .codex, brief: "保留对白")
        try creativeCheck(session.preview == .null, "未保存稿被外发")
        try creativeCheck(await model.save(), "改稿原文保存失败")
        let source = try await workspace.data("hetu.documents.get", input: ["document_id": .string(documentID)])
        let sourceRange = SourceSpan(content: original, selection: NSRange(location: 0, length: original.utf16.count))!
        await session.previewRevision(ranges: [CreativeTaskInput.range(sourceRange)], contextIDs: [], includeBible: true, client: .codex, brief: "仅调整灯光与最后一句。")
        try creativeCheck(session.preview["prompt"].string?.contains("hetu-military") == true, "题材套件未进入任务提示词")
        await session.prepare(prompt: session.preview["prompt"].string ?? "")
        try creativeCheck(session.task["request"]["task_kind"].string == "revision" && session.error == nil, "任务未落盘或恢复白名单不允许任务")
        try creativeCheck(session.tasks.count == 1 && model.pendingStructureOperations.isEmpty, "任务列表或原操作恢复状态不符")
        let fixed = session.task
        let ref = session.taskReference
        let agent = try await Workspace.open(at: directory, mode: .agent, taskID: fixed["request"]["task_id"].string)
        let tail = original.range(of: "对白保持")!
        let tailStart = original[..<tail.lowerBound].utf8.count
        let patches: [JSONValue] = [
            .object(["byte_start": .integer(0), "byte_end": .integer(9), "quote": .string("灯亮了"), "replacement": .string("灯影轻晃")]),
            .object(["byte_start": .integer(Int64(tailStart)), "byte_end": .integer(Int64(tailStart + "对白保持".utf8.count)), "quote": .string("对白保持"), "replacement": .string("只作参考")])
        ]
        let candidate: JSONValue = .object(["kind": .string("text"), "title": .string("改稿参考"), "source_format": .string("markdown"), "source_ref_indices": .array([.integer(0)]), "patches": .array(patches)])
        _ = try await agent.data("hetu.creative_tasks.submit_result", input: ["task_ref": ref, "request_sha256": fixed["request_sha256"], "candidates": .array([candidate]), "complete": .bool(true), "missing_items": .array([]), "provenance": .object(["client": .string("native-test"), "skill_version": .string("1")]), "operation_key": .string("submit")])
        model.edit(original + "作者继续写，先不保存。")
        await session.loadTask(ref)
        try creativeCheck(model.text.hasSuffix("先不保存。") && model.needsProtection, "收到候选覆盖作者缓冲")
        try creativeCheck(model.baseRevisionID == source["revision"]["revision_id"].string, "接收结果改变正文修订")
        // 作者明确保留当前缓冲到恢复文件，再载入已保存稿进行采纳。
        try creativeCheck(await model.persistRecovery(), "采纳前恢复副本未保存")
        try creativeCheck(await model.selectDocument(documentID), "未载入已保存原文")
        let savedCandidate = session.task["submission"]["candidates"].array[0]
        let draft = try await workspace.data("hetu.drafts.get", input: ["draft_id": savedCandidate["draft_ref"]["draft_id"]])
        let input = try CreativeTaskInput.patchAdoption(task: session.task, candidate: savedCandidate, draft: draft, target: source, selected: [0])
        let preview = try await workspace.data("hetu.drafts.preview_adoption", input: input)
        try creativeCheck(preview["content"].string == original.replacingOccurrences(of: "灯亮了", with: "灯影轻晃"), "未选改动被带入正文")
        let adopted = try await workspace.data("hetu.drafts.adopt", input: ["preview": preview["preview"], "operation_key": .string("adopt-selected")])
        try creativeCheck(adopted["document"]["approved_revision_id"] == .null && adopted["adoption"] != .null, "采纳未留痕或自动定稿")
        do {
            _ = try await workspace.data("hetu.drafts.adopt", input: ["preview": preview["preview"], "operation_key": .string("stale-preview")])
            throw CreativeTestFailure(message: "过期预览覆盖了新正文")
        } catch is CreativeTestFailure { throw CreativeTestFailure(message: "过期预览覆盖了新正文") }
        catch { }
        await session.loadTask(ref)
        await session.close(reason: "作者结束本次任务")
        let rejected = try await agent.request("hetu.creative_tasks.get", input: ["task_ref": ref])
        try creativeCheck(rejected["error"]["code"].string == "forbidden", "旧任务进程未随关闭失权")

        let creationURL = root.appendingPathComponent("无书名筹备")
        let project = try await Workspace.openCreationProject(at: creationURL, brief: "先有一个想法", operationKey: "creation")
        let discovery = try await project.data("hetu.capabilities.get")
        try creativeCheck(discovery["scope_ref"]["kind"].string == "creation_project" && !FileManager.default.fileExists(atPath: creationURL.appendingPathComponent(".heturc.json").path), "无书名筹备创建了假作品")
    }
}
