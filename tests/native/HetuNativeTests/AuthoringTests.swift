import AppKit
import Foundation
import HetuCore
import HetuNative

enum AuthoringTests {
    struct Failure: Error { let message: String }
    static func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw Failure(message: message) }
    }
    @MainActor private static func eventually(_ message: String, condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(15))
        while !condition() {
            guard ContinuousClock.now < deadline else { throw Failure(message: message) }
            try await Task.sleep(for: .milliseconds(50))
        }
    }
    @MainActor static func run(root: URL) async throws {
        let source = "雾港🌿\r\n雾港 e\u{301} HETU hetu"
        let matches = TextSearch.matches(in: source, query: "雾港")
        try require(matches.count == 2, "中文匹配数量错误")
        try require(TextSearch.replacing(source, matches: matches, with: "渡口") == "渡口🌿\r\n渡口 e\u{301} HETU hetu", "替换改变未选内容或 CRLF")
        try require(TextSearch.matches(in: source, query: "🌿").first?.range.length == 2, "Emoji 坐标错误")
        try require(TextSearch.matches(in: source, query: "hetu", caseSensitive: false).count == 2, "大小写选项无效")
        try require(TextSearch.matches(in: source, query: "雾港 渡口", words: true).map(\.quote).joined() == "雾港雾港", "中文词项查找丢失或重叠")
        try require(TextSearch.matches(in: "甲 乙 甲 乙 甲 乙", query: "乙 甲", words: true, limit: 2).map(\.range.location) == [0, 2, 4], "分词截断没有按原文顺序返回最早命中")
        try require(TextSearch.replacing("🌿", matches: [TextMatch(range: NSRange(location: 1, length: 1), quote: "�")], with: "x") == nil, "接受半个代理对")
        try require(TextSearch.replacing("旧句", matches: TextSearch.matches(in: "新句", query: "新句"), with: "修改") == nil, "接受过期引文")
        let large = String(repeating: "中文小说正文🌿\r\n", count: 10_000)
        let started = ContinuousClock.now
        let largeMatches = TextSearch.matches(in: large, query: "中文", limit: 15_000)
        try require(largeMatches.count == 10_000 && TextSearch.replacing(large, matches: largeMatches, with: "汉语") != nil, "长章匹配或替换丢失")
        print("十万字查找与替换：\(started.duration(to: .now))")

        let name = "run.limeai.hetu.authoring.\(UUID().uuidString)"
        let preferences = UserDefaults(suiteName: name)!
        defer { preferences.removePersistentDomain(forName: name) }
        let recovery = RecoveryStore(directory: root.appendingPathComponent("AuthoringRecovery"))
        let model = WorkspaceModel(recovery: recovery, preferences: preferences, library: LibraryStore(directory: root.appendingPathComponent("AuthoringLibrary")))
        let url = root.appendingPathComponent("自动保存验收")
        try require(await model.open(url, title: "自动保存"), "无法建书")
        guard let first = await model.createDocument(title: "第一章", kind: "novel_chapter") else {
            throw Failure(message: "无法创建第一章：\(model.message ?? "未返回错误")")
        }
        guard let second = await model.createDocument(title: "第二章", kind: "novel_chapter") else {
            throw Failure(message: "无法创建第二章：\(model.message ?? "未返回错误")")
        }
        try require(await model.selectDocument(first), "无法读取第一章：\(model.message ?? "未返回错误")")
        guard let workspace = model.workspace else { throw Failure(message: "章节读取后作品句柄丢失") }
        model.setComposition(true); model.edit("尚未提交的输入法文字")
        try await Task.sleep(for: .milliseconds(1800))
        let during = try await workspace.data("hetu.documents.get", input: ["document_id": .string(first)])
        try require(during["content"].string == "", "自动保存打断输入法组合")
        model.setComposition(false); model.edit(source)
        try await eventually("自动保存未完成：\(model.message ?? "未返回错误")") { !model.busy && !model.needsProtection && model.savedText == source }
        let saved = try await workspace.data("hetu.documents.get", input: ["document_id": .string(first)])
        try require(saved["content"].string == source && !model.dirty, "自动保存未写入作品修订")
        try require(model.replaceText(snapshot: source, matches: matches, replacement: "渡口"), "当前缓冲无法替换")
        try require(model.adoptionUndoBaseline == source && !model.replaceBuffer(snapshot: source, with: "过期"), "替换撤销基线或过期保护失败")
        model.setComposition(true)
        try require(!model.replaceBuffer(snapshot: model.text, with: "不应替换"), "替换打断组合输入")
        model.setComposition(false)
        try require(await model.save(), "替换后未保存")
        let other = try await workspace.data("hetu.documents.get", input: ["document_id": .string(second)])
        try require(other["content"].string == "", "替换修改了其他章节")

        let external = try await Workspace.open(at: url, mode: .author)
        let head = try await external.data("hetu.documents.get", input: ["document_id": .string(first)])
        _ = try await external.data("hetu.documents.save", input: ["document_id": .string(first), "base_revision_id": head["revision"]["revision_id"], "source_format": .string("markdown"), "content": .string("其他窗口的修订"), "operation_key": .string(UUID().uuidString)])
        model.edit("本窗口应保留的文字")
        try await eventually("自动保存未返回冲突：\(model.message ?? "未返回错误")") { !model.busy && model.conflict != .null }
        try require(model.conflict != .null && model.text == "本窗口应保留的文字" && model.dirty, "自动保存冲突丢失缓冲")
        let final = try await external.data("hetu.documents.get", input: ["document_id": .string(first)])
        try require(final["content"].string == "其他窗口的修订", "自动保存覆盖外部修订")
        print("作者编辑：Unicode 搜索替换、自动保存、输入法与冲突保护通过")
    }
}
