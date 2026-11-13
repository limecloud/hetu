import AppKit
import Foundation
import HetuCore
import HetuNative

private struct CheckFailure: Error { let message: String }
private func check(_ value: Bool, _ message: String) throws { if !value { throw CheckFailure(message: message) } }

@main struct NativeTests {
    @MainActor static func main() async {
        do { try await run() }
        catch { FileHandle.standardError.write(Data("Mac 原生检查失败：\(error)\n".utf8)); exit(1) }
    }
    @MainActor static func run() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("河图 Native \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let recovery = RecoveryStore(directory: root.appendingPathComponent("Recovery"))
        let preferencesName = "run.limeai.hetu.tests.\(UUID().uuidString)"
        let preferences = UserDefaults(suiteName: preferencesName)!
        defer { preferences.removePersistentDomain(forName: preferencesName) }
        if CommandLine.arguments.contains("--creation-projects") { try await CreationProjectTests.run(root: root); return }
        if CommandLine.arguments.contains("--covers") { try await CoverTests.run(root: root); return }
        if CommandLine.arguments.contains("--window-layout") { try WindowLayoutTests.run(); return }
        if CommandLine.arguments.contains("--local-task-view") { try await LocalTaskViewTests.run(root: root); return }
        if CommandLine.arguments.contains("--media") { try await mediaTests(root, recovery: recovery, preferences: preferences); return }
        if CommandLine.arguments.contains("--agent-integration") {
            try agentIntegrationTests(root, preferences: preferences)
            try await AgentInstallerTests.run(root: root)
            return
        }
        try agentIntegrationTests(root, preferences: preferences)
        try await AgentInstallerTests.run(root: root)
        try await CreativeTaskTests.run(root: root)
        try await CreationProjectTests.run(root: root)
        try await CoverTests.run(root: root)
        try WindowLayoutTests.run()
        try await LocalTaskViewTests.run(root: root)
        let model = WorkspaceModel(locale: "zh-CN", recovery: recovery, preferences: preferences, library: LibraryStore(directory: await recovery.directory.appendingPathComponent("Library")))
        let workspaceURL = root.appendingPathComponent("中文作品")
        try check(await model.open(workspaceURL, title: "雾港"), "原生状态未创建工作区")
        try check(model.title == "雾港", "未读取真实作品名称")
        guard let id = await model.createDocument(title: "第一章", kind: "novel_chapter") else { throw CheckFailure(message: "未创建章节") }
        try check(await model.selectDocument(id), "未读取章节")
        model.edit("你好，雾港。🌿 don't stop")
        try check(await model.persistRecovery(), "未持久恢复稿")
        let copies = try await recovery.list(workspaceID: model.workspaceID, documentID: id)
        try check(copies.count == 1 && copies[0].content == model.text, "恢复稿正文错误")
        model.locale = "en"
        try check(model.text == "你好，雾港。🌿 don't stop" && model.t("document.save") == "Save Revision", "语言切换改变正文或缺英文")
        try check(await model.save(), "未保存正文修订")
        try check(!model.needsProtection && model.savedText == model.text, "保存后缓冲状态错误")
        try check(try await recovery.list(workspaceID: model.workspaceID, documentID: id).isEmpty, "已保存恢复稿未清理")

        let second = WorkspaceModel(locale: "zh-CN", recovery: recovery, preferences: preferences, library: LibraryStore(directory: await recovery.directory.appendingPathComponent("Library")))
        try check(await second.open(workspaceURL), "第二窗口未打开同一作品")
        try check(await second.selectDocument(id), "第二窗口未读取同一章节")
        second.edit("第二窗口保留的内容")
        model.edit("第一窗口的新修订")
        try check(await model.save(), "第一窗口保存失败")
        try check(!(await second.save()), "第二窗口未拦截过期基线")
        try check(second.conflict["content"].string == "第一窗口的新修订" && second.text == "第二窗口保留的内容", "冲突丢失正文")
        await second.acceptConflictBaseline()
        try check(await second.save(), "确认基线后未保存")

        model.edit("重启后恢复内容 👨‍👩‍👧‍👦")
        try check(await model.persistRecovery(), "未保留重启恢复稿")
        let restart = WorkspaceModel(locale: "en", recovery: recovery, preferences: preferences, library: LibraryStore(directory: await recovery.directory.appendingPathComponent("Library")))
        try check(await restart.open(workspaceURL), "重启未打开作品")
        try check(await restart.selectDocument(id), "重启未读取章节")
        guard let candidate = restart.recoveryCandidates.first else { throw CheckFailure(message: "未发现恢复候选") }
        try check(await restart.restore(candidate), "未恢复候选")
        try check(restart.text == model.text, "恢复内容不一致")
        let allCopies = try await recovery.list(workspaceID: model.workspaceID, documentID: id)
        try check(allCopies.count == 2 && Set(allCopies.map(\.windowID)).count == 2, "恢复稿多窗口互相覆盖")
        try check(!(await restart.save()) && restart.conflict != .null, "旧恢复基线绕过 CAS")

        // 模拟：保存已落盘，但客户端未接收结果；恢复时必须重放原键与原输入。
        let direct = try await Workspace.open(at: workspaceURL, mode: .author)
        let head = try await direct.data("hetu.documents.get", input: ["document_id": .string(id)])
        let operationKey = UUID().uuidString
        let pending = PendingSave(operationKey: operationKey, baseRevisionID: head["revision"]["revision_id"].string!, content: "未知结果重放")
        let committed = try await direct.data("hetu.documents.save", input: ["document_id": .string(id), "base_revision_id": .string(pending.baseRevisionID), "source_format": .string("markdown"), "content": .string(pending.content), "operation_key": .string(operationKey)])
        let pendingCopy = RecoveryEntry(workspaceID: model.workspaceID, documentID: id, windowID: UUID(), baseRevisionID: pending.baseRevisionID, title: "第一章", content: pending.content, pendingSave: pending)
        try await recovery.write(pendingCopy)
        let unknown = WorkspaceModel(locale: "zh-CN", recovery: recovery, preferences: preferences, library: LibraryStore(directory: await recovery.directory.appendingPathComponent("Library")))
        try check(await unknown.open(workspaceURL), "恢复保存结果时未打开")
        try check(await unknown.selectDocument(id), "恢复保存结果时未读取")
        try check(await unknown.restore(pendingCopy), "未恢复原保存请求")
        unknown.edit("保存之后继续输入")
        try check(await unknown.save(), "原键重放失败")
        try check(unknown.baseRevisionID == committed["revision"]["revision_id"].string && unknown.text == "保存之后继续输入" && unknown.dirty, "原键重放重复保存或覆盖了新输入")
        try check(await unknown.save(), "原键确认后新输入未保存")
        try check(!unknown.needsProtection, "新输入未完成保存")

        try check(await model.saveCharacter(id: nil, name: "林舟", aliases: ["守夜人"], description: "雾港巡夜人", traits: ["谨慎"]), "角色保存失败")
        await model.setLocked(true, reason: "设定确认")
        try check(model.locked, "未锁定设定")
        try check(!(await model.saveCharacter(id: nil, name: "越界", aliases: [], description: "", traits: [])), "锁定后仍能新增角色")
        model.message = nil
        await model.setLocked(false, reason: "作者修订")
        try check(!model.locked, "未解锁设定")
        try await bibleTests(model, workspaceURL: workspaceURL, recovery: recovery, preferences: preferences)
        try await plotTests(model)
        try await structureRecoveryTests(workspaceURL, recovery: recovery, preferences: preferences)
        try await reviewTests(workspaceURL, recovery: recovery, preferences: preferences)
        try await lifecycleTests(root.appendingPathComponent("定稿与采纳"), recovery: recovery, preferences: preferences)
        try await mediaTests(root, recovery: recovery, preferences: preferences)
        try await gitTests(root, recovery: recovery, preferences: preferences)
        try await libraryTests(root, recovery: recovery, preferences: preferences)

        let stats = TextStatistics.count("汉字🌿👨‍👩‍👧‍👦 don't cafe\u{301} café")
        try check(stats.han == 2 && stats.latinWords == 3 && TextStatistics.count("e\u{301}").graphemes == 1 && TextStatistics.count("e\u{301}lan").latinWords == 1, "中英混排或组合字符统计错误")
        try check(Localizer(locale: "en").text("unsaved.title", ["title": "雾港"]) == "Save changes to “雾港”?", "具名占位符未本地化")
        try check(Localizer(locale: "en").byteCount(23) == "23 bytes" && Localizer(locale: "zh-CN").byteCount(23).contains("字节"), "文件大小未使用应用语言")
        try check(Localizer(locale: "en").error(CoreError.business(.object(["error": .object(["code": .string("revision_conflict")])]))).hasPrefix("A newer"), "英文错误未映射")
        try await editorTests()
        // 测试目录只含本程序创建的数据。
        try FileManager.default.removeItem(at: root)
        print("Mac 原生：多作品书库、作品资料与卷章、编辑恢复、跨窗口 CAS、设定集、素材与线索修订／原键恢复、双语与 TextKit 检查通过")
    }
    @MainActor static func libraryTests(_ root: URL, recovery: RecoveryStore, preferences: UserDefaults) async throws {
        let library = LibraryStore(directory: root.appendingPathComponent("多作品书库"))
        let first = WorkspaceModel(locale: "zh-CN", recovery: recovery, preferences: preferences, library: library)
        let firstURL = root.appendingPathComponent("长篇小说 一")
        let secondURL = root.appendingPathComponent("独立小说 二")
        try check(await first.open(firstURL, title: "雾港"), "书库未创建第一部独立小说")
        let firstID = first.workspaceID
        guard let chapter = await first.createDocument(title: "起雾", kind: "novel_chapter") else { throw CheckFailure(message: "小说目录未创建章节") }
        try check(first.orderedChapters.map(\.id) == [chapter], "正文创建未同步小说目录")
        var metadata = first.novelMetadata.object
        metadata["title"] = .string("雾港来信"); metadata["author_name"] = .string("听雨"); metadata["status"] = .string("writing")
        try check(await first.saveNovelMetadata(.object(metadata)), "作品资料未保存")
        try check(first.title == "雾港来信" && first.workspaceID == firstID, "改书名改变作品身份或未更新名称")
        let volume: JSONValue = .object(["volume_id": .string("volume_" + UUID().uuidString.lowercased()), "title": .string("雾起")])
        var item = first.chapters[0].object; item["volume_id"] = volume["volume_id"]
        try check(await first.saveNovelStructure(volumes: [volume], chapters: [.object(item)]), "未保存章节分卷归属")
        let second = WorkspaceModel(locale: "en", recovery: recovery, preferences: preferences, library: library)
        try check(await second.open(secondURL, title: "A Separate Story"), "书库未创建第二部独立小说")
        try check(second.workspaceID != firstID && second.chapters.isEmpty && second.bible["blueprint"]["characters"].array.isEmpty, "独立小说共享了身份或内容")
        await second.returnToLibrary()
        try check(second.workspace == nil && second.libraryEntries.count == 2, "返回书库未保留两部独立小说")
        guard let entry = second.libraryEntries.first(where: { $0.workspaceID == firstID }) else { throw CheckFailure(message: "第一部小说未持久登记") }
        try check(entry.title == "雾港来信" && entry.authorName == "听雨" && entry.status == "writing" && entry.chapterCount == 1, "书库投影未消费作品资料")
        try check(await second.openLibraryEntry(entry) && second.volumes == [volume] && second.orderedChapters.map(\.id) == [chapter], "书库重新进入未恢复作品和卷章")
        try check(!(await second.open(secondURL, expectedWorkspaceID: firstID)) && second.workspaceID == firstID, "错误目录身份替换当前作品上下文")
        second.message = nil
        let stale = JSONValue.object(["revision": second.novel["revision"], "sha256": second.novel["sha256"]])
        metadata["synopsis"] = .string("作者在另一个窗口修订的简介")
        try check(await first.saveNovelMetadata(.object(metadata)), "并发测试未保存新资料")
        metadata["synopsis"] = .string("过期表单的简介")
        try check(!(await second.saveNovelMetadata(.object(metadata), expected: stale)), "过期作品表单覆盖新资料")
        let copyURL = root.appendingPathComponent("同身份副本")
        try FileManager.default.createDirectory(at: copyURL, withIntermediateDirectories: true)
        do {
            _ = try await library.register(url: copyURL, workspaceID: firstID, metadata: .object(metadata), chapterCount: 0)
            throw CheckFailure(message: "相同作品身份静默覆盖可用目录")
        } catch LibraryStore.LibraryError.duplicateWorkspace {}
        // 本机书库不是最近十条记录；所有明确登记的作品都持久保留。
        for index in 0..<12 {
            let url = root.appendingPathComponent("登记作品 \(index)")
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            _ = try await library.register(url: url, workspaceID: "workspace_" + UUID().uuidString.lowercased(), metadata: .object(["title": .string("作品 \(index)")]), chapterCount: 0)
        }
        let reloaded = LibraryStore(directory: root.appendingPathComponent("多作品书库"))
        try check(try await reloaded.entries().count == 14, "书库被最近十条限制或重启丢记录")
    }
    @MainActor static func mediaTests(_ root: URL, recovery: RecoveryStore, preferences: UserDefaults) async throws {
        let workspaceURL = root.appendingPathComponent("素材管理作品")
        let file = root.appendingPathComponent("灯塔参考 🌿.png")
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==")!
        try png.write(to: file)
        let model = WorkspaceModel(locale: "zh-CN", recovery: recovery, preferences: preferences, library: LibraryStore(directory: await recovery.directory.appendingPathComponent("Library")))
        try check(await model.open(workspaceURL, title: "素材验收"), "素材检查未创建作品")
        guard let id = await model.createDocument(title: "灯塔场景", kind: "novel_chapter"), await model.selectDocument(id) else { throw CheckFailure(message: "未创建素材来源文档") }
        model.edit("第一行\r\n闻溪推开门 🌿。\n")
        try check(await model.save(), "素材来源正文未保存")
        let document = model.loaded
        var error: String?
        guard let inspected = await model.workspaceAction("hetu.assets.inspect", input: ["file_path": .string(file.path)], onFailure: { error = $0; _ = $1 }) else { throw CheckFailure(message: "未检查媒体：\(error ?? "")") }
        try check(inspected["media_type"].string == "image/png" && inspected["validation"].string == "signature_only", "媒体签名结果不明确")
        let input: [String: JSONValue] = ["file_path": .string(file.path), "expected_file": .object(["sha256": inspected["sha256"], "size_bytes": inspected["size_bytes"]]), "title": .string("灯塔参考 🌿"), "source": .object(["source_type": .string("author_supplied"), "creator_statement": .string("作者提供")]), "rights_status": .string("unknown"), "redistribution_allowed": .bool(false), "rights_statement": .string(""), "operation_key": .string("native-media-import")]
        // 模拟素材落盘后回执丢失，恢复时不能依赖外部文件仍然存在。
        let pending = PendingStructureOperation(workspaceID: model.workspaceID, action: "hetu.assets.import", input: input)
        try await recovery.writeOperation(pending)
        let direct = try await Workspace.open(at: workspaceURL, mode: .author)
        let imported = try await direct.data(pending.action, input: input)
        try FileManager.default.removeItem(at: file)
        let restarted = WorkspaceModel(locale: "en", recovery: recovery, preferences: preferences, library: LibraryStore(directory: await recovery.directory.appendingPathComponent("Library")))
        try check(await restarted.open(workspaceURL), "素材导入后重新打开作品失败：\(restarted.message ?? "")")
        try check(restarted.pendingStructureOperations == [pending], "重启后未保留素材导入原操作")
        let replayed = await restarted.workspaceAction(pending.action, input: input, onFailure: { error = $0; _ = $1 })
        try check(replayed == imported && restarted.pendingStructureOperations.isEmpty, "原键恢复未返回同一素材或未清理请求")
        let blob = workspaceURL.appendingPathComponent(imported["asset"]["blob"]["path"].string ?? "")
        try check(try Data(contentsOf: blob) == png && imported["delivery_eligible"].bool == false, "素材字节改变或未知权利被默认允许交付")
        let text = model.savedText
        guard let span = SourceSpan(content: text, selection: (text as NSString).range(of: "闻溪推开门 🌿。")) else { throw CheckFailure(message: "未取得正文来源选区") }
        let source: JSONValue = .object(["document_id": .string(id), "revision_id": document["revision"]["revision_id"], "byte_start": .integer(Int64(span.byteStart)), "byte_end": .integer(Int64(span.byteEnd)), "quote": .string(span.quote)])
        let reference: JSONValue = .object(["asset_id": imported["asset"]["asset_id"], "revision": imported["asset"]["revision"], "sha256": imported["sha256"]])
        let cue = await restarted.workspaceAction("hetu.cues.save", input: ["kind": .string("visual"), "title": .string("灯塔夜景"), "description": .string("雨夜，冷色灯光；作者说明。"), "narrative_refs": .array([source]), "asset_refs": .array([reference]), "archived": .bool(false), "operation_key": .string("native-cue")], onFailure: { error = $0; _ = $1 })
        guard let cue else { throw CheckFailure(message: "原生线索未保存：\(error ?? "")") }
        let english = restarted.t("media.title")
        restarted.locale = "zh-CN"
        let fetched = await restarted.workspaceAction("hetu.cues.get", input: ["cue_id": cue["cue"]["cue_id"]], onFailure: { error = $0; _ = $1 })
        try check(fetched?["cue"] == cue["cue"] && english == "Cues & media" && restarted.t("media.title") == "线索与素材", "语言切换改变线索或缺少翻译")
        try check(fetched?["cue"]["narrative_refs"].array.first?["quote"].string == span.quote && error == nil, "原文选区映射错误")
    }
    @MainActor static func gitTests(_ root: URL, recovery: RecoveryStore, preferences: UserDefaults) async throws {
        let workspaceURL = root.appendingPathComponent("版本管理作品")
        let authorizationURL = root.appendingPathComponent("Authorizations")
        let model = WorkspaceModel(locale: "en", recovery: recovery, preferences: preferences, authorizationURL: authorizationURL, library: LibraryStore(directory: await recovery.directory.appendingPathComponent("Library")))
        try check(await model.open(workspaceURL, title: "版本验收"), "Git 状态测试未创建作品")
        var error: String?
        let initialized = await model.workspaceAction("hetu.git.init", input: ["branch": .string("main"), "operation_key": .string("native-git-init")], onFailure: { error = $0; _ = $1 })
        try check(initialized?["initialized"].bool == true, "Git 初始化失败")
        let input: [String: JSONValue] = ["phase": .string("prepare"), "expected_head": initialized!["head"], "message": .string("保存作品设定 🌿"), "author": .object(["name": .string("河图作者"), "email": .string("author@hetu.test")]), "operation_key": .string("native-git-prepare")]
        let operation = PendingStructureOperation(workspaceID: model.workspaceID, action: "hetu.git.snapshot", input: input)
        try await recovery.writeOperation(operation)
        let direct = try await Workspace.open(at: workspaceURL, mode: .author, authorizationURL: authorizationURL)
        let prepared = try await direct.data(operation.action, input: input)
        let restarted = WorkspaceModel(locale: "en", recovery: recovery, preferences: preferences, authorizationURL: authorizationURL, library: LibraryStore(directory: await recovery.directory.appendingPathComponent("Library")))
        try check(await restarted.open(workspaceURL) && restarted.pendingStructureOperations == [operation], "Git 待确认操作未持久化")
        let replay = await restarted.workspaceAction(operation.action, input: input, onFailure: { error = $0; _ = $1 })
        try check(replay == prepared && restarted.pendingStructureOperations.isEmpty, "Git pending 未返回固定审阅结果")
        let id = prepared["snapshot"]["snapshot_id"]
        let approved = await restarted.workspaceAction("hetu.git.approve_snapshot", input: ["snapshot_id": id, "snapshot_sha256": prepared["snapshot_sha256"], "operation_key": .string("native-git-approve")], onFailure: { error = $0; _ = $1 })
        try check(approved?["approval_state"].string == "approved", "作者批准失败")
        let execution: [String: JSONValue] = ["phase": .string("execute"), "snapshot_id": id, "operation_key": .string("native-git-execute")]
        let committed = await restarted.workspaceAction("hetu.git.snapshot", input: execution, onFailure: { error = $0; _ = $1 })
        try check(committed?["commit_id"].string?.count == 40, "原生快照未完成提交")
        let repeated = await restarted.workspaceAction("hetu.git.snapshot", input: execution, onFailure: { error = $0; _ = $1 })
        try check(repeated == committed && restarted.pendingStructureOperations.isEmpty, "快照执行重复创建提交或丢失回执")
        let status = await restarted.workspaceAction("hetu.git.status", input: [:], onFailure: { error = $0; _ = $1 })
        try check(status?["changes"].array.isEmpty == true && error == nil, "提交后存在伪工作树变更")
        try check(restarted.t("git.title") == "Version history", "版本管理英文文案缺失")
    }
    @MainActor static func reviewTests(_ workspaceURL: URL, recovery: RecoveryStore, preferences: UserDefaults) async throws {
        let model = WorkspaceModel(locale: "zh-CN", recovery: recovery, preferences: preferences, library: LibraryStore(directory: await recovery.directory.appendingPathComponent("Library")))
        try check(await model.open(workspaceURL), "审核测试未打开作品")
        guard let docID = await model.createDocument(title: "待审章节", kind: "novel_chapter") else { throw CheckFailure(message: "审核测试未创建章节") }
        try check(await model.selectDocument(docID), "未选择待审章节")
        model.edit("# 雾港\n\n闻溪推开门。🌿\n")
        try check(await model.save(), "待审正文未保存")
        var error: String?
        let submitted = await model.workspaceAction("hetu.drafts.submit_current", input: ["document_id": .string(docID), "base_revision_id": .string(model.baseRevisionID), "blueprint_revision": model.bible["revision"], "operation_key": .string("native-review-submit")], onFailure: { error = $0; _ = $1 })
        guard let draft = submitted?["draft"], let id = draft["draft_id"].string else { throw CheckFailure(message: "未提交审核：\(error ?? "")") }
        try check(model.drafts.contains { $0["draft_id"].string == id }, "审核提交未更新草稿列表")
        guard let begun = await model.workspaceAction("hetu.reviews.begin", input: ["draft_id": .string(id), "expected_draft_revision": draft["revision"], "operation_key": .string("native-review-begin")], onFailure: { error = $0; _ = $1 }) else { throw CheckFailure(message: "未开始审核") }
        let report = await model.workspaceAction("hetu.reviews.validate", input: ["draft_id": .string(id), "expected_draft_revision": begun["draft"]["revision"], "plot_options": .object([:]), "validation_options": .object([:]), "operation_key": .string("native-review-validate")], onFailure: { error = $0; _ = $1 })
        try check(report?["report"]["input_snapshot"]["source_revisions"].array.first?["document_id"] == draft["evidence_document_id"], "草稿检查没有固定草稿源")
        guard let context = await model.workspaceAction("hetu.reviews.get", input: ["draft_id": .string(id)], onFailure: { error = $0; _ = $1 }) else { throw CheckFailure(message: "未取得审核证据") }
        let input: [String: JSONValue] = ["draft_id": .string(id), "expected_draft_revision": context["draft"]["revision"], "input_snapshot": context["input_snapshot"], "report_refs": .array([context["reports"].array.first!["reference"]]), "decision": .string("approved"), "comments": .string("作者核对通过"), "private_comments": .string("保留伏笔"), "coverage_acknowledgement": .string("已核对候选与未知语境"), "operation_key": .string("native-review-approve")]
        // 模拟通过已经落盘，但客户端没有收到回执。
        let pending = PendingStructureOperation(workspaceID: model.workspaceID, action: "hetu.reviews.decide", input: input)
        try await recovery.writeOperation(pending)
        let direct = try await Workspace.open(at: workspaceURL, mode: .author)
        let committed = try await direct.data(pending.action, input: input)
        let restarted = WorkspaceModel(locale: "en", recovery: recovery, preferences: preferences, library: LibraryStore(directory: await recovery.directory.appendingPathComponent("Library")))
        try check(await restarted.open(workspaceURL) && restarted.pendingStructureOperations == [pending], "重启丢失审核通过原请求")
        let replayed = await restarted.workspaceAction(pending.action, input: input, onFailure: { error = $0; _ = $1 })
        try check(replayed == committed && restarted.pendingStructureOperations.isEmpty, "审核未知结果未重放原键")
        try check(await restarted.selectDocument(docID), "审核后未读取正文")
        try check(restarted.loaded["document"]["approved_revision_id"] == .null && restarted.text == "# 雾港\n\n闻溪推开门。🌿\n", "参考稿审核改写了正文或设置了定稿")
        let difference = RevisionDifference.compare(before: "第一行\r\n旧句🌿\n", after: "第一行\r\n新句🌿\n")
        let firstVersion = RevisionDifference.compare(before: "", after: "首行🌿")
        try check(firstVersion.changes.count == 1 && firstVersion.changes[0].added, "首次文件错误显示删除空行")
        try check(difference.withinBudget && difference.totalChanges == 2 && difference.changes[0].line == 2 && difference.changes[0].text == "旧句🌿" && !difference.changes[0].added, "逐行差异丢失中文、Emoji 或源行号")
        try check(!RevisionDifference.compare(before: String(repeating: "行\n", count: 3001), after: "").withinBudget, "大差异未明确超过预算")
        try check(restarted.t("review.title") == "Review workbench" && error == nil, "审核国际化或执行错误")
    }
    @MainActor static func lifecycleTests(_ workspaceURL: URL, recovery: RecoveryStore, preferences: UserDefaults) async throws {
        var model = WorkspaceModel(locale: "zh-CN", recovery: recovery, preferences: preferences, library: LibraryStore(directory: await recovery.directory.appendingPathComponent("Library")))
        try check(await model.open(workspaceURL, title: "作者自主定稿"), "生命周期测试未创建作品")
        @MainActor func action(_ name: String, _ input: [String: JSONValue]) async throws -> JSONValue {
            var message = ""
            guard let value = await model.workspaceAction(name, input: input, onFailure: { message = $0; _ = $1 }) else {
                throw CheckFailure(message: name + "：" + message)
            }
            return value
        }
        func reference(_ value: JSONValue) -> JSONValue {
            .object(["document_id": value["document"]["document_id"], "revision_id": value["revision"]["revision_id"], "sha256": value["revision"]["sha256"]])
        }
        @MainActor func finalize(_ current: JSONValue) async throws -> JSONValue {
            let report = try await action("hetu.documents.validate", ["document_ref": reference(current), "plot_options": .object([:]), "validation_options": .object([:]), "operation_key": .string(UUID().uuidString)])
            let fetched = try await action("hetu.reports.get", ["report_id": report["report"]["report_id"]])
            try check(fetched["reference"] == report["reference"], "报告读取未返回内核固定的证据引用")
            let preview = try await action("hetu.documents.preview_finalization", ["document_ref": reference(current), "expected_finalization_ref": current["document"]["finalization_ref"], "report_refs": .array([fetched["reference"]]), "comments": .string("作者已核对全文。"), "coverage_acknowledgement": .string("已人工核对未能自动判断的内容。")])
            try check(preview["preview"]["eligible"].bool == true, "手工稿未取得独立定稿资格")
            return try await action("hetu.documents.finalize", ["preview": preview["preview"], "operation_key": .string(UUID().uuidString)])
        }
        guard let id = await model.createDocument(title: "第一章 起雾", kind: "novel_chapter") else { throw CheckFailure(message: "未创建手工章节") }
        try check(await model.selectDocument(id), "未打开手工章节")
        let original = "# 手工原稿🌿\r\n\r\n旧句。\r\n"
        model.edit(original); try check(await model.save(), "未保存手工稿")
        let first = model.loaded
        let confirmed = try await finalize(first)
        try check(model.loaded["document"]["finalization_ref"] == confirmed["finalization"]["reference"], "原生模型未刷新定稿指针")
        try check(try await action("hetu.drafts.list", [:])["drafts"].array.isEmpty, "手工定稿创建了虚拟 AI 参考稿")
        let agent = try await Workspace.open(at: workspaceURL, mode: .agent)
        let source = "新句。未选内容。"
        let submitted = try await agent.data("hetu.drafts.submit", input: ["package": .string("novel"), "source_format": .string("markdown"), "target_document_id": .string(id), "base_revision_id": first["revision"]["revision_id"], "content": .string(source), "blueprint_revision": .integer(1), "operation_key": .string("native-adoption-source")])
        guard let selected = SourceSpan(content: source, selection: (source as NSString).range(of: "新句。")),
              let destination = SourceSpan(content: original, selection: (original as NSString).range(of: "旧句。")) else { throw CheckFailure(message: "中文采纳选区无效") }
        func span(_ value: SourceSpan) -> JSONValue { .object(["byte_start": .integer(Int64(value.byteStart)), "byte_end": .integer(Int64(value.byteEnd)), "quote": .string(value.quote)]) }
        let draft = submitted["draft"]
        let preview = try await action("hetu.drafts.preview_adoption", ["draft_ref": .object(["draft_id": draft["draft_id"], "revision": draft["revision"], "sha256": draft["content_sha256"]]), "target_ref": reference(first), "new_document": .null, "selected_ranges": .array([.object(["source": span(selected), "target": span(destination)])])])
        try check(preview["content"].string == original.replacingOccurrences(of: "旧句。", with: "新句。"), "局部采纳带入了未选内容或改写了换行")
        let request = ["preview": preview["preview"], "operation_key": JSONValue.string("native-adoption-unknown")]
        let operation = PendingStructureOperation(workspaceID: model.workspaceID, action: "hetu.drafts.adopt", input: request)
        try await recovery.writeOperation(operation)
        let direct = try await Workspace.open(at: workspaceURL, mode: .author)
        let committed = try await direct.data(operation.action, input: request)
        model = WorkspaceModel(locale: "en", recovery: recovery, preferences: preferences, library: LibraryStore(directory: await recovery.directory.appendingPathComponent("Library")))
        try check(await model.open(workspaceURL) && model.pendingStructureOperations == [operation], "重启丢失采纳原请求")
        let replayed = try await action(operation.action, request)
        try check(replayed == committed && model.pendingStructureOperations.isEmpty, "未知采纳重复创建修订或未清除原操作")
        try check(await model.selectDocument(id, adoptionUndoBaseline: original), "采纳后未打开写作稿")
        try check(model.adoptionUndoBaseline == original && model.text == preview["content"].string && !model.dirty, "采纳撤销基线未与新正文原子装载")
        try check(model.loaded["document"]["approved_revision_id"] == first["revision"]["revision_id"], "采纳覆盖了旧定稿")
        model.edit(original); try check(await model.save(), "撤销采纳后未保存作者修订")
        try check(!model.loaded["revision"]["contribution_refs"].array.isEmpty, "手工编辑抹除了采纳来源")
        let newer = try await finalize(model.loaded)
        var terminal = false
        let old = await model.workspaceAction("hetu.documents.withdraw_finalization", input: ["document_id": .string(id), "expected_finalization_ref": confirmed["finalization"]["reference"], "reason": .string("旧请求"), "operation_key": .string("native-old-withdraw")], onFailure: { _, value in terminal = value })
        try check(old == nil && terminal && model.loaded["document"]["finalization_ref"] == newer["finalization"]["reference"], "旧决定撤回了较新的定稿")
        _ = try await action("hetu.documents.withdraw_finalization", ["document_id": .string(id), "expected_finalization_ref": newer["finalization"]["reference"], "reason": .string("继续修改"), "operation_key": .string("native-withdraw")])
        let history = try await action("hetu.documents.lifecycle", ["document_id": .string(id)])
        try check(history["adoptions"].array.count == 1 && history["finalizations"].array.count == 3 && model.loaded["document"]["finalization_ref"] == .null && model.text == original, "撤回丢失正文、来源或历史")
        try check(model.t("finalization.confirm") == "Confirm finalization" && Localizer(locale: "zh-CN").text("review.state.approved") == "审核通过", "作者用语或定稿双语文案错误")
    }
    @MainActor static func bibleTests(_ model: WorkspaceModel, workspaceURL: URL, recovery: RecoveryStore, preferences: UserDefaults) async throws {
        let initial = model.bible
        let changes = try JSONDecoder().decode(JSONValue.self, from: Data(#"""
        [
          {"type":"upsert_character","entity":{"character_id":"character_11111111-1111-4111-8111-111111111111","name":"闻溪","aliases":[],"description":"信使","traits":["守信"],"facts":[{"fact_id":"fact_11111111-1111-4111-8111-111111111111","subject_ref":"character_11111111-1111-4111-8111-111111111111","predicate":"primary_faction","value":"faction_22222222-2222-4222-8222-222222222222","valid_from":"event_44444444-4444-4444-8444-444444444444","source_refs":[]}],"archived":false}},
          {"type":"upsert_faction","entity":{"faction_id":"faction_22222222-2222-4222-8222-222222222222","name":"守夜会","description":"守护雾港","relations":[],"archived":false}},
          {"type":"upsert_location","entity":{"location_id":"location_33333333-3333-4333-8333-333333333333","name":"灯塔","aliases":["北塔"],"interior_exterior":"interior","description":"海边灯塔","archived":false}},
          {"type":"upsert_event","entity":{"event_id":"event_44444444-4444-4444-8444-444444444444","title":"点灯之夜","time_anchor":{"calendar":"雾港历","tick":0},"before_refs":[],"after_refs":[],"source_refs":[]}},
          {"type":"upsert_world","entity":{"entry_id":"entry_66666666-6666-4666-8666-666666666666","title":"潮汐","description":"每晚两次落潮","source_refs":[]}},
          {"type":"upsert_rule","entity":{"rule_id":"rule_77777777-7777-4777-8777-777777777777","revision":1,"type":"forbidden_term","scope":{"packages":["novel"],"document_ids":[],"entity_refs":[]},"severity":"warning","parameters":{"terms":["传送门"],"case_sensitive":true,"exceptions":[]},"rationale":"","exception_policy":"author_review"}}
        ]
        """#.utf8)).array
        try check(await model.previewBibleChanges(changes) != nil && model.bible == initial, "设定预览改变了当前修订")
        try check(await model.saveBibleChanges(changes), "六类设定或同批向前引用保存失败")
        let saved = model.bible
        try check(saved["blueprint"]["factions"].array.count == 1 && saved["blueprint"]["timeline"].array.count == 1 && saved["revision"].integer == initial["revision"].integer! + 1, "设定保存未更新原生状态")
        try check(await model.readBibleRevision(initial["revision"].integer!) == initial && model.bible == saved, "历史查看改变了当前设定")

        var localError: String?
        let removal: JSONValue = .object(["type": .string("remove_entity"), "entity_ref": .string("faction_22222222-2222-4222-8222-222222222222")])
        model.message = nil
        try check(!(await model.saveBibleChanges([removal], onFailure: { localError = $0 })), "引用中的势力仍能删除")
        try check(localError == model.t("error.hetu.reference_in_use") && model.message == nil && model.bible == saved, "表单错误未就地呈现或失败修改了设定")

        let other = WorkspaceModel(locale: "zh-CN", recovery: recovery, preferences: preferences, library: LibraryStore(directory: await recovery.directory.appendingPathComponent("Library")))
        try check(await other.open(workspaceURL), "未打开第二个设定窗口")
        var world = changes[4]["entity"].object
        world["description"] = .string("每晚两次落潮，月圆时推迟")
        let updated: JSONValue = .object(["type": .string("upsert_world"), "entity": .object(world)])
        try check(await model.saveBibleChanges([updated]), "世界观变更失败")
        try check(!(await other.saveBibleChanges(changes, onFailure: { localError = $0 })) && localError == other.t("error.bible_conflict"), "过期设定绕过 CAS 或缺少设定专用提示")
        try check(!(await other.setLocked(true, reason: "旧窗口锁定", onFailure: { localError = $0 })) && !other.locked, "锁定操作没有报告过期基线")
        try check(other.bible["blueprint"] == saved["blueprint"] && other.bible["sha256"] == saved["sha256"] && model.bible["blueprint"]["world"].array.first?["description"].string == "每晚两次落潮，月圆时推迟", "失败覆盖了新修订")
        model.locale = "en"
        try check(await model.readBibleRevision(9_999, onFailure: { localError = $0 }) == nil && localError == model.t("error.not_found"), "历史缺失未显示英文错误")
        await other.refresh()
        try check(other.bible["blueprint"] == model.bible["blueprint"] && other.bible["sha256"] == model.bible["sha256"], "显式刷新未获取最新设定")
    }
    @MainActor static func editorTests() async throws {
        _ = NSApplication.shared
        let editor = NSTextView()
        editor.isRichText = false; editor.allowsUndo = true
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = editor; window.makeFirstResponder(editor)
        editor.undoManager?.beginUndoGrouping()
        editor.insertText("中文🌿", replacementRange: NSRange(location: 0, length: 0))
        editor.undoManager?.endUndoGrouping()
        try check(editor.string == "中文🌿", "TextKit 未保留 Unicode")
        editor.undoManager?.undo()
        try check(editor.string.isEmpty, "TextKit 撤销失败")
        editor.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        try check(editor.hasMarkedText(), "TextKit 未保留组合区")
        editor.insertText("中", replacementRange: editor.markedRange())
        editor.unmarkText()
        try check(editor.string == "中" && !editor.hasMarkedText(), "TextKit 组合输入未提交")
        let content = "前言👩🏽‍💻\r\n林舟走。e\u{301}"
        let excerpt = "林舟走。"
        let start = "前言👩🏽‍💻\r\n".utf8.count
        guard let selection = SourceSelection(content: content, byteStart: start, byteEnd: start + excerpt.utf8.count, quote: excerpt) else { throw CheckFailure(message: "UTF8 证据未转换选区") }
        try check((content as NSString).substring(with: selection.range) == excerpt, "证据定位的 UTF16 坐标错误")
        try check(SourceSelection(content: content, byteStart: start + 1, byteEnd: start + excerpt.utf8.count, quote: excerpt) == nil, "断开的 Unicode 标量进入选区")
        let span = SourceSpan(content: content, selection: selection.range)
        try check(span?.byteStart == start && span?.byteEnd == start + excerpt.utf8.count && span?.quote == excerpt, "人工选区未还原原始 UTF8 位置")
        let scalar = SourceSelection(content: "e\u{301}", byteStart: 1, byteEnd: 3, quote: "\u{301}")
        try check(scalar?.range == NSRange(location: 1, length: 1), "组合字符内部的合法标量位置被改写")
        let insertion = SourceSpan(content: content, selection: NSRange(location: selection.range.location, length: 0), allowEmpty: true)
        try check(insertion?.byteStart == start && insertion?.byteEnd == start && insertion?.quote == "", "插入点未保留原始字节位置")
        try check(SourceSpan(content: content, selection: NSRange(location: 0, length: 0)) == nil, "参考稿空选区被接受")
        try check(SourceSpan(content: "🌿", selection: NSRange(location: 1, length: 0), allowEmpty: true) == nil, "Emoji 代理对内部被接受为插入点")
        try check(SourceSpan(content: "🌿", selection: NSRange(location: 0, length: 1)) == nil, "Emoji 半个代理对被接受为原文选区")
        let combiningSpan = SourceSpan(content: "e\u{301}", selection: NSRange(location: 1, length: 1))
        try check(combiningSpan?.byteStart == 1 && combiningSpan?.byteEnd == 3 && combiningSpan?.quote == "\u{301}", "合法组合标量选区未保留字节位置")
        try check(SourceSpan(content: content, selection: NSRange(location: NSNotFound, length: 1), allowEmpty: true) == nil, "无效原生选区触发越界")
        editor.string = ""; editor.undoManager?.removeAllActions()
        editor.undoManager?.beginUndoGrouping()
        editor.insertText(content, replacementRange: NSRange(location: 0, length: 0))
        editor.undoManager?.endUndoGrouping()
        editor.setSelectedRange(selection.range)
        let beforeStyle = Data(editor.string.utf8)
        let display = EditorPresentation(fontFamily: "pingfang", fontSize: 24, lineSpacing: 8)
        try check(display.apply(to: editor, readingMode: true), "未应用作者排版偏好")
        try check(Data(editor.string.utf8) == beforeStyle && editor.selectedRange() == selection.range, "修改排版改变了原文字节或选区")
        let paragraph = editor.textStorage?.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle
        try check(editor.font?.pointSize == 24 && paragraph?.firstLineHeadIndent == 48 && paragraph?.lineSpacing == 8, "字体、行距或两字缩进没有生效")
        try check(SourceSpan(content: editor.string, selection: selection.range) == span, "排版破坏了原文来源定位")
        editor.undoManager?.undo()
        try check(editor.string.isEmpty, "修改排版破坏了正文撤销栈")
        editor.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        try check(!EditorPresentation(fontSize: 16).apply(to: editor, readingMode: true) && editor.hasMarkedText(), "排版变更打断了中文组合输入")
        editor.unmarkText()
        let invalid = EditorPresentation(fontFamily: "invalid", fontSize: .nan, lineSpacing: .infinity)
        try check(invalid.fontSize == 18 && invalid.lineSpacing == 5 && invalid.fontFamily == "songti", "非法排版偏好没有收敛为可用默认值")
        try nativeAdoptionEditorTests()
    }
    @MainActor static func nativeAdoptionEditorTests() throws {
        let original = "手工原稿👩🏽‍💻\r\n旧句。e\u{301}"
        let adopted = "手工原稿👩🏽‍💻\r\n新句。e\u{301}"
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 500, height: 400))
        let editor = NSTextView(frame: scroll.bounds)
        editor.isRichText = false; editor.allowsUndo = true
        scroll.documentView = editor
        let window = NSWindow(contentRect: scroll.bounds, styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = scroll; window.makeFirstResponder(editor)
        var edits: [String] = []
        var bridge = NativeTextEditor(text: original, documentID: "chapter-one", replacementVersion: 0, accessibleName: "章节正文",
                                      readingMode: true, onChange: { edits.append($0) }, onComposition: { _ in })
        let coordinator = bridge.makeCoordinator()
        editor.delegate = coordinator
        bridge.updateEditor(in: scroll, coordinator: coordinator)
        try check(editor.string == original && editor.undoManager?.canUndo == false, "打开章节留下错误撤销操作")

        // 同一章节的显式采纳走生产同步入口，原有正文只能被作为一次编辑替换。
        bridge.text = adopted; bridge.undoBaseline = original; bridge.replacementVersion = 1
        bridge.updateEditor(in: scroll, coordinator: coordinator)
        try check(editor.string == adopted && editor.undoManager?.canUndo == true && edits.isEmpty, "采纳装载丢失撤销或触发了重复保存")
        editor.undoManager?.undo()
        try check(editor.string == original && edits.last == original && editor.undoManager?.canRedo == true, "一次撤销未恢复采纳前正文或未通知写作缓冲")
        bridge.updateEditor(in: scroll, coordinator: coordinator)
        try check(editor.string == original && editor.undoManager?.canRedo == true, "普通界面刷新覆盖了作者撤销")
        bridge.presentation = EditorPresentation(fontFamily: "pingfang", fontSize: 22, lineSpacing: 7)
        bridge.updateEditor(in: scroll, coordinator: coordinator)
        editor.undoManager?.redo()
        try check(editor.string == adopted && edits.last == adopted, "排版变更破坏了采纳重做")

        // 另一章节的采纳必须以该章节自己的原稿为撤销基线。
        bridge.documentID = "chapter-two"; bridge.text = "第二章新句🌿"; bridge.undoBaseline = "第二章原句🌿"
        bridge.updateEditor(in: scroll, coordinator: coordinator)
        editor.undoManager?.undo()
        try check(editor.string == "第二章原句🌿" && editor.undoManager?.canUndo == false, "切章采纳串用了上一章撤销栈")

        // 中文组合输入期间不允许显式重载或改排版；提交后再应用。
        editor.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: 0, length: 0))
        let composing = editor.string
        bridge.documentID = "chapter-three"; bridge.text = "第三章正文"; bridge.undoBaseline = nil
        bridge.replacementVersion = 2; bridge.presentation = EditorPresentation(fontSize: 16)
        bridge.updateEditor(in: scroll, coordinator: coordinator)
        try check(editor.hasMarkedText() && editor.string == composing, "显式装载打断了中文输入法")
        editor.unmarkText()
        bridge.updateEditor(in: scroll, coordinator: coordinator)
        try check(editor.string == "第三章正文" && editor.undoManager?.canUndo == false, "输入结束后的显式装载未重置旧坐标撤销")
    }
    @MainActor static func plotTests(_ model: WorkspaceModel) async throws {
        guard let id = await model.createDocument(title: "剧情原文", kind: "novel_chapter") else { throw CheckFailure(message: "剧情章节创建失败") }
        try check(await model.selectDocument(id), "剧情章节打开失败")
        model.edit("# 灯塔 — 夜\r\n\r\n闻溪推开门。👩🏽‍💻\r\n\r\n闻溪：“回来。”\r\n")
        try check(await model.save(), "剧情原文保存失败")
        var error: String?
        guard let extracted = await model.extractPlot(documentID: id, onFailure: { error = $0 }) else { throw CheckFailure(message: "原生提取失败：\(error ?? "")") }
        let plot = extracted["plot"]
        try check(plot["coverage"]["status"].string == "complete" && plot["nodes"].array.count == 3, "原生提取未保留覆盖或结构")
        guard let dialogue = plot["nodes"].array.first(where: { $0["kind"].string == "dialogue" }) else { throw CheckFailure(message: "没有对白节点") }
        var correction = dialogue.object.filter { ["kind", "entity_refs", "location_ref", "time_ref", "speaker_ref", "time_of_day", "verification", "node_id"].contains($0.key) }
        correction["type"] = .string("update_node"); correction["verification"] = .string("confirmed")
        correction["entity_refs"] = .array([.string("character_11111111-1111-4111-8111-111111111111")]); correction["speaker_ref"] = .string("character_11111111-1111-4111-8111-111111111111")
        guard let corrected = await model.correctPlot(plot["plot_revision_id"].string!, corrections: [.object(correction)], operationKey: UUID().uuidString, onFailure: { error = $0 }) else { throw CheckFailure(message: "原生校正失败：\(error ?? "")") }
        try check(corrected["plot"]["parent_plot_revision_id"] == plot["plot_revision_id"], "原生校正未绑定父修订")
        try await dramaTests(model, plot: corrected["plot"])
        let list = await model.listPlots(documentID: id, onFailure: { error = $0 })
        try check(list?["plots"].array.count == 2, "原生未列出剧情修订")
        let old = await model.readPlot(plot["plot_revision_id"].string!, onFailure: { error = $0 })
        try check(old?["plot"] == plot, "原生剧情历史被覆盖")
        let source = dialogue["source_refs"].array[0]
        let document = await model.readPlotSource(source, onFailure: { error = $0 })
        try check(document?["revision"]["revision_id"] == source["revision_id"], "核对原文未读取固定修订")
        guard let validated = await model.runValidation(plotRevision: corrected["plot"]["plot_revision_id"].string!, operationKey: "native-validation", onFailure: { error = $0 }) else { throw CheckFailure(message: "原生诊断失败：\(error ?? "")") }
        let report = validated["report"]
        try check(report["status"].string == "complete" && report["input_snapshot"]["plot_revision_id"] == corrected["plot"]["plot_revision_id"], "诊断未绑定固定剧情证据")
        try check(await model.listReports(plotRevision: corrected["plot"]["plot_revision_id"].string!, onFailure: { error = $0 })?["reports"].array.count == 1, "原生报告列表错误")
        // 无场景的提示不是保证出现的问题，因此用同一原文中的明确禁用词构造可处置报告。
        let rule = model.bible["blueprint"]["rules"].array.first!
        var updatedRule = rule.object; var parameters = rule["parameters"].object
        parameters["terms"] = .array([.string("回来")]); updatedRule["parameters"] = .object(parameters)
        try check(await model.saveBibleChanges([.object(["type": .string("upsert_rule"), "entity": .object(updatedRule)])]), "未保存诊断词条")
        guard let nextPlot = await model.extractPlot(documentID: id, onFailure: { error = $0 }),
              let nextReport = await model.runValidation(plotRevision: nextPlot["plot"]["plot_revision_id"].string!, operationKey: "native-validation-updated", onFailure: { error = $0 }),
              let finding = nextReport["report"]["findings"].array.first else { throw CheckFailure(message: "缺少真实诊断命中") }
        try check(await model.recordDisposition(report: nextReport["report"], findingID: finding["finding_id"].string!, expectedRevision: 0, disposition: "acknowledged", reason: "作者已核对", operationKey: "native-disposition", onFailure: { error = $0 }), "原生处置失败")
        let reread = await model.readReport(nextReport["report"]["report_id"].string!, onFailure: { error = $0 })
        try check(reread?["report"] == nextReport["report"] && reread?["dispositions"].array.first?["current"]["reason"].string == "作者已核对", "处置覆盖报告或未留存理由")
        let oldReport = await model.readReport(report["report_id"].string!, onFailure: { error = $0 })
        try check(oldReport?["stale"].bool == true && oldReport?["report"] == report, "设定更新后旧报告未标记过期")
        try check(Localizer(locale: "en").text("validation.prerequisites").hasPrefix("Missing") && !Localizer(locale: "en").date("2026-11-13T01:02:03.123456Z").contains("T01:"), "诊断或小数秒日期未本地化")
        try check(model.message == nil && error == nil, "剧情操作产生非预期错误")
    }
    @MainActor static func dramaTests(_ model: WorkspaceModel, plot: JSONValue) async throws {
        var error: String?
        guard let built = await model.dramaAction("hetu.drama.build_skeleton", input: ["plot_revision_id": plot["plot_revision_id"], "blueprint_revision": plot["blueprint_revision"], "episode_options": .object([:]), "operation_key": .string("native-structure")], onFailure: { error = $0; _ = $1 }) else { throw CheckFailure(message: "原生骨架失败：\(error ?? "")") }
        let skeleton = built["skeleton"]
        guard let scene = skeleton["episodes"].array.first?["scenes"].array.first else { throw CheckFailure(message: "缺少短剧场次") }
        try check(scene["dialogue"].string == "" && scene["shot_description"].string == "" && scene["time_of_day"].string == "unknown", "骨架生成正文或猜测日夜")
        let changed = await model.dramaAction("hetu.drama.edit_skeleton", input: ["skeleton_id": skeleton["skeleton_id"], "expected": .object(["revision": skeleton["revision"], "sha256": built["sha256"]]), "typed_changes": .array([.object(["type": .string("update_scene"), "scene_id": scene["scene_id"], "title": .string("灯塔之夜"), "location_ref": scene["location_ref"], "interior_exterior": .string("unknown"), "time_of_day": .string("dawn"), "character_refs": scene["character_refs"], "adaptation_note": .string("作者确认改编时间")])]), "operation_key": .string("native-structure-edit")], onFailure: { error = $0; _ = $1 })
        try check(changed?["skeleton"]["episodes"].array.first?["scenes"].array.first?["scene_id"] == scene["scene_id"], "编辑改变稳定场次 ID")
        let historical = await model.dramaAction("hetu.drama.get_skeleton", input: ["skeleton_id": skeleton["skeleton_id"], "revision": .integer(1)], onFailure: { error = $0; _ = $1 })
        try check(historical?["skeleton"] == skeleton, "骨架旧修订被覆盖")
        let report = await model.dramaAction("hetu.drama.compare", input: ["skeleton_ref": .object(["skeleton_id": skeleton["skeleton_id"], "revision": changed?["skeleton"]["revision"] ?? .null, "sha256": changed?["sha256"] ?? .null]), "source_revisions": skeleton["source_revisions"], "save_result": .bool(true), "operation_key": .string("native-structure-comparison")], onFailure: { error = $0; _ = $1 })
        try check(report?["comparison"]["items"].array.contains(where: { $0["kind"].string == "modified" }) == true, "原生未保留结构差异")
        let list = await model.dramaAction("hetu.drama.list_skeletons", input: [:], onFailure: { error = $0; _ = $1 })
        try check(list?["skeletons"].array.count == 2, "原生骨架修订列表错误")
        let originalLocale = model.locale; model.locale = "en"
        try check(model.t("drama.workbench_title") == "Drama structure" && model.t("drama.title") == "Drama" && changed?["skeleton"]["episodes"].array.first?["scenes"].array.first?["title"].string == "灯塔之夜", "国际化改变作者内容")
        model.locale = originalLocale
        try check(error == nil, "短剧工作台产生非预期错误")
        guard let changed else { throw CheckFailure(message: "没有可建剧本的骨架") }
        let script = await model.dramaAction("hetu.drama.create_script", input: ["skeleton_ref": .object(["skeleton_id": skeleton["skeleton_id"], "revision": changed["skeleton"]["revision"], "sha256": changed["sha256"]]), "title": .string("灯塔剧本 🌿"), "language_tag": .string("en"), "operation_key": .string("native-script")], onFailure: { error = $0; _ = $1 })
        guard let script, let scriptID = script["document"]["document_id"].string else { throw CheckFailure(message: "未建立独立剧本：\(error ?? "")") }
        try check(model.documents.contains(where: { $0.id == scriptID && $0.kind == "drama_script" }), "独立剧本未出现在原生文档列表")
        try check(await model.selectDocument(scriptID), "未打开结构剧本")
        let initialText = model.text
        try check(initialText.contains("# Episode 1") && initialText.contains(".LOCATION UNSET - DAWN") && !initialText.contains("INT."), "剧本语言、未知内外景或日夜映射错误")
        for scene in script["mapping"]["scenes"].array {
            try check(SourceSelection(content: initialText, byteStart: Int(scene["byte_start"].integer!), byteEnd: Int(scene["byte_end"].integer!), quote: scene["quote"].string!) != nil, "含中文 Emoji 的剧本来源定位失败")
        }
        model.edit(initialText + "@闻溪\n作者写下的对白。\n")
        try check(await model.save(), "手工剧本未创建正文新修订")
        let mapping = await model.dramaAction("hetu.drama.get_script_mapping", input: ["document_id": .string(scriptID)], onFailure: { error = $0; _ = $1 })
        try check(mapping?["stale"].bool == true && mapping?["mapping"] == script["mapping"], "正文改写后结构映射没有固定原始范围")
        model.locale = "en"
        try check(model.t("script.mapping") == "Structure sources" && model.text.hasSuffix("作者写下的对白。\n"), "映射国际化改变了作者正文")
        model.locale = originalLocale
    }
    @MainActor static func structureRecoveryTests(_ workspaceURL: URL, recovery: RecoveryStore, preferences: UserDefaults) async throws {
        let direct = try await Workspace.open(at: workspaceURL, mode: .author)
        let page = try await direct.data("hetu.plot.list")
        let plot = page["plots"].array.first!
        let info = try await direct.data("hetu.workspaces.get")
        let input: [String: JSONValue] = ["plot_revision_id": plot["plot_revision_id"], "blueprint_revision": plot["blueprint_revision"], "episode_options": .object([:]), "operation_key": .string("unknown-structure-build")]
        let pending = PendingStructureOperation(workspaceID: info["workspace"]["workspace_id"].string!, action: "hetu.drama.build_skeleton", input: input)
        try await recovery.writeOperation(pending)
        let committed = try await direct.data(pending.action, input: input, allowPartial: true)
        let count = try await direct.data("hetu.drama.list_skeletons")["skeletons"].array.count
        let restarted = WorkspaceModel(locale: "en", recovery: recovery, preferences: preferences, library: LibraryStore(directory: await recovery.directory.appendingPathComponent("Library")))
        try check(await restarted.open(workspaceURL) && restarted.pendingStructureOperations == [pending], "重启未发现原结构请求")
        var message: String?
        let replayed = await restarted.dramaAction(pending.action, input: pending.input, onFailure: { message = $0; _ = $1 })
        try check(replayed == committed && message == nil && restarted.pendingStructureOperations.isEmpty, "结构未知结果未按原键恢复或重复创建")
        let afterCount = try await direct.data("hetu.drama.list_skeletons")["skeletons"].array.count
        try check(count == afterCount, "恢复结构操作重复保存")
        try check(try await recovery.structureOperations(workspaceID: pending.workspaceID).isEmpty, "已确认结构恢复记录未清理")
        let scriptInput: [String: JSONValue] = ["skeleton_ref": .object(["skeleton_id": committed["skeleton"]["skeleton_id"], "revision": committed["skeleton"]["revision"], "sha256": committed["sha256"]]), "title": .string("未知结果剧本"), "language_tag": .string("zh-CN"), "operation_key": .string("unknown-script-create")]
        let scriptPending = PendingStructureOperation(workspaceID: pending.workspaceID, action: "hetu.drama.create_script", input: scriptInput)
        try await recovery.writeOperation(scriptPending)
        let scriptCommitted = try await direct.data(scriptPending.action, input: scriptInput, allowPartial: true)
        let documentsBefore = try await direct.data("hetu.documents.list")["documents"].array.count
        let scriptRestart = WorkspaceModel(locale: "zh-CN", recovery: recovery, preferences: preferences, library: LibraryStore(directory: await recovery.directory.appendingPathComponent("Library")))
        try check(await scriptRestart.open(workspaceURL) && scriptRestart.pendingStructureOperations == [scriptPending], "重启丢失建立剧本的原请求")
        let replay = await scriptRestart.dramaAction(scriptPending.action, input: scriptPending.input, onFailure: { message = $0; _ = $1 })
        try check(replay == scriptCommitted && scriptRestart.pendingStructureOperations.isEmpty && scriptRestart.documents.count == documentsBefore, "建立剧本恢复重复创建文档或未更新列表")
    }
}
