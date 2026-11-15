import Foundation
import HetuCore
import HetuNative

enum PageHandoffTests {
    struct Failure: Error { let message: String }
    private static func check(_ value: Bool, _ message: String) throws { if !value { throw Failure(message: message) } }
    @MainActor static func run(root: URL) async throws {
        let work = root.appendingPathComponent("页面交接 '$(test) 中文")
        let name = "run.limeai.hetu.page-handoff.\(UUID().uuidString)"
        let preferences = UserDefaults(suiteName: name)!
        preferences.set(false, forKey: "Hetu.editor.autosave")
        defer { preferences.removePersistentDomain(forName: name) }
        let recovery = RecoveryStore(directory: root.appendingPathComponent("交接恢复"))
        let model = WorkspaceModel(locale: "zh-CN", recovery: recovery, preferences: preferences, library: LibraryStore(directory: root.appendingPathComponent("交接书库")))
        try check(await model.open(work, title: "渡口"), "未创建隔离作品")
        guard let id = await model.createDocument(title: "第一章", kind: "novel_chapter"), await model.selectDocument(id) else { throw Failure(message: "未打开章节：\(model.message ?? "无业务错误")；busy=\(model.busy)，writeLocked=\(model.writeLocked)") }
        model.edit("已保存的中文稿🌧️")
        try check(await model.save(), "未保存原稿")
        let saved = model.baseRevisionID
        model.edit("不得交接的未保存缓冲")
        let agent = try await Workspace.open(at: work, mode: .agent)
        let context = try await agent.data("hetu.handoffs.get", input: ["view_kind": .string("document"), "object_ref": .object(["document_id": .string(id), "revision_id": .string(saved)])])
        try check(context["fixed_refs"].array.first?["revision_id"].string == saved, "页面未交接固定修订")
        let grant = try await model.workspace!.data("hetu.collaboration.authorize_workspace", input: ["client_adapter": .string("codex"), "collaboration_path": .string(root.appendingPathComponent("稳定交接").path), "operation_key": .string("workspace-grant")])
        for locale in ["zh-CN", "en"] {
            let prompt = try PageHandoff.prompt(context: context, workspace: work, executable: URL(fileURLWithPath: "/Applications/Hetu.app/Contents/Helpers/hetu"), locale: locale, suite: "historical", clientAdapter: "codex", managementRef: grant["management_ref"])
            try check(prompt.contains(saved) && prompt.contains(id), "提示词丢失当前对象或版本")
            try check(!prompt.contains(model.text), "未保存缓冲泄漏到交接")
            try check(prompt.contains("--client codex") && !prompt.contains("--workspace"), "页面未使用稳定客户端连接")
            try check(prompt.contains("hetu.agent_operations.prepare") && prompt.contains("hetu.agent_operations.execute"), "未接续真实管理动作")
        }
        let empty = try await agent.data("hetu.agent_operations.list")
        try check(empty["proposals"].array.isEmpty, "无方案状态读取失败")
        let before = try await agent.data("hetu.novels.get")
        var metadata = before["novel"]["metadata"].object
        metadata["synopsis"] = .string("Agent 填写的新简介")
        let proposal = try await agent.data("hetu.agent_operations.prepare", input: ["action": .string("hetu.novels.update"), "input": .object(["expected": .object(["revision": before["revision"], "sha256": before["sha256"]]), "metadata": .object(metadata), "operation_key": .string("metadata")]), "summary": .string("更新简介"), "operation_key": .string("prepare")])
        let decisionInput: [String: JSONValue] = ["proposal_id": proposal["proposal_id"], "proposal_sha256": proposal["proposal_sha256"], "expected_state_revision": .integer(1), "decision": .string("approve"), "operation_key": .string("approve")]
        let pending = PendingStructureOperation(workspaceID: model.workspaceID, action: "hetu.agent_operations.decide", input: decisionInput)
        try await recovery.writeOperation(pending)
        var decisionError: String?
        let decision = await model.workspaceAction(pending.action, input: pending.input) { message, _ in decisionError = message }
        try check(decision?["state"].string == "approved" && decisionError == nil, "原生作者批准未通过可恢复操作链")
        try check(try await recovery.structureOperations(workspaceID: model.workspaceID).isEmpty, "作者批准后遗留了待恢复操作")
        _ = try await agent.data("hetu.agent_operations.execute", input: ["proposal_id": proposal["proposal_id"], "proposal_sha256": proposal["proposal_sha256"], "operation_key": .string("execute")])
        await model.refresh()
        try check(model.novelMetadata["synopsis"].string == "Agent 填写的新简介", "机器执行结果未进入页面投影")
        try check(model.text == "不得交接的未保存缓冲" && model.baseRevisionID == saved && model.needsProtection, "刷新管理结果覆盖了未保存原稿或保存基线")
        print("页面交接与管理方案 Native 专项通过")
    }
}
