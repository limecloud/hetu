import Foundation
import HetuCore
import HetuNative

private struct CreationTestFailure: Error { let message: String }
private func creationCheck(_ condition: Bool, _ message: String) throws {
    if !condition { throw CreationTestFailure(message: message) }
}

enum CreationProjectTests {
    @MainActor static func run(root: URL) async throws {
        let plans = root.appendingPathComponent("新书筹备")
        let recovery = RecoveryStore(directory: root.appendingPathComponent("筹备恢复"))
        let first = CreationProjectSession(locale: "zh-CN", directory: plans, recovery: recovery)
        first.brief = "港城悬疑，先不要替我决定书名。"
        try creationCheck(await first.save(), "空书名未能保存筹备")
        guard let project = first.workspace else { throw CreationTestFailure(message: "未创建独立筹备句柄") }
        try creationCheck(first.value("title").isEmpty && !first.dirty && !FileManager.default.fileExists(atPath: project.url.appendingPathComponent(".heturc.json").path), "筹备生成了虚构书名或正式作品")

        let next = CreationProjectSession(locale: "zh-CN", directory: plans, recovery: recovery)
        await next.loadProjects()
        try creationCheck(next.projects.count == 1 && next.projects[0].title.isEmpty, "保存的无书名筹备无法在列表恢复")
        await next.open(next.projects[0].url)
        try creationCheck(next.brief == first.brief && next.projectID == first.projectID, "重开筹备丢失想法或换了身份")
        await next.previewTask(kind: "book_concept", client: .codex, suiteID: "military")
        try creationCheck(next.preview["prompt"].string?.contains("hetu-military") == true, "建书提示词未使用作者选择的专用套件")
        await next.prepare(prompt: next.preview["prompt"].string ?? "")
        try creationCheck(next.task["request"]["scope_ref"]["kind"].string == "creation_project" && next.pending == nil, "建书任务没有限定筹备范围或未确认保存")
        let task = next.task, reference = next.taskReference
        let agent = try await Workspace.openCreationProject(at: project.url, mode: .agent, taskID: task["request"]["task_id"].string)
        let candidate: JSONValue = .object(["kind": .string("title"), "title": .string("书名参考"), "source_format": .string("plain"), "source_ref_indices": .array([]), "content": .string("雾港听潮")])
        _ = try await agent.data("hetu.creative_tasks.submit_result", input: ["task_ref": reference, "request_sha256": task["request_sha256"], "candidates": .array([candidate]),
            "complete": .bool(true), "missing_items": .array([]), "provenance": .object(["client": .string("native-planning-test"), "skill_version": .string("1")]), "operation_key": .string("planning-candidate")])
        await next.loadTask(reference)
        try creationCheck(next.value("title").isEmpty, "接收候选自动填入书名")
        next.select(next.task["submission"]["candidates"].array[0], field: "title")
        next.set("title", value: "雾港长夜")
        next.set("author_name", value: "南山")
        next.set("synopsis", value: "作者确认的简介。")
        try creationCheck(await next.save(), "作者修改的候选未能保存")
        try creationCheck(next.record["project"]["selected_fields"]["title"]["candidate_ref"]["task_ref"] == reference, "作者改写后丢失候选来源")

        let other = try await Workspace.openCreationProject(at: project.url)
        let before = try await other.data("hetu.creation_projects.get", input: ["project_id": .string(next.projectID)])
        _ = try await other.data("hetu.creation_projects.save", input: ["project_id": .string(next.projectID), "expected": .object(["revision": before["revision"], "sha256": before["sha256"]]),
            "brief": .string("另一窗口更新的要求"), "selected_fields": before["project"]["selected_fields"], "operation_key": .string("planning-other-window")])
        next.set("genre", value: "悬疑")
        try creationCheck(!(await next.save()) && next.value("genre") == "悬疑" && next.pending == nil, "筹备冲突覆盖了作者表单或被当成未知操作")
        await next.reload()
        let saveBeforeComparison = await next.save()
        try creationCheck(next.value("genre") == "悬疑" && next.conflict != .null && !saveBeforeComparison, "刷新冲突基线丢失资料或未经确认就允许覆盖")
        next.acceptConflictBaseline()
        try creationCheck(await next.save(), "比较最新基线后无法保存筹备")

        let occupied = root.appendingPathComponent("已有内容的目录")
        try FileManager.default.createDirectory(at: occupied, withIntermediateDirectories: true)
        try Data("请保留".utf8).write(to: occupied.appendingPathComponent("原稿.txt"))
        try creationCheck(await next.createNovel(at: occupied, language: "zh-CN") == nil && next.pending == nil, "创建覆盖了非空目录或留下错误恢复请求")
        try creationCheck(String(data: Data(contentsOf: occupied.appendingPathComponent("原稿.txt")), encoding: .utf8) == "请保留", "非空目录中的原稿被修改")
        let target = root.appendingPathComponent("确认创建的小说")
        guard let result = await next.createNovel(at: target, language: "zh-CN") else { throw CreationTestFailure(message: "作者确认后创建失败：\(next.error ?? "unknown")") }
        try creationCheck(next.pending?.action == "hetu.creation_projects.create_novel", "打开新作品前过早丢弃创建回执")

        // 模拟创建已完成但窗口退出，仍沿原键、原目标读取同一作品。
        let resumed = CreationProjectSession(locale: "en", directory: plans, recovery: recovery)
        await resumed.open(project.url)
        try creationCheck(resumed.completed && resumed.pending != nil, "重启没有识别已提交但未登记的创建请求")
        await resumed.recover()
        let restoredPath = resumed.created["target_path"].string.map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path }
        try creationCheck(resumed.created["created_workspace_ref"] == result["created_workspace_ref"] && restoredPath == target.resolvingSymlinksInPath().path, "恢复创建换了身份或目标目录")
        let book = try await Workspace.open(at: target, mode: .author)
        let novel = try await book.data("hetu.novels.get")
        try creationCheck(novel["novel"]["metadata"]["title"].string == "雾港长夜" && novel["novel"]["metadata"]["author_name"].string == "南山", "新作品不是作者确认的资料")
        await resumed.acknowledgeCreatedWorkspace()
        let remaining = try await recovery.structureOperations(workspaceID: resumed.projectID)
        try creationCheck(resumed.pending == nil && remaining.isEmpty, "确认登记后未清理原操作恢复记录")
        await resumed.loadProjects()
        try creationCheck(resumed.projects.isEmpty, "已登记的新作品仍作为待创建筹备显示")
        print("建书筹备：空书名、重启恢复、外部候选、来源、CAS冲突、目录保护和原键创建恢复通过")
    }
}
