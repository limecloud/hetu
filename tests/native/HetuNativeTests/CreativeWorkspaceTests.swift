import Foundation
import HetuCore
import HetuNative

enum CreativeWorkspaceTests {
    struct Failure: Error { let message: String }
    static func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure(message: message) }
    }
    @MainActor static func run(root: URL) async throws {
        let recovery = RecoveryStore(directory: root.appendingPathComponent("剧本资料恢复"))
        let planning = CreationProjectSession(locale: "zh-CN", directory: root.appendingPathComponent("剧本筹备"), recovery: recovery)
        planning.set("title", value: "渡口重逢"); planning.set("synopsis", value: "两个故人在渡口重逢。")
        planning.setWorkProfile(workType: "drama", dramaMode: "original", languageTag: "zh-CN")
        try require(await planning.save(), "剧本筹备选择未保存")
        let restoredPlan = CreationProjectSession(locale: "en", directory: root.appendingPathComponent("剧本筹备"), recovery: recovery)
        await restoredPlan.open(planning.workspace!.url)
        try require(restoredPlan.workType == "drama" && restoredPlan.dramaMode == "original" && restoredPlan.languageTag == "zh-CN" && !restoredPlan.dirty, "重开筹备改变了剧本类型、改编方式或正文语言")
        planning.brief = "准备渡口重逢的原创短剧。"
        await planning.previewTask(kind: "book_concept", client: .codex, suiteID: "general")
        try require(planning.preview["input_snapshot"]["scope_context"]["work_profile"]["work_type"].string == "drama", "构思任务没有包含剧本创作类型")
        let target = root.appendingPathComponent("原创剧本作品")
        guard let created = await planning.createNovel(at: target, language: "zh-CN") else { throw Failure(message: "新建原创剧本失败：\(planning.error ?? "")") }
        try require(!FileManager.default.fileExists(atPath: target.appendingPathComponent("packages/novel/novel.json").path), "原创剧本创建了空小说")
        let preferencesName = "run.limeai.hetu.creative.\(UUID().uuidString)"
        let preferences = UserDefaults(suiteName: preferencesName)!
        preferences.set(false, forKey: "Hetu.editor.autosave")
        defer { preferences.removePersistentDomain(forName: preferencesName) }
        let library = LibraryStore(directory: root.appendingPathComponent("剧本作品库"))
        let model = WorkspaceModel(recovery: recovery, preferences: preferences, library: library)
        try require(await model.open(target), "Mac 无法打开无小说的剧本作品")
        try require(model.workType == "drama" && model.novel["initialized"].bool == false, "作品类型或小说状态错误")
        let originalTask = CreativeTaskSession(model: model)
        await originalTask.previewWriting(kind: .dramaDraft, contextIDs: [], includeBible: false, includeCurrent: false, client: .codex, brief: "原创短剧渡口重逢，先起草一场对白，不依赖原著。")
        try require(originalTask.preview["prepare_input"]["task_kind"].string == "drama_draft" && originalTask.preview["prepare_input"]["input_refs"].array.isEmpty, "原创短剧被要求提供小说或骨架")
        await originalTask.prepare(prompt: originalTask.preview["prompt"].string ?? "")
        try require(originalTask.task["request"]["skill_ref"]["name"].string == "hetu-drama" && model.documents.isEmpty, "原创剧本任务没有专用方法或创建了正式空稿")
        let scriptAgent = try await Workspace.open(at: target, mode: .agent, taskID: originalTask.task["request"]["task_id"].string)
        let scriptCopy = try await scriptAgent.data("hetu.working_copies.create", input: ["task_ref": originalTask.taskReference, "artifact_kind": .string("text"), "source_format": .string("fountain"), "title": .string("渡口重逢参考"), "base_refs": .array([]), "content": .string("INT. 渡口 - DAY\n\n林舟放下一封信。\n\n林舟\n这是你的信。\n"), "operation_key": .string("original-working")])
        _ = try await scriptAgent.data("hetu.creative_tasks.submit_result", input: ["task_ref": originalTask.taskReference, "request_sha256": originalTask.task["request_sha256"], "working_copy_refs": .array([scriptCopy["working_copy_ref"]]), "complete": .bool(true), "missing_items": .array([]), "provenance": .object(["client": .string("native-test"), "skill_version": .string("1")]), "operation_key": .string("original-submit")])
        await originalTask.loadTask(originalTask.taskReference)
        try require(originalTask.task["submission"]["candidates"].array.first?["draft_ref"]["draft_id"].string != nil && model.documents.allSatisfy { $0.value["draft_source_id"] != .null }, "原创剧本参考未固定为可比较草稿或覆盖正式稿")
        await planning.acknowledgeCreatedWorkspace()
        var message = ""
        func action(_ name: String, _ input: [String: JSONValue]) async throws -> JSONValue {
            guard let result = await model.workspaceAction(name, input: input, onFailure: { message = $0; _ = $1 }) else { throw Failure(message: "\(name)：\(message)") }
            return result
        }
        let project = created["drama_project"]
        let projectRef: JSONValue = .object(["project_id": project["project"]["project_id"], "revision": project["project"]["revision"], "sha256": project["sha256"]])
        let episode = try await action("hetu.drama.episodes.create", ["project_ref": projectRef, "title": .string("初见"), "plan": .string("故人发现一封未寄出的信。"), "language_tag": .string("zh-CN"), "operation_key": .string("native-episode")])
        let documentID = episode["document"]["document_id"].string ?? ""
        try require(model.documents.contains { $0.id == documentID }, "新分集没有刷新原生剧本列表")
        try require(await model.selectDocument(documentID), "无法进入分集剧本")
        let text = "INT. 渡口候船室 - DAY\n\n林舟放下一封信。🌿\n\n林舟\n这是你的信。\n"
        model.edit(text)
        try require(await model.save(), "原生剧本保存失败")
        let savedRevision = model.baseRevisionID
        let bufferedText = text + "\n作者未保存的补写。\n"
        model.edit(bufferedText)
        _ = try await action("hetu.drama.episodes.update", ["project_ref": .object(["project_id": episode["project"]["project_id"], "revision": episode["project"]["revision"], "sha256": episode["sha256"]]),
            "episode_id": episode["episode"]["episode_id"], "expected": .object(["revision": episode["episode"]["revision"], "sha256": episode["episode_sha256"]]), "title": .string("未寄出的信"), "plan": .string("保留原计划。"), "archived": .bool(false), "operation_key": .string("native-episode-title")])
        try require(model.documents.first { $0.id == documentID }?.title == "未寄出的信" && model.documentTitle == "未寄出的信", "分集改名后剧本目录或编辑器显示旧标题")
        try require(model.text == bufferedText && model.dirty && model.baseRevisionID == savedRevision, "修改分集资料改变了未保存的编辑缓冲或保存基线")

        let fields: [String: JSONValue] = ["title": .string("渡口考据"), "category": .string("research"), "body": .string("船只靠岸🌿\r\n保留作者笔记。"), "tags": .array([.string("渡口")]), "project_id": .null, "entity_refs": .array([]), "source_notes": .string("测试资料")]
        var input = fields; input["operation_key"] = .string("native-reference")
        let reference = try await action("hetu.resources.create", input)
        let operation = PendingStructureOperation(workspaceID: model.workspaceID, action: "hetu.resources.create", input: input)
        try await recovery.writeOperation(operation)
        let reopened = WorkspaceModel(recovery: recovery, preferences: preferences, library: library)
        try require(await reopened.open(target) && reopened.pendingStructureOperations == [operation], "重开没有加载资料原操作")
        let replay = await reopened.workspaceAction(operation.action, input: operation.input, onFailure: { message = $0; _ = $1 })
        try require(replay == reference && reopened.pendingStructureOperations.isEmpty, "恢复资料保存未返回原回执或未清理恢复记录")
        let list = try await action("hetu.resources.list", [:])
        try require(list["resources"].array.count == 1, "恢复重复创建资料")

        let task = CreativeTaskSession(model: model)
        let fixed: JSONValue = .object(["resource_id": reference["resource"]["resource_id"], "revision": reference["resource"]["revision"], "sha256": reference["sha256"]])
        await task.previewResources(references: [fixed], editableIDs: [reference["resource"]["resource_id"].string!], allowCreate: true, client: .codex, brief: "补充人物称呼和地点参考")
        try require(task.preview["prepare_input"]["resource_scope"]["resource_refs"].array == [fixed], "资料任务丢失固定授权")
        await task.prepare(prompt: task.preview["prompt"].string ?? "")
        try require(task.task["request"]["skill_ref"]["name"].string == "hetu-resources" && task.pending == nil, "资料任务没有接入专用 Skill 或遗留操作")
        let agent = try await Workspace.open(at: target, mode: .agent, taskID: task.task["request"]["task_id"].string)
        var edit = fields; edit["resource_id"] = reference["resource"]["resource_id"]; edit["expected"] = .object(["revision": reference["resource"]["revision"], "sha256": reference["sha256"]]); edit["body"] = .string("Agent 整理后的未采用资料"); edit["operation_key"] = .string("native-agent-reference")
        _ = try await agent.data("hetu.resources.update", input: edit)
        try require(model.text == bufferedText, "资料协作修改了作者剧本缓冲")
        await task.close(reason: "作者结束整理")
        let denied = try await agent.request("hetu.resources.update", input: edit)
        try require(denied["error"]["code"].string == "forbidden", "结束资料任务后原进程仍可写入")
        try require(await model.saveCharacter(id: nil, name: "林舟", aliases: [], description: "渡口故人", traits: []), "资料关联测试无法建人物")
        let catalog = ResourceAssociations()
        await catalog.load(model: model)
        try require(catalog.error == nil, "资料关联目录读取失败：\(catalog.error ?? "")")
        guard let character = catalog.options.first(where: { $0.kind == "character" && $0.title == "林舟" }) else { throw Failure(message: "关联选择器没有读取当前人物") }
        try require(character.reference["blueprint_revision"] == model.bible["revision"] && character.reference["blueprint_sha256"] == model.bible["sha256"], "关联选择器没有固定当前作品的设定修订")
        var linkedInput = fields
        linkedInput["title"] = .string("林舟衣着")
        linkedInput["category"] = .string("character")
        linkedInput["project_id"] = project["project"]["project_id"]
        linkedInput["entity_refs"] = .array([character.reference])
        linkedInput["operation_key"] = .string("native-linked-resource")
        let linked = try await action("hetu.resources.create", linkedInput)
        try require(await model.saveCharacter(id: character.reference["entity_id"].string, name: "林川", aliases: [], description: "作者修订姓名", traits: []), "人物改名失败")
        await catalog.load(model: model, projectID: project["project"]["project_id"].string, references: linked["resource"]["entity_refs"].array)
        try require(catalog.error == nil && catalog.title(for: character.reference) == "林舟", "资料关联被最新设定名覆盖或固定摘要不符")
        try require(catalog.options.contains { $0.title == "林川" && catalog.sameEntity($0.reference, character.reference) }, "同一人物改名后关联身份丢失")
        try require(catalog.projects.contains { $0["project"]["project_id"] == project["project"]["project_id"] }, "关联目录未载入所选项目")
        // 新实例没有旧缓存，固定历史引用仍须能从内核重新读取。
        let reopenedCatalog = ResourceAssociations()
        await reopenedCatalog.load(model: model, references: linked["resource"]["entity_refs"].array)
        try require(reopenedCatalog.error == nil && reopenedCatalog.title(for: character.reference) == "林舟"
            && reopenedCatalog.options.contains { $0.title == "林川" && reopenedCatalog.sameEntity($0.reference, character.reference) }, "重开关联目录没有读取固定历史设定或当前作品人物")
        let projectResources = try await action("hetu.resources.list", ["project_id": project["project"]["project_id"]])
        let sharedResources = try await action("hetu.resources.list", ["project_id": .null])
        try require(projectResources["resources"].array.map { $0["resource_id"] } == [linked["resource"]["resource_id"]] && sharedResources["resources"].array.map { $0["resource_id"] } == [reference["resource"]["resource_id"]], "项目资料与作品通用资料筛选串位")
        try require(model.text == bufferedText && model.baseRevisionID == savedRevision, "管理资料关联改变了作者未保存剧本或基线")
        model.locale = "en"
        try require(model.t("resources.title") == "Written references" && model.text == bufferedText, "英文界面缺译或改变作者原文")
        print("剧本与资料：原创创建、分集、作者编辑、目录刷新、资料原键恢复、固定设定关联、项目筛选、任务授权与撤权通过")
    }
}
