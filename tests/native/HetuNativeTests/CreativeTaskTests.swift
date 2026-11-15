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
        // 本用例明确控制保存与外部写入，不让自动保存竞争同一作品锁。
        preferences.set(false, forKey: "Hetu.editor.autosave")
        defer { preferences.removePersistentDomain(forName: name) }
        let model = WorkspaceModel(locale: "zh-CN", recovery: recovery, preferences: preferences, library: LibraryStore(directory: root.appendingPathComponent("改稿书库")))
        try creativeCheck(await model.open(directory, title: "雾港"), "未打开改稿作品")
        let firstDraft = CreativeTaskSession(model: model)
        await firstDraft.previewWriting(kind: .chapterDraft, contextIDs: [], includeBible: false, includeCurrent: false, client: .codex, brief: "从空白作品起草第一章，只返回参考稿。")
        try creativeCheck(firstDraft.preview["prepare_input"]["task_kind"].string == "chapter_draft" && firstDraft.preview["prepare_input"]["edit_scope"] == .null && firstDraft.preview["prepare_input"]["input_refs"].array.isEmpty, "首章起草被要求先建空章或授权正文修改")
        await firstDraft.prepare(prompt: firstDraft.preview["prompt"].string ?? "")
        try creativeCheck(firstDraft.task["request"]["skill_ref"]["name"].string == "hetu-draft" && model.documents.isEmpty, "首章任务没有使用对应方法或自动创建正式章节")
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
        try creativeCheck(session.tasks.count == 2 && model.pendingStructureOperations.isEmpty, "任务列表或原操作恢复状态不符")
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
        let working = try await agent.data("hetu.working_copies.create", input: ["task_ref": ref, "artifact_kind": .string("text"), "source_format": .string("markdown"),
            "title": .string("持续改稿"), "base_refs": .array([fixed["request"]["input_refs"].array[0]]), "patches": .array(patches), "operation_key": .string("working")])
        await session.loadTask(ref)
        let feedback = await session.mutate("hetu.task_feedback.save", input: ["task_ref": ref,
            "target_refs": .array([.object(["kind": .string("working_copy"), "working_copy_ref": working["working_copy_ref"]])]),
            "expected_feedback_head": .null, "intent": .string("request_changes"), "public_comment": .string("保留最后一句，只调整灯光。"),
            "selected_refs": .array([]), "operation_key": .string("author-feedback")])
        try creativeCheck(feedback?["delivery_state"].string == "not_requested" && model.pendingStructureOperations.isEmpty, "公开意见保存未清理原操作或错误声明已发送")
        let next = try await agent.data("hetu.working_copies.save", input: ["task_ref": ref, "working_copy_id": working["working_copy_ref"]["working_copy_id"],
            "expected": working["working_copy_ref"], "patches": .array([patches[0]]), "feedback_refs": .array([feedback!["feedback_ref"]]), "operation_key": .string("follow-up")])
        _ = try await agent.data("hetu.creative_tasks.submit_result", input: ["task_ref": ref, "request_sha256": fixed["request_sha256"],
            "working_copy_refs": .array([next["working_copy_ref"]]), "feedback_refs": .array([feedback!["feedback_ref"]]), "complete": .bool(true), "missing_items": .array([]),
            "provenance": .object(["client": .string("native-test"), "skill_version": .string("1")]), "operation_key": .string("follow-up-submit")])
        await session.loadTask(ref)
        let opinions = await session.read("hetu.task_feedback.list", input: ["task_ref": ref])
        try creativeCheck(opinions?["feedback"].array.first?["reported_result_refs"].array.count == 2 && model.text.hasSuffix("先不保存。"), "返工记录缺失或作者缓冲被覆盖")
        async let planRead = session.read("hetu.model_tasks.list", input: ["task_ref": ref])
        async let feedbackRead = session.read("hetu.task_feedback.list", input: ["task_ref": ref])
        async let contextRead = session.read("hetu.task_context.list", input: ["task_ref": ref])
        let concurrent = await (planRead, feedbackRead, contextRead)
        try creativeCheck(concurrent.0 != nil && concurrent.1?["feedback"].array.count == 1 && concurrent.2 != nil,
            "协作面板并发只读被全局忙碌状态丢弃")
        try creativeCheck(!model.busy && model.text.hasSuffix("先不保存。") && model.needsProtection,
            "并发回读改变作者缓冲或遗留忙碌状态")
        let forbiddenWrite = await session.read("hetu.creative_tasks.close", input: ["task_ref": ref,
            "expected": session.task["expected"], "reason": .string("不能从只读入口执行"), "operation_key": .string("read-must-not-write")])
        try creativeCheck(forbiddenWrite == nil && session.pending == nil, "只读面板可绕过事务恢复执行写入")
        await session.loadTask(ref)
        try creativeCheck(session.task["observation"]["state"].string != "closed", "只读入口意外关闭任务")
        let prompt = try TaskContinuation.prompt(task: session.task, feedbackRef: feedback!["feedback_ref"], locale: "zh-CN")
        try creativeCheck(prompt.contains("hetu_list_task_feedback") && !prompt.contains(original), "继续提示词缺少恢复入口或携带作者正文")
        let english = try TaskContinuation.prompt(task: session.task, feedbackRef: feedback!["feedback_ref"], locale: "en")
        try creativeCheck(english.hasPrefix("Continue the same") && english.contains(feedback!["feedback_ref"]["feedback_id"].string!), "英文继续提示词没有保留原意见引用")
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
        try creativeCheck(session.error == nil && session.task["observation"]["state"].string == "closed", "任务关闭失败：\(session.error ?? String(describing: session.task))")
        let rejected = try await agent.request("hetu.creative_tasks.get", input: ["task_ref": ref])
        try creativeCheck(rejected["error"]["code"].string == "forbidden", "旧任务进程未随关闭失权：\(rejected)")
        print("创作任务：空白作品首章参考、固定改稿、公开反馈、同稿返工、局部采纳及关闭撤权通过")

        let creationURL = root.appendingPathComponent("无书名筹备")
        let project = try await Workspace.openCreationProject(at: creationURL, brief: "先有一个想法", operationKey: "creation")
        let discovery = try await project.data("hetu.capabilities.get")
        try creativeCheck(discovery["scope_ref"]["kind"].string == "creation_project" && !FileManager.default.fileExists(atPath: creationURL.appendingPathComponent(".heturc.json").path), "无书名筹备创建了假作品")

        let artwork = CreativeTaskSession(model: model)
        await artwork.previewWriting(kind: .artwork, contextIDs: [], includeBible: true, includeCurrent: false, client: .codex, brief: "绘制雾港场景参考，不替换封面。")
        await artwork.prepare(prompt: artwork.preview["prompt"].string ?? "")
        try creativeCheck(artwork.error == nil && artwork.task["request"]["skill_ref"]["name"].string == "hetu-artwork"
            && artwork.task["request"]["output_contract"]["artifact_types"].array == [.string("image")], "素材图没有独立图片合同或对应方法")
    }
}
