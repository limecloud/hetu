import Foundation
import HetuCore
import HetuNative

enum LocalAutomationTests {
    struct Failure: Error { let message: String }
    static func check(_ test: Bool, _ message: String) throws { if !test { throw Failure(message: message) } }
    static func data(_ value: JSONValue) throws -> JSONValue { try value.requiringSuccess() }
    /// 仅在显式专项中运行真实官方 CLI，CODEX_HOME 必须指向隔离测试目录。
    static func officialInstaller(root: URL) async throws {
        guard let codexHome = ProcessInfo.processInfo.environment["CODEX_HOME"], codexHome.contains("ai-first-complete-20261115"),
              let executable = AgentSuiteInstaller.findCodex() else { throw Failure(message: "缺少隔离 CODEX_HOME 或官方 Codex CLI") }
        let domain = "run.limeai.hetu.official-installer.\(UUID().uuidString)"
        defer { UserDefaults(suiteName: domain)?.removePersistentDomain(forName: domain) }
        let installer = AgentSuiteInstaller(supportDirectory: root.appendingPathComponent("仅当前套件"), codexDirectory: URL(fileURLWithPath: codexHome), codexExecutable: executable)
        let service = LocalAutomation(directory: root.appendingPathComponent("安装方案"), preferencesDomain: domain, installer: installer)
        let input: [String: JSONValue] = ["kind": .string("agent_suite"), "summary": .string("安装当前作品通用套件"), "agent_client": .string("codex"), "suite_id": .string("general"), "install": .bool(true), "operation_key": .string("official-install")]
        let plan = try data(await service.request("hetu.local_settings.prepare", input: input, client: "codex"))
        _ = try await service.decide(id: plan["operation_id"].string!, sha256: plan["sha256"].string!, revision: 1, approve: true)
        let arguments: [String: JSONValue] = ["operation_id": plan["operation_id"], "sha256": plan["sha256"], "operation_key": .string("execute")]
        let executed = try data(await service.request("hetu.local_settings.execute", input: arguments, client: "codex"))
        try check(executed["state"].string == "executed" && executed["installation"]["version"].string != nil, "官方插件未安装或未核验")
        try check(try data(await service.request("hetu.local_settings.execute", input: arguments, client: "codex")) == executed, "官方安装回执不能原键恢复")
        let recovered = try installer.recoverCodex(suite: AgentSuiteCatalog.bundled().suites.first { $0.id == "general" }!, catalog: AgentSuiteCatalog.bundled())
        try check(recovered?.version == executed["installation"]["version"].string, "官方登记与文件无法只读恢复")
        print("真实官方 Codex CLI：仅安装所选通用套件、指纹/版本/启用核验、原键零重装及只读恢复通过；不声明本会话已加载")
    }
    static func run(root: URL) async throws {
        let name = "run.limeai.hetu.local-tests.\(UUID().uuidString)"
        let preferences = UserDefaults(suiteName: name)!
        defer { preferences.removePersistentDomain(forName: name) }
        preferences.set("私密测试值不得回读", forKey: "Hetu.models.privateKey")
        let directory = root.appendingPathComponent("本机方案")
        let service = LocalAutomation(directory: directory, preferencesDomain: name)
        let read = try data(await service.request("hetu.local_settings.get", input: [:], client: "codex"))
        try check(!(String(decoding: try read.encoded(), as: UTF8.self)).contains("私密测试值"), "回读包含非白名单配置")
        let arguments: [String: JSONValue] = ["kind": .string("preferences"), "summary": .string("阅读字号与段落间距"),
            "patch": .object(["font_size": .integer(20), "line_spacing": .integer(7)]), "operation_key": .string("prepare")]
        let plan = try data(await service.request("hetu.local_settings.prepare", input: arguments, client: "codex"))
        let otherName = name + ".other"
        defer { UserDefaults(suiteName: otherName)?.removePersistentDomain(forName: otherName) }
        let other = LocalAutomation(directory: directory, preferencesDomain: otherName)
        let otherPlan = try data(await other.request("hetu.local_settings.prepare", input: arguments, client: "codex"))
        try check(otherPlan["operation_id"] != plan["operation_id"], "跨应用域复用了同键方案")
        let ownPlans = try await service.plans(), foreignPlans = try await other.plans()
        try check(ownPlans.count == 1 && foreignPlans.count == 1, "其他应用域方案阻断或污染当前列表")
        try check(try data(await service.request("hetu.local_settings.prepare", input: arguments, client: "codex")) == plan, "原键准备不稳定")
        let execute: [String: JSONValue] = ["operation_id": plan["operation_id"], "sha256": plan["sha256"], "operation_key": .string("execute")]
        try check(await service.request("hetu.local_settings.execute", input: execute, client: "codex")["status"].string != "succeeded", "未批准即可改设置")
        _ = try await service.decide(id: plan["operation_id"].string!, sha256: plan["sha256"].string!, revision: 1, approve: true)
        let result = try data(await service.request("hetu.local_settings.execute", input: execute, client: "codex"))
        try check(result["state"].string == "executed" && preferences.double(forKey: "Hetu.editor.fontSize") == 20, "本机方案没有执行")
        try check(try data(await service.request("hetu.local_settings.execute", input: execute, client: "codex")) == result, "已执行方案无法恢复")
        try check(await service.request("hetu.local_settings.get_operation", input: ["operation_id": plan["operation_id"]], client: "workbuddy")["status"].string != "succeeded", "可串客户端读取方案")
        var bad = arguments; bad["patch"] = .object(["api_key": .string("不允许")]); bad["operation_key"] = .string("bad")
        try check(await service.request("hetu.local_settings.prepare", input: bad, client: "codex")["status"].string != "succeeded", "可借设置接口改私密配置")

        // 模拟偏好已写部分字段、结果尚未落盘；原意图可接续，不覆盖外部其他设置。
        var retry = arguments; retry["patch"] = .object(["font_size": .integer(22), "line_spacing": .integer(9)]); retry["operation_key"] = .string("recover")
        let pending = try data(await service.request("hetu.local_settings.prepare", input: retry, client: "codex"))
        var state = try await service.decide(id: pending["operation_id"].string!, sha256: pending["sha256"].string!, revision: 1, approve: true).object
        state["state"] = .string("executing"); state["execute_key"] = .string("recover-execute")
        try JSONValue.object(state).encoded().write(to: directory.appendingPathComponent(pending["operation_id"].string! + ".json"), options: .atomic)
        preferences.set(22, forKey: "Hetu.editor.fontSize")
        _ = try data(await service.request("hetu.local_settings.execute", input: ["operation_id": pending["operation_id"], "sha256": pending["sha256"], "operation_key": .string("recover-execute")], client: "codex"))
        try check(preferences.double(forKey: "Hetu.editor.lineSpacing") == 9, "中断未接续剩余设置")
        let workspace = "workspace_" + UUID().uuidString.lowercased()
        let suiteInput: [String: JSONValue] = ["kind": .string("agent_suite"), "summary": .string("选择本作品的方法"), "agent_client": .string("codex"), "suite_id": .string("historical"), "workspace_id": .string(workspace), "install": .bool(false), "operation_key": .string("suite")]
        let suite = try data(await service.request("hetu.local_settings.prepare", input: suiteInput, client: "codex"))
        _ = try await service.decide(id: suite["operation_id"].string!, sha256: suite["sha256"].string!, revision: 1, approve: true)
        preferences.set("workbuddy", forKey: "Hetu.ai.work.\(workspace).client")
        let conflict = await service.request("hetu.local_settings.execute", input: ["operation_id": suite["operation_id"], "sha256": suite["sha256"], "operation_key": .string("suite-execute")], client: "codex")
        try check(conflict["error"]["code"].string == "revision_conflict", "覆盖了作者已改变的作品选择")
        preferences.removeObject(forKey: "Hetu.ai.work.\(workspace).client")
        _ = try data(await service.request("hetu.local_settings.execute", input: ["operation_id": suite["operation_id"], "sha256": suite["sha256"], "operation_key": .string("suite-execute")], client: "codex"))
        let association = try data(await service.request("hetu.local_settings.get", input: ["workspace_id": .string(workspace)], client: "codex"))["association"]
        try check(association["suite"].string == "historical" && association["client"].string == "codex", "作品套件选择未回读")
        print("本机设置机器方案、作者批准、私密字段隔离与原操作恢复通过")
    }
}
