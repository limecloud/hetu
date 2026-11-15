import CryptoKit
import Foundation
import HetuCore
import HetuNative

/// 对真实导入记录做只读原生集成验收；书库、偏好与恢复目录均隔离。
@MainActor enum ImportedWorkReviewTests {
    struct Failure: Error { let message: String }
    static func check(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure(message: message) }
    }
    static func read(_ url: URL) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url)) }

    static func run(root: URL, recordDirectory: URL, preferences: UserDefaults) async throws {
        let state = try read(recordDirectory.appendingPathComponent("workspace.json"))
        let journal = try read(recordDirectory.appendingPathComponent("journal.json"))
        let plan = try read(recordDirectory.appendingPathComponent("plan.json"))
        let imported = journal["imported"].array
        guard let path = state["target_path"].string, !imported.isEmpty else { throw Failure(message: "缺少已完成导入记录") }
        try check(journal["next_index"].integer == Int64(imported.count), "导入尚未完成")
        let model = WorkspaceModel(locale: "zh-CN", recovery: RecoveryStore(directory: root.appendingPathComponent("恢复")), preferences: preferences,
            library: LibraryStore(directory: root.appendingPathComponent("书库"), collaborationDirectory: root.appendingPathComponent("隔离授权")))
        let clock = ContinuousClock(), start = clock.now
        try check(await model.open(URL(fileURLWithPath: path)), "原生打开失败：\(model.message ?? "")")
        let openTime = start.duration(to: clock.now)
        try check(model.orderedChapters.map(\.id) == imported.compactMap { $0["document_id"].string }, "原生章节目录截断或乱序")
        try check(model.orderedChapters.map(\.title) == plan["units"].array.compactMap { $0["title"].string }, "原生章节标题与导入计划不符")
        try check(model.volumes.count == plan["volumes"].array.count, "原生分卷丢失")
        for index in Set([0, imported.count / 2, imported.count - 1]).sorted() {
            let expected = imported[index]
            try check(await model.selectDocument(expected["document_id"].string!), "无法阅读第\(index + 1)篇：\(model.message ?? "")")
            let digest = SHA256.hash(data: Data(model.text.utf8)).map { String(format: "%02x", $0) }.joined()
            try check(model.baseRevisionID == expected["revision_id"].string && digest == expected["sha256"].string, "原生正文修订或摘要不符")
            model.locale = "en"
            try check(model.text == model.savedText && !model.needsProtection, "切换语言改变了原文")
            model.locale = "zh-CN"
        }
        let adaptation = recordDirectory.appendingPathComponent("改编参考/acceptance.json")
        if FileManager.default.fileExists(atPath: adaptation.path) {
            let result = try read(adaptation)
            guard let workspace = model.workspace else { throw Failure(message: "原生上下文丢失") }
            let project = try await workspace.data("hetu.drama.projects.get", input: ["project_id": result["project_id"]])
            try check(project["project"]["mode"].string == "adaptation", "改编项目类型不符")
            let novelCanon = model.bible["blueprint"]["blueprint_id"]
            let dramaRef = try WorkReference(.object(["workspace_id": .string(model.workspaceID), "kind": .string("drama"), "object_id": result["project_id"]]))
            try check(await model.open(URL(fileURLWithPath: path), workReference: dramaRef), "无法切到原著关联的剧本工作面")
            try check(model.workReference == dramaRef && (!model.bibleInitialized || model.bible["blueprint"]["blueprint_id"] != novelCanon), "旧改编项目被静默借用原著设定")
            for item in result["reference_episodes"].array {
                let episode = try await workspace.data("hetu.drama.episodes.get", input: ["episode_id": item["episode_id"]])
                let document = try await workspace.data("hetu.documents.get", input: ["document_id": episode["episode"]["document_id"]])
                try check(document["content"].string == "", "参考稿被提前写成作者正文")
                try check(await model.selectDocument(episode["episode"]["document_id"].string!), "无法打开本集的作者稿缓冲")
                let reader = EpisodeReadingSession(model: model)
                await reader.load(item["episode_id"].string!)
                try check(reader.error == nil && !reader.isAuthor && !reader.content.isEmpty, "分集入口未展示已有参考稿：\(reader.error ?? "")")
                try check(reader.selectedReference["task_ref"]["task_id"] == item["task_ref"]["task_id"], "分集读到了其他任务成果")
                try check(reader.selectedReference["sha256"] == item["working_copy_ref"]["sha256"], "分集阅读没有固定交付修订")
                try check(!ScreenplayReading.paragraphs(reader.content).filter { $0.kind == .scene }.isEmpty, "分集没有可读场次")
                await reader.select(-1)
                try check(reader.isAuthor && reader.error == nil && reader.content.isEmpty, "切换作者稿误读参考稿")
                let buffer = model.text + "\n作者尚未保存的测试意见"
                model.edit(buffer)
                await reader.load(item["episode_id"].string!)
                try check(model.text == buffer && model.needsProtection, "分集阅读覆盖了作者未保存内容")
                model.edit(model.savedText)
                reader.clear()
                try check(reader.episode == .null && reader.content.isEmpty && reader.isAuthor, "空项目仍显示前一分集")
                let taskReference: JSONValue = .object(["scope_ref": item["task_ref"]["scope_ref"], "task_id": item["task_ref"]["task_id"], "request_revision": item["task_ref"]["request_revision"]])
                let task = try await workspace.data("hetu.creative_tasks.get", input: ["task_ref": taskReference])
                try check(task["request_sha256"] == item["task_ref"]["sha256"], "原生任务请求摘要不符")
                try check(task["submission"]["submission_id"] == item["submission_ref"]["submission_id"], "原生无法读回固定提交")
                try check(task["submission"]["candidates"].array.first?["sha256"] == item["working_copy_ref"]["sha256"], "原生候选摘要不符")
                try check(model.drafts.contains { $0["draft_id"] == task["submission"]["candidates"].array.first?["draft_ref"]["draft_id"] }, "原生审核列表缺少剧本参考稿")
            }
            for item in result["resources"].array {
                let resource = try await workspace.data("hetu.resources.get", input: ["resource_id": item["resource_id"], "revision": item["revision"]])
                try check(resource["resource"]["state"].string == "draft" && resource["sha256"] == item["sha256"], "原生资料状态或固定修订不符")
            }
        }
        print("真实导入作品原生只读验收通过：\(imported.count)篇、\(model.volumes.count)组，首/中/尾正文、双语不改原文、改编候选及未采用资料；打开耗时 \(openTime)。此结果不替代GUI排版验收。")
    }
}
