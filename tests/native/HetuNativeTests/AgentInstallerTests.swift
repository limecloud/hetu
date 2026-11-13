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
            for suite in catalog.suites {
                let receipt = try installer.installWorkBuddy(suite: suite, catalog: catalog, configDirectory: workbuddy)
                let check = AgentPackageInspector(codexDirectory: codex, workbuddyDirectory: workbuddy).inspect(suite: suite, catalog: catalog, client: .workbuddy)
                try installationCheck(check.state == .filesInstalled && check.foundSkills.count == catalog.skills.count && receipt.version == check.version, "WorkBuddy 完整套件未安装到实际扫描目录")
                let second = try installer.installWorkBuddy(suite: suite, catalog: catalog, configDirectory: workbuddy)
                try installationCheck(second.directory.resolvingSymlinksInPath().standardizedFileURL.path == receipt.directory.resolvingSymlinksInPath().standardizedFileURL.path, "相同安装重复创建套件")
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
                print("Codex：隔离 CODEX_HOME 中官方来源登记、安装、启用、版本及整包摘要回读通过")
            } else { print("Codex 安装集成检查未执行：当前环境没有官方 CLI") }
            print("WorkBuddy：独立目录整套安装、题材名称隔离、重复安装与保留作者配置检查通过；宿主会话加载未验收")
        }.value
    }
}
