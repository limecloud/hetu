import Foundation
import HetuNative

private struct AgentCheckFailure: Error { let message: String }
private func agentCheck(_ condition: Bool, _ message: String) throws {
    if !condition { throw AgentCheckFailure(message: message) }
}

extension NativeTests {
    @MainActor static func agentIntegrationTests(_ root: URL, preferences: UserDefaults) throws {
        let settings = AgentIntegrationSettings(preferences: preferences)
        settings.defaultClient = .codex
        try agentCheck(settings.association(for: "old-book").client == .none, "默认客户端影响了旧作品")
        settings.associate(AgentAssociation(client: .workbuddy, suiteID: "military"), with: "first-book")
        settings.associate(AgentAssociation(client: .codex, suiteID: "general"), with: "second-book")
        settings.defaultClient = .other
        let restarted = AgentIntegrationSettings(preferences: preferences)
        try agentCheck(restarted.association(for: "first-book") == AgentAssociation(client: .workbuddy, suiteID: "military"), "重启或默认值变更丢失作品关联")
        try agentCheck(restarted.association(for: "second-book").client == .codex, "作品客户端串用")

        let catalog = try AgentSuiteCatalog.bundled()
        guard let general = catalog.suites.first(where: { $0.id == "general" }),
              let military = catalog.suites.first(where: { $0.id == "military" }) else { throw AgentCheckFailure(message: "缺少实际分发套件") }
        let codex = root.appendingPathComponent("测试客户端")
        let inspector = AgentPackageInspector(codexDirectory: codex, workbuddyDirectory: root.appendingPathComponent("测试 WorkBuddy"))
        for suite in catalog.suites {
            let actual = inspector.inspect(suite: suite, catalog: catalog, client: .codex, selectedDirectory: catalog.directory(for: suite))
            try agentCheck(actual.state == .filesFound && actual.missingSkills.isEmpty && actual.version == "0.1.0", "分发套件不完整或被误报已安装：\(suite.id)")
        }
        try agentCheck(inspector.inspect(suite: military, catalog: catalog, client: .codex).state == .notFound, "没有客户端目录却报告安装")
        let cache = codex.appendingPathComponent("plugins/cache/test-market/hetu-military/revision-a")
        try FileManager.default.createDirectory(at: cache.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: catalog.directory(for: military), to: cache)
        let cached = inspector.inspect(suite: military, catalog: catalog, client: .codex)
        try agentCheck(cached.state == .filesFound && cached.registration == .unknown, "缓存目录被当作启用或安装证据")
        try Data("[plugins.\"hetu-military@test-market\"]\nenabled = true\n".utf8).write(to: codex.appendingPathComponent("config.toml"))
        let enabled = inspector.inspect(suite: military, catalog: catalog, client: .codex)
        try agentCheck(enabled.state == .registered && enabled.registration == .enabled && enabled.foundSkills.count == 8, "未发现已登记的完整题材套件")
        try agentCheck(inspector.inspect(suite: general, catalog: catalog, client: .codex).state == .notFound, "军事套件被误认成通用套件")
        try Data("[plugins.\"hetu-military@test-market\"]\nenabled = false\n".utf8).write(to: codex.appendingPathComponent("config.toml"))
        try agentCheck(inspector.inspect(suite: military, catalog: catalog, client: .codex).registration == .disabled, "禁用包被误报启用")

        let wrongClient = inspector.inspect(suite: military, catalog: catalog, client: .workbuddy)
        try agentCheck(wrongClient.state == .notFound, "WorkBuddy 检测读取了 Codex 的安装")
        settings.selectPackageDirectory(cache, client: .workbuddy, suiteID: military.id)
        try agentCheck(settings.packageDirectory(client: .codex, suiteID: military.id) == nil, "手选来源跨客户端串用")
        let manuallySelected = inspector.inspect(suite: military, catalog: catalog, client: .workbuddy, selectedDirectory: cache)
        try agentCheck(manuallySelected.state == .filesFound && manuallySelected.registration == .unknown, "手选目录被当作宿主安装或启用")

        // manifest 是当前包版本；旧 lock 不能覆盖它。
        try Data("{\"pluginVersion\":\"9.9.9\"}".utf8).write(to: cache.appendingPathComponent("plugin.lock.json"))
        var manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: cache.appendingPathComponent("plugin.json"))) as! [String: Any]
        manifest["version"] = "0.0.9"
        try JSONSerialization.data(withJSONObject: manifest).write(to: cache.appendingPathComponent("plugin.json"))
        let older = inspector.inspect(suite: military, catalog: catalog, client: .codex)
        try agentCheck(older.version == "0.0.9" && older.versionDiffers && older.lockVersion == "9.9.9", "混用了 manifest 与 lock 版本或没有发现版本差异")
        let duplicate = cache.deletingLastPathComponent().appendingPathComponent("revision-b")
        try FileManager.default.copyItem(at: cache, to: duplicate)
        try agentCheck(inspector.inspect(suite: military, catalog: catalog, client: .codex).state == .ambiguous, "多个缓存版本被猜成当前加载包")
        try FileManager.default.removeItem(at: duplicate.appendingPathComponent("references/military.md"))
        try agentCheck(inspector.inspect(suite: military, catalog: catalog, client: .codex, selectedDirectory: duplicate).state == .invalid, "题材方法缺失仍显示为有效套件")
        let missing = cache.appendingPathComponent("skills/hetu-revise/SKILL.md")
        try FileManager.default.removeItem(at: missing)
        let partial = inspector.inspect(suite: military, catalog: catalog, client: .codex, selectedDirectory: cache)
        try agentCheck(partial.state == .partial && partial.missingSkills == ["hetu-revise"], "缺少改稿 Skill 的包被误报完整")
        let outside = root.appendingPathComponent("越界 Skill.md")
        try Data("---\nname: hetu-revise\n---\n".utf8).write(to: outside)
        try FileManager.default.createSymbolicLink(at: missing, withDestinationURL: outside)
        try agentCheck(inspector.inspect(suite: military, catalog: catalog, client: .codex, selectedDirectory: cache).state == .partial, "包外符号链接被当作包内 Skill")
        manifest["name"] = "another-plugin"
        try JSONSerialization.data(withJSONObject: manifest).write(to: cache.appendingPathComponent("plugin.json"))
        try agentCheck(inspector.inspect(suite: military, catalog: catalog, client: .codex, selectedDirectory: cache).state == .invalid, "其他插件被误认成河图套件")
        print("AI 协作：逐作品关联、题材套件完整性、版本、禁用、缓存歧义、宿主隔离与包路径检查通过")
    }
}
