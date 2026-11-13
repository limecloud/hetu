import Foundation
import HetuCore
import HetuNative

private struct DeliveryFailure: Error { let message: String }
private func checkDelivery(_ condition: Bool, _ message: String) throws {
    if !condition { throw DeliveryFailure(message: message) }
}

enum DeliveryTests {
    @MainActor static func run(root: URL) async throws {
        print("导入导出夹具：\(root.path)")
        let preferencesName = "run.limeai.hetu.delivery.\(UUID().uuidString)"
        let preferences = UserDefaults(suiteName: preferencesName)!
        defer { preferences.removePersistentDomain(forName: preferencesName) }
        let recovery = RecoveryStore(directory: root.appendingPathComponent("交付操作恢复"))
        let library = LibraryStore(directory: root.appendingPathComponent("交付书库"))
        let model = WorkspaceModel(locale: "zh-CN", recovery: recovery, preferences: preferences, library: library)
        let book = root.appendingPathComponent("中文作品 交付验收")
        try checkDelivery(await model.open(book, title: "雾港来信"), "未创建导入导出作品")

        // 预览不会建章，标题和分卷由作者确认，不依据正文标题自动拆章。
        let source = root.appendingPathComponent("外部中文原稿.txt")
        let original = "第一章 雾起\n\n  林舟走进雾港。\n\n第二章 来信\n\n信封留在门边。\n"
        try Data(original.utf8).write(to: source)
        let importer = DeliverySession(model: model)
        importer.chooseFile(source)
        await importer.prepare()
        try checkDelivery(importer.preview != .null && importer.preview["converted"]["confirmation_required"].bool == true, importer.error ?? "未生成结构转换预览")
        try checkDelivery(model.documents.isEmpty && model.chapters.isEmpty, "预览提前写入了作品")
        try checkDelivery(!(await importer.commit(acknowledgement: "  ")), "空确认执行了导入")
        importer.importTitle = "雾起与来信"
        try checkDelivery(importer.preview == .null && !importer.canCommit, "修改导入信息仍沿用旧预览")
        await importer.prepare()
        try Data("原文件在确认前已经改变。".utf8).write(to: source)
        try checkDelivery(!(await importer.commit(acknowledgement: "已确认。")) && importer.pending == nil && importer.preview == .null && model.documents.isEmpty && importer.error == model.t("delivery.inputs_changed"), "源文件改变后仍导入或未要求重新预览")
        try Data(original.utf8).write(to: source)
        await importer.prepare()
        try checkDelivery(await importer.commit(acknowledgement: "已确认导入预览。"), importer.error ?? "未导入正文")
        try checkDelivery(model.documents.count == 1 && model.orderedChapters.count == 1 && model.orderedChapters.first?.title == "雾起与来信", "导入没有同步卷章或擅自拆成多章")
        let documentID = model.documents[0].id
        try checkDelivery(try await library.entries().first?.chapterCount == 1, "导入后书库章节数未更新")
        try checkDelivery(await model.selectDocument(documentID), "未打开导入章节")
        try checkDelivery(model.loaded["revision"]["origin_kind"].string == "import" && model.loaded["document"]["approved_revision_id"] == .null, "导入丢失来源或自动定稿")
        try checkDelivery(model.text.contains("林舟走进雾港") && model.text.contains("信封留在门边"), "导入丢失正文")

        let exporter = DeliverySession(model: model)
        exporter.mode = .exportDocuments; exporter.format = "docx"; exporter.selectedDocuments = [documentID]
        model.edit(model.text + "\n尚未保存的作者修改。")
        await exporter.prepare()
        try checkDelivery(exporter.preview == .null && exporter.error == model.t("delivery.unsaved"), "导出未提示未保存内容")
        try checkDelivery(await model.save(), "未保存导入后的作者修改")
        exporter.useFinalizedRevisions = true
        await exporter.prepare()
        try checkDelivery(exporter.preview == .null && exporter.error == model.t("delivery.no_finalization"), "选用定稿却静默导出了未定稿正文")
        exporter.useFinalizedRevisions = false
        await exporter.prepare()
        try checkDelivery(exporter.canCommit && exporter.preview["files"].array.count == 1, exporter.error ?? "未生成 Word 导出预览")
        exporter.format = "txt"
        try checkDelivery(exporter.preview == .null && !exporter.canCommit, "切换格式没有使预览失效")
        exporter.format = "docx"; await exporter.prepare()
        try checkDelivery(!(await exporter.commit(acknowledgement: "")), "未确认便导出了文档")
        try checkDelivery(await exporter.commit(acknowledgement: "已确认 Word 导出。"), exporter.error ?? "Word 导出失败")
        guard let word = exporter.resultURL else { throw DeliveryFailure(message: "Word 产物路径缺失") }
        try checkDelivery(FileManager.default.fileExists(atPath: word.path) && word.pathExtension == "docx", "Word 文件不存在")
        let reimport = DeliverySession(model: model)
        reimport.chooseFile(word); await reimport.prepare()
        try checkDelivery(reimport.preview["converted"]["content"].string?.contains("尚未保存的作者修改") == true, reimport.error ?? "导出的 Word 无法回读正文")

        // 附件沿真实骨架、报告和改编差异查询，不以展示标题作为身份。
        var plotError = ""
        guard let extracted = await model.extractPlot(documentID: documentID, onFailure: { plotError = $0 }) else { throw DeliveryFailure(message: plotError) }
        let plot = extracted["plot"]
        let built = try await action(model, "hetu.drama.build_skeleton", ["plot_revision_id": plot["plot_revision_id"], "blueprint_revision": plot["blueprint_revision"], "episode_options": .object([:]), "operation_key": .string(UUID().uuidString)])
        let skeleton = built["skeleton"]
        let comparison = try await action(model, "hetu.drama.compare", ["skeleton_ref": .object(["skeleton_id": skeleton["skeleton_id"], "revision": skeleton["revision"], "sha256": built["sha256"]]), "source_revisions": skeleton["source_revisions"], "save_result": .bool(true), "operation_key": .string(UUID().uuidString)])

        // 正式包使用独立定稿，后续写作稿及未保存缓冲均不混入。
        let finalized = try await finalize(model: model)
        let approvedID = finalized["document"]["approved_revision_id"]
        model.edit(model.text + "\n这句仅在后续写作稿中。")
        try checkDelivery(await model.save(), "定稿后写作修订未保存")
        let currentID = model.loaded["revision"]["revision_id"]
        model.edit(model.text + "\n这句还在编辑缓冲中。")
        let bundle = DeliverySession(model: model)
        bundle.mode = .bundle; bundle.selectedDocuments = [documentID]; bundle.readingFormats = ["docx"]
        await bundle.loadAttachments(.skeletons)
        await bundle.loadAttachments(.reports)
        bundle.comparisonSkeletonID = skeleton["skeleton_id"].string
        await bundle.loadAttachments(.comparisons)
        guard let savedSkeleton = bundle.attachments[.skeletons]?.first,
              let savedComparison = bundle.attachments[.comparisons]?.first,
              let savedReport = bundle.attachments[.reports]?.first else { throw DeliveryFailure(message: bundle.error ?? "没有查询到交付附件") }
        try checkDelivery(savedComparison["comparison_id"] == comparison["comparison"]["comparison_id"], "差异报告查询没有绑定所选骨架")
        bundle.selectedAttachments[.skeletons] = [DeliveryAttachmentKind.skeletons.identity(savedSkeleton)]
        bundle.selectedAttachments[.reports] = [DeliveryAttachmentKind.reports.identity(savedReport)]
        bundle.selectedAttachments[.comparisons] = [DeliveryAttachmentKind.comparisons.identity(savedComparison)]
        await bundle.prepare()
        let formalRef = bundle.preview["inputs"]["document_refs"].array.first ?? .null
        try checkDelivery(bundle.canCommit && formalRef["revision_id"] == approvedID && formalRef["revision_id"] != currentID && formalRef["finalization_ref"] != .null, bundle.error ?? "正式包没有固定旧定稿")
        try checkDelivery(bundle.preview["inputs"]["comparison_refs"].array.first?["sha256"] == savedComparison["sha256"] && bundle.preview["inputs"]["skeleton_refs"].array.count == 1 && bundle.preview["inputs"]["report_refs"].array.count == 1, "交付预览丢失固定附件")
        let buffer = model.text
        try checkDelivery(await bundle.commit(acknowledgement: "已确认正式交付。"), bundle.error ?? "正式交付失败")
        try checkDelivery(model.text == buffer && model.dirty && model.loaded["document"]["approved_revision_id"] == approvedID, "交付覆盖编辑缓冲或定稿指针")
        guard let archive = bundle.resultURL else { throw DeliveryFailure(message: "交付包路径缺失") }
        try checkDelivery(FileManager.default.fileExists(atPath: archive.path) && archive.pathExtension == "zip", "交付包文件不存在")
        await bundle.verifyResult()
        try checkDelivery(bundle.verification["verified"].bool == true && bundle.verification["sha256"] == bundle.result["sha256"], bundle.error ?? "交付包未通过核验")
        bundle.mode = .exportDocuments
        try checkDelivery(bundle.result == .null && bundle.resultURL == nil && bundle.verification == .null, "切换操作后仍展示上次交付结果")
        try checkDelivery(await model.save(), "交付后缓冲未能正常保存")

        // 文档导出的定稿选项不改变审阅包默认的写作稿选择。
        let review = DeliverySession(model: model)
        review.mode = .exportDocuments; review.useFinalizedRevisions = true
        review.mode = .bundle; review.bundleProfile = "review_delivery"; review.readingFormats = []; review.selectedDocuments = [documentID]
        await review.prepare()
        try checkDelivery(review.preview["inputs"]["document_refs"].array.first?["revision_id"] == model.loaded["revision"]["revision_id"], review.error ?? "隐藏的定稿选项改变了审阅包选集")
        guard let newChapter = await model.createDocument(title: "未定稿章节", kind: "novel_chapter") else { throw DeliveryFailure(message: "未创建未定稿章节") }
        let blocked = DeliverySession(model: model)
        blocked.mode = .bundle; blocked.readingFormats = []; blocked.selectedDocuments = [newChapter]
        await blocked.prepare()
        try checkDelivery(blocked.preview != .null && blocked.preview["eligible"].bool == false && !blocked.canCommit, blocked.error ?? "未定稿正文未被正式交付阻断")
        blocked.bundleProfile = "review_delivery"; await blocked.prepare()
        try checkDelivery(blocked.canCommit, blocked.error ?? "审阅包没有接受作者写作稿")

        // 已写入但回执未知的导入、文档和交付包，重启后沿原键恢复。
        let direct = try await Workspace.open(at: book, mode: .author)
        let sourceForRecovery = root.appendingPathComponent("恢复后原文件移走.txt")
        try Data("这是恢复导入的章节。\n".utf8).write(to: sourceForRecovery)
        let pendingImportPreview = try await direct.data("hetu.documents.preview_import", input: ["file_path": .string(sourceForRecovery.path), "format": .string("txt"), "profile": .string("hetu-novel-zh/1")])["preview"]
        let importInput: [String: JSONValue] = ["preview": pendingImportPreview, "kind": .string("novel_chapter"), "title": .string("恢复导入"), "language_tag": .string("zh-CN"), "volume_id": .null, "acknowledgement": .string("已确认。"), "operation_key": .string("native-import-unknown")]
        let imported = try await recover(action: "hetu.documents.import", input: importInput, model: model, direct: direct, recovery: recovery, library: library, preferences: preferences, beforeRestart: {
            try FileManager.default.moveItem(at: sourceForRecovery, to: sourceForRecovery.appendingPathExtension("moved"))
        })
        try checkDelivery(imported["document"]["title"].string == "恢复导入", "导入恢复未返回原文档")
        let docPreview = try await direct.data("hetu.documents.preview_export", input: ["revision_refs": .array([.object(["document_id": imported["document"]["document_id"], "revision_id": imported["revision"]["revision_id"], "sha256": imported["revision"]["sha256"]])]), "profile": .string("hetu-novel-zh/1"), "format": .string("docx")])["preview"]
        _ = try await recover(action: "hetu.documents.export", input: ["preview": docPreview, "acknowledgement": .string("已确认。"), "operation_key": .string("native-document-unknown")], model: model, direct: direct, recovery: recovery, library: library, preferences: preferences)
        _ = try await recover(action: "hetu.bundles.export", input: ["preview": blocked.preview, "acknowledgement": .string("已确认。"), "operation_key": .string("native-bundle-unknown")], model: model, direct: direct, recovery: recovery, library: library, preferences: preferences)

        // PDF 缺字必须明确失败；Fountain 格式一次只交付一部剧本。
        await model.refresh()
        guard let glyphDocument = await model.createDocument(title: "含表情的章节", kind: "novel_chapter"), await model.selectDocument(glyphDocument) else { throw DeliveryFailure(message: "未创建缺字检查章节") }
        model.edit("林舟收到来信。😀\n")
        try checkDelivery(await model.save(), "缺字检查章节未保存")
        model.locale = "en"
        let pdf = DeliverySession(model: model)
        pdf.mode = .exportDocuments; pdf.format = "pdf"; pdf.selectedDocuments = [glyphDocument]
        await pdf.prepare()
        try checkDelivery(pdf.preview == .null && pdf.error == model.t("error.hetu.format_unrepresentable"), "PDF 缺字没有明确的英文提示")
        model.locale = "zh-CN"
        guard let firstScript = await model.createDocument(title: "第一部剧本", kind: "drama_script"),
              let secondScript = await model.createDocument(title: "第二部剧本", kind: "drama_script") else { throw DeliveryFailure(message: "未创建独立剧本") }
        let fountain = DeliverySession(model: model)
        fountain.mode = .exportDocuments; fountain.selectedDocuments = [firstScript, secondScript]; fountain.format = "fountain"
        try checkDelivery(fountain.selectedDocuments.count == 1, "切换 Fountain 后仍多选剧本")
        fountain.selectedDocuments = [firstScript, secondScript]
        try checkDelivery(!fountain.canPrepare, "Fountain 同时导出多部剧本")

        // 旧面板即使持有确认预览，也不能在切书后写入任何作品。
        await model.refresh()
        let stale = DeliverySession(model: model)
        stale.chooseFile(source); await stale.prepare()
        try checkDelivery(stale.canCommit, stale.error ?? "隔离测试没有预览")
        let otherBook = root.appendingPathComponent("另一部独立小说")
        try checkDelivery(await model.open(otherBook, title: "独立作品"), "未能切到另一部作品")
        try checkDelivery(!(await stale.commit(acknowledgement: "不应执行")) && model.documents.isEmpty, "旧交付面板向新作品写入内容")
        try checkDelivery(model.t("delivery.title") == "导入导出", "中文交付入口缺失")
        model.locale = "en"
        try checkDelivery(model.t("delivery.title") == "Import and Export" && model.localizer.hasTranslation(for: "error.hetu.format_unrepresentable"), "英文入口或格式错误缺失")
        print("导入导出：作者预览与确认、卷章书库同步、Word 回读、旧定稿交付、核验、原键恢复及切书隔离通过")
    }

    @MainActor private static func finalize(model: WorkspaceModel) async throws -> JSONValue {
        let current = model.loaded
        let reference: JSONValue = .object(["document_id": current["document"]["document_id"], "revision_id": current["revision"]["revision_id"], "sha256": current["revision"]["sha256"]])
        let checked = try await action(model, "hetu.documents.validate", ["document_ref": reference, "plot_options": .object([:]), "validation_options": .object([:]), "operation_key": .string(UUID().uuidString)])
        let preview = try await action(model, "hetu.documents.preview_finalization", ["document_ref": reference, "expected_finalization_ref": current["document"]["finalization_ref"], "report_refs": .array([checked["reference"]]), "comments": .string("作者确认此修订。"), "coverage_acknowledgement": .string("已核对本次检查覆盖范围。")])
        return try await action(model, "hetu.documents.finalize", ["preview": preview["preview"], "operation_key": .string(UUID().uuidString)])
    }

    @MainActor private static func action(_ model: WorkspaceModel, _ name: String, _ input: [String: JSONValue]) async throws -> JSONValue {
        var message = ""
        guard let value = await model.workspaceAction(name, input: input, onFailure: { message = $0; _ = $1 }) else { throw DeliveryFailure(message: name + ": " + message) }
        return value
    }

    @MainActor private static func recover(action: String, input: [String: JSONValue], model: WorkspaceModel, direct: Workspace, recovery: RecoveryStore, library: LibraryStore, preferences: UserDefaults, beforeRestart: () throws -> Void = {}) async throws -> JSONValue {
        let operation = PendingStructureOperation(workspaceID: model.workspaceID, action: action, input: input)
        try await recovery.writeOperation(operation)
        let committed = try await direct.data(action, input: input, allowPartial: true)
        try beforeRestart()
        let restarted = WorkspaceModel(locale: "en", recovery: recovery, preferences: preferences, library: library)
        try checkDelivery(await restarted.open(direct.url) && restarted.pendingStructureOperations == [operation], "重启丢失原交付操作")
        let restored = DeliverySession(model: restarted)
        let expectedMode: DeliveryMode = action == "hetu.documents.import" ? .importDocument : action == "hetu.documents.export" ? .exportDocuments : .bundle
        try checkDelivery(restored.mode == expectedMode && restored.preview == input["preview"], "恢复面板没有显示原操作及固定预览")
        await restored.retry()
        try checkDelivery(restored.pending == nil && restored.result == committed && restarted.pendingStructureOperations.isEmpty, restored.error ?? "原操作重复写入或恢复记录未清理")
        return committed
    }
}
