import Foundation
import HetuNative

private struct InstallationCheckError: Error { let message: String }
private func installationCheck(_ value: Bool, _ message: String) throws {
    if !value { throw InstallationCheckError(message: message) }
}

enum AgentInstallerTests {
    static func run(root: URL) async throws {
        try await Task.detached {
            let catalog = try AgentSuiteCatalog.bundled()
            guard let military = catalog.suites.first(where: { $0.id == "military" }) else { throw InstallationCheckError(message: "缺少军事包") }
            let codex = root.appendingPathComponent("安装测试 Codex"), workbuddy = root.appendingPathComponent("安装测试 WorkBuddy")
            try FileManager.default.createDirectory(at: codex, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: workbuddy, withIntermediateDirectories: true)
            let sentinel = workbuddy.appendingPathComponent("settings.json")
            let original = Data("{\"existing\":\"保留作者配置\"}".utf8)
            try original.write(to: sentinel)
            let installer = AgentSuiteInstaller(supportDirectory: root.appendingPathComponent("安装包来源"), codexDirectory: codex)
            let selected = catalog.suites.filter { ["military", "apocalypse", "infinite"].contains($0.id) }
            try installationCheck(selected.count == 3, "缺少选型安装场景的题材包")
            var installedNames = Set<String>()
            for suite in selected {
                let receipt = try installer.installWorkBuddy(suite: suite, catalog: catalog, configDirectory: workbuddy)
                let check = AgentPackageInspector(codexDirectory: codex, workbuddyDirectory: workbuddy).inspect(suite: suite, catalog: catalog, client: .workbuddy)
                try installationCheck(check.state == .filesInstalled && check.foundSkills.count == catalog.skills.count && receipt.version == check.version, "WorkBuddy 完整套件未安装到实际扫描目录")
                let second = try installer.installWorkBuddy(suite: suite, catalog: catalog, configDirectory: workbuddy)
                try installationCheck(second.directory.resolvingSymlinksInPath().standardizedFileURL.path == receipt.directory.resolvingSymlinksInPath().standardizedFileURL.path, "相同安装重复创建套件")
                installedNames.insert(suite.pluginName)
                let names = try FileManager.default.contentsOfDirectory(atPath: workbuddy.appendingPathComponent("skills").path)
                try installationCheck(Set(names) == installedNames, "安装一个题材时写入了未选的套件")
                let genre = try String(contentsOf: receipt.directory.appendingPathComponent("references/genre.md"), encoding: .utf8)
                try installationCheck(genre.contains(suite.summary ?? ""), "安装内容与作者所选题材不符")
            }
            try installationCheck(try Data(contentsOf: sentinel) == original, "WorkBuddy 安装改动了其他设置")
            let militaryFile = workbuddy.appendingPathComponent("skills/hetu-military/skills/hetu-revise/SKILL.md")
            let text = try String(contentsOf: militaryFile, encoding: .utf8)
            try installationCheck(text.contains("\nname: hetu-military-revise\n"), "军事与通用工作流名称冲突")
            let edited = text + "\n作者自定义方法\n"
            try Data(edited.utf8).write(to: militaryFile)
            do {
                _ = try installer.installWorkBuddy(suite: military, catalog: catalog, configDirectory: workbuddy)
                throw InstallationCheckError(message: "安装覆盖了作者自定义方法")
            } catch AgentInstallError.destinationConflict {}
            try installationCheck(try String(contentsOf: militaryFile, encoding: .utf8) == edited, "冲突破坏了原文件")
            if installer.codexExecutable != nil {
                let receipt = try installer.installCodex(suite: military, catalog: catalog)
                let check = AgentPackageInspector(codexDirectory: codex).inspect(suite: military, catalog: catalog, client: .codex, selectedDirectory: receipt.directory)
                try installationCheck(check.state == .registered && check.registration == .enabled && check.version == receipt.version, "Codex 官方 CLI 安装后未发现真实登记")
                let second = try installer.installCodex(suite: military, catalog: catalog)
                try installationCheck(second.directory.resolvingSymlinksInPath().standardizedFileURL.path == receipt.directory.resolvingSymlinksInPath().standardizedFileURL.path, "Codex 相同安装未复用实际版本")
                for suite in catalog.suites where suite.id != military.id {
                    let unselected = AgentPackageInspector(codexDirectory: codex).inspect(suite: suite, catalog: catalog, client: .codex)
                    try installationCheck(unselected.state == .notFound, "Codex 安装军事包时同时安装了其他题材")
                }
                try verifyCodexUpgrade(root: root, suite: military, catalog: catalog, executable: installer.codexExecutable!)
                print("Codex：隔离 CODEX_HOME 中官方来源登记、安装、启用、版本及整包摘要回读通过")
            } else { print("Codex 安装集成检查未执行：当前环境没有官方 CLI") }
            print("WorkBuddy：独立目录整套安装、题材名称隔离、重复安装与保留作者配置检查通过；宿主会话加载未验收")
        }.value
    }
    private static func verifyCodexUpgrade(root: URL, suite: AgentSuite, catalog: AgentSuiteCatalog, executable: URL) throws {
        let support = root.appendingPathComponent("升级来源"), codex = root.appendingPathComponent("升级 Codex")
        try FileManager.default.createDirectory(at: codex, withIntermediateDirectories: true)
        let market = support.appendingPathComponent("codex/\(suite.id)/0.2.0")
        let legacy = try seedMarket(at: market, suite: suite, catalog: catalog, version: "0.2.0")
        _ = try codexCommand(executable, home: codex, arguments: ["plugin", "marketplace", "add", market.path, "--json"])
        _ = try codexCommand(executable, home: codex, arguments: ["plugin", "add", suite.pluginName + "@hetu-luoshu-" + suite.id, "--json"])
        let installer = AgentSuiteInstaller(supportDirectory: support, codexDirectory: codex, codexExecutable: executable)
        let method = legacy.appendingPathComponent("skills/hetu-revise/SKILL.md")
        let original = try Data(contentsOf: method), edited = original + Data("\n作者自定义升级前方法\n".utf8)
        try edited.write(to: method)
        do {
            _ = try installer.installCodex(suite: suite, catalog: catalog)
            throw InstallationCheckError(message: "升级未保留作者修改过的旧包")
        } catch AgentInstallError.destinationConflict {}
        try installationCheck(try Data(contentsOf: method) == edited, "升级冲突破坏了作者旧包")
        try original.write(to: method)
        let receipt = try installer.installCodex(suite: suite, catalog: catalog)
        let check = AgentPackageInspector(codexDirectory: codex).inspect(suite: suite, catalog: catalog, client: .codex, selectedDirectory: receipt.directory)
        try installationCheck(check.state == .registered && check.registration == .enabled && check.version == receipt.version && receipt.version != "0.2.0", "旧市场升级未登记实际新版本")
        let markets = try codexCommand(executable, home: codex, arguments: ["plugin", "marketplace", "list", "--json"])["marketplaces"] as? [[String: Any]]
        let registeredRoot = (markets?.first?["root"] as? String).map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().standardizedFileURL }
        try installationCheck(markets?.count == 1 && registeredRoot == market.resolvingSymlinksInPath().standardizedFileURL, "升级创建了重复市场或切换了旧来源")
        try installationCheck(FileManager.default.fileExists(atPath: legacy.path), "升级删除了旧版本包")
        let repeated = try installer.installCodex(suite: suite, catalog: catalog)
        try installationCheck(repeated.directory == receipt.directory, "升级后重复安装未复用当前版本")
        let manifest = market.appendingPathComponent(".agents/plugins/marketplace.json")
        var custom = try JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as! [String: Any]
        custom["author_note"] = "作者自定义市场"
        let customBytes = try JSONSerialization.data(withJSONObject: custom, options: [.sortedKeys])
        try customBytes.write(to: manifest)
        do {
            _ = try installer.installCodex(suite: suite, catalog: catalog)
            throw InstallationCheckError(message: "安装覆盖了作者自定义市场清单")
        } catch AgentInstallError.destinationConflict {}
        try installationCheck(try Data(contentsOf: manifest) == customBytes, "市场清单冲突破坏了作者内容")

        let externalHome = root.appendingPathComponent("外部市场 Codex"), external = root.appendingPathComponent("作者外部市场")
        try FileManager.default.createDirectory(at: externalHome, withIntermediateDirectories: true)
        _ = try seedMarket(at: external, suite: suite, catalog: catalog, version: "0.2.0")
        _ = try codexCommand(executable, home: externalHome, arguments: ["plugin", "marketplace", "add", external.path, "--json"])
        let config = externalHome.appendingPathComponent("config.toml")
        let configBytes = try Data(contentsOf: config)
        let externalManifest = external.appendingPathComponent(".agents/plugins/marketplace.json")
        let externalBytes = try Data(contentsOf: externalManifest)
        let externalInstaller = AgentSuiteInstaller(supportDirectory: root.appendingPathComponent("外部市场安装来源"), codexDirectory: externalHome, codexExecutable: executable)
        do {
            _ = try externalInstaller.installCodex(suite: suite, catalog: catalog)
            throw InstallationCheckError(message: "安装接管了作者的同名外部市场")
        } catch AgentInstallError.destinationConflict {}
        try installationCheck(try Data(contentsOf: config) == configBytes && Data(contentsOf: externalManifest) == externalBytes, "外部市场冲突改动了作者登记或文件")
        print("Codex：0.2.0 旧来源升级、单市场复用、旧包保留、作者修改与外部同名市场冲突保护通过")
    }
    private static func seedMarket(at market: URL, suite: AgentSuite, catalog: AgentSuiteCatalog, version: String) throws -> URL {
        try FileManager.default.createDirectory(at: market, withIntermediateDirectories: true)
        let package = market.appendingPathComponent(suite.pluginName)
        try FileManager.default.copyItem(at: catalog.directory(for: suite), to: package)
        let plugin = package.appendingPathComponent("plugin.json")
        var object = try JSONSerialization.jsonObject(with: Data(contentsOf: plugin)) as! [String: Any]
        object["version"] = version
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]).write(to: plugin)
        let manifest: [String: Any] = ["name": "hetu-luoshu-" + suite.id, "plugins": [["name": suite.pluginName,
            "source": ["source": "local", "path": "./" + suite.pluginName],
            "policy": ["installation": "AVAILABLE", "authentication": "ON_INSTALL"], "category": "Productivity"]]]
        let directory = market.appendingPathComponent(".agents/plugins")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys]).write(to: directory.appendingPathComponent("marketplace.json"))
        return package
    }
    private static func codexCommand(_ executable: URL, home: URL, arguments: [String]) throws -> [String: Any] {
        let process = Process(), output = Pipe()
        process.executableURL = executable; process.arguments = arguments
        process.environment = ProcessInfo.processInfo.environment.merging(["CODEX_HOME": home.path]) { _, value in value }
        process.standardOutput = output; process.standardError = FileHandle.nullDevice; process.standardInput = FileHandle.nullDevice
        let timer = DispatchSource.makeTimerSource()
        timer.schedule(deadline: .now() + 45)
        timer.setEventHandler { if process.isRunning { process.terminate() } }; timer.resume()
        defer { timer.cancel() }
        try process.run()
        let bytes = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0, let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
            throw InstallationCheckError(message: "隔离 Codex CLI 失败：" + arguments.joined(separator: " "))
        }
        return object
    }
}
